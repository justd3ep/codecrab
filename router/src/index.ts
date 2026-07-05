import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { exec } from 'child_process';
import util from 'util';
import { fileURLToPath } from 'url';
import { getLlama, Llama, LlamaModel, LlamaContext, LlamaChatSession } from 'node-llama-cpp';
import { em, indexWorkspace, updateFile, deleteFiles, syncWorkspace, retrieveContext, tableNameFor } from './rag.js';
import { tier2Retrieve, patchTier2Caches, shouldSkipFEPhase, cleanupArtifacts, patchCachesFromArtifact } from './rag/index.js';
import { buildArtifactFromFiles, writeArtifact, deleteArtifact } from './rag/artifact.js';
import { runPostGenerationValidator } from './validator.js';
import type { ValidationContract, ValidationIssue } from './validator.js';
import { inspectWorkspace } from './workspaceInspector.js';
import { buildExecutionGraph, nextPendingNode, isGraphComplete, graphSummary, markNodeFailed } from './planner.js';
import type { AdvisorV2Result, ExecutionGraph } from './planner.js';
import { resolveCapabilities, loadCapabilityPrompts, buildCapabilitySystemPrompt } from './capabilityResolver.js';
import { runIncrementalEngine, shouldUseIncrementalEngine } from './incrementalEngine.js';

// ── Async Job System (Phase 4) ─────────────────────────────────────────────
import { EventBus }         from './core/eventBus.js';
import { Logger }           from './logging/logger.js';
import { ModelManager }     from './models/modelManager.js';
import { JobService }       from './jobs/jobService.js';
import { RecoveryManager }  from './jobs/recoveryManager.js';
import { makeJobRoutes }    from './router/jobRoutes.js';
import { makeHealthRoutes } from './router/healthRoutes.js';
import config               from '@/config/index.js';

// ---------------------------------------------------------------------------
// Constraint Parser — runs BEFORE advisor, highest priority
// ---------------------------------------------------------------------------

type UserScope = 'BACKEND_ONLY' | 'FRONTEND_ONLY' | 'ANY';

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

function parseUserScope(msg: string): UserScope {
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

// ---------------------------------------------------------------------------
// Planner Contract — deterministic keyword extraction, no model call
// ---------------------------------------------------------------------------

interface PlannerContract {
	scope: 'backend' | 'frontend' | 'fullstack';
	architecture: 'repository' | 'mvc' | 'clean' | 'flat' | 'unknown';
	framework: string;
	language: 'typescript' | 'javascript';
	requiredFeatures: string[];
	requiredFolders: string[];
	estimatedFiles: number;
}

const FEATURE_DETECTION: Array<{ key: string; re: RegExp }> = [
	{ key: 'jwt', re: /\bjwt\b|json.?web.?token|access.?token/i },
	{ key: 'refresh_tokens', re: /refresh.?token/i },
	{ key: 'repository', re: /repository.?pattern|repo.?pattern/i },
	{ key: 'service_layer', re: /service.?layer|service\s+class/i },
	{ key: 'uploads', re: /\bupload\b|file.?upload|image.?upload/i },
	{ key: 'logging', re: /\blogg?ing\b|\blogger\b/i },
	{ key: 'pagination', re: /\bpaginat/i },
	{ key: 'email', re: /\bemail\b|send.?mail|nodemailer/i },
	{ key: 'payments', re: /\bpayment\b|\bstripe\b|\bpaypal\b|\bcheckout\b/i },
	{ key: 'rbac', re: /\brbac\b|role.?based|permission|admin.?role/i },
	{ key: 'oauth', re: /\boauth\b|google.?auth|github.?auth|social.?login/i },
	{ key: 'password_reset', re: /password.?reset|forgot.?password/i },
	{ key: 'email_verification', re: /email.?verif|verify.?email/i },
	{ key: 'transactions', re: /\btransaction\b/i },
	{ key: 'dto', re: /\bdto\b|data.?transfer.?object|class.?validator/i },
	{ key: 'bcrypt', re: /\bbcrypt\b|hash.?password|password.?hash/i },
	{ key: 'middleware', re: /\bmiddleware\b/i },
];

const ARCH_DETECTION: Array<{ arch: PlannerContract['architecture']; re: RegExp }> = [
	{ arch: 'repository', re: /repository.?pattern|repo.?pattern/i },
	{ arch: 'clean', re: /clean.?arch|domain.?driven|ddd|hexagonal/i },
	{ arch: 'mvc', re: /\bmvc\b|model.?view.?controller/i },
];

const ARCH_FOLDERS_MAP: Record<string, string[]> = {
	repository: ['controllers', 'services', 'repositories'],
	mvc: ['models', 'controllers'],
	clean: ['domain', 'application', 'infrastructure'],
	flat: [],
};

function buildPlannerContract(msg: string, advisorIntent: string): PlannerContract {
	// Scope
	const scope: PlannerContract['scope'] =
		advisorIntent.includes('fullstack') ? 'fullstack'
			: advisorIntent.includes('fe') ? 'frontend'
				: advisorIntent.includes('be') ? 'backend'
					: 'fullstack';

	// Architecture
	let architecture: PlannerContract['architecture'] = 'unknown';
	for (const a of ARCH_DETECTION) {
		if (a.re.test(msg)) { architecture = a.arch; break; }
	}
	// repository pattern is implied when service + controller keywords present
	if (architecture === 'unknown' && scope !== 'frontend') {
		if (/\bservice\b/i.test(msg) && /\bcontroller\b/i.test(msg)) architecture = 'repository';
	}

	// Framework
	const framework =
		/\bnestjs\b/i.test(msg) ? 'nestjs'
			: /\bexpress\b/i.test(msg) ? 'express'
				: /\bnext\.?js\b/i.test(msg) ? 'nextjs'
					: /\bvite\b/i.test(msg) ? 'vite'
						: /\bfastify\b/i.test(msg) ? 'fastify'
							: 'unknown';

	// Language
	const language: 'typescript' | 'javascript' =
		/\bjavascript\b|\.js\b/i.test(msg) && !/\btypescript\b|\.ts\b/i.test(msg) ? 'javascript' : 'typescript';

	// Required features
	const requiredFeatures = FEATURE_DETECTION.filter(f => f.re.test(msg)).map(f => f.key);

	// Required folders from architecture
	const requiredFolders = ARCH_FOLDERS_MAP[architecture] ?? [];

	// Rough file estimate: (features * 2) + (folders * 2) + 3 base files
	const estimatedFiles = scope === 'fullstack'
		? Math.max(10, requiredFeatures.length * 2 + requiredFolders.length * 2 + 5)
		: Math.max(5, requiredFeatures.length * 2 + requiredFolders.length * 2 + 3);

	console.log(`[PlannerContract] scope=${scope} arch=${architecture} fw=${framework} features=[${requiredFeatures.join(',')}] est=${estimatedFiles}`);
	return { scope, architecture, framework, language, requiredFeatures, requiredFolders, estimatedFiles };
}

function plannerContractToValidationContract(pc: PlannerContract, userScope: UserScope): ValidationContract {
	const scope: ValidationContract['scope'] =
		userScope === 'BACKEND_ONLY' ? 'backend'
			: userScope === 'FRONTEND_ONLY' ? 'frontend'
				: pc.scope === 'backend' ? 'backend'
					: pc.scope === 'frontend' ? 'frontend'
						: pc.scope === 'fullstack' ? 'fullstack'
							: 'unknown';
	return {
		scope,
		architecture: pc.architecture,
		framework: pc.framework,
		language: pc.language,
		requiredFeatures: pc.requiredFeatures,
		requiredFolders: pc.requiredFolders,
		expectedFiles: [],
		estimatedFiles: pc.estimatedFiles,
	};
}

// ---------------------------------------------------------------------------
// Repair Loop V2.6 — Modification-Oriented Architecture
// ---------------------------------------------------------------------------

/** Repair strategy per issue type. */
const enum RepairMode {
	MODIFY_EXISTING = 'MODIFY_EXISTING',
	GENERATE_MISSING = 'GENERATE_MISSING',
	REWIRE_IMPORTS = 'REWIRE_IMPORTS',
	DELETE_DUPLICATES = 'DELETE_DUPLICATES',
	SECURITY_FIX = 'SECURITY_FIX',
	COMPILE_FIX = 'COMPILE_FIX',
}

/** Map ValidationIssue.kind → RepairMode */
function classifyRepairMode(kind: string, message: string): RepairMode {
	switch (kind) {
		case 'missing_architecture':
			// "already exists" → MODIFY, otherwise GENERATE
			return /already exists|duplicate/i.test(message) ? RepairMode.DELETE_DUPLICATES : RepairMode.GENERATE_MISSING;
		case 'missing_coverage':
			return RepairMode.GENERATE_MISSING;
		case 'business_logic_leak':
			// Layer violation = rewrite existing file, not add new one
			return /layer violation|imports.*directly|belongs in/i.test(message) ? RepairMode.MODIFY_EXISTING : RepairMode.GENERATE_MISSING;
		case 'missing_import':
			return RepairMode.REWIRE_IMPORTS;
		case 'undefined_symbol':
			return RepairMode.MODIFY_EXISTING;
		case 'dead_code':
			return /already exists|workspace/i.test(message) ? RepairMode.DELETE_DUPLICATES : RepairMode.MODIFY_EXISTING;
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
 * Scan workspace + generated files and return a map of:
 *   moduleName → { layer, relPath }[]
 * Used to prevent parallel implementations during repair.
 */
function collectWorkspaceModules(
	workspaceRoot: string,
	generatedFiles: string[],
): Map<string, { layer: string; path: string }[]> {
	const result = new Map<string, { layer: string; path: string }[]>();
	const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.git', '.next']);

	const LAYER_SUFFIX_RE = /\.(service|controller|repository|router|routes?|middleware|guard|module|dto|entity|model|schema)\.[tj]sx?$/i;
	const LAYER_DIR_RE = /\/(services?|controllers?|repositor|routes?|middleware|models?|dto|guards?)\//i;

	function classifyFileLayer(p: string): string {
		if (LAYER_DIR_RE.test(p)) {
			const m = LAYER_DIR_RE.exec(p);
			return m ? m[1]!.replace(/s$/, '').toLowerCase() : 'other';
		}
		if (LAYER_SUFFIX_RE.test(p)) {
			const m = LAYER_SUFFIX_RE.exec(p);
			return m ? m[1]!.toLowerCase() : 'other';
		}
		return 'other';
	}

	function extractMod(p: string): string | null {
		const base = path.basename(p, path.extname(p))
			.replace(/\.(service|controller|repository|router|routes?|middleware|guard|module|dto|entity|model|schema)$/i, '')
			.toLowerCase().trim();
		return base.length > 1 ? base : null;
	}

	function addFile(relPath: string): void {
		const mod = extractMod(relPath);
		const layer = classifyFileLayer(relPath);
		if (!mod || layer === 'other') return;
		if (!result.has(mod)) result.set(mod, []);
		result.get(mod)!.push({ layer, path: relPath });
	}

	// Generated files
	for (const f of generatedFiles) addFile(f);

	// Workspace files (shallow scan)
	function scanDir(dir: string, depth = 0): void {
		if (depth > 5) return;
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const e of entries) {
				if (SKIP_DIRS.has(e.name)) continue;
				if (e.isDirectory()) scanDir(path.join(dir, e.name), depth + 1);
				else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) addFile(path.relative(workspaceRoot, path.join(dir, e.name)));
			}
		} catch { /* ignore */ }
	}
	scanDir(workspaceRoot);

	return result;
}

/**
 * Determine if a file path exists among generated files OR on disk.
 */
function fileExists(filePath: string, generatedPaths: Set<string>, workspaceRoot: string): boolean {
	if (generatedPaths.has(filePath)) return true;
	const exts = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];
	return exts.some(e => { try { return fs.existsSync(path.join(workspaceRoot, filePath + e)); } catch { return false; } });
}

/**
 * V2.6 Modification-Oriented Repair Prompt Builder.
 *
 * Produces targeted MODIFY / GENERATE / REWIRE instructions.
 * Never says "generate controllers" if controllers already exist.
 */
function buildTargetedRepairPrompt(
	issues: ValidationIssue[],
	generatedFiles: string[] = [],
	workspaceRoot = '',
): string {
	const errors = issues.filter(i => i.severity === 'error');
	if (errors.length === 0) return '';

	const generatedSet = new Set(generatedFiles);
	const wsModules = workspaceRoot ? collectWorkspaceModules(workspaceRoot, generatedFiles) : new Map();
	const existingModuleList = [...wsModules.keys()].sort().slice(0, 20);

	// Group issues → RepairMode → instructions
	type RepairGroup = { mode: RepairMode; issues: ValidationIssue[] };
	const groups = new Map<RepairMode, ValidationIssue[]>();
	for (const iss of errors) {
		const mode = classifyRepairMode(iss.kind, iss.message);
		if (!groups.has(mode)) groups.set(mode, []);
		groups.get(mode)!.push(iss);
	}

	const lines: string[] = ['<repair_instructions>'];

	// ── Project State ─────────────────────────────────────────────────────────
	lines.push('## Project State', '');
	if (existingModuleList.length > 0) {
		lines.push('### Existing Modules (DO NOT duplicate)');
		existingModuleList.forEach(m => lines.push(`  - ${m}`));
		lines.push('');
	}
	if (generatedFiles.length > 0) {
		lines.push('### Generated Files (already on disk)');
		generatedFiles.slice(0, 25).forEach(f => lines.push(`  - ${f}`));
		lines.push('');
	}

	// ── Expected Layer Graph ──────────────────────────────────────────────────
	lines.push(
		'## Expected Dependency Graph',
		'  Routes → Controllers → Services → Repositories → Models/Database',
		'  ILLEGAL: Route → Repository | Route → Model | Controller → Model | Controller → Prisma | Route → bcrypt | Route → jwt',
		'',
	);

	// ── Repair Instructions by Mode ───────────────────────────────────────────
	lines.push('## Repair Instructions', '');

	// MODIFY_EXISTING — rewrite specific files
	const modifyIssues = groups.get(RepairMode.MODIFY_EXISTING) ?? [];
	if (modifyIssues.length > 0) {
		lines.push('### MODIFY (rewrite existing files — do NOT create new parallel implementations)');
		// Group by file
		const byFile = new Map<string, ValidationIssue[]>();
		for (const iss of modifyIssues) {
			const key = iss.file ?? 'unknown';
			if (!byFile.has(key)) byFile.set(key, []);
			byFile.get(key)!.push(iss);
		}
		for (const [file, fileIssues] of byFile) {
			const exists = file !== 'unknown' && fileExists(file, generatedSet, workspaceRoot);
			lines.push(`  ${exists ? '📝 MODIFY' : '❓ FIX'}: ${file}`);
			fileIssues.forEach(i => lines.push(`    - ${i.message}`));
		}
		lines.push('');
	}

	// GENERATE_MISSING — only truly missing files
	const genIssues = groups.get(RepairMode.GENERATE_MISSING) ?? [];
	if (genIssues.length > 0) {
		lines.push('### GENERATE (create ONLY these missing files — no other new files)');
		for (const iss of genIssues) {
			lines.push(`  📄 ${iss.message}`);
			// If related files need updating, list them
			if (iss.file && fileExists(iss.file, generatedSet, workspaceRoot)) {
				lines.push(`    → Also update imports in: ${iss.file}`);
			}
		}
		lines.push('');
	}

	// REWIRE_IMPORTS — fix imports in existing files
	const rewireIssues = groups.get(RepairMode.REWIRE_IMPORTS) ?? [];
	if (rewireIssues.length > 0) {
		lines.push('### REWIRE IMPORTS (fix import paths — do not restructure logic)');
		for (const iss of rewireIssues) {
			const file = iss.file ?? '';
			lines.push(`  🔗 ${file}: ${iss.message}`);
		}
		lines.push('');
	}

	// DELETE_DUPLICATES — remove or consolidate
	const deleteIssues = groups.get(RepairMode.DELETE_DUPLICATES) ?? [];
	if (deleteIssues.length > 0) {
		lines.push('### CONSOLIDATE (remove duplicate logic — reuse existing modules)');
		for (const iss of deleteIssues) {
			lines.push(`  🗑️  ${iss.file ?? ''}: ${iss.message}`);
			lines.push(`    → Reuse existing module. Do NOT create a parallel implementation.`);
		}
		lines.push('');
	}

	// SECURITY_FIX
	const secIssues = groups.get(RepairMode.SECURITY_FIX) ?? [];
	if (secIssues.length > 0) {
		lines.push('### SECURITY FIXES (patch existing files only)');
		for (const iss of secIssues) {
			lines.push(`  🔒 ${iss.file ?? ''}: ${iss.message}`);
		}
		lines.push('');
	}

	// COMPILE_FIX
	const compileIssues = groups.get(RepairMode.COMPILE_FIX) ?? [];
	if (compileIssues.length > 0) {
		lines.push('### COMPILE ERRORS (fix type errors — do not restructure)');
		for (const iss of compileIssues) {
			lines.push(`  ⚠️  ${iss.file ?? ''}: ${iss.message}`);
		}
		lines.push('');
	}

	// ── Output Rules ─────────────────────────────────────────────────────────
	lines.push(
		'## Output Rules',
		'  1. Use <file path="...">...</file> format for ALL output files.',
		'  2. Output ONLY the files listed above as MODIFY or GENERATE.',
		'  3. DO NOT output files that are already correct and not listed above.',
		'  4. DO NOT regenerate the entire project.',
		'  5. DO NOT create new modules for functionality that already exists — extend or modify instead.',
		'  6. Move logic between layers by rewriting the affected files (routes, controller, service, repository).',
		'  7. When moving database logic from a route to a repository, update the route → controller → service → repository chain.',
		'</repair_instructions>',
	);

	return lines.join('\n');
}


// ---------------------------------------------------------------------------
// Suppress known harmless llama.cpp native stderr noise
// ---------------------------------------------------------------------------
const SUPPRESSED_PATTERNS = [
	'embeddings required but some input tokens were not marked as outputs -> overriding',
];
const _origStderrWrite = process.stderr.write.bind(process.stderr);
(process.stderr as any).write = (chunk: any, ...args: any[]) => {
	const text = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? '';
	if (SUPPRESSED_PATTERNS.some(p => text.includes(p))) return true;
	return (_origStderrWrite as any)(chunk, ...args);
};

const execPromise = util.promisify(exec);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = config.server.port;

const IDLE_UNLOAD_MS = config.generation.requestTimeoutMs; // 5 min idle → unload model

// GPU VRAM budget per model key
// 'auto' = node-llama-cpp binary-searches best layer count, falls back to CPU if needed (never OOMs)
// 'max'  = ALL layers or throw — do NOT use
// 0      = CPU only
const GPU_LAYERS: Record<string, number | 'auto'> = {
	fe: 'auto',
	be: 'auto',
};

// ---------------------------------------------------------------------------
// ModelManager — exactly 0 or 1 model in VRAM at any time
// ---------------------------------------------------------------------------
const mm = new class ModelManager {
	private llama: Llama | null = null;
	private activeModel: LlamaModel | null = null;
	private activeKey: string | null = null;
	private loading = false;        // mutex: prevent concurrent loads
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

	// fallback to auto discovery if configured path missing
	private findModelFile(key: string): string | null {
		// 1. Check explicit configuration
		const cfgPath = key === 'advisor' ? config.models.advisor : (key === 'fe' ? config.models.frontend : config.models.backend);
		if (cfgPath) {
			if (fs.existsSync(cfgPath)) return cfgPath;
			throw new Error(`Configuration Error: Configured model path for ${key} does not exist: ${cfgPath}`);
		}
		
		// 2. Fallback to auto-discovery
		const BASE_MODELS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../models/base');
		if (!fs.existsSync(BASE_MODELS_DIR)) {
			throw new Error(`Configuration Error: No configured path for ${key} and models/base directory missing.`);
		}
		const files = fs.readdirSync(BASE_MODELS_DIR).filter(f => f.endsWith('.gguf'));
		if (key === 'advisor') {
			const match = files.find(f => f.includes('advisor'));
			return match ? path.join(BASE_MODELS_DIR, match) : null;
		}
		const match = files.find(f => f.includes(key) && !f.includes('advisor'));
		return match ? path.join(BASE_MODELS_DIR, match) : null;
	}

	// Unload current model, free VRAM
	private async unload(): Promise<void> {
		if (!this.activeModel) return;
		const key = this.activeKey;
		console.log(`[ModelManager] Unloading model "${key}" — freeing VRAM...`);
		try {
			await this.activeModel.dispose();
		} catch (e) {
			console.error(`[ModelManager] Error disposing model "${key}": `, e);
		}
		this.activeModel = null;
		this.activeKey = null;
		console.log(`[ModelManager] Model "${key}" unloaded.`);
	}

	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(async () => {
			console.log(`[ModelManager] Idle timeout. Unloading model...`);
			await this.unload();
		}, IDLE_UNLOAD_MS);
	}

	async init(): Promise<void> {
		console.log(`[ModelManager] Initializing llama engine (no models pre-loaded)...`);
		this.llama = await getLlama();
		console.log(`[ModelManager] Engine ready. VRAM: 0 models loaded.`);
	}

	// Get model for intent — loads if needed, swaps if different model active
	async acquire(intent: 'frontend' | 'backend' | 'general' | 'advisor'): Promise<LlamaModel> {
		if (!this.llama) throw new Error('Engine not initialized.');

		// Resolve key: advisor → 'advisor', frontend → 'fe', everything else → 'be'
		const key = intent === 'advisor' ? 'advisor' : (intent === 'frontend' ? 'fe' : 'be');

		// Already loaded — reset idle, return it
		if (this.activeModel && this.activeKey === key) {
			console.log(`[ModelManager] Model "${key}" already in VRAM.`);
			this.resetIdleTimer();
			return this.activeModel;
		}

		// Mutex: wait if another load in progress
		if (this.loading) throw new Error('Model load already in progress. Retry.');
		this.loading = true;

		try {
			// Unload current model first (VRAM swap)
			if (this.activeModel) {
				console.log(`[ModelManager] Swapping "${this.activeKey}" → "${key}"`);
				await this.unload();
				// Give CUDA driver ~500ms to fully reclaim pages before VRAM preflight
				await new Promise(r => setTimeout(r, 500));
			}

			const modelPath = this.findModelFile(key);
			if (!modelPath) throw new Error(`Model resolution failed for key "${key}"`);

			const gpuLayers = GPU_LAYERS[key] ?? 'auto';
			console.log(`[ModelManager] Loading "${key}" (gpuLayers=${gpuLayers}): ${modelPath}`);

			this.activeModel = await this.llama!.loadModel({
				modelPath,
				gpuLayers,
			});
			this.activeKey = key;
			console.log(`[ModelManager] Model "${key}" loaded. VRAM swap complete.`);
			this.resetIdleTimer();
			return this.activeModel;
		} finally {
			this.loading = false;
		}
	}

	get status() {
		return {
			activeKey: this.activeKey,
			loaded: this.activeModel !== null,
			loading: this.loading,
		};
	}
};

// Initialize on startup (engine only, no models loaded)
mm.init().catch(e => console.error('[ModelManager] Init failed:', e));

// Initialize RAG embedding model on CPU (non-blocking)
em.init().catch(e => console.error('[EmbeddingManager] Init failed:', e));

// Helpers for Dynamic Routing
function detectFrontendIntent(messages: any[]): boolean {
	if (!messages || messages.length === 0) return false;
	const lastMessage = messages[messages.length - 1]?.content?.toLowerCase() || '';
	const frontendKeywords = ['css', 'html', 'tailwind', 'react', 'vue', 'frontend', 'ui', 'component', 'button', 'layout', 'style'];
	return frontendKeywords.some(kw => lastMessage.includes(kw));
}

function detectBackendIntent(messages: any[]): boolean {
	if (!messages || messages.length === 0) return false;
	const lastMessage = messages[messages.length - 1]?.content?.toLowerCase() || '';
	const backendKeywords = [
		'backend', 'api', 'database', 'sql', 'mongo', 'node', 'express', 'server', 'auth', 'docker', 'router',
		'jwt', 'oauth', 'rbac', 'authentication', 'authorization', 'refresh tokens', 'sessions',
		'database design', 'schema design', 'postgresql', 'mongodb', 'repository pattern',
		'service layer', 'controllers', 'middleware', 'guards', 'nestjs', 'api design', 'openapi',
		'validation', 'zod', 'joi', 'class-validator', 'queues', 'redis', 'background jobs',
		'microservices', 'event architecture'
	];
	return backendKeywords.some(kw => lastMessage.includes(kw));
}

// ---------------------------------------------------------------------------
// READ vs WRITE intent classifier
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

function classifyIntent(userMessage: string): 'read' | 'write' {
	const msg = userMessage.toLowerCase();

	// WRITE wins if any write pattern matches — explicit mutation intent
	if (WRITE_PATTERNS.some(p => p.test(msg))) return 'write';
	// READ wins if any read pattern matches
	if (READ_PATTERNS.some(p => p.test(msg))) return 'read';
	// Default to write so existing behavior is preserved for ambiguous prompts
	return 'write';
}


function getAvailableModels() {
	const models = [];

	if (config.models.frontend) {
		models.push({
			ollamaTag: 'codecrab/qwen-fe',
			id: 'codecrab/qwen-fe',
			displayName: 'Qwen 2.5 (Frontend Specialist)',
			domain: 'Frontend UI/UX',
			status: 'ready',
			maturity: 'alpha',
			ramRequiredGb: 6
		});
	}

	if (config.models.backend) {
		models.push({
			ollamaTag: 'codecrab/qwen-be',
			id: 'codecrab/qwen-be',
			displayName: 'Qwen 2.5 (Backend Specialist)',
			domain: 'Backend Engineering',
			status: 'ready',
			maturity: 'alpha',
			ramRequiredGb: 6
		});
	}

	if (models.length === 0) {
		models.push({
			ollamaTag: 'codecrab/base',
			id: 'codecrab/base',
			displayName: 'Native CodeCrab Base Model',
			domain: 'General',
			status: 'ready',
			maturity: 'stable',
			ramRequiredGb: 4
		});
	}

	return models;
}

// Health Check
app.get('/health', (req, res) => {
	res.json({
		router: 'ok',
		engine: 'node-llama-cpp',
		...mm.status,
		models: getAvailableModels()
	});
});

let lastCpuInfo = os.cpus();
function getCpuUsage(): number {
	const currentCpuInfo = os.cpus();
	let idleDiff = 0;
	let totalDiff = 0;
	for (let i = 0; i < currentCpuInfo.length; i++) {
		const oldTimes = lastCpuInfo[i]!.times;
		const newTimes = currentCpuInfo[i]!.times;
		const oldTotal = Object.values(oldTimes).reduce((a, b) => a + b, 0);
		const newTotal = Object.values(newTimes).reduce((a, b) => a + b, 0);
		idleDiff += newTimes.idle - oldTimes.idle;
		totalDiff += newTotal - oldTotal;
	}
	lastCpuInfo = currentCpuInfo;
	if (totalDiff === 0) return 0;
	const usage = 100 - (100 * idleDiff / totalDiff);
	return Math.max(0, Math.min(100, usage));
}

// Stats Telemetry Endpoint
app.get('/stats', async (req, res) => {
	try {
		const totalMemBytes = os.totalmem();
		const freeMemBytes = os.freemem();
		const usedMemBytes = totalMemBytes - freeMemBytes;
		const ramUsagePercent = (usedMemBytes / totalMemBytes) * 100;
		const ramUsedGb = usedMemBytes / 1024 / 1024 / 1024;
		const ramTotalGb = totalMemBytes / 1024 / 1024 / 1024;

		const cpuUsagePercent = getCpuUsage();

		let storageUsagePercent = 0;
		let storageUsedGb = 0;
		let storageTotalGb = 0;
		try {
			const { stdout } = await execPromise('df -k / | tail -1');
			const parts = stdout.trim().split(/\\s+/);
			const totalKb = parseInt(parts[1] ?? '0', 10);
			const usedKb  = parseInt(parts[2] ?? '0', 10);
			storageTotalGb = totalKb / 1024 / 1024;
			storageUsedGb = usedKb / 1024 / 1024;
			storageUsagePercent = (storageUsedGb / storageTotalGb) * 100;
		} catch (e) { }

		let hasGpu = false;
		let vramUsagePercent = 0;
		let vramUsedGb = 0;
		let vramTotalGb = 0;

		try {
			const { stdout } = await execPromise('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,nounits,noheader');
			const [used, total] = stdout.trim().split(',').map(Number);
			hasGpu = true;
			vramUsedGb = (used ?? 0) / 1024;
			vramTotalGb = (total ?? 0) / 1024;
			vramUsagePercent = ((used ?? 0) / (total ?? 1)) * 100;
		} catch (e) {
			try {
				const { stdout } = await execPromise('rocm-smi --showmeminfo vram --csv');
				if (stdout.includes('vram')) {
					hasGpu = true;
					// Dummy AMD values if parsing is complex, just to show it detected AMD
					vramUsagePercent = 40;
					vramUsedGb = 6;
					vramTotalGb = 16;
				}
			} catch (e2) {
				hasGpu = false;
			}
		}

		res.json({
			cpu: { percent: cpuUsagePercent.toFixed(1) },
			ram: { percent: ramUsagePercent.toFixed(1), usedGb: ramUsedGb.toFixed(1), totalGb: ramTotalGb.toFixed(1) },
			storage: { percent: storageUsagePercent.toFixed(1), usedGb: storageUsedGb.toFixed(1), totalGb: storageTotalGb.toFixed(1) },
			gpu: { hasGpu, percent: vramUsagePercent.toFixed(1), usedGb: vramUsedGb.toFixed(1), totalGb: vramTotalGb.toFixed(1) }
		});
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch stats' });
	}
});

// List Models
app.get('/v1/models', (req, res) => {
	res.json(getAvailableModels());
});

// ---------------------------------------------------------------------------
// Dynamic System Prompt Builder
// ---------------------------------------------------------------------------

function loadPrompt(name: string): string {
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
// Appends JSON lines to router/logs/routing_failures.jsonl
// Call whenever you detect the route was wrong (via user feedback or hard overrides).
// Collect 500–2000 failures before finetuning the advisor.
// ---------------------------------------------------------------------------
const FAILURE_LOG_PATH = path.join(config.runtime.root, 'logs/routing_failures.jsonl');
function logRoutingFailure(prompt: string, predicted: string, expected: string): void {
	try {
		const dir = path.dirname(FAILURE_LOG_PATH);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const entry = JSON.stringify({ prompt, predicted, expected, ts: new Date().toISOString() });
		fs.appendFileSync(FAILURE_LOG_PATH, entry + '\n');
		console.log(`[Router] Failure logged: ${predicted} → expected ${expected}`);
	} catch (e: any) {
		console.warn('[Router] Failed to write routing failure log:', e.message);
	}
}

// ---------------------------------------------------------------------------
// Advisor — stateless 0.6B intent classifier
// Returns one of 8 intent strings. Never talks to user. No confidence.
// ---------------------------------------------------------------------------

type AdvisorIntent =
	| 'create_fe' | 'edit_fe'
	| 'create_be' | 'edit_be'
	| 'create_fullstack' | 'edit_fullstack'
	| 'general' | 'unknown';

/** Parse {"intent":"..."} from raw advisor output. Returns null on any failure. */
function parseAdvisorIntent(raw: string): AdvisorIntent | null {
	const stripped = raw.replace(/```json?\s*/gi, '').replace(/```\s*/g, '').trim();
	const match = stripped.match(/\{[^{}]*\}/);
	if (!match) { console.warn('[Advisor] No JSON found.'); return null; }
	try {
		const obj = JSON.parse(match[0]);
		const intent = obj.intent as string;
		const valid: AdvisorIntent[] = ['create_fe', 'edit_fe', 'create_be', 'edit_be', 'create_fullstack', 'edit_fullstack', 'general', 'unknown'];
		if (!valid.includes(intent as AdvisorIntent)) {
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

/**
 * AdvisorV2: attempt to extract rich planning fields from advisor JSON.
 * Falls back gracefully — intent field is the only required field.
 * Never throws. Returns null if intent is invalid.
 */
function parseAdvisorV2(raw: string): { intent: AdvisorIntent; v2: AdvisorV2Result } | null {
	const stripped = raw.replace(/```json?\s*/gi, '').replace(/```\s*/g, '').trim();
	// Support nested JSON (advisor may output indented JSON)
	const match = stripped.match(/\{[\s\S]*\}/);
	if (!match) { console.warn('[AdvisorV2] No JSON found.'); return null; }
	try {
		const obj = JSON.parse(match[0]);
		const intentRaw = obj.intent as string;
		const valid: AdvisorIntent[] = ['create_fe', 'edit_fe', 'create_be', 'edit_be', 'create_fullstack', 'edit_fullstack', 'general', 'unknown'];
		if (!valid.includes(intentRaw as AdvisorIntent)) {
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

/**
 * Run the Advisor model pass.
 * - Acquires the 'advisor' (0.6B) model via ModelManager.
 * - Immediately disposes context after classification (no VRAM residency).
 * - Returns AdvisorIntent or null (orchestrator falls back to ensemble heuristic).
 * - Also returns AdvisorV2Result if the model output includes the rich fields.
 */
async function runAdvisor(userRequest: string): Promise<AdvisorIntent | null>;
async function runAdvisor(userRequest: string, v2: true): Promise<{ intent: AdvisorIntent | null; v2Result: AdvisorV2Result | null }>;
async function runAdvisor(userRequest: string, v2 = false): Promise<any> {
	const systemPrompt = loadPrompt('planner');
	if (!systemPrompt) {
		console.warn('[Advisor] planner.md not found, skipping advisor pass.');
		return v2 ? { intent: null, v2Result: null } : null;
	}
	try {
		const advisorModel = await mm.acquire('advisor');
		// 512 ctx: system(~240 tok) + user(~20 tok) + template(~30 tok) + response(~10 tok) = ~300 tok, fits
		const advisorCtx = await advisorModel.createContext({ contextSize: 512 });
		const seq = advisorCtx.getSequence();

		// Build Qwen3 chat template + /no_think to suppress chain-of-thought mode.
		// Pre-filling <think>\n\n</think> forces the model to skip reasoning and output JSON directly.
		// planner.md is now ~50 tokens; total input fits well within 512-token context.
		const fullPrompt = `<|im_start|>system\n${systemPrompt}<|im_end|>\n<|im_start|>user\n${userRequest} /no_think<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n`;
		const inputTokens = advisorModel.tokenize(fullPrompt);
		console.log(`[Advisor] Input tokens: ${inputTokens.length} / 512`);

		// evaluate(inputTokens) both evals the prompt AND generates next tokens.
		// For V2, we allow up to 500 chars (rich JSON is larger than {"intent":"..."})
		let raw = '';
		const eosToken = advisorModel.tokens.eos;
		for await (const token of seq.evaluate(inputTokens, { temperature: 0 })) {
			const text = advisorModel.detokenize([token]);
			raw += text;
			if (token === eosToken) break;
			// Stop when JSON is closed — simple heuristic
			const depth = (raw.match(/\{/g) ?? []).length - (raw.match(/\}/g) ?? []).length;
			if (depth <= 0 && raw.includes('{')) break;
			if (raw.length > 600) break; // safety cap
		}

		console.log('[Advisor] Raw output:', raw.trim().slice(0, 150));
		await advisorCtx.dispose();

		if (v2) {
			// Try V2 parse first (rich fields), fall back to V1 intent-only
			const parsed = parseAdvisorV2(raw);
			if (parsed) return { intent: parsed.intent, v2Result: parsed.v2 };
			// V2 parse failed — try V1
			const intentOnly = parseAdvisorIntent(raw);
			return { intent: intentOnly, v2Result: intentOnly ? { intent: intentOnly } : null };
		}
		return parseAdvisorIntent(raw);
	} catch (e: any) {
		console.error('[Advisor] Failed:', e.message);
		return v2 ? { intent: null, v2Result: null } : null;
	}
}


// ---------------------------------------------------------------------------
// Ensemble scoring — fuses all signals into a final FE/BE/FULLSTACK/GENERAL score
// ---------------------------------------------------------------------------

/**
 * Infer previous route intent from conversation history.
 * Scans past assistant messages for <file path="..."> tags.
 * Returns 'fe', 'be', or null.
 */
function inferPreviousRoute(messages: any[]): 'fe' | 'be' | null {
	// Walk messages in reverse, find most recent assistant turn
	for (let i = messages.length - 2; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== 'assistant') continue;
		const content = msg?.content || '';
		// Check for FE file patterns
		if (/<file\s+path=["'][^"']*(\.(tsx|jsx|css|scss)|components\/|pages\/|hooks\/)[^"']*["']/i.test(content)) return 'fe';
		// Check for BE file patterns
		if (/<file\s+path=["'][^"']*(controller|service|middleware|repository|schema\.prisma|routes\/)[^"']*["']/i.test(content)) return 'be';
		// Found an assistant message but no clear signal — stop
		break;
	}
	return null;
}

/**
 * Classify open file context as 'fe', 'be', or null.
 */
function classifyOpenFile(openFiles: string[] | undefined): 'fe' | 'be' | null {
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

/**
 * Score keywords in the user message.
 * Returns { feScore, beScore }.
 */
function scoreKeywords(msg: string): { feScore: number; beScore: number } {
	const m = msg.toLowerCase();
	const feKw = [
		'react', 'tsx', 'tailwind', 'css', 'responsive', 'dark mode', 'modal', 'sidebar',
		'navbar', 'dashboard', 'table', 'chart', 'animation', 'theme', 'page', 'layout',
		'drag and drop', 'kanban', 'component', 'form', 'zustand', 'tanstack query',
		'shadcn',
	];
	const beKw = [
		'jwt', 'refresh token', 'access token', 'oauth', 'passport', 'bcrypt',
		'controller', 'middleware', 'endpoint', 'route', 'express', 'nestjs', 'service',
		'repository', 'prisma', 'typeorm', 'mongoose', 'mongodb', 'postgres', 'mysql',
		'redis', 'cache', 'queue', 'websocket', 'upload', 'bullmq', 'cron', 'validation',
		'zod', 'class-validator',
	];
	const feScore = feKw.filter(k => m.includes(k)).length;
	const beScore = beKw.filter(k => m.includes(k)).length;
	return { feScore, beScore };
}

/**
 * Empty workspace app-type detector.
 * If workspace empty + prompt describes an app → force create_fullstack.
 * Prevents "build a Postman clone" routing to create_be.
 */
function detectAppType(msg: string): boolean {
	const appNouns = /\b(app|application|platform|saas|clone|dashboard|tool|system|portal|suite|product)\b/i;
	return appNouns.test(msg);
}

// ---------------------------------------------------------------------------
// Cross-Specialist Skip Helpers
// ---------------------------------------------------------------------------

/** Frontend signal keywords — presence means the prompt requires UI work */
const FE_SIGNAL_WORDS = [
	'react', 'ui', 'page', 'screen', 'dashboard', 'component', 'modal',
	'table', 'chart', 'tailwind', 'form', 'layout', 'drag', 'kanban',
	'frontend', 'navbar', 'sidebar', 'button', 'style', 'css', 'animation',
	'carousel', 'accordion', 'dropdown', 'tab', 'toast', 'alert',
];

/**
 * Returns true if the prompt contains signals that frontend work is required.
 * Used to decide whether the FE specialist should run after the BE phase.
 *
 * Examples:
 *   "Implement JWT auth with refresh tokens" → false
 *   "Implement JWT auth with login page"     → true
 *   "Build a MERN expense tracker"           → true
 */
function promptNeedsFrontend(prompt: string): boolean {
	const lower = prompt.toLowerCase();
	return FE_SIGNAL_WORDS.some(word => lower.includes(word));
}

/**
 * Single hook for deciding whether the FE specialist should run in fullstack mode.
 * Currently uses prompt signals only. Can later incorporate:
 *   - BE output metadata (what files were created)
 *   - Planner results
 *   - Flutter / DevOps specialist awareness
 */
function shouldRunFrontend(opts: {
	intent: string;
	prompt: string;
	beFilesWritten: string[];
}): boolean {
	// Only relevant for fullstack execution — should never be called for single-specialist intents
	if (opts.intent !== 'create_fullstack' && opts.intent !== 'edit_fullstack' && opts.intent !== 'general') {
		return false;
	}
	return promptNeedsFrontend(opts.prompt);
}

/**
 * Ensemble Orchestrator.
 * Fuses: advisor(+3), previous route(+2), open file(+2), workspace(+1), keywords(+1).
 * Returns final routing intent.
 */
function ensembleRoute(
	advisorIntent: AdvisorIntent | null,
	openFiles: string[] | undefined,
	messages: any[],
	backendFileCount: number,
	frontendFileCount: number,
	msg: string,
): { intent: 'frontend' | 'backend' | 'general' | 'unknown'; isCreate: boolean } {
	let feScore = 0;
	let beScore = 0;
	let isCreate = false;

	// Priority order: workspace > open file > prev route > keywords > advisor

	// --- Signal 1: Workspace (+2) — strongest heuristic ---
	if (frontendFileCount > 0 && backendFileCount === 0) feScore += 2;
	if (backendFileCount > 0 && frontendFileCount === 0) beScore += 2;

	// --- Signal 2: Open file (+2) ---
	const openFileSignal = classifyOpenFile(openFiles);
	if (openFileSignal === 'fe') feScore += 2;
	if (openFileSignal === 'be') beScore += 2;

	// --- Signal 3: Previous route (+2) ---
	const prevRoute = inferPreviousRoute(messages);
	if (prevRoute === 'fe') feScore += 2;
	if (prevRoute === 'be') beScore += 2;

	// --- Signal 4: Keywords (+1 each, cap +3) ---
	const { feScore: fkw, beScore: bkw } = scoreKeywords(msg);
	feScore += Math.min(fkw, 3);
	beScore += Math.min(bkw, 3);

	// --- Signal 5: Advisor vote (+2 max, never overrides workspace) ---
	if (advisorIntent && advisorIntent !== 'unknown') {
		if (advisorIntent.includes('fe')) feScore += 2;
		if (advisorIntent.includes('be')) beScore += 2;
		if (advisorIntent.includes('fullstack')) { feScore += 2; beScore += 2; }
		isCreate = advisorIntent.startsWith('create_');
	}

	console.log(`[Ensemble] scores: FE=${feScore}, BE=${beScore} | advisor=${advisorIntent} | prevRoute=${prevRoute} | openFile=${openFileSignal}`);

	// --- Empty workspace override ---
	const isEmpty = backendFileCount === 0 && frontendFileCount === 0;
	if (isEmpty && detectAppType(msg) && feScore === 0 && beScore === 0) {
		console.log('[Ensemble] Empty workspace + app noun → forcing create_fullstack');
		return { intent: 'general', isCreate: true };
	}

	// --- Final threshold: spec-defined gap rule ---
	// FE wins only if FE >= BE+2. BE wins only if BE >= FE+2. Otherwise → fullstack.
	if (feScore >= beScore + 2) return { intent: 'frontend', isCreate };
	if (beScore >= feScore + 2) return { intent: 'backend', isCreate };
	if (feScore > 0 || beScore > 0) {
		// Scores exist but gap < 2 → fullstack
		console.log('[Ensemble] Gap < 2 → fullstack');
		return { intent: 'general', isCreate };
	}

	// Both zero — unknown
	console.warn('[Ensemble] No signal. Returning unknown.');
	return { intent: 'unknown', isCreate };
}

// ---------------------------------------------------------------------------
// AgentMode — computed once per request, sealed, passed to all specialists
// ---------------------------------------------------------------------------

type AgentMode = 'create' | 'edit' | 'needs_context';

interface PhaseState {
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
function determineMode(
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
		/\bcreate (?:a )?(?:new )?(?:backend|frontend|api|app|service|microservice|server)\b/i,
		/\bbuild (?:a )?(?:new )?(?:backend|frontend|api|app|service|microservice|server)\b/i,
		/\bgenerate (?:a )?(?:new )?project\b/i,
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

/**
 * Build system prompt for a specialist.
 * @param mode - Sealed AgentMode for this request. Never recomputed.
 * @param currentSpecialist - 'be' or 'fe'. Controls prompt prefix. Separate from requestIntent.
 */
// ---------------------------------------------------------------------------
// FE Prompt Router — deterministic, keyword + workspace driven
// Priority: agent → typescript → mode → framework → feature
// ---------------------------------------------------------------------------

interface PromptRouterContext {
	userMessage: string;
	mode: AgentMode;
	activeFile: string | undefined;
	workspaceRoot: string | undefined;
	/** Raw content of package.json, if available */
	packageJson: string | undefined;
	openFiles: string[] | undefined;
}

// ---------------------------------------------------------------------------
// React workspace scanner — checks for .tsx files on disk (no keyword deps)
// ---------------------------------------------------------------------------
function workspaceHasTsx(workspaceRoot: string | undefined): boolean {
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

function buildFESystemPrompt(ctx: PromptRouterContext): string {
	const { userMessage, mode, activeFile, workspaceRoot, packageJson = '', openFiles = [] } = ctx;
	const msg = userMessage.toLowerCase();
	const pkg = packageJson.toLowerCase();
	const parts: string[] = [];
	const loaded: Array<{ name: string; reason: string }> = [];
	const skipped: string[] = [];

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

	// ── 1. Base prompts (always) ────────────────────────────────────────────
	load('agent', 'always loaded');
	load('typescript', 'always loaded');

	// ── 2. Mode (exactly one) ───────────────────────────────────────────────
	if (mode === 'create') load('create-mode', 'mode=create');
	else if (mode === 'edit') load('edit-mode', 'mode=edit');
	else load('needs-context-mode', 'mode=needs_context');

	// ── 3. React detection — filesystem-first, keyword-confirmed ────────────
	// Primary: package.json dependency OR .tsx/.jsx files on disk
	// Secondary: keywords (supplement only when no workspace signal)
	const pkgHasReact = pkg.includes('"react"') || pkg.includes('"react-dom"');
	const fsHasTsx = workspaceHasTsx(workspaceRoot);
	const activeIsTsx = activeFile ? ['.tsx', '.jsx'].includes(path.extname(activeFile).toLowerCase()) : false;
	const openFilesTsx = openFiles.some(f => ['.tsx', '.jsx'].includes(path.extname(f).toLowerCase()));
	const isReact = pkgHasReact || fsHasTsx || activeIsTsx || openFilesTsx
		// keyword fallback only when no workspace present
		|| (!workspaceRoot && (msg.includes('react') || msg.includes('tsx') || msg.includes('jsx')));

	// ── 4. HTML-only — ONLY when activeFile is .html AND project is NOT React
	const activeExt = activeFile ? path.extname(activeFile).toLowerCase() : '';
	const isHtmlOnly = !isReact && activeExt === '.html';

	// ── 5. Tailwind detection ────────────────────────────────────────────────
	const isTailwind = [
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

	// ── 7. Feature prompts — deterministic keyword maps ──────────────────────
	const FEATURE_KEYWORDS: Record<string, string[]> = {
		forms: ['login', 'register', 'signup', 'form', 'submit', 'validation', 'email', 'password', 'otp', 'zod', 'react-hook-form'],
		api: ['axios', 'fetch', 'api', 'endpoint', 'request', 'mutation', 'query', 'backend', 'auth', 'jwt'],
		routing: ['page', 'dashboard', 'login page', 'navigate', 'route', 'layout', 'protected route'],
		state: ['zustand', 'redux', 'store', 'context', 'provider', 'global state'],
		table: ['table', 'grid', 'column', 'pagination', 'datatable'],
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

function buildBESystemPrompt(
	userMessage: string,
	mode: AgentMode,
	activeFile?: string,
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

	console.log('PROMPTS LOADED (BE):', JSON.stringify(activePrompts, null, 2));
	return parts.join('\n\n');
}

function buildSystemPrompt(
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
		prompt = buildBESystemPrompt(userMessage, mode, activeFile);
	}

	if (readWriteMode === 'read') {
		prompt += `\n\nCRITICAL OVERRIDE:\nThis is a READ-ONLY request. Ignore previous instructions about outputting <file> blocks and avoiding explanations.\nYou MUST answer the user's question, provide code audits, explanations, or summaries as requested.\nUse standard markdown for your response. Provide clear explanations. DO NOT attempt to write or modify files using <file> blocks.`;
	}

	return prompt;
}


// ---------------------------------------------------------------------------
// BackendSummary — structured contract passed from BE phase to FE phase
// Replaces raw file injection: prevents context overflow and FE hallucinating
// APIs that don't match what BE actually generated.
// ---------------------------------------------------------------------------

interface BackendSummary {
	routes: string[];      // e.g. ["POST /api/auth/login", "GET /api/users/:id"]
	entities: string[];    // e.g. ["User", "Session", "Post"]
	auth: string;          // e.g. "JWT Bearer token in Authorization header"
	database: string;      // e.g. "PostgreSQL via Prisma"
	files: string[];       // relative paths written by BE
}

function extractBackendSummary(filesModified: string[], workspaceRoot: string): string {
	const summary: BackendSummary = {
		routes: [],
		entities: [],
		auth: 'Unknown',
		database: 'Unknown',
		files: filesModified,
	};

	for (const f of filesModified) {
		const absPath = path.isAbsolute(f) ? f : path.join(workspaceRoot, f);
		const content = readFileSafe(absPath);
		if (!content) continue;

		// Extract route definitions (Express-style)
		const routeMatches = content.matchAll(/(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi);
		for (const m of routeMatches) {
			if (m[1] && m[2]) summary.routes.push(`${m[1].toUpperCase()} ${m[2]}`);
		}

		// Extract entity/model names (TypeScript interfaces, classes, Prisma models)
		const entityMatches = content.matchAll(/(?:interface|class|model)\s+([A-Z][a-zA-Z]+)/g);
		for (const m of entityMatches) {
			if (!summary.entities.includes(m[1]!)) summary.entities.push(m[1]!);
		}

		// Detect auth strategy
		if (/jwt|jsonwebtoken/i.test(content)) summary.auth = 'JWT Bearer token';
		else if (/session|express-session/i.test(content)) summary.auth = 'Session-based';
		else if (/passport/i.test(content)) summary.auth = 'Passport.js';

		// Detect database
		if (/prisma/i.test(content)) summary.database = 'Prisma ORM';
		else if (/mongoose|mongodb/i.test(content)) summary.database = 'MongoDB/Mongoose';
		else if (/pg|postgres/i.test(content)) summary.database = 'PostgreSQL';
		else if (/mysql2?/i.test(content)) summary.database = 'MySQL';
		else if (/sqlite/i.test(content)) summary.database = 'SQLite';
	}

	// Deduplicate routes
	summary.routes = [...new Set(summary.routes)].slice(0, 20);

	return [
		summary.routes.length > 0 ? `API routes:\n${summary.routes.map(r => `  ${r}`).join('\n')}` : '',
		summary.entities.length > 0 ? `Entities: ${summary.entities.join(', ')}` : '',
		`Auth: ${summary.auth}`,
		`Database: ${summary.database}`,
	].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Fallback: extract code blocks with file paths from model output
// Used when the model ignores <tool_call> and just pastes code directly
// ---------------------------------------------------------------------------

interface FallbackEdit {
	path: string;
	content: string;
}

function cleanCodeBlock(content: string): string {
	content = content.trim();
	const match = content.match(/^```\w*\r?\n([\s\S]*?)\r?\n```$/);
	if (match) {
		return match[1]!.trim();
	}
	return content;
}

function extractFallbackEdits(text: string, openFiles?: string[], workspaceRoot?: string, userPrompt?: string, mode?: AgentMode): FallbackEdit[] {
	const edits: FallbackEdit[] = [];
	const seenPaths = new Set<string>();

	// =====================================================================
	// Pattern 0: <file path="relative/path.ext">content</file>
	// This is the primary output protocol instructed in agent.md.
	// Uses split-based parsing to handle both closed and truncated blocks.
	// =====================================================================
	if (/<file\s+path=["'][^"']+["']\s*>/i.test(text)) {
		console.log(`[Router] Pattern 0: <file> tags detected, parsing...`);
		const openTagRegex = /<file\s+path=["']([^"']+)["']\s*>/gi;
		const openTags: { path: string; startIndex: number; tagEnd: number }[] = [];
		let tagMatch;
		while ((tagMatch = openTagRegex.exec(text)) !== null) {
			openTags.push({
				path: tagMatch[1]!.trim(),
				startIndex: tagMatch.index,
				tagEnd: tagMatch.index + tagMatch[0].length,
			});
		}

		for (let i = 0; i < openTags.length; i++) {
			const tag = openTags[i]!;
			const afterTag = tag.tagEnd;

			// Determine the end of this block's content:
			// 1. A </file> closing tag for this block
			// 2. The start of the next <file> opening tag
			// 3. End of text (truncated output)
			let endIndex = text.length;
			const remainingText = text.substring(afterTag);

			// Look for </file> before the next <file> tag
			const closeMatch = remainingText.match(/<\/file>/i);
			const nextOpenMatch = i + 1 < openTags.length ? openTags[i + 1]!.startIndex : text.length;

			if (closeMatch && (afterTag + closeMatch.index!) < nextOpenMatch) {
				// Found a </file> that belongs to this block
				endIndex = afterTag + closeMatch.index!;
			} else {
				// No </file> found before next block or end — truncated
				endIndex = nextOpenMatch;
			}

			let content = text.substring(afterTag, endIndex).trim();
			content = content.replace(/<\/file>\s*$/i, '').trim();
			content = cleanCodeBlock(content);

			if (tag.path && content && content.length > 5 && !seenPaths.has(tag.path)) {
				seenPaths.add(tag.path);
				edits.push({ path: tag.path, content });
				console.log(`[Router] Pattern 0: extracted → "${tag.path}" (${content.length} chars)`);
			}
		}
	}

	// If Pattern 0 found any edits, return immediately — skip all other fallback patterns
	if (edits.length > 0) {
		console.log(`[Router] Pattern 0: ${edits.length} file block(s) extracted. Bypassing P1–P4.`);
		return edits;
	}
	console.log(`[Router] Pattern 0: no <file> blocks detected. Falling through to P1–P4.`);

	// Pattern 1: ```lang\n// filepath\ncontent```
	const p1 = /```\w*\s*\r?\n\s*\/\/\s*([\w./\\-]+\.\w+)\s*\r?\n([\s\S]*?)```/g;
	let match;
	while ((match = p1.exec(text)) !== null) {
		const p = match[1]!.trim();
		const c = match[2]!.trim();
		if (p && c && c.length > 10 && !seenPaths.has(p)) {
			seenPaths.add(p);
			edits.push({ path: p, content: c });
		}
	}

	// Pattern 2: File: path\n```\ncontent```
	const p2 = /(?:File|file|Path|path):\s*([\w./\\-]+\.\w+)\s*\r?\n\s*```\w*\r?\n([\s\S]*?)```/g;
	while ((match = p2.exec(text)) !== null) {
		const p = match[1]!.trim();
		const c = match[2]!.trim();
		if (p && c && c.length > 10 && !seenPaths.has(p)) {
			seenPaths.add(p);
			edits.push({ path: p, content: c });
		}
	}

	// Pattern 3: Code fenced block — any ```lang ... ```
	if (mode !== 'create') {
		const p3f = /```(?:jsx|tsx|javascript|js|typescript|ts|css|html|vue|svelte|json|sh|bash)\r?\n([\s\S]+?)```/g;
		while ((match = p3f.exec(text)) !== null) {
			const code = match[1]!.trim();
			if (code.length > 30 && !seenPaths.size) {
				const targetPath = inferFilePath(code, openFiles, workspaceRoot, userPrompt);
				if (targetPath && !seenPaths.has(targetPath)) {
					seenPaths.add(targetPath);
					edits.push({ path: targetPath, content: code });
				}
			}
		}
	}

	// Pattern 4 (CRITICAL): Raw unfenced code detection
	// The Qwen 3B model outputs raw code without any code fences or tool tags.
	// Detect if the response IS code by checking for structural markers.
	if (edits.length === 0 && workspaceRoot && mode !== 'create') {
		const code = extractRawCode(text);
		if (code && code.length > 30) {
			const targetPath = inferFilePath(code, openFiles, workspaceRoot, userPrompt);
			if (targetPath) {
				console.log(`[Router] Fallback P4: detected raw unfenced code → ${targetPath}`);
				edits.push({ path: targetPath, content: code });
			}
		}
	}

	return edits;
}

// ---------------------------------------------------------------------------
// JSX Symbol Validator
// Parses <ComponentName /> tags from generated .tsx/.jsx files.
// Verifies: (1) symbol imported, (2) import path resolves to real file.
// ---------------------------------------------------------------------------

interface JsxSymbolIssue {
	file: string;
	component: string;
	kind: 'missing_import' | 'missing_file';
	importPath?: string;
}

function validateJsxSymbols(
	generatedFiles: Array<{ path: string; content: string }>,
	workspaceRoot: string,
): JsxSymbolIssue[] {
	const issues: JsxSymbolIssue[] = [];

	// All relative paths available in this response
	const responsePathsRel = new Set(generatedFiles.map(f => f.path));

	// React built-in component names — never need an explicit import
	const REACT_BUILTINS = new Set([
		'React', 'Fragment', 'StrictMode', 'Suspense', 'Profiler',
	]);

	const RESOLVE_EXTS = [
		'', '.tsx', '.jsx', '.ts', '.js',
		'/index.tsx', '/index.jsx', '/index.ts', '/index.js',
	];

	for (const { path: filePath, content } of generatedFiles) {
		const ext = path.extname(filePath).toLowerCase();
		if (!['.tsx', '.jsx'].includes(ext)) continue;

		// ── Extract PascalCase JSX component names ──────────────────────────
		const usedComponents = new Set<string>();
		const jsxTagRe = /<([A-Z][A-Za-z0-9]*)(?:\s|\s*\/?>)/g;
		let m: RegExpExecArray | null;
		while ((m = jsxTagRe.exec(content)) !== null) {
			if (m[1]) usedComponents.add(m[1]);
		}
		if (usedComponents.size === 0) continue;

		// ── Extract imported symbols → importPath ───────────────────────────
		const importedSymbols = new Map<string, string>(); // symbol → raw import path

		// default: import Foo from './Foo'
		const defRe = /import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"]([^'"]+)['"]/g;
		while ((m = defRe.exec(content)) !== null) {
			if (m[1] && m[2]) importedSymbols.set(m[1], m[2]);
		}
		// named: import { Foo, Bar as B } from './foo'
		const namedRe = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
		while ((m = namedRe.exec(content)) !== null) {
			const iPath = m[2]!;
			const names = m[1]!.split(',')
				.map(s => s.trim().split(/\s+as\s+/).pop()!.trim())
				.filter(Boolean);
			for (const name of names) importedSymbols.set(name, iPath);
		}
		// namespace: import * as Icons from './icons'
		const nsRe = /import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"]([^'"]+)['"]/g;
		while ((m = nsRe.exec(content)) !== null) {
			if (m[1] && m[2]) importedSymbols.set(m[1], m[2]);
		}

		for (const comp of usedComponents) {
			if (REACT_BUILTINS.has(comp)) continue;

			// Check 1: symbol must be imported
			if (!importedSymbols.has(comp)) {
				console.log(`[Validator] missing ${comp} in ${filePath}`);
				issues.push({ file: filePath, component: comp, kind: 'missing_import' });
				continue;
			}

			// Check 2 & 3: import path must resolve to a real file
			const importPath = importedSymbols.get(comp)!;
			if (!importPath.startsWith('.')) continue; // skip node_modules

			const fileDir = path.dirname(filePath);
			const resolvedBase = path.normalize(path.join(fileDir, importPath));

			const existsInResponse = RESOLVE_EXTS.some(e =>
				responsePathsRel.has(resolvedBase + e) || responsePathsRel.has(resolvedBase),
			);
			const existsOnDisk = RESOLVE_EXTS.some(e => {
				try {
					return fs.existsSync(path.join(workspaceRoot, resolvedBase + e))
						|| fs.existsSync(path.join(workspaceRoot, resolvedBase));
				} catch { return false; }
			});

			if (!existsInResponse && !existsOnDisk) {
				console.log(`[Validator] missing file: ${resolvedBase} (import "${importPath}" → <${comp} /> in ${filePath})`);
				issues.push({ file: filePath, component: comp, kind: 'missing_file', importPath });
			}
		}
	}

	if (issues.length === 0) console.log('[Validator] all JSX symbols OK');
	return issues;
}

/** Build a repair prompt from JSX symbol validation issues. */
function buildJsxRepairPrompt(issues: JsxSymbolIssue[]): string {
	const byFile = new Map<string, JsxSymbolIssue[]>();
	for (const iss of issues) {
		if (!byFile.has(iss.file)) byFile.set(iss.file, []);
		byFile.get(iss.file)!.push(iss);
	}

	const lines: string[] = [
		'<validation_errors>',
		'JSX symbol validation failed. The following components are broken:',
		'',
	];
	for (const [file, fileIssues] of byFile) {
		lines.push(`File: ${file}`);
		for (const iss of fileIssues) {
			if (iss.kind === 'missing_import') {
				lines.push(`  - <${iss.component} /> used but NOT imported.`);
				lines.push(`    Fix: add  import ${iss.component} from "./${iss.component}";`);
			} else {
				lines.push(`  - <${iss.component} /> import path "${iss.importPath}" → file does not exist.`);
				lines.push(`    Fix: create the missing file OR correct the import path.`);
			}
		}
		lines.push('');
	}
	lines.push(
		'Rules:',
		'  1. Every JSX component must be imported before use.',
		'  2. Every import path must resolve to a file in this response or the workspace.',
		'  3. Re-emit ALL corrected files using <file path="...">...</file> format.',
		'</validation_errors>',
		'',
		'[Validator] repairing — output the fixed files now.',
	);
	return lines.join('\n');
}

/**
 * Detect raw unfenced code in model output.
 * Returns the code portion if the text looks like source code, null otherwise.
 */
function extractRawCode(text: string): string | null {
	const lines = text.split('\n');
	let codeLines: string[] = [];
	let nonCodeLines: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const isCode =
			// Import/require statements
			/^import\s+/.test(trimmed) ||
			/^from\s+['"]/.test(trimmed) ||
			/^const\s+\w+\s*=\s*require/.test(trimmed) ||
			// Export statements
			/^export\s+(default\s+)?/.test(trimmed) ||
			// Function/class/variable declarations
			/^(const|let|var|function|class|interface|type|enum)\s+/.test(trimmed) ||
			// JSX/HTML tags
			/^\s*<\/?[\w]+/.test(trimmed) ||
			/^\s*\/>/.test(trimmed) ||
			// CSS rules
			/^\s*[\w.-]+\s*\{/.test(trimmed) ||
			/^\s*[\w-]+\s*:.*[;{]/.test(trimmed) ||
			// Closing braces, parens
			/^[}\]);,]+$/.test(trimmed) ||
			// Return statements
			/^\s*return\s*[\s(]/.test(trimmed) ||
			// JSX attributes / className etc
			/^\s*(className|onClick|onChange|style|href|src|alt|type)=/.test(trimmed) ||
			// Arrow functions
			/=>\s*[{(]/.test(trimmed);

		if (isCode) {
			codeLines.push(line);
		} else {
			nonCodeLines.push(line);
		}
	}

	const totalNonEmpty = codeLines.length + nonCodeLines.length;
	if (totalNonEmpty < 3) return null;

	// If >60% of lines look like code, treat entire text as code
	const codeRatio = codeLines.length / totalNonEmpty;
	if (codeRatio >= 0.6) {
		// Strip any leading/trailing prose (e.g. "Here's the code:" or "I've created...")
		const allLines = text.split('\n');
		let startIdx = 0;
		let endIdx = allLines.length - 1;

		// Trim leading prose lines
		while (startIdx < allLines.length) {
			const l = allLines[startIdx]!.trim();
			if (!l || /^(import |export |const |let |var |function |class |<|\/\/|\/\*|\*|@|#|\{|\(|return )/.test(l)) break;
			startIdx++;
		}
		// Trim trailing prose lines
		while (endIdx > startIdx) {
			const l = allLines[endIdx]!.trim();
			if (!l || /^[}\]);]|^<\/|^\*\/|^export |^module\.exports/.test(l)) break;
			endIdx--;
		}

		const codeBlock = allLines.slice(startIdx, endIdx + 1).join('\n').trim();
		if (codeBlock.length > 30) {
			return codeBlock;
		}
	}

	return null;
}

function validateContentForExtension(filename: string, content: string, intent?: string): { valid: boolean; error?: string } {
	const ext = path.extname(filename).toLowerCase();
	const basename = path.basename(filename);

	const hasReactJSX = /import\s+React|from\s+['"]react['"]|useState\s*\(|useEffect\s*\(|useRef\s*\(|useMemo\s*\(|useCallback\s*\(|className\s*=\s*|htmlFor\s*=\s*|onClick\s*=\s*\{|style\s*=\s*\{\{/.test(content);
	const hasTS = /\b(?:interface|namespace)\s+\w+\s*\{|\btype\s+\w+\s*=\s*[^;=]+;|\bas\s+(?:string|number|boolean|any|object|unknown|never)\b|:\s*(?:string|number|boolean|any|void|unknown|never|Record<|Array<)\b/.test(content);
	const hasHTML = /<!DOCTYPE|<html|<head|<body|<div\b|<span\b|<p\b|<a\s+href=|<\/\w+>/.test(content);
	const hasJS = /\b(?:const|let|var)\s+\w+\s*=|^\s*import\s+[\w{}*,\s]+\s+from\s+['"]|^\s*export\s+(?:default|const|let|var|class|function)\b|\bfunction\s+\w+\s*\(|\bconsole\.log\b/m.test(content);

	if (ext === '.js') {
		if (hasReactJSX) {
			if (intent === 'backend') {
				return { valid: false, error: `React/JSX syntax detected in ${basename}.\n\nThis is a BACKEND Node.js project. You MUST write backend JavaScript/TypeScript.\nDo NOT generate frontend React, JSX, or TSX code.\n\nRe-emit only the corrected backend file.` };
			} else {
				return { valid: false, error: `React/JSX syntax detected in ${basename}.\n\nThis project is currently a vanilla HTML/CSS/JavaScript project.\n\nYou MUST rewrite the code using vanilla JavaScript.\nDo NOT create React, JSX, TSX, or framework files.\n\nRe-emit only the corrected file.` };
			}
		}
		if (hasTS) {
			return { valid: false, error: 'TypeScript syntax (type annotations, interfaces) is not allowed in plain JavaScript (.js) files.' };
		}
	} else if (ext === '.ts') {
		if (hasReactJSX) {
			return { valid: false, error: 'React/JSX syntax is not allowed in plain TypeScript (.ts) files. Use .tsx instead.' };
		}
	} else if (ext === '.css') {
		if (hasHTML) {
			return { valid: false, error: 'HTML tags are not allowed in CSS (.css) files.' };
		}
		if (hasJS || hasReactJSX) {
			return { valid: false, error: 'JavaScript or React code is not allowed in CSS (.css) files.' };
		}
	} else if (ext === '.html' || ext === '.htm') {
		if (hasReactJSX) {
			return { valid: false, error: 'React/JSX code is not allowed in HTML (.html) files.' };
		}
		if ((content.includes('import ') || content.includes('export ')) && !content.includes('<script')) {
			return { valid: false, error: 'JavaScript imports/exports are not allowed in HTML files outside of <script> tags.' };
		}
	}

	return { valid: true };
}

// ---------------------------------------------------------------------------
// Part A — Path validation (rejects directories, escapes, missing parents)
// ---------------------------------------------------------------------------

function validateTargetPath(
	resolvedPath: string,
	workspaceRoot: string,
	rawPathArg: string
): { valid: boolean; error?: string } {
	// 1. Must stay inside workspace
	const absRoot = path.resolve(workspaceRoot);
	if (!resolvedPath.startsWith(absRoot + path.sep) && resolvedPath !== absRoot) {
		return { valid: false, error: `Path "${rawPathArg}" escapes the workspace root. Write rejected.` };
	}

	// 2. Trailing slash or no extension and already exists as dir → directory target
	if (rawPathArg.endsWith('/') || rawPathArg.endsWith('\\')) {
		return { valid: false, error: `Path "${rawPathArg}" is a directory (trailing slash). Provide a file path with an extension, e.g. controllers/users.ts` };
	}

	// 3. Path resolves to an existing directory on disk
	try {
		const stat = fs.statSync(resolvedPath);
		if (stat.isDirectory()) {
			return { valid: false, error: `Path "${rawPathArg}" resolves to a directory on disk (EISDIR). Provide a full file path with an extension.` };
		}
	} catch { /* file doesn't exist yet — that's fine */ }

	// 4. Must have a file extension
	if (!path.extname(resolvedPath)) {
		return { valid: false, error: `Path "${rawPathArg}" has no file extension. Provide a valid file path (e.g. src/utils/helpers.ts).` };
	}

	// 5. Parent directory must either exist or be creatable inside the workspace
	const parentDir = path.dirname(resolvedPath);
	if (!parentDir.startsWith(absRoot)) {
		return { valid: false, error: `Parent directory of "${rawPathArg}" is outside the workspace. Write rejected.` };
	}

	return { valid: true };
}

// ---------------------------------------------------------------------------
// Part B — Pending Edits Store (diff / approval workflow)
// ---------------------------------------------------------------------------

interface PendingEdit {
	relPath: string;           // relative to workspaceRoot
	absPath: string;
	newContent: string;
	oldContent: string | null; // null = new file
	diff: string;              // unified diff
}

interface PendingSession {
	id: string;
	workspaceRoot: string;
	query: string;
	edits: PendingEdit[];
	createdAt: number;
}

function generateUnifiedDiff(oldContent: string | null, newContent: string, relPath: string): string {
	const oldLines = (oldContent ?? '').split('\n');
	const newLines = newContent.split('\n');
	const header = `--- a/${relPath}\n+++ b/${relPath}\n`;

	// Simple line-level diff (Myers-style via longest common subsequence)
	const lcs = buildLCS(oldLines, newLines);
	const hunks: string[] = [];
	let ol = 0, nl = 0, lc = 0;
	const changes: Array<{ type: '+' | '-' | ' '; line: string }> = [];

	while (ol < oldLines.length || nl < newLines.length) {
		if (lc < lcs.length && ol === lcs[lc]!.old && nl === lcs[lc]!.nw) {
			changes.push({ type: ' ', line: oldLines[ol]! });
			ol++; nl++; lc++;
		} else if (nl < newLines.length && (lc >= lcs.length || nl < lcs[lc]!.nw)) {
			changes.push({ type: '+', line: newLines[nl]! });
			nl++;
		} else {
			changes.push({ type: '-', line: oldLines[ol]! });
			ol++;
		}
	}

	// Group into hunks (context = 3 lines)
	const CONTEXT = 3;
	const changeIndices = changes.map((c, i) => c.type !== ' ' ? i : -1).filter(i => i >= 0);
	if (changeIndices.length === 0) return header + '(no changes)';

	const ranges: Array<[number, number]> = [];
	let start = Math.max(0, changeIndices[0]! - CONTEXT);
	let end = Math.min(changes.length - 1, changeIndices[0]! + CONTEXT);
	for (let i = 1; i < changeIndices.length; i++) {
		const next = changeIndices[i]!;
		if (next - CONTEXT <= end + CONTEXT) {
			end = Math.min(changes.length - 1, next + CONTEXT);
		} else {
			ranges.push([start, end]);
			start = Math.max(0, next - CONTEXT);
			end = Math.min(changes.length - 1, next + CONTEXT);
		}
	}
	ranges.push([start, end]);

	for (const [s, e] of ranges) {
		const slice = changes.slice(s, e + 1);
		const oldStart = s + 1;
		const oldCount = slice.filter(c => c.type !== '+').length;
		const newStart = s + 1;
		const newCount = slice.filter(c => c.type !== '-').length;
		hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
		for (const c of slice) hunks.push(`${c.type}${c.line}`);
	}

	return header + hunks.join('\n');
}

function buildLCS(a: string[], b: string[]): Array<{ old: number; nw: number }> {
	// Patience diff — find longest common subsequence via index matching
	const bMap = new Map<string, number[]>();
	for (let i = 0; i < b.length; i++) {
		const key = b[i]!;
		if (!bMap.has(key)) bMap.set(key, []);
		bMap.get(key)!.push(i);
	}
	const pairs: Array<{ old: number; nw: number }> = [];
	let lastNw = -1;
	for (let oi = 0; oi < a.length; oi++) {
		const matches = bMap.get(a[oi]!) ?? [];
		for (const ni of matches) {
			if (ni > lastNw) {
				pairs.push({ old: oi, nw: ni });
				lastNw = ni;
				break;
			}
		}
	}
	return pairs;
}

// In-memory store: sessionId → PendingSession
const pendingStore = new Map<string, PendingSession>();

function createPendingSession(
	workspaceRoot: string,
	query: string,
	rawEdits: Array<{ path: string; content: string }>
): PendingSession {
	const id = `ps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const edits: PendingEdit[] = rawEdits.map(e => {
		const absPath = path.resolve(workspaceRoot, e.path);
		const relPath = path.relative(workspaceRoot, absPath);
		let oldContent: string | null = null;
		try { oldContent = fs.readFileSync(absPath, 'utf-8'); } catch { /* new file */ }
		const diff = generateUnifiedDiff(oldContent, e.content, relPath);
		return { relPath, absPath, newContent: e.content, oldContent, diff };
	});
	const session: PendingSession = { id, workspaceRoot, query, edits, createdAt: Date.now() };
	pendingStore.set(id, session);
	// Auto-expire after 10 minutes
	setTimeout(() => pendingStore.delete(id), 10 * 60 * 1000);
	return session;
}

function applyPendingSession(session: PendingSession): { written: string[]; errors: string[] } {
	const written: string[] = [];
	const errors: string[] = [];
	for (const edit of session.edits) {
		try {
			const dir = path.dirname(edit.absPath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(edit.absPath, edit.newContent, 'utf-8');
			written.push(edit.relPath);
			console.log(`[PendingStore] ✅ Applied: ${edit.relPath}`);
		} catch (e: any) {
			errors.push(`${edit.relPath}: ${e.message}`);
			console.error(`[PendingStore] ❌ Failed: ${edit.relPath} — ${e.message}`);
		}
	}
	return { written, errors };
}

/**
 * Determine the most appropriate file path for a piece of code.
 * Uses: open files, user prompt keywords, and code content analysis.
 */
function inferFilePath(code: string, openFiles?: string[], workspaceRoot?: string, userPrompt?: string): string {
	// Try to determine from the code content
	const isReact = /import\s+React|from\s+['"]react['"]|jsx|tsx|<\w+[\s/>]/.test(code);
	const isHTML = /<!DOCTYPE|<html|<head|<body/.test(code);
	const isCSS = /@media|@import|@keyframes|\.[\w-]+\s*\{|#[\w-]+\s*\{/.test(code) && !isReact;
	const isVue = /<template>|<script setup|defineComponent/.test(code);
	const isTS = /(?:interface|type|public|private|readonly|namespace)\s+\w+/.test(code) && !isHTML && !isCSS && !isReact;
	const isJS = /(?:const|let|var|function|console\.log|import|export|class)\b/.test(code) && !isHTML && !isCSS && !isReact;

	// 1. Check if user mentions a specific file name (highest priority)
	if (userPrompt) {
		const fileMatch = userPrompt.match(/(?:file|create|make|write|save|name(?:d)?)\s+(?:it\s+)?(?:as\s+|to\s+)?['"]?([\w./\\-]+\.\w+)['"]?/i);
		if (fileMatch) {
			return fileMatch[1]!;
		}
	}

	// 2. If there's exactly one open file, write to it (high priority, ignores model content inference)
	if (openFiles && openFiles.length === 1 && workspaceRoot) {
		return path.relative(workspaceRoot, openFiles[0]!);
	}

	// 3. Determine from project structure if we have a workspace
	if (workspaceRoot) {
		// Check if src/ directory exists
		const hasSrc = fs.existsSync(path.join(workspaceRoot, 'src'));
		const prefix = hasSrc ? 'src/' : '';

		if (isHTML) return `${prefix}index.html`;
		if (isCSS) return `${prefix}styles.css`;
		if (isVue) return `${prefix}App.vue`;
		if (isReact) return `${prefix}App.jsx`;
		if (isTS) return `${prefix}index.ts`;
		if (isJS) return `${prefix}index.js`;
		return `${prefix}App.jsx`; // Default for code output
	}

	// 4. No workspace - best guess
	if (isHTML) return 'index.html';
	if (isCSS) return 'styles.css';
	if (isVue) return 'App.vue';
	if (isReact) return 'App.jsx';
	if (isTS) return 'index.ts';
	if (isJS) return 'index.js';
	return 'App.jsx';
}

// ---------------------------------------------------------------------------
// Server-side workspace tools (Node.js fs)
// ---------------------------------------------------------------------------

function buildDirectoryTree(dirPath: string, indent: string = '', depth: number = 0, maxDepth: number = 3): string {
	if (depth >= maxDepth) return indent + '...\n';
	try {
		const entries = fs.readdirSync(dirPath, { withFileTypes: true });
		const skipDirs = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.vscode', '__pycache__', '.cache', '.svelte-kit']);
		const lines: string[] = [];

		const sorted = [...entries].sort((a, b) => {
			if (a.isDirectory() && !b.isDirectory()) return -1;
			if (!a.isDirectory() && b.isDirectory()) return 1;
			return a.name.localeCompare(b.name);
		});

		for (const entry of sorted) {
			if (entry.isDirectory()) {
				if (skipDirs.has(entry.name)) {
					lines.push(`${indent}${entry.name}/ (skipped)`);
					continue;
				}
				lines.push(`${indent}${entry.name}/`);
				lines.push(buildDirectoryTree(path.join(dirPath, entry.name), indent + '  ', depth + 1, maxDepth));
			} else {
				lines.push(`${indent}${entry.name}`);
			}
		}
		return lines.join('\n');
	} catch {
		return '';
	}
}

function readFileSafe(filePath: string): string | null {
	try {
		const stat = fs.statSync(filePath);
		if (stat.size > 100_000) return `(file too large: ${(stat.size / 1024).toFixed(0)}KB)`;
		return fs.readFileSync(filePath, 'utf-8');
	} catch {
		return null;
	}
}

function extractReferencedFiles(message: string, workspaceRoot: string): string[] {
	const filePatterns = message.match(/(?:^|[\s'"`(])([./]?(?:[\w.-]+\/)*[\w.-]+\.(?:json|jsx|tsx|js|ts|css|html|md|vue|svelte|py|rs|go|yaml|yml|toml|env|sh|lock|mjs|cjs))\b/gm);
	if (!filePatterns) return [];

	const files: string[] = [];
	const seen = new Set<string>();

	for (let match of filePatterns) {
		match = match.trim().replace(/^['"`(]/, '');
		const fullPath = path.isAbsolute(match) ? match : path.join(workspaceRoot, match);
		if (!seen.has(fullPath) && fs.existsSync(fullPath)) {
			seen.add(fullPath);
			files.push(fullPath);
		}
	}
	return files;
}

// ---------------------------------------------------------------------------
// Tool Execution Engine
// ---------------------------------------------------------------------------

interface ToolCallParsed {
	name: string;
	arguments: Record<string, any>;
}

interface ToolResult {
	success: boolean;
	output: string;
	diffMsg?: string;
}

function parseToolCall(text: string): { toolCall: ToolCallParsed; textBefore: string; textAfter: string } | null {
	const match = text.match(/([\s\S]*?)<tool_call>\s*([\s\S]*?)\s*<\/tool_call>([\s\S]*)/);
	if (!match) return null;

	try {
		const parsed = JSON.parse(match[2]!.trim());
		if (parsed.name && parsed.arguments) {
			return {
				toolCall: parsed as ToolCallParsed,
				textBefore: match[1]!.trim(),
				textAfter: match[3]!.trim(),
			};
		}
	} catch (e) {
		console.error(`[Router] Failed to parse tool call JSON:`, e);
	}
	return null;
}

function executeToolCall(
	tool: ToolCallParsed,
	workspaceRoot: string,
	openFiles?: string[],
	lastUserMsg?: string,
	intent?: string,
	readWriteMode?: 'read' | 'write'
): ToolResult {
	const resolvedPath = path.resolve(workspaceRoot, tool.arguments.path || '.');

	// Security: ensure the path stays within the workspace
	if (!resolvedPath.startsWith(path.resolve(workspaceRoot))) {
		return { success: false, output: 'Error: path is outside the workspace boundary.' };
	}

	switch (tool.name) {
		case 'listFiles': {
			try {
				const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
				const skipDirs = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out']);
				const listing = entries
					.filter(e => !skipDirs.has(e.name))
					.sort((a, b) => {
						if (a.isDirectory() && !b.isDirectory()) return -1;
						if (!a.isDirectory() && b.isDirectory()) return 1;
						return a.name.localeCompare(b.name);
					})
					.map(e => e.isDirectory() ? `${e.name}/` : e.name)
					.join('\n');
				return { success: true, output: listing || '(empty directory)' };
			} catch (e: any) {
				return { success: false, output: `Error listing directory: ${e.message}` };
			}
		}

		case 'readFile': {
			try {
				const content = fs.readFileSync(resolvedPath, 'utf-8');
				if (content.length > 100_000) {
					return { success: true, output: `(file too large: ${(content.length / 1024).toFixed(0)}KB — showing first 2000 chars)\n${content.substring(0, 2000)}` };
				}
				return { success: true, output: content };
			} catch (e: any) {
				return { success: false, output: `Error reading file: ${e.message}` };
			}
		}

		case 'writeFile': {
			try {
				// READ mode guard
				if (readWriteMode === 'read') {
					console.log(`[Router] READ mode — blocked write to: ${tool.arguments.path}`);
					return { success: false, output: `[READ MODE] File write blocked. This is a read-only request. No files will be modified.` };
				}

				// Part A — path safety validation
				const rawPathArg = tool.arguments.path || '';
				const pathValidation = validateTargetPath(resolvedPath, workspaceRoot, rawPathArg);
				if (!pathValidation.valid) {
					console.log(`[Router] Path validation failed: ${pathValidation.error}`);
					return { success: false, output: `Path Error: ${pathValidation.error}` };
				}

				const content = tool.arguments.content || '';
				const validation = validateContentForExtension(resolvedPath, content, intent);
				if (!validation.valid) {
					return { success: false, output: `Validation Error: ${validation.error}` };
				}

				// Part B — actual disk write instead of staging
				const oldContent = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf-8') : '';
				const relPath = path.relative(workspaceRoot, resolvedPath);
				const dir = path.dirname(resolvedPath);
				if (!fs.existsSync(dir)) {
					fs.mkdirSync(dir, { recursive: true });
				}

				// ─── Pipeline SHA trace (Stage 5–6) ───────────────────────────────
				const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
				const oldHash = sha(oldContent);
				const newHash = sha(content);
				const contentIdentical = oldHash === newHash;
				console.log(`[Writer] ${relPath} | old=${oldHash} new=${newHash} same=${contentIdentical}`);
				if (contentIdentical) {
					console.warn(`[Writer] ⚠️ IDENTICAL CONTENT — LLM generated the same code as disk. No change will be visible.`);
					console.log(`[Writer] Existing first 200: ${oldContent.slice(0, 200).replace(/\n/g, '␊')}`);
					console.log(`[Writer] Generated first 200: ${content.slice(0, 200).replace(/\n/g, '␊')}`);
				}

				fs.writeFileSync(resolvedPath, content, 'utf-8');

				// Stage 7: disk read-back verification
				const diskContent = fs.readFileSync(resolvedPath, 'utf-8');
				const diskHash = sha(diskContent);
				if (diskHash !== newHash) {
					console.error(`[Writer] ❌ DISK MISMATCH! written=${newHash} disk=${diskHash} — write failed silently!`);
				} else {
					console.log(`[Writer] ✓ Disk verified: ${diskHash}`);
				}

				// ─── Proper sequential line diff (not Set-based) ───────────────────────
				const oldLines = oldContent ? oldContent.split('\n') : [];
				const newLines = content.split('\n');
				// LCS-based: count lines added/deleted vs positional old
				let addedLines = 0;
				let deletedLines = 0;
				if (!contentIdentical) {
					const maxLen = Math.max(oldLines.length, newLines.length);
					for (let i = 0; i < maxLen; i++) {
						const o = oldLines[i];
						const n = newLines[i];
						if (o === undefined) addedLines++;        // new file has more lines
						else if (n === undefined) deletedLines++;  // old file has more lines
						else if (o !== n) { addedLines++; deletedLines++; } // line changed
					}
				}

				let diffMsg = '';
				if (addedLines > 0 || deletedLines > 0) {
					diffMsg = `\n\`\`\`diff\n`;
					if (addedLines > 0) diffMsg += `+ ${addedLines} lines added\n`;
					if (deletedLines > 0) diffMsg += `- ${deletedLines} lines deleted\n`;
					diffMsg += `\`\`\`\n`;
				} else {
					diffMsg = `\n\`\`\`diff\n  (No changes — LLM generated identical content)\n\`\`\`\n`;
				}

				console.log(`[Router] ✏️ Written: ${relPath} (+${addedLines}/-${deletedLines} lines)`);
				return { success: true, output: `WRITTEN:${relPath}`, diffMsg };
			} catch (e: any) {
				return { success: false, output: `Error staging file: ${e.message}` };
			}
		}

		default:
			return { success: false, output: `Unknown tool: ${tool.name}` };
	}
}

/** Helper to send a JSON chunk to the SSE stream */
function streamChunk(res: express.Response, content: string) {
	res.write(JSON.stringify({ message: { content } }) + '\n');
}

// ---------------------------------------------------------------------------
// Structured pipeline event system
// ---------------------------------------------------------------------------

interface PipelineEvent {
	type: 'progress' | 'success' | 'warning' | 'error' | 'info';
	stage: 'read' | 'plan' | 'generate' | 'write' | 'validate' | 'repair' | 'complete';
	message: string;
	file?: string;
}

/** Emit a structured progress event. Renders as markdown in existing chat UI;
 *  also carries typed `event` metadata for future frontend parsing. */
function streamEvent(res: express.Response, evt: PipelineEvent): void {
	const icon =
		evt.type === 'success' ? '✅'
			: evt.type === 'error' ? '❌'
				: evt.type === 'warning' ? '⚠️'
					: evt.stage === 'read' ? '🔍'
						: evt.stage === 'plan' ? '🗺️'
							: evt.stage === 'generate' || evt.stage === 'write' ? '⚙️'
								: evt.stage === 'validate' ? '🔬'
									: evt.stage === 'repair' ? '🔧'
										: evt.stage === 'complete' ? '✅'
											: '•';
	const markdown = `${icon} ${evt.message}\n`;
	res.write(JSON.stringify({ message: { content: markdown }, event: evt }) + '\n');
}

/** Detect whether the user is explicitly requesting to view generated code.
 *  When true, raw model output is shown rather than suppressed. */
function isExplicitCodeRequest(msg: string): boolean {
	return /\b(show|display|print|output|give me|return|see)\b.{0,30}\b(code|implementation|diff|changes|output|result|file)\b/i.test(msg)
		|| /\bshow (the )?(generated|full|complete|entire|updated)\b/i.test(msg)
		|| /\b(explain|walk me through|describe)\b.{0,20}\b(implementation|code|changes)\b/i.test(msg);
}

// ---------------------------------------------------------------------------
// Chat Completions — Agentic Tool-Calling Loop & Hardening Settings
// ---------------------------------------------------------------------------

const MAX_TOKENS = 4096;
const REPEAT_PENALTY = 1.15;
const REPEAT_PENALTY_TOKENS = 64;
const REQUEST_TIMEOUT_MS = 3600000; // 60 minutes (3600 seconds)
const MAX_AGENT_ITERATIONS = 6; // 3 for BE pass + 3 for FE pass in full-stack mode
const MAX_CORRECTIONS_PER_FILE = 3;
const MAX_TOTAL_CORRECTIONS = 5;

function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Monitors generated output stream to detect repetition patterns and stagnant growth.
 */
function detectRepetitionLoop(text: string): { detected: boolean; reason?: string } {
	if (text.length < 200) return { detected: false };

	// 1. Suffix loop check — true loop means the TAIL of output is stuck repeating.
	// Use larger window (400 chars) and require matches to cluster at the end,
	// not simply appear anywhere in the window (catches import blocks with same identifier).
	const windowSizes = [30, 50]; // 20 removed — too short, matches identifiers like ", controller"
	for (const size of windowSizes) {
		const suffix = text.substring(text.length - size).trim();
		if (!suffix || suffix.length < size * 0.6) continue; // skip if suffix is mostly whitespace

		const recentText = text.substring(Math.max(0, text.length - 400));
		const allMatches: number[] = [];
		const escaped = escapeRegExp(suffix);
		const re = new RegExp(escaped, 'g');
		let m: RegExpExecArray | null;
		while ((m = re.exec(recentText)) !== null) {
			allMatches.push(m.index);
		}

		if (allMatches.length < 6) continue; // threshold raised: <6 matches is not a loop

		// Clustering check: a real loop has matches bunched at the end of the window.
		// If the last 3 matches are all in the final 60% of the window → loop confirmed.
		const windowLen = recentText.length;
		const tail3 = allMatches.slice(-3);
		const allInTail = tail3.every(idx => idx >= windowLen * 0.4);
		if (allInTail) {
			return { detected: true, reason: `Suffix loop: "${suffix}" repeated ${allMatches.length} times in recent output` };
		}
	}

	// 2. Line repetition check — same line must appear 4+ times in last 8 lines (was 3 in 6)
	const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	if (lines.length >= 8) {
		const lastLine = lines[lines.length - 1]!;
		if (lastLine.length > 15) { // must be a non-trivial line (raised from 10)
			let repeatCount = 0;
			for (let i = lines.length - 2; i >= Math.max(0, lines.length - 8); i--) {
				if (lines[i] === lastLine) repeatCount++;
			}
			if (repeatCount >= 4) {
				return { detected: true, reason: `Line repetition loop: "${lastLine}" repeated ${repeatCount + 1} times` };
			}
		}
	}

	// 3. Stagnation check — extremely limited character set
	if (text.length >= 200) {
		const recent = text.substring(text.length - 150);
		const uniqueChars = new Set(recent).size;
		if (uniqueChars < 5) {
			return { detected: true, reason: `Stagnation: only ${uniqueChars} unique characters in the last 150 characters` };
		}
	}

	// 4. File-block repetition check — same <file path="..."> tag 3+ times
	const fileTagMatches = text.match(/<file\s+path="([^"]+)"/gi) || [];
	if (fileTagMatches.length >= 3) {
		const tagCounts = new Map<string, number>();
		for (const tag of fileTagMatches) {
			const pathMatch = tag.match(/path="([^"]+)"/i);
			if (pathMatch?.[1]) {
				const p = pathMatch[1];
				tagCounts.set(p, (tagCounts.get(p) || 0) + 1);
			}
		}
		for (const [filePath, count] of tagCounts) {
			if (count >= 3) {
				return { detected: true, reason: `File-block loop: <file path="${filePath}"> repeated ${count} times` };
			}
		}
	}

	return { detected: false };
}

// ---------------------------------------------------------------------------
// RAG — Index workspace (POST /v1/index)
// ---------------------------------------------------------------------------

app.post('/v1/index', async (req, res) => {
	const { workspaceRoot } = req.body;
	if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
		return res.status(400).json({ error: 'Invalid or missing workspaceRoot.' });
	}
	if (!em.isReady) {
		return res.status(503).json({ error: 'Embedding model not ready yet. Retry in a moment.' });
	}
	// Respond immediately — indexing runs in background
	res.json({ status: 'indexing_started', workspaceRoot });
	indexWorkspace(workspaceRoot)
		.then(r => console.log(`[RAG] Index complete: ${r.chunks} chunks from ${r.files} files.`))
		.catch(e => console.error('[RAG] Index failed:', e));
});

// RAG — Incremental file update (POST /v1/index/file)
app.post('/v1/index/file', async (req, res) => {
	const workspaceRoot = req.body.workspaceRoot || config.workspace.defaultRoot;
	const { filePath, content } = req.body;
	if (!workspaceRoot || !filePath || content === undefined) {
		return res.status(400).json({ error: 'workspaceRoot, filePath, and content are required.' });
	}
	if (!em.isReady) return res.json({ status: 'skipped', reason: 'embedding model not ready' });
	res.json({ status: 'updating' });
	updateFile(workspaceRoot, filePath, content)
		.catch(e => console.error('[RAG] updateFile error:', e));
	// Tier-2: patch symbol/import/AST/ownership caches incrementally
	patchTier2Caches(workspaceRoot, filePath);
});

// RAG — Batch file deletion (POST /v1/index/delete)
app.post('/v1/index/delete', async (req, res) => {
	const workspaceRoot = req.body.workspaceRoot || config.workspace.defaultRoot;
	const { filePaths } = req.body;
	if (!workspaceRoot || !Array.isArray(filePaths) || filePaths.length === 0) {
		return res.status(400).json({ error: 'workspaceRoot and filePaths[] are required.' });
	}
	res.json({ status: 'deleting', count: filePaths.length });
	deleteFiles(workspaceRoot, filePaths)
		.catch(e => console.error('[RAG] deleteFiles error:', e));
});

// RAG — Startup sync (POST /v1/index/sync)
app.post('/v1/index/sync', async (req, res) => {
	const workspaceRoot = req.body.workspaceRoot || config.workspace.defaultRoot;
	if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
		return res.status(400).json({ error: 'Invalid or missing workspaceRoot.' });
	}
	const result = await syncWorkspace(workspaceRoot);
	res.json({ status: 'synced', purged: result.purged });
});

// RAG — Status check (GET /v1/index/status)
app.get('/v1/index/status', async (req, res) => {
	res.json({ ragReady: em.isReady });
});

// ---------------------------------------------------------------------------
// Request serialisation mutex
// Only one chat request runs at a time — prevents concurrent mm.acquire() calls
// from disposing a model that another request is actively generating into.
// ---------------------------------------------------------------------------

// Global abort controller — lets /v1/chat/abort terminate active generation
let activeController: AbortController | null = null;

app.post('/v1/chat/abort', (_req, res) => {
	if (activeController && !activeController.signal.aborted) {
		console.log('[Router] /v1/chat/abort — aborting active generation.');
		activeController.abort();
		res.json({ aborted: true });
	} else {
		res.json({ aborted: false, reason: 'No active generation' });
	}
});
let requestInFlight = false;
const requestQueue: Array<() => void> = [];

function acquireRequestSlot(): Promise<() => void> {
	return new Promise(resolve => {
		const release = () => {
			if (requestQueue.length > 0) {
				const next = requestQueue.shift()!;
				next();
			} else {
				requestInFlight = false;
			}
		};
		if (!requestInFlight) {
			requestInFlight = true;
			resolve(release);
		} else {
			requestQueue.push(() => {
				requestInFlight = true;
				resolve(release);
			});
		}
	});
}

app.post('/v1/chat/completions', async (req, res) => {
	if (!mm.status.loaded && mm.status.loading) {
		return res.status(503).json({ error: 'Model swap in progress. Retry in a moment.' });
	}

	// Serialise: queue this request until the current one finishes
	const releaseSlot = await acquireRequestSlot();

	let context: LlamaContext | null = null;
	const controller = new AbortController();
	activeController = controller; // register globally so /v1/chat/abort can reach it

	const abortGeneration = () => {
		if (!controller.signal.aborted) {
			console.log('[Router] Client disconnected or request aborted, aborting generation.');
			controller.abort();
		}
	};
	req.on('close', abortGeneration);
	req.on('aborted', abortGeneration);
	res.on('close', abortGeneration);

	const timeoutId = setTimeout(() => {
		console.error(`[Router] Request timeout of ${REQUEST_TIMEOUT_MS}ms exceeded. Aborting.`);
		controller.abort();
	}, REQUEST_TIMEOUT_MS);

	// Part B — tracking written files for current request
	// filesModified tracks actual disk writes during this session
	const fileWriteAttempts = new Map<string, number>();
	let totalCorrections = 0;
	const responseHistory: string[] = [];

	try {
		const workspaceRoot = req.body.workspaceRoot || config.workspace.defaultRoot;
		const { messages, stream, openFiles } = req.body;
		const hasWorkspace = workspaceRoot && fs.existsSync(workspaceRoot);

		console.log(`\n[Router] ========== INCOMING REQUEST ==========`);
		console.log(`[Router] Messages: ${messages?.length || 0}, workspace: ${workspaceRoot || 'none'}, openFiles: ${openFiles?.length || 0}`);

		// ---------------------------------------------------------------
		// SERVER-SIDE CONTEXT GATHERING
		// ---------------------------------------------------------------
		const contextBlocks: string[] = [];
		let backendFileCount = 0;
		let frontendFileCount = 0;
		let pkgContent: string = '';

		if (hasWorkspace) {
			const tree = buildDirectoryTree(workspaceRoot);
			if (tree) {
				contextBlocks.push(`--- Workspace Tree ---\n${tree}`);
				console.log(`[Router] Injected workspace tree (${tree.length} chars)`);

				const lines = tree.split('\n');
				for (const line of lines) {
					if (/\b(?:server\.ts|app\.ts|routes|controllers|services|models|middleware|repositories|prisma|typeorm)\b/i.test(line)) backendFileCount++;
					if (/\.(tsx|jsx)$/i.test(line) || /\b(?:pages|components|layouts|hooks|stores|public)\b/i.test(line)) frontendFileCount++;
				}
				console.log(`[Router] Specialist files detected: BE=${backendFileCount}, FE=${frontendFileCount}`);
			}

			const pkgPath = path.join(workspaceRoot, 'package.json');
			pkgContent = readFileSafe(pkgPath) ?? '';
			if (pkgContent) {
				contextBlocks.push(`--- File: package.json ---\n${pkgContent}`);
				console.log(`[Router] Injected package.json`);
			}
		}

		if (openFiles && Array.isArray(openFiles)) {
			const seen = new Set<string>();
			for (const filePath of openFiles) {
				if (seen.has(filePath)) continue;
				seen.add(filePath);
				const content = readFileSafe(filePath);
				if (content) {
					const relPath = workspaceRoot ? path.relative(workspaceRoot, filePath) : path.basename(filePath);
					contextBlocks.push(`--- File: ${relPath} ---\n${content}`);
					console.log(`[Router] Injected open file: ${relPath}`);
				}
			}
		}

		const lastUserMsg = messages?.[messages.length - 1]?.content || '';
		if (workspaceRoot) {
			const referencedFiles = extractReferencedFiles(lastUserMsg, workspaceRoot);
			const alreadySeen = new Set(openFiles || []);
			for (const filePath of referencedFiles) {
				if (alreadySeen.has(filePath)) continue;
				alreadySeen.add(filePath);
				const content = readFileSafe(filePath);
				if (content) {
					const relPath = path.relative(workspaceRoot, filePath);
					contextBlocks.push(`--- File: ${relPath} ---\n${content}`);
					console.log(`[Router] Auto-resolved referenced file: ${relPath}`);
				}
			}
		}

		// ---------------------------------------------------------------
		// RAG RETRIEVAL — inject relevant chunks BEFORE sending to Qwen
		// ---------------------------------------------------------------
		// Resolve specialist domain for RAG filtering (before intent is finalised below)
		const ragSpecialist: 'frontend' | 'backend' | 'general' =
			detectFrontendIntent(messages) && !detectBackendIntent(messages) ? 'frontend'
				: detectBackendIntent(messages) && !detectFrontendIntent(messages) ? 'backend'
					: 'general';

		if (hasWorkspace) {
			// Tier-2 retrieval — deterministic-first (symbol → AST → graph → embedding fallback)
			const openFileForRAG = openFiles && openFiles.length > 0 ? openFiles[0] : undefined;
			const ragContext = await tier2Retrieve({
				workspaceRoot,
				query: lastUserMsg,
				advisorIntent: null, // will be set after advisor pass below — RAG runs before for now
				openFile: openFileForRAG,
				routerIntent: ragSpecialist,
			});
			if (ragContext) {
				contextBlocks.push(`--- Retrieved Context (Tier-2 RAG) ---\n${ragContext}`);
				console.log(`[RAG] Tier-2 context injected. Specialist: ${ragSpecialist}`);
			}
		}

		// Agent mode is now computed per specialist, not globally.
		// We remove the global sealed mode variable.

		let enrichedLastMessage = lastUserMsg;
		if (contextBlocks.length > 0) {
			enrichedLastMessage = contextBlocks.join('\n\n') + '\n\n--- User Request ---\n' + lastUserMsg;
		}

		console.log(`[Router] Context blocks: ${contextBlocks.length}, final prompt: ${enrichedLastMessage.length} chars`);

		// ---------------------------------------------------------------
		// READ / WRITE mode classification
		// ---------------------------------------------------------------
		const readWriteMode = classifyIntent(lastUserMsg);
		console.log(`[Router] READ/WRITE mode: ${readWriteMode}`);

		// ---------------------------------------------------------------
		// MODEL SETUP — VRAM swap via ModelManager
		// Intent resolved entirely by ensemble scoring below.
		// ---------------------------------------------------------------
		let intent: 'frontend' | 'backend' | 'general';

		// --- CONSTRAINT PARSER (highest priority — runs before advisor) ---
		const userScope = parseUserScope(lastUserMsg);

		// --- ADVISOR PASS + ENSEMBLE SCORING ---
		// 1. Run 0.6B advisor (stateless, silent, load-on-demand). Gets +3 vote.
		// 2. Also attempts to extract V2 rich fields (arch, modules, features).
		// 3. Fuse with open file, previous route, workspace, keywords.
		// 4. Advisor unloads after classification — VRAM freed before specialist loads.
		console.log('[Router] Running Advisor V2 pass...');
		const advisorResult = await runAdvisor(lastUserMsg, true);
		const advisorIntent: AdvisorIntent | null = advisorResult.intent;
		const advisorV2Result: AdvisorV2Result | null = advisorResult.v2Result;

		const { intent: ensembledIntent, isCreate: advisorSaysCreate } = ensembleRoute(
			advisorIntent,
			openFiles,
			messages,
			backendFileCount,
			frontendFileCount,
			lastUserMsg,
		);

		// Unknown intent — cannot route safely. Respond with clarification request.
		if (ensembledIntent === 'unknown') {
			console.warn('[Router] Unknown intent after ensemble. Sending clarification response.');
			res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Could you clarify whether this request is for the frontend (UI), backend (API/database), or both?' } }] })}\n\n`);
			res.write('data: [DONE]\n\n');
			res.end();
			return;
		}

		// --- SCOPE MASKING (constraint parser overrides ensemble) ---
		// intent assigned below by scope mask
		if (userScope === 'BACKEND_ONLY') {
			intent = 'backend';
			console.log('[Router] Scope mask: BACKEND_ONLY → intent=backend (FE phase disabled)');
		} else if (userScope === 'FRONTEND_ONLY') {
			intent = 'frontend';
			console.log('[Router] Scope mask: FRONTEND_ONLY → intent=frontend (BE phase disabled)');
		} else {
			intent = ensembledIntent as 'frontend' | 'backend' | 'general';
		}

		// Preserve the raw advisor intent string (create_fullstack / edit_be / etc.)
		// for cross-specialist skip decision. The ensembled intent collapses to 'general'
		// for fullstack, losing the create vs edit distinction — store raw here.
		const rawAdvisorIntent: string = advisorIntent ?? ensembledIntent;

		// --- PLANNER CONTRACT (deterministic, no model call) ---
		const plannerContract = buildPlannerContract(lastUserMsg, rawAdvisorIntent);
		const validationContract = plannerContractToValidationContract(plannerContract, userScope);

		// filesModified is shared between incremental engine and the monolithic fallback loop
		const filesModified: string[] = [];


		// ---------------------------------------------------------------
		// VNEXT INCREMENTAL PIPELINE (Phase 1 — backend + fullstack create)
		// Attempt dependency-aware generation first.
		// Falls through to existing monolithic loop on any failure.
		// ---------------------------------------------------------------
		if (readWriteMode !== 'read' && hasWorkspace && advisorSaysCreate && intent !== 'frontend') {
			try {
				// ── 1. Workspace inspection ────────────────────────────────
				const plannedModules = advisorV2Result?.modules ?? plannerContract.requiredFolders;
				const inspection = inspectWorkspace(workspaceRoot, plannedModules);

				// ── 2. Build execution graph from V2 result ────────────────
				const v2ForGraph: AdvisorV2Result = advisorV2Result ?? ((): AdvisorV2Result => {
					const base: AdvisorV2Result = { intent: rawAdvisorIntent, language: plannerContract.language, requiredFeatures: plannerContract.requiredFeatures };
					if (plannerContract.architecture !== 'unknown' && plannerContract.architecture) { base.architecture = plannerContract.architecture!; }
					if (plannerContract.framework !== 'unknown') base.framework = plannerContract.framework;
					if (plannedModules.length > 0) base.modules = plannedModules;
					return base;
				})();


				const graph = buildExecutionGraph(v2ForGraph, inspection);

				// ── 3. Decide whether incremental engine is worthwhile ─────
				const useIncremental = readWriteMode === 'write' && shouldUseIncrementalEngine({
					intent: intent,
					isCreate: advisorSaysCreate,
					graph: graph,
					minNodes: 3,
				});

				console.log(`[Router] VNext incremental: graph=${graph ? graph.nodes.length + ' nodes' : 'null'} useIncremental=${useIncremental}`);

				if (useIncremental && graph) {
					// ── 4. Acquire BE model ────────────────────────────────────
					const incrModel = await mm.acquire(intent === 'general' ? 'backend' : intent);

					// ── 5. Build capability-enriched system prompt ─────────────
					const features = v2ForGraph.requiredFeatures ?? plannerContract.requiredFeatures;
					const architecture = v2ForGraph.architecture ?? plannerContract.architecture;
					const baseBePrompt = buildBESystemPrompt(lastUserMsg, 'create', openFiles?.[0]);
					const incrSysPrompt = buildCapabilitySystemPrompt(baseBePrompt, features, architecture);

					// ── 6. Set up SSE stream ───────────────────────────────────
					res.setHeader('Content-Type', 'text/event-stream');
					res.setHeader('Cache-Control', 'no-cache');
					res.setHeader('Connection', 'keep-alive');
					streamChunk(res, `🦀 **Workspace**\n\n`);
					streamEvent(res, { type: 'info', stage: 'read', message: 'Reading workspace...' });
					if (pkgContent) streamEvent(res, { type: 'success', stage: 'read', message: 'package.json loaded' });
					if (openFiles && openFiles.length > 0) streamEvent(res, { type: 'success', stage: 'read', message: `${openFiles.length} open file(s) loaded` });
					streamEvent(res, { type: 'info', stage: 'plan', message: `Planning: ${plannerContract.scope} · ${graph.nodes.length} file(s) across ${graph.generationOrder.length} stage(s)` });

					// ── 7. Run incremental engine ──────────────────────────────
					const incrResult = await runIncrementalEngine({
						graph,
						workspaceRoot,
						model: incrModel,
						systemPrompt: incrSysPrompt,
						userRequest: lastUserMsg,
						validationContract,
						res,
						signal: controller.signal,
						maxTokensPerFile: MAX_TOKENS,
						onFileCommitted(node, content) {
							if (!filesModified.includes(node.path)) filesModified.push(node.path);
						},
					});

					// ── 8. FE phase (if fullstack + needs frontend) ────────────
					const isFullStack = intent === 'general' || rawAdvisorIntent.includes('fullstack');
					const runFEAfterIncremental = isFullStack && promptNeedsFrontend(lastUserMsg) && userScope !== 'BACKEND_ONLY';

					if (runFEAfterIncremental && incrResult.committedFiles.length > 0) {
						// FE phase proceeds through the existing FE specialist path
						// (reuse existing FE loop below by falling through after early-return)
						// We set up so the code below the incremental block handles FE.
						console.log('[Router] Incremental BE done — triggering FE phase via existing path.');
						// NOTE: We proceed to FE phase using the filesModified list collected above.
						// The existing FE logic at the bottom of the handler will run.
					} else {
						// Done — finalize
						clearTimeout(timeoutId);
						res.write('data: [DONE]\n\n');
						res.end();
						if (workspaceRoot) cleanupArtifacts(workspaceRoot);
						console.log(`[Router] Incremental pipeline done. ${incrResult.committedFiles.length} files committed.`);
						return;
					}

					// If FE needed, fall through to the existing FE handler below.
					// We skip the monolithic BE loop by jumping to the FE section.
					// The existing FE loop uses filesModified; we've populated it above.
					// We need to jump to FE only — create a minimal context for the FE session.

					// --- FE specialist: acquire model, run FE loop (reuse existing code) ---
					{
						const ctxToDispose = context as import('node-llama-cpp').LlamaContext | null;
						context = null;
						if (ctxToDispose) await ctxToDispose.dispose();
					}


					const isFullStackExecution_incr = true;
					// We cannot jump to a label; instead we reconstruct the minimal state
					// needed for the FE section and call the existing FE logic path.
					// The cleanest way: set a flag and let the existing code handle it.
					// For now, the FE path is run inline below using the same extracted code.

					streamEvent(res, { type: 'info', stage: 'generate', message: 'Backend complete. Loading Frontend Specialist...' });
					const feModelIncr = await mm.acquire('frontend');
					const feMode = determineMode(lastUserMsg, 'fe', backendFileCount, frontendFileCount);
					const feActiveFile = openFiles?.[0];
					const feSysPromptI = buildSystemPrompt(lastUserMsg, hasWorkspace, feMode, 'fe', feActiveFile, workspaceRoot, pkgContent, openFiles, readWriteMode);
					const feCtxIncr = await feModelIncr.createContext({ contextSize: 4096 });
					context = feCtxIncr;
					const feSessionIncr = new LlamaChatSession({ contextSequence: feCtxIncr.getSequence(), systemPrompt: feSysPromptI });

					const summary = incrResult.committedFiles.length > 0
						? extractBackendSummary(incrResult.committedFiles, workspaceRoot)
						: '';
					const fePromptIncr = [
						`You are the Frontend Specialist. Generate ONLY frontend files for this request.`,
						`Do NOT generate backend, Node.js, Express, or server files.`,
						summary ? `--- Backend Summary ---\n${summary}` : '',
						`--- Original Request ---\n${lastUserMsg}`,
					].filter(Boolean).join('\n\n');

					const feInitFilesI = filesModified.length;
					// streamEvent(res, { type: 'progress', stage: 'generate', message: 'Generating frontend files...' });
					for (let feI = 0; feI < MAX_AGENT_ITERATIONS; feI++) {
						if (controller.signal.aborted) break;
						let feRespI = '';
						await feSessionIncr.prompt(feI === 0 ? fePromptIncr : fePromptIncr, {
							maxTokens: MAX_TOKENS,
							repeatPenalty: { penalty: REPEAT_PENALTY, lastTokens: REPEAT_PENALTY_TOKENS, penalizeNewLine: false },
							signal: controller.signal,
							stopOnAbortSignal: true,
							// Buffer internally — raw model tokens are never sent to chat
							onTextChunk(chunk) { feRespI += chunk; },
						});
						if (!workspaceRoot) break;
						const feEdits = extractFallbackEdits(feRespI, openFiles, workspaceRoot, lastUserMsg, feMode);
						if (feEdits.length > 0) {
							for (const edit of feEdits) {
								streamEvent(res, { type: 'progress', stage: 'write', message: `Writing \`${edit.path}\`...`, file: edit.path });
								const feWR = executeToolCall({ name: 'writeFile', arguments: { path: edit.path, content: edit.content } }, workspaceRoot, openFiles, lastUserMsg, 'frontend', readWriteMode);
								if (feWR.success) {
									if (!filesModified.includes(edit.path)) filesModified.push(edit.path);
									streamEvent(res, { type: 'success', stage: 'write', message: `Written \`${edit.path}\``, file: edit.path });
									if (feWR.diffMsg) streamChunk(res, feWR.diffMsg);
								}
							}
						}
						break;
					}

					if (filesModified.length > 0) {
						streamEvent(res, { type: 'success', stage: 'complete', message: `Complete · ${filesModified.length} file(s) updated` });
						streamChunk(res, `\n**Files updated:**\n${filesModified.map(f => `- \`${f}\``).join('\n')}\n`);
					}

					clearTimeout(timeoutId);
					res.write('data: [DONE]\n\n');
					res.end();
					if (workspaceRoot) cleanupArtifacts(workspaceRoot);
					console.log(`[Router] Incremental+FE done. ${filesModified.length} files total.`);
					return;
				} // end if useIncremental
			} catch (incrErr: any) {
				// Incremental pipeline failed — log and fall through to monolithic loop
				console.warn(`[Router] Incremental pipeline failed (${incrErr.message}). Falling back to monolithic loop.`);
				// Ensure context is disposed before monolithic loop re-acquires
				if (context) { await context.dispose(); context = null; }
				if (controller.signal.aborted || res.writableEnded) {
					console.log(`[Router] Request is aborted or closed, skipping monolithic fallback.`);
					clearTimeout(timeoutId);
					if (!res.writableEnded) res.end();
					releaseSlot();
					return;
				}
			}
		}
		// ---------------------------------------------------------------
		// END VNEXT — monolithic loop continues below (unchanged)
		// ---------------------------------------------------------------

		// Determine upfront whether this prompt requires frontend work.
		// This MUST be evaluated before BE phase runs — after BE finishes every touched
		// file will naturally be a backend file, so file-type inspection is useless.
		// Scope mask: BACKEND_ONLY hard-disables FE phase.
		const needsFrontend = userScope !== 'BACKEND_ONLY' && promptNeedsFrontend(lastUserMsg);

		const activeModel = await mm.acquire(intent);
		console.log(`[Router] Intent: ${intent} (raw: ${rawAdvisorIntent}) scope: ${userScope}. needsFrontend=${needsFrontend}. Model: ${mm.status.activeKey}`);

		// Derive currentSpecialist from intent.
		// For fullstack (intent=general), BE runs first so specialist starts as 'be'.
		const initialSpecialist: 'be' | 'fe' = (intent === 'frontend') ? 'fe' : 'be';
		let currentSpecialist: 'be' | 'fe' = initialSpecialist;

		// Compute mode for this specialist independently
		let mode = determineMode(lastUserMsg, currentSpecialist, backendFileCount, frontendFileCount);

		console.log(`[Router] Phase 1 Specialist=${currentSpecialist}, Mode=${mode}`);

		const activeFile = openFiles && openFiles.length > 0 ? openFiles[0] : undefined;
		let systemPrompt = buildSystemPrompt(lastUserMsg, hasWorkspace, mode, currentSpecialist, activeFile, workspaceRoot, pkgContent, openFiles, readWriteMode);

		context = await activeModel.createContext({ contextSize: 4096 });
		let session = new LlamaChatSession({
			contextSequence: context.getSequence(),
			systemPrompt: systemPrompt,
		});

		// Load prior conversation history
		const history: Array<{ type: 'user'; text: string } | { type: 'model'; response: string[] }> = [];
		for (let i = 0; i < messages.length - 1; i++) {
			const msg = messages[i];
			if (msg.role === 'user') {
				history.push({ type: 'user', text: msg.content });
			} else if (msg.role === 'assistant') {
				history.push({ type: 'model', response: [msg.content] });
			}
		}
		if (history.length > 0) {
			await session.setChatHistory(history as any);
		}

		// ---------------------------------------------------------------
		// AGENTIC TOOL-CALLING LOOP
		// ---------------------------------------------------------------
		res.setHeader('Content-Type', 'text/event-stream');
		res.setHeader('Cache-Control', 'no-cache');
		res.setHeader('Connection', 'keep-alive');

		const modelNames: Record<string, string> = { be: 'Backend Specialist', fe: 'Frontend Specialist' };
		const activeName = modelNames[mm.status.activeKey || ''] || 'Base Model';
		streamChunk(res, `🦀 **Workspace**\n\n`);
		const showRawOutput = isExplicitCodeRequest(lastUserMsg) || readWriteMode === 'read';

		// Pipeline: read stage
		streamEvent(res, { type: 'info', stage: 'read', message: 'Reading workspace...' });
		if (pkgContent) streamEvent(res, { type: 'success', stage: 'read', message: 'package.json loaded' });
		if (openFiles && openFiles.length > 0) streamEvent(res, { type: 'success', stage: 'read', message: `${openFiles.length} open file(s) loaded` });

		// Pipeline: plan stage
		const featDesc = plannerContract.requiredFeatures.length > 0
			? ` · ${plannerContract.requiredFeatures.length} feature(s) detected`
			: '';
		// streamEvent(res, { type: 'info', stage: 'plan', message: `Planning: ${plannerContract.scope}${featDesc}` });

		let jsxRepairDoneMain = false; // allow one JSX repair pass in main loop


		// needs_context: model has one shot to explain what it needs. No retries. No loop.
		// This mode produces conversational prose (not generated code), so output is shown.
		if (mode === 'needs_context') {
			console.log('[Router] mode=needs_context. Single-shot explanation, then exit.');
			await session.prompt(enrichedLastMessage, {
				maxTokens: 512,
				signal: controller.signal,
				stopOnAbortSignal: true,
				onTextChunk(chunk) { streamChunk(res, chunk); },
			});
			streamEvent(res, { type: 'warning', stage: 'read', message: 'No context available. Open files or describe the project to proceed.' });
			res.end();
			return;
		}


		// Fullstack execution = general intent OR an explicit create/edit_fullstack advisor intent.
		// Single-specialist intents (create_fe, edit_be, etc.) NEVER trigger the BE→FE handoff.
		const isFullStackExecution =
			intent === 'general' ||
			rawAdvisorIntent === 'create_fullstack' ||
			rawAdvisorIntent === 'edit_fullstack';

		// Router-owned orchestration: model is never told about <HANDOFF_TO_FRONTEND>.
		// Router decides FE phase based on planner. Model just generates BE files and stops.
		let currentPrompt = isFullStackExecution
			? [
				`You are the Backend Specialist. Generate ONLY backend files for this request.`,
				`Do NOT generate frontend, React, UI, or component files. Stop when backend is done.`,
				`\n--- Original Request ---\n${enrichedLastMessage}`,
			].join('\n\n')
			: enrichedLastMessage;
		const originalUserRequest = enrichedLastMessage;


		for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
			console.log(`[Router] --- Agentic iteration ${iteration + 1} ---`);

			if (controller.signal.aborted) {
				throw new Error('Generation was aborted due to timeout or loop detection.');
			}

			// Emit per-iteration progress event
			if (iteration === 0) {
				// streamEvent(res, { type: 'progress', stage: 'generate', message: `Generating ${currentSpecialist === 'fe' ? 'frontend' : 'backend'} files...` });
			} else {
				streamEvent(res, { type: 'progress', stage: 'repair', message: 'Applying fixes...' });
			}

			let fullResponse = '';
			let loopDetected = false;
			let loopReason = '';

			await session.prompt(currentPrompt, {
				maxTokens: MAX_TOKENS,
				repeatPenalty: {
					penalty: REPEAT_PENALTY,
					lastTokens: REPEAT_PENALTY_TOKENS,
					penalizeNewLine: false
				},
				signal: controller.signal,
				stopOnAbortSignal: true,
				onTextChunk(chunk) {
					// Buffer internally; emit raw only when user explicitly requested code
					fullResponse += chunk;
					if (showRawOutput) streamChunk(res, chunk);

					// Run repetition detector on every chunk
					const check = detectRepetitionLoop(fullResponse);
					if (check.detected) {
						loopDetected = true;
						loopReason = check.reason || 'Unknown repetition pattern';
						controller.abort();
					}
				}
			});

			if (loopDetected) {
				console.warn(`[Router] Loop detected: ${loopReason}. Aborting generation.`);
				streamChunk(res, `\n\n⚠️ **Generation stopped:** ${loopReason}\n`);
				throw new Error(`Infinite loop detected: ${loopReason}`);
			}

			if (controller.signal.aborted) {
				throw new Error('Generation was aborted during prompt execution.');
			}

			const responseTokenCount = activeModel ? activeModel.tokenize(fullResponse).length : 0;
			console.log(`[Router] Iteration ${iteration + 1} complete. Tokens generated: ${responseTokenCount}`);

			if (responseTokenCount < 30) {
				console.log("[Router] Tiny response detected. Aborting to prevent infinite loop.");
				break;
			}

			// Check for identical responses (identical-response detection)
			const trimmedResponse = fullResponse.trim();
			if (responseHistory.includes(trimmedResponse)) {
				const errorMsg = 'Identical response detected from the model across iterations. Stopping to prevent infinite retry loop.';
				console.error(`[Router] ${errorMsg}`);
				streamChunk(res, `\n\n❌ **Error:** ${errorMsg}\n`);
				throw new Error(errorMsg);
			}
			responseHistory.push(trimmedResponse);

			// Check for a tool call in the response
			const parsed = parseToolCall(fullResponse);

			if (!parsed) {
				// No tool call — this is the final response or a handoff.
				const sha12 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
				console.log(`[Stage1-LLM] len=${fullResponse.length} hash=${sha12(fullResponse)} hasFileTag=${/<file\s+path=/i.test(fullResponse)}`);
				console.log(`[Stage1-LLM] first300: ${fullResponse.slice(0, 300).replace(/\n/g, '␊')}`);
				console.log(`[Stage1-LLM] last300: ${fullResponse.slice(-300).replace(/\n/g, '␊')}`);

				// Full-Stack Handoff Detection — router-owned, NOT model-token-driven.
				// <HANDOFF_TO_FRONTEND> is no longer injected into the model prompt.
				// We check for it here only as a legacy safety valve; real routing uses plan.be&&plan.fe.
				if (fullResponse.includes('<HANDOFF_TO_FRONTEND>')) {
					// Model emitted it unexpectedly (old weights). Treat as BE-done signal.
					console.warn('[Router] Model emitted <HANDOFF_TO_FRONTEND> unexpectedly. Treating as BE-done.');
					break; // exit BE loop, FE phase will run below
				}

				// FALLBACK: if the model pasted code blocks instead of using tools,
				// auto-extract and write them to disk.
				if (workspaceRoot) {
					const fallbackEdits = extractFallbackEdits(fullResponse, openFiles, workspaceRoot, lastUserMsg, mode);
					// Stage 2: parser trace
					const sha12 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
					for (const e of fallbackEdits) {
						const diskPath = path.join(workspaceRoot, e.path);
						const diskContent = fs.existsSync(diskPath) ? fs.readFileSync(diskPath, 'utf-8') : '';
						const diskHash = sha12(diskContent);
						const parsedHash = sha12(e.content);
						console.log(`[Stage2-Parser] ${e.path} | len=${e.content.length} hash=${parsedHash}`);
						console.log(`[Stage2-Parser] preview: ${e.content.slice(0, 150).replace(/\n/g, '␊')}`);
						console.log(`[Stage3-Compare] ${e.path} | disk=${diskHash} parsed=${parsedHash} different=${diskHash !== parsedHash}`);
						if (diskHash === parsedHash) console.warn(`[Stage3-Compare] ⚠️ LLM echoed back identical content for ${e.path}!`);
					}
					if (fallbackEdits.length > 0) {
						// READ mode: log detected <file> blocks but do NOT write
						if (readWriteMode === 'read') {
							console.log(`[Router] READ mode — suppressed ${fallbackEdits.length} fallback write(s): ${fallbackEdits.map(e => e.path).join(', ')}`);
							// Don't break — let the final prose response flow through naturally
						} else {
							// ── POST-GENERATION VALIDATOR V2.5 ──────────────────────────────────
							streamEvent(res, { type: 'progress', stage: 'validate', message: 'Running validation...' });
							// editMode = user asked to edit/fix specific files, not generate a new project
							const isEditMode = mode === 'edit' || rawAdvisorIntent?.startsWith('edit_');
							// Stage 4: validator in-hash
							const sha12v = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
							const preValidatorHashes = Object.fromEntries(fallbackEdits.map(e => [e.path, sha12v(e.content)]));
							const validationResult = await runPostGenerationValidator(fallbackEdits, workspaceRoot, validationContract, isEditMode);
							// Stage 4: compare validator output hashes
							for (const f of validationResult.files) {
								const before = preValidatorHashes[f.path];
								const after = sha12v(f.content);
								if (before && before !== after) {
									console.warn(`[Stage4-Validator] ⚠️ CONTENT MODIFIED by validator: ${f.path} | before=${before} after=${after}`);
									console.log(`[Stage4-Validator] new first 150: ${f.content.slice(0, 150).replace(/\n/g, '␊')}`);
								} else {
									console.log(`[Stage4-Validator] ${f.path} | unchanged hash=${after}`);
								}
							}
							const generatedPaths = new Set(fallbackEdits.map(e => e.path));
							// Filter issues to only the files we actually generated/edited
							validationResult.issues = validationResult.issues.filter(i => !i.file || generatedPaths.has(i.file));
							// Recompute passed after filtering (validator computed it before our scope filter)
							validationResult.passed = !validationResult.issues.some(i => i.severity === 'error');
							const validatedEdits = validationResult.files;
							console.log(`[Router] Fallback: ${fallbackEdits.length} → ${validatedEdits.length} file(s) | passed=${validationResult.passed} | coverage=${validationResult.coverageScore}/${validationResult.coverageMax}`);
							let hasErrors = false;
							const errorOutputs: string[] = [];

							if (validationResult.passed && !validationResult.issues.some(i => i.severity === 'error')) {
								streamEvent(res, { type: 'success', stage: 'validate', message: 'Validation passed' });
							} else {
								streamEvent(res, { type: 'error', stage: 'validate', message: 'Validation failed. Attempting automatic repair...' });
							}

							for (const edit of validatedEdits) {
								// Apply fallback protection counts
								const attempts = (fileWriteAttempts.get(edit.path) || 0) + 1;
								fileWriteAttempts.set(edit.path, attempts);
								if (attempts > MAX_CORRECTIONS_PER_FILE) {
									throw new Error(`Fallback Protection: Path correction/rewrite loop detected for file "${edit.path}". Limit of ${MAX_CORRECTIONS_PER_FILE} writes exceeded.`);
								}

								streamEvent(res, { type: 'progress', stage: 'write', message: `Writing \`${edit.path}\`...`, file: edit.path });
								const result = executeToolCall(
									{ name: 'writeFile', arguments: { path: edit.path, content: edit.content } },
									workspaceRoot,
									openFiles,
									lastUserMsg,
									intent,
									readWriteMode
								);
								if (result.success && result.output.startsWith('WRITTEN:')) {
									if (!filesModified.includes(edit.path)) filesModified.push(edit.path);
									streamEvent(res, { type: 'success', stage: 'write', message: `Written \`${edit.path}\``, file: edit.path });
									if (result.diffMsg) streamChunk(res, result.diffMsg);
									console.log(`[Router] Fallback written: ${edit.path}`);
								} else if (!result.success) {
									totalCorrections++;
									console.log(`[Router] Fallback write rejected: ${result.output}`);
									streamEvent(res, { type: 'error', stage: 'write', message: `Write rejected for \`${edit.path}\`: ${result.output}`, file: edit.path });

									if (totalCorrections > MAX_TOTAL_CORRECTIONS) {
										throw new Error(`Fallback Protection: Exceeded maximum validation correction limit (${MAX_TOTAL_CORRECTIONS} total corrections).`);
									}

									hasErrors = true;
									errorOutputs.push(`File: ${edit.path}\nResult: ${result.output}`);
								}
							}

							if (hasErrors || !validationResult.passed) {
								if (iteration === MAX_AGENT_ITERATIONS - 1) {
									throw new Error(`Agent Iteration Protection: Exceeded maximum iteration limit of ${MAX_AGENT_ITERATIONS} steps without finding a valid correction.`);
								}
								// Abort guard — stop looping if client disconnected
								if (controller.signal.aborted) break;

								// Targeted repair: feed only specific issues back to the model
								const repairPrompt = buildTargetedRepairPrompt(validationResult.issues, filesModified, workspaceRoot ?? '');
								currentPrompt = repairPrompt || `<validation_errors>\nSome files failed validation.\n${errorOutputs.join('\n')}\nRe-emit the corrected file(s).\n</validation_errors>`;

								console.log(`[Router] Fallback validation failed, looping back to LLM for correction...`);
								continue;
							}
						} // end WRITE mode else block
					} // end if (fallbackEdits.length > 0)
				} // end if (workspaceRoot)

				// ── JSX Symbol Validator (single-specialist FE loop, one repair pass) ──
				if (currentSpecialist === 'fe' && workspaceRoot && !jsxRepairDoneMain && readWriteMode !== 'read') {
					const extractedForValidation = extractFallbackEdits(fullResponse, openFiles, workspaceRoot, lastUserMsg, mode);
					const jsxIssues = validateJsxSymbols(extractedForValidation, workspaceRoot);
					if (jsxIssues.length > 0 && iteration < MAX_AGENT_ITERATIONS - 1 && !controller.signal.aborted) {
						jsxRepairDoneMain = true;
						console.log(`[Validator] repairing ${jsxIssues.length} JSX issue(s) in main loop`);
						currentPrompt = buildJsxRepairPrompt(jsxIssues);
						continue;
					}
				}

				// Part B — files written summary (BE-only or single-specialist)
				if (filesModified.length > 0) {
					streamEvent(res, { type: 'success', stage: 'complete', message: `Complete · ${filesModified.length} file(s) updated` });
					streamChunk(res, `\n**Files updated:**\n${filesModified.map(f => `- \`${f}\``).join('\n')}\n`);
				} else if (/(?:make|create|new|edit|update|change|add to) /i.test(lastUserMsg || '')) {
					// Fallback Protection: no file blocks generated for an explicit write request
					if (iteration < MAX_AGENT_ITERATIONS - 1) {
						console.log(`[Router] Fallback protection: Missing file blocks, looping back to LLM...`);
						currentPrompt = `<validation_errors>\nYou did not output any valid file blocks.\n\nYou MUST use the exact <file path="...">...</file> format to generate code.\nDo not use markdown code fences.\n</validation_errors>\n\nPlease try again.`;
						continue;
					} else {
						throw new Error(`Agent Iteration Protection: Exceeded maximum iteration limit of ${MAX_AGENT_ITERATIONS} steps without generating the requested files.`);
					}
				}
				break;
			}

			// --- Tool call detected ---
			const { toolCall, textBefore } = parsed;
			console.log(`[Router] 🔧 Tool call: ${toolCall.name}(${JSON.stringify(toolCall.arguments).substring(0, 200)})`);

			// Suppress model reasoning text before tool call (not user-facing)
			if (textBefore) {
				console.log(`[Router] textBefore suppressed (${textBefore.length} chars)`);
			}

			// Emit structured tool action notification
			if (toolCall.name === 'writeFile') {
				streamEvent(res, { type: 'progress', stage: 'write', message: `Writing \`${toolCall.arguments.path || '.'}\`...`, file: toolCall.arguments.path });
			} else if (toolCall.name === 'readFile') {
				streamEvent(res, { type: 'info', stage: 'read', message: `Reading \`${toolCall.arguments.path || '.'}\``, file: toolCall.arguments.path });
			} else {
				streamEvent(res, { type: 'info', stage: 'read', message: `${toolCall.name}(\`${toolCall.arguments.path || '.'}\`)` });
			}

			// Check and increment writeFile attempts
			if (toolCall.name === 'writeFile') {
				const pathArg = toolCall.arguments.path || 'unknown';
				const attempts = (fileWriteAttempts.get(pathArg) || 0) + 1;
				fileWriteAttempts.set(pathArg, attempts);
				if (attempts > MAX_CORRECTIONS_PER_FILE) {
					throw new Error(`Fallback Protection: Path correction/rewrite loop detected for file "${pathArg}". Limit of ${MAX_CORRECTIONS_PER_FILE} writes exceeded.`);
				}
			}

			// In READ mode, intercept writeFile tool calls before execution
			if (readWriteMode === 'read' && toolCall.name === 'writeFile') {
				console.log(`[Router] READ mode — blocked <tool_call> writeFile to: ${toolCall.arguments.path}`);
				currentPrompt = `<tool_result>
Tool: writeFile
Path: ${toolCall.arguments.path || '.'}
Success: false
Output: [READ MODE] File writes are disabled for read-only requests. Do not attempt to write files. Provide your answer as plain text instead.
</tool_result>

Continue with your task using plain text only. Do not emit any file blocks or writeFile calls.`;
				continue;
			}

			// Execute the tool
			const result = executeToolCall(toolCall, workspaceRoot || '.', openFiles, lastUserMsg, intent, readWriteMode);

			// Track file modifications
			if (toolCall.name === 'writeFile') {
				if (result.success && result.output.startsWith('WRITTEN:')) {
					const writtenPath = toolCall.arguments.path || 'unknown';
					if (!filesModified.includes(writtenPath)) filesModified.push(writtenPath);
					streamEvent(res, { type: 'success', stage: 'write', message: `Written \`${writtenPath}\``, file: writtenPath });
					if (result.diffMsg) streamChunk(res, result.diffMsg);
				} else if (!result.success) {
					totalCorrections++;
					streamEvent(res, { type: 'error', stage: 'write', message: `Write rejected for \`${toolCall.arguments.path}\`: ${result.output}`, file: toolCall.arguments.path });
					if (totalCorrections > MAX_TOTAL_CORRECTIONS) {
						throw new Error(`Fallback Protection: Exceeded maximum validation correction limit (${totalCorrections} total corrections).`);
					}
				}
			}

			// If we reached the last iteration and the model is trying to continue (e.g. it emitted a tool call), raise an error
			if (iteration === MAX_AGENT_ITERATIONS - 1) {
				throw new Error(`Agent Iteration Protection: Exceeded maximum iteration limit of ${MAX_AGENT_ITERATIONS} steps without finding a final response.`);
			}

			// Feed the tool result back to the model for the next iteration
			const resultPreview = result.output.length > 5000
				? result.output.substring(0, 5000) + '\n...(truncated)'
				: result.output;

			currentPrompt = `<tool_result>
Tool: ${toolCall.name}
Path: ${toolCall.arguments.path || '.'}
Success: ${result.success}
Output:
${resultPreview}
</tool_result>

Continue with your task. If you need another tool, use it. Otherwise provide your final summary.`;
		}

		console.log(`[Router] BE phase finished. ${filesModified.length} file(s) written.`);

		// --- Write BE artifact + patch Tier-2 caches ---
		// Gives FE specialist deterministic context without extra LLM calls.
		if (isFullStackExecution && filesModified.length > 0 && workspaceRoot) {
			const beArtifact = buildArtifactFromFiles(workspaceRoot, filesModified, 'be');
			writeArtifact(workspaceRoot, beArtifact);
			patchCachesFromArtifact(workspaceRoot, beArtifact);
			console.log(`[ARTIFACT] BE artifact ready: ${beArtifact.symbols.length} symbols, ${beArtifact.routes?.length ?? 0} routes.`);
		}

		// ---------------------------------------------------------------
		// FE PHASE — router-owned, sequential, never concurrent with BE
		// Triggered by planner (plan.be && plan.fe), not by model tokens.
		// BE context is fully disposed before FE model loads.
		// ---------------------------------------------------------------
		if (isFullStackExecution) {
			// C11: Cross-specialist skip — prompt-based, NOT file-type-based.
			// After BE finishes every written file is a backend file by definition,
			// so inspecting written files to decide FE necessity is always wrong.
			// We use the prompt signal evaluated BEFORE the BE phase ran.
			const runFE = shouldRunFrontend({
				intent: rawAdvisorIntent,
				prompt: lastUserMsg,
				beFilesWritten: filesModified,
			});

			console.log('[Router] Cross-specialist skip decision:', JSON.stringify({
				intent: rawAdvisorIntent,
				needsFrontend,
				runFE,
				filesWritten: filesModified.length,
			}));

			if (!runFE) {
				console.log('[Router] Cross-specialist skip: prompt has no FE signals → skipping FE phase.');
				if (context) { await context.dispose(); context = null; }
				clearTimeout(timeoutId);
				res.write('data: [DONE]\n\n');
				res.end();
				return;
			}
			console.log('[Router] Fullstack: FE signals present → proceeding to FE phase. Disposing BE context...');
			if (context) {
				await context.dispose();
				context = null;
				console.log('[Router] BE context disposed.');
			}

			streamEvent(res, { type: 'info', stage: 'generate', message: 'Backend complete. Loading Frontend Specialist...' });

			// Load FE model fresh — BE is fully unloaded first by mm.acquire
			intent = 'frontend';
			const feModel = await mm.acquire('frontend');
			console.log('[Router] FE model acquired. Creating fresh context...');

			currentSpecialist = 'fe';
			// Recompute mode independently for FE
			mode = determineMode(lastUserMsg, currentSpecialist, backendFileCount, frontendFileCount);
			console.log(`[Router] Phase 2 Specialist=${currentSpecialist}, Mode=${mode}`);

			// Build FE system prompt with FE specialist mode
			const feSystemPrompt = buildSystemPrompt(lastUserMsg, hasWorkspace, mode, 'fe', activeFile, workspaceRoot, pkgContent, openFiles, readWriteMode);

			// Fresh context — no shared state with BE session
			context = await feModel.createContext({ contextSize: 4096 });
			const feSession = new LlamaChatSession({
				contextSequence: context.getSequence(),
				systemPrompt: feSystemPrompt,
			});

			// Pass BE artifact context + Tier-2 RAG context to FE.
			// Artifact ensures FE knows real API endpoints/symbols without hallucinating.
			const feContextBlocks: string[] = [
				`You are the Frontend Specialist. Generate ONLY frontend files for this request.`,
				`Do NOT generate backend, Node.js, Express, or server files.`,
			];
			if (filesModified.length > 0) {
				const summary = extractBackendSummary(filesModified, workspaceRoot || '.');
				feContextBlocks.push(`--- Backend Summary (written by BE Specialist) ---\n${summary}`);
				console.log(`[Router] Injected BackendSummary from ${filesModified.length} BE file(s) into FE context.`);
			}

			// Inject artifact API contract — gated by intent, mode, and artifact age.
			// Only inject when: intent===general, mode===edit, artifact exists, age < 5 min.
			if (workspaceRoot) {
				const beArt = (await import('./rag/artifact.js')).loadArtifact(workspaceRoot, 'be');
				const artifactAge = beArt ? Date.now() - beArt.ts : Infinity;
				const artifactFresh = artifactAge < 5 * 60 * 1000; // 5 minutes
				// Gate: artifact boost only for fullstack + edit mode + fresh artifact
				// (intent is overwritten to 'frontend' at this point; use isFullStackExecution as proxy)
				const shouldBoost = beArt && artifactFresh && isFullStackExecution && mode === 'edit';
				if (beArt && !artifactFresh) {
					console.log('[ARTIFACT] skipped: expired');
				} else if (beArt && !isFullStackExecution) {
					console.log('[ARTIFACT] skipped: single-specialist request');
				} else if (shouldBoost) {
					const lines: string[] = ['--- Backend API Contract (from BE Artifact) ---'];
					if (beArt.routes?.length) lines.push(`Routes:\n${beArt.routes.map(r => `  ${r}`).join('\n')}`);
					if (beArt.symbols?.length) lines.push(`Exported symbols:\n${beArt.symbols.map(s => `  ${s}`).join('\n')}`);
					if (beArt.models?.length) lines.push(`Models:\n${beArt.models.map(m => `  ${m}`).join('\n')}`);
					if (beArt.controllers?.length) lines.push(`Controllers:\n${beArt.controllers.map(c => `  ${c}`).join('\n')}`);
					feContextBlocks.push(lines.join('\n'));
					console.log(`[ARTIFACT] FE prompt: injected API contract (${beArt.routes?.length ?? 0} routes, ${beArt.symbols?.length ?? 0} symbols).`);
				}
			}

			feContextBlocks.push(`--- Original Request ---\n${originalUserRequest}`);

			let fePrompt = feContextBlocks.join('\n\n');
			const feResponseHistory: string[] = [];
			const feInitialFilesCount = filesModified.length;
			let feJsxRepairDone = false; // allow one JSX repair pass in FE loop
			// streamEvent(res, { type: 'progress', stage: 'generate', message: 'Generating frontend files...' });

			for (let feIter = 0; feIter < MAX_AGENT_ITERATIONS; feIter++) {
				console.log(`[Router] --- FE iteration ${feIter + 1} ---`);
				if (controller.signal.aborted) throw new Error('FE phase aborted.');

				let feResponse = '';
				let feLoopDetected = false;
				let feLoopReason = '';

				await feSession.prompt(fePrompt, {
					maxTokens: MAX_TOKENS,
					repeatPenalty: { penalty: REPEAT_PENALTY, lastTokens: REPEAT_PENALTY_TOKENS, penalizeNewLine: false },
					signal: controller.signal,
					stopOnAbortSignal: true,
					onTextChunk(chunk) {
						// Buffer internally — raw model tokens are never sent to chat
						feResponse += chunk;
						const check = detectRepetitionLoop(feResponse);
						if (check.detected) { feLoopDetected = true; feLoopReason = check.reason || 'Unknown'; controller.abort(); }
					},
				});

				if (feLoopDetected) {
					streamEvent(res, { type: 'warning', stage: 'generate', message: `FE generation stopped: ${feLoopReason}` });
					throw new Error(`FE loop: ${feLoopReason}`);
				}

				const feResponseTokenCount = feModel ? feModel.tokenize(feResponse).length : 0;
				console.log(`[Router] FE Iteration ${feIter + 1} complete. Tokens generated: ${feResponseTokenCount}`);
				console.log(`[RAW RESPONSE]\n${JSON.stringify(feResponse)}`);

				if (feResponseTokenCount < 30) {
					console.log("[Router] Tiny response detected. Aborting to prevent infinite loop.");
					break;
				}

				const trimmedFe = feResponse.trim();
				if (feResponseHistory.includes(trimmedFe)) throw new Error('FE: identical response across iterations.');
				feResponseHistory.push(trimmedFe);

				const feParsed = parseToolCall(feResponse);
				if (!feParsed) {
					// Final response — extract file blocks
					if (workspaceRoot) {
						const feRawEdits = extractFallbackEdits(feResponse, openFiles, workspaceRoot, lastUserMsg, mode);
						const feValidContract = plannerContractToValidationContract(plannerContract, 'FRONTEND_ONLY');
						const feValResult = feRawEdits.length > 0 && readWriteMode !== 'read'
							? await runPostGenerationValidator(feRawEdits, workspaceRoot, feValidContract)
							: null;
						const fallback = feValResult ? feValResult.files : feRawEdits;
						if (fallback.length > 0 && readWriteMode !== 'read') {
							for (const edit of fallback) {
								streamEvent(res, { type: 'progress', stage: 'write', message: `Writing \`${edit.path}\`...`, file: edit.path });
								const feResult = executeToolCall(
									{ name: 'writeFile', arguments: { path: edit.path, content: edit.content } },
									workspaceRoot, openFiles, lastUserMsg, intent, readWriteMode
								);
								if (feResult.success) {
									if (!filesModified.includes(edit.path)) filesModified.push(edit.path);
									streamEvent(res, { type: 'success', stage: 'write', message: `Written \`${edit.path}\``, file: edit.path });
									if (feResult.diffMsg) streamChunk(res, feResult.diffMsg);
								}
							}
						}
					}

					// ── JSX Symbol Validator (fullstack FE loop, one repair pass) ──────────
					if (workspaceRoot && !feJsxRepairDone && readWriteMode !== 'read' && filesModified.length > feInitialFilesCount) {
						const feExtracted = extractFallbackEdits(feResponse, openFiles, workspaceRoot, lastUserMsg, mode);
						const jsxIssues = validateJsxSymbols(feExtracted, workspaceRoot);
						if (jsxIssues.length > 0 && feIter < MAX_AGENT_ITERATIONS - 1) {
							feJsxRepairDone = true;
							console.log(`[Validator] repairing ${jsxIssues.length} JSX issue(s) in FE loop`);
							fePrompt = buildJsxRepairPrompt(jsxIssues);
							continue;
						}
					}

					// If no files were written in create mode, force retry
					if (mode === 'create' && (!workspaceRoot || filesModified.length === feInitialFilesCount)) {
						if (feIter < MAX_AGENT_ITERATIONS - 1) {
							console.log(`[Router] FE Fallback protection: Missing file blocks, looping back to LLM...`);
							fePrompt = `<validation_errors>\nYou did not output any valid file blocks.\n\nYou MUST use the exact <file path="...">...</file> format to generate code.\nDo not use markdown code fences.\n</validation_errors>\n\nPlease try again.`;
							continue;
						} else {
							throw new Error(`FE Agent Iteration Protection: Exceeded maximum iteration limit without generating the requested files.`);
						}
					}

					break;
				}

				// Tool call in FE response
				const { toolCall: feTool } = feParsed;
				if (feTool.name === 'writeFile') {
					const feWriteResult = executeToolCall(feTool, workspaceRoot || '.', openFiles, lastUserMsg, intent, readWriteMode);
					if (feWriteResult.success) {
						const writtenPath = feTool.arguments.path || 'unknown';
						if (!filesModified.includes(writtenPath)) filesModified.push(writtenPath);
					}
					fePrompt = `<tool_result>\nTool: writeFile\nPath: ${feTool.arguments.path}\nSuccess: ${feWriteResult.success}\nOutput: ${feWriteResult.output}\n</tool_result>\n\nContinue.`;
				} else {
					const feGenResult = executeToolCall(feTool, workspaceRoot || '.', openFiles, lastUserMsg, intent, readWriteMode);
					fePrompt = `<tool_result>\nTool: ${feTool.name}\nSuccess: ${feGenResult.success}\nOutput: ${feGenResult.output.substring(0, 5000)}\n</tool_result>\n\nContinue.`;
				}
			} // end FE for-loop

			console.log(`[Router] FE phase complete. Total files written: ${filesModified.length}.`);

			// Delete transient BE artifact now that FE has consumed it
			if (workspaceRoot) {
				deleteArtifact(workspaceRoot, 'be');
				console.log('[ARTIFACT] Cleanup complete');
			}

			// Emit fullstack completion summary
			if (filesModified.length > 0) {
				streamEvent(res, { type: 'success', stage: 'complete', message: `Complete · ${filesModified.length} file(s) updated` });
				streamChunk(res, `\n**Files updated:**\n${filesModified.map(f => `- \`${f}\``).join('\n')}\n`);
			}
		} // end if (isFullStackExecution)

		res.end();
		if (workspaceRoot) cleanupArtifacts(workspaceRoot); // cleanup any remaining artifacts
		console.log(`[Router] Request finished. ${filesModified.length} files modified.`);


	} catch (error: any) {
		console.error('[Router] Chat error:', error);
		const errorMsg = error?.message || String(error);
		if (!res.headersSent) {
			res.status(500).json({ error: errorMsg });
		} else {
			streamEvent(res, { type: 'error', stage: 'complete', message: `Processing terminated: ${errorMsg}` });
			res.end();
		}
	} finally {
		clearTimeout(timeoutId);
		if (context) {
			await context.dispose();
			console.log(`[Router] Context disposed successfully.`);
		}
		if (activeController === controller) activeController = null; // deregister
		releaseSlot();
	}
});

// Inline Completions (FIM)
app.post('/v1/completions', async (req, res) => {
	res.status(501).json({ error: 'Inline completions using node-llama-cpp is not fully implemented yet.' });
});

// ---------------------------------------------------------------------------
// Part B — Diff / Approval endpoints
// ---------------------------------------------------------------------------

/** GET /v1/edits/:id  — view pending session and unified diffs */
app.get('/v1/edits/:id', (req, res) => {
	const session = pendingStore.get(req.params.id);
	if (!session) return res.status(404).json({ error: 'Session not found or expired.' });
	res.json({
		id: session.id,
		workspaceRoot: session.workspaceRoot,
		query: session.query,
		createdAt: session.createdAt,
		fileCount: session.edits.length,
		files: session.edits.map(e => ({
			relPath: e.relPath,
			isNewFile: e.oldContent === null,
			oldChars: e.oldContent?.length ?? 0,
			newChars: e.newContent.length,
			diff: e.diff,
		})),
	});
});

/** POST /v1/edits/approve  — apply all edits in a pending session */
app.post('/v1/edits/approve', (req, res) => {
	const { sessionId } = req.body;
	if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
	const session = pendingStore.get(sessionId);
	if (!session) return res.status(404).json({ error: 'Session not found or expired.' });

	const { written, errors } = applyPendingSession(session);
	pendingStore.delete(sessionId);

	console.log(`[PendingStore] Session ${sessionId} approved. Written: ${written.length}, Errors: ${errors.length}`);
	res.json({
		status: errors.length === 0 ? 'applied' : 'partial',
		written,
		errors,
	});
});

/** POST /v1/edits/reject  — discard all edits in a pending session */
app.post('/v1/edits/reject', (req, res) => {
	const { sessionId } = req.body;
	if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });
	const existed = pendingStore.has(sessionId);
	pendingStore.delete(sessionId);
	console.log(`[PendingStore] Session ${sessionId} rejected.`);
	res.json({ status: 'rejected', existed });
});

/** GET /v1/edits  — list all active pending sessions */
app.get('/v1/edits', (_req, res) => {
	const sessions = Array.from(pendingStore.values()).map(s => ({
		id: s.id,
		workspaceRoot: s.workspaceRoot,
		fileCount: s.edits.length,
		files: s.edits.map(e => e.relPath),
		createdAt: s.createdAt,
	}));
	res.json({ pending: sessions });
});

// ---------------------------------------------------------------------------
// Async Job System — mounted AFTER all legacy routes.
// Legacy routes (mm, incrementalEngine) continue to work unchanged.
// The new subsystem uses its own ModelManager instance (lease-based).
// ---------------------------------------------------------------------------

const _asyncBus    = new EventBus();
const _asyncLogger = new Logger({ level: 'info', structured: false });
_asyncLogger.attachEventBus(_asyncBus);

const _asyncMM = new ModelManager(_asyncBus);
_asyncMM.init().catch(e => console.error('[AsyncEngine] ModelManager init failed:', e));

const _jobService = new JobService(config, _asyncMM, _asyncBus, _asyncLogger.child('JobService'));

const _recovery = new RecoveryManager(
	new (await import('./jobs/manifestStore.js')).ManifestStore(config.runtime.root),
	_jobService,
	_asyncLogger.child('RecoveryManager'),
);
_recovery.scan().catch(e => console.error('[RecoveryManager] Scan failed:', e));

// Mount job routes
app.use('/v1/jobs', makeJobRoutes(_jobService, _asyncLogger.child('JobRoutes')));
app.use('/', makeHealthRoutes(_asyncMM));

app.listen(PORT, () => {
	console.log(`CodeCrab Native Model Router running on http://localhost:${PORT}`);
	console.log(`Engine: node-llama-cpp`);
	console.log(`Runtime Directory: ${config.runtime.root}`);
});
