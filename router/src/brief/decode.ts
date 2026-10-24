/**
 * decode.ts — the one place raw advisor text becomes a schema intent.
 *
 * THE BUG THIS EXISTS FOR
 *
 * The advisor speaks its own vocabulary (`create_fullstack`, `edit_fe`,
 * `general`, `unknown`); the brief speaks the schema's (`fullstack`,
 * `create_fe`, ...). Phase 2 normalised by membership only, so a valid
 * `create_fullstack` decode was recorded as `unknown` and scored as a
 * failure, and the literal string "unknown" survived the
 * `advisorIntent ?? ensembledIntent` null-check into the planner contract,
 * whose ternary then fell through to `fullstack`. A request the ensemble
 * had scored BE=0 ran the backend model.
 *
 * This is the decode contract: either the text maps onto the schema, or it
 * is explicitly failed with a reason that names why. There is no third
 * state and no default, which is what makes `decode.ok` trustworthy as a
 * gate and usable as an eval metric.
 */
import { BRIEF_INTENTS, type BriefIntent } from './types.js';

export interface DecodeOutcome {
	/** What the schema calls this request. `unknown` when it is unusable. */
	intent: BriefIntent;
	/** True only when the text mapped onto a routable schema intent. */
	ok: boolean;
	/** Why. Stable prefixes (`unrecognised:`, `advisor_`, `empty`) for eval. */
	reason: string;
}

/**
 * Advisor intents whose meaning the schema already has under another name.
 * `create_fullstack` and `edit_fullstack` are the same routing decision as
 * `fullstack`; the create/edit distinction is carried by `isCreate`
 * elsewhere, not by the brief.
 */
const ALIASES: Record<string, BriefIntent> = {
	create_fullstack: 'fullstack',
	edit_fullstack: 'fullstack',
};

/**
 * Decode raw advisor text. Never throws, never guesses.
 *
 * `general` is deliberately NOT routable: the advisor emits it when it has
 * no opinion, and the brief's `unknown` is the honest record of that.
 */
export function decodeAdvisorIntent(raw: string | null | undefined): DecodeOutcome {
	if (raw == null) return { intent: 'unknown', ok: false, reason: 'no_intent' };
	const v = String(raw).trim().toLowerCase().replace(/\s+/g, '_');
	if (!v) return { intent: 'unknown', ok: false, reason: 'empty' };

	if (v === 'general') return { intent: 'unknown', ok: false, reason: 'advisor_general' };

	const mapped = ALIASES[v] ?? v;
	if (!(BRIEF_INTENTS as readonly string[]).includes(mapped)) {
		return { intent: 'unknown', ok: false, reason: `unrecognised:${v}` };
	}
	if (mapped === 'unknown') return { intent: 'unknown', ok: false, reason: 'advisor_returned_unknown' };

	return { intent: mapped as BriefIntent, ok: true, reason: 'decoded' };
}
