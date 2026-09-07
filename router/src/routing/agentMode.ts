/**
 * agentMode.ts — Agent mode determination, computed once per request.
 *
 * Extracted from index.ts (lines 1287–1363).
 * Pure function, no I/O. Mode is sealed and passed to all specialists.
 */

/** Generation mode for a specialist pass. */
export type AgentMode = 'create' | 'edit' | 'needs_context';

export interface PhaseState {
	specialist: 'be' | 'fe';
	mode: AgentMode;
}

/**
 * Determine agent mode from workspace state and user message for a specific specialist.
 * Computed independently for each phase.
 *
 * Priority (in order):
 *   1. Explicit creation intent ALWAYS overrides filesystem.
 *   2. Files exist (for this specialist) → edit
 *   3. Empty workspace + project nouns → create
 *   4. Everything else on empty workspace → needs_context
 */
export function determineMode(
	message: string,
	currentSpecialist: 'be' | 'fe',
	backendFileCount: number,
	frontendFileCount: number,
): AgentMode {
	// Tier 1: Explicit creation intent ALWAYS overrides filesystem.
	// If user says "from scratch", they mean it.
	const explicitCreate = [
		/\bfrom scratch\b/i,
		/\bnew project\b/i,
		/\bscaffold\b/i,
		/\bbootstrap\b/i,
		/\bstart over\b/i,
		/\bgenerate a new\b/i,
		/\binitiali[sz]e\b/i,
		/\bstart (?:a )?(?:new )?project\b/i,
		/\bnew (?:backend|frontend|api|server|application|app|service|microservice)\b/i,
		/\bcreate (?:a )?(?:new )?(?:backend|frontend|api|app|service|microservice|server|board|kanban|component|dashboard|page)\b/i,
		/\bbuild (?:a )?(?:new )?(?:backend|frontend|api|app|service|microservice|server|board|kanban|component|dashboard|page)\b/i,
		/\bgenerate (?:a )?(?:new )?(?:project|board|kanban|component|app)\b/i,
	];
	if (explicitCreate.some(p => p.test(message))) return 'create';

	// Tier 2: filesystem state for the current specialist.
	const specialistFilesExist = currentSpecialist === 'be' ? backendFileCount > 0 : frontendFileCount > 0;
	if (specialistFilesExist) {
		return 'edit';
	}

	// Tier 3: project nouns imply creation on empty workspace
	const projectNouns = [
		/\btodo\s*app\b/i,
		/\bchat\s*app\b/i,
		/\bexpense\s*tracker\b/i,
		/\bbudget\s*(?:app|tracker)\b/i,
		/\bportfolio\b/i,
		/\bdashboard\b/i,
		/\bblog\b/i,
		/\blanding\s*page\b/i,
		/\badmin\s*panel\b/i,
		/\bcrm\b/i,
		/\berp\b/i,
		/\bauthentication\s*system\b/i,
		/\bauth\s*system\b/i,
		/\bbooking\s*system\b/i,
		/\be-?commerce\b/i,
		/\bsaas\b/i,
		/\bapi\s*server\b/i,
		/\b(?:create|build|make|write|implement|generate|set up|setup)\b/i,
	];
	if (projectNouns.some(p => p.test(message))) return 'create';

	// Tier 4: empty workspace + ambiguous request → cannot act without context
	return 'needs_context';
}
