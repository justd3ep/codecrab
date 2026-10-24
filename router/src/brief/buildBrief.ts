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
import { BRIEF_INTENTS, BRIEF_VERSION } from './types.js';
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
	/** Scope the planner contract produced, if any. Advisory until Phase 3. */
	contractScope?: string | null;
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

/** Coerce raw advisor text into a schema intent. Anything else is unknown. */
export function normaliseIntent(raw: string | null | undefined): BriefIntent {
	if (!raw) return 'unknown';
	const v = String(raw).trim().toLowerCase().replace(/\s+/g, '_');
	return (BRIEF_INTENTS as readonly string[]).includes(v) ? (v as BriefIntent) : 'unknown';
}

function normaliseScope(raw: string | null | undefined): BriefScope | null {
	if (!raw) return null;
	const v = String(raw).trim().toLowerCase();
	return v === 'frontend' || v === 'backend' || v === 'fullstack' ? (v as BriefScope) : null;
}

/**
 * Which scope the brief should record.
 *
 * Order of authority: explicit user constraint > valid decode's contract
 * scope > the ensemble's verdict. A failed decode skips the contract
 * entirely (R3) — that is the whole defect this pipeline exists to kill.
 */
function resolveScope(input: BriefInput, decodedOk: boolean): BriefScope {
	const userScope = (input.userScope || '').toUpperCase();
	if (userScope === 'FRONTEND_ONLY') return 'frontend';
	if (userScope === 'BACKEND_ONLY') return 'backend';

	if (decodedOk) {
		const fromContract = normaliseScope(input.contractScope);
		if (fromContract) return fromContract;
	}

	const fromEnsemble = normaliseScope(input.ensembleIntent);
	if (fromEnsemble) return fromEnsemble;

	// 'general' — no textual signal either way. Never default to fullstack.
	return input.scores.be > input.scores.fe ? 'backend' : 'frontend';
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

	let scope = resolveScope(input, decode.ok);

	// A user mask is an instruction, not a vote. `resolveScope` already
	// honoured it; this flag tells the router the scope is not negotiable.
	const mask = (input.userScope || '').toUpperCase();
	const scopePinned = mask === 'FRONTEND_ONLY' || mask === 'BACKEND_ONLY';

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
