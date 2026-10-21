/*---------------------------------------------------------------------------------------------
 *  CodeCrab Router Client
 *  HTTP client that talks to the Model Router (Phase 2 service).
 *  Phase 1: All methods throw a "router not connected" error gracefully.
 *  Phase 3: Real implementation with SSE streaming and retry logic.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IChatMessage, IFileContext, ISpecialistModel } from './codecrabAiService.js';
import { CodeCrabConfigKeys } from './codecrabConfiguration.js';

export interface IContextUsageData {
	used: number;
	total: number;
	percent: number;
	model?: string;
}

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
	contextSize?: number;    // User-configured context window size in tokens
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
	context?: IContextUsageData;
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

	/** Fired when active model context usage changes. */
	readonly onDidChangeContextUsage: Event<IContextUsageData>;

	/**
	 * Check if the router is reachable.
	 * Phase 1: always returns false.
	 */
	checkHealth(): Promise<IRouterHealthResponse | null>;

	/**
	 * Fetch current context usage telemetry from the router.
	 */
	getContextUsage(): Promise<IContextUsageData | null>;

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

// -------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------

/**
 * Normalize a user-supplied router URL.
 *
 * - Strips a trailing slash so `${url}/health` never becomes `//health`.
 * - Defaults to `http://` when the scheme is missing, otherwise the browser
 *   would try to resolve `localhost:3141` as a relative path and fail with
 *   "Failed to fetch".
 */
export function normalizeRouterUrl(raw: string | undefined): string {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) {
		return 'http://localhost:3141';
	}
	const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	return withScheme.replace(/\/+$/, '');
}

/**
 * Decide whether a thrown value means "the router is not reachable".
 *
 * The workbench runs in Chromium, whose fetch failures surface as
 * `TypeError: Failed to fetch` — Node's `ECONNREFUSED` / "fetch failed"
 * wording never appears. The previous check only looked for the Node
 * wording, so a genuinely-offline router produced a raw "Failed to fetch"
 * stack trace instead of the helpful "router is not running" message.
 */
export function isRouterUnreachable(error: any): boolean {
	if (!error) {
		return false;
	}
	if (error.name === 'AbortError') {
		return false;
	}
	const code = error.cause?.code ?? error.code;
	if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
		return true;
	}
	const message = String(error.message ?? error).toLowerCase();
	return message.includes('failed to fetch')
		|| message.includes('fetch failed')
		|| message.includes('econnrefused')
		|| message.includes('networkerror')
		|| message.includes('load failed');
}

// -------------------------------------------------------------------------------------------
// Implementation
// -------------------------------------------------------------------------------------------
export class CodeCrabRouterClient extends Disposable implements ICodeCrabRouterClient {
	declare readonly _serviceBrand: undefined;

	/**
	 * Base URL of the router.
	 *
	 * Resolved from the `codecrab.routerUrl` setting (default
	 * `http://localhost:3141`). Previously this was hardcoded, which made the
	 * registered setting a no-op and broke the moment the port changed.
	 */
	readonly routerUrl: string;

	private readonly _onDidChangeContextUsage = this._register(new Emitter<IContextUsageData>());
	readonly onDidChangeContextUsage: Event<IContextUsageData> = this._onDidChangeContextUsage.event;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this.routerUrl = normalizeRouterUrl(
			this._configurationService.getValue<string>(CodeCrabConfigKeys.RouterUrl) ?? 'http://localhost:3141'
		);
	}

	// Phase 1 stub — router not built yet
	async checkHealth(): Promise<IRouterHealthResponse | null> {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 2000);
			const response = await fetch(`${this.routerUrl}/health`, { signal: controller.signal });
			clearTimeout(timeoutId);
			if (!response.ok) { return null; }
			const result = await response.json() as IRouterHealthResponse;
			if (result.context) {
				this._onDidChangeContextUsage.fire(result.context);
			}
			return result;
		} catch {
			return null;
		}
	}

	async getContextUsage(): Promise<IContextUsageData | null> {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 2000);
			const response = await fetch(`${this.routerUrl}/context-usage`, { signal: controller.signal });
			clearTimeout(timeoutId);
			if (!response.ok) { return null; }
			const data = await response.json() as IContextUsageData;
			this._onDidChangeContextUsage.fire(data);
			return data;
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
				throw new Error(`Router error: ${res.status} ${res.statusText}`);
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
						const parsed = this._parseChunk(line);
						if (!parsed) { continue; }
						if (parsed.contextUsage) {
							this._onDidChangeContextUsage.fire(parsed.contextUsage);
						}
						if (parsed.content) {
							yield parsed.content;
						}
					}
				}

				// Flush whatever is left in the buffer
				if (buffer.trim()) {
					const parsed = this._parseChunk(buffer);
					if (parsed) {
						if (parsed.contextUsage) {
							this._onDidChangeContextUsage.fire(parsed.contextUsage);
						}
						if (parsed.content) {
							yield parsed.content;
						}
					}
				}
			}
		} catch (error: any) {
			if (error.name === 'AbortError') { return; }
			if (isRouterUnreachable(error)) {
				throw new RouterNotConnectedError();
			}
			throw error;
		} finally {
			disposable.dispose();
		}
	}

	/**
	 * Parse one line of the router's response stream.
	 *
	 * The router speaks three shapes on the same connection:
	 *   1. NDJSON  `{"message":{"content":"..."}}`      — the normal pipeline
	 *   2. NDJSON  `{"type":"context_usage", ...}`      — telemetry
	 *   3. SSE     `data: {"choices":[{"delta":{"content":"..."}}]}` — the
	 *      clarification path, and the `data: [DONE]` sentinel
	 *
	 * The old parser only understood (1) and (2), so the clarification reply
	 * was silently dropped and the user saw an empty response.
	 */
	private _parseChunk(line: string): { content?: string; contextUsage?: IContextUsageData } | null {
		let trimmed = line.trim();
		if (!trimmed) { return null; }

		if (trimmed.startsWith('data:')) {
			trimmed = trimmed.substring(5).trim();
		}
		if (!trimmed || trimmed === '[DONE]') { return null; }

		let data: any;
		try {
			data = JSON.parse(trimmed);
		} catch {
			// Not JSON — ignore malformed chunk rather than killing the stream.
			return null;
		}
		if (!data || typeof data !== 'object') { return null; }

		// (2) context usage telemetry
		if (data.type === 'context_usage' && typeof data.used === 'number') {
			const total = data.total ?? 8192;
			return {
				contextUsage: {
					used: data.used,
					total,
					percent: data.percent ?? Math.round((data.used / total) * 100),
					model: data.model
				}
			};
		}

		// (3) OpenAI-compatible delta
		const delta = data.choices?.[0]?.delta?.content;
		if (typeof delta === 'string' && delta.length > 0) {
			return { content: delta };
		}

		// (1) router pipeline chunk
		if (typeof data.message?.content === 'string' && data.message.content.length > 0) {
			return { content: data.message.content };
		}

		return null;
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
