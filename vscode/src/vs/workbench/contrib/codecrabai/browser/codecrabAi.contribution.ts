/*---------------------------------------------------------------------------------------------
 *  CodeCrab AI — Main Browser Contribution
 *  Entry point that imports all browser-side CodeCrab contributions.
 *  Referenced from workbench.common.main.ts.
 *--------------------------------------------------------------------------------------------*/

// Services (common — registered in DI container)
import '../common/codecrabAiService.js';
import '../common/codecrabRouterClient.js';
import '../common/codecrabLanguageModel.js';
import '../common/codecrabConfiguration.js';

// Browser-side contributions
import './codecrabInlineCompletions.js';
import './codecrabStatusBar.js';
import './codecrabRagWatcher.js';
import './theme/codecrabTheme.js';
