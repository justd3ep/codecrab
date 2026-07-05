/**
 * Planner — high-level planning decisions.
 *
 * Responsibilities: analyze requirements → determine modules → delegate to
 * ExecutionGraphBuilder. DOES NOT schedule or generate.
 *
 * Re-exports graph builder and dependency analyzer for convenience.
 */

import type { AdvisorV2Result } from './executionGraphBuilder.js';
import type { ExecutionGraph }  from '../core/types.js';
import type { WorkspaceInspection } from '../workspaceInspector.js';
import { buildExecutionGraph }  from './executionGraphBuilder.js';
import { verifyGraph }          from './dependencyAnalyzer.js';

export { buildExecutionGraph, type AdvisorV2Result } from './executionGraphBuilder.js';
export { verifyGraph, type PlannerVerificationResult } from './dependencyAnalyzer.js';

export interface PlanResult {
	graph:       ExecutionGraph;
	valid:       boolean;
	warnings:    string[];
}

/**
 * Plan — build graph and verify in one call.
 */
export function plan(
	advisor:    AdvisorV2Result,
	inspection: WorkspaceInspection | null,
): PlanResult | null {
	const graph = buildExecutionGraph(advisor, inspection);
	if (!graph) return null;

	const verification = verifyGraph(graph);

	return {
		graph,
		valid:    verification.valid,
		warnings: verification.warnings,
	};
}
