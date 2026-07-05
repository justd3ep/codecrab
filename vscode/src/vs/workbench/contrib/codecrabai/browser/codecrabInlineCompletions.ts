/*---------------------------------------------------------------------------------------------
 *  CodeCrab Inline Completions Provider
 *  Provides ghost-text completions in the editor powered by CodeCrab's specialist models.
 *
 *  Phase 1: Returns empty/mock completions (no real model call).
 *  Phase 3: Calls ICodeCrabAiService.complete() → Model Router → Ollama → qwen-fe.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ICodeCrabAiService } from '../common/codecrabAiService.js';

// ---------------------------------------------------------------------------
// Contribution registration
// ---------------------------------------------------------------------------

import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions, IWorkbenchContribution } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';

// Debounce time in ms before triggering a completion request
const COMPLETION_DEBOUNCE_MS = 350;

// Minimum characters before the cursor before we attempt a completion
const MIN_PREFIX_LENGTH = 10;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class CodeCrabInlineCompletionProvider extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.codecrabInlineCompletion';

	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@ICodeCrabAiService private readonly _aiService: ICodeCrabAiService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
	) {
		super();
		this._registerEditorListener();
	}

	private _registerEditorListener(): void {
		// Listen to all editor cursor-position changes and trigger completions
		this._register(
			this._codeEditorService.onCodeEditorAdd(editor => {
				this._register(
					editor.onDidChangeCursorPosition(() => {
						this._scheduleCompletion(editor);
					})
				);
			})
		);
	}

	private _scheduleCompletion(editor: ICodeEditor): void {
		if (this._debounceTimer !== undefined) {
			clearTimeout(this._debounceTimer);
		}

		this._debounceTimer = setTimeout(async () => {
			await this._triggerCompletion(editor);
		}, COMPLETION_DEBOUNCE_MS);
	}

	private async _triggerCompletion(
		editor: ICodeEditor
	): Promise<void> {
		const model = editor.getModel();
		if (!model) { return; }

		const position = editor.getPosition();
		if (!position) { return; }

		const languageId = model.getLanguageId();
		const offset = model.getOffsetAt(position);
		const fullText = model.getValue();

		const prefix = fullText.substring(0, offset);
		const suffix = fullText.substring(offset);

		if (prefix.trim().length < MIN_PREFIX_LENGTH) { return; }

		try {
			// Phase 1: returns empty string (stub).
			// Phase 3: will return real completion text.
			await this._aiService.complete(
				prefix,
				suffix,
				languageId,
				CancellationToken.None
			);

			// Phase 3: set ghost text via editor.setGhostText() or inline completion provider
			// For now, this is a no-op in Phase 1.
		} catch {
			// Silently ignore — completions are best-effort
		}
	}

	override dispose(): void {
		if (this._debounceTimer !== undefined) {
			clearTimeout(this._debounceTimer);
		}
		super.dispose();
	}
}

// ---------------------------------------------------------------------------
// Register as a workbench contribution
// ---------------------------------------------------------------------------

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	CodeCrabInlineCompletionProvider,
	LifecyclePhase.Restored
);
