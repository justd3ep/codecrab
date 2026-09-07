/**
 * promptBuilder.ts — System prompt construction for BE and FE specialists.
 *
 * Extracted from index.ts (lines 729–1573 original, step 6).
 * Depends on: fs, path, AgentMode, gitHarness.
 * No HTTP, no model calls.
 */

import path from 'path';
import fs from 'fs';
import type { AgentMode } from '../routing/agentMode.js';
import { getGitLogSummarySync } from '../gitHarness.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function loadPrompt(name: string): string {
	try {
		const promptPath = path.join(import.meta.dirname, '../../prompts', `${name}.md`);
		return fs.readFileSync(promptPath, 'utf-8').trim();
	} catch (e) {
		console.warn(`[Router] Warning: Could not load prompt ${name}.md`);
		return '';
	}
}

// ---------------------------------------------------------------------------
// Routing failure logger — Stage 7 dataset collection
// ---------------------------------------------------------------------------

let _failureLogPath = '';
export function setFailureLogPath(p: string) { _failureLogPath = p; }

export function logRoutingFailure(prompt: string, predicted: string, expected: string): void {
	if (!_failureLogPath) return;
	try {
		const dir = path.dirname(_failureLogPath);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const entry = JSON.stringify({ prompt, predicted, expected, ts: new Date().toISOString() });
		fs.appendFileSync(_failureLogPath, entry + '\n');
		console.log(`[Router] Failure logged: ${predicted} → expected ${expected}`);
	} catch (e: any) {
		console.warn('[Router] Failed to write routing failure log:', e.message);
	}
}

// ---------------------------------------------------------------------------
// FE Prompt Router context
// ---------------------------------------------------------------------------

export interface PromptRouterContext {
	userMessage: string;
	mode: AgentMode;
	activeFile: string | undefined;
	workspaceRoot: string | undefined;
	/** Raw content of package.json, if available */
	packageJson: string | undefined;
	openFiles: string[] | undefined;
}

// ---------------------------------------------------------------------------
// React workspace scanner
// ---------------------------------------------------------------------------

export function workspaceHasTsx(workspaceRoot: string | undefined): boolean {
	if (!workspaceRoot) return false;
	const srcDir = path.join(workspaceRoot, 'src');
	const dirsToScan = [workspaceRoot, ...(fs.existsSync(srcDir) ? [srcDir] : [])];
	for (const dir of dirsToScan) {
		try {
			const entries = fs.readdirSync(dir);
			if (entries.some(f => f.endsWith('.tsx') || f.endsWith('.jsx'))) return true;
		} catch { /* ignore unreadable dirs */ }
	}
	return false;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Directory tree — imported from toolEngine and re-exported
// ---------------------------------------------------------------------------
import { buildDirectoryTree } from '../tools/toolEngine.js';
export { buildDirectoryTree };

// ---------------------------------------------------------------------------
// Phase 2 harness — injects progress / features / AGENTS.md / git log
// ---------------------------------------------------------------------------

export function injectPhase2Harness(workspaceRoot: string | undefined): string[] {
	if (!workspaceRoot) return [];
	const notes: string[] = [];

	notes.push([
		'',
		'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
		'AGENT BEARINGS (WORKING DIRECTORY)',
		'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
		`Directory: ${workspaceRoot}`,
		'Rule: All file operations are strictly scoped to this workspace.',
	].join('\n'));

	const progressFile = path.join(workspaceRoot, 'progress.txt');
	if (fs.existsSync(progressFile)) {
		try {
			const progressContent = fs.readFileSync(progressFile, 'utf-8').trim();
			if (progressContent) {
				notes.push([
					'',
					'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
					'PROJECT CONTEXT & RECENT WORK (progress.txt)',
					'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
					progressContent,
				].join('\n'));
				console.log('[PromptRouter] Injected progress.txt into prompt context');
			}
		} catch { /* ignore unreadable */ }
	}

	const featuresFile = path.join(workspaceRoot, 'features.json');
	if (fs.existsSync(featuresFile)) {
		try {
			const raw = fs.readFileSync(featuresFile, 'utf-8');
			const features = JSON.parse(raw);
			if (Array.isArray(features)) {
				const pending = features.filter((f: any) => !f.passes);
				const completed = features.length - pending.length;
				const nextFeature = pending[0];
				notes.push([
					'',
					'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
					'FEATURE CHECKLIST STATUS (features.json)',
					'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
					`Progress: ${completed}/${features.length} features completed (${pending.length} remaining).`,
					nextFeature ? `NEXT TARGET FEATURE: ${nextFeature.description} (Category: ${nextFeature.category})` : 'All features marked passing!',
					'INSTRUCTION: Focus ONLY on implementing this next target feature. Do not attempt to one-shot other features.',
					'Update features.json to set "passes": true for this feature, and append your changes to progress.txt.',
				].join('\n'));
				console.log(`[PromptRouter] Injected features.json: ${completed}/${features.length} done`);
			}
		} catch { /* ignore invalid json */ }
	}

	const agentsFile = path.join(workspaceRoot, 'AGENTS.md');
	if (fs.existsSync(agentsFile)) {
		try {
			const content = fs.readFileSync(agentsFile, 'utf-8').trim();
			if (content) {
				notes.push([
					'',
					'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
					'AGENT OPERATING RULES (AGENTS.md)',
					'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
					content,
				].join('\n'));
				console.log('[PromptRouter] Injected AGENTS.md into prompt context');
			}
		} catch { /* ignore */ }
	}

	const archFile = path.join(workspaceRoot, 'ARCHITECTURE.md');
	if (fs.existsSync(archFile)) {
		try {
			const content = fs.readFileSync(archFile, 'utf-8').trim();
			if (content) {
				notes.push([
					'',
					'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
					'SYSTEM ARCHITECTURE (ARCHITECTURE.md)',
					'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
					content,
				].join('\n'));
				console.log('[PromptRouter] Injected ARCHITECTURE.md into prompt context');
			}
		} catch { /* ignore */ }
	}

	const activePlanDir = path.join(workspaceRoot, 'docs', 'exec-plans', 'active');
	if (fs.existsSync(activePlanDir)) {
		try {
			const planFiles = fs.readdirSync(activePlanDir).filter(f => f.endsWith('.md'));
			const planFile = planFiles[0];
			if (planFile) {
				const planContent = fs.readFileSync(path.join(activePlanDir, planFile), 'utf-8').trim();
				notes.push([
					'',
					'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
					`ACTIVE EXECUTION PLAN (docs/exec-plans/active/${planFile})`,
					'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
					planContent,
				].join('\n'));
				console.log(`[PromptRouter] Injected active execution plan: ${planFile}`);
			}
		} catch { /* ignore */ }
	}

	const gitLog = getGitLogSummarySync(workspaceRoot, 5);
	if (gitLog) {
		notes.push([
			'',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'RECENT GIT COMMITS (git log)',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			gitLog,
		].join('\n'));
		console.log('[PromptRouter] Injected git log into prompt context');
	}

	return notes;
}

// ---------------------------------------------------------------------------
// FE System Prompt Builder
// ---------------------------------------------------------------------------

export function buildFESystemPrompt(ctx: PromptRouterContext): string {
	const { userMessage, mode, activeFile, workspaceRoot, packageJson = '', openFiles = [] } = ctx;
	const msg = userMessage.toLowerCase();
	const pkg = packageJson.toLowerCase();
	const parts: string[] = [];
	const loaded: Array<{ name: string; reason: string }> = [];
	const skipped: string[] = [];

	if (workspaceRoot) {
		const tree = buildDirectoryTree(workspaceRoot);
		const fileCount = tree.split('\n').filter(l => l.trim() && !l.includes('/')).length;
		if (fileCount === 0) {
			console.log('[PromptRouter] workspace empty — artifact boost disabled, forced files skipped.');
		}
	}

	const load = (name: string, reason: string) => {
		const content = loadPrompt(`fe/${name}`);
		if (content) {
			parts.push(content);
			loaded.push({ name: `fe/${name}`, reason });
		} else {
			console.warn(`[PromptRouter] WARN: fe/${name}.md not found`);
		}
	};
	const skip = (name: string, reason?: string) => {
		skipped.push(`fe/${name}`);
		if (reason) console.log(`[PromptRouter] SKIP fe/${name}: ${reason}`);
	};

	load('agent', 'always loaded');
	load('typescript', 'always loaded');

	if (mode === 'create') load('create-mode', 'mode=create');
	else if (mode === 'edit') load('edit-mode', 'mode=edit');
	else load('needs-context-mode', 'mode=needs_context');

	const pkgHasReact = pkg.includes('"react"') || pkg.includes('"react-dom"');
	const fsHasTsx = workspaceHasTsx(workspaceRoot);
	const activeIsTsx = activeFile ? ['.tsx', '.jsx'].includes(path.extname(activeFile).toLowerCase()) : false;
	const openFilesTsx = openFiles.some(f => ['.tsx', '.jsx'].includes(path.extname(f).toLowerCase()));
	const hasReactKeywords = /react|tsx|jsx|kanban|trello|dashboard|frontend|component|tailwind|vite/.test(msg);
	const isReact = pkgHasReact || fsHasTsx || activeIsTsx || openFilesTsx || hasReactKeywords || mode === 'create';

	const activeExt = activeFile ? path.extname(activeFile).toLowerCase() : '';
	const isHtmlOnly = !isReact && activeExt === '.html';

	const isTailwind = [
		pkg.includes('tailwindcss'),
		msg.includes('tailwind'),
		workspaceRoot ? fs.existsSync(path.join(workspaceRoot, 'tailwind.config.js')) ||
			fs.existsSync(path.join(workspaceRoot, 'tailwind.config.ts')) : false,
	].some(Boolean);

	const isRefine = [
		pkg.includes('@refinedev/'),
		pkg.includes('@pankod/'),
		msg.includes('refine'),
		msg.includes('dataprovider'),
		msg.includes('authprovider'),
		msg.includes('resource'),
	].some(Boolean);

	if (isReact) {
		const reactReason = pkgHasReact ? 'package.json contains react/react-dom'
			: fsHasTsx ? 'workspace contains .tsx/.jsx files'
				: activeIsTsx ? 'active file is .tsx/.jsx'
					: openFilesTsx ? 'open file is .tsx/.jsx'
						: hasReactKeywords ? 'frontend keyword match'
							: 'default create mode stack';
		load('react', reactReason);
	} else {
		skip('react', 'no react/react-dom in package.json, no .tsx files in workspace');
	}

	if (isTailwind) load('tailwind', 'tailwindcss dependency or tailwind.config.js or keyword');
	else skip('tailwind');

	if (isRefine) load('refine', '@refinedev/* dependency or keyword "refine"');
	else skip('refine');

	if (isHtmlOnly) load('html', 'activeFile is .html and project is NOT React');
	else if (!isReact) skip('html', 'not an HTML-only project');
	else skip('html', 'BLOCKED — React project detected');

	const FEATURE_KEYWORDS: Record<string, string[]> = {
		forms: ['login', 'register', 'signup', 'form', 'submit', 'validation', 'email', 'password', 'otp', 'zod', 'react-hook-form'],
		api: ['axios', 'fetch', 'api', 'endpoint', 'request', 'mutation', 'query', 'backend', 'auth', 'jwt'],
		routing: ['page', 'dashboard', 'login page', 'navigate', 'route', 'layout', 'protected route'],
		state: ['zustand', 'redux', 'store', 'context', 'provider', 'global state', 'kanban', 'trello', 'board', 'drag', 'drop', 'dnd', 'task', 'cards'],
		table: ['table', 'datatable', 'spreadsheet', 'data table'],
		chart: ['chart', 'graph', 'analytics', 'dashboard metrics', 'pie', 'bar', 'line'],
	};

	for (const [feature, keywords] of Object.entries(FEATURE_KEYWORDS)) {
		const triggerKw = keywords.find(k => msg.includes(k));
		if (triggerKw) {
			load(feature, `keyword: ${triggerKw}`);
			console.log(`[PromptRouter] ${feature} -> keyword ${triggerKw}`);
		} else {
			skip(feature);
		}
	}

	if (isReact && workspaceRoot) {
		const validatorNote = [
			'',
			'[Validator] Pre-output checklist:',
			'  For every import, script src, route, stylesheet, component, and asset reference:',
			'  verify the target file exists either in this response OR already in workspace.',
			'  If any reference is missing → add the missing file to this response.',
			'  Log: [Validator] missing <file> / [Validator] repairing',
		].join('\n');
		parts.push(validatorNote);
		console.log('[PromptRouter] Validator instruction injected (React project)');
	}

	const phase2Notes = injectPhase2Harness(workspaceRoot);
	if (phase2Notes.length > 0) parts.push(...phase2Notes);

	let installedPkgs: string[] = [];
	let rawPkg = packageJson;
	if (!rawPkg && workspaceRoot) {
		const pkgPath = path.join(workspaceRoot, 'package.json');
		try {
			if (fs.existsSync(pkgPath)) rawPkg = fs.readFileSync(pkgPath, 'utf-8');
		} catch { /* ignore */ }
	}
	if (rawPkg) {
		try {
			const parsed = JSON.parse(rawPkg);
			const deps = Object.keys(parsed.dependencies || {});
			const devDeps = Object.keys(parsed.devDependencies || {});
			installedPkgs = Array.from(new Set([...deps, ...devDeps]));
		} catch { /* ignore */ }
	}

	if (installedPkgs.length > 0) {
		parts.push([
			'',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'WORKSPACE DEPENDENCY CONSTRAINTS (package.json)',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			`Installed packages: ${installedPkgs.join(', ')}`,
			'CRITICAL BOUNDARIES:',
			'1. ONLY import third-party packages from the installed list above, or standard React ("react", "react/jsx-runtime").',
			'2. NEVER import uninstalled packages (e.g. recharts, react-hook-form, zod, formik, axios, framer-motion) unless explicitly listed above.',
			'3. For forms: Use standard React useState with controlled inputs unless react-hook-form is listed above.',
			'4. For charts/metrics: Use clean SVG or Tailwind CSS elements unless recharts is listed above.',
			'5. NEVER output "use client"; (this is a Vite React SPA, not Next.js).',
		].join('\n'));
		console.log(`[PromptRouter] Injected ${installedPkgs.length} installed package constraints into FE system prompt.`);
	} else {
		parts.push([
			'',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'WORKSPACE DEPENDENCY CONSTRAINTS',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'No external third-party dependencies detected.',
			'CRITICAL BOUNDARIES:',
			'1. ONLY import standard React ("react") or local relative files ("./...").',
			'2. NEVER import third-party packages (e.g. recharts, react-hook-form, zod, axios, framer-motion).',
			'3. Implement all UI, forms, and charts using standard React useState and Tailwind CSS.',
			'4. NEVER output "use client"; (this is a Vite React SPA, not Next.js).',
		].join('\n'));
	}

	console.log('\nPROMPTS LOADED:');
	console.log(JSON.stringify(loaded.map(l => l.name), null, 2));
	console.log('\nPROMPTS SKIPPED:');
	console.log(JSON.stringify(skipped, null, 2));
	for (const l of loaded) {
		console.log(`[PromptRouter] ${l.name.replace('fe/', '')} ← ${l.reason}`);
	}

	return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// BE System Prompt Builder
// ---------------------------------------------------------------------------

export function buildBESystemPrompt(
	userMessage: string,
	mode: AgentMode,
	activeFile?: string,
	workspaceRoot?: string,
): string {
	const parts: string[] = [];
	const activePrompts: string[] = [];
	const msg = userMessage.toLowerCase();

	const addBE = (name: string) => {
		const content = loadPrompt(`be/${name}`);
		if (content) { parts.push(content); activePrompts.push(`be/${name}`); }
		else console.warn(`[Router] Warning: Could not load prompt be/${name}.md`);
	};

	addBE('agent');

	const ext = activeFile ? path.extname(activeFile).toLowerCase() : '';
	if (ext === '.ts' || ext === '.js' || msg.includes('typescript') || msg.includes('express') || msg.includes('node')) {
		if (ext === '.js' || msg.includes('javascript')) addBE('javascript');
		else addBE('typescript');
		addBE('node');
	}
	if (msg.includes('express')) addBE('express');
	if (msg.includes('sql') || msg.includes('database') || msg.includes('postgres') || msg.includes('mysql')) addBE('sql');

	if (mode === 'create') addBE('create-mode');
	else if (mode === 'edit') addBE('edit-mode');
	else addBE('needs-context-mode');

	const phase2Notes = injectPhase2Harness(workspaceRoot);
	if (phase2Notes.length > 0) parts.push(...phase2Notes);

	console.log('PROMPTS LOADED (BE):', JSON.stringify(activePrompts, null, 2));
	return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Unified System Prompt Builder
// ---------------------------------------------------------------------------

export function buildSystemPrompt(
	userMessage: string,
	hasWorkspace: boolean,
	mode: AgentMode,
	currentSpecialist: 'be' | 'fe',
	activeFile?: string,
	workspaceRoot?: string,
	packageJson?: string,
	openFiles?: string[],
	readWriteMode?: 'read' | 'write',
): string {
	if (!hasWorkspace) {
		const role = currentSpecialist === 'be' ? 'backend engineering' : 'frontend development';
		return `You are CodeCrab Assistant. You specialize in ${role}.`;
	}

	let prompt = '';
	if (currentSpecialist === 'fe') {
		prompt = buildFESystemPrompt({ userMessage, mode, activeFile, workspaceRoot, packageJson, openFiles });
	} else {
		prompt = buildBESystemPrompt(userMessage, mode, activeFile, workspaceRoot);
	}

	if (readWriteMode === 'read') {
		prompt += `\n\nCRITICAL OVERRIDE:\nThis is a READ-ONLY request. Ignore previous instructions about outputting <file> blocks and avoiding explanations.\nYou MUST answer the user's question, provide code audits, explanations, or summaries as requested.\nUse standard markdown for your response. Provide clear explanations. DO NOT attempt to write or modify files using <file> blocks.`;
	}

	return prompt;
}
