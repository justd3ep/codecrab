/**
 * DependencyStatus
 * ================
 * Classifies the status of a local import target relative to the current
 * generation session. This is the core fix for false missing_import errors:
 *
 *   Planned   → file is in the graph but not yet generated — IGNORE
 *   Generated → committed this session — OK
 *   Existing  → already on disk, not in our plan — OK
 *   External  → npm package or node builtin — OK
 *   Missing   → not in graph, not on disk — REAL ERROR
 *
 * Validators must call classifyDependency() before emitting missing_import.
 * Only DependencyStatus.Missing warrants an error.
 */

import fs   from 'fs';
import path from 'path';

import type { ExecutionGraph } from './planner.js';

// ---------------------------------------------------------------------------
// Public enum
// ---------------------------------------------------------------------------

export enum DependencyStatus {
  /** In graph, not yet committed — will be generated, not an error */
  Planned   = 'Planned',
  /** Committed this generation session */
  Generated = 'Generated',
  /** Already exists on disk, outside of our plan */
  Existing  = 'Existing',
  /** npm package or Node.js built-in */
  External  = 'External',
  /** Not in graph, not on disk — legitimate error */
  Missing   = 'Missing',
}

// ---------------------------------------------------------------------------
// Node.js built-ins
// ---------------------------------------------------------------------------

const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'http', 'https', 'crypto', 'util', 'stream',
  'events', 'child_process', 'readline', 'url', 'buffer', 'assert',
  'module', 'process', 'timers', 'vm', 'zlib', 'net', 'tls',
  'node:fs', 'node:path', 'node:os', 'node:http', 'node:https',
  'node:crypto', 'node:util', 'node:stream', 'node:events',
  'node:child_process', 'node:url', 'node:buffer', 'node:assert',
]);

// Extensions to try when resolving an import path
const RESOLVE_EXTS = [
  '', '.ts', '.tsx', '.js', '.jsx',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx',
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify the dependency status of a single import specifier.
 *
 * @param importSpecifier  Raw import string, e.g. "../repositories/user.repository"
 * @param fromFile         Relative path of the importing file, e.g. "src/services/user.service.ts"
 * @param graph            Current ExecutionGraph (provides planned + committed nodes)
 * @param committedPaths   Set of relative paths committed this session (subset of graph nodes)
 * @param workspaceRoot    Absolute path to workspace root
 */
export function classifyDependency(
  importSpecifier: string,
  fromFile:        string,
  graph:           ExecutionGraph,
  committedPaths:  Set<string>,
  workspaceRoot:   string,
): DependencyStatus {
  // ── External: npm package or node builtin ────────────────────────────────
  if (!importSpecifier.startsWith('.')) {
    const pkg = importSpecifier.startsWith('@')
      ? importSpecifier.split('/').slice(0, 2).join('/')
      : importSpecifier.split('/')[0]!;
    if (NODE_BUILTINS.has(pkg)) return DependencyStatus.External;
    // Assume all other bare specifiers are npm packages
    return DependencyStatus.External;
  }

  // ── Resolve relative path ─────────────────────────────────────────────────
  const fromDir   = path.dirname(fromFile);
  const resolved  = path.normalize(path.join(fromDir, importSpecifier));

  // Build set of all planned paths (all nodes in graph)
  const plannedPaths = new Set(graph.nodes.map(n => n.path));

  // ── Generated: committed this session ────────────────────────────────────
  for (const ext of RESOLVE_EXTS) {
    if (committedPaths.has(resolved + ext)) return DependencyStatus.Generated;
  }

  // ── Planned: in graph but not yet generated ───────────────────────────────
  for (const ext of RESOLVE_EXTS) {
    if (plannedPaths.has(resolved + ext)) return DependencyStatus.Planned;
  }

  // ── Existing: on disk (not in our plan) ───────────────────────────────────
  for (const ext of RESOLVE_EXTS) {
    try {
      const abs = path.join(workspaceRoot, resolved + ext);
      if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) {
        return DependencyStatus.Existing;
      }
    } catch { /* ignore fs errors */ }
  }

  // ── Missing: not found anywhere ───────────────────────────────────────────
  return DependencyStatus.Missing;
}

/**
 * Returns true if the import should be treated as a real error.
 * Planned and Generated imports are not errors during incremental generation.
 */
export function isImportError(status: DependencyStatus): boolean {
  return status === DependencyStatus.Missing;
}

/**
 * Classify all local imports in a file's content.
 * Returns only the entries where the import is a real error (Missing).
 */
export function findMissingImports(
  filePath:       string,
  content:        string,
  graph:          ExecutionGraph,
  committedPaths: Set<string>,
  workspaceRoot:  string,
): Array<{ importSpecifier: string; status: DependencyStatus }> {
  const results: Array<{ importSpecifier: string; status: DependencyStatus }> = [];
  const re = /import\s+(?:[\w{}\s*,]+\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(content)) !== null) {
    const spec   = m[1]!;
    const status = classifyDependency(spec, filePath, graph, committedPaths, workspaceRoot);
    if (isImportError(status)) {
      results.push({ importSpecifier: spec, status });
    }
  }

  return results;
}
