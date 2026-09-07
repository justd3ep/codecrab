/**
 * requestMutex.ts — Request serialiser and global abort controller.
 *
 * Extracted from index.ts (Step 8).
 * Ensures single active request slot and abort control across completions requests.
 */

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
