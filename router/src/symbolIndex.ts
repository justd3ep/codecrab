/**
 * SymbolIndex
 * ===========
 * Lightweight export + import registry for generated files.
 * Regex-based (no AST). Tracks:
 *   - exported names (functions, classes, consts, types, interfaces)
 *   - default export
 *   - local import paths (for circular dep detection)
 *
 * Used by the incremental engine to build compact dependency signatures
 * for prompt injection, replacing full file content injection.
 *
 * Also provides PromptCache: keyed by (path, signatureHash), invalidated
 * on file re-commit, preventing redundant prompt rebuilds.
 */

import crypto                from 'crypto';
import type { GeneratedFile } from './validator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SymbolEntry {
  /** Relative file path */
  path:           string;
  /** Exported function/class/const/variable names */
  exports:        string[];
  /** Exported type/interface names */
  types:          string[];
  /** Default export name (if any) */
  defaultExport?: string;
  /** Relative import paths this file uses (local only, starting with ./) */
  imports:        string[];
}

// ---------------------------------------------------------------------------
// SymbolIndex
// ---------------------------------------------------------------------------

export class SymbolIndex {
  private readonly entries = new Map<string, SymbolEntry>();

  /** Parse a generated file and register its exports + imports. */
  add(file: GeneratedFile): void {
    const entry = parseSymbolEntry(file);
    this.entries.set(file.path, entry);
  }

  /** Remove a file from the index (e.g., if re-generated). */
  remove(filePath: string): void {
    this.entries.delete(filePath);
  }

  get(filePath: string): SymbolEntry | undefined {
    return this.entries.get(filePath);
  }

  has(filePath: string): boolean {
    return this.entries.has(filePath);
  }

  /**
   * Compact signature for a single file — used in prompts instead of full content.
   * Typical output: 3–10 lines.
   *
   * Example:
   *   // src/repositories/user.repository.ts
   *   export class UserRepository { create(data): Promise<User>; findByEmail(email): Promise<User|null> }
   *   export type { UserCreateInput }
   *   imports: ['../models/user', '../config/database']
   */
  getSignature(filePath: string): string {
    const entry = this.entries.get(filePath);
    if (!entry) return `// ${filePath} — not yet generated`;

    const lines: string[] = [`// ${filePath}`];

    if (entry.defaultExport) {
      lines.push(`export default ${entry.defaultExport}`);
    }
    if (entry.exports.length > 0) {
      lines.push(`export { ${entry.exports.join(', ')} }`);
    }
    if (entry.types.length > 0) {
      lines.push(`export type { ${entry.types.join(', ')} }`);
    }
    if (entry.imports.length > 0) {
      lines.push(`imports: [${entry.imports.map(i => `'${i}'`).join(', ')}]`);
    }

    return lines.join('\n');
  }

  /**
   * Multi-file signature block — injected into generation prompts
   * instead of full dependency file content.
   */
  getAllSignatures(filePaths: string[]): string {
    if (filePaths.length === 0) return '';
    return filePaths
      .map(p => this.getSignature(p))
      .join('\n\n');
  }

  /**
   * Detect circular import cycles using DFS.
   * Returns an array of cycles, each cycle is an array of file paths.
   */
  detectCircular(): string[][] {
    const cycles: string[][] = [];
    const visited    = new Set<string>();
    const inStack    = new Set<string>();
    const stackPath: string[] = [];

    const dfs = (node: string): void => {
      if (inStack.has(node)) {
        // Found a cycle — extract the cycle portion
        const cycleStart = stackPath.indexOf(node);
        if (cycleStart >= 0) {
          cycles.push([...stackPath.slice(cycleStart), node]);
        }
        return;
      }
      if (visited.has(node)) return;

      visited.add(node);
      inStack.add(node);
      stackPath.push(node);

      const entry = this.entries.get(node);
      if (entry) {
        for (const imp of entry.imports) {
          // Resolve the import to an index key
          const resolved = resolveImportPath(imp, node);
          if (this.entries.has(resolved)) {
            dfs(resolved);
          }
        }
      }

      stackPath.pop();
      inStack.delete(node);
    };

    for (const key of this.entries.keys()) {
      if (!visited.has(key)) dfs(key);
    }

    return cycles;
  }

  /**
   * Find import paths in a file that are not referenced by any of its exports.
   * Useful for identifying dead imports.
   */
  unusedDeps(filePath: string): string[] {
    const entry = this.entries.get(filePath);
    if (!entry) return [];
    // Simplified: all imports are considered "used" if the file exports something
    // A more sophisticated check would cross-reference symbol usage
    if (entry.exports.length > 0 || entry.defaultExport) return [];
    return entry.imports;
  }

  /** Snapshot of all entries (for WorkspaceSnapshot) */
  snapshot(): Map<string, SymbolEntry> {
    return new Map(this.entries);
  }

  /** Restore from snapshot */
  restore(snap: Map<string, SymbolEntry>): void {
    this.entries.clear();
    for (const [k, v] of snap) this.entries.set(k, v);
  }

  get size(): number { return this.entries.size; }
}

// ---------------------------------------------------------------------------
// Regex-based symbol parser
// ---------------------------------------------------------------------------

function parseSymbolEntry(file: GeneratedFile): SymbolEntry {
  const { path: filePath, content } = file;
  const exports:  string[] = [];
  const types:    string[] = [];
  const imports:  string[] = [];
  let   defaultExport: string | undefined;

  // ── Named exports ─────────────────────────────────────────────────────────
  // export function Foo / export async function Foo / export class Foo / export const foo
  const namedExportRe = /^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  const constExportRe = /^export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  // export { Foo, Bar }
  const braceExportRe = /^export\s*\{\s*([^}]+)\}/gm;

  let m: RegExpExecArray | null;
  while ((m = namedExportRe.exec(content)) !== null) if (m[1]) exports.push(m[1]);
  while ((m = constExportRe.exec(content))  !== null) if (m[1]) exports.push(m[1]);
  while ((m = braceExportRe.exec(content))  !== null) {
    m[1]!.split(',').forEach(s => {
      const name = s.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && !exports.includes(name)) exports.push(name);
    });
  }

  // ── Type / interface exports ──────────────────────────────────────────────
  const typeExportRe = /^export\s+(?:type\s+)?(?:interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  const typeReExportRe = /^export\s+type\s*\{\s*([^}]+)\}/gm;
  while ((m = typeExportRe.exec(content))    !== null) if (m[1]) types.push(m[1]);
  while ((m = typeReExportRe.exec(content))  !== null) {
    m[1]!.split(',').forEach(s => {
      const name = s.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && !types.includes(name)) types.push(name);
    });
  }

  // ── Default export ────────────────────────────────────────────────────────
  const defExportRe = /^export\s+default\s+(?:class|function)?\s*([A-Za-z_$][A-Za-z0-9_$]*)/m;
  const defMatch = defExportRe.exec(content);
  if (defMatch?.[1]) defaultExport = defMatch[1];

  // ── Local imports ─────────────────────────────────────────────────────────
  const importRe = /^import\s+(?:[\w{}\s*,]+\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/gm;
  while ((m = importRe.exec(content)) !== null) {
    const spec = m[1]!.trim();
    if (!imports.includes(spec)) imports.push(spec);
  }
  // Also handle: import type { ... } from '...'
  const importTypeRe = /^import\s+type\s+(?:[\w{}\s*,]+\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/gm;
  while ((m = importTypeRe.exec(content)) !== null) {
    const spec = m[1]!.trim();
    if (!imports.includes(spec)) imports.push(spec);
  }

  return {
    path: filePath,
    exports: [...new Set(exports)],
    types:   [...new Set(types)],
    ...(defaultExport !== undefined ? { defaultExport } : {}),
    imports,
  };
}

/** Resolve a relative import path to a canonical index key */
function resolveImportPath(importSpec: string, fromFile: string): string {
  // Simple resolution — strip leading ./
  const dir = fromFile.split('/').slice(0, -1).join('/');
  const parts = (dir ? dir + '/' + importSpec : importSpec).split('/');
  const resolved: string[] = [];
  for (const p of parts) {
    if (p === '..') { resolved.pop(); }
    else if (p !== '.') resolved.push(p);
  }
  return resolved.join('/');
}

// ---------------------------------------------------------------------------
// PromptCache
// ---------------------------------------------------------------------------

/**
 * Per-file prompt context cache.
 * Key: (filePath, signatureHash) — invalidated when file is re-committed
 * and its signature changes.
 */
export class PromptCache {
  private readonly cache = new Map<string, { sigHash: string; context: string }>();

  private hash(sig: string): string {
    return crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16);
  }

  /**
   * Retrieve cached prompt context if the signature hasn't changed.
   * Returns null on miss.
   */
  get(filePath: string, currentSignature: string): string | null {
    const entry = this.cache.get(filePath);
    if (!entry) return null;
    if (entry.sigHash !== this.hash(currentSignature)) return null;
    return entry.context;
  }

  set(filePath: string, currentSignature: string, context: string): void {
    this.cache.set(filePath, {
      sigHash: this.hash(currentSignature),
      context,
    });
  }

  /** Called when a file is re-committed (signature may have changed) */
  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  get size(): number { return this.cache.size; }
}
