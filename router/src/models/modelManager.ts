/**
 * modelManager.ts — the job pipeline's model manager.
 *
 * WHY IT CHANGED
 *
 * This file had the SAME bug as legacyModelManager.ts: one model at
 * a time, so acquiring the advisor EVICTED the specialist and the
 * loop re-acquired it — a measured 11.5 s reload plus a 500 ms
 * sleep, per loop recovery. The job pipeline — which is the newer
 * path and the one the fine-tuning goal depends on — was producing
 * the same 13-model-load thrash.
 *
 * THE 4 GB TARGET
 *
 * The cache size is NOT a constant. It is set at init from the
 * detected VRAM, because the design target is a 4 GB box where the
 * specialist needs every MB for offloading:
 *
 *   <= 5 GB   1 model   the specialist needs the VRAM
 *   6-9 GB    2 models the advisor fits alongside
 *   > 9 GB    3 models FE + BE + advisor
 *
 * On a 4 GB box the 0.45 GB advisor must NOT stay resident — it
 * steals VRAM from the specialist and makes its offloading less
 * rigorous. The original one-model-at-a-time design was correct
 * there.
 *
 * The eviction is still LRU: whichever model was used least
 * recently goes first.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLlama, Llama, LlamaModel } from 'node-llama-cpp';
import { EventBus } from '../core/eventBus.js';
import config from '@/config/index.js';
import { ModelLease } from './modelLease.js';
import { ModelLoadError } from '../core/errors.js';
import { budgetForVram } from './vramBudget.js';

export type ModelIntent = 'frontend' | 'backend' | 'general' | 'advisor';

interface Resident {
	model: LlamaModel;
	key: string;
	lastUsed: number;
}

export class ModelManager {
	private llama: Llama | null = null;
	private readonly resident = new Map<string, Resident>();
	private maxResident: number = 1;
	private loading = false;
	private useCounter = 0;

	constructor(private readonly bus: EventBus) {}

	async init(): Promise<void> {
		this.llama = await getLlama();
		this.maxResident = await this.detectBudget();
		console.log(`[ModelManager] Engine ready. VRAM budget: ${this.maxResident} model(s) resident.`);
	}

	private async detectBudget(): Promise<number> {
		try {
			const state = await this.llama!.getVramState?.();
			if (state && typeof state.total === 'number' && state.total > 0) {
				return budgetForVram(state.total);
			}
		} catch {
			// Fall through to the conservative default.
		}
		return 1; // unknown — the design target
	}

	private findModelFile(key: string): string | null {
		const cfgPath = key === 'advisor' ? config.models.advisor : (key === 'fe' ? config.models.frontend : config.models.backend);
		if (cfgPath) {
			if (fs.existsSync(cfgPath)) return cfgPath;
			throw new ModelLoadError(key, `Configuration Error: Configured model path for ${key} does not exist: ${cfgPath}`);
		}
		const BASE_MODELS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../models/base');
		if (!fs.existsSync(BASE_MODELS_DIR)) {
			throw new ModelLoadError(key, `Configuration Error: No configured path for ${key} and models/base directory missing.`);
		}
		const files = fs.readdirSync(BASE_MODELS_DIR).filter(f => f.endsWith('.gguf'));
		if (key === 'advisor') {
			const match = files.find(f => f.includes('advisor'));
			return match ? path.join(BASE_MODELS_DIR, match) : null;
		}
		const match = files.find(f => f.includes(key) && !f.includes('advisor'));
		return match ? path.join(BASE_MODELS_DIR, match) : null;
	}

	private async disposeResident(key: string): Promise<void> {
		const entry = this.resident.get(key);
		if (!entry) return;
		this.resident.delete(key);
		console.log(`[ModelManager] Unloading model "${key}" — freeing VRAM...`);
		try {
			await entry.model.dispose();
		} catch (e) {
			console.error(`[ModelManager] Error disposing model "${key}": `, e);
		}
		console.log(`[ModelManager] Model "${key}" unloaded.`);
	}

	private async evictIfNeeded(): Promise<void> {
		while (this.resident.size >= this.maxResident) {
			let oldestKey: string | null = null;
			let oldestUse = Number.POSITIVE_INFINITY;
			for (const [key, entry] of this.resident) {
				if (entry.lastUsed < oldestUse) {
					oldestUse = entry.lastUsed;
					oldestKey = key;
				}
			}
			if (!oldestKey) return;
			console.log(`[ModelManager] Evicting "${oldestKey}" — the cache is full (${this.maxResident} models).`);
			await this.disposeResident(oldestKey);
			// The driver needs a moment to release the VRAM before the
			// next model is loaded. Removing this caused crashes.
			await new Promise(r => setTimeout(r, 500));
		}
	}

	async acquire(intent: ModelIntent): Promise<ModelLease> {
		if (!this.llama) throw new ModelLoadError('engine', 'Engine not initialized');

		const key = intent === 'advisor' ? 'advisor' : (intent === 'frontend' ? 'fe' : 'be');

		// Already resident — return it, with no load and no evict.
		const cached = this.resident.get(key);
		if (cached) {
			cached.lastUsed = ++this.useCounter;
			this.bus.emit('model:leased', { key, leaseId: 'resident' });
			return new ModelLease(cached.model, 'resident', key, () => {});
		}

		if (this.loading) throw new ModelLoadError(key, 'Model load already in progress');
		this.loading = true;

		try {
			await this.evictIfNeeded();

			const modelPath = this.findModelFile(key);
			if (!modelPath) throw new ModelLoadError(key, `Model resolution failed for "${key}"`);

			const gpuLayers = 'auto';
			const start = Date.now();
			console.log(`[ModelManager] Loading "${key}" (gpuLayers=${gpuLayers}): ${modelPath}`);
			const model = await this.llama!.loadModel({ modelPath, gpuLayers });
			this.resident.set(key, { model, key, lastUsed: ++this.useCounter });
			this.bus.emit('model:loaded', { key, durationMs: Date.now() - start });
			console.log(`[ModelManager] Model "${key}" loaded. ${this.resident.size} model(s) resident.`);
		} finally {
			this.loading = false;
		}

		const leaseId = crypto.randomUUID();
		const entry = this.resident.get(key)!;
		const lease = new ModelLease(entry.model, leaseId, key, (id) => this.releaseLease(id));
		this.bus.emit('model:leased', { key, leaseId });
		return lease;
	}

	private releaseLease(leaseId: string): void {
		if (leaseId === 'resident') return;
		this.bus.emit('model:released', { key: 'lease', leaseId });
	}

	get status() {
		return {
			loaded: this.resident.size > 0,
			loading: this.loading,
			resident: [...this.resident.keys()],
		};
	}
}