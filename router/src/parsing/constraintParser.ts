/**
 * constraintParser.ts — Scope constraint detection.
 *
 * Extracted from index.ts (lines 38–64).
 * Runs BEFORE the advisor, highest priority. Pure functions, no I/O.
 */

export type UserScope = 'BACKEND_ONLY' | 'FRONTEND_ONLY' | 'ANY';

const BACKEND_ONLY_PATTERNS = [
	/\bbackend[\s-]?only\b/i, /\bbackend\s+files?\s+only\b/i,
	/\bgenerate\s+(?:only\s+)?backend\b/i, /\bserver[\s-]?only\b/i,
	/\bapi[\s-]?only\b/i, /\bno\s+frontend\b/i, /\bwithout\s+frontend\b/i,
	/\bexpress\s+backend\b/i, /\bnestjs\s+backend\b/i,
	/\bno\s+react\b/i, /\bno\s+ui\b/i,
];
const FRONTEND_ONLY_PATTERNS = [
	/\bfrontend[\s-]?only\b/i, /\breact[\s-]?only\b/i,
	/\bnext\.?js[\s-]?only\b/i, /\bui[\s-]?only\b/i,
	/\bcomponent[\s-]?only\b/i, /\bno\s+backend\b/i,
	/\bwithout\s+backend\b/i, /\bno\s+server\b/i, /\bno\s+api\b/i,
];

export function parseUserScope(msg: string): UserScope {
	if (BACKEND_ONLY_PATTERNS.some(p => p.test(msg))) {
		console.log('[ConstraintParser] Scope: BACKEND_ONLY');
		return 'BACKEND_ONLY';
	}
	if (FRONTEND_ONLY_PATTERNS.some(p => p.test(msg))) {
		console.log('[ConstraintParser] Scope: FRONTEND_ONLY');
		return 'FRONTEND_ONLY';
	}
	return 'ANY';
}
