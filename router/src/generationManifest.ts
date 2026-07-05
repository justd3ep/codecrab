/**
 * GenerationManifest
 * ==================
 * Written to <workspaceRoot>/.crabcode/generation-manifest.json.
 * Updated after every file commit.
 * Source of truth for generation progress — observable from outside the engine.
 *
 * Not a build artifact — should be excluded from source control.
 */

import fs   from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ManifestStatus =
  | 'planning'
  | 'running'
  | 'validating'
  | 'repairing'
  | 'done'
  | 'failed';

export interface GenerationManifest {
  expectedFiles:   number;
  generatedFiles:  number;
  remaining:       number;
  failedFiles:     string[];
  skippedFiles:    string[];
  committedFiles:  string[];
  architecture:    string;
  framework:       string;
  modules:         string[];
  status:          ManifestStatus;
  startedAt:       string;   // ISO 8601
  updatedAt:       string;   // ISO 8601
}

// ---------------------------------------------------------------------------
// ManifestManager
// ---------------------------------------------------------------------------

const MANIFEST_DIR  = '.crabcode';
const MANIFEST_FILE = 'generation-manifest.json';

export class ManifestManager {
  private readonly manifestPath: string;
  private manifest: GenerationManifest;

  constructor(workspaceRoot: string, initial: Omit<GenerationManifest, 'startedAt' | 'updatedAt' | 'status'>) {
    this.manifestPath = path.join(workspaceRoot, MANIFEST_DIR, MANIFEST_FILE);
    const now = new Date().toISOString();
    this.manifest = {
      ...initial,
      status:    'planning',
      startedAt: now,
      updatedAt: now,
    };
  }

  /** Write current manifest to disk */
  flush(): void {
    try {
      const dir = path.dirname(this.manifestPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.manifest.updatedAt = new Date().toISOString();
      fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf-8');
    } catch (e) {
      // Non-fatal — manifest is informational, never abort pipeline for this
      console.warn(`[Manifest] Write failed: ${(e as Error).message}`);
    }
  }

  /** Record a successful file commit */
  recordCommit(filePath: string): void {
    if (!this.manifest.committedFiles.includes(filePath)) {
      this.manifest.committedFiles.push(filePath);
      this.manifest.generatedFiles = this.manifest.committedFiles.length;
      this.manifest.remaining = Math.max(
        0,
        this.manifest.expectedFiles - this.manifest.generatedFiles,
      );
    }
    this.flush();
  }

  /** Record a failed file */
  recordFailure(filePath: string): void {
    if (!this.manifest.failedFiles.includes(filePath)) {
      this.manifest.failedFiles.push(filePath);
    }
    this.flush();
  }

  /** Record a skipped file */
  recordSkip(filePath: string): void {
    if (!this.manifest.skippedFiles.includes(filePath)) {
      this.manifest.skippedFiles.push(filePath);
    }
    this.flush();
  }

  /** Update pipeline status */
  setStatus(status: ManifestStatus): void {
    this.manifest.status = status;
    this.flush();
  }

  get current(): GenerationManifest {
    return { ...this.manifest };
  }

  /** Remove manifest file on clean completion (optional) */
  remove(): void {
    try { fs.rmSync(this.manifestPath); } catch { /* ignore */ }
  }
}
