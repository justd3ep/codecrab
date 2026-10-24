/**
 * buildBrief.ts — assemble the brief from values the router already has.
 *
 * PHASE 2 IS A WIRING EXERCISE, NOT A BEHAVIOUR CHANGE
 *
 * Nothing in the request path reads `prep.brief` yet. This function only
 * *records* what the five deciders concluded, so the brief can be
 * validated, serialized, and diffed against live traffic before any
 * consumer depends on it. That is the whole point: flip the consumers in
 * a later phase and prove parity from the JSON that was already being
 * written, instead of changing routing and rewriting the pipeline at the
 * same time.
 *
 * WHAT IT DOES CORRECT (WITHOUT ACTING ON IT YET)
 *
 * Two corrections happen here because the schema would otherwise be
 * invalid on today's traffic, and an invalid brief teaches nothing:
 *
 *   1. R3 — if the decode failed, the scope comes from the deterministic
 *      ensemble, never from the contract. Today the advisor fails and
 *      still returns the literal string "unknown", which survives the
 *      `advisorIntent ?? ensembledIntent` null-check and lands in
 *      plannerContract, whose ternary falls through to 'fullstack'. The
 *      brief records 'frontend' for that request while the pipeline still
 *      runs 'fullstack'. That difference IS the bug, made visible.
 *   2. R2 — a fullstack scope with no backend score is downgraded to the
 *      winning single specialist, because validate.ts will not accept it.
 *
 * Nothing downstream reads the result, so behaviour is byte-identical.
 */
import type {
	BriefIntent,
	BriefScope,
	BriefTarget,
	DecodeRecord,
	FileFacts,
	FileKnowledge,
	RetrievedChunk,
	StackFacts,
	TurnBrief,
} from './types.js';
import { BRIEF_VERSION } from './types.js';
import { decodeAdvisorIntent } from './decode.js';
import { hasBackendEvidence, routeFromBrief, winningSpecialist } from './routeFromBrief.js';

export const ADVISOR_MODEL_ID = 'qwen-advisor-v1';

export interface BriefInput {
	requestId: string;
	lastUserMsg: string;
	/** What the ensemble concluded: frontend | backend | general. */
	ensembleIntent: 'frontend' | 'backend' | 'general';
	/** Raw advisor output, e.g. "create_fe", "unknown", or null. */
	rawAdvisorIntent: string | null | undefined;
	/** Deterministic keyword/pattern scores that fed the ensemble. */
	scores: { fe: number; be: number };
	/** Advisor pass outcome, as measured by the caller. */
	decode: { model?: string; ms: number; promptTokens?: number; raw: string; ok: boolean };
	/** Detected stack profile (or null when there is no workspace). */
	stack?: { framework?: string; language?: string; singleFile?: boolean } | null;
	/** Constraint parser's scope mask. */
	userScope?: string | null;
	features?: string[];
	modules?: string[];
	fileKnowledge?: {
		indexedAt?: string;
		fileCount?: number;
		edges?: number;
		files?: FileFacts[];
		retrieved?: RetrievedChunk[];
	};
	targets?: BriefTarget[];
	/** ISO timestamp, passed in so the builder stays deterministic. */
	now?: string;
}

/**
 * Coerce raw advisor text into a schema intent. Anything else is unknown.
 *
 * Delegates to the decode contract so there is exactly one mapping. This
 * used to be membership-only, which scored a valid `create_fullstack`
 * decode as a failure and sent the request to the ensemble fallback.
 */
export function normaliseIntent(raw: string | null | undefined): BriefIntent {
	return decodeAdvisorIntent(raw).intent;
}

function normaliseScope(raw: string | null | undefined): BriefScope | null {
	if (!raw) return null;
	const v = String(raw).trim().toLowerCase();
	return v === 'frontend' || v === 'backend' || v === 'fullstack' ? (v as BriefScope) : null;
}

/** The scope a decoded intent names, or null when it names none. */
export function scopeForIntent(intent: BriefIntent): BriefScope | null {
	switch (intent) {
		case 'create_fe':
		case 'edit_fe':
			return 'frontend';
		case 'create_be':
		case 'edit_be':
			return 'backend';
		case 'fullstack':
			return 'fullstack';
		default:
			// `question` and `unknown` name no generation scope.
			return null;
	}
}

export interface ScopeSignals {
	/** Explicit `undefined` is allowed: callers pass the parser result straight through. */
	userScope?: string | null | undefined;
	/** The decode's schema intent; `unknown` when the decode failed. */
	intent: BriefIntent;
	ensembleIntent: 'frontend' | 'backend' | 'general';
	scores: { fe: number; be: number };
}

/**
 * Which scope the brief records — and, in Phase 3, the only scope the
 * planner contract is allowed to report.
 *
 * Order of authority: explicit user constraint > the decoded intent > the
 * ensemble's verdict > the scores. The old chain went through the planner
 * contract, whose scope was derived from the same advisor string and whose
 * final branch was `fullstack` — so an undecodable request silently became
 * the expensive two-model path. There is no fullstack fallthrough here.
 */
export function resolveBriefScope(input: ScopeSignals): { scope: BriefScope; pinned: boolean } {
	const userScope = (input.userScope || '').toUpperCase();
	if (userScope === 'FRONTEND_ONLY') return { scope: 'frontend', pinned: true };
	if (userScope === 'BACKEND_ONLY') return { scope: 'backend', pinned: true };

	const fromIntent = scopeForIntent(input.intent);
	if (fromIntent) return { scope: fromIntent, pinned: false };

	const fromEnsemble = normaliseScope(input.ensembleIntent);
	if (fromEnsemble) return { scope: fromEnsemble, pinned: false };

	// 'general' — no textual signal either way. Never default to fullstack.
	return { scope: input.scores.be > input.scores.fe ? 'backend' : 'frontend', pinned: false };
}

function resolveStack(stack: BriefInput['stack']): StackFacts {
	const language = String(stack?.language || 'typescript').toLowerCase();
	return {
		framework: String(stack?.framework || 'none'),
		language: ['html', 'javascript', 'typescript'].includes(language) ? language : 'typescript',
		singleFile: Boolean(stack?.singleFile),
	};
}

function resolveFileKnowledge(input: BriefInput): FileKnowledge {
	const fk = input.fileKnowledge;
	return {
		indexedAt: fk?.indexedAt || input.now || new Date().toISOString(),
		fileCount: typeof fk?.fileCount === 'number' ? fk.fileCount : 0,
		edges: typeof fk?.edges === 'number' ? fk.edges : 0,
		files: Array.isArray(fk?.files) ? fk.files : [],
		retrieved: Array.isArray(fk?.retrieved) ? fk.retrieved : [],
	};
}

export function buildBrief(input: BriefInput): TurnBrief {
	const intent = normaliseIntent(input.rawAdvisorIntent);
	const decode: DecodeRecord = {
		model: input.decode.model || ADVISOR_MODEL_ID,
		ms: Math.max(0, Math.round(input.decode.ms || 0)),
		promptTokens: Math.max(0, Math.round(input.decode.promptTokens || 0)),
		ok: Boolean(input.decode.ok),
		failed: !input.decode.ok,
		raw: String(input.decode.raw ?? ''),
	};

	// The brief owns the routing decision. The planner contract is derived
	// FROM this result (Phase 3) — it is never consulted while producing it.
	const scopeInfo = resolveBriefScope({
		userScope: input.userScope,
		intent,
		ensembleIntent: input.ensembleIntent,
		scores: input.scores,
	});
	const scopePinned = scopeInfo.pinned;
	let scope = scopeInfo.scope;

	// R2 — fullstack is opt-in. Without backend evidence the brief records
	// the single specialist the scores support.
	if (scope === 'fullstack' && !hasBackendEvidence(input.scores)) {
		scope = winningSpecialist(input.scores) === 'be' ? 'backend' : 'frontend';
	}

	const route = routeFromBrief({ intent, scope, scores: input.scores, decode, scopePinned });

	return {
		version: BRIEF_VERSION,
		requestId: input.requestId,
		decode,
		intent,
		scope,
		stack: resolveStack(input.stack),
		modules: Array.isArray(input.modules) ? input.modules.filter(Boolean) : [],
		features: Array.isArray(input.features) ? input.features.filter(Boolean) : [],
		fileKnowledge: resolveFileKnowledge(input),
		targets: Array.isArray(input.targets) ? input.targets : [],
		route,
	};
}
