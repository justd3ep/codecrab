/**
 * EmbeddingManager — CPU-based embedding model for RAG.
 *
 * Extracted from index.ts. Runs on CPU, non-blocking.
 * Independent of ModelManager (GPU).
 */

import fs                              from 'fs';
import path                            from 'path';
import { getLlama }                    from 'node-llama-cpp';
import type { Llama, LlamaModel, LlamaEmbeddingContext } from 'node-llama-cpp';
import config                          from '@/config/index.js';

export class EmbeddingManager {
	private llama: Llama | null = null;
	private model: LlamaModel | null = null;
	private ctx:   LlamaEmbeddingContext | null = null;
	private ready = false;

	constructor() {}

	async init(): Promise<void> {
		const modelPath = config.models.embedding;
		if (!modelPath) {
			console.warn(`[EmbeddingManager] No embedding model configured`);
			return;
		}

		if (!fs.existsSync(modelPath)) {
			console.warn(`[EmbeddingManager] Embedding model not found at configured path: ${modelPath}`);
			return;
		}

		console.log(`[EmbeddingManager] Loading on CPU: ${path.basename(modelPath)}`);

		this.llama = await getLlama();
		this.model = await this.llama.loadModel({
			modelPath,
			gpuLayers: 0,  // always CPU
		});
		this.ctx = await this.model.createEmbeddingContext();
		this.ready = true;
		console.log('[EmbeddingManager] Ready — RAG enabled.');
	}

	get isReady(): boolean { return this.ready; }

	async embed(text: string): Promise<number[]> {
		if (!this.ctx) throw new Error('EmbeddingManager not initialized');
		const result = await this.ctx.getEmbeddingFor(text);
		return Array.from(result.vector);
	}

	async dispose(): Promise<void> {
		if (this.ctx)   { await this.ctx.dispose();   this.ctx = null; }
		if (this.model) { await this.model.dispose(); this.model = null; }
		this.ready = false;
	}
}
