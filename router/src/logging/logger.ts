/**
 * Structured JSON logger.
 *
 * Every log entry is a JSON object with: timestamp, level, component, message, and data.
 * Subscribes to EventBus for automatic event logging.
 */

import type { EventBus }   from '../core/eventBus.js';
import type { LoggingConfig } from '../config/types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info:  1,
	warn:  2,
	error: 3,
};

export interface LogEntry {
	timestamp: string;
	level:     LogLevel;
	component: string;
	message:   string;
	data?:     Record<string, unknown>;
}

export class Logger {
	private readonly minLevel: number;
	private readonly structured: boolean;

	constructor(config: LoggingConfig) {
		this.minLevel   = LEVEL_PRIORITY[config.level];
		this.structured = config.structured;
	}

	private shouldLog(level: LogLevel): boolean {
		return LEVEL_PRIORITY[level] >= this.minLevel;
	}

	private write(entry: LogEntry): void {
		if (this.structured) {
			const line = JSON.stringify(entry);
			if (entry.level === 'error') {
				process.stderr.write(line + '\n');
			} else {
				process.stdout.write(line + '\n');
			}
		} else {
			// Human-readable fallback
			const prefix = `[${entry.component}]`;
			const msg = `${prefix} ${entry.message}`;
			if (entry.level === 'error') {
				console.error(msg, entry.data ?? '');
			} else if (entry.level === 'warn') {
				console.warn(msg, entry.data ?? '');
			} else {
				console.log(msg, entry.data ?? '');
			}
		}
	}

	log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
		if (!this.shouldLog(level)) return;
		this.write({
			timestamp: new Date().toISOString(),
			level,
			component,
			message,
			...(data !== undefined ? { data } : {}),
		});
	}

	debug(component: string, message: string, data?: Record<string, unknown>): void {
		this.log('debug', component, message, data);
	}

	info(component: string, message: string, data?: Record<string, unknown>): void {
		this.log('info', component, message, data);
	}

	warn(component: string, message: string, data?: Record<string, unknown>): void {
		this.log('warn', component, message, data);
	}

	error(component: string, message: string, data?: Record<string, unknown>): void {
		this.log('error', component, message, data);
	}

	/** Create a child logger scoped to a component */
	child(component: string): ScopedLogger {
		return new ScopedLogger(this, component);
	}

	/**
	 * Wire EventBus → Logger.
	 * Automatically logs all lifecycle events at appropriate levels.
	 */
	attachEventBus(bus: EventBus): void {
		bus.on('job:created',          d => this.info('JobService', `Job created: ${d.jobId}`, d));
		bus.on('job:completed',        d => this.info('JobService', `Job completed: ${d.jobId} (${d.committedFiles.length} files)`, d));
		bus.on('job:failed',           d => this.error('JobService', `Job failed: ${d.jobId} — ${d.error}`, d));
		bus.on('job:cancelled',        d => this.info('JobService', `Job cancelled: ${d.jobId}`, d));

		bus.on('generation:started',   d => this.info('Worker', `Generating ${d.node}`, d));
		bus.on('generation:completed', d => this.info('Worker', `Generated ${d.node} (${d.durationMs}ms)`, d));
		bus.on('generation:failed',    d => this.warn('Worker', `Generation failed: ${d.node} (attempt ${d.attempt})`, d));

		bus.on('validation:passed',    d => this.debug('Validator', `Passed: ${d.node}`, d));
		bus.on('validation:failed',    d => this.warn('Validator', `Failed: ${d.node} (${d.errorCount} error(s))`, d));

		bus.on('commit:completed',     d => this.info('CommitManager', `Committed: ${d.node}`, d));
		bus.on('commit:failed',        d => this.error('CommitManager', `Commit failed: ${d.node} — ${d.error}`, d));

		bus.on('model:loaded',         d => this.info('ModelManager', `Model "${d.key}" loaded (${d.durationMs}ms)`, d));
		bus.on('model:unloaded',       d => this.info('ModelManager', `Model "${d.key}" unloaded`, d));
	}
}

/** Component-scoped logger — avoids passing component string on every call */
export class ScopedLogger {
	constructor(
		private readonly parent: Logger,
		private readonly component: string,
	) {}

	debug(message: string, data?: Record<string, unknown>): void { this.parent.debug(this.component, message, data); }
	info(message: string, data?: Record<string, unknown>): void  { this.parent.info(this.component, message, data); }
	warn(message: string, data?: Record<string, unknown>): void  { this.parent.warn(this.component, message, data); }
	error(message: string, data?: Record<string, unknown>): void { this.parent.error(this.component, message, data); }
}
