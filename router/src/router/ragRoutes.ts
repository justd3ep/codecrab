/**
 * ragRoutes.ts — RAG endpoints for workspace indexing, file tracking, and status.
 *
 * Extracted from index.ts (Step 9).
 */

import { Router } from 'express';
import fs from 'fs';
import config from '../config/index.js';
import { em, indexWorkspace, updateFile, deleteFiles, syncWorkspace } from '../rag.js';
import { patchTier2Caches } from '../rag/index.js';

export function makeRagRoutes(): Router {
	const r = Router();

	// RAG — Index workspace (POST /v1/index)
	r.post('/index', async (req, res) => {
		const { workspaceRoot } = req.body;
		if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
			return res.status(400).json({ error: 'Invalid or missing workspaceRoot.' });
		}
		if (!em.isReady) {
			return res.status(503).json({ error: 'Embedding model not ready yet. Retry in a moment.' });
		}
		// Respond immediately — indexing runs in background
		res.json({ status: 'indexing_started', workspaceRoot });
		indexWorkspace(workspaceRoot)
			.then(result => console.log(`[RAG] Index complete: ${result.chunks} chunks from ${result.files} files.`))
			.catch(e => console.error('[RAG] Index failed:', e));
	});

	// RAG — Incremental file update (POST /v1/index/file)
	r.post('/index/file', async (req, res) => {
		const workspaceRoot = req.body.workspaceRoot || config.workspace.defaultRoot;
		const { filePath, content } = req.body;
		if (!workspaceRoot || !filePath || content === undefined) {
			return res.status(400).json({ error: 'workspaceRoot, filePath, and content are required.' });
		}
		if (!em.isReady) return res.json({ status: 'skipped', reason: 'embedding model not ready' });
		res.json({ status: 'updating' });
		updateFile(workspaceRoot, filePath, content)
			.catch(e => console.error('[RAG] updateFile error:', e));
		// Tier-2: patch symbol/import/AST/ownership caches incrementally
		patchTier2Caches(workspaceRoot, filePath);
	});

	// RAG — Batch file deletion (POST /v1/index/delete)
	r.post('/index/delete', async (req, res) => {
		const workspaceRoot = req.body.workspaceRoot || config.workspace.defaultRoot;
		const { filePaths } = req.body;
		if (!workspaceRoot || !Array.isArray(filePaths) || filePaths.length === 0) {
			return res.status(400).json({ error: 'workspaceRoot and filePaths[] are required.' });
		}
		res.json({ status: 'deleting', count: filePaths.length });
		deleteFiles(workspaceRoot, filePaths)
			.catch(e => console.error('[RAG] deleteFiles error:', e));
	});

	// RAG — Startup sync (POST /v1/index/sync)
	r.post('/index/sync', async (req, res) => {
		const workspaceRoot = req.body.workspaceRoot || config.workspace.defaultRoot;
		if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
			return res.status(400).json({ error: 'Invalid or missing workspaceRoot.' });
		}
		const result = await syncWorkspace(workspaceRoot);
		res.json({ status: 'synced', purged: result.purged });
	});

	// RAG — Status check (GET /v1/index/status)
	r.get('/index/status', async (_req, res) => {
		res.json({ ragReady: em.isReady });
	});

	return r;
}
