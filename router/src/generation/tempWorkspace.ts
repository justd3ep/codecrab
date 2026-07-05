/**
 * TempWorkspace — isolated per-job generation area.
 * Location: .crabcode/jobs/<jobId>/workspace/
 * Survives restart. Cleaned up after job completes.
 */

import fs   from 'fs';
import path from 'path';
import type { GeneratedFile, TempFile } from '../core/types.js';

export class TempWorkspace {
	readonly dir: string;

	constructor(jobsDir: string, jobId: string) {
		this.dir = path.join(jobsDir, jobId, 'workspace');
		fs.mkdirSync(this.dir, { recursive: true });
	}

	write(file: GeneratedFile): TempFile {
		const abs = path.join(this.dir, file.path);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, file.content, 'utf-8');
		return { ...file, absolutePath: abs };
	}

	read(relPath: string): string | null {
		const abs = path.join(this.dir, relPath);
		try { return fs.readFileSync(abs, 'utf-8'); } catch { return null; }
	}

	exists(relPath: string): boolean {
		return fs.existsSync(path.join(this.dir, relPath));
	}

	delete(relPath: string): void {
		try { fs.rmSync(path.join(this.dir, relPath)); } catch { /* ignore */ }
	}

	/** Remove all temp files for this job */
	cleanup(): void {
		try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}

	/** List all files written (relative paths) */
	listFiles(): string[] {
		const results: string[] = [];
		const walk = (dir: string): void => {
			try {
				for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, e.name);
					if (e.isDirectory()) walk(full);
					else results.push(path.relative(this.dir, full));
				}
			} catch { /* ignore */ }
		};
		walk(this.dir);
		return results;
	}
}
