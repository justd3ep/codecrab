/**
 * CommitManager — atomic writes from temp workspace to repository.
 * Only subsystem that may modify project files.
 * Backs up before overwrite. Never commits unvalidated files.
 */

import fs                           from 'fs';
import path                         from 'path';
import type { GeneratedFile }        from '../core/types.js';
import type { EventBus }             from '../core/eventBus.js';
import { BackupStore }               from './backupStore.js';
import { CommitError }               from '../core/errors.js';

export class CommitManager {
	private readonly backups: BackupStore;

	constructor(
		private readonly bus:       EventBus,
		backupDir: string,
	) {
		this.backups = new BackupStore(backupDir);
	}

	/**
	 * Atomically write validated file to repository.
	 * Backs up existing file first. Emits commit:completed or commit:failed.
	 */
	async commit(
		file:          GeneratedFile,
		workspaceRoot: string,
		jobId:         string,
	): Promise<void> {
		const abs = path.join(workspaceRoot, file.path);

		// Backup existing
		this.backups.backup(jobId, file.path, workspaceRoot);

		try {
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			// Atomic: write to .tmp then rename
			const tmp = abs + '.crab.tmp';
			fs.writeFileSync(tmp, file.content, 'utf-8');
			fs.renameSync(tmp, abs);
			this.bus.emit('commit:completed', { jobId, node: file.path });
		} catch (e: any) {
			this.bus.emit('commit:failed', { jobId, node: file.path, error: e.message });
			throw new CommitError(file.path, e.message);
		}
	}

	/** Rollback a committed file from backup */
	rollback(filePath: string, workspaceRoot: string, jobId: string): boolean {
		return this.backups.restore(jobId, filePath, workspaceRoot);
	}
}
