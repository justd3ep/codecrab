/**
 * contextUsage.ts — Context window telemetry & state.
 *
 * Extracted from index.ts (lines 744–764).
 * Single source of truth for context usage tracking.
 */

export const DEFAULT_CONTEXT_SIZE = 8192;

export let activeContextUsage = {
	used: 0,
	total: DEFAULT_CONTEXT_SIZE,
	percent: 0,
	model: 'idle',
	lastUpdated: Date.now()
};

export function updateContextUsage(used: number, total: number = DEFAULT_CONTEXT_SIZE, model: string = 'qwen') {
	activeContextUsage = {
		used,
		total,
		percent: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0,
		model,
		lastUpdated: Date.now()
	};
}
