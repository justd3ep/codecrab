/**
 * JobService — create, cancel, resume generation jobs.
 * Orchestrates: Planner → Scheduler → Worker → ValidationPipeline → CommitManager → ManifestStore.
 * All execution is direct method calls. EventBus = notifications only.
 */

import crypto                              from 'crypto';
import path                                from 'path';
import type { JobManifest, ExecutionGraph } from '../core/types.js';
import type { AppConfig }                   from '../config/types.js';
import type { EventBus }                    from '../core/eventBus.js';
import type { ScopedLogger }               from '../logging/logger.js';
import { ManifestStore }                   from './manifestStore.js';
import { Scheduler }                       from '../scheduling/scheduler.js';
import { TempWorkspace }                   from '../generation/tempWorkspace.js';
import { Worker }                          from '../generation/worker.js';
import { GenerationEngine }                from '../generation/generationEngine.js';
import { ValidationPipeline }              from '../validation/validationPipeline.js';
import { CommitManager }                   from '../commits/commitManager.js';
import { ModelManager }                    from '../models/modelManager.js';
import { plan }                            from '../planning/planner.js';
import type { AdvisorV2Result }            from '../planning/executionGraphBuilder.js';
import type { ValidationContract }         from '../core/types.js';
import { JobNotFoundError }                from '../core/errors.js';

export interface CreateJobOptions {
	workspaceRoot:  string;
	userRequest:    string;
	advisorResult:  AdvisorV2Result;
	systemPrompt:   string;
	contract:       ValidationContract;
	modelIntent:    'backend' | 'frontend' | 'general';
}

export class JobService {
	private readonly store:      ManifestStore;
	private readonly pipeline:   ValidationPipeline;
	private readonly commits:    CommitManager;
	private readonly scheduler:  Scheduler;
	private readonly activeJobs: Map<string, AbortController> = new Map();

	constructor(
		private readonly config:       AppConfig,
		private readonly modelManager: ModelManager,
		private readonly bus:          EventBus,
		private readonly log:          ScopedLogger,
	) {
		this.store     = new ManifestStore(path.join(config.runtime.root, 'jobs'));
		this.pipeline  = new ValidationPipeline(bus);
		this.commits   = new CommitManager(bus, path.join(config.runtime.root, 'backups'));
		this.scheduler = new Scheduler({ maxRetries: config.generation.maxRepairAttempts });
	}

	async create(opts: CreateJobOptions): Promise<string> {
		const { workspaceRoot, userRequest, advisorResult, systemPrompt, contract, modelIntent } = opts;

		const planResult = plan(advisorResult, null);
		if (!planResult) throw new Error('Planner failed to build execution graph');

		const jobId = `j_${crypto.randomUUID().slice(0, 8)}`;
		const now   = new Date().toISOString();

		const manifest: JobManifest = {
			jobId,
			status:        'pending',
			createdAt:     now,
			updatedAt:     now,
			completedAt:   null,
			workspaceRoot,
			userRequest,
			model: { key: modelIntent === 'frontend' ? 'fe' : 'be', path: '', adapter: null, contextSize: 8192, temperature: this.config.generation.temperature, seed: null },
			plan: {
				architecture:  planResult.graph.architecture,
				framework:     planResult.graph.framework,
				language:      planResult.graph.language,
				expectedFiles: planResult.graph.nodes.length,
				graph:         planResult.graph,
			},
			progress:    { generated: [], validated: [], committed: [], failed: [], skipped: [], currentNode: null },
			attempts:    [],
			resumePoint: { phase: 'generation', lastCommittedNode: null },
		};

		this.store.create(manifest);
		this.bus.emit('job:created', { jobId, workspaceRoot, userRequest });
		this.log.info(`Job created: ${jobId} (${planResult.graph.nodes.length} nodes)`);

		// Run async — don't await
		this.run(jobId, planResult.graph, systemPrompt, contract, modelIntent).catch(e =>
			this.log.error(`Job ${jobId} crashed: ${e.message}`)
		);

		return jobId;
	}

	async resume(jobId: string): Promise<void> {
		if (!this.store.exists(jobId)) throw new JobNotFoundError(jobId);
		const m = this.store.read(jobId);
		// Restore graph, resume from last committed point
		const graph = m.plan.graph;
		// Mark already-committed nodes
		for (const n of graph.nodes) {
			if (m.progress.committed.includes(n.path)) n.status = 'committed';
			else if (m.progress.failed.includes(n.path)) n.status = 'failed';
			else if (m.progress.skipped.includes(n.path)) n.status = 'skipped';
			else n.status = 'pending';
		}
		const contract = { scope: 'backend' as const, architecture: graph.architecture, framework: graph.framework, language: graph.language, requiredFeatures: [], requiredFolders: [], expectedFiles: [], estimatedFiles: graph.nodes.length };
		this.log.info(`Resuming job ${jobId} from ${m.resumePoint.lastCommittedNode ?? 'start'}`);
		this.run(jobId, graph, '', contract, 'backend').catch(e =>
			this.log.error(`Job ${jobId} resume crashed: ${e.message}`)
		);
	}

	async cancel(jobId: string): Promise<void> {
		const ctrl = this.activeJobs.get(jobId);
		if (ctrl) { ctrl.abort(); this.activeJobs.delete(jobId); }
		this.store.setStatus(jobId, 'cancelled');
		this.bus.emit('job:cancelled', { jobId });
	}

	status(jobId: string): JobManifest {
		if (!this.store.exists(jobId)) throw new JobNotFoundError(jobId);
		return this.store.read(jobId);
	}

	list(): string[] { return this.store.listAll(); }

	events(jobId: string): string { return this.store.readEvents(jobId); }

	// ── Core execution loop ──────────────────────────────────────────────────

	private async run(
		jobId:        string,
		graph:        ExecutionGraph,
		systemPrompt: string,
		contract:     ValidationContract,
		modelIntent:  'backend' | 'frontend' | 'general',
	): Promise<void> {
		const ctrl = new AbortController();
		this.activeJobs.set(jobId, ctrl);

		const manifest    = this.store.read(jobId);
		const workspace   = new TempWorkspace(path.join(this.config.runtime.root, 'jobs'), jobId);
		const committedPaths = new Set(manifest.progress.committed);

		this.store.setStatus(jobId, 'running');
		this.bus.emit('job:started', { jobId });

		try {
			const intent = modelIntent === 'frontend' ? 'frontend' as const : 'backend' as const;
			const lease  = await this.modelManager.acquire(intent);
			try {
				const engine = new GenerationEngine(lease.model, this.config.generation, systemPrompt);
				const worker = new Worker(this.bus);

				while (!this.scheduler.isDone(graph) && !ctrl.signal.aborted) {
					// Deadlock check
					if (this.scheduler.isDeadlocked(graph)) {
						const skipped = this.scheduler.resolveDeadlock(graph);
						this.log.warn(`Deadlock resolved, skipped: ${skipped.join(', ')}`);
						break;
					}

					const node = this.scheduler.next(graph);
					if (!node) break;

					this.store.setCurrentNode(jobId, node.path);
					this.store.appendEvent(jobId, 'node:ready', { node: node.path });

					const start = Date.now();
					try {
						// Generate → temp
						const tempFile = await worker.generate(
							node, engine, workspace,
							{ graph, userRequest: manifest.userRequest },
							{ signal: ctrl.signal, jobId },
						);
						if (!tempFile) {
							this.scheduler.onFailed(graph, node, 'No output');
							continue;
						}

						// Validate → repair → revalidate (hard gate)
						node.status = 'validating';
						const result = await this.pipeline.validate(tempFile, engine, {
							maxRepairAttempts: this.config.generation.maxRepairAttempts,
							signal:            ctrl.signal,
							jobId,
							workspaceRoot:     manifest.workspaceRoot,
							contract,
							graph,
							committedPaths,
						});

						if (!result.passed) {
							const retry = this.scheduler.onFailed(graph, node, `Validation: ${result.issues.length} error(s)`);
							this.store.recordFailure(jobId, node.path, result.issues.map(i => i.message).join('; '));
							if (!retry) this.store.appendEvent(jobId, 'node:failed', { node: node.path });
							continue;
						}

						// Commit
						await this.commits.commit(result.file, manifest.workspaceRoot, jobId);
						committedPaths.add(node.path);
						node.status = 'committed';
						this.scheduler.onCommitted(node);

						// Checkpoint AFTER commit
						this.store.checkpoint(jobId, node.path);
						this.store.recordAttempt(jobId, {
							node:             node.path,
							timestamp:        new Date().toISOString(),
							attempt:          this.scheduler.retryCount(node.path) + 1,
							promptHash:       '',
							inputTokens:      0,
							outputTokens:     0,
							durationMs:       Date.now() - start,
							validationResult: 'passed',
							repairPerformed:  result.repairs > 0,
							failureReason:    null,
						});
						this.store.appendEvent(jobId, 'commit:completed', { node: node.path });
						workspace.delete(node.path); // clean temp after commit

					} catch (e: any) {
						if (ctrl.signal.aborted) break;
						const retry = this.scheduler.onFailed(graph, node, e.message);
						this.log.warn(`Node failed: ${node.path} — ${e.message} (retry=${retry})`);
					}
				}
			} finally {
				lease.release();
			}

			// Final status
			const committed = graph.nodes.filter(n => n.status === 'committed').map(n => n.path);
			const failed    = graph.nodes.filter(n => n.status === 'failed').map(n => n.path);
			this.store.setStatus(jobId, failed.length === graph.nodes.length ? 'failed' : 'completed');
			this.bus.emit('job:completed', { jobId, committedFiles: committed });
			this.log.info(`Job done: ${jobId} — ${committed.length} committed, ${failed.length} failed`);

		} catch (e: any) {
			this.store.setStatus(jobId, 'failed');
			this.bus.emit('job:failed', { jobId, error: e.message });
			this.log.error(`Job failed: ${jobId} — ${e.message}`);
		} finally {
			this.activeJobs.delete(jobId);
		}
	}
}
