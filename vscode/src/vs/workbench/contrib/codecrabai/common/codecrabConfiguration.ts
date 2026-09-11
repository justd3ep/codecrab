/*---------------------------------------------------------------------------------------------
 *  CodeCrab AI — Configuration Schema
 *  Registers settings for CodeCrab AI in VS Code settings.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Extensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

export const enum CodeCrabConfigKeys {
	ContextWindow = 'codecrab.contextWindow',
	RouterUrl = 'codecrab.routerUrl',
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'codecrab',
	order: 25,
	title: localize('codecrabConfigurationTitle', "CodeCrab AI"),
	type: 'object',
	properties: {
		[CodeCrabConfigKeys.ContextWindow]: {
			type: 'number',
			enum: [2048, 4096, 8192, 16384, 32768],
			enumDescriptions: [
				localize('codecrab.contextWindow.2048', "2,048 tokens — Ultra-low VRAM (2GB - 4GB GPUs)"),
				localize('codecrab.contextWindow.4096', "4,096 tokens — Low VRAM (4GB - 6GB GPUs)"),
				localize('codecrab.contextWindow.8192', "8,192 tokens — Balanced Default (8GB - 12GB GPUs)"),
				localize('codecrab.contextWindow.16384', "16,384 tokens — High VRAM (16GB GPUs, e.g. RTX 4080)"),
				localize('codecrab.contextWindow.32768', "32,768 tokens — Extreme VRAM (24GB+ GPUs, e.g. RTX 3090/4090, A100)")
			],
			default: 8192,
			description: localize('codecrab.contextWindow.desc', "Context window size for CodeCrab AI specialist models. Higher values allow larger projects and longer histories to fit in memory, but require more GPU VRAM."),
			scope: 1 // ConfigurationScope.APPLICATION
		},
		[CodeCrabConfigKeys.RouterUrl]: {
			type: 'string',
			default: 'http://localhost:3141',
			description: localize('codecrab.routerUrl.desc', "Base URL of the CodeCrab Model Router service."),
			scope: 1 // ConfigurationScope.APPLICATION
		}
	}
});
