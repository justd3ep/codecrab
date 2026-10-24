/**
 * routeFromBrief.ts — the one place that turns a brief into a route.
 *
 * WHY A PURE FUNCTION
 *
 * Routing is currently decided in three unrelated places: the ensemble
 * scores keywords, the planner contract picks a scope, and index.ts picks
 * the specialist from a boolean (`isFrontendOnly`). Each of them can be
 * individually plausible and still disagree, which is exactly what the
 * production log shows (ensemble FE=8/BE=0, contract fullstack).
 *
 * R1 of the plan: `route.specialist` is produced here and nowhere else.
 * It takes only brief fields, does no I/O, calls no model, and is
 * therefore exhaustively testable. Phase 5 points index.ts at this
 * function; until then the brief records the decision it WOULD make, so
 * the two can be diffed against live traffic before anything flips.
 *
 * NEVER FULLSTACK BY DEFAULT
 *
 * A tie (fe === be) resolves to `fe`, and a fullstack scope without
 * backend evidence downgrades to the winning single specialist. The
 * expensive two-model path is opt-in, never a fallthrough.
 */
import type { BriefIntent, BriefScope, BriefSpecialist, DecodeRecord, RouteDecision } from './types.js';

export interface RouteInput {
	intent: BriefIntent;
	scope: BriefScope;
	scores: { fe: number; be: number };
	decode: Pick<DecodeRecord, 'ok' | 'failed'>;
	/**
	 * True when `scope` came from an explicit user constraint rather than
	 * from the contract or the ensemble. A pinned scope wins outright — see
	 * the precedence note in the header.
	 */
	scopePinned?: boolean;
}

/** BE score below this is not evidence of a backend requirement. */
export const FULLSTACK_MIN_BE_SCORE = 3;

/** Did the request carry positive evidence for a backend phase? */
export function hasBackendEvidence(scores: { fe: number; be: number }): boolean {
	return scores.be >= FULLSTACK_MIN_BE_SCORE;
}

/** Which specialist wins on scores alone. A tie is NOT fullstack. */
export function winningSpecialist(scores: { fe: number; be: number }): 'fe' | 'be' {
	return scores.be > scores.fe ? 'be' : 'fe';
}

function confidenceFrom(scores: { fe: number; be: number }, floor = 0.4): number {
	const sum = scores.fe + scores.be;
	if (sum <= 0) return floor;
	return Math.min(1, Math.abs(scores.fe - scores.be) / sum + 0.3);
}

/** Route one intent string to a specialist, or null if it says nothing. */
function specialistForIntent(intent: BriefIntent): BriefSpecialist | null {
	switch (intent) {
		case 'create_fe':
		case 'edit_fe':
			return 'fe';
		case 'create_be':
		case 'edit_be':
			return 'be';
		case 'question':
			return 'none';
		default:
			return null;
	}
}

export function routeFromBrief(input: RouteInput): RouteDecision {
	const { intent, scope, scores, decode } = input;

	// A pinned scope is an instruction, not a signal. It is checked before
	// the decode so an explicit "frontend only" can never reach the backend
	// model, even when the advisor failed or misread the request.
	if (input.scopePinned && scope !== 'fullstack') {
		const pinned: BriefSpecialist = scope === 'backend' ? 'be' : 'fe';
		return {
			specialist: pinned,
			phases: [pinned],
			scores,
			reason: `scope_pinned:${scope} fe=${scores.fe} be=${scores.be}`,
			confidence: 1,
		};
	}

	// R3 — a failed decode cannot route. Fall back to the deterministic
	// scores and say so in the reason; the marker is what tests and eval
	// grep for when counting how often the model was unusable.
	if (decode.failed || !decode.ok) {
		const winner = winningSpecialist(scores);
		return {
			specialist: winner,
			phases: [winner],
			scores,
			reason: `decode_failed:ensemble_fallback fe=${scores.fe} be=${scores.be}`,
			confidence: confidenceFrom(scores),
		};
	}

	// An unrecognised-but-"ok" intent is still not routeable.
	if (intent === 'unknown') {
		const winner = winningSpecialist(scores);
		return {
			specialist: winner,
			phases: [winner],
			scores,
			reason: `unknown_intent:ensemble_fallback fe=${scores.fe} be=${scores.be}`,
			confidence: confidenceFrom(scores),
		};
	}

	if (intent === 'fullstack') {
		// R2 — even an explicit fullstack intent needs backend evidence to
		// run the backend model. Without it, the second phase is pure cost.
		if (!hasBackendEvidence(scores)) {
			const winner = winningSpecialist(scores);
			return {
				specialist: winner,
				phases: [winner],
				scores,
				reason: `fullstack_downgraded:no_be_evidence fe=${scores.fe} be=${scores.be}`,
				confidence: confidenceFrom(scores),
			};
		}
		return {
			specialist: 'be',
			phases: ['be', 'fe'],
			scores,
			reason: `fullstack:decoded fe=${scores.fe} be=${scores.be}`,
			confidence: confidenceFrom(scores),
		};
	}

	const fromIntent = specialistForIntent(intent);
	if (fromIntent) {
		return {
			specialist: fromIntent,
			phases: fromIntent === 'none' ? [] : [fromIntent],
			scores,
			reason: `${intent}:decoded fe=${scores.fe} be=${scores.be}`,
			confidence: Math.max(confidenceFrom(scores), 0.6),
		};
	}

	// Scope is the next-strongest evidence (constraint parser or contract).
	if (scope === 'fullstack' && hasBackendEvidence(scores)) {
		return {
			specialist: 'be',
			phases: ['be', 'fe'],
			scores,
			reason: `fullstack_scope:be_evidence fe=${scores.fe} be=${scores.be}`,
			confidence: confidenceFrom(scores),
		};
	}

	const winner = winningSpecialist(scores);
	return {
		specialist: winner,
		phases: [winner],
		scores,
		reason: `scores:${winner} fe=${scores.fe} be=${scores.be}`,
		confidence: confidenceFrom(scores),
	};
}
