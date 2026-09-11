/*---------------------------------------------------------------------------------------------
 *  CodeCrab Status Bar Item
 *  Shows active specialist model and context usage bar in the status bar with interactive pickers.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { ICodeCrabAiService } from '../common/codecrabAiService.js';
import { ICodeCrabLanguageModelProvider } from '../common/codecrabLanguageModel.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions, IWorkbenchContribution } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { CodeCrabConfigKeys } from '../common/codecrabConfiguration.js';

const STATUS_BAR_ENTRY_ID = 'codecrab.statusBar.activeModel';
const CONTEXT_STATUS_BAR_ENTRY_ID = 'codecrab.statusBar.contextUsage';

const SELECT_CONTEXT_WINDOW_COMMAND_ID = 'codecrab.selectContextWindow';
const OPEN_MODEL_MANAGER_COMMAND_ID = 'codecrab.openModelManager';

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

interface IContextPickItem extends IQuickPickItem {
	contextValue?: number;
	action?: 'settings';
}

interface IModelPickItem extends IQuickPickItem {
	action?: 'context' | 'settings';
}

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
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ICommandService private readonly _commandService: ICommandService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		this._registerCommands();
		this._createStatusBarEntry();
		this._createContextStatusBarEntry();
		this._startRouterCheck();
		this._register(this._aiService.onDidChangeActiveModel(() => this._updateStatusBar()));
		this._register(this._aiService.onDidChangeContextUsage((usage) => {
			this._updateContextBar(usage.used, usage.total, usage.percent);
		}));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CodeCrabConfigKeys.ContextWindow)) {
				const currentContext = this._configurationService.getValue<number>(CodeCrabConfigKeys.ContextWindow) ?? 8192;
				this._updateContextBar(0, currentContext, 0);
			}
		}));
	}

	// -------------------------------------------------------------------------
	// Command registration
	// -------------------------------------------------------------------------

	private _registerCommands(): void {
		this._register(CommandsRegistry.registerCommand({
			id: SELECT_CONTEXT_WINDOW_COMMAND_ID,
			handler: () => this._showContextWindowPicker()
		}));

		this._register(CommandsRegistry.registerCommand({
			id: OPEN_MODEL_MANAGER_COMMAND_ID,
			handler: () => this._showModelManagerPicker()
		}));
	}

	private async _showContextWindowPicker(): Promise<void> {
		const currentContext = this._configurationService.getValue<number>(CodeCrabConfigKeys.ContextWindow) ?? 8192;

		const options: { value: number; label: string; description: string; detail: string }[] = [
			{
				value: 2048,
				label: '2,048 tokens',
				description: 'Ultra-low VRAM',
				detail: 'Optimal for 2GB - 4GB GPUs (e.g. GTX 1650 ultra-low memory, MX series). Fastest token speed.'
			},
			{
				value: 4096,
				label: '4,096 tokens',
				description: 'Low VRAM (Recommended for GTX 1650)',
				detail: 'Recommended for 4GB - 6GB GPUs (GTX 1650, GTX 1060, RTX 3050 Laptop). Fast ~16 tok/s inference.'
			},
			{
				value: 8192,
				label: '8,192 tokens',
				description: 'Balanced Default',
				detail: 'Default profile for 8GB - 12GB GPUs (RTX 4060, RTX 3060, RTX 4070). Standard project context.'
			},
			{
				value: 16384,
				label: '16,384 tokens',
				description: 'High VRAM',
				detail: 'For 16GB GPUs (RTX 4080, RTX 3080 16GB). Suitable for large codebases and multi-file context.'
			},
			{
				value: 32768,
				label: '32,768 tokens',
				description: 'Extreme VRAM',
				detail: 'For 24GB+ GPUs (RTX 3090, RTX 4090, A100). Maximum context window size.'
			}
		];

		const picks: IContextPickItem[] = options.map(opt => ({
			label: opt.value === currentContext ? `$(check) ${opt.label}` : `     ${opt.label}`,
			description: opt.description,
			detail: opt.detail,
			contextValue: opt.value,
		}));

		picks.push(
			{ type: 'separator' } as any,
			{
				label: '$(gear) Configure in Settings...',
				description: 'Open Settings for codecrab.contextWindow',
				action: 'settings'
			}
		);

		const selected = await this._quickInputService.pick(picks, {
			placeHolder: `Select Context Window (Current: ${currentContext.toLocaleString()} tokens)`,
			matchOnDescription: true,
			matchOnDetail: true
		});

		if (!selected) {
			return;
		}

		if (selected.action === 'settings') {
			await this._commandService.executeCommand('workbench.action.openSettings', CodeCrabConfigKeys.ContextWindow);
			return;
		}

		if (selected.contextValue !== undefined) {
			await this._configurationService.updateValue(CodeCrabConfigKeys.ContextWindow, selected.contextValue, ConfigurationTarget.USER);
			this._updateContextBar(0, selected.contextValue, 0);
			this._notificationService.info(`CodeCrab context window set to ${selected.contextValue.toLocaleString()} tokens.`);
		}
	}

	private async _showModelManagerPicker(): Promise<void> {
		const activeModel = this._aiService.getActiveModel();
		const currentContext = this._configurationService.getValue<number>(CodeCrabConfigKeys.ContextWindow) ?? 8192;

		const picks: IModelPickItem[] = [
			{
				label: `$(symbol-variable) Active Model: ${activeModel.displayName}`,
				description: `Domain: ${activeModel.domain} | Maturity: ${activeModel.maturity}`,
				detail: `Ollama Tag: ${activeModel.ollamaTag} | RAM: ${activeModel.ramRequiredGb} GB required`,
			},
			{
				label: `$(database) Context Window: ${currentContext.toLocaleString()} tokens`,
				description: 'Click to switch context size (2,048 - 32,768)',
				action: 'context'
			},
			{ type: 'separator' } as any,
			{
				label: '$(gear) Open CodeCrab AI Settings...',
				detail: 'Configure Router URL and Model options',
				action: 'settings'
			}
		];

		const selected = await this._quickInputService.pick(picks, {
			placeHolder: `CodeCrab AI Specialist Model: ${activeModel.displayName}`
		});

		if (!selected) {
			return;
		}

		if (selected.action === 'context') {
			await this._showContextWindowPicker();
		} else if (selected.action === 'settings') {
			await this._commandService.executeCommand('workbench.action.openSettings', 'codecrab');
		}
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
					text: `$(sparkle) ${activeModel.displayName}`,
					tooltip: this._buildTooltip(),
					ariaLabel: `CodeCrab: ${activeModel.displayName}`,
					command: OPEN_MODEL_MANAGER_COMMAND_ID,
				},
				STATUS_BAR_ENTRY_ID,
				StatusbarAlignment.RIGHT,
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
				text: `$(sparkle) Router offline`,
				tooltip: 'CodeCrab: Local Model Router is not running.\nStart the router on port 3141 to enable AI features.',
				ariaLabel: 'CodeCrab: Router offline',
				command: OPEN_MODEL_MANAGER_COMMAND_ID,
				backgroundColor: undefined,
			});
			return;
		}

		this._statusBarEntry.update({
			name: 'CodeCrab Active Model',
			text: `$(sparkle) ${activeModel.displayName}`,
			tooltip: this._buildTooltip(),
			ariaLabel: `CodeCrab: ${activeModel.displayName}`,
			command: OPEN_MODEL_MANAGER_COMMAND_ID,
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
			`Click to open Model Manager & Settings`,
		].join('\n');
	}

	private _createContextStatusBarEntry(): void {
		const initialContext = this._configurationService.getValue<number>(CodeCrabConfigKeys.ContextWindow) ?? 8192;
		this._contextStatusBarEntry = this._register(
			this._statusbarService.addEntry(
				{
					name: 'CodeCrab Context Usage',
					text: renderContextBar(0, initialContext),
					tooltip: this._buildContextTooltip(0, initialContext),
					ariaLabel: `CodeCrab Context Usage: 0 of ${initialContext.toLocaleString()} tokens`,
					command: SELECT_CONTEXT_WINDOW_COMMAND_ID,
				},
				CONTEXT_STATUS_BAR_ENTRY_ID,
				StatusbarAlignment.LEFT,
				45
			)
		);
	}

	private _updateContextBar(used: number, total: number, percent?: number): void {
		if (!this._contextStatusBarEntry) { return; }
		const fallbackTotal = this._configurationService.getValue<number>(CodeCrabConfigKeys.ContextWindow) ?? 8192;
		const effectiveTotal = total > 0 ? total : fallbackTotal;
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
			command: SELECT_CONTEXT_WINDOW_COMMAND_ID,
		});
	}

	private _buildContextTooltip(used: number, total: number): string {
		const fallbackTotal = this._configurationService.getValue<number>(CodeCrabConfigKeys.ContextWindow) ?? 8192;
		const effectiveTotal = total > 0 ? total : fallbackTotal;
		const pct = ((used / effectiveTotal) * 100).toFixed(1);
		const headroom = Math.max(0, effectiveTotal - used);
		const compactThreshold = Math.round(effectiveTotal * 0.75);
		const status = used >= compactThreshold ? 'Compaction Threshold Reached (75%)' : 'Optimal Attention Zone (<75%)';

		return [
			'CodeCrab Context Usage',
			'-----------------------------------------',
			`Tokens Used:   ${used.toLocaleString()} / ${effectiveTotal.toLocaleString()} (${pct}%)`,
			`Free Headroom: ${headroom.toLocaleString()} tokens`,
			`Auto-Compact:  Triggers at 75% (${compactThreshold.toLocaleString()} tokens)`,
			`Status:        ${status}`,
			'',
			'Click to switch Context Window (2,048 - 32,768 tokens)',
		].join('\n');
	}

	// -------------------------------------------------------------------------
	// Ollama connectivity polling
	// -------------------------------------------------------------------------

	private _startRouterCheck(): void {
		this._checkRouter();
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
