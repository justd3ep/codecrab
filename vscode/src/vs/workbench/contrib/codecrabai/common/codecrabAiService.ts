/*---------------------------------------------------------------------------------------------
 *  CodeCrab AI Service
 *  Central DI service that the entire IDE uses to communicate with the AI layer.
 *  Phase 1: Returns stub/mock responses.
 *  Phase 3: Wired to the real Model Router HTTP client.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ICodeCrabRouterClient, IRouterChatRequest, IRouterCompletionRequest } from './codecrabRouterClient.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface IFileContext {
	/** Absolute path of the active file, if any. */
	filePath?: string;
	/** Language identifier (e.g. 'typescriptreact', 'html', 'css'). */
	languageId?: string;
	/** A snippet of the file around the cursor (for inline completions). */
	surroundingCode?: string;
}

export interface ISpecialistModel {
	/** Ollama tag, e.g. "codecrab/qwen-fe" */
	ollamaTag: string;
	/** Human-readable name shown in UI */
	displayName: string;
	/** Domain this model specialises in */
	domain: 'frontend' | 'backend' | 'security' | 'database' | 'devops' | 'general';
	/** Whether the model is currently loaded in Ollama */
	status: 'active' | 'idle' | 'unavailable';
	/** Training maturity */
	maturity: 'alpha' | 'beta' | 'stable';
	/** RAM required in GB */
	ramRequiredGb: number;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export const ICodeCrabAiService = createDecorator<ICodeCrabAiService>('ICodeCrabAiService');

export interface ICodeCrabAiService {
	readonly _serviceBrand: undefined;

	/** Fires whenever the active model changes. */
	readonly onDidChangeActiveModel: Event<ISpecialistModel>;

	/** Fires when Ollama connectivity status changes. */
	readonly onDidChangeOllamaStatus: Event<boolean>;

	/**
	 * Stream a chat response from the appropriate specialist model.
	 * Phase 1: Returns a mock async iterable.
	 * Phase 3: Proxies through the Model Router.
	 */
	chat(
		messages: IChatMessage[],
		context: IFileContext,
		token: CancellationToken,
		workspaceRoot?: string,
		openFiles?: string[]
	): AsyncIterable<string>;

	/**
	 * Return an inline completion (fill-in-the-middle) for the current cursor position.
	 * Phase 1: Returns a mock string.
	 * Phase 3: Calls Model Router /v1/completions.
	 */
	complete(
		prefix: string,
		suffix: string,
		languageId: string,
		token: CancellationToken
	): Promise<string>;

	/** Returns metadata for the currently active specialist model. */
	getActiveModel(): ISpecialistModel;

	/** Returns all registered specialist models. */
	listModels(): ISpecialistModel[];

	/** Returns true if the Model Router is reachable. */
	isRouterAvailable(): Promise<boolean>;

	/** Returns true if Ollama is running and reachable. */
	isOllamaAvailable(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Built-in model registry (Phase 1 — hardcoded; Phase 3 — fetched from router)
// ---------------------------------------------------------------------------

const BUILTIN_MODELS: ISpecialistModel[] = [
	{
		ollamaTag: 'codecrab/auto',
		displayName: 'CodeCrab Auto-Router',
		domain: 'general',
		status: 'idle',
		maturity: 'stable',
		ramRequiredGb: 4,
	},
];

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class CodeCrabAiService extends Disposable implements ICodeCrabAiService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveModel = this._register(new Emitter<ISpecialistModel>());
	readonly onDidChangeActiveModel: Event<ISpecialistModel> = this._onDidChangeActiveModel.event;

	private readonly _onDidChangeOllamaStatus = this._register(new Emitter<boolean>());
	readonly onDidChangeOllamaStatus: Event<boolean> = this._onDidChangeOllamaStatus.event;

	private _activeModel: ISpecialistModel = BUILTIN_MODELS[0];
	private _models: ISpecialistModel[] = [...BUILTIN_MODELS];
	private _routerAvailable = false;

	constructor(
		@ICodeCrabRouterClient private readonly _routerClient: ICodeCrabRouterClient
	) {
		super();
	}

	// -------------------------------------------------------------------------
	// Chat (Phase 1 — stub)
	// -------------------------------------------------------------------------

	async *chat(
		messages: IChatMessage[],
		context: IFileContext,
		token: CancellationToken,
		workspaceRoot?: string,
		openFiles?: string[]
	): AsyncIterable<string> {
		const request: IRouterChatRequest = {
			model: this._activeModel.ollamaTag,
			messages: messages,
			stream: true,
			context: context,
			workspaceRoot: workspaceRoot,
			openFiles: openFiles
		};
		yield* this._routerClient.streamChat(request, token);
	}

	// -------------------------------------------------------------------------
	// Inline completion (Phase 1 — stub)
	// -------------------------------------------------------------------------

	async complete(
		prefix: string,
		suffix: string,
		languageId: string,
		token: CancellationToken
	): Promise<string> {
		if (token.isCancellationRequested) { return ''; }

		const request: IRouterCompletionRequest = {
			model: this._activeModel.ollamaTag,
			prompt: `${prefix}<fim_suffix>${suffix}`,
			stream: false,
			language: languageId
		};
		return this._routerClient.complete(request, token);
	}

	// -------------------------------------------------------------------------
	// Model management
	// -------------------------------------------------------------------------

	getActiveModel(): ISpecialistModel {
		return this._activeModel;
	}

	listModels(): ISpecialistModel[] {
		return this._models;
	}

	setActiveModel(ollamaTag: string): void {
		const model = this._models.find(m => m.ollamaTag === ollamaTag);
		if (model && model.ollamaTag !== this._activeModel.ollamaTag) {
			this._activeModel = model;
			this._onDidChangeActiveModel.fire(model);
		}
	}

	// -------------------------------------------------------------------------
	// Connectivity checks (Phase 1 — stubbed)
	// -------------------------------------------------------------------------

	async isRouterAvailable(): Promise<boolean> {
		const health = await this._routerClient.checkHealth();
		const available = health !== null && health.router === 'ok';
		if (this._routerAvailable !== available) {
			this._routerAvailable = available;
			this._onDidChangeOllamaStatus.fire(available);
		}
		if (health && health.models && health.models.length > 0) {
			this._models = [...BUILTIN_MODELS, ...(health.models as unknown as ISpecialistModel[])];
			
			if (health.activeKey) {
				const activeTag = health.activeKey === 'be' || health.activeKey === 'fe' ? `codecrab/qwen-${health.activeKey}` : 'codecrab/base';
				const activeModel = this._models.find(m => m.ollamaTag === activeTag);
				if (activeModel && this._activeModel?.ollamaTag !== activeModel.ollamaTag) {
					this._activeModel = activeModel;
					this._onDidChangeActiveModel.fire(activeModel);
				}
			} else {
				const autoModel = this._models.find(m => m.ollamaTag === 'codecrab/auto');
				if (autoModel && this._activeModel?.ollamaTag !== autoModel.ollamaTag) {
					this._activeModel = autoModel;
					this._onDidChangeActiveModel.fire(autoModel);
				}
			}
		}
		return available;
	}

	async isOllamaAvailable(): Promise<boolean> {
		const health = await this._routerClient.checkHealth();
		return health !== null && health.ollama === 'connected';
	}
}

// ---------------------------------------------------------------------------
// Register in VS Code's DI container
// ---------------------------------------------------------------------------

registerSingleton(ICodeCrabAiService, CodeCrabAiService, InstantiationType.Delayed);
