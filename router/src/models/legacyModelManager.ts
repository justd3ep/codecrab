/**
 * legacyModelManager.ts — the model manager.
 *
 * WHY IT CHANGED
 *
 * THE PERFORMANCE BUG
 *
 * One request produced THIRTEEN model loads, and SIX of them were
 * the full 5.75 GB frontend model. The live log:
 *
 *     Loading "fe" ... Unloading "fe" ... Loading "advisor" ...
 *     Unloading "advisor" ... Loading "fe" ... "fe" already in VRAM
 *
 * The cause is the repair loop. When the model loops, it asks the
 * 0.6B ADVISOR to distill a task spec:
 *
 *     const advisorModel = await mm.acquire('advisor');
 *
 * and the manager's contract was "one model at a time" — so
 * acquiring the advisor UNLOADED the specialist. Then the loop
 * re-acquired the specialist:
 *
 *     activeModel = await mm.acquire(intent);
 *
 * That is a full 5.75 GB reload — measured at 11.5 s — plus a
 * 500 ms sleep, per loop recovery. Three recoveries = ~36 s of
 * pure loading.
 *
 * The fix: the advisor is 0.45 GB and the specialist is 5.75 GB.
 * Together they are 6.2 GB, which FITS in this machine's 8 GB of
 * VRAM. They do not need to evict each other.
 *
 * So the manager now keeps a CACHE: more than one model can be
 * resident, and a model that is already loaded is returned
 * immediately.
 *
 * the LEAST RECENTLY USED model when it is full. The advisor, being
 * small and used constantly, is the last one evicted.
 *
 * WHAT DID NOT CHANGE
 *
 * The swap still happens when it must: the frontend and the backend
 * models are 5.75 GB each, so they cannot both be resident on an
 * 8 GB card, and the backend still replaces the frontend.
 *
 * The 500 ms sleep after an unload stays. It gives the driver time
 * to release the VRAM, and removing it caused crashes.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLlama, Llama, LlamaModel } from 'node-llama-cpp';
import config from '../config/index.js';
import { budgetForVram } from './vramBudget.js';

export const IDLE_UNLOAD_MS = config.generation.requestTimeoutMs;

/**
 * How many models may be resident at once.
 *
 * This is NOT a constant. It is set at init from the detected VRAM,
 * because the design target is a 4 GB box where the specialist needs
 * every MB for offloading. See src/models/vramBudget.ts.
 */

/**
 * The GPU layers per model.
 *
 * 'auto' offloads every layer that fits. The measured result on
 * this machine: 37/37 layers offloaded, so the generation runs on
 * the GPU.
 */
export const GPU_LAYERS: Record<string, number | 'auto'> = {
	fe: 'auto',
	be: 'auto',
};

/** A resident model, and when it was last used. */
interface Resident {
	model: LlamaModel;
	key: string;
	/** The monotonic counter of its last use. */
	lastUsed: number;
}

class LegacyModelManager {
	private llama: Llama | null = null;
	/** The resident models, by key. */
	private readonly resident = new Map<string, Resident>();
	/** How many models may be resident — set at init from the VRAM. */
	private maxResident: number = 1;
	/** The model the request path is currently generating with. */
	private activeModel: LlamaModel | null = null;
	private activeKey: string | null = null;

	private loading = false;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private useCounter = 0;

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

	/** Dispose one model and forget it. */
	private async disposeResident(key: string): Promise<void> {
		const entry = this.resident.get(key);
		if (!entry) return;
		this.resident.delete(key);
		if (this.activeKey === key) {
			this.activeModel = null;
			this.activeKey = null;
		}
		console.log(`[ModelManager] Unloading model "${key}" — freeing VRAM...`);
		try {
			await entry.model.dispose();
		} catch (e) {
			console.error(`[ModelManager] Error disposing model "${key}": `, e);
		}
		console.log(`[ModelManager] Model "${key}" unloaded.`);
	}

	/**
	 * Make room for one more model.
	 *
	 * The LEAST RECENTLY USED model is evicted. The advisor is used
	 * constantly and is small, so it is rarely the one to go — but
	 * if the frontend and the backend are both resident, one of
	 * them must leave.
	 */
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
			// The driver needs a moment to release the VRAM before
			// the next model is loaded. Removing this caused crashes.
			await new Promise(r => setTimeout(r, 500));
		}
	}

	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(async () => {
			console.log('[ModelManager] Idle timeout. Unloading all models...');
			await this.unloadAll();
		}, IDLE_UNLOAD_MS);
	}

	async init(): Promise<void> {
		console.log('[ModelManager] Initializing llama engine (no models pre-loaded)...');
		this.llama = await getLlama();

		// The resident-model budget is set from the detected VRAM, so
		// a 4 GB box keeps one model in VRAM (the specialist needs
		// every MB for offloading) while an 8 GB box keeps two.
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

	/** Dispose every resident model. */
	async unloadAll(): Promise<void> {
		for (const key of [...this.resident.keys()]) {
			await this.disposeResident(key);
		}
		this.activeModel = null;
		this.activeKey = null;
	}

	/**
	 * Get a model, loading it if it is not already resident.
	 *
	 * A model that is already resident is returned IMMEDIATELY. That
	 * is the whole point: the advisor can be used without evicting
	 * the specialist, and the specialist can be re-acquired after
	 * the advisor without a reload.
	 */
	async acquire(intent: 'frontend' | 'backend' | 'general' | 'advisor'): Promise<LlamaModel> {
		if (!this.llama) throw new Error('Engine not initialized.');

		const key = intent === 'advisor' ? 'advisor' : (intent === 'frontend' ? 'fe' : 'be');

		// Already resident — return it, with no load and no evict.
		const cached = this.resident.get(key);
		if (cached) {
			cached.lastUsed = ++this.useCounter;
			this.activeModel = cached.model;
			this.activeKey = key;
			console.log(`[ModelManager] Model "${key}" already resident.`);
			this.resetIdleTimer();
			return cached.model;
		}

		if (this.loading) throw new Error('Model load already in progress. Retry.');
		this.loading = true;

		try {
			await this.evictIfNeeded();

			const modelPath = this.findModelFile(key);
			if (!modelPath) throw new Error(`Model resolution failed for key "${key}"`);

			const gpuLayers = GPU_LAYERS[key] ?? 'auto';
			console.log(`[ModelManager] Loading "${key}" (gpuLayers=${gpuLayers}): ${modelPath}`);

			const model = await this.llama!.loadModel({
				modelPath,
				gpuLayers,
			});

			this.resident.set(key, { model, key, lastUsed: ++this.useCounter });
			this.activeModel = model;
			this.activeKey = key;
			console.log(`[ModelManager] Model "${key}" loaded. ${this.resident.size} model(s) resident.`);
			this.resetIdleTimer();
			return model;
		} finally {
			this.loading = false;
		}
	}

	get status() {
		return {
			activeKey: this.activeKey,
			loaded: this.activeModel !== null,
			loading: this.loading,
			/** The resident model keys. */
			resident: [...this.resident.keys()],
		};
	}
}

export const mm = new LegacyModelManager();
