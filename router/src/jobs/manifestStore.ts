/**
 * ManifestStore — persistent JSON job manifest.
 * One file per job: .crabcode/jobs/<jobId>/manifest.json
 * Checkpoint only after successful commit.
 */

import fs   from 'fs';
import path from 'path';
import type { JobManifest, AttemptRecord } from '../core/types.js';
import { ManifestError } from '../core/errors.js';

export class ManifestStore {
	constructor(private readonly jobsDir: string) {
		fs.mkdirSync(jobsDir, { recursive: true });
	}

	private dir(jobId: string): string { return path.join(this.jobsDir, jobId); }
	private file(jobId: string): string { return path.join(this.dir(jobId), 'manifest.json'); }
	private eventsFile(jobId: string): string { return path.join(this.dir(jobId), 'events.jsonl'); }

	create(manifest: JobManifest): void {
		fs.mkdirSync(this.dir(manifest.jobId), { recursive: true });
		this.write(manifest);
	}

	read(jobId: string): JobManifest {
		try {
			return JSON.parse(fs.readFileSync(this.file(jobId), 'utf-8')) as JobManifest;
		} catch (e: any) {
			throw new ManifestError(jobId, 'read', e.message);
		}
	}

	write(manifest: JobManifest): void {
		try {
			manifest.updatedAt = new Date().toISOString();
			const tmp = this.file(manifest.jobId) + '.tmp';
			fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
			fs.renameSync(tmp, this.file(manifest.jobId)); // atomic replace
		} catch (e: any) {
			throw new ManifestError(manifest.jobId, 'write', e.message);
		}
	}

	exists(jobId: string): boolean { return fs.existsSync(this.file(jobId)); }

	/** Checkpoint after commit — adds committed node to progress */
	checkpoint(jobId: string, committedPath: string): void {
		const m = this.read(jobId);
		if (!m.progress.committed.includes(committedPath)) m.progress.committed.push(committedPath);
		if (!m.progress.validated.includes(committedPath)) m.progress.validated.push(committedPath);
		m.progress.currentNode = null;
		m.resumePoint.lastCommittedNode = committedPath;
		this.write(m);
	}

	recordAttempt(jobId: string, attempt: AttemptRecord): void {
		const m = this.read(jobId);
		m.attempts.push(attempt);
		this.write(m);
	}

	recordFailure(jobId: string, nodePath: string, reason: string): void {
		const m = this.read(jobId);
		if (!m.progress.failed.includes(nodePath)) m.progress.failed.push(nodePath);
		this.write(m);
	}

	setStatus(jobId: string, status: JobManifest['status']): void {
		const m = this.read(jobId);
		m.status = status;
		if (status === 'completed' || status === 'failed' || status === 'cancelled') {
			m.completedAt = new Date().toISOString();
		}
		this.write(m);
	}

	setCurrentNode(jobId: string, nodePath: string | null): void {
		const m = this.read(jobId);
		m.progress.currentNode = nodePath;
		this.write(m);
	}

	/** Append structured event to events.jsonl for GET /jobs/:id/events */
	appendEvent(jobId: string, type: string, data: Record<string, unknown>): void {
		try {
			const line = JSON.stringify({ timestamp: new Date().toISOString(), type, data }) + '\n';
			fs.appendFileSync(this.eventsFile(jobId), line);
		} catch { /* non-fatal */ }
	}

	readEvents(jobId: string): string {
		try { return fs.readFileSync(this.eventsFile(jobId), 'utf-8'); } catch { return ''; }
	}

	listAll(): string[] {
		try {
			return fs.readdirSync(this.jobsDir).filter(d =>
				fs.existsSync(path.join(this.jobsDir, d, 'manifest.json'))
			);
		} catch { return []; }
	}
}
