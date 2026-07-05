/**
 * BackupStore — back up files before overwrite.
 * Location: .crabcode/backups/<jobId>/<timestamp>/<relPath>
 */

import fs   from 'fs';
import path from 'path';

export class BackupStore {
	constructor(private readonly backupDir: string) {
		fs.mkdirSync(backupDir, { recursive: true });
	}

	backup(jobId: string, relPath: string, workspaceRoot: string): string | null {
		const src = path.join(workspaceRoot, relPath);
		if (!fs.existsSync(src)) return null;
		const ts  = Date.now().toString();
		const dst = path.join(this.backupDir, jobId, ts, relPath);
		fs.mkdirSync(path.dirname(dst), { recursive: true });
		fs.copyFileSync(src, dst);
		return dst;
	}

	restore(jobId: string, relPath: string, workspaceRoot: string): boolean {
		const backupJobDir = path.join(this.backupDir, jobId);
		if (!fs.existsSync(backupJobDir)) return false;
		// Find most recent backup
		const snapshots = fs.readdirSync(backupJobDir).sort().reverse();
		for (const ts of snapshots) {
			const src = path.join(backupJobDir, ts, relPath);
			if (fs.existsSync(src)) {
				const dst = path.join(workspaceRoot, relPath);
				fs.mkdirSync(path.dirname(dst), { recursive: true });
				fs.copyFileSync(src, dst);
				return true;
			}
		}
		return false;
	}
}
