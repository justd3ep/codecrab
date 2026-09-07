import { Router } from 'express';
import { pendingStore, applyPendingSession } from '../tools/toolEngine.js';

export function makeEditRoutes(): Router {
	const router = Router();

	/** GET /v1/edits/:id  — view pending session and unified diffs */
	router.get('/edits/:id', (req, res) => {
		const session = pendingStore.get(req.params.id);
		if (!session) return res.status(404).json({ error: 'Session not found or expired.' });
		res.json({
			id: session.id,
			workspaceRoot: session.workspaceRoot,
			query: session.query,
			createdAt: session.createdAt,
			fileCount: session.edits.length,
			files: session.edits.map(e => ({
				relPath: e.relPath,
				isNewFile: e.oldContent === null,
				oldChars: e.oldContent?.length ?? 0,
				newChars: e.newContent.length,
				diff: e.diff,
			})),
		});
	});

	/** POST /v1/edits/approve  — apply all edits in a pending session */
	router.post('/edits/approve', (req, res) => {
		const { sessionId } = req.body;
		if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
		const session = pendingStore.get(sessionId);
		if (!session) return res.status(404).json({ error: 'Session not found or expired.' });

		const { written, errors } = applyPendingSession(session);
		pendingStore.delete(sessionId);

		console.log(`[PendingStore] Session ${sessionId} approved. Written: ${written.length}, Errors: ${errors.length}`);
		res.json({
			status: errors.length === 0 ? 'applied' : 'partial',
			written,
			errors,
		});
	});

	/** POST /v1/edits/reject  — discard all edits in a pending session */
	router.post('/edits/reject', (req, res) => {
		const { sessionId } = req.body;
		if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
		const existed = pendingStore.has(sessionId);
		pendingStore.delete(sessionId);
		console.log(`[PendingStore] Session ${sessionId} rejected.`);
		res.json({ status: 'rejected', existed });
	});

	/** GET /v1/edits  — list all active pending sessions */
	router.get('/edits', (_req, res) => {
		const sessions = Array.from(pendingStore.values()).map(s => ({
			id: s.id,
			workspaceRoot: s.workspaceRoot,
			fileCount: s.edits.length,
			files: s.edits.map(e => e.relPath),
			createdAt: s.createdAt,
		}));
		res.json({ pending: sessions });
	});

	return router;
}
