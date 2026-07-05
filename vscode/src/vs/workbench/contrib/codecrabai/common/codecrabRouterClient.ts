/*---------------------------------------------------------------------------------------------
 *  CodeCrab Router Client
 *  HTTP client that talks to the Model Router (Phase 2 service).
 *  Phase 1: All methods throw a "router not connected" error gracefully.
 *  Phase 3: Real implementation with SSE streaming and retry logic.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IChatMessage, IFileContext, ISpecialistModel } from './codecrabAiService.js';

// ---------------------------------------------------------------------------
// Router response types (OpenAI-compatible)
// ---------------------------------------------------------------------------

export interface IRouterChatRequest {
	model: string;           // "auto" lets the router decide; or explicit "codecrab/qwen-fe"
	messages: IChatMessage[];
	stream: boolean;
	context?: IFileContext;
	workspaceRoot?: string;  // Absolute path to workspace root for server-side context gathering
	openFiles?: string[];    // Absolute paths of currently open editor files
}

export interface IRouterCompletionRequest {
	model: string;
	prompt: string;          // FIM: prefix + <fim_suffix> + suffix
	stream: boolean;
	language?: string;
}

export interface IRouterModelInfo {
	id: string;
	ollamaTag: string;
	domain: string;
	status: string;
	maturity: string;
	ramRequiredGb: number;
}

export interface IRouterHealthResponse {
	router: 'ok' | 'error';
	ollama: 'connected' | 'disconnected';
	activeKey?: string;
	models: IRouterModelInfo[];
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export const ICodeCrabRouterClient = createDecorator<ICodeCrabRouterClient>('ICodeCrabRouterClient');

export interface ICodeCrabRouterClient {
	readonly _serviceBrand: undefined;

	/** Base URL of the Model Router, e.g. http://localhost:3141 */
	readonly routerUrl: string;

	/**
	 * Check if the router is reachable.
	 * Phase 1: always returns false.
	 */
	checkHealth(): Promise<IRouterHealthResponse | null>;

	/**
	 * Stream a chat response from the router.
	 * Phase 1: throws RouterNotConnectedError.
	 * Phase 3: streams SSE tokens from the router.
	 */
	streamChat(
		request: IRouterChatRequest,
		token: CancellationToken
	): AsyncIterable<string>;

	/**
	 * Request an inline completion from the router.
	 * Phase 1: returns empty string.
	 * Phase 3: POST /v1/completions and returns the completion text.
	 */
	complete(
		request: IRouterCompletionRequest,
		token: CancellationToken
	): Promise<string>;

	/**
	 * Fetch the list of available specialist models from the router.
	 * Phase 1: returns an empty array.
	 * Phase 3: GET /v1/models.
	 */
	listModels(): Promise<ISpecialistModel[]>;

	/**
	 * Tell the router to index a workspace for RAG.
	 * Indexing is non-blocking on the router side.
	 */
	indexWorkspace(workspaceRoot: string): Promise<void>;

	/**
	 * Notify the router that a file was saved so it can update the RAG index.
	 */
	updateIndexedFile(workspaceRoot: string, filePath: string, content: string): Promise<void>;

	/**
	 * Notify the router that files were deleted so it can purge stale vectors.
	 * Accepts a batch to match onDidDeleteFiles which fires once per multi-delete.
	 */
	deleteIndexedFiles(workspaceRoot: string, filePaths: string[]): Promise<void>;

	/**
	 * Run a startup sync — purges any indexed vectors whose source files no longer exist.
	 * Call on activation to recover from crashes, git checkouts, or terminal deletes.
	 */
	syncIndex(workspaceRoot: string): Promise<{ purged: number }>;
}

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class RouterNotConnectedError extends Error {
	constructor() {
		super(
			'CodeCrab Model Router is not running. ' +
			'Start the router with: cd router && npm run dev\n' +
			'(Router expected at http://localhost:3141)'
		);
		this.name = 'RouterNotConnectedError';
	}
}

// ---------------------------------------------------------------------------
// Phase 1 stub implementation
// ---------------------------------------------------------------------------

export class CodeCrabRouterClient extends Disposable implements ICodeCrabRouterClient {
	declare readonly _serviceBrand: undefined;

	/**
	 * Phase 2: This URL will come from a workspace configuration setting.
	 * For now it is hardcoded to the default router port.
	 */
	readonly routerUrl = 'http://localhost:3141';

	constructor() {
		super();
	}

	// Phase 1 stub — router not built yet
	async checkHealth(): Promise<IRouterHealthResponse | null> {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 2000);
			const response = await fetch(`${this.routerUrl}/health`, { signal: controller.signal });
			clearTimeout(timeoutId);
			if (!response.ok) { return null; }
			return await response.json() as IRouterHealthResponse;
		} catch {
			return null;
		}
	}

	// Phase 3 implementation
	async *streamChat(
		request: IRouterChatRequest,
		token: CancellationToken
	): AsyncIterable<string> {
		if (token.isCancellationRequested) { return; }
		
		const controller = new AbortController();
		const disposable = token.onCancellationRequested(() => controller.abort());

		try {
			const res = await fetch(`${this.routerUrl}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request),
				signal: controller.signal
			});

			if (!res.ok) {
				throw new Error(`Router error: ${res.statusText}`);
			}

			if (res.body) {
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';
				
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() || ''; // Keep the last, potentially incomplete line
					
					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) continue;
						try {
							const data = JSON.parse(trimmed);
							if (data.message?.content) {
								yield data.message.content;
							}
						} catch (e) {
							// Ignore parse errors for corrupt chunks
						}
					}
				}

				if (buffer.trim()) {
					try {
						const data = JSON.parse(buffer.trim());
						if (data.message?.content) {
							yield data.message.content;
						}
					} catch (e) {}
				}
			}
		} catch (error: any) {
			if (error.name === 'AbortError') { return; }
			if (error.cause?.code === 'ECONNREFUSED' || error.message.includes('fetch failed')) {
				throw new RouterNotConnectedError();
			}
			throw error;
		} finally {
			disposable.dispose();
		}
	}

	// Phase 3 implementation
	async complete(
		request: IRouterCompletionRequest,
		token: CancellationToken
	): Promise<string> {
		if (token.isCancellationRequested) { return ''; }
		
		const controller = new AbortController();
		const disposable = token.onCancellationRequested(() => controller.abort());
		
		try {
			const res = await fetch(`${this.routerUrl}/v1/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(request),
				signal: controller.signal
			});

			if (!res.ok) { return ''; }
			
			const data = await res.json() as any;
			return data.response || '';
		} catch {
			return '';
		} finally {
			disposable.dispose();
		}
	}

	// Phase 3 implementation
	async listModels(): Promise<ISpecialistModel[]> {
		try {
			const res = await fetch(`${this.routerUrl}/v1/models`);
			if (!res.ok) return [];
			return await res.json() as ISpecialistModel[];
		} catch {
			return [];
		}
	}

	async indexWorkspace(workspaceRoot: string): Promise<void> {
		try {
			await fetch(`${this.routerUrl}/v1/index`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ workspaceRoot }),
			});
		} catch {
			// Router may not be running — silent fail
		}
	}

	async updateIndexedFile(workspaceRoot: string, filePath: string, content: string): Promise<void> {
		try {
			await fetch(`${this.routerUrl}/v1/index/file`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ workspaceRoot, filePath, content }),
			});
		} catch {
			// Silent fail
		}
	}

	async deleteIndexedFiles(workspaceRoot: string, filePaths: string[]): Promise<void> {
		if (filePaths.length === 0) return;
		try {
			await fetch(`${this.routerUrl}/v1/index/delete`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ workspaceRoot, filePaths }),
			});
		} catch {
			// Silent fail — router may not be running
		}
	}

	async syncIndex(workspaceRoot: string): Promise<{ purged: number }> {
		try {
			const res = await fetch(`${this.routerUrl}/v1/index/sync`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ workspaceRoot }),
			});
			if (!res.ok) return { purged: 0 };
			return await res.json() as { purged: number };
		} catch {
			return { purged: 0 };
		}
	}
}

// ---------------------------------------------------------------------------
// Register in VS Code's DI container
// ---------------------------------------------------------------------------

registerSingleton(ICodeCrabRouterClient, CodeCrabRouterClient, InstantiationType.Delayed);
