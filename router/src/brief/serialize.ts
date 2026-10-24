/**
 * serialize.ts — one JSON file per request, written before generation.
 *
 * R5 of the plan: every request leaves a brief at
 * `<workspace>/.crabcode/briefs/<requestId>.json`. Three things come out
 * of that, and all three are why this exists:
 *
 *   - REPLAY. A turn can be re-run from its brief instead of from a
 *     post-mortem of console logs.
 *   - DIFF. The brief says what the router decided, so it can be compared
 *     against what the pipeline actually did on the same request — that is
 *     how the fullstack drift gets measured instead of argued about.
 *   - TRAINING. The brief is the SFT target. A frozen, validated shape is
 *     the precondition for fine-tuning; ad-hoc prompt text is not.
 *
 * FAILURE POLICY: writing a brief is observability, never a request
 * dependency. An unwritable workspace, a full disk, or a read-only mount
 * logs once and the request continues. An INVALID brief is not written at
 * all — a corrupt training record is worse than a missing one.
 */
import fs from 'fs';
import path from 'path';

import type { TurnBrief } from './types.js';
import { validateBrief } from './validate.js';

/** Where briefs live inside a workspace. */
export const BRIEF_DIRNAME = path.join('.crabcode', 'briefs');

export function briefDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, BRIEF_DIRNAME);
}

/** Path for one request's brief. The id is sanitised — it lands in a filename. */
export function briefPath(workspaceRoot: string, requestId: string): string {
	const safe = String(requestId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
	return path.join(briefDir(workspaceRoot), `${safe}.json`);
}

/** Stable, diffable, reviewable JSON. Two-space indent: it is read by humans. */
export function serializeBrief(brief: TurnBrief): string {
	return JSON.stringify(brief, null, 2) + '\n';
}

/**
 * Validate, then write. Returns the path written, or null when the brief
 * was invalid or the write failed. Never throws.
 */
export function writeBrief(brief: TurnBrief, workspaceRoot: string): string | null {
	const violations = validateBrief(brief);
	if (violations.length > 0) {
		console.warn(`[Brief] not written — invalid brief: ${violations.join('; ')}`);
		return null;
	}
	if (!workspaceRoot) return null;

	try {
		const dir = briefDir(workspaceRoot);
		fs.mkdirSync(dir, { recursive: true });
		const file = briefPath(workspaceRoot, brief.requestId);
		fs.writeFileSync(file, serializeBrief(brief), 'utf8');
		return file;
	} catch (err: any) {
		console.warn(`[Brief] write failed (non-fatal): ${err?.message || err}`);
		return null;
	}
}
