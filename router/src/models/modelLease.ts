/**
 * ModelLease — RAII-style lock preventing model unload during active use.
 *
 * The model cannot be unloaded while any lease exists.
 * Always use try/finally to release.
 *
 * Usage:
 *   const lease = await modelManager.acquire('backend');
 *   try {
 *     await worker.generate(node, lease.model);
 *   } finally {
 *     lease.release();
 *   }
 */

import type { LlamaModel } from 'node-llama-cpp';

export class ModelLease {
	private released = false;

	constructor(
		public readonly model:   LlamaModel,
		public readonly leaseId: string,
		public readonly key:     string,
		private readonly onRelease: (leaseId: string) => void,
	) {}

	release(): void {
		if (this.released) return;
		this.released = true;
		this.onRelease(this.leaseId);
	}

	get isReleased(): boolean {
		return this.released;
	}
}
