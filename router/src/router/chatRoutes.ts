import express, { Router } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { getLlama, Llama, LlamaModel, LlamaContext, LlamaChatSession } from 'node-llama-cpp';
import { em } from '../rag.js';
import {
	tier2Retrieve,
	patchTier2Caches,
	shouldSkipFEPhase,
	cleanupArtifacts,
	patchCachesFromArtifact,
} from '../rag/index.js';
import { buildArtifactFromFiles, writeArtifact, deleteArtifact, loadArtifact } from '../rag/artifact.js';
import { runPostGenerationValidator, type ValidationContract, type ValidationIssue } from '../validator.js';
import { inspectWorkspace } from '../workspaceInspector.js';
import {
	buildExecutionGraph,
	nextPendingNode,
	isGraphComplete,
	graphSummary,
	markNodeFailed,
	type AdvisorV2Result,
	type ExecutionGraph,
} from '../planner.js';
import { resolveCapabilities, loadCapabilityPrompts, buildCapabilitySystemPrompt } from '../capabilityResolver.js';
import { runIncrementalEngine, shouldUseIncrementalEngine } from '../incrementalEngine.js';
import { ensureGitRepo, commitHarnessTurn, getGitLogSummarySync } from '../gitHarness.js';
import { ensureFrontendScaffold, ensureBackendScaffold } from '../frontendScaffold.js';
import config from '@/config/index.js';

import { type UserScope, parseUserScope } from '../parsing/constraintParser.js';
import {
	type PlannerContract,
	buildPlannerContract,
	plannerContractToValidationContract,
} from '../parsing/plannerContract.js';
import {
	RepairMode,
	classifyRepairMode,
	collectWorkspaceModules,
	fileExists,
	buildTargetedRepairPrompt,
	buildFERepairPrompt,
} from '../repairEngine.js';
import { mm } from '../models/legacyModelManager.js';
import {
	type AdvisorIntent,
	runAdvisor as runAdvisorImpl,
	runAdvisorProjectSummary as runAdvisorProjectSummaryImpl,
	inferPreviousRoute,
	classifyOpenFile,
	scoreKeywords,
	detectAppType,
	detectFrontendIntent,
	detectBackendIntent,
	classifyIntent,
} from '../routing/intentClassifier.js';
import { updateContextUsage, setEffectiveContextSize, effectiveContextSize } from '../telemetry/contextUsage.js';
import {
	loadPrompt,
	type PromptRouterContext,
	workspaceHasTsx,
	injectPhase2Harness,
	buildFESystemPrompt,
	buildBESystemPrompt,
	buildSystemPrompt,
} from '../prompts/promptBuilder.js';
import {
	promptNeedsFrontend,
	shouldRunFrontend,
	isCreatePrompt,
	ensembleRoute,
} from '../routing/ensembleRouter.js';
import { type AgentMode, type PhaseState, determineMode } from '../routing/agentMode.js';
import {
	type BackendSummary,
	extractBackendSummary,
	type FallbackEdit,
	cleanCodeBlock,
	extractFallbackEdits,
	type JsxSymbolIssue,
	validateJsxSymbols,
	buildJsxRepairPrompt,
	extractRawCode,
	streamChunk,
	type PipelineEvent,
	streamEvent,
	isExplicitCodeRequest,
	escapeRegExp,
	detectRepetitionLoop,
} from '../generation/pipelineHelpers.js';
import {
	validateContentForExtension,
	validateTargetPath,
	type PendingEdit,
	type PendingSession,
	buildLCS,
	generateUnifiedDiff,
	pendingStore,
	createPendingSession,
	applyPendingSession,
	inferFilePath,
	buildDirectoryTree,
	readFileSafe,
	extractReferencedFiles,
	type ToolCallParsed,
	type ToolResult,
	parseToolCall,
	executeToolCall,
} from '../tools/toolEngine.js';
import {
	acquireRequestSlot,
	getActiveController,
	setActiveController,
	abortActiveGeneration,
} from '../server/requestMutex.js';

// ---------------------------------------------------------------------------
// Constants & Settings
// ---------------------------------------------------------------------------
const MAX_TOKENS = 4096;
const REPEAT_PENALTY = 1.18;
const REPEAT_PENALTY_TOKENS = 256;
const REQUEST_TIMEOUT_MS = 3600000; // 60 minutes (3600 seconds)
const MAX_AGENT_ITERATIONS = 6; // 3 for BE pass + 3 for FE pass in full-stack mode
const MAX_CORRECTIONS_PER_FILE = 3;
const MAX_TOTAL_CORRECTIONS = 5;

// ---------------------------------------------------------------------------
// Advisor Helper Passes
// ---------------------------------------------------------------------------
/**
 * Run the Advisor model pass (delegated to intentClassifier).
 */
async function runAdvisor(userRequest: string): Promise<AdvisorIntent | null>;
async function runAdvisor(userRequest: string, v2: true): Promise<{ intent: AdvisorIntent | null; v2Result: AdvisorV2Result | null }>;
async function runAdvisor(userRequest: string, v2 = false): Promise<any> {
	const advisorModel = await mm.acquire('advisor');
	return runAdvisorImpl(advisorModel, loadPrompt, userRequest, v2 as any);
}

/**
 * Run lightweight Advisor pass to summarize the project state (delegated to intentClassifier).
 */
async function runAdvisorProjectSummary(params: {
	userRequest: string;
	filesWritten: string[];
	partialSnippet: string;
	specialist?: 'fe' | 'be';
}): Promise<string> {
	const advisorModel = await mm.acquire('advisor');
	return runAdvisorProjectSummaryImpl(advisorModel, params);
}

export function makeChatRoutes(): Router {
	const router = Router();

router.post('/chat/abort', (_req, res) => {
	const aborted = abortActiveGeneration();
	if (aborted) {
		res.json({ aborted: true });
	} else {
		res.json({ aborted: false, reason: 'No active generation' });
	}
});

router.post('/chat/completions', async (req, res) => {
	if (!mm.status.loaded && mm.status.loading) {
		return res.status(503).json({ error: 'Model swap in progress. Retry in a moment.' });
	}

	// Serialise: queue this request until the current one finishes
	const releaseSlot = await acquireRequestSlot();

	let context: LlamaContext | null = null;
	const controller = new AbortController();
	setActiveController(controller); // register globally so /v1/chat/abort can reach it

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

		const requestedContextSize = Math.max(
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
		const activeContextSize = requestedContextSize;
		const feContextSize = requestedContextSize;

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
		const validationContract = plannerContractToValidationContract(plannerContract, userScope);

		// filesModified is shared between incremental engine and the monolithic fallback loop
		const filesModified: string[] = [];
		let bootstrappedCount = 0;

		// Derive currentSpecialist from intent.
		// For fullstack (intent=general), BE runs first so specialist starts as 'be'.
		const initialSpecialist: 'be' | 'fe' = (intent === 'frontend') ? 'fe' : 'be';
		let currentSpecialist: 'be' | 'fe' = initialSpecialist;
		let mode = determineMode(lastUserMsg, currentSpecialist, backendFileCount, frontendFileCount);

		// Auto-scaffold foundation files on create mode (package.json, tsconfig.json, init.sh, features.json, progress.txt)
		if (workspaceRoot && (mode === 'create' || advisorSaysCreate)) {
			// Backend scaffolding when BE is active or prompt has backend/general intent
			if (currentSpecialist === 'be' || intent === 'backend' || intent === 'general') {
				const beBootstrapped = ensureBackendScaffold(workspaceRoot, lastUserMsg);
				bootstrappedCount += beBootstrapped.length;
				for (const f of beBootstrapped) if (!filesModified.includes(f)) filesModified.push(f);
			}
			// Frontend scaffolding when FE is active or prompt has frontend signals
			if (currentSpecialist === 'fe' || intent === 'frontend' || (intent === 'general' && promptNeedsFrontend(lastUserMsg))) {
				const feBootstrapped = ensureFrontendScaffold(workspaceRoot, lastUserMsg);
				bootstrappedCount += feBootstrapped.length;
				for (const f of feBootstrapped) if (!filesModified.includes(f)) filesModified.push(f);
			}
			if (bootstrappedCount > 0) {
				try {
					pkgContent = fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf-8');
				} catch { /* ignore */ }
				console.log(`[Router] Initializer bootstrapped ${bootstrappedCount} foundation files.`);
			}
		}


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
					if (beBootstrapped.length > 0) {
						try { pkgContent = fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf-8'); } catch {}
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
					console.log(`[Router] Workspace: pkg=${!!pkgContent}, openFiles=${openFiles?.length || 0}`);
					console.log(`[Router] Planning: ${plannerContract.scope} · ${graph.nodes.length} file(s) across ${graph.generationOrder.length} stage(s)`);
					streamChunk(res, `Generating...\n\n`);

					try {
						const promptTokens = incrModel ? incrModel.tokenize(incrSysPrompt + '\n' + lastUserMsg).length : 0;
						updateContextUsage(promptTokens, requestedContextSize, 'backend');
						streamEvent(res, {
							type: 'context_usage',
							used: promptTokens,
							total: requestedContextSize,
							percent: Math.min(100, Math.round((promptTokens / requestedContextSize) * 100))
						});
					} catch (e) {
						console.warn('[Router] Failed to emit initial context usage in incremental engine:', e);
					}

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
						maxTokensPerFile: MAX_TOKENS,
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
						if (workspaceRoot && incrResult.committedFiles.length > 0) {
							try {
								const gitResult = await commitHarnessTurn(workspaceRoot, mode, lastUserMsg);
								if (gitResult.buildStatus) {
									streamEvent(res, {
										type: gitResult.buildStatus.passed ? 'success' : 'warning',
										stage: 'validate',
										message: gitResult.buildStatus.message,
									});
								}
								if (gitResult.committed) {
									streamEvent(res, { type: 'success', stage: 'complete', message: `Git commit: ${gitResult.hash} - ${gitResult.message}` });
								}
							} catch { /* non-fatal */ }
						}
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

		let activeModel = await mm.acquire(intent);
		console.log(`[Router] Intent: ${intent} (raw: ${rawAdvisorIntent}) scope: ${userScope}. needsFrontend=${needsFrontend}. Model: ${mm.status.activeKey}`);

		// Reset currentSpecialist and recompute mode for this specialist
		currentSpecialist = initialSpecialist;
		mode = determineMode(lastUserMsg, currentSpecialist, backendFileCount, frontendFileCount);

		console.log(`[Router] Phase 1 Specialist=${currentSpecialist}, Mode=${mode}`);

		const activeFile = openFiles && openFiles.length > 0 ? openFiles[0] : undefined;
		let systemPrompt = buildSystemPrompt(lastUserMsg, hasWorkspace, mode, currentSpecialist, activeFile, workspaceRoot, pkgContent, openFiles, readWriteMode);

		context = await activeModel.createContext({ contextSize: requestedContextSize });
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
		if (bootstrappedCount > 0) {
			console.log(`[Router] Initializer scaffolded turnkey frontend foundation (${bootstrappedCount} files)`);
		}
		console.log(`[Router] Reading workspace: pkg=${!!pkgContent}, openFiles=${openFiles?.length || 0}`);
		const showRawOutput = isExplicitCodeRequest(lastUserMsg) || readWriteMode === 'read';
		streamChunk(res, `Generating...\n\n`);

		// Emit initial context usage with loaded prompts and context
		try {
			const promptTokens = activeModel ? activeModel.tokenize(systemPrompt + '\n' + enrichedLastMessage).length : 0;
			const initialTokens = Math.max(session?.sequence?.nextTokenIndex || 0, promptTokens);
			updateContextUsage(initialTokens, activeContextSize, currentSpecialist);
			streamEvent(res, {
				type: 'context_usage',
				used: initialTokens,
				total: activeContextSize,
				percent: Math.min(100, Math.round((initialTokens / activeContextSize) * 100))
			});
			console.log(`[Router] Initial context usage: ${initialTokens}/${activeContextSize} tokens (${Math.round((initialTokens / activeContextSize) * 100)}%)`);
		} catch (e) {
			console.warn('[Router] Failed to emit initial context usage:', e);
		}

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
		// Fullstack execution = general intent OR an explicit create/edit_fullstack advisor intent (unless ensemble locked to frontend/backend).
		// Single-specialist intents (create_fe, edit_be, frontend, backend) NEVER trigger the BE→FE handoff.
		const isFullStackExecution =
			(intent === 'general' ||
			rawAdvisorIntent === 'create_fullstack' ||
			rawAdvisorIntent === 'edit_fullstack') &&
			intent !== 'frontend' && intent !== 'backend';

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
			let chunkCount = 0;
			let compactionTriggered = false;

			const iterController = new AbortController();
			const onGlobalAbort = () => iterController.abort();
			controller.signal.addEventListener('abort', onGlobalAbort);

			await session.prompt(currentPrompt, {
				maxTokens: MAX_TOKENS,
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

					// Stream live context usage periodically
					chunkCount++;
					if (chunkCount % 12 === 0) {
						try {
							const liveTokens = session.sequence?.nextTokenIndex || 0;
							if (liveTokens > 0) {
								updateContextUsage(liveTokens, activeContextSize, currentSpecialist);
								streamEvent(res, {
									type: 'context_usage',
									used: liveTokens,
									total: activeContextSize,
									percent: Math.min(100, Math.round((liveTokens / activeContextSize) * 100))
								});

								// Check 75% cutoff threshold
								const COMPACTION_THRESHOLD = Math.round(activeContextSize * 0.75);
								if (liveTokens >= COMPACTION_THRESHOLD && !compactionTriggered && iteration < MAX_AGENT_ITERATIONS - 1) {
									compactionTriggered = true;
									console.log(`[Router] 75% cutoff reached (${liveTokens}/${activeContextSize} tokens). Halting 3B generator for auto-compaction.`);
									iterController.abort();
								}
							}
						} catch { /* ignore */ }
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

			if (loopDetected) {
				console.warn(`[Router] Loop detected: ${loopReason}. Aborting generation.`);
				try {
					const liveTokens = session.sequence?.nextTokenIndex || 0;
					if (liveTokens > 0) {
						updateContextUsage(liveTokens, activeContextSize, currentSpecialist);
						streamEvent(res, {
							type: 'context_usage',
							used: liveTokens,
							total: activeContextSize,
							percent: Math.min(100, Math.round((liveTokens / activeContextSize) * 100))
						});
					}
				} catch { /* ignore */ }
				streamChunk(res, `\n\n**Generation stopped:** ${loopReason}\n`);
				throw new Error(`Infinite loop detected: ${loopReason}`);
			}

			if (compactionTriggered) {
				console.log('[Router] Auto-compaction triggered at 75% cutoff.');
				streamEvent(res, {
					type: 'info',
					stage: 'plan',
					message: '75% context cutoff reached. Flushing KV cache & summarizing with Advisor...'
				});

				// Harvest only fully complete files generated so far before cutoff
				if (workspaceRoot && fullResponse.length > 0) {
					const completedEdits = extractFallbackEdits(fullResponse, openFiles, workspaceRoot, lastUserMsg, mode, true);
					for (const edit of completedEdits) {
						const wr = executeToolCall({ name: 'writeFile', arguments: { path: edit.path, content: edit.content } }, workspaceRoot, openFiles, lastUserMsg, intent, readWriteMode);
						if (wr.success && !filesModified.includes(edit.path)) {
							filesModified.push(edit.path);
							streamEvent(res, { type: 'success', stage: 'write', message: `Written \`${edit.path}\``, file: edit.path });
							if (wr.diffMsg) streamChunk(res, wr.diffMsg);
						}
					}
				}

				// Run Advisor (0.6B) to generate a concise project state summary
				const projectSummary = await runAdvisorProjectSummary({
					userRequest: originalUserRequest,
					filesWritten: filesModified,
					partialSnippet: fullResponse.slice(-400),
					specialist: currentSpecialist,
				});

				// Flush bloated KV cache
				if (context) {
					await context.dispose();
					context = null;
				}

				// Re-acquire specialist model in VRAM (since Advisor pass swapped it)
				activeModel = await mm.acquire(intent);

				// Re-arm context with fresh sequence retaining the ~20% baseline prompts
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
					currentPrompt = [
						`--- Project State (After 75% Context Compaction) ---`,
						`Advisor Project Summary:\n${projectSummary}`,
						`Files written so far:\n${filesModified.map(f => `- ${f}`).join('\n') || 'None'}`,
						`--- Original User Request ---`,
						originalUserRequest,
						`--- Required Action ---`,
						`The generator was paused due to token limits and has now been given a fresh context sequence.`,
						`1. Inspect the original request against the files written so far.`,
						`2. If any requested component, modal, action handler, filter, or stat card is still missing or incomplete, generate it now.`,
						`3. If \`src/App.tsx\` needs to be created or updated to wire all state and components together, emit the complete <file path="src/App.tsx"> block now.`,
						`4. Output your code as complete <file path="...">...</file> blocks. Do not output empty text.`,
					].join('\n\n');
				}

				// Compute and emit new ~20% baseline context usage
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

			try {
				const currentTokens = session.sequence.nextTokenIndex;
				const modelLabel = currentSpecialist === 'be' ? 'backend' : 'frontend';
				updateContextUsage(currentTokens, activeContextSize, modelLabel);
				streamEvent(res, {
					type: 'context_usage',
					used: currentTokens,
					total: activeContextSize,
					percent: Math.min(100, Math.round((currentTokens / activeContextSize) * 100)),
					model: modelLabel
				});
				if (currentTokens >= Math.round(activeContextSize * 0.75)) {
					streamEvent(res, {
						type: 'warning',
						stage: 'generate',
						message: `Context window 75% filled (${currentTokens}/${activeContextSize} tokens). Auto-compaction trigger threshold reached.`
					});
				}
			} catch { /* sequence disposed or not tracking */ }

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

			// Check for identical responses (identical-response detection)
			const trimmedResponse = fullResponse.trim();
			if (responseHistory.includes(trimmedResponse)) {
				console.warn('[Router] Identical response detected from the model across iterations.');
				if (filesModified.length > 0) {
					streamEvent(res, {
						type: 'info',
						stage: 'complete',
						message: 'Model finished generation. Preserving generated files and concluding.'
					});
					break;
				}
				const errorMsg = 'Identical response detected from the model across iterations. Stopping to prevent infinite retry loop.';
				console.error(`[Router] ${errorMsg}`);
				streamChunk(res, `\n\n**Error:** ${errorMsg}\n`);
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
									console.warn(`[Router] Exceeded maximum iteration limit of ${MAX_AGENT_ITERATIONS} steps.`);
									if (filesModified.length > 0) {
										streamEvent(res, {
											type: 'warning',
											stage: 'complete',
											message: `Generation completed with ${filesModified.length} file(s) saved. (Max retry limit reached).`
										});
										break;
									}
									throw new Error(`Agent Iteration Protection: Exceeded maximum iteration limit of ${MAX_AGENT_ITERATIONS} steps without finding a valid correction.`);
								}
								// Abort guard — stop looping if client disconnected
								if (controller.signal.aborted) break;

								// Targeted repair: feed only specific issues back to the model
								const repairPrompt = currentSpecialist === 'fe'
									? buildFERepairPrompt(validationResult.issues, filesModified)
									: buildTargetedRepairPrompt(validationResult.issues, filesModified, workspaceRoot ?? '');
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

				// Part B — files written summary & application guard
				const newFilesWrittenCount = filesModified.length - bootstrappedCount;
				const isFrontendCreate = (mode === 'create' || advisorSaysCreate) && (currentSpecialist === 'fe' || intent === 'frontend');
				const hasFrontendAppCode = filesModified.some(f => /src\/(App\.[tj]sx|components\/.*)/i.test(f));

				// If in frontend create mode and model hasn't generated src/App.tsx or components, force retry
				if (isFrontendCreate && !hasFrontendAppCode && readWriteMode !== 'read') {
					if (iteration < MAX_AGENT_ITERATIONS - 1 && !controller.signal.aborted) {
						console.log(`[Router] Create mode: Missing application code (src/App.tsx). Looping back to LLM...`);
						currentPrompt = `<validation_errors>\nThe project foundation files (package.json, index.html, vite.config.ts, tsconfig.json, init.sh) have already been scaffolded.\nHowever, you have NOT generated the core application component yet!\n\nYou MUST generate:\n<file path="src/App.tsx">\n// Complete React implementation of the requested UI and features\n</file>\n\nDo NOT output plain text, explanations, or markdown code fences. Output ONLY valid <file path="...">...</file> blocks.\n</validation_errors>\n\nPlease output src/App.tsx now:`;
						continue;
					} else {
						if (filesModified.length > 0) {
							console.warn('[Router] Iteration limit reached, preserving existing files.');
							break;
						}
						throw new Error(`Agent Iteration Protection: Exceeded maximum iteration limit without generating src/App.tsx.`);
					}
				}

				if (newFilesWrittenCount > 0 || filesModified.length > 0) {
					if (newFilesWrittenCount === 0 && /(?:make|create|new|edit|update|change|add to) /i.test(lastUserMsg || '') && readWriteMode !== 'read') {
						// Fallback Protection: only bootstrapped files exist, model generated no new files
						if (iteration < MAX_AGENT_ITERATIONS - 1 && !controller.signal.aborted) {
							console.log(`[Router] Fallback protection: Model emitted no new files, looping back to LLM...`);
							currentPrompt = `<validation_errors>\nYou did not output any valid file blocks.\n\nYou MUST use the exact <file path="...">...</file> format to generate code.\nDo not use markdown code fences.\n</validation_errors>\n\nPlease try again.`;
							continue;
						} else {
							if (filesModified.length > 0) break;
							throw new Error(`Agent Iteration Protection: Exceeded maximum iteration limit of ${MAX_AGENT_ITERATIONS} steps without generating the requested files.`);
						}
					}
					streamEvent(res, { type: 'success', stage: 'complete', message: `Complete · ${filesModified.length} file(s) updated` });
					streamChunk(res, `\n**Files updated:**\n${filesModified.map(f => `- \`${f}\``).join('\n')}\n`);
				} else if (/(?:make|create|new|edit|update|change|add to) /i.test(lastUserMsg || '')) {
					// Fallback Protection: no file blocks generated for an explicit write request
					if (iteration < MAX_AGENT_ITERATIONS - 1 && !controller.signal.aborted) {
						console.log(`[Router] Fallback protection: Missing file blocks, looping back to LLM...`);
						currentPrompt = `<validation_errors>\nYou did not output any valid file blocks.\n\nYou MUST use the exact <file path="...">...</file> format to generate code.\nDo not use markdown code fences.\n</validation_errors>\n\nPlease try again.`;
						continue;
					} else {
						if (filesModified.length > 0) break;
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

			if (workspaceRoot && (mode === 'create' || advisorSaysCreate)) {
				const feBootstrapped = ensureFrontendScaffold(workspaceRoot, lastUserMsg);
				if (feBootstrapped.length > 0) {
					for (const f of feBootstrapped) if (!filesModified.includes(f)) filesModified.push(f);
					try { pkgContent = fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf-8'); } catch {}
					console.log(`[Router] Initializer bootstrapped ${feBootstrapped.length} frontend foundation files for FE phase.`);
				}
			}

			// Build FE system prompt with FE specialist mode
			const feSystemPrompt = buildSystemPrompt(lastUserMsg, hasWorkspace, mode, 'fe', activeFile, workspaceRoot, pkgContent, openFiles, readWriteMode);

			// Fresh context — no shared state with BE session
			context = await feModel.createContext({ contextSize: feContextSize });
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
				const beArt = loadArtifact(workspaceRoot, 'be');
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

			try {
				const fePromptTokens = feModel ? feModel.tokenize(feSystemPrompt + '\n' + fePrompt).length : 0;
				const feInitialTokens = Math.max(feSession?.sequence?.nextTokenIndex || 0, fePromptTokens);
				updateContextUsage(feInitialTokens, feContextSize, 'frontend');
				streamEvent(res, {
					type: 'context_usage',
					used: feInitialTokens,
					total: feContextSize,
					percent: Math.min(100, Math.round((feInitialTokens / feContextSize) * 100))
				});
			} catch (e) {
				console.warn('[Router] Failed to emit FE initial context usage:', e);
			}

			for (let feIter = 0; feIter < MAX_AGENT_ITERATIONS; feIter++) {
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
					maxTokens: MAX_TOKENS,
					repeatPenalty: { penalty: REPEAT_PENALTY, lastTokens: REPEAT_PENALTY_TOKENS, penalizeNewLine: false },
					signal: feIterController.signal,
					stopOnAbortSignal: true,
					onTextChunk(chunk) {
						// Buffer internally — raw model tokens are never sent to chat
						feResponse += chunk;

						feChunkCount++;
						if (feChunkCount % 12 === 0) {
							try {
								const liveTokens = feSession.sequence?.nextTokenIndex || 0;
								if (liveTokens > 0) {
									updateContextUsage(liveTokens, feContextSize, 'frontend');
									streamEvent(res, {
										type: 'context_usage',
										used: liveTokens,
										total: feContextSize,
										percent: Math.min(100, Math.round((liveTokens / feContextSize) * 100))
									});

									// Check 75% cutoff threshold
									const COMPACTION_THRESHOLD = Math.round(feContextSize * 0.75);
									if (liveTokens >= COMPACTION_THRESHOLD && !feCompactionTriggered && feIter < MAX_AGENT_ITERATIONS - 1) {
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

				if (feLoopDetected) {
					try {
						const liveTokens = feSession.sequence?.nextTokenIndex || 0;
						if (liveTokens > 0) {
							updateContextUsage(liveTokens, feContextSize, 'frontend');
							streamEvent(res, {
								type: 'context_usage',
								used: liveTokens,
								total: feContextSize,
								percent: Math.min(100, Math.round((liveTokens / feContextSize) * 100))
							});
						}
					} catch { /* ignore */ }
					streamEvent(res, { type: 'warning', stage: 'generate', message: `FE generation stopped: ${feLoopReason}` });
					throw new Error(`FE loop: ${feLoopReason}`);
				}

				if (feCompactionTriggered) {
					console.log('[Router] FE Auto-compaction triggered at 75% cutoff.');
					streamEvent(res, {
						type: 'info',
						stage: 'plan',
						message: '75% context cutoff reached. Flushing KV cache & summarizing with Advisor...'
					});

					// Harvest only fully complete files generated so far before cutoff
					if (workspaceRoot && feResponse.length > 0) {
						const completedEdits = extractFallbackEdits(feResponse, openFiles, workspaceRoot, lastUserMsg, mode, true);
						for (const edit of completedEdits) {
							const wr = executeToolCall({ name: 'writeFile', arguments: { path: edit.path, content: edit.content } }, workspaceRoot, openFiles, lastUserMsg, 'frontend', readWriteMode);
							if (wr.success && !filesModified.includes(edit.path)) {
								filesModified.push(edit.path);
								streamEvent(res, { type: 'success', stage: 'write', message: `Written \`${edit.path}\``, file: edit.path });
								if (wr.diffMsg) streamChunk(res, wr.diffMsg);
							}
						}
					}

					const projectSummary = await runAdvisorProjectSummary({
						userRequest: originalUserRequest,
						filesWritten: filesModified,
						partialSnippet: feResponse.slice(-400),
					});

					if (context) {
						await context.dispose();
						context = null;
					}

					const freshFeModel = await mm.acquire('frontend');
					context = await freshFeModel.createContext({ contextSize: feContextSize });
					const newFeSession = new LlamaChatSession({
						contextSequence: context.getSequence(),
						systemPrompt: feSystemPrompt,
					});

					fePrompt = [
						`--- Project Brain Summary (Advisor Auto-Compaction) ---`,
						projectSummary,
						`--- Files Already Completed (Do NOT re-generate) ---`,
						filesModified.map(f => `- ${f}`).join('\n') || 'None',
						`--- Original Request ---`,
						originalUserRequest,
						`\nResume generation. Output ONLY the remaining uncompleted files as <file path="...">...</file> blocks. Do NOT re-emit files that are already completed.`,
					].join('\n\n');

					const freshTokens = feModel ? feModel.tokenize(feSystemPrompt + '\n' + fePrompt).length : 0;
					const newBaseline = Math.max(newFeSession.sequence?.nextTokenIndex || 0, freshTokens);
					updateContextUsage(newBaseline, feContextSize, 'frontend');
					streamEvent(res, {
						type: 'context_usage',
						used: newBaseline,
						total: feContextSize,
						percent: Math.min(100, Math.round((newBaseline / feContextSize) * 100))
					});
					console.log(`[Router] FE Context flushed and re-armed at ~20% baseline: ${newBaseline}/${feContextSize} tokens (${Math.round((newBaseline / feContextSize) * 100)}%)`);

					feCompactionTriggered = false;
					continue;
				}

				const feResponseTokenCount = feModel ? feModel.tokenize(feResponse).length : 0;
				console.log(`[Router] FE Iteration ${feIter + 1} complete. Tokens generated: ${feResponseTokenCount}`);

				try {
					const currentTokens = feSession.sequence.nextTokenIndex;
					updateContextUsage(currentTokens, feContextSize, 'frontend');
					streamEvent(res, {
						type: 'context_usage',
						used: currentTokens,
						total: feContextSize,
						percent: Math.min(100, Math.round((currentTokens / feContextSize) * 100))
					});
					if (currentTokens >= Math.round(feContextSize * 0.75)) {
						streamEvent(res, {
							type: 'warning',
							stage: 'generate',
							message: `Context window 75% filled (${currentTokens}/${feContextSize} tokens). Auto-compaction trigger threshold reached.`
						});
					}
				} catch { /* sequence disposed or not tracking */ }
				console.log(`[RAW RESPONSE]\n${JSON.stringify(feResponse)}`);

				if (feResponseTokenCount < 30) {
					console.log("[Router] Tiny response detected. Aborting to prevent infinite loop.");
					break;
				}

				const trimmedFe = feResponse.trim();
				if (feResponseHistory.includes(trimmedFe)) {
					console.warn('[Router] FE: identical response across iterations.');
					if (filesModified.length > 0) {
						streamEvent(res, {
							type: 'info',
							stage: 'complete',
							message: 'Frontend generation completed. Preserving generated files and concluding.'
						});
						break;
					}
					throw new Error('FE: identical response across iterations without generating files.');
				}
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

		} // end if (isFullStackExecution)

		// Emit completion summary & create git harness commit
		if (filesModified.length > 0) {
			if (workspaceRoot) {
				try {
					const gitResult = await commitHarnessTurn(workspaceRoot, mode, lastUserMsg);
					if (gitResult.buildStatus) {
						streamEvent(res, {
							type: gitResult.buildStatus.passed ? 'success' : 'warning',
							stage: 'validate',
							message: gitResult.buildStatus.message,
						});
					}
					if (gitResult.committed) {
						streamEvent(res, { type: 'success', stage: 'complete', message: `Git commit: ${gitResult.hash} - ${gitResult.message}` });
						streamChunk(res, `\n**Git commit created:** \`${gitResult.hash}\` - *${gitResult.message}*\n`);
					}
				} catch { /* non-fatal */ }
			}
			streamEvent(res, { type: 'success', stage: 'complete', message: `Complete · ${filesModified.length} file(s) updated` });
			streamChunk(res, `\n**Files updated:**\n${filesModified.map(f => `- \`${f}\``).join('\n')}\n`);
		}

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
		if (getActiveController() === controller) setActiveController(null); // deregister
		releaseSlot();
	}
});

// Inline Completions (FIM)
router.post('/completions', async (req, res) => {
	res.status(501).json({ error: 'Inline completions using node-llama-cpp is not fully implemented yet.' });
});

	return router;
}
