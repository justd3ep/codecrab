/**
 * Typed error classes for structured error handling.
 * Each error carries enough context for logging + recovery.
 */

export class CrabError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly context: Record<string, unknown> = {},
	) {
		super(message);
		this.name = 'CrabError';
	}
}

/** Model not loaded or disposed mid-generation */
export class ModelDisposedError extends CrabError {
	constructor(modelKey: string) {
		super(
			`Model "${modelKey}" was disposed during active use`,
			'MODEL_DISPOSED',
			{ modelKey },
		);
		this.name = 'ModelDisposedError';
	}
}

/** Model load failed (file missing, VRAM exhausted, etc.) */
export class ModelLoadError extends CrabError {
	constructor(modelKey: string, reason: string) {
		super(
			`Failed to load model "${modelKey}": ${reason}`,
			'MODEL_LOAD_FAILED',
			{ modelKey, reason },
		);
		this.name = 'ModelLoadError';
	}
}

/** Generation timed out or was aborted */
export class GenerationAbortedError extends CrabError {
	constructor(jobId: string, nodeId: string, reason: string) {
		super(
			`Generation aborted for ${nodeId}: ${reason}`,
			'GENERATION_ABORTED',
			{ jobId, nodeId, reason },
		);
		this.name = 'GenerationAbortedError';
	}
}

/** Validation blocked commit */
export class ValidationGateError extends CrabError {
	constructor(filePath: string, errorCount: number) {
		super(
			`Validation gate blocked commit of ${filePath}: ${errorCount} error(s)`,
			'VALIDATION_GATE',
			{ filePath, errorCount },
		);
		this.name = 'ValidationGateError';
	}
}

/** Repair budget exhausted */
export class RepairBudgetExhaustedError extends CrabError {
	constructor(filePath: string, attempts: number) {
		super(
			`Repair budget exhausted for ${filePath} after ${attempts} attempt(s)`,
			'REPAIR_BUDGET_EXHAUSTED',
			{ filePath, attempts },
		);
		this.name = 'RepairBudgetExhaustedError';
	}
}

/** Job not found */
export class JobNotFoundError extends CrabError {
	constructor(jobId: string) {
		super(`Job not found: ${jobId}`, 'JOB_NOT_FOUND', { jobId });
		this.name = 'JobNotFoundError';
	}
}

/** Commit failed (disk write, permission, etc.) */
export class CommitError extends CrabError {
	constructor(filePath: string, reason: string) {
		super(
			`Commit failed for ${filePath}: ${reason}`,
			'COMMIT_FAILED',
			{ filePath, reason },
		);
		this.name = 'CommitError';
	}
}

/** Manifest read/write failure */
export class ManifestError extends CrabError {
	constructor(jobId: string, operation: 'read' | 'write', reason: string) {
		super(
			`Manifest ${operation} failed for job ${jobId}: ${reason}`,
			'MANIFEST_ERROR',
			{ jobId, operation, reason },
		);
		this.name = 'ManifestError';
	}
}

/** Graph has cycles or is otherwise invalid */
export class GraphError extends CrabError {
	constructor(message: string, details: Record<string, unknown> = {}) {
		super(message, 'GRAPH_ERROR', details);
		this.name = 'GraphError';
	}
}
