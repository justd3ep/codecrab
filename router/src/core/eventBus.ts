/**
 * EventBus — Typed notification system.
 *
 * NOTIFICATIONS ONLY. Never drives execution flow.
 * Used for: logging, metrics, SSE progress, recovery notifications.
 *
 * Execution flow uses direct method calls between subsystems.
 */

import { EventEmitter } from 'events';
import type { JobEvent, PipelineProgressEvent } from './types.js';

// ---------------------------------------------------------------------------
// Event map — every event name → payload type
// ---------------------------------------------------------------------------

export interface EventMap {
	// Job lifecycle
	'job:created':    { jobId: string; workspaceRoot: string; userRequest: string };
	'job:started':    { jobId: string };
	'job:completed':  { jobId: string; committedFiles: string[] };
	'job:failed':     { jobId: string; error: string };
	'job:cancelled':  { jobId: string };

	// Planning
	'planning:started':   { jobId: string };
	'planning:completed': { jobId: string; nodeCount: number };

	// Generation
	'generation:started':   { jobId: string; node: string };
	'generation:completed': { jobId: string; node: string; durationMs: number };
	'generation:failed':    { jobId: string; node: string; error: string; attempt: number };

	// Validation
	'validation:started': { jobId: string; node: string };
	'validation:passed':  { jobId: string; node: string };
	'validation:failed':  { jobId: string; node: string; errorCount: number };

	// Repair
	'repair:started': { jobId: string; node: string; attempt: number };
	'repair:completed': { jobId: string; node: string; resolved: boolean };

	// Commit
	'commit:completed': { jobId: string; node: string };
	'commit:failed':    { jobId: string; node: string; error: string };

	// Model
	'model:loaded':   { key: string; durationMs: number };
	'model:unloaded': { key: string };
	'model:leased':   { key: string; leaseId: string };
	'model:released': { key: string; leaseId: string };

	// Progress (SSE)
	'progress': PipelineProgressEvent;

	// Generic job event (for event log persistence)
	'event': JobEvent;
}

// ---------------------------------------------------------------------------
// Typed EventBus
// ---------------------------------------------------------------------------

export class EventBus {
	private readonly emitter = new EventEmitter();

	constructor() {
		// Prevent Node warning for many listeners (metrics + logger + SSE + recovery)
		this.emitter.setMaxListeners(50);
	}

	emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
		this.emitter.emit(event, payload);
	}

	on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): void {
		this.emitter.on(event, handler as any);
	}

	once<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): void {
		this.emitter.once(event, handler as any);
	}

	off<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): void {
		this.emitter.off(event, handler as any);
	}

	/** Remove all listeners (for shutdown / tests) */
	removeAll(): void {
		this.emitter.removeAllListeners();
	}
}
