/**
 * The frontend feature table — the scored counterpart to the
 * requirement probes.
 *
 * WHY IT EXISTS
 *
 * The coverage table had EIGHTEEN entries and every one of them was
 * backend: jwt, repository, rbac, bcrypt. A FRONTEND request —
 * which is what the frontend model is asked for most of the time —
 * matched NONE of them, so its feature contract was empty and its
 * coverage score was 0/0:
 *
 *     [Validator] ===== DONE — 1 file(s) | 1 error(s) | 0 warning(s)
 *     | Coverage: 0/0 =====
 *
 * A 0/0 score is not a pass and not a fail. It is no measurement at
 * all. And "expected ~5 (min 2)" — the completeness check — had
 * nothing to compare against.
 *
 * The requirement PROBES already worked for this: they match the
 * user's own wording against the generated code, and they catch a
 * missing drag-and-drop. But they produce ISSUES, not a score. So
 * the probes caught the omission, and the score still said 0/0.
 *
 * This table is the scored counterpart: the same signals, with
 * weights, so a frontend request gets a real coverage number.
 *
 * WHY THE KEYS DIFFER FROM THE PROBES
 *
 * The probes use a LABEL — "drag and drop" — because they produce
 * a human-readable message. The weights table uses a KEY, because
 * it is looked up by name. The keys here are the probe labels,
 * lowercased and underscored, so the two stay recognisably the
 * same set of requirements.
 *
 * THE EVIDENCE PATTERNS ARE THE PROBES' PATTERNS
 *
 * They are proven — the probe version caught a React generation
 * that dropped the drag-and-drop the user asked for. Reusing them
 * means the score and the issues agree.
 */

/** A frontend feature: how much it is worth, and what proves it. */
export interface FrontendFeatureSpec {
	/** How much the feature is worth in the coverage score. */
	weight: number;
	/** The evidence patterns. One match is enough. */
	patterns: RegExp[];
	/** The human-readable label. */
	label: string;
}

/**
 * The frontend features.
 *
 * The weights are lower than the backend's on purpose. A frontend
 * request usually has a handful of requirements, and a backend
 * request usually has a contract with a dozen. The score is a
 * RATIO — it is compared against the maximum for that request, not
 * against an absolute — so the weights only have to be internally
 * consistent.
 */
export const FRONTEND_FEATURE_WEIGHTS: Record<string, FrontendFeatureSpec> = {
	drag_and_drop: {
		weight: 10,
		label: 'drag and drop',
		patterns: [/draggable|dragstart|dragover|ondrag/i],
	},
	localstorage_persistence: {
		weight: 8,
		label: 'localStorage persistence',
		patterns: [/localStorage/i],
	},
	theme_toggle: {
		weight: 6,
		label: 'theme toggle',
		patterns: [/prefers-color-scheme|data-theme|prefers-color/i],
	},
	aria_live_region: {
		weight: 8,
		label: 'ARIA / live region',
		patterns: [/aria-|role\s*=/i],
	},
	alt_arrow_keyboard_move: {
		weight: 6,
		label: 'Alt+Arrow keyboard move',
		patterns: [/altKey/i],
	},
	keyboard_accessibility: {
		weight: 10,
		label: 'keyboard accessibility',
		patterns: [/keydown|keyup|tabindex/i],
	},
	responsive_layout: {
		weight: 6,
		label: 'responsive layout',
		patterns: [/@media/i],
	},
	animation: {
		weight: 4,
		label: 'animation',
		patterns: [/@keyframes|animation|transition/i],
	},
	inline_edit: {
		weight: 4,
		label: 'inline edit',
		patterns: [/contenteditable|dblclick/i],
	},
	delete: {
		weight: 3,
		label: 'delete',
		patterns: [/\bdelete\b|removeItem|onDelete/i],
	},
	form_validation: {
		weight: 6,
		label: 'form validation',
		patterns: [/required|pattern=|noValidate|setCustomValidity/i],
	},
	loading_state: {
		weight: 4,
		label: 'loading state',
		patterns: [/isLoading|loading\b|spinner|isPending/i],
	},
	error_state: {
		weight: 4,
		label: 'error state',
		patterns: [/catch\s*\(|error\.message|isError|\.catch\b/i],
	},
};

/**
 * The frontend feature keys, for a request.
 *
 * The signals are the PROBES' signals — proven to match the user's
 * own wording. The keys are the same, so the score and the issues
 * are about the same requirements.
 */
export const FRONTEND_FEATURE_SIGNALS: Array<{ key: string; re: RegExp }> = [
	{ key: 'drag_and_drop', re: /\bdrag(?:ging)?[\s-]?and[\s-]?drop|\bdraggable\b|\bdrag\b/i },
	{ key: 'localstorage_persistence', re: /\blocalstorage\b|\bpersist(?:ence|ent)?\b|\brestore on reload\b/i },
	{ key: 'theme_toggle', re: /prefers-color-scheme|\bdark\b.{0,20}\blight\b|\btheme toggle\b/i },
	{ key: 'aria_live_region', re: /\baria\b|\blive region\b|\bannounc/i },
	{ key: 'alt_arrow_keyboard_move', re: /\balt\s*\+\s*arrow|\barrow keys?\b/i },
	{ key: 'keyboard_accessibility', re: /\bkeyboard\b|\bfocus (?:cards?|items?) with tab\b|\btab\b/i },
	{ key: 'responsive_layout', re: /\bresponsive\b|\bstack under\b|\bbreakpoint\b|\d{3,4}\s*px\b/i },
	{ key: 'animation', re: /\banimat/i },
	{ key: 'inline_edit', re: /\binline edit\b|\bedit\b/i },
	{ key: 'delete', re: /\bdelete\b|\bremove\b/i },
	{ key: 'form_validation', re: /\bvalidat/i },
	{ key: 'loading_state', re: /\bloading\b|\bspinner\b|\bskeleton\b/i },
	{ key: 'error_state', re: /\berror handling\b|\berror state\b|\bfallback ui\b/i },
];

/**
 * The frontend features a request asks for.
 *
 * The same shape as the backend's detection: a list of KEYS.
 */
export function detectFrontendFeatures(request: string): string[] {
	return FRONTEND_FEATURE_SIGNALS.filter(f => f.re.test(request)).map(f => f.key);
}