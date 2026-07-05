/**
 * healthRoutes — GET /health, GET /stats
 */

import { Router }              from 'express';
import type { ModelManager }   from '../models/modelManager.js';

export function makeHealthRoutes(modelManager: ModelManager): Router {
	const r = Router();

	r.get('/health', (_req, res) => {
		res.json({ status: 'ok', ts: new Date().toISOString() });
	});

	r.get('/stats', (_req, res) => {
		res.json({ model: modelManager.status });
	});

	return r;
}
