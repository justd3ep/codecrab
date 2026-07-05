/**
 * PipelineState — Explicit State Machine
 * =======================================
 * Every phase transition is explicit. Invalid transitions throw.
 * Enables deterministic debugging, crash resume, and observer hooks.
 *
 * Also defines:
 *   - ProjectContext  — single object passed through all pipeline stages
 *   - RepairBudget    — caps all repair loops to prevent infinite expansion
 *   - PipelineSettings — runtime configuration
 */

import type { AdvisorV2Result, ExecutionGraph } from './planner.js';
import type { SymbolIndex }                     from './symbolIndex.js';
import type { GenerationManifest }              from './generationManifest.js';
import type { WorkspaceSnapshot }               from './workspaceSnapshot.js';
import type { PipelineMetrics }                 from './pipelineMetrics.js';

// ---------------------------------------------------------------------------
// State enum
// ---------------------------------------------------------------------------

export enum PipelineState {
  Planning          = 'Planning',
  BuildingGraph     = 'BuildingGraph',
  Generating        = 'Generating',
  LocalValidation   = 'LocalValidation',
  Committing        = 'Committing',
  ProjectValidation = 'ProjectValidation',
  Linking           = 'Linking',
  Compiling         = 'Compiling',
  ProjectRepair     = 'ProjectRepair',
  Completed         = 'Completed',
  Failed            = 'Failed',
}

// ---------------------------------------------------------------------------
// Valid transitions (adjacency map)
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Partial<Record<PipelineState, PipelineState[]>> = {
  [PipelineState.Planning]:          [PipelineState.BuildingGraph, PipelineState.Failed],
  [PipelineState.BuildingGraph]:     [PipelineState.Generating, PipelineState.Failed],
  [PipelineState.Generating]:        [PipelineState.LocalValidation, PipelineState.ProjectValidation, PipelineState.Failed],
  [PipelineState.LocalValidation]:   [PipelineState.Committing, PipelineState.Generating, PipelineState.Failed],
  [PipelineState.Committing]:        [PipelineState.Generating, PipelineState.ProjectValidation, PipelineState.Failed],
  [PipelineState.ProjectValidation]: [PipelineState.Linking, PipelineState.ProjectRepair, PipelineState.Completed, PipelineState.Failed],
  [PipelineState.Linking]:           [PipelineState.Compiling, PipelineState.ProjectRepair, PipelineState.Failed],
  [PipelineState.Compiling]:         [PipelineState.Completed, PipelineState.ProjectRepair, PipelineState.Failed],
  [PipelineState.ProjectRepair]:     [PipelineState.Generating, PipelineState.ProjectValidation, PipelineState.Completed, PipelineState.Failed],
  [PipelineState.Completed]:         [],
  [PipelineState.Failed]:            [],
};

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export class PipelineStateMachine {
  private _state: PipelineState = PipelineState.Planning;
  private _history: PipelineState[] = [PipelineState.Planning];
  private _listeners: Array<(from: PipelineState, to: PipelineState) => void> = [];

  get current(): PipelineState { return this._state; }
  get history():  PipelineState[] { return [...this._history]; }

  transition(next: PipelineState): void {
    const allowed = VALID_TRANSITIONS[this._state] ?? [];
    if (!allowed.includes(next)) {
      throw new PipelineStateError(
        `Invalid transition: ${this._state} → ${next}. ` +
        `Allowed: [${allowed.join(', ')}]`,
      );
    }
    const prev = this._state;
    this._state = next;
    this._history.push(next);
    for (const fn of this._listeners) fn(prev, next);
  }

  /** Transition without throwing — used for error paths where state is uncertain */
  safeTransition(next: PipelineState): boolean {
    try { this.transition(next); return true; }
    catch { return false; }
  }

  onTransition(fn: (from: PipelineState, to: PipelineState) => void): void {
    this._listeners.push(fn);
  }

  is(state: PipelineState): boolean { return this._state === state; }
  isTerminal(): boolean {
    return this._state === PipelineState.Completed ||
           this._state === PipelineState.Failed;
  }
}

export class PipelineStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineStateError';
  }
}

// ---------------------------------------------------------------------------
// RepairBudget
// ---------------------------------------------------------------------------

export interface RepairBudget {
  /** Max repair attempts per local issue per file. Default: 2 */
  maxLocalRepairsPerFile: number;
  /** Max total project-level repair attempts. Default: 5 */
  maxProjectRepairs:      number;
  /** Max new files that can be queued by repair. Default: 10 */
  maxGeneratedDependencies: number;
}

export const DEFAULT_REPAIR_BUDGET: RepairBudget = {
  maxLocalRepairsPerFile:   2,
  maxProjectRepairs:        5,
  maxGeneratedDependencies: 10,
};

// ---------------------------------------------------------------------------
// PipelineSettings
// ---------------------------------------------------------------------------

export interface PipelineSettings {
  workspaceRoot:    string;
  maxTokensPerFile: number;
  repairBudget:     RepairBudget;
  /** If true, skip tsc compile phase even if link passes */
  skipCompile?:     boolean;
}

// ---------------------------------------------------------------------------
// ProjectContext — single object passed through all stages
// ---------------------------------------------------------------------------

export interface ProjectContext {
  planner:     AdvisorV2Result;
  graph:       ExecutionGraph;
  symbolIndex: SymbolIndex;
  manifest:    GenerationManifest;
  snapshot:    WorkspaceSnapshot;
  metrics:     PipelineMetrics;
  settings:    PipelineSettings;
  stateMachine: PipelineStateMachine;
}
