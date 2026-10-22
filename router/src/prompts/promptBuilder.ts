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
import { detectStackProfile } from '../routing/stackProfile.js';
import type { StackProfile } from '../routing/stackProfile.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function loadPrompt(name: string): string {
	try {
		const promptPath = path.join(import.meta.dirname, '../prompts', `${name}.md`);
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
	/** Stack + hard constraints derived from the user's request. */
	profile?: StackProfile;
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

	// ── Stack profile ────────────────────────────────────────────────────────
	// Derived from the request (single file / vanilla / no libraries / native
	// APIs only). It decides the prompt set, the scaffold, and the validation
	// contract. Without it every request was treated as a React app.
	const profile = ctx.profile ?? detectStackProfile(userMessage, {
		workspaceHasReact: workspaceHasTsx(workspaceRoot),
		packageJson,
	});
	const plainStack = profile.kind === 'vanilla' || profile.kind === 'single-file';

	// ── Empty workspace guard ────────────────────────────────────────────────
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

	// ── 1. Base prompts (stack-aware) ───────────────────────────────────────
	if (plainStack) {
		load('agent-plain', `stack=${profile.kind} — plain HTML/CSS/JS, no framework`);
	} else {
		load('agent', 'always loaded');
		load('typescript', 'always loaded');
	}

	// ── 2. Mode (exactly one) ───────────────────────────────────────────────
	if (mode === 'create') {
		if (plainStack) load('create-mode-plain', 'mode=create (plain stack)');
		else load('create-mode', 'mode=create');
	} else if (mode === 'edit') load('edit-mode', 'mode=edit');
	else load('needs-context-mode', 'mode=needs_context');

	// ── 3. React detection — filesystem-first, keyword-confirmed ────────────
	// Primary: package.json dependency OR .tsx/.jsx files on disk
	// Secondary: keywords (supplement only when no workspace signal)
	const pkgHasReact = pkg.includes('"react"') || pkg.includes('"react-dom"');
	const fsHasTsx = workspaceHasTsx(workspaceRoot);
	const activeIsTsx = activeFile ? ['.tsx', '.jsx'].includes(path.extname(activeFile).toLowerCase()) : false;
	const openFilesTsx = openFiles.some(f => ['.tsx', '.jsx'].includes(path.extname(f).toLowerCase()));
	const isReact = !plainStack && (pkgHasReact || fsHasTsx || activeIsTsx || openFilesTsx
		// keyword fallback only when no workspace present
		|| (!workspaceRoot && (msg.includes('react') || msg.includes('tsx') || msg.includes('jsx'))));

	// ── 4. HTML-only — ONLY when activeFile is .html AND project is NOT React
	const activeExt = activeFile ? path.extname(activeFile).toLowerCase() : '';
	const isHtmlOnly = !isReact && activeExt === '.html';

	// ── 5. Tailwind detection ────────────────────────────────────────────────
	const isTailwind = !plainStack && [
		pkg.includes('tailwindcss'),
		msg.includes('tailwind'),
		workspaceRoot ? fs.existsSync(path.join(workspaceRoot, 'tailwind.config.js')) ||
			fs.existsSync(path.join(workspaceRoot, 'tailwind.config.ts')) : false,
	].some(Boolean);

	// ── 6. Refine detection ──────────────────────────────────────────────────
	const isRefine = [
		pkg.includes('@refinedev/'),
		pkg.includes('@pankod/'),
		msg.includes('refine'),
		msg.includes('dataprovider'),
		msg.includes('authprovider'),
		msg.includes('resource'),
	].some(Boolean);

	// Deterministic load order: react → tailwind → refine → html
	if (plainStack) {
		// Plain stack: never load React/Tailwind/Refine guidance — those prompts
		// push the model into className/JSX/useState and contradict the request.
		skip('react', `stack=${profile.kind} — plain HTML/CSS/JS, no framework requested`);
		skip('tailwind', 'plain stack — no CSS framework');
		skip('refine', 'plain stack — no data framework');
		// html.md / css.md / javascript.md are mutually exclusive ("output only
		// HTML" / "output CSS only" / "return JavaScript only") and a single-file
		// deliverable contains all three at once. Loading them together produces
		// contradictory instructions AND burns ~1.5k tokens of the window.
		// Only the HTML guide is safe, and only when editing an existing .html.
		const editingHtml = mode === 'edit' && activeFile
			&& path.extname(activeFile).toLowerCase() === '.html';
		if (editingHtml) load('html', 'editing an existing .html file');
		else skip('html', 'plain stack — the file contains HTML + CSS + JS together');
		skip('css', 'plain stack — the file contains HTML + CSS + JS together');
		skip('javascript', 'plain stack — the file contains HTML + CSS + JS together');
	} else {
		if (isReact) {
			const reactReason = pkgHasReact ? 'package.json contains react/react-dom'
				: fsHasTsx ? 'workspace contains .tsx/.jsx files'
					: activeIsTsx ? 'active file is .tsx/.jsx'
						: openFilesTsx ? 'open file is .tsx/.jsx'
							: 'keyword (no workspace)';
			load('react', reactReason);
		} else {
			skip('react', 'no react/react-dom in package.json, no .tsx files in workspace');
		}

		if (isTailwind) load('tailwind', 'tailwindcss dependency or tailwind.config.js or keyword');
		else skip('tailwind');

		if (isRefine) load('refine', '@refinedev/* dependency or keyword "refine"');
		else skip('refine');

		// html MUST NOT load for React projects
		if (isHtmlOnly) load('html', 'activeFile is .html and project is NOT React');
		else if (!isReact) skip('html', 'not an HTML-only project');
		else skip('html', 'BLOCKED — React project detected');
	}

	// ── 7. Feature prompts — deterministic keyword maps ──────────────────────
	const FEATURE_KEYWORDS: Record<string, string[]> = {
		forms: ['login', 'register', 'signup', 'form', 'submit', 'validation', 'email', 'password', 'otp', 'zod', 'react-hook-form'],
		api: ['axios', 'fetch', 'api', 'endpoint', 'request', 'mutation', 'query', 'backend', 'auth', 'jwt'],
		routing: ['page', 'dashboard', 'login page', 'navigate', 'route', 'layout', 'protected route'],
		state: ['zustand', 'redux', 'store', 'context', 'provider', 'global state'],
		kanban: ['kanban', 'trello', 'drag and drop', 'dnd'],
		table: ['table', 'grid', 'column', 'pagination', 'datatable'],
		chart: ['chart', 'graph', 'analytics', 'dashboard metrics', 'pie', 'bar', 'line'],
	};

	// Feature prompts are React-flavoured (className, useState, zustand, TanStack
	// Table). For a plain stack only the framework-free variants are loaded.
	const PLAIN_FEATURE_PROMPTS: Record<string, string> = { kanban: 'kanban-plain' };

	for (const [feature, keywords] of Object.entries(FEATURE_KEYWORDS)) {
		const triggerKw = keywords.find(k => msg.includes(k));
		if (!triggerKw) {
			skip(feature);
			continue;
		}
		if (plainStack) {
			const plainPrompt = PLAIN_FEATURE_PROMPTS[feature];
			if (plainPrompt) {
				load(plainPrompt, `keyword: ${triggerKw} (plain stack)`);
				console.log(`[PromptRouter] ${plainPrompt} -> keyword ${triggerKw}`);
			} else {
				skip(feature, 'plain stack — React-specific feature guide');
			}
			continue;
		}
		load(feature, `keyword: ${triggerKw}`);
		console.log(`[PromptRouter] ${feature} -> keyword ${triggerKw}`);
	}

	// ── 8. Response validator ────────────────────────────────────────────────
	// Inject a lightweight validator instruction when React project detected.
	// Model must verify all imports/refs resolve before final output.
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

	// ── 9. Workspace Dependency Constraints ──────────────────────────────────
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

	if (plainStack) {
		parts.push([
			'',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'NO-DEPENDENCY RULES (plain HTML / CSS / JS)',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'CRITICAL BOUNDARIES:',
			'1. Do NOT import anything. No `import`, no `require`, no ES module specifiers.',
			'2. Do NOT add a `<script src="https://cdn...">` or an external `<link>` stylesheet.',
			'3. Do NOT create package.json / node_modules / a bundler config.',
			'4. All logic lives in ONE inline <script> block; all styles in ONE inline <style> block.',
			'5. Use only browser built-ins: document, window, localStorage, matchMedia,',
			'   fetch, setTimeout, requestAnimationFrame, DragEvent, KeyboardEvent, Event.',
			'6. If a UI affordance is needed (icons, toasts, modals) implement it with',
			'   plain elements + CSS — never reference an icon font or an icon package.',
		].join('\n'));
	} else if (installedPkgs.length > 0) {
		parts.push([
			'',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'WORKSPACE DEPENDENCY CONSTRAINTS (package.json)',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			`Installed packages: ${installedPkgs.join(', ')}`,
			'CRITICAL BOUNDARIES:',
			'1. ONLY import third-party packages from the installed list above, or standard React ("react", "react/jsx-runtime").',
			'2. NEVER import uninstalled packages (e.g. recharts, react-hook-form, zod, formik, axios, framer-motion) unless explicitly listed above.',
			'3. ICONS: ONLY import icons from "lucide-react" using named imports (e.g. import { Send, Plus, X, Settings, LayoutDashboard, Bot, Building2, UserPlus } from "lucide-react";). NEVER use undeclared identifiers like IconSend or IconX.',
			'4. IMPORTS: If src/App.tsx renders <MessageInput /> or <LeftSidebar />, it MUST explicitly import them: import { MessageInput } from "./components/MessageInput";.',
			'5. HOOKS: ALWAYS import hooks: import React, { useState, useEffect } from "react";. NEVER call useState after an early return or if condition.',
			'6. STATE: Use dynamic useState arrays for messages and lists. NEVER hardcode static arrays. Wire send and new chat buttons to mutate state.',
			'7. NO PHANTOM WRAPPERS: NEVER emit an App.tsx that only renders a wrapper like <MainView /> or <DashboardView /> unless you output that exact component. App.tsx must directly import and assemble the requested subcomponents.',
			'8. NO FAKE UTILITIES: NEVER import from "@/utils/..." or "@/lib/..." (e.g. "@/utils/currency"). If you need helper functions like formatCurrency, formatPrice, or formatDate, write them directly inside the component file or output the utility file.',
			'9. NEVER output "use client"; (this is a Vite React SPA, not Next.js).',
		].join('\n'));
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

	// ── 10. Scope-Adaptive Architecture Rules ────────────────────────────────
	const asksForSingleFile = !plainStack
		&& /keep all state in src\/app\.tsx|single page|single file|simple|widget/i.test(userMessage);
	if (plainStack) {
		parts.push([
			'',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'PLAIN STACK ARCHITECTURE RULES',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'1. ONE ARTIFACT: the deliverable is a single HTML document with inline <style> and inline <script>.',
			'2. NO FRAMEWORK: no React, no JSX, no TypeScript, no className, no useState, no import/export.',
			'3. NO BUILD: the file must work when opened directly (file://) — no bundler, no dev server.',
			'4. SEMANTIC MARKUP: real elements (section, ul/li, button, form), not a div soup.',
			'5. EVERY ID YOU QUERY MUST EXIST in your own markup — no dead getElementById targets.',
			'6. EVERY HANDLER MUST BE WIRED — a button without a listener is a defect.',
			'7. DEFINE BEFORE USE: every function and const must be declared before it is used at runtime.',
			'8. NO PLACEHOLDERS: no TODO, no "implementation goes here", no empty handlers.',
		].join('\n'));
	} else if (asksForSingleFile) {
		parts.push([
			'',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'COMPONENT ARCHITECTURE (SINGLE-FILE HUB RULE)',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'For this application, implement the entire solution self-contained inside `src/App.tsx`.',
			'1. Declare all TypeScript interfaces directly inside `src/App.tsx`.',
			'2. Declare all state variables and action handlers (add, delete, toggle, filter) using native React useState.',
			'3. Helper subcomponents may be defined in the same file `src/App.tsx`.',
			'4. Do NOT generate separate files in `src/components/` unless modular separation is explicitly demanded.',
			'5. Every button MUST have an active onClick handler; every form MUST have an active onSubmit handler.',
			'6. Ensure 100% of the user requirements are fully implemented with real state logic.',
		].join('\n'));
	} else {
		parts.push([
			'',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'MODULAR ARCHITECTURE & STRICT CLOSURE RULES',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'1. 100% IMPORT CLOSURE: If you write `import Foo from "./components/Foo"`, you MUST generate `<file path="src/components/Foo.tsx">` in this exact same response.',
			'2. PROP ALIGNMENT: Child components must accept typed props matching what the parent passes. Container components (lists, grids) MUST map over array props (`items.map(...)`).',
			'3. ZERO ORPHANS: Every file emitted in `src/components/` MUST be imported and rendered in the component tree.',
			'4. FILENAME PARITY: The exported component name MUST match the filename (e.g. `src/components/HabitCard.tsx` exports `export function HabitCard`).',
			'5. FULL REQUIREMENT COVERAGE: Every requirement requested by the user must be implemented with real interactive state and handlers.',
			'6. NO PHANTOM WRAPPERS: src/App.tsx MUST be the real main view holding application state (useState), layouts, navigation/sidebar, and child views. NEVER output a tiny 5-10 line wrapper that delegates to an ungenerated <MainView /> or <DashboardView />. Either compose the modular components inside src/App.tsx, or if you extract a container component, you MUST emit that component in <file path="...">.',
		].join('\n'));
	}

	// ── 11. HARD CONSTRAINTS (from the detected stack) ───────────────────────
	// Injected LAST on purpose: it is the most recent instruction the model
	// sees, so it wins over any generic guidance loaded above.
	if (profile.constraints.length > 0) {
		parts.push([
			'',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'HARD CONSTRAINTS — THE USER EXPLICITLY REQUESTED THIS (NON-NEGOTIABLE)',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			...profile.constraints,
			'VIOLATING ANY OF THE ABOVE MAKES THE ANSWER WRONG.',
		].join('\n'));
		console.log(`[PromptRouter] Hard constraints injected (${profile.constraints.length})`);
	}

	// ── Debug log ────────────────────────────────────────────────────────────
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

	let installedPkgs: string[] = [];
	if (workspaceRoot) {
		const pkgPath = path.join(workspaceRoot, 'package.json');
		try {
			if (fs.existsSync(pkgPath)) {
				const raw = fs.readFileSync(pkgPath, 'utf-8');
				const parsed = JSON.parse(raw);
				const deps = Object.keys(parsed.dependencies || {});
				const devDeps = Object.keys(parsed.devDependencies || {});
				installedPkgs = Array.from(new Set([...deps, ...devDeps]));
			}
		} catch { /* ignore */ }
	}

	const hasPkg = (name: string) => installedPkgs.includes(name);

	const ext = activeFile ? path.extname(activeFile).toLowerCase() : '';
	if (ext === '.ts' || ext === '.js' || msg.includes('typescript') || msg.includes('express') || msg.includes('node') || mode === 'create') {
		if (ext === '.js' || msg.includes('javascript')) addBE('javascript');
		else addBE('typescript');
		addBE('node');
	}

	// Express & REST are standard for backend APIs
	const isExpress = hasPkg('express') || msg.includes('express') || mode === 'create';
	if (isExpress) addBE('express');
	addBE('rest');

	// Database vs In-Memory DB
	const hasSqlOrOrm = [
		hasPkg('pg'), hasPkg('mysql'), hasPkg('mysql2'), hasPkg('sqlite3'),
		hasPkg('prisma'), hasPkg('@prisma/client'), hasPkg('typeorm'), hasPkg('mongoose')
	].some(Boolean);

	if (hasSqlOrOrm || msg.includes('sql') || msg.includes('database') || msg.includes('postgres') || msg.includes('mysql')) {
		addBE('sql');
	} else {
		addBE('in-memory-db');
	}

	// Domain skills & capabilities
	const DOMAIN_SKILLS: Record<string, string[]> = {
		'ecommerce': ['product', 'shop', 'store', 'cart', 'checkout', 'catalog', 'clothing', 'fashion', 'price', 'order', 'e-commerce', 'ecommerce'],
		'saas-dashboard': ['dashboard', 'metrics', 'billing', 'analytics', 'invoice', 'subscription', 'saas', 'revenue', 'transaction'],
		'capabilities/validation': ['validate', 'validation', 'schema', 'input', 'form'],
		'capabilities/error-handling': ['error', 'exception', 'handler'],
		'capabilities/controller-pattern': ['controller', 'mvc', 'repository', 'clean', 'backend', 'api'],
		'capabilities/service-pattern': ['service', 'repository', 'clean', 'backend', 'api'],
		'capabilities/jwt': ['jwt', 'token', 'auth', 'login', 'bearer'],
		'capabilities/pagination': ['paginate', 'pagination', 'page', 'limit', 'offset'],
	};

	for (const [skill, keywords] of Object.entries(DOMAIN_SKILLS)) {
		const matched = keywords.some(kw => msg.includes(kw));
		if (matched || (mode === 'create' && (skill.includes('error-handling') || skill.includes('controller-pattern') || skill.includes('service-pattern')))) {
			addBE(skill);
		}
	}

	if (mode === 'create') addBE('create-mode');
	else if (mode === 'edit') addBE('edit-mode');
	else addBE('needs-context-mode');

	// Inject workspace dependency constraints
	if (installedPkgs.length > 0) {
		parts.push([
			'',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'WORKSPACE DEPENDENCY CONSTRAINTS (package.json)',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			`Installed packages: ${installedPkgs.join(', ')}`,
			'CRITICAL BOUNDARIES:',
			'1. ONLY import third-party packages from the installed list above, or standard Node.js built-ins ("http", "path", "fs", "crypto").',
			'2. NEVER import uninstalled packages (such as mongoose, prisma, typeorm, bcrypt, jsonwebtoken, zod, axios, express-validator) unless explicitly listed above.',
			'3. NO PHANTOM UTILITIES: NEVER import from non-existent files like "../utils/logger", "../utils/validators", "../utils/errors", or "../models/database". If helper functions are needed, declare them locally in the file or in shared models/types.',
			'4. SERVER ARCHITECTURE: "src/app.ts" configures middleware and mounts routes, exporting app (export default app;). "src/server.ts" imports app and calls app.listen(PORT). NEVER call app.listen() inside "src/app.ts".',
			'5. IN-MEMORY STORAGE: If no database package (mongoose/prisma/pg) is installed, store data using an in-memory Map or Array in the service with initial mock data.',
		].join('\n'));
	} else {
		parts.push([
			'',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'WORKSPACE DEPENDENCY CONSTRAINTS',
			'━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
			'CRITICAL BOUNDARIES:',
			'1. ONLY import standard Express and Node.js built-ins ("http", "path", "fs", "crypto").',
			'2. NEVER import uninstalled packages (such as mongoose, prisma, bcrypt, jsonwebtoken, zod).',
			'3. NO PHANTOM UTILITIES: Never import from "../utils/..." unless that file already exists on disk. Declare helper functions locally.',
			'4. SERVER ARCHITECTURE: "src/app.ts" exports app; "src/server.ts" calls app.listen(PORT). Never call app.listen() in both.',
			'5. IN-MEMORY STORAGE: Use an in-memory Map or Array with sample seed data for data persistence.',
		].join('\n'));
	}

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
	profile?: StackProfile,
): string {
	if (!hasWorkspace) {
		const role = currentSpecialist === 'be' ? 'backend engineering' : 'frontend development';
		return `You are CodeCrab Assistant. You specialize in ${role}.`;
	}

	let prompt = '';
	if (currentSpecialist === 'fe') {
		prompt = buildFESystemPrompt({
			userMessage, mode, activeFile, workspaceRoot, packageJson, openFiles,
			...(profile ? { profile } : {}),
		});
	} else {
		prompt = buildBESystemPrompt(userMessage, mode, activeFile, workspaceRoot);
	}

	if (readWriteMode === 'read') {
		prompt += `\n\nCRITICAL OVERRIDE:\nThis is a READ-ONLY request. Ignore previous instructions about outputting <file> blocks and avoiding explanations.\nYou MUST answer the user's question, provide code audits, explanations, or summaries as requested.\nUse standard markdown for your response. Provide clear explanations. DO NOT attempt to write or modify files using <file> blocks.`;
	}

	return prompt;
}
