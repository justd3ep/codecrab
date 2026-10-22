/**
 * The request LIFECYCLE.
 *
 * WHY THIS IS A MODULE
 *
 * The chat handler is 1,923 lines, and inside it there is ONE
 * statement of 1,889 lines — a single try block that writes 31
 * closure variables:
 *
 *   pkgContent, requestedContextSize, enrichedLastMessage, intent,
 *   context, compactionTriggered, loopDetected, loopReason, taskSpec,
 *   activeModel, session, currentPrompt, projectSummary,
 *   justCompacted, compactionRetryDone, lastFailedEdits, hasErrors,
 *   jsxRepairDoneMain, currentSpecialist, mode, feCompactionTriggered,
 *   feLoopDetected, feLoopReason, feTaskSpec, feModel, feSession,
 *   fePrompt, feJustCompacted, feCompactionRetryDone, feJsxRepairDone,
 *   activeController
 *
 * So the try block has no seam — it cannot be split without
 * threading 31 pieces of shared mutable state through every
 * boundary.
 *
 * But the code BEFORE the try block is clean, and it is a coherent
 * unit with one job: set up a request, and guarantee the cleanup
 * runs whatever happens.
 *
 * THE CLEANUP IS THE POINT
 *
 * Four things must happen on EVERY exit path, including the ones
 * that throw:
 *
 *   1. the request slot is released — otherwise the next request
 *      waits forever
 *   2. the timeout timer is cleared — otherwise the process keeps
 *      a live handle for an hour
 *   3. the llama context is disposed — otherwise the GPU memory is
 *      never released
 *   4. the abort controller is deregistered — otherwise
 *      /v1/chat/abort aborts a controller that is already gone
 *
 * A helper that owns all four cannot get it wrong, and cannot leak
 * a slot when a new exit path is added later.
 */
import type { Request, Response } from 'express';
import type { LlamaContext } from 'node-llama-cpp';

/** The state a request carries. */
export interface RequestLifecycle {
	/** The controller — call `controller.abort()` to stop the work. */
	controller: AbortController;
	/** Aborts the generation. Safe to call more than once. */
	abort: (reason?: string) => void;
	/** The per-file write attempts. */
	fileWriteAttempts: Map<string, number>;
	/**
	 * The total corrections made this request. It is an object
	 * because the repair loop MUTATES it, and a plain number could
	 * not be written back from outside.
	 */
	totalCorrections: { value: number };
	/** The response history — used to detect identical responses. */
	responseHistory: string[];
	/**
	 * The timeout handle. The handler clears it on its own exit
	 * paths; the cleanup clears it too.
	 */
	timeoutId: ReturnType<typeof setTimeout>;
	/**
	 * The cleanup. It MUST be called, and it is safe to call more
	 * than once — the second call does nothing.
	 */
	cleanup: () => Promise<void>;
}

/** The globals the lifecycle needs. */
export interface LifecycleDeps {
	/**
	 * The release function for the request slot. The caller takes
	 * the slot FIRST (it is async), then calls beginRequest.
	 */
	releaseSlot: () => void;
	/** The request timeout, in milliseconds. */
	timeoutMs: number;
	/** Registers the controller so /v1/chat/abort can reach it. */
	registerController: (c: AbortController) => void;
	/** Deregisters the controller. */
	deregisterController: (c: AbortController) => void;
	/** The context to dispose on cleanup. The handler sets it later. */
	getContext: () => LlamaContext | null;
	/** Clears the context after disposal. */
	clearContext: () => void;
}

/**
 * Begin a request.
 *
 * @param req   The express request — for the abort listeners.
 * @param res   The express response — for the close listener.
 * @param deps  The globals the lifecycle needs.
 */
export function beginRequest(
	req: Request,
	res: Response,
	deps: LifecycleDeps,
): RequestLifecycle {
	// The abort controller, and the listeners that trigger it.
	const controller = new AbortController();
	deps.registerController(controller);

	const abort = (reason?: string) => {
		if (controller.signal.aborted) return;
		if (reason) console.log(`[Router] ${reason}`);
		console.log('[Router] Client disconnected or request aborted, aborting generation.');
		controller.abort();
	};

	req.on('close', () => abort('Client disconnected or request aborted, aborting generation.'));
	req.on('aborted', () => abort('Request aborted, aborting generation.'));
	res.on('close', () => abort('Response closed, aborting generation.'));

	// The timeout.
	const timeoutId = setTimeout(() => {
		console.error(`[Router] Request timeout of ${deps.timeoutMs}ms exceeded. Aborting.`);
		controller.abort();
	}, deps.timeoutMs);

	// The per-request tracking state.
	const fileWriteAttempts = new Map<string, number>();
	const responseHistory: string[] = [];
	// The correction counter is mutated by the repair loop, so it
	// lives on an object the loop can write to.
	const totalCorrections = { value: 0 };

	let cleaned = false;
	const cleanup = async (): Promise<void> => {
		if (cleaned) return;
		cleaned = true;
		clearTimeout(timeoutId);
		const ctx = deps.getContext();
		if (ctx) {
			try {
				await ctx.dispose();
				console.log('[Router] Context disposed successfully.');
			} catch (e: any) {
				console.error('[Router] Context disposal failed:', e?.message ?? e);
			}
			deps.clearContext();
		}
		deps.deregisterController(controller);
		deps.releaseSlot();
	};

	return {
		controller,
		abort,
		fileWriteAttempts,
		totalCorrections,
		responseHistory,
		timeoutId,
		cleanup,
	};
}
