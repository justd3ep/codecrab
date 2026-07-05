/**
 * GenerationEngine — compose PromptBuilder + ModelExecutor + OutputParser.
 * Workers call this; swap executor to change model backend.
 */

import type { FileNode, ExecutionGraph, GeneratedFile } from '../core/types.js';
import type { GenerationConfig }                         from '../config/types.js';
import type { LlamaModel }                               from 'node-llama-cpp';
import { buildSingleFilePrompt, buildRepairPrompt }      from './promptBuilder.js';
import { ModelExecutor }                                 from './modelExecutor.js';
import { extractFileBlocks }                             from './outputParser.js';

export interface GenerationContext {
	graph:       ExecutionGraph;
	userRequest: string;
	depSignatures?: string;
}

export class GenerationEngine {
	private readonly executor: ModelExecutor;

	constructor(model: LlamaModel, config: GenerationConfig, systemPrompt: string) {
		this.executor = new ModelExecutor(model, config, systemPrompt);
	}

	async generateFile(
		node:   FileNode,
		ctx:    GenerationContext,
		opts:   { signal: AbortSignal; jobId: string },
	): Promise<GeneratedFile[]> {
		const promptCtx: import('./promptBuilder.js').PromptContext = {
			graph:       ctx.graph,
			userRequest: ctx.userRequest,
			...(ctx.depSignatures !== undefined ? { depSignatures: ctx.depSignatures } : {}),
		};
		const prompt = buildSingleFilePrompt(node, promptCtx);
		const raw   = await this.executor.execute(prompt, { signal: opts.signal, jobId: opts.jobId, nodeId: node.path });
		const files = extractFileBlocks(raw);
		// Filter to only the target file (prevent hallucinated extras)
		return files.filter(f => f.path === node.path || files.length === 1);
	}

	async repairFile(
		filePath:    string,
		content:     string,
		issues:      Array<{ message: string; kind: string }>,
		depCtx:      string,
		opts:        { signal: AbortSignal; jobId: string },
	): Promise<GeneratedFile[]> {
		const prompt = buildRepairPrompt(filePath, content, issues, depCtx);
		const raw    = await this.executor.execute(prompt, { signal: opts.signal, jobId: opts.jobId, nodeId: filePath });
		return extractFileBlocks(raw);
	}
}
