/**
 * ValidationPipeline — hard gate with integrated repair.
 * generate → validate → repair → revalidate → commit OR reject.
 * No commit path bypasses this.
 */

import type { TempFile, GeneratedFile, ValidationResult, ExecutionGraph } from '../core/types.js';
import type { ValidationContract }                                          from '../core/types.js';
import type { GenerationEngine }                                            from '../generation/generationEngine.js';
import type { EventBus }                                                    from '../core/eventBus.js';
import { runPostGenerationValidator }                                       from '../validator.js';

export interface PipelineResult {
	passed:  boolean;
	file:    GeneratedFile;
	issues:  ValidationResult['issues'];
	repairs: number;
}

export interface PipelineOptions {
	maxRepairAttempts: number;
	signal:            AbortSignal;
	jobId:             string;
	workspaceRoot:     string;
	contract:          ValidationContract;
	graph?:            ExecutionGraph;
	committedPaths?:   Set<string>;
}

export class ValidationPipeline {
	constructor(private readonly bus: EventBus) {}

	async validate(
		tempFile: TempFile,
		engine:   GenerationEngine,
		opts:     PipelineOptions,
	): Promise<PipelineResult> {
		this.bus.emit('validation:started', { jobId: opts.jobId, node: tempFile.path });

		let file: GeneratedFile = { path: tempFile.path, content: tempFile.content };
		let repairs = 0;

		for (let attempt = 0; attempt <= opts.maxRepairAttempts; attempt++) {
			if (opts.signal.aborted) break;

			const result = await runPostGenerationValidator(
				[file],
				opts.workspaceRoot,
				opts.contract,
				false,
				opts.graph as any, // bridge until validator.ts migrates to core/types
				opts.committedPaths,
			);

			const errors = result.issues.filter(i => i.severity === 'error');

			if (errors.length === 0) {
				this.bus.emit('validation:passed', { jobId: opts.jobId, node: file.path });
				return { passed: true, file: result.files[0] ?? file, issues: result.issues as any, repairs };
			}

			// Last attempt — fail
			if (attempt === opts.maxRepairAttempts) {
				this.bus.emit('validation:failed', { jobId: opts.jobId, node: file.path, errorCount: errors.length });
				return { passed: false, file, issues: result.issues as any, repairs };
			}

			// Repair attempt
			this.bus.emit('repair:started', { jobId: opts.jobId, node: file.path, attempt: attempt + 1 });
			const repaired = await engine.repairFile(
				file.path, file.content,
				errors.map(e => ({ message: e.message, kind: e.kind })),
				'',
				{ signal: opts.signal, jobId: opts.jobId },
			);
			const repairedFile = repaired.find(f => f.path === file.path) ?? repaired[0];
			if (repairedFile) {
				file = repairedFile;
				repairs++;
				this.bus.emit('repair:completed', { jobId: opts.jobId, node: file.path, resolved: true });
			} else {
				this.bus.emit('repair:completed', { jobId: opts.jobId, node: file.path, resolved: false });
				break;
			}
		}

		this.bus.emit('validation:failed', { jobId: opts.jobId, node: file.path, errorCount: 999 });
		return { passed: false, file, issues: [], repairs };
	}
}
