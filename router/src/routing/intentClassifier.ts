/**
 * intentClassifier.ts — Pattern-based semantic intent classification.
 *
 * Extracted from index.ts (lines 498–1021 original, steps 5a).
 * All pattern constants + classify/detect/score helpers + Advisor runner.
 * Depends on: node-llama-cpp (for runAdvisor), config, planner types.
 */

import path from 'path';
import type { LlamaModel } from 'node-llama-cpp';
import type { AdvisorV2Result } from '../planner.js';

// ---------------------------------------------------------------------------
// 1. UI Component / Interaction / Design / Framework Patterns
// ---------------------------------------------------------------------------

export const UI_COMPONENT_PATTERN = /\b(?:board|card|column|view|page|screen|modal|dialog|panel|widget|bar|tab|drawer|menu|carousel|slider|form|table|chart|grid|feed|timeline|sidebar|navbar|header|footer|button|input|dropdown|toast|accordion|avatar|badge|canvas|popup|stepper|breadcrumbs?|tooltip|trello|kanban)s?\b/i;
export const UI_INTERACTION_PATTERN = /\b(?:drag(?:ging)?(?:\s+and\s+drop)?|drop(?:ped)?|click(?:able)?|hover|render(?:ing)?|display(?:ing)?|style(?:d|s)?|animate(?:d|s|ion)?|preview|layout|visualize|toggle|select|filter|sort|reorder|scroll|zoom|paint|color|draw)\b/i;
export const UI_DESIGN_PATTERN = /\b(?:ui|ux|frontend|front-end|gui|theme|dark\s*mode|light\s*mode|responsive|mobile|desktop|css|scss|sass|tailwind|html|svg|icon|palette|typography|look\s+like|clone(?:\s+of)?|style|-style)\b/i;
export const UI_FRAMEWORK_PATTERN = /\b(?:react|vue|svelte|angular|next\.?js|nuxt|vite|tailwind(?:css)?|framer|lucide|shadcn|radix|redux|zustand|tanstack|chakra|material-ui|mui|bootstrap)\b/i;

// ---------------------------------------------------------------------------
// 2. Backend Patterns
// ---------------------------------------------------------------------------

export const BE_DB_PATTERN = /\b(?:sql|postgres(?:ql)?|mysql|sqlite|mongodb?|mongoose|prisma|typeorm|database|db|migration|seed(?:er)?|redis|memcached)\b/i;
export const BE_SERVER_PATTERN = /\b(?:backend|back-end|api|rest(?:ful)?|graphql|endpoint|route|router|controller|service|middleware|repository|server|express|nestjs|fastify|koa|django|flask|spring)\b/i;
export const BE_AUTH_INFRA_PATTERN = /\b(?:jwt|bearer|oauth|bcrypt|hash(?:ing)?|auth(?:entication|orization)?|session|cookie|rbac|queue|bullmq|kafka|rabbitmq|cron|worker|microservice|docker)\b/i;

// ---------------------------------------------------------------------------
// 3. High-level intent helpers
// ---------------------------------------------------------------------------

export function detectFrontendIntent(messages: any[]): boolean {
	if (!messages || messages.length === 0) return false;
	const lastMessage = messages[messages.length - 1]?.content || '';
	return (
		UI_COMPONENT_PATTERN.test(lastMessage) ||
		UI_INTERACTION_PATTERN.test(lastMessage) ||
		UI_DESIGN_PATTERN.test(lastMessage) ||
		UI_FRAMEWORK_PATTERN.test(lastMessage)
	);
}

export function detectBackendIntent(messages: any[]): boolean {
	if (!messages || messages.length === 0) return false;
	const lastMessage = messages[messages.length - 1]?.content || '';
	return (
		BE_DB_PATTERN.test(lastMessage) ||
		BE_SERVER_PATTERN.test(lastMessage) ||
		BE_AUTH_INFRA_PATTERN.test(lastMessage)
	);
}

// ---------------------------------------------------------------------------
// 4. READ vs WRITE intent classifier
// ---------------------------------------------------------------------------

const READ_PATTERNS = [
	/\b(?:explain|summarize|summary|describe|what\s+is|what\s+are|how\s+does|how\s+do|tell\s+me\s+about)\b/i,
	/\b(?:list|show|find|locate|search|where\s+is|where\s+are|which\s+files?)\b/i,
	/\b(?:review|audit|analyse|analyze|inspect|read|look\s+at|check)\b/i,
	/\b(?:architecture|overview|structure|diagram|dependency|dependencies)\b/i,
];

const WRITE_PATTERNS = [
	/\b(?:create|make|generate|add|write|implement|build|scaffold)\b/i,
	/\b(?:modify|edit|update|change|refactor|rename|move|delete|remove)\b/i,
	/\b(?:fix|debug|resolve|patch|correct|repair)\b/i,
	/\b(?:add\s+feature|new\s+file|new\s+component|new\s+route|new\s+endpoint)\b/i,
];

export function classifyIntent(userMessage: string): 'read' | 'write' {
	const msg = userMessage.toLowerCase();
	if (WRITE_PATTERNS.some(p => p.test(msg))) return 'write';
	if (READ_PATTERNS.some(p => p.test(msg))) return 'read';
	return 'write';
}

// ---------------------------------------------------------------------------
// 5. Advisor types + parsers
// ---------------------------------------------------------------------------

export type AdvisorIntent =
	| 'create_fe' | 'edit_fe'
	| 'create_be' | 'edit_be'
	| 'create_fullstack' | 'edit_fullstack'
	| 'general' | 'unknown';

const VALID_INTENTS: AdvisorIntent[] = [
	'create_fe', 'edit_fe', 'create_be', 'edit_be',
	'create_fullstack', 'edit_fullstack', 'general', 'unknown',
];

export function parseAdvisorIntent(raw: string): AdvisorIntent | null {
	const stripped = raw.replace(/```json?\s*/gi, '').replace(/```\s*/g, '').trim();
	const match = stripped.match(/\{[^{}]*\}/);
	if (!match) { console.warn('[Advisor] No JSON found.'); return null; }
	try {
		const obj = JSON.parse(match[0]);
		const intent = obj.intent as string;
		if (!VALID_INTENTS.includes(intent as AdvisorIntent)) {
			console.warn(`[Advisor] Unknown intent value: "${intent}"`);
			return null;
		}
		console.log(`[Advisor] Intent: ${intent}`);
		return intent as AdvisorIntent;
	} catch (e: any) {
		console.error('[Advisor] JSON parse failed:', e.message);
		return null;
	}
}

export function parseAdvisorV2(raw: string): { intent: AdvisorIntent; v2: AdvisorV2Result } | null {
	const stripped = raw.replace(/```json?\s*/gi, '').replace(/```\s*/g, '').trim();
	const match = stripped.match(/\{[\s\S]*\}/);
	if (!match) { console.warn('[AdvisorV2] No JSON found.'); return null; }
	try {
		const obj = JSON.parse(match[0]);
		const intentRaw = obj.intent as string;
		if (!VALID_INTENTS.includes(intentRaw as AdvisorIntent)) {
			console.warn(`[AdvisorV2] Unknown intent: "${intentRaw}"`);
			return null;
		}
		const v2: AdvisorV2Result = {
			intent: intentRaw,
			projectType: obj.projectType,
			architecture: obj.architecture,
			framework: obj.framework,
			language: obj.language,
			database: obj.database,
			orm: obj.orm,
			authentication: obj.authentication,
			requiredFeatures: Array.isArray(obj.requiredFeatures) ? obj.requiredFeatures : undefined,
			modules: Array.isArray(obj.modules) ? obj.modules : undefined,
			estimatedFiles: typeof obj.estimatedFiles === 'number' ? obj.estimatedFiles : undefined,
			generationStrategy: obj.generationStrategy,
			confidence: typeof obj.confidence === 'number' ? obj.confidence : undefined,
		};
		console.log(`[AdvisorV2] intent=${intentRaw} arch=${v2.architecture ?? '?'} modules=[${(v2.modules ?? []).join(',')}] features=[${(v2.requiredFeatures ?? []).join(',')}]`);
		return { intent: intentRaw as AdvisorIntent, v2 };
	} catch (e: any) {
		console.error('[AdvisorV2] JSON parse failed:', e.message);
		return null;
	}
}

// ---------------------------------------------------------------------------
// 6. Advisor runner — needs mm (model manager) injected to avoid circular dep
// ---------------------------------------------------------------------------

/** Run the Advisor model pass (overloads). */
export async function runAdvisor(
	advisorModel: LlamaModel,
	loadPrompt: (name: string) => string,
	userRequest: string,
): Promise<AdvisorIntent | null>;
export async function runAdvisor(
	advisorModel: LlamaModel,
	loadPrompt: (name: string) => string,
	userRequest: string,
	v2: true,
): Promise<{ intent: AdvisorIntent | null; v2Result: AdvisorV2Result | null }>;
export async function runAdvisor(
	advisorModel: LlamaModel,
	loadPrompt: (name: string) => string,
	userRequest: string,
	v2 = false,
): Promise<any> {
	const systemPrompt = loadPrompt('planner');
	if (!systemPrompt) {
		console.warn('[Advisor] planner.md not found, skipping advisor pass.');
		return v2 ? { intent: null, v2Result: null } : null;
	}
	try {
		// 512 ctx: system(~240 tok) + user(~20 tok) + template(~30 tok) + response(~10 tok) = ~300 tok, fits
		const advisorCtx = await advisorModel.createContext({ contextSize: 512 });
		const seq = advisorCtx.getSequence();

		// Build Qwen3 chat template + /no_think to suppress chain-of-thought mode.
		// Pre-filling <think>\n\n</think> forces the model to skip reasoning and output JSON directly.
		const fullPrompt = `<|im_start|>system\n${systemPrompt}<|im_end|>\n<|im_start|>user\n${userRequest} /no_think<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n`;
		const inputTokens = advisorModel.tokenize(fullPrompt);
		console.log(`[Advisor] Input tokens: ${inputTokens.length} / 512`);

		let raw = '';
		const eosToken = advisorModel.tokens.eos;
		for await (const token of seq.evaluate(inputTokens, { temperature: 0 })) {
			const text = advisorModel.detokenize([token]);
			raw += text;
			if (token === eosToken) break;
			const depth = (raw.match(/\{/g) ?? []).length - (raw.match(/\}/g) ?? []).length;
			if (depth <= 0 && raw.includes('{')) break;
			if (raw.length > 600) break;
		}

		console.log('[Advisor] Raw output:', raw.trim().slice(0, 150));
		await advisorCtx.dispose();

		if (v2) {
			const parsed = parseAdvisorV2(raw);
			if (parsed) return { intent: parsed.intent, v2Result: parsed.v2 };
			const intentOnly = parseAdvisorIntent(raw);
			return { intent: intentOnly, v2Result: intentOnly ? { intent: intentOnly } : null };
		}
		return parseAdvisorIntent(raw);
	} catch (e: any) {
		console.error('[Advisor] Failed:', e.message);
		return v2 ? { intent: null, v2Result: null } : null;
	}
}

/** Run lightweight Advisor pass to summarize project state at 75% context cutoff. */
export async function runAdvisorProjectSummary(
	advisorModel: LlamaModel,
	params: {
		userRequest: string;
		filesWritten: string[];
		partialSnippet: string;
	},
): Promise<string> {
	try {
		console.log('[Advisor] Running Project Brain Summary pass for 75% auto-compaction...');
		const advisorCtx = await advisorModel.createContext({ contextSize: 1024 });
		const seq = advisorCtx.getSequence();

		const systemPrompt = [
			'You are the CodeCrab Project Brain Summarizer.',
			'The code generation specialist reached its 75% context cutoff.',
			'Your task: create a concise, factual 100-150 word project summary.',
			'Structure:',
			'1. COMPLETED: List files and components already written to disk.',
			'2. REMAINING: List required components or features still missing from the request.',
			'3. NEXT STEP: Give an explicit instruction on which file to generate next.',
			'Keep it brief and factual. No conversational filler.',
		].join('\n');

		const userContent = [
			`Original User Goal: ${params.userRequest}`,
			`Files Written So Far: ${params.filesWritten.join(', ') || 'None completed yet'}`,
			params.partialSnippet ? `Recent Generation Tail:\n${params.partialSnippet.slice(-400)}` : '',
		].filter(Boolean).join('\n\n');

		const fullPrompt = `<|im_start|>system\n${systemPrompt}<|im_end|>\n<|im_start|>user\n${userContent} /no_think<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n`;
		const inputTokens = advisorModel.tokenize(fullPrompt);

		let raw = '';
		const eosToken = advisorModel.tokens.eos;
		for await (const token of seq.evaluate(inputTokens, { temperature: 0.1 })) {
			const text = advisorModel.detokenize([token]);
			raw += text;
			if (token === eosToken) break;
			if (raw.length > 1000) break;
		}

		await advisorCtx.dispose();
		let summary = raw.trim();
		if (!summary.includes('REMAINING') && !summary.includes('NEXT STEP')) {
			summary += `\nREMAINING: Verify all requested features, handlers, and components are fully wired.\nNEXT STEP: Generate complete src/App.tsx connecting all components with native React state.`;
		}
		console.log(`[Advisor] Summary generated (${summary.length} chars):`, summary.slice(0, 120) + '...');
		return summary || 'Project state summarized. Continue generating remaining uncompleted components.';
	} catch (e: any) {
		console.warn('[Advisor] Summary pass failed, using fallback summary:', e.message);
		return `Files completed: ${params.filesWritten.join(', ') || 'None'}.\nREMAINING: Assemble all components in src/App.tsx with complete state and handlers.\nNEXT STEP: Generate src/App.tsx now.`;
	}
}

// ---------------------------------------------------------------------------
// 7. Ensemble helpers (scoring / classifying)
// ---------------------------------------------------------------------------

export function inferPreviousRoute(messages: any[]): 'fe' | 'be' | null {
	for (let i = messages.length - 2; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== 'assistant') continue;
		const content = msg?.content || '';
		if (/<file\s+path=["'][^"']*(\.(tsx|jsx|css|scss)|components\/|pages\/|hooks\/)[^"']*["']/i.test(content)) return 'fe';
		if (/<file\s+path=["'][^"']*(controller|service|middleware|repository|schema\.prisma|routes\/)[^"']*["']/i.test(content)) return 'be';
		break;
	}
	return null;
}

export function classifyOpenFile(openFiles: string[] | undefined): 'fe' | 'be' | null {
	if (!openFiles || openFiles.length === 0) return null;
	const activeFile = openFiles[0]!;
	const ext = path.extname(activeFile).toLowerCase();
	const base = path.basename(activeFile).toLowerCase();
	if (['.tsx', '.jsx'].includes(ext)) return 'fe';
	if (['.css', '.scss'].includes(ext)) return 'fe';
	if (/(?:component|page|layout|sidebar|dashboard|modal|hook|store)/i.test(base)) return 'fe';
	if (/(?:controller|service|middleware|repository|route|schema\.prisma|guard)/i.test(base)) return 'be';
	if (ext === '.sql') return 'be';
	return null;
}

export function scoreKeywords(msg: string): { feScore: number; beScore: number } {
	let feScore = 0;
	let beScore = 0;
	if (UI_COMPONENT_PATTERN.test(msg)) feScore += 2;
	if (UI_INTERACTION_PATTERN.test(msg)) feScore += 1;
	if (UI_DESIGN_PATTERN.test(msg)) feScore += 2;
	if (UI_FRAMEWORK_PATTERN.test(msg)) feScore += 2;
	if (/\b(?:kanban|trello|drag\s+and\s+drop|dark\s+mode|dashboard|responsive)\b/i.test(msg)) feScore += 2;
	if (BE_DB_PATTERN.test(msg)) beScore += 2;
	if (BE_SERVER_PATTERN.test(msg)) beScore += 2;
	if (BE_AUTH_INFRA_PATTERN.test(msg)) beScore += 2;
	return { feScore, beScore };
}

export function detectAppType(msg: string): boolean {
	return /\b(app|application|platform|saas|clone|dashboard|tool|system|portal|suite|product)\b/i.test(msg);
}
