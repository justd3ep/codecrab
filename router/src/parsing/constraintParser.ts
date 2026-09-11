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
	// Natural language backend requests
	/\b(?:build|create|implement|make)\s+(?:a\s+)?(?:[\w-]+\s+){0,3}(?:rest\s+|server\s+)?backend\b/i,
	/\bbackend\s+for\b/i,
	/\bbackend\s+(?:service|server|api|application)\b/i,
	/\bonly\s+(?:the\s+)?(?:backend|server|api)\b/i,
];
const FRONTEND_ONLY_PATTERNS = [
	/\bfrontend[\s-]?only\b/i, /\breact[\s-]?only\b/i,
	/\bnext\.?js[\s-]?only\b/i, /\bui[\s-]?only\b/i,
	/\bcomponent[\s-]?only\b/i, /\bno\s+backend\b/i,
	/\bwithout\s+backend\b/i, /\bno\s+server\b/i, /\bno\s+api\b/i,
	// Natural language frontend requests
	/\b(?:build|create|implement|make|design)\s+(?:a\s+)?(?:[\w-]+\s+){0,3}(?:dashboard\s+|web\s+)?frontend\b/i,
	/\bfrontend\s+for\b/i,
	/\bfrontend\s+(?:dashboard|app|application|ui|interface|client)\b/i,
	/\bclient[\s-]?side\b/i,
	/\bfrontend\s+code\b/i,
	/\bonly\s+(?:the\s+)?(?:frontend|ui)\b/i,
	/\buse\s+mock\s+(?:data|api|functions)\b/i,
];

export function parseUserScope(msg: string): UserScope {
	// If the user explicitly asks for fullstack, or explicitly mentions both frontend and backend work,
	// do NOT lock into a single-domain constraint.
	const isFullStack = /\bfull[\s-]?stack\b/i.test(msg) ||
		(/\b(?:frontend|react|ui|client)\b/i.test(msg) && /\b(?:backend|server|express|nestjs|database)\b/i.test(msg));

	if (isFullStack) {
		return 'ANY';
	}

	if (FRONTEND_ONLY_PATTERNS.some(p => p.test(msg))) {
		console.log('[ConstraintParser] Scope: FRONTEND_ONLY');
		return 'FRONTEND_ONLY';
	}
	if (BACKEND_ONLY_PATTERNS.some(p => p.test(msg))) {
		console.log('[ConstraintParser] Scope: BACKEND_ONLY');
		return 'BACKEND_ONLY';
	}
	return 'ANY';
}
