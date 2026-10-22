import express from 'express';
import { mm } from './models/legacyModelManager.js';
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
import type { ValidationContract, ValidationIssue, GeneratedFile } from './validator.js';
import { selectTopDependencyFiles, buildDependencyContextBlock } from './dependencySelector.js';
import { buildFERepairPrompt, buildPlainStackRepairPrompt, buildTargetedRepairPrompt, classifyRepairMode, collectWorkspaceModules, fileExists } from './repairEngine.js';
import { inspectWorkspace } from './workspaceInspector.js';
import { buildExecutionGraph, nextPendingNode, isGraphComplete, graphSummary, markNodeFailed } from './planner.js';
import type { AdvisorV2Result, ExecutionGraph } from './planner.js';
import { resolveCapabilities, loadCapabilityPrompts, buildCapabilitySystemPrompt } from './capabilityResolver.js';
import { runIncrementalEngine, shouldUseIncrementalEngine } from './incrementalEngine.js';

// ── Async Job System (Phase 4) ─────────────────────────────────────────────
import { EventBus } from './core/eventBus.js';
import { Logger } from './logging/logger.js';
import { ModelManager } from './models/modelManager.js';
import { JobService } from './jobs/jobService.js';
import { RecoveryManager } from './jobs/recoveryManager.js';
import { makeJobRoutes } from './router/jobRoutes.js';
import { makeHealthRoutes } from './router/healthRoutes.js';
import config from '@/config/index.js';
import { activeContextUsage, updateContextUsage, setEffectiveContextSize, effectiveContextSize } from './telemetry/contextUsage.js';
import { ensureFrontendScaffold, ensureBackendScaffold, mergePackageJson, mergeInitSh } from './frontendScaffold.js';
import { classifyIntent, classifyOpenFile, detectAppType, detectBackendIntent, detectFrontendIntent, inferPreviousRoute, parseAdvisorIntent, parseAdvisorV2, runAdvisor, runAdvisorLoopDecomposition, runAdvisorProjectSummary, scoreKeywords } from './routing/intentClassifier.js';
import { detectStackProfile } from './routing/stackProfile.js';
import type { StackProfile } from './routing/stackProfile.js';
import { diagnoseResponse, buildTruncationContinuationPrompt, buildProseOutputPrompt } from './generation/responseDiagnosis.js';
import { cleanCodeBlock, detectRepetitionLoop, escapeRegExp, extractBackendSummary, extractFallbackEdits, extractRawCode, isExplicitCodeRequest, streamChunk, streamEvent } from './generation/pipelineHelpers.js';
import { buildNoOutputPrompt } from './generation/pipelineHelpers.js';
import { validateJsxSymbols, buildJsxRepairPrompt, type JsxSymbolIssue } from './generation/pipelineHelpers.js';
import { parseAdvisorJson } from './routing/advisorJson.js';

import { wouldClobberScaffold } from './tools/scaffoldGuard.js';
import { determineMode } from './routing/agentMode.js';

import { buildBESystemPrompt, buildFESystemPrompt, buildSystemPrompt, loadPrompt, logRoutingFailure, workspaceHasTsx } from './prompts/promptBuilder.js';

import { ensembleRoute, isCreatePrompt, promptNeedsFrontend, shouldRunFrontend } from './routing/ensembleRouter.js';
import { applyPendingSession, buildDirectoryTree, buildLCS, createPendingSession, executeToolCall, extractReferencedFiles, generateUnifiedDiff, inferFilePath, parseToolCall, readFileSafe, validateContentForExtension, validateTargetPath } from './tools/toolEngine.js';
import { getAvailableModels, getCpuUsage } from './router/systemRoutes.js';
import { buildPlannerContract } from './parsing/plannerContract.js';
import { parseUserScope } from './parsing/constraintParser.js';
import { plannerContractToValidationContract } from './parsing/plannerContract.js';

import {
	MAX_AGENT_ITERATIONS,
	MAX_CORRECTIONS_PER_FILE,
	MAX_TOTAL_CORRECTIONS,
	REPEAT_PENALTY,
	REPEAT_PENALTY_TOKENS,
	REQUEST_TIMEOUT_MS,
} from './generation/limits.js';


// ---------------------------------------------------------------------------
// Constraint Parser — runs BEFORE advisor, highest priority
// ---------------------------------------------------------------------------








// ---------------------------------------------------------------------------
// Planner Contract — deterministic keyword extraction, no model call
// ---------------------------------------------------------------------------













// ---------------------------------------------------------------------------
// Repair Loop V2.6 — Modification-Oriented Architecture
// ---------------------------------------------------------------------------

/** Repair strategy per issue type. */








/**
 * V2.6 Modification-Oriented Repair Prompt Builder.
 *
 * Produces targeted MODIFY / GENERATE / REWIRE instructions.
 * Never says "generate controllers" if controllers already exist.
 */
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

// 5 min idle → unload model

// GPU VRAM budget per model key
// 'auto' = node-llama-cpp binary-searches best layer count, falls back to CPU if needed (never OOMs)
// 'max'  = ALL layers or throw — do NOT use
// 0      = CPU only


// ---------------------------------------------------------------------------
// ModelManager — exactly 0 or 1 model in VRAM at any time
// ---------------------------------------------------------------------------
;

// Initialize on startup (engine only, no models loaded)
mm.init().catch(e => console.error('[ModelManager] Init failed:', e));

// Initialize RAG embedding model on CPU (non-blocking)
em.init().catch(e => console.error('[EmbeddingManager] Init failed:', e));

// ---------------------------------------------------------------------------
// Pattern-Based Semantic Classifier Patterns
// ---------------------------------------------------------------------------

// 1. UI Components, Suffixes & Structure


// 2. Interaction, Visual & Styling Verbs


// 3. Visual & Design Modifiers


// 4. Frontend Frameworks & Libraries


// Backend Patterns (strictly bounded)




// Helpers for Dynamic Routing




// ---------------------------------------------------------------------------
// READ vs WRITE intent classifier
// ---------------------------------------------------------------------------










// Health Check
app.get('/health', (req, res) => {
	res.json({
		router: 'ok',
		engine: 'node-llama-cpp',
		// The editor's ISpecialistModel expects a narrow domain/status union.
		// The router used to report 'ready' / 'Frontend UI/UX', which matched
		// neither, so the model picker silently showed garbage.
		ollama: 'connected',
		...mm.status,
		context: activeContextUsage,
		models: getAvailableModels(),
		// Which model file was really loaded, and whether the preferred one
		// was missing. A silent fallback hid a 3x-slower model.
		modelResolution: config.modelResolution ?? null
	});
});



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
			const usedKb = parseInt(parts[2] ?? '0', 10);
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
			gpu: { hasGpu, percent: vramUsagePercent.toFixed(1), usedGb: vramUsedGb.toFixed(1), totalGb: vramTotalGb.toFixed(1) },
			context: activeContextUsage
		});
	} catch (error) {
		res.status(500).json({ error: 'Failed to fetch stats' });
	}
});

// Live Context Usage Endpoint
app.get('/context-usage', (_req, res) => {
	res.json(activeContextUsage);
});

// List Models
app.get('/v1/models', (req, res) => {
	res.json(getAvailableModels());
});

// ---------------------------------------------------------------------------
// Dynamic System Prompt Builder
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Routing failure logger — Stage 7 dataset collection
// Appends JSON lines to router/logs/routing_failures.jsonl
// Call whenever you detect the route was wrong (via user feedback or hard overrides).
// Collect 500–2000 failures before finetuning the advisor.
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Advisor — stateless 0.6B intent classifier
// Returns one of 8 intent strings. Never talks to user. No confidence.
// ---------------------------------------------------------------------------

type AdvisorIntent =
	| 'create_fe' | 'edit_fe'
	| 'create_be' | 'edit_be'
	| 'create_fullstack' | 'edit_fullstack'
	| 'general' | 'unknown';








// ---------------------------------------------------------------------------
// Ensemble scoring — fuses all signals into a final FE/BE/FULLSTACK/GENERAL score
// ---------------------------------------------------------------------------









// ---------------------------------------------------------------------------
// Cross-Specialist Skip Helpers
// ---------------------------------------------------------------------------









// ---------------------------------------------------------------------------
// AgentMode — computed once per request, sealed, passed to all specialists
// ---------------------------------------------------------------------------







/**
 * Build system prompt for a specialist.
 * @param mode - Sealed AgentMode for this request. Never recomputed.
 * @param currentSpecialist - 'be' or 'fe'. Controls prompt prefix. Separate from requestIntent.
 */
// ---------------------------------------------------------------------------
// FE Prompt Router — deterministic, keyword + workspace driven
// Priority: agent → typescript → mode → framework → feature
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// React workspace scanner — checks for .tsx files on disk (no keyword deps)
// ---------------------------------------------------------------------------









// ---------------------------------------------------------------------------
// BackendSummary — structured contract passed from BE phase to FE phase
// Replaces raw file injection: prevents context overflow and FE hallucinating
// APIs that don't match what BE actually generated.
// ---------------------------------------------------------------------------





// ---------------------------------------------------------------------------
// Fallback: extract code blocks with file paths from model output
// Used when the model ignores <tool_call> and just pastes code directly
// ---------------------------------------------------------------------------







// ---------------------------------------------------------------------------
// JSX Symbol Validator
// Parses <ComponentName /> tags from generated .tsx/.jsx files.
// Verifies: (1) symbol imported, (2) import path resolves to real file.
// ---------------------------------------------------------------------------

/** Build a repair prompt from JSX symbol validation issues. */


// ---------------------------------------------------------------------------
// Part A — Path validation (rejects directories, escapes, missing parents)
// ---------------------------------------------------------------------------



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





// In-memory store: sessionId → PendingSession
const pendingStore = new Map<string, PendingSession>();







// ---------------------------------------------------------------------------
// Server-side workspace tools (Node.js fs)
// ---------------------------------------------------------------------------







// ---------------------------------------------------------------------------
// Tool Execution Engine
// ---------------------------------------------------------------------------









// ---------------------------------------------------------------------------
// Structured pipeline event system
// ---------------------------------------------------------------------------







// ---------------------------------------------------------------------------
// Chat Completions — Agentic Tool-Calling Loop & Hardening Settings
// ---------------------------------------------------------------------------




// 60 minutes (3600 seconds)
// 3 for BE pass + 3 for FE pass in full-stack mode







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
		const { messages, stream, openFiles, contextSize: rawContextSize } = req.body;
		const hasWorkspace = workspaceRoot && fs.existsSync(workspaceRoot);

		let requestedContextSize = Math.max(
			1024,
			Math.min(
				65536,
				Number(rawContextSize) ||
				Number(process.env.CODECRAB_CONTEXT_SIZE) ||
				config.generation.contextSize ||
				8192
			)
		);
		setEffectiveContextSize(requestedContextSize);

		console.log(`\n[Router] ========== INCOMING REQUEST ==========`);
		console.log(`[Router] Messages: ${messages?.length || 0}, workspace: ${workspaceRoot || 'none'}, openFiles: ${openFiles?.length || 0}, contextSize: ${requestedContextSize}`);

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

		// ── Stack profile (computed once per request) ───────────────────────
		// Derived from the user's own words: "single file", "vanilla", "no
		// libraries", "native ... only", "react". It decides whether we
		// scaffold a React toolchain, which prompts the model gets, and which
		// validation contract is enforced on the result.
		const stackProfile = detectStackProfile(lastUserMsg, {
			workspaceHasReact: hasWorkspace && workspaceHasTsx(workspaceRoot),
			packageJson: pkgContent,
		});
		const plainStack = stackProfile.kind === 'vanilla' || stackProfile.kind === 'single-file';

		// ── Generation budget sized to the deliverable ─────────────────────
		// A single-file app is ONE big file (6-10k tokens). With the default 8k
		// window the model is cut off mid-file, which is exactly how a truncated
		// index.html with a syntax error ends up on disk.
		if (requestedContextSize < stackProfile.minContextSize) {
			console.log(`[Router] Context ${requestedContextSize} -> ${stackProfile.minContextSize} (stack=${stackProfile.kind})`);
			requestedContextSize = stackProfile.minContextSize;
			setEffectiveContextSize(requestedContextSize);
		}
		const genMaxTokens = Math.min(
			stackProfile.recommendedMaxTokens,
			Math.max(2048, requestedContextSize - 4096),
		);

		// A single-file deliverable is one big artifact that a small model rarely
		// gets right in one shot — give it more repair rounds.
		const AGENT_ITERATIONS = stackProfile.kind === 'single-file' ? 10 : MAX_AGENT_ITERATIONS;
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
		const plannerContract = buildPlannerContract(lastUserMsg, rawAdvisorIntent, userScope);
		const validationContract = plannerContractToValidationContract(plannerContract, userScope, stackProfile);

		// filesModified is shared between incremental engine and the monolithic fallback loop
		const filesModified: string[] = [];
		// Files written by the SCAFFOLD (package.json, tsconfig, init.sh, ...).
		// These are NOT the deliverable — they are the project skeleton. Keeping
		// them separate is what lets the summary say "12 files on disk, 0 of them
		// generated" instead of the flat, misleading "12 files written".
		const scaffoldedFiles = new Set<string>();
		// Last attempt that failed validation — used for a best-effort write when
		// the iteration budget runs out, so the user is never left with nothing.
		let lastFailedEdits: GeneratedFile[] = [];


		// ---------------------------------------------------------------
		// VNEXT INCREMENTAL PIPELINE (Phase 1 — backend + fullstack create)
		// Attempt dependency-aware generation first.
		// Falls through to existing monolithic loop on any failure.
		// ---------------------------------------------------------------
		if (readWriteMode !== 'read' && hasWorkspace && advisorSaysCreate && intent !== 'frontend') {
			try {
				// ── 0. Bootstrap backend foundation files if create mode ───
				if (workspaceRoot) {
					const beBootstrapped = ensureBackendScaffold(workspaceRoot, lastUserMsg);
					for (const f of beBootstrapped) if (!filesModified.includes(f)) filesModified.push(f);
					for (const f of beBootstrapped) scaffoldedFiles.add(f);
					if (beBootstrapped.length > 0) {
						try { pkgContent = fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf-8'); } catch { }
						console.log(`[Router] VNext pipeline bootstrapped ${beBootstrapped.length} backend foundation files.`);
					}
				}

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


				const graph = buildExecutionGraph(v2ForGraph, inspection, lastUserMsg);

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
					const baseBePrompt = buildBESystemPrompt(lastUserMsg, 'create', openFiles?.[0], workspaceRoot);
					const incrSysPrompt = buildCapabilitySystemPrompt(baseBePrompt, features, architecture);

					// ── 6. Set up SSE stream ───────────────────────────────────
					res.setHeader('Content-Type', 'text/event-stream');
					res.setHeader('Cache-Control', 'no-cache');
					res.setHeader('Connection', 'keep-alive');
					streamChunk(res, `**Workspace**\n\n`);
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
						contextSize: requestedContextSize,
						maxTokensPerFile: genMaxTokens,
						onFileCommitted(node, content) {
							if (!filesModified.includes(node.path)) filesModified.push(node.path);
						},
					});

					// ── 8. FE phase (if fullstack + needs frontend) ────────────
					const isFullStack = intent === 'general' || rawAdvisorIntent.includes('fullstack');
					const runFEAfterIncremental = isFullStack && promptNeedsFrontend(lastUserMsg) && userScope !== 'BACKEND_ONLY';

					if (runFEAfterIncremental) {
						// FE phase proceeds through the existing FE specialist path
						// (reuse existing FE loop below by falling through after early-return)
						// We set up so the code below the incremental block handles FE.
						console.log('[Router] Incremental BE step completed — triggering FE phase via existing path.');
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
					const feSysPromptI = buildSystemPrompt(lastUserMsg, hasWorkspace, feMode, 'fe', feActiveFile, workspaceRoot, pkgContent, openFiles, readWriteMode, stackProfile);
					const feCtxIncr = await feModelIncr.createContext({ contextSize: requestedContextSize });
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
					try {
						const promptTok = feModelIncr ? feModelIncr.tokenize(feSysPromptI + '\n' + fePromptIncr).length : 0;
						const initTok = Math.max(feSessionIncr?.sequence?.nextTokenIndex || 0, promptTok);
						updateContextUsage(initTok, requestedContextSize, 'frontend');
						streamEvent(res, { type: 'context_usage', used: initTok, total: requestedContextSize, percent: Math.min(100, Math.round((initTok / requestedContextSize) * 100)), model: 'frontend' });
					} catch { }

					for (let feI = 0; feI < AGENT_ITERATIONS; feI++) {
						if (controller.signal.aborted) break;
						let feRespI = '';
						let feChunkCountI = 0;
						await feSessionIncr.prompt(feI === 0 ? fePromptIncr : fePromptIncr, {
							maxTokens: genMaxTokens,
							repeatPenalty: { penalty: REPEAT_PENALTY, lastTokens: REPEAT_PENALTY_TOKENS, penalizeNewLine: false },
							signal: controller.signal,
							stopOnAbortSignal: true,
							// Buffer internally — raw model tokens are never sent to chat
							onTextChunk(chunk) {
								feRespI += chunk;
								feChunkCountI++;
								if (feChunkCountI % 12 === 0) {
									try {
										const liveTok = feSessionIncr?.sequence?.nextTokenIndex || 0;
										if (liveTok > 0) {
											updateContextUsage(liveTok, requestedContextSize, 'frontend');
											streamEvent(res, { type: 'context_usage', used: liveTok, total: requestedContextSize, percent: Math.min(100, Math.round((liveTok / requestedContextSize) * 100)), model: 'frontend' });
										}
									} catch { }
								}
							},
						});
						try {
							const finTok = feSessionIncr?.sequence?.nextTokenIndex || 0;
							if (finTok > 0) {
								updateContextUsage(finTok, requestedContextSize, 'frontend');
								streamEvent(res, { type: 'context_usage', used: finTok, total: requestedContextSize, percent: Math.min(100, Math.round((finTok / requestedContextSize) * 100)), model: 'frontend' });
							}
						} catch { }
						if (!workspaceRoot) break;
						const feEdits = extractFallbackEdits(feRespI, openFiles, workspaceRoot, lastUserMsg, feMode);
						if (feEdits.length > 0) {
							for (const edit of feEdits) {
								streamEvent(res, { type: 'progress', stage: 'write', message: `Writing \`${edit.path}\`...`, file: edit.path });
								const feWR = executeToolCall({ name: 'writeFile', arguments: { path: edit.path, content: edit.content } }, workspaceRoot, openFiles, lastUserMsg, 'frontend', readWriteMode, rawAdvisorIntent?.startsWith('create_') === true);
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
						streamEvent(res, { type: 'success', stage: 'complete', message: `Complete · ${filesModified.filter(f => !scaffoldedFiles.has(f)).length} file(s) generated` });
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

		let activeModel = await mm.acquire(intent);
		console.log(`[Router] Intent: ${intent} (raw: ${rawAdvisorIntent}) scope: ${userScope}. needsFrontend=${needsFrontend}. Model: ${mm.status.activeKey}`);

		// Derive currentSpecialist from intent.
		// For fullstack (intent=general), BE runs first so specialist starts as 'be'.
		const initialSpecialist: 'be' | 'fe' = (intent === 'frontend') ? 'fe' : 'be';
		let currentSpecialist: 'be' | 'fe' = initialSpecialist;

		// Compute mode for this specialist independently
		let mode = determineMode(lastUserMsg, currentSpecialist, backendFileCount, frontendFileCount);

		// Auto-scaffold foundation files on create mode (package.json, tsconfig.json, init.sh, features.json, progress.txt)
		let bootstrappedCount = 0;
		if (workspaceRoot && (mode === 'create' || advisorSaysCreate)) {
			// Backend scaffolding when BE is active or prompt has backend/general intent
			if (currentSpecialist === 'be' || intent === 'backend' || intent === 'general') {
				const beBootstrapped = ensureBackendScaffold(workspaceRoot, lastUserMsg);
				bootstrappedCount += beBootstrapped.length;
				for (const f of beBootstrapped) if (!filesModified.includes(f)) filesModified.push(f);
				for (const f of beBootstrapped) scaffoldedFiles.add(f);
			}
			// Frontend scaffolding when FE is active or prompt has frontend signals
			if (currentSpecialist === 'fe' || intent === 'frontend' || (intent === 'general' && promptNeedsFrontend(lastUserMsg))) {
				const feBootstrapped = ensureFrontendScaffold(workspaceRoot, lastUserMsg, stackProfile);
				bootstrappedCount += feBootstrapped.length;
				for (const f of feBootstrapped) if (!filesModified.includes(f)) filesModified.push(f);
				for (const f of feBootstrapped) scaffoldedFiles.add(f);
			}
			if (bootstrappedCount > 0) {
				try {
					pkgContent = fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf-8');
				} catch { /* ignore */ }
				console.log(`[Router] Initializer bootstrapped ${bootstrappedCount} foundation files.`);
			}
		}

		console.log(`[Router] Phase 1 Specialist=${currentSpecialist}, Mode=${mode}`);

		const activeFile = openFiles && openFiles.length > 0 ? openFiles[0] : undefined;
		let systemPrompt = buildSystemPrompt(lastUserMsg, hasWorkspace, mode, currentSpecialist, activeFile, workspaceRoot, pkgContent, openFiles, readWriteMode, stackProfile);

		context = await activeModel.createContext({ contextSize: requestedContextSize });
		let session = new LlamaChatSession({
			contextSequence: context.getSequence(),
			systemPrompt: systemPrompt,
		});
		const activeContextSize = (context as any)?.contextSize || requestedContextSize;

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

		// Emit initial context usage baseline
		try {
			const promptTokens = activeModel ? activeModel.tokenize(systemPrompt + '\n' + enrichedLastMessage).length : 0;
			const initialTokens = Math.max(session?.sequence?.nextTokenIndex || 0, promptTokens);
			const modelLabel = currentSpecialist === 'be' ? 'backend' : 'frontend';
			updateContextUsage(initialTokens, activeContextSize, modelLabel);
			streamEvent(res, {
				type: 'context_usage',
				used: initialTokens,
				total: activeContextSize,
				percent: Math.min(100, Math.round((initialTokens / activeContextSize) * 100)),
				model: modelLabel
			});
			console.log(`[Router] Initial context usage (${modelLabel}): ${initialTokens}/${activeContextSize} tokens (${Math.round((initialTokens / activeContextSize) * 100)}%)`);
		} catch (e) {
			console.warn('[Router] Failed to emit initial context usage:', e);
		}

		const modelNames: Record<string, string> = { be: 'Backend Specialist', fe: 'Frontend Specialist' };
		const activeName = modelNames[mm.status.activeKey || ''] || 'Base Model';
		streamChunk(res, `**Workspace**\n\n`);
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
		let justCompacted = false;
		let compactionRetryDone = false;
		let loopRecoveryCount = 0;

		for (let iteration = 0; iteration < AGENT_ITERATIONS; iteration++) {
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
			let chunkCount = 0;
			let compactionTriggered = false;

			const iterController = new AbortController();
			const onGlobalAbort = () => iterController.abort();
			controller.signal.addEventListener('abort', onGlobalAbort);

			await session.prompt(currentPrompt, {
				maxTokens: genMaxTokens,
				repeatPenalty: {
					penalty: REPEAT_PENALTY,
					lastTokens: REPEAT_PENALTY_TOKENS,
					penalizeNewLine: false
				},
				signal: iterController.signal,
				stopOnAbortSignal: true,
				onTextChunk(chunk) {
					// Buffer internally; emit raw only when user explicitly requested code
					fullResponse += chunk;
					if (showRawOutput) streamChunk(res, chunk);

					// Stream live context usage updates
					chunkCount++;
					if (chunkCount % 12 === 0) {
						try {
							const liveTokens = session?.sequence?.nextTokenIndex || 0;
							if (liveTokens > 0) {
								const modelLabel = currentSpecialist === 'be' ? 'backend' : 'frontend';
								updateContextUsage(liveTokens, activeContextSize, modelLabel);
								streamEvent(res, {
									type: 'context_usage',
									used: liveTokens,
									total: activeContextSize,
									percent: Math.min(100, Math.round((liveTokens / activeContextSize) * 100)),
									model: modelLabel
								});

								// Check 75% cutoff threshold
								const COMPACTION_THRESHOLD = Math.round(activeContextSize * 0.75); // 6,144 tokens
								if (liveTokens >= COMPACTION_THRESHOLD && !compactionTriggered && iteration < AGENT_ITERATIONS - 1) {
									compactionTriggered = true;
									console.log(`[Router] 75% cutoff reached (${liveTokens}/${activeContextSize} tokens). Halting ${modelLabel} generator for auto-compaction.`);
									iterController.abort();
								}
							}
						} catch (e) { }
					}

					// Run repetition detector on every chunk
					const check = detectRepetitionLoop(fullResponse);
					if (check.detected) {
						loopDetected = true;
						loopReason = check.reason || 'Unknown repetition pattern';
						iterController.abort();
					}
				}
			});

			controller.signal.removeEventListener('abort', onGlobalAbort);

			try {
				const currentTokens = session?.sequence?.nextTokenIndex || 0;
				if (currentTokens > 0) {
					const modelLabel = currentSpecialist === 'be' ? 'backend' : 'frontend';
					updateContextUsage(currentTokens, activeContextSize, modelLabel);
					streamEvent(res, {
						type: 'context_usage',
						used: currentTokens,
						total: activeContextSize,
						percent: Math.min(100, Math.round((currentTokens / activeContextSize) * 100)),
						model: modelLabel
					});
				}
			} catch (e) { }

			if (loopDetected) {
				console.warn(`[Router] Loop detected: ${loopReason}. Harvesting files and recovering with fresh context.`);
				streamEvent(res, {
					type: 'warning',
					stage: 'generate',
					message: `Repetition detected. Harvesting files and restarting with fresh context sequence...`
				});

				// Harvest completed closed file blocks before cutoff
				if (workspaceRoot && fullResponse.length > 0) {
					const completedEdits = extractFallbackEdits(fullResponse, openFiles, workspaceRoot, lastUserMsg, mode, true);
					for (const edit of completedEdits) {
						const wr = executeToolCall({ name: 'writeFile', arguments: { path: edit.path, content: edit.content } }, workspaceRoot, openFiles, lastUserMsg, intent, readWriteMode, rawAdvisorIntent?.startsWith('create_') === true);
						if (wr.success && !filesModified.includes(edit.path)) {
							filesModified.push(edit.path);
							streamEvent(res, { type: 'success', stage: 'write', message: `Written \`${edit.path}\``, file: edit.path });
							if (wr.diffMsg) streamChunk(res, wr.diffMsg);
						}
					}
				}

				if (loopRecoveryCount < 3 && iteration < AGENT_ITERATIONS - 1) {
					loopRecoveryCount++;

					// Extract the looping file if matched
					const pathMatch = loopReason.match(/path="([^"]+)"/i);
					const loopingFile = (pathMatch && pathMatch[1]) ? pathMatch[1] : '';

					// Run 0.6B Advisor to distill the user goal into an atomic [TASK_SPEC]
					let taskSpec = '';
					try {
						const advisorModel = await mm.acquire('advisor');
						taskSpec = await runAdvisorLoopDecomposition(advisorModel, {
							userRequest: originalUserRequest,
							filesWritten: filesModified,
							loopingFile,
							specialist: currentSpecialist,
						});
					} catch (e: any) {
						console.warn('[Advisor] Loop task decomposition pass failed, using fallback:', e.message);
						taskSpec = `[TASK_SPEC]\nCOMPLETED: ${filesModified.join(', ') || 'None'}\nFORBIDDEN: Do not re-emit ${loopingFile}\nNEXT_TARGET_FILE: src/App.tsx (or next missing component)\nKEY_ELEMENTS: Wire all completed components with state and action handlers\n[/TASK_SPEC]`;
					}

					// Flush bloated/looping KV cache
					if (context) {
						await context.dispose();
						context = null;
					}

					// Re-acquire specialist model and re-arm fresh context
					activeModel = await mm.acquire(intent);
					context = await activeModel.createContext({ contextSize: activeContextSize });
					session = new LlamaChatSession({
						contextSequence: context.getSequence(),
						systemPrompt: systemPrompt,
					});

					// Select top 3 dependencies from disk
					const topDeps = workspaceRoot
						? selectTopDependencyFiles(workspaceRoot, filesModified, 'src/App.tsx', 3)
						: [];
					const depContextBlock = buildDependencyContextBlock(topDeps);

					currentPrompt = [
						`--- Repetition Recovery & Task Specification ---`,
						`A repetition pattern was detected on "${loopingFile || 'component'}". The context sequence has been wiped clean.`,
						`Advisor Task Specification:`,
						taskSpec,
						depContextBlock,
						`--- Required Action ---`,
						`1. Follow the [TASK_SPEC] above strictly: DO NOT output or repeat ${loopingFile || 'any completed file'}.`,
						`2. Generate the NEXT_TARGET_FILE specified in the task specification, or the remaining missing components.`,
						`3. If \`src/App.tsx\` needs to be created or updated, emit the complete <file path="src/App.tsx"> block wiring the components from disk. Do NOT emit a phantom wrapper like <MainView />.`,
						`4. Output your code as complete <file path="...">...</file> blocks. Do not output empty text.`,
					].filter(Boolean).join('\n\n');

					// Update baseline tokens
					const freshTokens = activeModel ? activeModel.tokenize(systemPrompt + '\n' + currentPrompt).length : 0;
					const newBaseline = Math.max(session.sequence?.nextTokenIndex || 0, freshTokens);
					const modelLabel = currentSpecialist === 'be' ? 'backend' : 'frontend';
					updateContextUsage(newBaseline, activeContextSize, modelLabel);
					streamEvent(res, {
						type: 'context_usage',
						used: newBaseline,
						total: activeContextSize,
						percent: Math.min(100, Math.round((newBaseline / activeContextSize) * 100)),
						model: modelLabel
					});

					console.log(`[Router] Context sequence reset cleanly. Resuming generation (loop recovery attempt ${loopRecoveryCount}/3)...`);
					continue;
				} else {
					if (filesModified.length > 0) {
						console.warn(`[Router] Max loop recovery attempts reached, but ${filesModified.length} file(s) are on disk. Proceeding.`);
						break;
					}
					throw new Error(`Infinite loop detected: ${loopReason}`);
				}
			}

			if (compactionTriggered) {
				const modelLabel = currentSpecialist === 'be' ? 'backend' : 'frontend';
				console.log(`[Router] Auto-compaction triggered at 75% cutoff for ${modelLabel}.`);
				streamEvent(res, {
					type: 'info',
					stage: 'plan',
					message: '75% context cutoff reached. Flushing KV cache & condensing context with Advisor...'
				});

				// Harvest only fully complete files generated so far before cutoff
				if (workspaceRoot && fullResponse.length > 0) {
					const completedEdits = extractFallbackEdits(fullResponse, openFiles, workspaceRoot, lastUserMsg, mode, true);
					for (const edit of completedEdits) {
						const wr = executeToolCall({ name: 'writeFile', arguments: { path: edit.path, content: edit.content } }, workspaceRoot, openFiles, lastUserMsg, intent, readWriteMode, rawAdvisorIntent?.startsWith('create_') === true);
						if (wr.success && !filesModified.includes(edit.path)) {
							filesModified.push(edit.path);
							streamEvent(res, { type: 'success', stage: 'write', message: `Written \`${edit.path}\``, file: edit.path });
							if (wr.diffMsg) streamChunk(res, wr.diffMsg);
						}
					}
				}

				// Run Advisor (0.6B) to generate a concise project state summary
				let projectSummary = '';
				try {
					const advisorModel = await mm.acquire('advisor');
					projectSummary = await runAdvisorProjectSummary(advisorModel, {
						userRequest: originalUserRequest,
						filesWritten: filesModified,
						partialSnippet: fullResponse.slice(-400),
						specialist: currentSpecialist,
					});
				} catch (e: any) {
					console.warn('[Advisor] Summary pass failed, using fallback summary:', e.message);
					projectSummary = currentSpecialist === 'be'
						? `Files completed: ${filesModified.join(', ') || 'None'}.\nREMAINING: Implement missing backend routes, controllers, and services.\nNEXT STEP: Generate the remaining backend files now.`
						: `Files completed: ${filesModified.join(', ') || 'None'}.\nREMAINING: Assemble all components in src/App.tsx with complete state and handlers.\nNEXT STEP: Generate src/App.tsx now.`;
				}

				// Flush bloated KV cache
				if (context) {
					await context.dispose();
					context = null;
				}

				// Re-acquire specialist model in VRAM (since Advisor pass swapped it)
				activeModel = await mm.acquire(intent);

				// Re-arm context with fresh 8K sequence retaining the ~20% baseline prompts
				context = await activeModel.createContext({ contextSize: activeContextSize });
				session = new LlamaChatSession({
					contextSequence: context.getSequence(),
					systemPrompt: systemPrompt,
				});

				// Reconstruct next prompt with constructive completion instructions
				if (currentSpecialist === 'be') {
					currentPrompt = [
						`--- Project State (After 75% Context Compaction) ---`,
						`Advisor Project Summary:\n${projectSummary}`,
						`Files written so far:\n${filesModified.map(f => `- ${f}`).join('\n') || 'None'}`,
						`--- Original User Request ---`,
						originalUserRequest,
						`--- Required Action ---`,
						`The backend generator was paused due to token limits and has now been given a fresh context sequence.`,
						`1. Inspect the original backend request against the files written so far.`,
						`2. If any requested database schema/model, Prisma file, route, controller, service, middleware, or utility is still missing or incomplete, generate it now.`,
						`3. If the server entrypoint (e.g. \`server.ts\`, \`src/server.ts\`, or \`src/app.ts\`) needs to be created or updated to register all routes, database connections, and middleware, emit the complete file block now.`,
						`4. Output your code as complete <file path="...">...</file> blocks. Do not output empty text.`,
					].join('\n\n');
				} else {
					const topDeps = workspaceRoot
						? selectTopDependencyFiles(workspaceRoot, filesModified, 'src/App.tsx', 3)
						: [];
					const depContextBlock = buildDependencyContextBlock(topDeps);

					currentPrompt = [
						`--- Project State (After 75% Context Compaction) ---`,
						`Advisor Project Summary:\n${projectSummary}`,
						`Files written so far:\n${filesModified.map(f => `- ${f}`).join('\n') || 'None'}`,
						depContextBlock,
						`--- Original User Request ---`,
						originalUserRequest,
						`--- Required Action ---`,
						`The generator was paused due to token limits and has now been given a fresh context sequence with the top dependency files preserved above.`,
						`1. Inspect the dependency files above to reference their exact exported component names, props, and interfaces.`,
						`2. If any requested component, modal, action handler, filter, or stat card is still missing or incomplete, generate it now.`,
						`3. If \`src/App.tsx\` needs to be created or updated, emit the complete <file path="src/App.tsx"> block wiring the components from disk. Do NOT emit a phantom wrapper like <MainView />.`,
						`4. Output your code as complete <file path="...">...</file> blocks. Do not output empty text.`,
					].filter(Boolean).join('\n\n');
				}

				// Compute and emit new ~20% baseline context usage
				const freshTokens = activeModel ? activeModel.tokenize(systemPrompt + '\n' + currentPrompt).length : 0;
				const newBaseline = Math.max(session.sequence?.nextTokenIndex || 0, freshTokens);
				updateContextUsage(newBaseline, activeContextSize, modelLabel);
				streamEvent(res, {
					type: 'context_usage',
					used: newBaseline,
					total: activeContextSize,
					percent: Math.min(100, Math.round((newBaseline / activeContextSize) * 100)),
					model: modelLabel
				});
				console.log(`[Router] Context flushed and re-armed at ~20% baseline (${modelLabel}): ${newBaseline}/${activeContextSize} tokens (${Math.round((newBaseline / activeContextSize) * 100)}%)`);

				compactionTriggered = false;
				justCompacted = true;
				continue;
			}

			if (controller.signal.aborted) {
				throw new Error('Generation was aborted during prompt execution.');
			}

			const responseTokenCount = activeModel ? activeModel.tokenize(fullResponse).length : 0;
			console.log(`[Router] Iteration ${iteration + 1} complete. Tokens generated: ${responseTokenCount}`);

			// ── Response diagnosis: truncated or prose? ─────────────────────
			// A severed or non-code response must never be written to disk.
			// Both cases are recoverable by re-prompting, and re-prompting is
			// strictly better than writing a broken file and reporting success.
			const diagnosis = diagnoseResponse(fullResponse, responseTokenCount, genMaxTokens);
			if (diagnosis.truncated || diagnosis.prose) {
				const canRetry = iteration < AGENT_ITERATIONS - 1 && !controller.signal.aborted;
				if (canRetry) {
					console.log(`[Router] Rejected response: ${diagnosis.reason}. Re-prompting.`);
					streamEvent(res, { type: 'warning', stage: 'generate', message: diagnosis.truncated ? 'Response was cut off at the generation limit — regenerating the remaining files.' : 'The model replied with prose instead of code — asking for the files.' });
					if (diagnosis.truncated) {
						const emitted = fullResponse.match(/<file\s+path=["']([^"']+)["']/gi)?.map(m => m.replace(/<file\s+path=["']|["']/gi, '')) ?? [];
						currentPrompt = buildTruncationContinuationPrompt(mode, lastUserMsg, emitted);
					} else {
						currentPrompt = buildProseOutputPrompt(mode, lastUserMsg);
					}
					continue;
				}
				throw new Error(`The model ${diagnosis.reason}. It could not be recovered within the iteration limit.`);
			}

			if (responseTokenCount < 30) {
				if (justCompacted && !compactionRetryDone) {
					compactionRetryDone = true;
					justCompacted = false;
					const modelLabel = currentSpecialist === 'be' ? 'Backend' : 'Frontend';
					console.log(`[Router] ${modelLabel} model produced empty response after compaction. Sending targeted completion directive...`);
					if (currentSpecialist === 'be') {
						currentPrompt = `<validation_repair>\nYou did not emit any code after compaction.\nBased on the backend request: "${originalUserRequest.slice(0, 300)}..."\nYou MUST output the complete, working server entry file or remaining route/controller (e.g. <file path="server.ts"> or <file path="src/server.ts">) that wires all endpoints and database models. Output the complete file now.\n</validation_repair>`;
					} else {
						currentPrompt = `<validation_repair>\nYou did not emit any code after compaction.\nBased on the request: "${originalUserRequest.slice(0, 300)}..."\nYou MUST output the complete, working <file path="src/App.tsx"> that imports all components, implements all state (useState) and action handlers, and renders the user interface. Output <file path="src/App.tsx"> now.\n</validation_repair>`;
					}
					continue;
				}
				console.log("[Router] Tiny response detected. Aborting to prevent infinite loop.");
				break;
			}
			justCompacted = false;
			// P1.8 — per-file content hashes, so a file the model cannot fix
			// is not re-prompted forever.
			const fileHashHistory = new Map<string, string>();
			const fileHashRepeat = new Map<string, number>();
			const stuckFiles = new Set<string>();



			// Check for identical responses (identical-response detection)
			const trimmedResponse = fullResponse.trim();
			if (responseHistory.includes(trimmedResponse)) {
				const errorMsg = 'Identical response detected from the model across iterations. Stopping to prevent infinite retry loop.';
				console.error(`[Router] ${errorMsg}`);
				streamChunk(res, `\n\n[Error] **Error:** ${errorMsg}\n`);
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

// ── P1.8: track per-file content hashes across iterations ────────
							//
			// The whole-response guard below took FIVE iterations to trip, and
			// each iteration cost a full model load + generation. The file-level
			// signal was already logged and unused:
			//
			//   [Stage4-Validator] src/App.tsx | unchanged hash=32d3418e700c
			//
			// If a file's hash is the same as last iteration, the model is not
			// making progress on it. Stop asking.
			if (typeof validationResult !== 'undefined' && validationResult) {
				const sha12p1 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
				for (const f of (validationResult.files ?? [])) {
					const h = sha12p1(f.content);
					const prev = fileHashHistory.get(f.path);
					if (prev === h) {
						const repeats = (fileHashRepeat.get(f.path) ?? 0) + 1;
						fileHashRepeat.set(f.path, repeats);
						if (repeats >= 2) {
							stuckFiles.add(f.path);
							console.warn(
								`[Router] ⚠️ ${f.path} has not changed for ${repeats} iterations — ` +
								`the model cannot fix it. Excluding it from the next repair prompt.`,
							);
						}
					} else {
						fileHashRepeat.set(f.path, 0);
					}
					fileHashHistory.set(f.path, h);
				}
			}
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

							// Never write files that failed validation. Broken code on disk is
							// worse than one more repair round-trip. On the final
							// iteration we write best-effort so the user still has
							// something to inspect.
							lastFailedEdits = validatedEdits;
							const writeAnyway = iteration === AGENT_ITERATIONS - 1;
							const writeList = (validationResult.passed || writeAnyway) ? validatedEdits : [];
							if (writeList.length === 0 && validatedEdits.length > 0) {
								console.log('[Router] Validation failed - skipping write, requesting repair instead.');
								streamEvent(res, { type: 'warning', stage: 'validate', message: 'Validation failed - regenerating before writing.' });
							}

							for (const edit of writeList) {
								// Apply fallback protection counts
								const attempts = (fileWriteAttempts.get(edit.path) || 0) + 1;
								fileWriteAttempts.set(edit.path, attempts);
								if (attempts > MAX_CORRECTIONS_PER_FILE) {
									throw new Error(`Fallback Protection: Path correction/rewrite loop detected for file "${edit.path}". Limit of ${MAX_CORRECTIONS_PER_FILE} writes exceeded.`);
								}

								streamEvent(res, { type: 'progress', stage: 'write', message: `Writing \`${edit.path}\`...`, file: edit.path });
								const result = executeToolCall({ name: 'writeFile', arguments: { path: edit.path, content: edit.content } }, workspaceRoot, openFiles, lastUserMsg, intent, readWriteMode, rawAdvisorIntent?.startsWith('create_') === true);
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
								if (iteration === AGENT_ITERATIONS - 1) {
									if (filesModified.length > 0) {
										console.warn(`[Router] Max agent iterations (${AGENT_ITERATIONS}) reached, but ${filesModified.length} file(s) were successfully written to disk. Exiting repair loop gracefully.`);
										streamChunk(res, `\n\n> Note: Validation completed after ${AGENT_ITERATIONS} steps. Generated files have been preserved on disk.\n`);
										break;
									}
									// Nothing passed validation: write the last attempt anyway so
									// the user gets a reviewable artifact instead of an empty
									// workspace. The failure is reported in the stream.
									if (lastFailedEdits.length > 0) {
										console.warn(`[Router] Max agent iterations (${AGENT_ITERATIONS}) reached with no passing validation — writing last attempt (best effort).`);
										streamEvent(res, { type: 'warning', stage: 'complete', message: 'Validation never passed — the last attempt was written for review. Check the reported issues.' });
										for (const edit of lastFailedEdits) {
											const wr = executeToolCall(
												{ name: 'writeFile', arguments: { path: edit.path, content: edit.content } },
												workspaceRoot, openFiles, lastUserMsg, intent, readWriteMode,
											);
											if (wr.success && !filesModified.includes(edit.path)) filesModified.push(edit.path);
										}
										break;
									}
									throw new Error(`Agent Iteration Protection: Exceeded maximum iteration limit of ${AGENT_ITERATIONS} steps without finding a valid correction.`);
								}
								// Abort guard — stop looping if client disconnected
								if (controller.signal.aborted) break;

								// ── P1.8: do not re-ask for a file the model cannot fix ──
								//
								// A file whose content hash has not changed for two iterations is
								// not going to change on the third. Asking again costs a full model
								// load + generation and produces the identical file.
								const stuckNow = [...stuckFiles];
								const repairableIssues = stuckNow.length > 0
									? validationResult.issues.filter(i => !i.file || !stuckFiles.has(i.file))
									: validationResult.issues;

								if (stuckNow.length > 0) {
									console.warn(
										`[Router] ⚠️ Excluding stuck file(s) from the repair prompt: ${stuckNow.join(', ')}`,
									);
									for (const s of stuckNow) {
										streamEvent(res, {
											type: 'error', stage: 'validate',
											message: `The model could not fix ${s} after several attempts — it was left unchanged.`,
											file: s,
										});
									}
								}

								// Every failing file is stuck — there is nothing left to ask for.
								// Stop instead of looping to the response-level guard.
								if (repairableIssues.length === 0 && stuckNow.length > 0) {
									throw new Error(
										`Repair stalled: the model could not fix ${stuckNow.join(', ')} ` +
										`after multiple attempts, and the content never changed.`,
									);
								}

								// Targeted repair: feed only specific issues back to the model
								const repairPrompt = currentSpecialist === 'fe'
									? buildFERepairPrompt(repairableIssues, filesModified)
									: buildTargetedRepairPrompt(repairableIssues, filesModified, workspaceRoot ?? '');
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
					const noOutput = jsxIssues.find(i => i.kind === 'no_output');
					if (noOutput) {
						// Nothing was parsed out of the response. The remedy is
						// to make the model emit code, not to repair symbols.
						if (iteration < AGENT_ITERATIONS - 1 && !controller.signal.aborted) {
							console.log('[Validator] no file blocks parsed from the response — re-prompting for code output.');
							currentPrompt = buildNoOutputPrompt(mode);
							continue;
						}
						throw new Error('The model did not produce any parseable file output. See the router log for the raw response.');
					}
					if (jsxIssues.length > 0 && iteration < AGENT_ITERATIONS - 1 && !controller.signal.aborted) {
						jsxRepairDoneMain = true;
						console.log(`[Validator] repairing ${jsxIssues.length} JSX issue(s) in main loop`);
						currentPrompt = buildJsxRepairPrompt(jsxIssues);
						continue;
					}
				}

				// Part B — files written summary (BE-only or single-specialist)
				if (filesModified.length > 0) {
					streamEvent(res, { type: 'success', stage: 'complete', message: `Complete · ${filesModified.filter(f => !scaffoldedFiles.has(f)).length} file(s) generated` });
					streamChunk(res, `\n**Files updated:**\n${filesModified.map(f => `- \`${f}\``).join('\n')}\n`);
				} else if (/(?:make|create|new|edit|update|change|add to) /i.test(lastUserMsg || '')) {
					// Fallback Protection: no file blocks generated for an explicit write request
					if (iteration < AGENT_ITERATIONS - 1) {
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

			// If we reached the last iteration and the model is trying to continue (e.g. it emitted a tool call), check if files were already generated
			if (iteration === AGENT_ITERATIONS - 1) {
				if (filesModified.length > 0) {
					console.warn(`[Router] Max agent iterations reached with active tool call, but ${filesModified.length} file(s) were written. Finishing.`);
					break;
				}
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

		const generatedCount = filesModified.filter(f => !scaffoldedFiles.has(f)).length;
		console.log(`[Router] BE phase finished. ${generatedCount} file(s) generated, ${scaffoldedFiles.size} scaffolded, ${filesModified.length} total on disk.`);

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
			let feModel = await mm.acquire('frontend');
			console.log('[Router] FE model acquired. Creating fresh context...');

			currentSpecialist = 'fe';
			// Recompute mode independently for FE
			mode = determineMode(lastUserMsg, currentSpecialist, backendFileCount, frontendFileCount);
			console.log(`[Router] Phase 2 Specialist=${currentSpecialist}, Mode=${mode}`);

			if (workspaceRoot && (mode === 'create' || advisorSaysCreate)) {
				const feBootstrapped = ensureFrontendScaffold(workspaceRoot, lastUserMsg, stackProfile);
				if (feBootstrapped.length > 0) {
					for (const f of feBootstrapped) if (!filesModified.includes(f)) filesModified.push(f);
					for (const f of feBootstrapped) scaffoldedFiles.add(f);
					try { pkgContent = fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf-8'); } catch { }
					console.log(`[Router] Initializer bootstrapped ${feBootstrapped.length} frontend foundation files for FE phase.`);
				}
			}

			// Build FE system prompt with FE specialist mode
			const feSystemPrompt = buildSystemPrompt(lastUserMsg, hasWorkspace, mode, 'fe', activeFile, workspaceRoot, pkgContent, openFiles, readWriteMode, stackProfile);

			// Fresh context — no shared state with BE session
			context = await feModel.createContext({ contextSize: requestedContextSize });
			let feSession = new LlamaChatSession({
				contextSequence: context.getSequence(),
				systemPrompt: feSystemPrompt,
			});
			const feContextSize = (context as any)?.contextSize || requestedContextSize;

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

			// Emit initial FE context usage
			try {
				const fePromptTokens = feModel ? feModel.tokenize(feSystemPrompt + '\n' + fePrompt).length : 0;
				const feInitialTokens = Math.max(feSession?.sequence?.nextTokenIndex || 0, fePromptTokens);
				updateContextUsage(feInitialTokens, feContextSize, 'frontend');
				streamEvent(res, {
					type: 'context_usage',
					used: feInitialTokens,
					total: feContextSize,
					percent: Math.min(100, Math.round((feInitialTokens / feContextSize) * 100)),
					model: 'frontend'
				});
				console.log(`[Router] Initial FE context usage: ${feInitialTokens}/${feContextSize} tokens (${Math.round((feInitialTokens / feContextSize) * 100)}%)`);
			} catch (e) { }

			const feResponseHistory: string[] = [];
			const feInitialFilesCount = filesModified.length;
			let feJsxRepairDone = false; // allow one JSX repair pass in FE loop
			let feJustCompacted = false;
			let feCompactionRetryDone = false;
			let feLoopRecoveryCount = 0;

			for (let feIter = 0; feIter < AGENT_ITERATIONS; feIter++) {
				console.log(`[Router] --- FE iteration ${feIter + 1} ---`);
				if (controller.signal.aborted) throw new Error('FE phase aborted.');

				let feResponse = '';
				let feLoopDetected = false;
				let feLoopReason = '';
				let feChunkCount = 0;
				let feCompactionTriggered = false;

				const feIterController = new AbortController();
				const onFeGlobalAbort = () => feIterController.abort();
				controller.signal.addEventListener('abort', onFeGlobalAbort);

				await feSession.prompt(fePrompt, {
					maxTokens: genMaxTokens,
					repeatPenalty: { penalty: REPEAT_PENALTY, lastTokens: REPEAT_PENALTY_TOKENS, penalizeNewLine: false },
					signal: feIterController.signal,
					stopOnAbortSignal: true,
					onTextChunk(chunk) {
						// Buffer internally — raw model tokens are never sent to chat
						feResponse += chunk;

						feChunkCount++;
						if (feChunkCount % 12 === 0) {
							try {
								const liveTokens = feSession?.sequence?.nextTokenIndex || 0;
								if (liveTokens > 0) {
									updateContextUsage(liveTokens, feContextSize, 'frontend');
									streamEvent(res, {
										type: 'context_usage',
										used: liveTokens,
										total: feContextSize,
										percent: Math.min(100, Math.round((liveTokens / feContextSize) * 100)),
										model: 'frontend'
									});

									// Check 75% cutoff threshold
									const COMPACTION_THRESHOLD = Math.round(feContextSize * 0.75); // 6,144 tokens
									if (liveTokens >= COMPACTION_THRESHOLD && !feCompactionTriggered && feIter < AGENT_ITERATIONS - 1) {
										feCompactionTriggered = true;
										console.log(`[Router] FE 75% cutoff reached (${liveTokens}/${feContextSize} tokens). Halting for auto-compaction.`);
										feIterController.abort();
									}
								}
							} catch { /* ignore */ }
						}

						const check = detectRepetitionLoop(feResponse);
						if (check.detected) { feLoopDetected = true; feLoopReason = check.reason || 'Unknown'; feIterController.abort(); }
					},
				});

				controller.signal.removeEventListener('abort', onFeGlobalAbort);

				try {
					const currentFeTokens = feSession?.sequence?.nextTokenIndex || 0;
					if (currentFeTokens > 0) {
						updateContextUsage(currentFeTokens, feContextSize, 'frontend');
						streamEvent(res, {
							type: 'context_usage',
							used: currentFeTokens,
							total: feContextSize,
							percent: Math.min(100, Math.round((currentFeTokens / feContextSize) * 100)),
							model: 'frontend'
						});
					}
				} catch (e) { }

				if (feLoopDetected) {
					console.warn(`[Router] FE Loop detected: ${feLoopReason}. Harvesting files and recovering with fresh context.`);
					streamEvent(res, {
						type: 'warning',
						stage: 'generate',
						message: `FE repetition detected. Harvesting files and restarting with fresh context sequence...`
					});

					// Harvest completed closed file blocks before cutoff
					if (workspaceRoot && feResponse.length > 0) {
						const completedEdits = extractFallbackEdits(feResponse, openFiles, workspaceRoot, lastUserMsg, mode, true);
						for (const edit of completedEdits) {
							const wr = executeToolCall({ name: 'writeFile', arguments: { path: edit.path, content: edit.content } }, workspaceRoot, openFiles, lastUserMsg, 'frontend', readWriteMode, rawAdvisorIntent?.startsWith('create_') === true);
							if (wr.success && !filesModified.includes(edit.path)) {
								filesModified.push(edit.path);
								streamEvent(res, { type: 'success', stage: 'write', message: `Written \`${edit.path}\``, file: edit.path });
								if (wr.diffMsg) streamChunk(res, wr.diffMsg);
							}
						}
					}

					if (feLoopRecoveryCount < 3 && feIter < AGENT_ITERATIONS - 1) {
						feLoopRecoveryCount++;

						const pathMatch = feLoopReason.match(/path="([^"]+)"/i);
						const loopingFile = (pathMatch && pathMatch[1]) ? pathMatch[1] : '';

						let feTaskSpec = '';
						try {
							const advisorModel = await mm.acquire('advisor');
							feTaskSpec = await runAdvisorLoopDecomposition(advisorModel, {
								userRequest: originalUserRequest,
								filesWritten: filesModified,
								loopingFile,
								specialist: 'fe',
							});
						} catch (e: any) {
							console.warn('[Advisor] FE Loop task decomposition pass failed, using fallback:', e.message);
							feTaskSpec = `[TASK_SPEC]\nCOMPLETED: ${filesModified.join(', ') || 'None'}\nFORBIDDEN: Do not re-emit ${loopingFile}\nNEXT_TARGET_FILE: src/App.tsx\nKEY_ELEMENTS: Wire all completed components with state and action handlers\n[/TASK_SPEC]`;
						}

						if (context) {
							await context.dispose();
							context = null;
						}

						feModel = await mm.acquire('frontend');
						context = await feModel.createContext({ contextSize: feContextSize });
						feSession = new LlamaChatSession({
							contextSequence: context.getSequence(),
							systemPrompt: feSystemPrompt,
						});

						const topDeps = workspaceRoot
							? selectTopDependencyFiles(workspaceRoot, filesModified, 'src/App.tsx', 3)
							: [];
						const depContextBlock = buildDependencyContextBlock(topDeps);

						fePrompt = [
							`--- Repetition Recovery & Task Specification ---`,
							`A repetition pattern was detected on "${loopingFile || 'component'}". The context sequence has been wiped clean.`,
							`Advisor Task Specification:`,
							feTaskSpec,
							depContextBlock,
							`--- Required Action ---`,
							`1. Follow the [TASK_SPEC] above strictly: DO NOT output or repeat ${loopingFile || 'any completed file'}.`,
							`2. Generate the NEXT_TARGET_FILE specified in the task specification, or the remaining missing components and src/App.tsx.`,
							`3. If \`src/App.tsx\` needs to be created or updated, emit the complete <file path="src/App.tsx"> block wiring the components from disk. Do NOT emit a phantom wrapper like <MainView />.`,
							`4. Output your code as complete <file path="...">...</file> blocks. Do not output empty text.`,
						].filter(Boolean).join('\n\n');

						const freshTokens = feModel ? feModel.tokenize(feSystemPrompt + '\n' + fePrompt).length : 0;
						const newBaseline = Math.max(feSession.sequence?.nextTokenIndex || 0, freshTokens);
						updateContextUsage(newBaseline, feContextSize, 'frontend');
						streamEvent(res, {
							type: 'context_usage',
							used: newBaseline,
							total: feContextSize,
							percent: Math.min(100, Math.round((newBaseline / feContextSize) * 100)),
							model: 'frontend'
						});

						console.log(`[Router] FE context sequence reset cleanly. Resuming generation (loop recovery attempt ${feLoopRecoveryCount}/3)...`);
						continue;
					} else {
						if (filesModified.length > feInitialFilesCount) {
							console.warn(`[Router] FE loop recovery limit reached, but files were written. Proceeding.`);
							break;
						}
						throw new Error(`FE loop: ${feLoopReason}`);
					}
				}

				if (feCompactionTriggered) {
					console.log('[Router] FE Auto-compaction triggered at 75% cutoff.');
					streamEvent(res, {
						type: 'info',
						stage: 'plan',
						message: '75% context cutoff reached. Flushing KV cache & condensing context with Advisor...'
					});

					// Harvest only fully complete files generated so far before cutoff
					if (workspaceRoot && feResponse.length > 0) {
						const completedEdits = extractFallbackEdits(feResponse, openFiles, workspaceRoot, lastUserMsg, mode, true);
						for (const edit of completedEdits) {
							const wr = executeToolCall({ name: 'writeFile', arguments: { path: edit.path, content: edit.content } }, workspaceRoot, openFiles, lastUserMsg, 'frontend', readWriteMode, rawAdvisorIntent?.startsWith('create_') === true);
							if (wr.success && !filesModified.includes(edit.path)) {
								filesModified.push(edit.path);
								streamEvent(res, { type: 'success', stage: 'write', message: `Written \`${edit.path}\``, file: edit.path });
								if (wr.diffMsg) streamChunk(res, wr.diffMsg);
							}
						}
					}

					let projectSummary = '';
					try {
						const advisorModel = await mm.acquire('advisor');
						projectSummary = await runAdvisorProjectSummary(advisorModel, {
							userRequest: originalUserRequest,
							filesWritten: filesModified,
							partialSnippet: feResponse.slice(-400),
							specialist: 'fe',
						});
					} catch (e: any) {
						console.warn('[Advisor] FE Summary pass failed, using fallback:', e.message);
						projectSummary = `Files completed: ${filesModified.join(', ') || 'None'}. Continue generating the remaining requested components.`;
					}

					if (context) {
						await context.dispose();
						context = null;
					}

					feModel = await mm.acquire('frontend');
					context = await feModel.createContext({ contextSize: feContextSize });
					feSession = new LlamaChatSession({
						contextSequence: context.getSequence(),
						systemPrompt: feSystemPrompt,
					});

					const topDeps = workspaceRoot
						? selectTopDependencyFiles(workspaceRoot, filesModified, 'src/App.tsx', 3)
						: [];
					const depContextBlock = buildDependencyContextBlock(topDeps);

					fePrompt = [
						`--- Project State (After 75% Context Compaction) ---`,
						`Advisor Project Summary:\n${projectSummary}`,
						`Files written so far:\n${filesModified.map(f => `- ${f}`).join('\n') || 'None'}`,
						depContextBlock,
						`--- Original User Request ---`,
						originalUserRequest,
						`--- Required Action ---`,
						`The generator was paused due to token limits and has now been given a fresh context sequence with the top dependency files preserved above.`,
						`1. Inspect the dependency files above to reference their exact exported component names, props, and interfaces.`,
						`2. If any requested component, modal, action handler, filter, or stat card is still missing or incomplete, generate it now.`,
						`3. If \`src/App.tsx\` needs to be created or updated to wire all state and components together, emit the complete <file path="src/App.tsx"> block now. Do NOT emit a phantom wrapper like <MainView />.`,
						`4. Output your code as complete <file path="...">...</file> blocks. Do not output empty text.`,
					].filter(Boolean).join('\n\n');

					const freshTokens = feModel ? feModel.tokenize(feSystemPrompt + '\n' + fePrompt).length : 0;
					const newBaseline = Math.max(feSession.sequence?.nextTokenIndex || 0, freshTokens);
					updateContextUsage(newBaseline, feContextSize, 'frontend');
					streamEvent(res, {
						type: 'context_usage',
						used: newBaseline,
						total: feContextSize,
						percent: Math.min(100, Math.round((newBaseline / feContextSize) * 100)),
						model: 'frontend'
					});
					console.log(`[Router] FE Context flushed and re-armed at ~20% baseline: ${newBaseline}/${feContextSize} tokens (${Math.round((newBaseline / feContextSize) * 100)}%)`);

					feCompactionTriggered = false;
					feJustCompacted = true;
					continue;
				}

				const feResponseTokenCount = feModel ? feModel.tokenize(feResponse).length : 0;
				console.log(`[Router] FE Iteration ${feIter + 1} complete. Tokens generated: ${feResponseTokenCount}`);
				console.log(`[RAW RESPONSE]\n${JSON.stringify(feResponse)}`);

				if (feResponseTokenCount < 30) {
					if (feJustCompacted && !feCompactionRetryDone) {
						feCompactionRetryDone = true;
						feJustCompacted = false;
						console.log("[Router] FE Model produced empty response after compaction. Sending targeted completion directive...");
						fePrompt = `<validation_repair>\nYou did not emit any code after compaction.\nBased on the request: "${originalUserRequest.slice(0, 300)}..."\nYou MUST output the complete, working <file path="src/App.tsx"> that imports all components, implements all state (useState) and action handlers, and renders the user interface. Output <file path="src/App.tsx"> now.\n</validation_repair>`;
						continue;
					}
					console.log("[Router] Tiny response detected. Aborting to prevent infinite loop.");
					break;
				}
				feJustCompacted = false;

				const trimmedFe = feResponse.trim();
				if (feResponseHistory.includes(trimmedFe)) throw new Error('FE: identical response across iterations.');
				feResponseHistory.push(trimmedFe);

				const feParsed = parseToolCall(feResponse);
				if (!feParsed) {
					// Final response — extract file blocks
					if (workspaceRoot) {
						const feRawEdits = extractFallbackEdits(feResponse, openFiles, workspaceRoot, lastUserMsg, mode);
						const feValidContract = plannerContractToValidationContract(plannerContract, 'FRONTEND_ONLY', stackProfile);
						const feValResult = feRawEdits.length > 0 && readWriteMode !== 'read'
							? await runPostGenerationValidator(feRawEdits, workspaceRoot, feValidContract)
							: null;

						// ── Validation gate + repair loop ─────────────────────────
						// Previously the validator ran but its verdict was DISCARDED:
						// broken output was written to disk as-is. Now a failed
						// validation sends the errors back to the model and the
						// files are only written once they pass.
						if (feValResult && !feValResult.passed && feIter < AGENT_ITERATIONS - 1) {
							const feErrors = feValResult.issues.filter(i => i.severity === 'error');
							if (feErrors.length > 0) {
								console.log(`[Validator] FE validation failed with ${feErrors.length} error(s) — requesting repair (iteration ${feIter + 1})`);
								streamEvent(res, {
									type: 'warning', stage: 'validate',
									message: `Validation failed (${feErrors.length} error(s)) — repairing...`,
								});
								fePrompt = plainStack
									? buildPlainStackRepairPrompt(feErrors, stackProfile.targetFile ?? 'index.html')
									: buildFERepairPrompt(feErrors, filesModified);
								continue;
							}
						}

						const fallback = feValResult ? feValResult.files : feRawEdits;
						if (fallback.length > 0 && readWriteMode !== 'read') {
							for (const edit of fallback) {
								streamEvent(res, { type: 'progress', stage: 'write', message: `Writing \`${edit.path}\`...`, file: edit.path });
								const feResult = executeToolCall({ name: 'writeFile', arguments: { path: edit.path, content: edit.content } }, workspaceRoot, openFiles, lastUserMsg, intent, readWriteMode, rawAdvisorIntent?.startsWith('create_') === true);
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
						const noOutput = jsxIssues.find(i => i.kind === 'no_output');
						if (noOutput) {
							// Nothing was parsed out of the response. The remedy is
							// to make the model emit code, not to repair symbols.
							if (feIter < AGENT_ITERATIONS - 1) {
								console.log('[Validator] no file blocks parsed from the response — re-prompting for code output.');
								fePrompt = buildNoOutputPrompt(mode);
								continue;
							}
							throw new Error('The model did not produce any parseable file output. See the router log for the raw response.');
						}
						if (jsxIssues.length > 0 && feIter < AGENT_ITERATIONS - 1) {
							feJsxRepairDone = true;
							console.log(`[Validator] repairing ${jsxIssues.length} JSX issue(s) in FE loop`);
							fePrompt = buildJsxRepairPrompt(jsxIssues);
							continue;
						}
					}

					// If no files were written in create mode, force retry
					if (mode === 'create' && (!workspaceRoot || filesModified.length === feInitialFilesCount)) {
						if (feIter < AGENT_ITERATIONS - 1) {
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
				streamEvent(res, { type: 'success', stage: 'complete', message: `Complete · ${filesModified.filter(f => !scaffoldedFiles.has(f)).length} file(s) generated` });
				streamChunk(res, `\n**Files updated:**\n${filesModified.map(f => `- \`${f}\``).join('\n')}\n`);
			}
		} // end if (isFullStackExecution)

		// ── Zero-output guard ────────────────────────────────────────────
		// A create request that produced no application file is a FAILURE.
		//
		// Before P0.3 the counts were conflated, so this was invisible: the
		// dashboard run reported "12 file(s) written" and a clean HTTP 200
		// while the model had written ZERO application files. Twelve scaffold
		// files were on disk and nothing was delivered.
		//
		// The guard is deliberately narrow:
		//   - create mode only (an edit that changes nothing is legal)
		//   - a workspace must be in play (a chat with no workspace is a
		//     conversation, not a deliverable)
		//   - the scaffold must have run (otherwise "no files" just means the
		//     user asked a question, which is not a failure)
		const generatedFinal = filesModified.filter(f => !scaffoldedFiles.has(f)).length;
		if (mode === 'create' && workspaceRoot && scaffoldedFiles.size > 0 && generatedFinal === 0) {
			const errorMsg = `The request asked for new files, but no application file was generated. `
				+ `${scaffoldedFiles.size} scaffolding file(s) were created, but the model produced no code. `
				+ `See the router log for the raw model response.`;
			console.error(`[Router] ${errorMsg}`);
			streamEvent(res, { type: 'error', stage: 'complete', message: errorMsg });
			if (!res.writableEnded) {
				res.write('data: [DONE]\n\n');
				res.end();
			}
			if (workspaceRoot) cleanupArtifacts(workspaceRoot);
			throw new Error(errorMsg);
		}

		// Terminate the stream with the standard sentinel so every client
		// (OpenAI-compatible ones included) sees an explicit end-of-stream.
		if (!res.writableEnded) {
			res.write('data: [DONE]\n\n');
			res.end();
		}
		if (workspaceRoot) cleanupArtifacts(workspaceRoot); // cleanup any remaining artifacts
		console.log(`[Router] Request finished. ${generatedFinal} file(s) generated, ${scaffoldedFiles.size} scaffolded, ${filesModified.length} total on disk.`);


	} catch (error: any) {
		console.error('[Router] Chat error:', error);
		const errorMsg = error?.message || String(error);
		if (!res.headersSent) {
			res.status(500).json({ error: errorMsg });
		} else {
			streamEvent(res, { type: 'error', stage: 'complete', message: `Processing terminated: ${errorMsg}` });
			if (!res.writableEnded) {
				res.write('data: [DONE]\n\n');
				res.end();
			}
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

const _asyncBus = new EventBus();
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
