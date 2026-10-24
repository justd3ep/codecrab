/**
 * validate.ts — the brief must be provably sane before anything trusts it.
 *
 * A brief is only worth having if a bad one cannot pass. The four rules
 * below are the ones that would have caught the measured production
 * failures, so they are enforced structurally rather than by convention:
 *
 *   R2  `scope === 'fullstack'` needs POSITIVE backend evidence.
 *       The old code reached fullstack by falling through a ternary, on a
 *       request the ensemble had scored BE=0. That is a silent cost
 *       doubling, so a brief claiming fullstack with no BE score and no
 *       backend target is invalid.
 *   R3  a failed decode cannot yield fullstack, and must say it failed.
 *   R4  a `patch` target must carry the hash it was derived from —
 *       a patch with no hash cannot be verified against the file on disk.
 *   R1  `route.specialist` and `route.phases` must agree.
 *
 * Returns a list of violations (empty array = valid) rather than
 * throwing, so callers can log-and-continue in production and assert in
 * tests. `assertBrief` is the throwing form.
 */
import {
	BRIEF_INTENTS,
	BRIEF_SCOPES,
	BRIEF_VERSION,
	type TurnBrief,
} from './types.js';
import { FULLSTACK_MIN_BE_SCORE, hasBackendEvidence } from './routeFromBrief.js';

/** Does this path look like a backend artefact? Used for R2 evidence. */
export function isBackendPath(p: string): boolean {
	return /(^|\/)(server|api|routes?|controllers?|services?|middleware|db|prisma|models?)\b/i.test(p) || /\.sql$/i.test(p);
}

export function validateBrief(brief: unknown): string[] {
	const out: string[] = [];
	const b = brief as Partial<TurnBrief> | null | undefined;

	if (!b || typeof b !== 'object') return ['brief is not an object'];

	if (b.version !== BRIEF_VERSION) out.push(`version must be ${BRIEF_VERSION}, got ${String(b.version)}`);
	if (typeof b.requestId !== 'string' || !b.requestId) out.push('requestId must be a non-empty string');

	if (!BRIEF_INTENTS.includes(b.intent as any)) out.push(`intent "${String(b.intent)}" is not in the schema`);
	if (!BRIEF_SCOPES.includes(b.scope as any)) out.push(`scope "${String(b.scope)}" is not in the schema`);

	// --- decode ---
	const d = b.decode;
	if (!d || typeof d !== 'object') {
		out.push('decode record is missing');
	} else {
		if (typeof d.model !== 'string' || !d.model) out.push('decode.model must be a non-empty string');
		if (typeof d.ms !== 'number' || !Number.isFinite(d.ms) || d.ms < 0) out.push('decode.ms must be a finite ms value');
		if (typeof d.ok !== 'boolean') out.push('decode.ok must be a boolean');
		if (typeof d.failed !== 'boolean') out.push('decode.failed must be a boolean');
		if (d.ok === true && d.failed === true) out.push('decode.ok and decode.failed cannot both be true');
		if (typeof d.raw !== 'string') out.push('decode.raw must be a string');
	}

	// --- stack ---
	const s = b.stack;
	if (!s || typeof s !== 'object') {
		out.push('stack is missing');
	} else {
		if (typeof s.framework !== 'string' || !s.framework) out.push('stack.framework must be a non-empty string');
		if (!['html', 'javascript', 'typescript'].includes(s.language as any)) {
			out.push(`stack.language "${String(s.language)}" must be html|javascript|typescript`);
		}
		if (typeof s.singleFile !== 'boolean') out.push('stack.singleFile must be a boolean');
	}

	// --- route (R1) ---
	const r = b.route;
	const scores = r && r.scores;
	if (!r || typeof r !== 'object') {
		out.push('route is missing');
	} else {
		if (!['fe', 'be', 'none'].includes(r.specialist as any)) {
			out.push(`route.specialist "${String(r.specialist)}" must be fe|be|none`);
		}
		if (!Array.isArray(r.phases) || r.phases.some((p) => p !== 'fe' && p !== 'be')) {
			out.push('route.phases must be an array of fe|be');
		} else {
			const phases = r.phases as Array<'fe' | 'be'>;
			if (r.specialist === 'none' && phases.length > 0) out.push('route.specialist none cannot have phases');
			if (r.specialist === 'fe' && !phases.includes('fe')) out.push('route.specialist fe is not in route.phases');
			if (r.specialist === 'be' && !phases.includes('be')) out.push('route.specialist be is not in route.phases');
		}
		if (!scores || typeof scores.fe !== 'number' || typeof scores.be !== 'number') {
			out.push('route.scores must carry numeric fe and be');
		}
		if (typeof r.reason !== 'string' || !r.reason) out.push('route.reason must be a non-empty string');
		if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) {
			out.push('route.confidence must be between 0 and 1');
		}
	}

	// --- file knowledge ---
	const fk = b.fileKnowledge;
	if (!fk || typeof fk !== 'object' || !Array.isArray(fk.files)) {
		out.push('fileKnowledge.files must be an array');
	} else {
		fk.files.forEach((f, i) => {
			if (!f || typeof f.path !== 'string' || !f.path) out.push(`fileKnowledge.files[${i}].path is missing`);
		});
	}

	// --- targets (R4) ---
	if (!Array.isArray(b.targets)) {
		out.push('targets must be an array');
	} else {
		b.targets.forEach((t, i) => {
			if (!t || typeof t.path !== 'string' || !t.path) out.push(`targets[${i}].path is missing`);
			if (t && t.mode !== 'patch' && t.mode !== 'create') out.push(`targets[${i}].mode must be patch|create`);
			if (t && t.mode === 'patch' && (typeof t.hash !== 'string' || !t.hash)) {
				out.push(`targets[${i}] is a patch target with no hash`);
			}
		});
	}

	// --- R1b: scope and specialist cannot contradict each other ---
	// The measured bug class: scope resolved to frontend (a user mask) while
	// the route still named the backend specialist. Two fields, one owner.
	if (b.scope === 'frontend' && r && r.specialist === 'be') {
		out.push('scope frontend contradicts route.specialist be');
	}
	if (b.scope === 'backend' && r && r.specialist === 'fe') {
		out.push('scope backend contradicts route.specialist fe');
	}

	// --- R2: fullstack needs evidence ---
	if (b.scope === 'fullstack' && scores && typeof scores.be === 'number') {
		const backendTarget = Array.isArray(b.targets) && b.targets.some((t) => t && isBackendPath(t.path));
		if (!hasBackendEvidence(scores) && !backendTarget) {
			out.push(
				`scope fullstack without backend evidence (be=${scores.be} < ${FULLSTACK_MIN_BE_SCORE}, no backend target)`,
			);
		}
	}

	// --- R3: a failed decode cannot yield fullstack ---
	if (d && typeof d === 'object' && d.failed === true) {
		if (b.scope === 'fullstack') out.push('a failed decode cannot produce scope fullstack');
		if (r && typeof r.reason === 'string' && !r.reason.startsWith('decode_failed:')) {
			out.push('a failed decode must route with a "decode_failed:" reason');
		}
	}

	return out;
}

/** Throwing form for tests and for the write path. */
export function assertBrief(brief: unknown): asserts brief is TurnBrief {
	const violations = validateBrief(brief);
	if (violations.length > 0) {
		throw new Error(`invalid TurnBrief: ${violations.join('; ')}`);
	}
}

export function isValidBrief(brief: unknown): brief is TurnBrief {
	return validateBrief(brief).length === 0;
}
