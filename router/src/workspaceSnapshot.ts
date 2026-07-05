/**
 * WorkspaceSnapshot
 * =================
 * In-memory snapshot of pipeline state taken before generation begins.
 * If the engine throws (abort, timeout, crash), restore() rolls back
 * in-memory state to the pre-generation baseline.
 *
 * Disk files already written remain on disk (intentional — partial output is
 * useful for resuming manually). Only in-memory graph state is rolled back.
 *
 * Future: persist snapshot to .crabcode/snapshot.json for full crash resume.
 */

import type { ExecutionGraph, FileNode } from './planner.js';
import type { SymbolEntry }              from './symbolIndex.js';
import type { GenerationManifest }       from './generationManifest.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceSnapshot {
  /** Deep copy of execution graph node statuses at snapshot time */
  nodeStatuses:    Map<string, import('./planner.js').FileNodeStatus>;
  /** Copy of symbol index entries */
  symbolEntries:   Map<string, SymbolEntry>;
  /** Copy of committed file contents */
  committedContent: Map<string, string>;
  /** Manifest state at snapshot time */
  manifestState:   GenerationManifest;
  /** Timestamp */
  takenAt:         number;
}

// ---------------------------------------------------------------------------
// SnapshotManager
// ---------------------------------------------------------------------------

export class SnapshotManager {
  private snap: WorkspaceSnapshot | null = null;

  /**
   * Take a snapshot of current in-memory pipeline state.
   * Call this before the generation loop begins.
   */
  take(
    graph:            ExecutionGraph,
    symbolEntries:    Map<string, SymbolEntry>,
    committedContent: Map<string, string>,
    manifest:         GenerationManifest,
  ): WorkspaceSnapshot {
    const nodeStatuses = new Map<string, import('./planner.js').FileNodeStatus>();
    for (const node of graph.nodes) {
      nodeStatuses.set(node.path, node.status);
    }

    this.snap = {
      nodeStatuses,
      symbolEntries:    new Map(symbolEntries),
      committedContent: new Map(committedContent),
      manifestState:    { ...manifest, committedFiles: [...manifest.committedFiles], failedFiles: [...manifest.failedFiles], skippedFiles: [...manifest.skippedFiles] },
      takenAt:          Date.now(),
    };

    console.log(`[Snapshot] Taken: ${graph.nodes.length} nodes, ${committedContent.size} committed files`);
    return this.snap;
  }

  /**
   * Restore graph node statuses and symbol entries from snapshot.
   * Does NOT remove disk files — only rolls back in-memory state.
   */
  restore(
    graph:            ExecutionGraph,
    symbolEntries:    Map<string, SymbolEntry>,
    committedContent: Map<string, string>,
  ): boolean {
    if (!this.snap) {
      console.warn('[Snapshot] No snapshot to restore from.');
      return false;
    }

    // Restore graph node statuses
    for (const node of graph.nodes) {
      const saved = this.snap.nodeStatuses.get(node.path);
      if (saved !== undefined) node.status = saved;
    }

    // Restore symbol entries
    symbolEntries.clear();
    for (const [k, v] of this.snap.symbolEntries) symbolEntries.set(k, v);

    // Restore committed content
    committedContent.clear();
    for (const [k, v] of this.snap.committedContent) committedContent.set(k, v);

    const age = Math.round((Date.now() - this.snap.takenAt) / 1000);
    console.log(`[Snapshot] Restored (snapshot was ${age}s old)`);
    return true;
  }

  get hasSnapshot(): boolean { return this.snap !== null; }
  get snapshot():    WorkspaceSnapshot | null { return this.snap; }

  clear(): void { this.snap = null; }
}
