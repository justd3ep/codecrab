/**
 * legacyModelManager.ts — Legacy raw-LlamaModel single-VRAM slot manager.
 *
 * Extracted from index.ts (Step G).
 * Provides raw LlamaModel instances needed by legacy completions handler.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLlama, Llama, LlamaModel } from 'node-llama-cpp';
import config from '../config/index.js';

export const GPU_LAYERS: Record<string, number | 'auto'> = {
	fe: 'auto',
	be: 'auto',
};

export const IDLE_UNLOAD_MS = config.generation.requestTimeoutMs; // 5 min idle → unload model

class LegacyModelManager {
	private llama: Llama | null = null;
	private activeModel: LlamaModel | null = null;
	private activeKey: string | null = null;
	private loading = false;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

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
		const key = this.activeKey;
		console.log(`[ModelManager] Unloading model "${key}" — freeing VRAM...`);
		try {
			await this.activeModel.dispose();
		} catch (e) {
			console.error(`[ModelManager] Error disposing model "${key}": `, e);
		}
		this.activeModel = null;
		this.activeKey = null;
		console.log(`[ModelManager] Model "${key}" unloaded.`);
	}

	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(async () => {
			console.log(`[ModelManager] Idle timeout. Unloading model...`);
			await this.unload();
		}, IDLE_UNLOAD_MS);
	}

	async init(): Promise<void> {
		console.log(`[ModelManager] Initializing llama engine (no models pre-loaded)...`);
		this.llama = await getLlama();
		console.log(`[ModelManager] Engine ready. VRAM: 0 models loaded.`);
	}

	async acquire(intent: 'frontend' | 'backend' | 'general' | 'advisor'): Promise<LlamaModel> {
		if (!this.llama) throw new Error('Engine not initialized.');

		const key = intent === 'advisor' ? 'advisor' : (intent === 'frontend' ? 'fe' : 'be');

		if (this.activeModel && this.activeKey === key) {
			console.log(`[ModelManager] Model "${key}" already in VRAM.`);
			this.resetIdleTimer();
			return this.activeModel;
		}

		if (this.loading) throw new Error('Model load already in progress. Retry.');
		this.loading = true;

		try {
			if (this.activeModel) {
				console.log(`[ModelManager] Swapping "${this.activeKey}" → "${key}"`);
				await this.unload();
				await new Promise(r => setTimeout(r, 500));
			}

			const modelPath = this.findModelFile(key);
			if (!modelPath) throw new Error(`Model resolution failed for key "${key}"`);

			const gpuLayers = GPU_LAYERS[key] ?? 'auto';
			console.log(`[ModelManager] Loading "${key}" (gpuLayers=${gpuLayers}): ${modelPath}`);

			this.activeModel = await this.llama!.loadModel({
				modelPath,
				gpuLayers,
			});
			this.activeKey = key;
			console.log(`[ModelManager] Model "${key}" loaded. VRAM swap complete.`);
			this.resetIdleTimer();
			return this.activeModel;
		} finally {
			this.loading = false;
		}
	}

	get status() {
		return {
			activeKey: this.activeKey,
			loaded: this.activeModel !== null,
			loading: this.loading,
		};
	}
}

export const mm = new LegacyModelManager();
