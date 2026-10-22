/**
 * ModelManager — Lease-based model lifecycle.
 *
 * Key invariants:
 *   1. Exactly 0 or 1 model in VRAM at any time.
 *   2. Idle timer ONLY fires when activeLeases.size === 0.
 *   3. Model cannot unload while any lease exists.
 *   4. DisposedError becomes impossible during active generation.
 *
 * Extracted from index.ts (lines 462-571) with lease pattern.
 */

import fs                                   from 'fs';
import path                                 from 'path';
import { getLlama }                         from 'node-llama-cpp';
import type { Llama, LlamaModel }           from 'node-llama-cpp';
import crypto                               from 'crypto';
import type { ModelConfig }                  from '../config/types.js';
import type { EventBus }                     from '../core/eventBus.js';
import type { ModelIntent }                  from '../core/types.js';
import { ModelLease }                        from './modelLease.js';
import { ModelLoadError, ModelDisposedError } from '../core/errors.js';
import config                               from '@/config/index.js';
import { fileURLToPath }                    from 'url';

export class ModelManager {
	private llama: Llama | null = null;
	private activeModel: LlamaModel | null = null;
	private activeKey: string | null = null;
	private loading = false;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly activeLeases = new Map<string, ModelLease>();

	constructor(
		private readonly bus:    EventBus,
	) {}

	// ── Lifecycle ────────────────────────────────────────────────────────────

	async init(): Promise<void> {
		this.llama = await getLlama();
	}

	// ── Lease-based acquisition ──────────────────────────────────────────────

	async acquire(intent: ModelIntent): Promise<ModelLease> {
		if (!this.llama) throw new ModelLoadError('engine', 'Engine not initialized');

		const key = intent === 'advisor' ? 'advisor' : (intent === 'frontend' ? 'fe' : 'be');

		// Load or swap model
		if (!this.activeModel || this.activeKey !== key) {
			if (this.loading) throw new ModelLoadError(key, 'Model load already in progress');
			this.loading = true;
			try {
				if (this.activeModel) {
					await this.unload();
					await new Promise(r => setTimeout(r, 500)); // CUDA reclaim
				}
				const modelPath = this.findModelFile(key);
				if (!modelPath) throw new ModelLoadError(key, `Model resolution failed for "${key}"`);

				const gpuLayers = 'auto'; // or config.models.gpuLayers if added later
				const start = Date.now();
				this.activeModel = await this.llama!.loadModel({ modelPath, gpuLayers });
				this.activeKey = key;
				this.bus.emit('model:loaded', { key, durationMs: Date.now() - start });
			} finally {
				this.loading = false;
			}
		}

		// Cancel idle timer — model is in active use
		this.cancelIdleTimer();

		const leaseId = crypto.randomUUID();
		const lease = new ModelLease(this.activeModel!, leaseId, key, (id) => this.releaseLease(id));
		this.activeLeases.set(leaseId, lease);
		this.bus.emit('model:leased', { key, leaseId });

		return lease;
	}

	private releaseLease(leaseId: string): void {
		const lease = this.activeLeases.get(leaseId);
		if (!lease) return;
		this.activeLeases.delete(leaseId);
		this.bus.emit('model:released', { key: lease.key, leaseId });

		// Start idle timer only when ALL leases released
		if (this.activeLeases.size === 0) {
			this.resetIdleTimer();
		}
	}

	// ── Internals ────────────────────────────────────────────────────────────

	private findModelFile(key: string): string | null {
		// 1. Check explicit configuration
		const cfgPath = key === 'advisor' ? config.models.advisor : (key === 'fe' ? config.models.frontend : config.models.backend);
		if (cfgPath) {
			if (fs.existsSync(cfgPath)) return cfgPath;
			throw new Error(`Configuration Error: Configured model path for ${key} does not exist: ${cfgPath}`);
		}
		
		// 2. Fallback to auto-discovery
		const BASE_MODELS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../models/base');
		if (!fs.existsSync(BASE_MODELS_DIR)) {
			throw new Error(`Configuration Error: No configured path for ${key} and models/base directory missing.`);
		}
		const files = fs.readdirSync(BASE_MODELS_DIR).filter(f => f.endsWith('.gguf'));
		if (key === 'advisor') {
			const match = files.find(f => f.includes('advisor'));
			return match ? path.join(BASE_MODELS_DIR, match) : null;
		}
		const match = files.find(f => f.includes(key) && !f.includes('advisor'));
		return match ? path.join(BASE_MODELS_DIR, match) : null;
	}

	private async unload(): Promise<void> {
		if (!this.activeModel) return;
		// Guard: refuse to unload while leases active
		if (this.activeLeases.size > 0) {
			console.warn(`[ModelManager] Refusing to unload — ${this.activeLeases.size} active lease(s)`);
			return;
		}
		const key = this.activeKey;
		try {
			await this.activeModel.dispose();
		} catch (e) {
			console.error(`[ModelManager] Error disposing "${key}":`, e);
		}
		this.activeModel = null;
		this.activeKey = null;
		if (key) this.bus.emit('model:unloaded', { key });
	}

	private cancelIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	private resetIdleTimer(): void {
		this.cancelIdleTimer();
		this.idleTimer = setTimeout(async () => {
			if (this.activeLeases.size > 0) return; // double check
			await this.unload();
		}, config.generation.requestTimeoutMs);
	}

	// ── Status ───────────────────────────────────────────────────────────────

	get status() {
		return {
			activeKey:    this.activeKey,
			loaded:       this.activeModel !== null,
			loading:      this.loading,
			activeLeases: this.activeLeases.size,
		};
	}

	get hasActiveLeases(): boolean {
		return this.activeLeases.size > 0;
	}
}
