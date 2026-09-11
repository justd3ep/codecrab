/*---------------------------------------------------------------------------------------------
 *  CodeCrab Language Model Provider
 *  Registers CodeCrab's qwen-fe (and future specialists) into VS Code's
 *  ILanguageModelsService so the Chat panel shows CodeCrab models instead of Copilot.
 *
 *  Phase 1: Stub provider — models appear in the picker, responses are mocked.
 *  Phase 3: Delegates to ICodeCrabAiService which calls the real Model Router.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	ChatMessageRole,
	IChatMessage,
	IChatResponsePart,
	ILanguageModelChatMetadata,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse,
	ILanguageModelChatInfoOptions,
	ILanguageModelsService,
} from '../../chat/common/languageModels.js';
import { ICodeCrabAiService } from './codecrabAiService.js';

// ---------------------------------------------------------------------------
// CodeCrab vendor / model identifiers
// ---------------------------------------------------------------------------

export const CODECRAB_VENDOR_ID = 'codecrab';

export const CODECRAB_MODELS: ILanguageModelChatMetadata[] = [
	{
		extension: new ExtensionIdentifier('codecrab.ai'),
		name: 'CodeCrab Auto-Router',
		id: 'codecrab/auto',
		vendor: CODECRAB_VENDOR_ID,
		version: '1.0.0',
		tooltip: 'CodeCrab Intelligent Routing System',
		detail: 'Automatically selects the best model for your task',
		family: 'auto',
		maxInputTokens: 8192,
		maxOutputTokens: 4096,
		isDefaultForLocation: {},
		isUserSelectable: true,
		capabilities: {
			vision: false,
			toolCalling: true,
			agentMode: true,
		},
	},
];

// ---------------------------------------------------------------------------
// Service decorator (so other services can inject ICodeCrabLanguageModelProvider)
// ---------------------------------------------------------------------------

export const ICodeCrabLanguageModelProvider =
	createDecorator<ICodeCrabLanguageModelProvider>('ICodeCrabLanguageModelProvider');

export interface ICodeCrabLanguageModelProvider {
	readonly _serviceBrand: undefined;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class CodeCrabLanguageModelProvider
	extends Disposable
	implements ILanguageModelChatProvider, ICodeCrabLanguageModelProvider
{
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@ICodeCrabAiService private readonly _aiService: ICodeCrabAiService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
	) {
		super();
		// Register this provider under the "codecrab" vendor
		this._register(
			this._languageModelsService.registerLanguageModelProvider(CODECRAB_VENDOR_ID, this)
		);
	}

	// -------------------------------------------------------------------------
	// ILanguageModelChatProvider implementation
	// -------------------------------------------------------------------------

	async provideLanguageModelChatInfo(
		_options: ILanguageModelChatInfoOptions,
		_token: CancellationToken
	): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		return CODECRAB_MODELS.map(metadata => ({
			metadata,
			identifier: metadata.id,
		}));
	}

	async sendChatRequest(
		_modelId: string,
		messages: IChatMessage[],
		_from: ExtensionIdentifier | undefined,
		_options: ILanguageModelChatRequestOptions,
		token: CancellationToken
	): Promise<ILanguageModelChatResponse> {
		// Convert VS Code's IChatMessage[] to our simpler format
		const simplifiedMessages = messages.map(m => ({
			role: m.role === ChatMessageRole.User
				? 'user' as const
				: m.role === ChatMessageRole.Assistant
					? 'assistant' as const
					: 'system' as const,
			content: m.content
				.filter(p => p.type === 'text')
				.map(p => (p as { type: 'text'; value: string }).value)
				.join(''),
		}));

		const activeModel = this._aiService.getActiveModel();
		const context = {
			languageId: undefined,
			filePath: undefined,
		};

		// Extract workspace info from options (injected by chatSetupProviders)
		const opts = _options as any;
		const workspaceRoot = opts?.workspaceRoot as string | undefined;
		const openFiles = opts?.openFiles as string[] | undefined;
		const contextSize = opts?.contextSize as number | undefined;

		// Create the async stream from the AI service
		const tokenStream = this._aiService.chat(simplifiedMessages, context, token, workspaceRoot, openFiles, contextSize);

		// Wrap in VS Code's ILanguageModelChatResponse shape
		const parts: IChatResponsePart[] = [];

		const stream: AsyncIterable<IChatResponsePart | IChatResponsePart[]> = {
			[Symbol.asyncIterator]() {
				return (async function* () {
					for await (const chunk of tokenStream) {
						const part: IChatResponsePart = { type: 'text', value: chunk };
						parts.push(part);
						yield part;
					}
				})();
			}
		};

		return {
			stream,
			result: Promise.resolve({ model: activeModel.ollamaTag }),
		};
	}

	async provideTokenCount(
		_modelId: string,
		message: string | IChatMessage,
		_token: CancellationToken
	): Promise<number> {
		// Phase 1 stub: rough estimate (4 chars ≈ 1 token)
		const text = typeof message === 'string'
			? message
			: message.content
				.filter(p => p.type === 'text')
				.map(p => (p as { type: 'text'; value: string }).value)
				.join('');
		return Math.ceil(text.length / 4);
	}
}

// ---------------------------------------------------------------------------
// Register in VS Code's DI container
// ---------------------------------------------------------------------------

registerSingleton(
	ICodeCrabLanguageModelProvider,
	CodeCrabLanguageModelProvider,
	InstantiationType.Eager  // Eager so it registers immediately on workbench init
);
