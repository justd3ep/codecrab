/**
 * PipelineMetrics
 * ===============
 * Collects timing, token usage, and quality metrics for each generation run.
 * Written to <workspaceRoot>/.crabcode/pipeline-metrics.json on completion.
 * Enables data-driven optimization of the pipeline.
 */

import fs   from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileMetrics {
  path:               string;
  /** ms from start of generate to completion */
  generateTimeMs:     number;
  /** ms for local validator to run */
  validateTimeMs:     number;
  /** ms spent in repair loop */
  repairTimeMs:       number;
  /** Number of local repair attempts */
  localRepairCount:   number;
  /** Rough estimate from char count (4 chars ≈ 1 token) */
  promptTokens:       number;
  completionTokens:   number;
  /** Characters of dep context injected */
  contextSizeChars:   number;
  /** true if PromptCache hit for dep context */
  cacheHit:           boolean;
}

export interface PipelineMetrics {
  files:                 FileMetrics[];
  totalGenerateTimeMs:   number;
  totalValidateTimeMs:   number;
  totalRepairTimeMs:     number;
  projectValidateTimeMs: number;
  linkTimeMs:            number;
  compilationTimeMs:     number;
  modelCallCount:        number;
  averageTokensPerFile:  number;
  averageContextChars:   number;
  /** repairs / commits */
  repairRate:            number;
  /** committed / planned */
  queueUtilization:      number;
  /** Files added to queue by repair (not originally planned) */
  dependenciesGenerated: number;
  /** Project validator run count */
  projectValidatorRuns:  number;
  startedAt:             string;
  completedAt:           string;
}

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

const METRICS_DIR  = '.crabcode';
const METRICS_FILE = 'pipeline-metrics.json';

export class MetricsCollector {
  private readonly startedAt = new Date().toISOString();
  private readonly fileMap   = new Map<string, Partial<FileMetrics> & { _genStart?: number; _valStart?: number; _repStart?: number }>();

  private projectValidateMs = 0;
  private linkMs            = 0;
  private compileMs         = 0;
  private modelCallCount    = 0;
  private depsGenerated     = 0;
  private projectValRuns    = 0;

  // ── Per-file tracking ─────────────────────────────────────────────────────

  startGenerate(filePath: string, contextSizeChars: number, cacheHit: boolean): void {
    this.fileMap.set(filePath, {
      path: filePath,
      contextSizeChars,
      cacheHit,
      _genStart: Date.now(),
      generateTimeMs:   0,
      validateTimeMs:   0,
      repairTimeMs:     0,
      localRepairCount: 0,
      promptTokens:     0,
      completionTokens: 0,
    });
    this.modelCallCount++;
  }

  endGenerate(filePath: string, promptChars: number, completionChars: number): void {
    const e = this.fileMap.get(filePath);
    if (!e) return;
    e.generateTimeMs  = Date.now() - (e._genStart ?? Date.now());
    e.promptTokens    = Math.round(promptChars    / 4);
    e.completionTokens = Math.round(completionChars / 4);
  }

  startValidate(filePath: string): void {
    const e = this.fileMap.get(filePath);
    if (e) e._valStart = Date.now();
  }

  endValidate(filePath: string): void {
    const e = this.fileMap.get(filePath);
    if (!e) return;
    e.validateTimeMs = Date.now() - (e._valStart ?? Date.now());
  }

  startRepair(filePath: string): void {
    const e = this.fileMap.get(filePath);
    if (e) { e._repStart = Date.now(); e.localRepairCount = (e.localRepairCount ?? 0) + 1; }
    this.modelCallCount++;
  }

  endRepair(filePath: string): void {
    const e = this.fileMap.get(filePath);
    if (!e) return;
    e.repairTimeMs = (e.repairTimeMs ?? 0) + (Date.now() - (e._repStart ?? Date.now()));
  }

  // ── Project-level tracking ────────────────────────────────────────────────

  recordProjectValidate(ms: number): void {
    this.projectValidateMs += ms;
    this.projectValRuns++;
  }

  recordLink(ms: number):    void { this.linkMs    += ms; }
  recordCompile(ms: number): void { this.compileMs += ms; }
  recordDepGenerated():      void { this.depsGenerated++; }

  // ── Final summary ─────────────────────────────────────────────────────────

  finalize(expectedFiles: number): PipelineMetrics {
    const files = Array.from(this.fileMap.values()).map(e => ({
      path:              e.path ?? '',
      generateTimeMs:    e.generateTimeMs   ?? 0,
      validateTimeMs:    e.validateTimeMs   ?? 0,
      repairTimeMs:      e.repairTimeMs     ?? 0,
      localRepairCount:  e.localRepairCount ?? 0,
      promptTokens:      e.promptTokens     ?? 0,
      completionTokens:  e.completionTokens ?? 0,
      contextSizeChars:  e.contextSizeChars ?? 0,
      cacheHit:          e.cacheHit         ?? false,
    } satisfies FileMetrics));

    const committed = files.length;
    const totalRepairs = files.reduce((s, f) => s + f.localRepairCount, 0);
    const avgCtx = committed > 0
      ? Math.round(files.reduce((s, f) => s + f.contextSizeChars, 0) / committed)
      : 0;
    const avgTokens = committed > 0
      ? Math.round(files.reduce((s, f) => s + f.completionTokens, 0) / committed)
      : 0;

    return {
      files,
      totalGenerateTimeMs:   files.reduce((s, f) => s + f.generateTimeMs,  0),
      totalValidateTimeMs:   files.reduce((s, f) => s + f.validateTimeMs,  0),
      totalRepairTimeMs:     files.reduce((s, f) => s + f.repairTimeMs,    0),
      projectValidateTimeMs: this.projectValidateMs,
      linkTimeMs:            this.linkMs,
      compilationTimeMs:     this.compileMs,
      modelCallCount:        this.modelCallCount,
      averageTokensPerFile:  avgTokens,
      averageContextChars:   avgCtx,
      repairRate:            committed > 0 ? totalRepairs / committed : 0,
      queueUtilization:      expectedFiles > 0 ? committed / expectedFiles : 0,
      dependenciesGenerated: this.depsGenerated,
      projectValidatorRuns:  this.projectValRuns,
      startedAt:             this.startedAt,
      completedAt:           new Date().toISOString(),
    };
  }

  /** Persist metrics to disk. Non-fatal on failure. */
  persist(workspaceRoot: string, metrics: PipelineMetrics): void {
    try {
      const dir  = path.join(workspaceRoot, METRICS_DIR);
      const file = path.join(dir, METRICS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(metrics, null, 2), 'utf-8');
      console.log(`[Metrics] Written: ${file}`);
    } catch (e) {
      console.warn(`[Metrics] Persist failed: ${(e as Error).message}`);
    }
  }
}
