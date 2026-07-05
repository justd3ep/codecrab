/**
 * Worker — stateless single generation unit.
 * pick node → engine → temp file. Never commits, never validates.
 */

import type { FileNode, ExecutionGraph, TempFile } from '../core/types.js';
import type { GenerationEngine, GenerationContext }  from './generationEngine.js';
import type { TempWorkspace }                        from './tempWorkspace.js';
import type { EventBus }                             from '../core/eventBus.js';

export class Worker {
	constructor(private readonly bus: EventBus) {}

	async generate(
		node:      FileNode,
		engine:    GenerationEngine,
		workspace: TempWorkspace,
		ctx:       GenerationContext,
		opts:      { signal: AbortSignal; jobId: string },
	): Promise<TempFile | null> {
		node.status = 'generating';
		const start = Date.now();
		this.bus.emit('generation:started', { jobId: opts.jobId, node: node.path });

		try {
			const files = await engine.generateFile(node, ctx, opts);
			const target = files.find(f => f.path === node.path) ?? files[0];

			if (!target) {
				this.bus.emit('generation:failed', { jobId: opts.jobId, node: node.path, error: 'No file block in output', attempt: 1 });
				return null;
			}

			const tempFile = workspace.write(target);
			this.bus.emit('generation:completed', { jobId: opts.jobId, node: node.path, durationMs: Date.now() - start });
			return tempFile;
		} catch (e: any) {
			this.bus.emit('generation:failed', { jobId: opts.jobId, node: node.path, error: e.message, attempt: 1 });
			throw e;
		}
	}
}
