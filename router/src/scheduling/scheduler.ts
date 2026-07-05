/**
 * Scheduler — topo-ordered queue, retry policy, priority.
 * Operates on ExecutionGraph. No model calls, no I/O.
 */

import type { ExecutionGraph, FileNode } from '../core/types.js';
import { nextPendingNode, markNodeFailed, isGraphComplete, graphSummary } from '../planning/dependencyAnalyzer.js';

export interface SchedulerConfig {
	maxRetries: number;
}

const DEFAULT_CONFIG: SchedulerConfig = { maxRetries: 3 };

export class Scheduler {
	private retryCounts = new Map<string, number>();

	constructor(private readonly config: SchedulerConfig = DEFAULT_CONFIG) {}

	/** Next node ready to generate (deps committed). Null = deadlock or done. */
	next(graph: ExecutionGraph): FileNode | null {
		return nextPendingNode(graph);
	}

	/** Call after successful commit. Clears retry counter. */
	onCommitted(node: FileNode): void {
		node.status = 'committed';
		this.retryCounts.delete(node.path);
	}

	/** Call after generation/validation failure. Returns true = retry, false = give up. */
	onFailed(graph: ExecutionGraph, node: FileNode, reason: string): boolean {
		const attempts = (this.retryCounts.get(node.path) ?? 0) + 1;
		this.retryCounts.set(node.path, attempts);
		if (attempts <= this.config.maxRetries) {
			node.status = 'pending'; // reset → will be retried
			console.log(`[Scheduler] retry ${attempts}/${this.config.maxRetries} for ${node.path}: ${reason}`);
			return true;
		}
		console.log(`[Scheduler] giving up on ${node.path} after ${attempts} attempts`);
		markNodeFailed(graph, node);
		return false;
	}

	isDone(graph: ExecutionGraph): boolean { return isGraphComplete(graph); }

	/** Detect deadlock: pending nodes exist but none are ready */
	isDeadlocked(graph: ExecutionGraph): boolean {
		const pending = graph.nodes.filter(n => n.status === 'pending');
		if (pending.length === 0) return false;
		return nextPendingNode(graph) === null;
	}

	/** Resolve deadlock by skipping all pending nodes */
	resolveDeadlock(graph: ExecutionGraph): string[] {
		const skipped: string[] = [];
		for (const n of graph.nodes) {
			if (n.status === 'pending') { n.status = 'skipped'; skipped.push(n.path); }
		}
		return skipped;
	}

	summary(graph: ExecutionGraph): string { return graphSummary(graph); }

	retryCount(path: string): number { return this.retryCounts.get(path) ?? 0; }
}
