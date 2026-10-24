/**
 * types.ts — the `TurnBrief` contract (v1).
 *
 * WHY THIS EXISTS
 *
 * Today five components each decide, independently, what a request is:
 * the advisor decodes an intent, the ensemble scores keywords, the
 * planner contract picks a scope, the RAG tier picks chunks, and the
 * generation loop picks a specialist. Nothing reconciles them, so they
 * disagree in production and nothing notices. The measured case:
 *
 *   [Ensemble] Overwhelming frontend signals (FE=8, BE=0) -> frontend
 *   [PlannerContract] scope=fullstack arch=unknown fw=unknown est=10
 *
 * The brief is the single object that reconciles them. One decode step
 * fills it; every downstream stage READS it and no stage re-derives
 * intent. It is also the SFT record format, which is why the schema is
 * versioned and serialized rather than kept in memory.
 *
 * PHASE 2 SCOPE: this file is the schema and nothing else. No consumer
 * reads the brief yet, so behaviour is identical to before. The point of
 * shipping it first is that the shape can be tested and diffed before
 * anything depends on it.
 */

/** Bumped when a field changes meaning, not when one is added. */
export const BRIEF_VERSION = 1;

/**
 * What the decode step is allowed to say. `unknown` is a first-class
 * member on purpose: it is what a failed decode reports, and it must
 * never be coerced into `fullstack` (see validate.ts R3).
 */
export type BriefIntent =
	| 'create_fe'
	| 'edit_fe'
	| 'create_be'
	| 'edit_be'
	| 'fullstack'
	| 'question'
	| 'unknown';

export type BriefScope = 'frontend' | 'backend' | 'fullstack';

/** Which specialist runs. `none` = answer directly, generate nothing. */
export type BriefSpecialist = 'fe' | 'be' | 'none';

/** The observable result of the advisor pass. */
export interface DecodeRecord {
	/** Model id that produced the decode, e.g. 'qwen-advisor-v1'. */
	model: string;
	/** Wall time of the decode, ms. */
	ms: number;
	/** Prompt tokens the decode consumed. */
	promptTokens: number;
	/** Did the decode produce a schema-valid intent? */
	ok: boolean;
	/** `!ok`, kept separately because it reads better at call sites. */
	failed: boolean;
	/** Raw model text. Kept for eval/replay only — never parsed downstream. */
	raw: string;
}

/** Stack facts, copied from the profile the router already detects. */
export interface StackFacts {
	framework: string;
	language: string;
	singleFile: boolean;
}

/** One indexed file. Populated in Phase 4; zeros are honest until then. */
export interface FileFacts {
	path: string;
	hash: string;
	loc: number;
	role: string;
	symbols: string[];
	imports: string[];
	summary: string;
}

export interface RetrievedChunk {
	path: string;
	score: number;
	chunk: string;
}

export interface FileKnowledge {
	indexedAt: string;
	fileCount: number;
	edges: number;
	files: FileFacts[];
	retrieved: RetrievedChunk[];
}

/**
 * A file the specialist is expected to touch. `patch` requires a hash —
 * a patch target with no hash cannot be verified, so validate.ts rejects
 * it rather than letting a stale patch through.
 */
export interface BriefTarget {
	path: string;
	mode: 'patch' | 'create';
	hash?: string;
}

export interface RouteDecision {
	specialist: BriefSpecialist;
	/** Specialists to run, in order. `['be','fe']` for fullstack. */
	phases: Array<'fe' | 'be'>;
	/** The deterministic scores that fed the decision. */
	scores: { fe: number; be: number };
	/** Human-readable justification. `decode_failed:*` marks a fallback. */
	reason: string;
	confidence: number;
}

export interface TurnBrief {
	version: number;
	requestId: string;
	decode: DecodeRecord;
	intent: BriefIntent;
	scope: BriefScope;
	stack: StackFacts;
	modules: string[];
	features: string[];
	fileKnowledge: FileKnowledge;
	targets: BriefTarget[];
	route: RouteDecision;
}

/** Every intent the schema accepts, for validators and parsers. */
export const BRIEF_INTENTS: readonly BriefIntent[] = [
	'create_fe',
	'edit_fe',
	'create_be',
	'edit_be',
	'fullstack',
	'question',
	'unknown',
];

export const BRIEF_SCOPES: readonly BriefScope[] = ['frontend', 'backend', 'fullstack'];
