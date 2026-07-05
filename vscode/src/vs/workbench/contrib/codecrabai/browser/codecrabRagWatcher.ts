/*---------------------------------------------------------------------------------------------
 *  CodeCrab RAG Watcher
 *  Keeps the router's LanceDB index in sync with the workspace filesystem by:
 *
 *  1. On activation  — POST /v1/index/sync  (purge stale vectors from crashes / git ops)
 *  2. onDidFilesChange (DELETED) — POST /v1/index/delete  (batch, fires once per multi-delete)
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IFileService, FileChangeType } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions, IWorkbenchContribution } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ICodeCrabRouterClient } from '../common/codecrabRouterClient.js';

// ---------------------------------------------------------------------------
// Helper — resolve workspace root from the context service
// ---------------------------------------------------------------------------

function getWorkspaceRoot(workspaceContextService: IWorkspaceContextService): string | undefined {
	const folders = workspaceContextService.getWorkspace().folders;
	if (folders.length === 0) { return undefined; }
	const uri = folders[0].uri;
	// Only handle local file:// workspaces
	if (uri.scheme !== 'file') { return undefined; }
	return uri.fsPath;
}

// ---------------------------------------------------------------------------
// Contribution
// ---------------------------------------------------------------------------

export class CodeCrabRagWatcher extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.codecrabRagWatcher';

	constructor(
		@ICodeCrabRouterClient private readonly _routerClient: ICodeCrabRouterClient,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._runStartupSync();
		this._registerFileWatcher();
	}

	// -------------------------------------------------------------------------
	// Startup sync — purge vectors whose files were deleted while IDE was closed.
	// Handles: VSCode crashes, `git checkout`, terminal `rm -rf`.
	// -------------------------------------------------------------------------

	private _runStartupSync(): void {
		const workspaceRoot = getWorkspaceRoot(this._workspaceContextService);
		if (!workspaceRoot) { return; }

		this._routerClient.syncIndex(workspaceRoot).then(result => {
			if (result.purged > 0) {
				console.log(`[CodeCrab RAG] Startup sync purged ${result.purged} stale vector(s).`);
			}
		}).catch(() => {
			// Router may not be running yet — silent fail
		});
	}

	// -------------------------------------------------------------------------
	// File deletion watcher — fires once per batch (handles folder deletes too).
	// -------------------------------------------------------------------------

	private _registerFileWatcher(): void {
		this._register(
			this._fileService.onDidFilesChange(event => {
				const workspaceRoot = getWorkspaceRoot(this._workspaceContextService);
				if (!workspaceRoot) { return; }

				// Collect all deleted file paths from this event batch
				const deletedPaths = event.changes
					.filter(c => c.type === FileChangeType.DELETED)
					.map(c => c.resource.fsPath)
					.filter(p => p.startsWith(workspaceRoot));

				if (deletedPaths.length === 0) { return; }

				console.log(`[CodeCrab RAG] Detected ${deletedPaths.length} deletion(s) — purging from index.`);

				this._routerClient.deleteIndexedFiles(workspaceRoot, deletedPaths).catch(() => {
					// Silent fail — safety layer in retrieveContext() will catch leftovers
				});
			})
		);
	}
}

// ---------------------------------------------------------------------------
// Register as a workbench contribution (Restored = after workspace loads)
// ---------------------------------------------------------------------------

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	CodeCrabRagWatcher,
	LifecyclePhase.Restored
);
