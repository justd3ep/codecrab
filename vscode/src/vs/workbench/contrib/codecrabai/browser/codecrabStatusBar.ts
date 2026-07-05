/*---------------------------------------------------------------------------------------------
 *  CodeCrab Status Bar Item
 *  Shows the active specialist model and Ollama connection status in the status bar.
 *  e.g.:  🦀 qwen-fe (alpha)   or   🦀 Ollama offline
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { ICodeCrabAiService } from '../common/codecrabAiService.js';
import { ICodeCrabLanguageModelProvider } from '../common/codecrabLanguageModel.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions, IWorkbenchContribution } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';

const STATUS_BAR_ENTRY_ID = 'codecrab.statusBar.activeModel';
// @ts-ignore
const OLLAMA_CHECK_INTERVAL_MS = 30_000; // 30 seconds
const ROUTER_CHECK_INTERVAL_MS = 30_000;

export class CodeCrabStatusBarItem extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.codecrabStatusBar';

	private _statusBarEntry: IStatusbarEntryAccessor | undefined;
	private _routerCheckTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		@ICodeCrabAiService private readonly _aiService: ICodeCrabAiService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		// @ts-ignore
		@ICodeCrabLanguageModelProvider private readonly _languageModelProvider: ICodeCrabLanguageModelProvider,
	) {
		super();
		this._createStatusBarEntry();
		this._startRouterCheck();
		this._register(this._aiService.onDidChangeActiveModel(() => this._updateStatusBar()));
	}

	// -------------------------------------------------------------------------
	// Status bar management
	// -------------------------------------------------------------------------

	private _createStatusBarEntry(): void {
		const activeModel = this._aiService.getActiveModel();
		this._statusBarEntry = this._register(
			this._statusbarService.addEntry(
				{
					name: 'CodeCrab Active Model',
					text: `🦀 ${activeModel.displayName}`,
					tooltip: this._buildTooltip(),
					ariaLabel: `CodeCrab: ${activeModel.displayName}`,
					command: 'codecrab.openModelManager',
				},
				STATUS_BAR_ENTRY_ID,
				StatusbarAlignment.RIGHT,
				// Priority: just to the left of language indicator
				100
			)
		);
	}

	private _updateStatusBar(routerAvailable?: boolean): void {
		if (!this._statusBarEntry) { return; }

		const activeModel = this._aiService.getActiveModel();

		if (routerAvailable === false) {
			this._statusBarEntry.update({
				name: 'CodeCrab Active Model',
				text: `🦀 Router offline`,
				tooltip: 'CodeCrab: Local Model Router is not running.\nStart the router on port 3141 to enable AI features.',
				ariaLabel: 'CodeCrab: Router offline',
				command: 'codecrab.openModelManager',
				backgroundColor: undefined,
			});
			return;
		}

		this._statusBarEntry.update({
			name: 'CodeCrab Active Model',
			text: `🦀 ${activeModel.displayName}`,
			tooltip: this._buildTooltip(),
			ariaLabel: `CodeCrab: ${activeModel.displayName}`,
			command: 'codecrab.openModelManager',
		});
	}

	private _buildTooltip(): string {
		const model = this._aiService.getActiveModel();
		return [
			`CodeCrab AI — Active Model`,
			``,
			`  Model:   ${model.ollamaTag}`,
			`  Domain:  ${model.domain}`,
			`  Status:  ${model.maturity}`,
			`  RAM:     ${model.ramRequiredGb} GB required`,
			``,
			`Click to open Model Manager`,
		].join('\n');
	}

	// -------------------------------------------------------------------------
	// Ollama connectivity polling
	// -------------------------------------------------------------------------

	private _startRouterCheck(): void {
		// Initial check
		this._checkRouter();
		// Periodic check
		this._routerCheckTimer = setInterval(() => this._checkRouter(), ROUTER_CHECK_INTERVAL_MS);
	}

	private async _checkRouter(): Promise<void> {
		const available = await this._aiService.isRouterAvailable();
		this._updateStatusBar(available);
	}

	override dispose(): void {
		if (this._routerCheckTimer !== undefined) {
			clearInterval(this._routerCheckTimer);
		}
		super.dispose();
	}
}

// ---------------------------------------------------------------------------
// Register as a workbench contribution
// ---------------------------------------------------------------------------

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	CodeCrabStatusBarItem,
	LifecyclePhase.Restored
);
