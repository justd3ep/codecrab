/**
 * RecoveryManager — on startup, scan manifests and resume interrupted jobs.
 */

import type { ManifestStore }  from './manifestStore.js';
import type { JobService }      from './jobService.js';
import type { ScopedLogger }    from '../logging/logger.js';

export class RecoveryManager {
	constructor(
		private readonly store:      ManifestStore,
		private readonly jobService: JobService,
		private readonly log:        ScopedLogger,
	) {}

	async scan(): Promise<number> {
		this.log.info('Scanning for interrupted jobs...');
		const ids = this.store.listAll();
		let resumed = 0;

		for (const jobId of ids) {
			try {
				const m = this.store.read(jobId);
				if (m.status === 'running' || m.status === 'planning' || m.status === 'generating') {
					this.log.info(`Resuming interrupted job: ${jobId} (was ${m.status})`);
					await this.jobService.resume(jobId);
					resumed++;
				}
			} catch (e: any) {
				this.log.warn(`Could not recover job ${jobId}: ${e.message}`);
			}
		}

		this.log.info(`Scan complete. Resumed ${resumed} job(s).`);
		return resumed;
	}
}
