/**
 * RepairEngine — Issue-by-Issue Repair Runner
 * ============================================
 * Processes ValidationIssues one at a time instead of bundling them all
 * into a single repair prompt. Each issue gets its own model call with
 * full context, repair mode classification, and validation of the result.
 *
 * Repair order: errors first, then warnings.
 * Max 3 attempts per issue before skipping.
 */

import type { LlamaChatSession }   from 'node-llama-cpp';
import type { ValidationIssue }    from './validator.js';
import type { GeneratedFile }      from './validator.js';
import type { FileNode }           from './planner.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const enum RepairMode {
	MODIFY_EXISTING   = 'MODIFY_EXISTING',
	GENERATE_MISSING  = 'GENERATE_MISSING',
	REWIRE_IMPORTS    = 'REWIRE_IMPORTS',
	DELETE_DUPLICATES = 'DELETE_DUPLICATES',
	SECURITY_FIX      = 'SECURITY_FIX',
	COMPILE_FIX       = 'COMPILE_FIX',
}

export interface RepairJob {
	issue:       ValidationIssue;
	targetFile:  GeneratedFile;
	mode:        RepairMode;
	/** Content of committed dependency files — for import resolution context */
	depContext:  string[];
	attempt:     number;
	maxAttempts: number;
}

export interface RepairResult {
	success:      boolean;
	repairedFile: GeneratedFile | null;
	attempts:     number;
	skipped:      boolean;    // true if maxAttempts exceeded
}

/**
 * RepairDecision — result of classifyRepairDecision.
 *
 * repair            — attempt LLM repair
 * queue_dependency  — missing file is in the plan; re-queue it
 * skip_planned      — target is planned but not yet generated — wait, do not repair
 * planner_expansion — target is not in plan; only the planner may add it
 * skip              — unresolvable; give up
 */
export type RepairDecision =
	| { action: 'repair';            mode: RepairMode }
	| { action: 'queue_dependency';  missingPath: string }
	| { action: 'skip_planned';      reason: string }
	| { action: 'planner_expansion'; suggestedPath: string }
	| { action: 'skip';              reason: string };

// ---------------------------------------------------------------------------
// RepairMode classification (mirrors index.ts classifyRepairMode)
// ---------------------------------------------------------------------------

export function classifyRepairMode(kind: string, message: string): RepairMode {
	switch (kind) {
		case 'missing_architecture':
			return /already exists|duplicate/i.test(message)
				? RepairMode.DELETE_DUPLICATES
				: RepairMode.GENERATE_MISSING;
		case 'missing_coverage':
			return RepairMode.GENERATE_MISSING;
		case 'business_logic_leak':
			return /layer violation|imports.*directly|belongs in/i.test(message)
				? RepairMode.MODIFY_EXISTING
				: RepairMode.GENERATE_MISSING;
		case 'missing_import':
			return RepairMode.REWIRE_IMPORTS;
		case 'undefined_symbol':
			return RepairMode.MODIFY_EXISTING;
		case 'dead_code':
			return /already exists|workspace/i.test(message)
				? RepairMode.DELETE_DUPLICATES
				: RepairMode.MODIFY_EXISTING;
		case 'security':
			return RepairMode.SECURITY_FIX;
		case 'compile_error':
			return RepairMode.COMPILE_FIX;
		case 'scope_violation':
			return RepairMode.DELETE_DUPLICATES;
		default:
			return RepairMode.MODIFY_EXISTING;
	}
}

/**
 * classifyRepairDecision
 * ======================
 * Dependency-aware repair routing.
 *
 * For missing_import issues:
 *   • Target in committedPaths → REWIRE (import exists, path may be wrong)
 *   • Target in plannedPaths  → skip_planned (file will be generated later)
 *   • Target in neither       → planner_expansion (repair cannot invent files)
 *
 * CRITICAL RULE: repair may NEVER generate a file not in plannedPaths.
 * Only the planner has authority to add new files to the generation graph.
 */
export function classifyRepairDecision(
	issue:           import('./validator.js').ValidationIssue,
	committedPaths: Set<string>,
	plannedPaths:   Set<string>,
): RepairDecision {
	if (issue.kind === 'missing_import') {
		// Extract target path from message if possible
		const pathMatch = issue.message.match(/"([^"]+)"/);
		const rawTarget = pathMatch?.[1] ?? '';

		// Normalize: strip leading ./ and extension for comparison
		const normalizedTarget = rawTarget.replace(/^\.\//, '').replace(/\.(?:ts|tsx|js|jsx)$/, '');
		const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', ''];

		const inCommitted = RESOLVE_EXTS.some(ext =>
			committedPaths.has(normalizedTarget + ext) ||
			committedPaths.has(rawTarget + ext) ||
			committedPaths.has(rawTarget),
		);
		if (inCommitted) {
			return { action: 'repair', mode: RepairMode.REWIRE_IMPORTS };
		}

		const inPlanned = RESOLVE_EXTS.some(ext =>
			plannedPaths.has(normalizedTarget + ext) ||
			plannedPaths.has(rawTarget + ext) ||
			plannedPaths.has(rawTarget),
		);
		if (inPlanned) {
			// File is planned but not yet generated — wait, don't repair
			return { action: 'skip_planned', reason: `"${rawTarget}" is planned but not yet generated` };
		}

		// Target not in plan and not committed — planner authority applies
		// Suggest the path but do NOT generate
		return { action: 'planner_expansion', suggestedPath: rawTarget };
	}

	// For all other issue kinds, use standard RepairMode classification
	return { action: 'repair', mode: classifyRepairMode(issue.kind, issue.message) };
}

// ---------------------------------------------------------------------------
// Single-issue repair prompt builder
// ---------------------------------------------------------------------------

function buildSingleIssueRepairPrompt(job: RepairJob): string {
	const { issue, targetFile, mode, depContext } = job;
	const lines: string[] = ['<repair_instructions>'];

	// Current file content
	lines.push(
		'## File to Repair',
		`Path: ${targetFile.path}`,
		'',
		'```',
		targetFile.content,
		'```',
		'',
	);

	// Dependency context (committed files this file imports from)
	if (depContext.length > 0) {
		lines.push('## Available Dependencies (DO NOT re-generate these)');
		for (const ctx of depContext) lines.push(ctx);
		lines.push('');
	}

	// The single issue
	lines.push(
		'## Issue to Fix (FIX ONLY THIS ISSUE)',
		`Kind:     ${issue.kind}`,
		`Severity: ${issue.severity}`,
		`Message:  ${issue.message}`,
		'',
	);

	// Mode-specific instruction
	lines.push('## Repair Instruction');
	switch (mode) {
		case RepairMode.MODIFY_EXISTING:
			lines.push(`MODIFY: Rewrite \`${targetFile.path}\` to fix the issue above.`);
			lines.push('Do NOT create new files. Do NOT change unrelated code.');
			break;
		case RepairMode.GENERATE_MISSING:
			lines.push(`GENERATE: The issue requires a missing file or missing implementation.`);
			lines.push(`Create only what is needed. Output using <file path="...">...</file> format.`);
			break;
		case RepairMode.REWIRE_IMPORTS:
			lines.push(`REWIRE: Fix the import path(s) in \`${targetFile.path}\`.`);
			lines.push('Do not restructure logic. Only fix the import statements.');
			break;
		case RepairMode.DELETE_DUPLICATES:
			lines.push(`CONSOLIDATE: Remove the duplicate or out-of-scope code.`);
			lines.push('Reuse existing modules. Do NOT create a parallel implementation.');
			break;
		case RepairMode.SECURITY_FIX:
			lines.push(`SECURITY: Patch the security issue in \`${targetFile.path}\`.`);
			lines.push('Minimal change. Do not restructure.');
			break;
		case RepairMode.COMPILE_FIX:
			lines.push(`COMPILE FIX: Fix the TypeScript type error in \`${targetFile.path}\`.`);
			lines.push('Do not restructure logic. Only fix type annotations.');
			break;
	}

	lines.push(
		'',
		'## Output Rules',
		`  1. Output ONLY the repaired file using <file path="${targetFile.path}">...</file>.`,
		'  2. Output the complete file — no truncation.',
		'  3. Do NOT output any other files.',
		'  4. Do NOT add prose explanations inside the file block.',
		'</repair_instructions>',
		'',
		'Output the repaired file now.',
	);

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// File block extractor (re-use pattern from index.ts)
// ---------------------------------------------------------------------------

function extractSingleFileBlock(text: string): GeneratedFile | null {
	const openTagRegex = /<file\s+path=["']([^"']+)["']\s*>/i;
	const match = openTagRegex.exec(text);
	if (!match) return null;

	const filePath  = match[1]!.trim();
	const afterTag  = text.indexOf(match[0]) + match[0].length;
	const closeIdx  = text.indexOf('</file>', afterTag);
	const content   = closeIdx >= 0
		? text.substring(afterTag, closeIdx).trim()
		: text.substring(afterTag).trim();

	if (!content || content.length < 10) return null;
	return { path: filePath, content };
}

// ---------------------------------------------------------------------------
// Streaming repair helper
// ---------------------------------------------------------------------------

async function promptForRepair(
	session: LlamaChatSession,
	prompt: string,
	maxTokens: number,
	signal: AbortSignal,
): Promise<string> {
	let raw = '';
	await session.prompt(prompt, {
		maxTokens,
		signal,
		stopOnAbortSignal: true,
		onTextChunk(chunk) { raw += chunk; },
	});
	return raw;
}

// ---------------------------------------------------------------------------
// Main repair runner
// ---------------------------------------------------------------------------

/**
 * Run repair jobs for a single FileNode's issues, one issue at a time.
 *
 * @param issues       Validation issues for targetFile.
 * @param targetFile   The file that needs repair.
 * @param depContext   Content strings of committed dependency files.
 * @param session      Active LlamaChatSession for the BE specialist.
 * @param maxTokens    Per-repair max tokens.
 * @param signal       AbortSignal from the request controller.
 * @param validate     Validator to run on the repaired file (single-file pass).
 * @param budget       Optional RepairBudget — caps repair attempts per issue.
 * @param plannedPaths Optional set of all planned file paths — enables dependency routing.
 * @returns The final repaired file (may still have unresolved warnings) or null on failure.
 */
export async function runRepairLoop(
	issues:         import('./validator.js').ValidationIssue[],
	targetFile:     GeneratedFile,
	depContext:     string[],
	session:        LlamaChatSession,
	maxTokens:      number,
	signal:         AbortSignal,
	validate:       (file: GeneratedFile) => Promise<import('./validator.js').ValidationIssue[]>,
	budget?:        { maxLocalRepairsPerFile: number },
	plannedPaths?:  Set<string>,
	committedPaths?: Set<string>,
): Promise<{ file: GeneratedFile; resolvedCount: number; skippedCount: number }> {
	const maxAttempts = budget?.maxLocalRepairsPerFile ?? 3;

	// Sort: errors first, then warnings. Within each severity, stable order.
	const sorted = [...issues].sort((a, b) => {
		if (a.severity === b.severity) return 0;
		return a.severity === 'error' ? -1 : 1;
	});

	let currentFile   = { ...targetFile };
	let resolvedCount = 0;
	let skippedCount  = 0;

	for (const issue of sorted) {
		if (signal.aborted) break;

		// Skip warnings unless errors are all resolved
		if (issue.severity === 'warning' && resolvedCount < sorted.filter(i => i.severity === 'error').length) {
			skippedCount++;
			continue;
		}

		// ── Dependency-aware decision ─────────────────────────────────────────────────
		if (plannedPaths && committedPaths) {
			const decision = classifyRepairDecision(issue, committedPaths, plannedPaths);
			if (decision.action === 'skip_planned') {
				console.log(`[RepairEngine] skip_planned: ${decision.reason}`);
				skippedCount++;
				continue;
			}
			if (decision.action === 'planner_expansion') {
				console.log(`[RepairEngine] planner_expansion needed for "${decision.suggestedPath}" — skipping (planner authority)`);
				skippedCount++;
				continue;
			}
			if (decision.action === 'queue_dependency') {
				console.log(`[RepairEngine] queue_dependency: ${decision.missingPath}`);
				skippedCount++;
				continue; // engine caller handles re-queuing
			}
		}

		const mode = classifyRepairMode(issue.kind, issue.message);
		const job: RepairJob = {
			issue,
			targetFile: currentFile,
			mode,
			depContext,
			attempt:     0,
			maxAttempts,
		};

		let issueResolved = false;

		for (let attempt = 1; attempt <= job.maxAttempts; attempt++) {
			if (signal.aborted) break;
			job.attempt = attempt;

			console.log(`[RepairEngine] issue=${issue.kind} mode=${mode} attempt=${attempt}/${job.maxAttempts} file=${currentFile.path}`);

			const prompt = buildSingleIssueRepairPrompt(job);
			const raw    = await promptForRepair(session, prompt, maxTokens, signal);
			const repaired = extractSingleFileBlock(raw);

			if (!repaired) {
				console.log(`[RepairEngine] attempt ${attempt}: no <file> block in repair output`);
				continue;
			}

			// Validate the repaired file
			const remainingIssues = await validate(repaired);
			const thisIssueFixed  = !remainingIssues.some(
				ri => ri.kind === issue.kind && ri.message === issue.message,
			);

			if (thisIssueFixed) {
				currentFile   = repaired;
				issueResolved = true;
				resolvedCount++;
				console.log(`[RepairEngine] ✅ resolved: ${issue.kind} in ${currentFile.path}`);
				break;
			} else {
				console.log(`[RepairEngine] attempt ${attempt}: issue not resolved after repair`);
				// Update targetFile with the latest attempt content for next try
				job.targetFile = repaired;
			}
		}

		if (!issueResolved) {
			skippedCount++;
			console.log(`[RepairEngine] ⚠️ gave up on: ${issue.kind} in ${currentFile.path} after ${job.maxAttempts} attempts`);
		}
	}

	return { file: currentFile, resolvedCount, skippedCount };
}

/**
 * Build dep context strings from an array of committed GeneratedFiles.
 * Caps at maxFiles to avoid context overflow.
 */
export function buildDepContext(
	depPaths:       string[],
	committedFiles: Map<string, string>,   // path → content
	maxFiles = 5,
): string[] {
	const ctx: string[] = [];
	for (const depPath of depPaths.slice(0, maxFiles)) {
		const content = committedFiles.get(depPath);
		if (content) {
			ctx.push(`--- Dependency: ${depPath} ---\n${content.substring(0, 3000)}`);
		}
	}
	return ctx;
}
