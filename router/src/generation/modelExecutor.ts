/**
 * ModelExecutor — node-llama-cpp adapter.
 * Implements GenerationEngine interface → swappable for Ollama/OpenAI/vLLM.
 */

import { LlamaChatSession }               from 'node-llama-cpp';
import type { LlamaModel }                from 'node-llama-cpp';
import type { GenerationConfig }          from '../config/types.js';
import { detectRepetitionLoop }           from './outputParser.js';
import { GenerationAbortedError }         from '../core/errors.js';

export interface ExecutionOptions {
	signal:  AbortSignal;
	jobId:   string;
	nodeId:  string;
}

export class ModelExecutor {
	constructor(
		private readonly model:  LlamaModel,
		private readonly config: GenerationConfig,
		private readonly systemPrompt: string,
	) {}

	async execute(prompt: string, opts: ExecutionOptions): Promise<string> {
		const ctx     = await this.model.createContext({ contextSize: this.config.maxTokensPerFile });
		const session = new LlamaChatSession({ contextSequence: ctx.getSequence(), systemPrompt: this.systemPrompt });

		let raw          = '';
		let loopDetected = false;
		let loopReason   = '';

		try {
			await session.prompt(prompt, {
				maxTokens:         this.config.maxTokensPerFile,
				signal:            opts.signal,
				stopOnAbortSignal: true,
				onTextChunk(chunk) {
					raw += chunk;
					const check = detectRepetitionLoop(raw);
					if (check.detected) { loopDetected = true; loopReason = check.reason ?? 'loop'; }
				},
			});
		} finally {
			await ctx.dispose();
		}

		if (loopDetected) {
			throw new GenerationAbortedError(opts.jobId, opts.nodeId, `Repetition loop: ${loopReason}`);
		}
		if (opts.signal.aborted) {
			throw new GenerationAbortedError(opts.jobId, opts.nodeId, 'Aborted');
		}

		return raw;
	}
}
