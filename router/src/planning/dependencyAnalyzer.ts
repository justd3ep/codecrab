/**
 * DependencyAnalyzer — cycle detection, graph verification.
 * Extracted from planner.ts verifyGraph() (lines 504-609).
 */

import type { ExecutionGraph } from '../core/types.js';

export interface PlannerVerificationResult {
	valid:            boolean;
	duplicatePaths:   string[];
	unreachableNodes: string[];
	cycles:           string[][];
	invalidPaths:     string[];
	warnings:         string[];
}

export function verifyGraph(graph: ExecutionGraph): PlannerVerificationResult {
	const result: PlannerVerificationResult = {
		valid: true, duplicatePaths: [], unreachableNodes: [], cycles: [], invalidPaths: [], warnings: [],
	};

	// Duplicate paths
	const seen = new Set<string>();
	for (const n of graph.nodes) {
		if (seen.has(n.path)) result.duplicatePaths.push(n.path);
		else seen.add(n.path);
	}

	// Invalid paths
	const BAD = /[<>:"|?*\\]|^\//;
	const NEEDS_EXT = /\.(?:ts|tsx|js|jsx|json)$/;
	for (const n of graph.nodes) {
		if (BAD.test(n.path) || !NEEDS_EXT.test(n.path)) result.invalidPaths.push(n.path);
	}

	// Cycle detection (DFS)
	const pathSet  = new Set(graph.nodes.map(n => n.path));
	const visited  = new Set<string>();
	const inStack  = new Set<string>();
	const stack:   string[] = [];

	const dfs = (p: string): void => {
		if (inStack.has(p)) {
			const start = stack.indexOf(p);
			if (start >= 0) result.cycles.push([...stack.slice(start), p]);
			return;
		}
		if (visited.has(p)) return;
		visited.add(p); inStack.add(p); stack.push(p);
		const node = graph.nodes.find(n => n.path === p);
		if (node) {
			for (const e of node.dependencies) { if (pathSet.has(e.path)) dfs(e.path); }
		}
		stack.pop(); inStack.delete(p);
	};
	for (const n of graph.nodes) { if (!visited.has(n.path)) dfs(n.path); }

	// Unreachable (no dependents, not terminal layer)
	const TERMINAL = new Set(['server', 'route']);
	for (const n of graph.nodes) {
		if (!TERMINAL.has(n.layer) && n.dependents.length === 0) {
			result.warnings.push(`"${n.path}" has no dependents`);
		}
	}

	if (result.duplicatePaths.length > 0 || result.cycles.length > 0 || result.invalidPaths.length > 0) {
		result.valid = false;
	}
	return result;
}

/** Get next pending node with all deps committed */
export function nextPendingNode(graph: ExecutionGraph): import('../core/types.js').FileNode | null {
	for (const n of graph.nodes) {
		if (n.status !== 'pending') continue;
		const ready = n.dependencies.every(e => {
			const dep = graph.nodes.find(d => d.path === e.path);
			return !dep || dep.status === 'committed';
		});
		if (ready) return n;
	}
	return null;
}

/** Mark node + transitive dependents failed/skipped */
export function markNodeFailed(graph: ExecutionGraph, node: import('../core/types.js').FileNode): void {
	node.status = 'failed';
	const queue = [...node.dependents];
	const seen  = new Set<string>([node.path]);
	while (queue.length) {
		const p = queue.shift()!;
		if (seen.has(p)) continue;
		seen.add(p);
		const dep = graph.nodes.find(n => n.path === p);
		if (dep && dep.status === 'pending') {
			dep.status = 'skipped';
			queue.push(...dep.dependents);
		}
	}
}

export function isGraphComplete(graph: ExecutionGraph): boolean {
	return graph.nodes.every(n => n.status === 'committed' || n.status === 'failed' || n.status === 'skipped');
}

export function graphSummary(graph: ExecutionGraph): string {
	const c = { pending: 0, ready: 0, generating: 0, validating: 0, repairing: 0, committed: 0, failed: 0, skipped: 0 };
	for (const n of graph.nodes) (c as any)[n.status]++;
	return Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ');
}
