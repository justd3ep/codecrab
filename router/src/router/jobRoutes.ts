/**
 * jobRoutes — POST /v1/jobs, GET /v1/jobs/:id, etc.
 */

import { Router }            from 'express';
import type { JobService }   from '../jobs/jobService.js';
import type { ScopedLogger } from '../logging/logger.js';

export function makeJobRoutes(jobService: JobService, log: ScopedLogger): Router {
	const r = Router();

	// POST /v1/jobs — create and start a new job
	r.post('/', async (req, res) => {
		try {
			const { workspaceRoot, userRequest, advisorResult, systemPrompt, contract, modelIntent } = req.body as any;
			if (!workspaceRoot || !userRequest || !advisorResult) {
				return res.status(400).json({ error: 'workspaceRoot, userRequest, advisorResult required' });
			}
			const jobId = await jobService.create({ workspaceRoot, userRequest, advisorResult, systemPrompt: systemPrompt ?? '', contract, modelIntent: modelIntent ?? 'backend' });
			res.status(202).json({ jobId, status: 'pending' });
		} catch (e: any) {
			log.error('POST /v1/jobs failed', { error: e.message });
			res.status(500).json({ error: e.message });
		}
	});

	// GET /v1/jobs — list all jobs
	r.get('/', (_req, res) => {
		res.json({ jobs: jobService.list() });
	});

	// GET /v1/jobs/:id — job status + manifest
	r.get('/:id', (req, res) => {
		try {
			res.json(jobService.status(req.params.id!));
		} catch (e: any) {
			res.status(404).json({ error: e.message });
		}
	});

	// GET /v1/jobs/:id/events — chronological event log (JSONL)
	r.get('/:id/events', (req, res) => {
		res.setHeader('Content-Type', 'application/x-ndjson');
		res.send(jobService.events(req.params.id!));
	});

	// POST /v1/jobs/:id/cancel
	r.post('/:id/cancel', async (req, res) => {
		try {
			await jobService.cancel(req.params.id!);
			res.json({ cancelled: true });
		} catch (e: any) {
			res.status(404).json({ error: e.message });
		}
	});

	// POST /v1/jobs/:id/resume
	r.post('/:id/resume', async (req, res) => {
		try {
			await jobService.resume(req.params.id!);
			res.json({ resumed: true });
		} catch (e: any) {
			res.status(404).json({ error: e.message });
		}
	});

	return r;
}
