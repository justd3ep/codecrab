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
const CONTEXT_STATUS_BAR_ENTRY_ID = 'codecrab.statusBar.contextUsage';

function renderContextBar(used: number, total: number): string {
	const effectiveTotal = total > 0 ? total : 8192;
	const pct = Math.min(100, Math.max(0, Math.round((used / effectiveTotal) * 100)));
	const totalBlocks = 8;
	const filled = Math.min(totalBlocks, Math.round((pct / 100) * totalBlocks));
	const empty = totalBlocks - filled;
	const bar = '█'.repeat(filled) + '░'.repeat(empty);
	return `$(database) [${bar}] ${used.toLocaleString()} / ${effectiveTotal.toLocaleString()} (${pct}%)`;
}

// @ts-ignore
const OLLAMA_CHECK_INTERVAL_MS = 30_000; // 30 seconds
const ROUTER_CHECK_INTERVAL_MS = 30_000;

export class CodeCrabStatusBarItem extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.codecrabStatusBar';

	private _statusBarEntry: IStatusbarEntryAccessor | undefined;
	private _contextStatusBarEntry: IStatusbarEntryAccessor | undefined;
	private _routerCheckTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		@ICodeCrabAiService private readonly _aiService: ICodeCrabAiService,
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		// @ts-ignore
		@ICodeCrabLanguageModelProvider private readonly _languageModelProvider: ICodeCrabLanguageModelProvider,
	) {
		super();
		this._createStatusBarEntry();
		this._createContextStatusBarEntry();
		this._startRouterCheck();
		this._register(this._aiService.onDidChangeActiveModel(() => this._updateStatusBar()));
		this._register(this._aiService.onDidChangeContextUsage((usage) => {
			this._updateContextBar(usage.used, usage.total, usage.percent);
		}));
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

	private _createContextStatusBarEntry(): void {
		this._contextStatusBarEntry = this._register(
			this._statusbarService.addEntry(
				{
					name: 'CodeCrab Context Usage',
					text: renderContextBar(0, 8192),
					tooltip: this._buildContextTooltip(0, 8192),
					ariaLabel: 'CodeCrab Context Usage: 0 of 8,192 tokens',
				},
				CONTEXT_STATUS_BAR_ENTRY_ID,
				StatusbarAlignment.LEFT,
				// Priority: placed right next to problems and git branch in bottom-left
				45
			)
		);
	}

	private _updateContextBar(used: number, total: number, percent?: number): void {
		if (!this._contextStatusBarEntry) { return; }
		const effectiveTotal = total > 0 ? total : 8192;
		const pct = percent ?? Math.min(100, Math.max(0, Math.round((used / effectiveTotal) * 100)));

		let text = renderContextBar(used, effectiveTotal);
		if (pct >= 75) {
			text += ' [75% compact threshold]';
		}

		this._contextStatusBarEntry.update({
			name: 'CodeCrab Context Usage',
			text,
			tooltip: this._buildContextTooltip(used, effectiveTotal),
			ariaLabel: `CodeCrab Context Usage: ${used} of ${effectiveTotal} tokens (${pct}%)`,
		});
	}

	private _buildContextTooltip(used: number, total: number): string {
		const effectiveTotal = total > 0 ? total : 8192;
		const pct = ((used / effectiveTotal) * 100).toFixed(1);
		const headroom = Math.max(0, effectiveTotal - used);
		const compactThreshold = Math.round(effectiveTotal * 0.75);
		const status = used >= compactThreshold ? 'Compaction Threshold Reached (75%)' : 'Optimal Attention Zone (<75%)';

		return [
			'CodeCrab Context Usage',
			'-----------------------------------------',
			`Tokens Used:   ${used.toLocaleString()} / ${effectiveTotal.toLocaleString()} (${pct}%)`,
			`Free Headroom: ${headroom.toLocaleString()} tokens`,
			`Hardware:      NVIDIA GeForce RTX 4060 (8 GB VRAM)`,
			`Auto-Compact:  Triggers at 75% (${compactThreshold.toLocaleString()} tokens)`,
			`Status:        ${status}`,
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
		if (available) {
			const usage = await this._aiService.getContextUsage();
			if (usage) {
				this._updateContextBar(usage.used, usage.total, usage.percent);
			}
		}
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
