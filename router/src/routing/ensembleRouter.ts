/**
 * ensembleRouter.ts — Ensemble orchestrator + cross-specialist skip helpers.
 *
 * Extracted from index.ts (lines 1023–1143 original, step 5b).
 * Fuses: advisor, prompt patterns, open file, workspace signals → final route.
 */

import {
	type AdvisorIntent,
	UI_COMPONENT_PATTERN,
	UI_INTERACTION_PATTERN,
	UI_DESIGN_PATTERN,
	UI_FRAMEWORK_PATTERN,
	scoreKeywords,
	detectAppType,
	inferPreviousRoute,
	classifyOpenFile,
} from './intentClassifier.js';

// ---------------------------------------------------------------------------
// Cross-specialist skip helpers
// ---------------------------------------------------------------------------

/** Returns true if the prompt contains signals that frontend work is required. */
export function promptNeedsFrontend(prompt: string): boolean {
	return (
		UI_COMPONENT_PATTERN.test(prompt) ||
		UI_INTERACTION_PATTERN.test(prompt) ||
		UI_DESIGN_PATTERN.test(prompt) ||
		UI_FRAMEWORK_PATTERN.test(prompt)
	);
}

/** Single hook for deciding whether the FE specialist should run in fullstack mode. */
export function shouldRunFrontend(opts: {
	intent: string;
	prompt: string;
	beFilesWritten: string[];
}): boolean {
	if (promptNeedsFrontend(opts.prompt)) return true;
	if (opts.intent === 'create_fullstack' || opts.intent === 'edit_fullstack' || opts.intent === 'general') return true;
	return false;
}

export function isCreatePrompt(msg: string): boolean {
	return /\b(?:create|make|build|scaffold|generate|setup|init|new|develop|implement)\b/i.test(msg);
}

// ---------------------------------------------------------------------------
// Ensemble Orchestrator
// ---------------------------------------------------------------------------

/**
 * Ensemble Orchestrator.
 * Fuses: advisor(+3), prompt semantic patterns, open file(+1), workspace(+1).
 * Returns final routing intent.
 */
export function ensembleRoute(
	advisorIntent: AdvisorIntent | null,
	openFiles: string[] | undefined,
	messages: any[],
	backendFileCount: number,
	frontendFileCount: number,
	msg: string,
): { intent: 'frontend' | 'backend' | 'general' | 'unknown'; isCreate: boolean } {
	let isCreate = advisorIntent ? advisorIntent.startsWith('create_') : isCreatePrompt(msg);

	const { feScore: fkw, beScore: bkw } = scoreKeywords(msg);
	console.log(`[Ensemble] Keyword/Pattern scores: FE=${fkw}, BE=${bkw} | advisor=${advisorIntent}`);

	// --- 1. Decisive Gap Winners from keyword/pattern scoring ---
	// If one domain has an overwhelming advantage (e.g. FE=8, BE=2, difference >= 3 or ratio >= 2.5),
	// it must NOT be hijacked into fullstack by an incidental keyword or noisy advisor output.
	if (fkw >= 4 && (bkw === 0 || fkw >= bkw + 3 || fkw >= bkw * 2.5)) {
		console.log(`[Ensemble] Overwhelming frontend signals (FE=${fkw}, BE=${bkw}) -> routing to frontend`);
		return { intent: 'frontend', isCreate };
	}
	if (bkw >= 4 && (fkw === 0 || bkw >= fkw + 3 || bkw >= fkw * 2.5)) {
		console.log(`[Ensemble] Overwhelming backend signals (BE=${bkw}, FE=${fkw}) -> routing to backend`);
		return { intent: 'backend', isCreate };
	}

	// --- 2. Pure single-domain requests (one has signal, other is strictly 0) ---
	if (fkw > 0 && bkw === 0) {
		console.log(`[Ensemble] Pure frontend request (FE=${fkw}, BE=0) -> routing to frontend`);
		return { intent: 'frontend', isCreate };
	}
	if (bkw > 0 && fkw === 0) {
		console.log(`[Ensemble] Pure backend request (BE=${bkw}, FE=0) -> routing to backend`);
		return { intent: 'backend', isCreate };
	}

	// --- 3. Explicit Fullstack from Advisor ---
	// Only route to fullstack if Advisor explicitly says fullstack AND signals are not strongly one-sided
	if (advisorIntent?.includes('fullstack') && Math.abs(fkw - bkw) <= 2) {
		console.log('[Ensemble] Confirmed fullstack (Advisor=fullstack with balanced signals) -> general');
		return { intent: 'general', isCreate };
	}

	// --- 4. Mixed / Ambiguous signals -> fuse with Open File & Workspace context ---
	let feScore = Math.min(fkw, 4);
	let beScore = Math.min(bkw, 4);

	if (advisorIntent && advisorIntent !== 'unknown') {
		if (advisorIntent.includes('fe')) feScore += 3;
		if (advisorIntent.includes('be')) beScore += 3;
	}

	const openFileSignal = classifyOpenFile(openFiles);
	if (openFileSignal === 'fe') feScore += 1;
	if (openFileSignal === 'be') beScore += 1;

	const prevRoute = inferPreviousRoute(messages);
	if (prevRoute === 'fe') feScore += 1;
	if (prevRoute === 'be') beScore += 1;

	if (fkw === 0 && bkw === 0) {
		if (frontendFileCount > 0 && backendFileCount === 0) feScore += 2;
		if (backendFileCount > 0 && frontendFileCount === 0) beScore += 2;
	}

	console.log(`[Ensemble] Final fused scores: FE=${feScore}, BE=${beScore}`);

	// Clear gap winner from fused scoring
	if (feScore >= beScore + 2) return { intent: 'frontend', isCreate };
	if (beScore >= feScore + 2) return { intent: 'backend', isCreate };

	// Balanced signals where both are genuinely present -> fullstack
	if (feScore >= 2 && beScore >= 2) {
		console.log('[Ensemble] Balanced signals -> fullstack (general)');
		return { intent: 'general', isCreate };
	}

	// Margin winner when signals are weak
	if (feScore > beScore) return { intent: 'frontend', isCreate };
	if (beScore > feScore) return { intent: 'backend', isCreate };

	// Empty workspace app fallback
	const isEmpty = backendFileCount === 0 && frontendFileCount === 0;
	if (isEmpty && detectAppType(msg)) {
		console.log('[Ensemble] Empty workspace + app noun -> forcing create_fullstack');
		return { intent: 'general', isCreate: true };
	}

	console.warn('[Ensemble] No signal. Returning unknown.');
	return { intent: 'unknown', isCreate };
}
