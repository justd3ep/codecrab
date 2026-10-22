/**
 * requestMutex.ts — Request serialiser and global abort controller.
 *
 * WHY IT EXISTS
 *
 * Only one chat request runs at a time. A concurrent mm.acquire()
 * can DISPOSE a model that another request is actively generating
 * into, and the model manager's `loading` flag is a boolean, not a
 * mutex — so two acquires can overlap and the second throws:
 *
 *     if (this.loading) throw new Error('Model load already in progress. Retry.');
 *
 * The queue turns that race into a wait.
 *
 * It also owns the ACTIVE GENERATION's abort controller, so
 * /v1/chat/abort can reach the request that is running — whichever
 * route it arrived on.
 *
 * WHY THE ABORT ROUTE LIVES HERE
 *
 * It used to be inline in index.ts, and the route and the handler
 * were coupled through a mutable module-level variable. A module
 * that owns both cannot be half-wired: the abort route cannot reach
 * a controller that was never registered, and the handler cannot
 * register a controller the abort route cannot see.
 *
 * chatRoutes.ts — the SHADOW route — already uses this module for
 * exactly that, and already has its own /chat/abort route with the
 * same body. So the route factory is here, and both routes use it.
 */
import { Router } from 'express';

let activeController: AbortController | null = null;

export function getActiveController(): AbortController | null {
	return activeController;
}

export function setActiveController(controller: AbortController | null): void {
	activeController = controller;
}

export function abortActiveGeneration(): boolean {
	if (activeController && !activeController.signal.aborted) {
		console.log('[RequestMutex] Aborting active generation.');
		activeController.abort();
		return true;
	}
	return false;
}

let requestInFlight = false;
const requestQueue: Array<() => void> = [];

export function acquireRequestSlot(): Promise<() => void> {
	return new Promise(resolve => {
		const release = () => {
			if (requestQueue.length > 0) {
				const next = requestQueue.shift()!;
				next();
			} else {
				requestInFlight = false;
			}
		};
		if (!requestInFlight) {
			requestInFlight = true;
			resolve(release);
		} else {
			requestQueue.push(() => {
				requestInFlight = true;
				resolve(release);
			});
		}
	});
}

/** Is a request running right now? */
export function isRequestInFlight(): boolean {
	return requestInFlight;
}

/** How many requests are waiting for the slot. */
export function queuedRequestCount(): number {
	return requestQueue.length;
}

/**
 * The abort route.
 *
 * The path is relative — the live route mounts it at '/v1' and the
 * shadow route at '/', so the same factory serves both.
 */
export function makeAbortRoutes(): Router {
	const router = Router();

	router.post('/chat/abort', (_req, res) => {
		if (abortActiveGeneration()) {
			console.log('[Router] /v1/chat/abort — aborting active generation.');
			res.json({ aborted: true });
		} else {
			res.json({ aborted: false, reason: 'No active generation' });
		}
	});

	return router;
}
