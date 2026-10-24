import express from 'express';
import { makeChatRoutes } from './router/chatRoutes.js';
import { prepareRequest } from './chat/preparation.js';
import { runSpecialistPhase } from './chat/phaseRunner.js';
import { mm } from './models/legacyModelManager.js';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { LlamaContext, LlamaChatSession } from 'node-llama-cpp';
import { em } from './rag.js';
import { cleanupArtifacts, patchCachesFromArtifact } from './rag/index.js';
import { buildArtifactFromFiles, writeArtifact, deleteArtifact } from './rag/artifact.js';
import { inspectWorkspace } from './workspaceInspector.js';
import { buildExecutionGraph } from './planner.js';
import type { AdvisorV2Result } from './planner.js';
import { buildCapabilitySystemPrompt } from './capabilityResolver.js';
import { runIncrementalEngine, shouldUseIncrementalEngine } from './incrementalEngine.js';

// ── Async Job System (Phase 4) ─────────────────────────────────────────────
import { EventBus } from './core/eventBus.js';
import { Logger } from './logging/logger.js';
import { ModelManager } from './models/modelManager.js';
import { JobService } from './jobs/jobService.js';
import { RecoveryManager } from './jobs/recoveryManager.js';
import { makeJobRoutes } from './router/jobRoutes.js';
import config from '@/config/index.js';
import { updateContextUsage } from './telemetry/contextUsage.js';
import { ensureFrontendScaffold, ensureBackendScaffold } from './frontendScaffold.js';
import {
	extractBackendSummary,
	extractFallbackEdits,
	streamChunk,
	streamEvent,
} from './generation/pipelineHelpers.js';
import { determineMode } from './routing/agentMode.js';

import { buildBESystemPrompt, buildSystemPrompt } from './prompts/promptBuilder.js';

import { promptNeedsFrontend } from './routing/ensembleRouter.js';
import { executeToolCall } from './tools/toolEngine.js';
import { makeSystemRoutes } from './router/systemRoutes.js';
import { installCrashHandlers } from './server/crashHandlers.js';
import { beginRequest } from './server/requestLifecycle.js';
import { acquireRequestSlot, getActiveController, setActiveController, makeAbortRoutes } from './server/requestMutex.js';
import { makeEditRoutes } from './router/editRoutes.js';
import { makeRagRoutes } from './router/ragRoutes.js';

import {
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
// The system routes — /health, /stats, /context-usage, /v1/models.
// They were inline here AND in router/src/router/systemRoutes.ts,
// and the module was never mounted. The module is mounted now.
app.use('/', makeSystemRoutes());


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
// The RAG routes. They were inline here AND in
// router/src/router/ragRoutes.ts — the module was written but never
// mounted. The module is mounted now.
app.use('/v1', makeRagRoutes());


// The request serialisation mutex and the active-generation handle.
//
// Only one chat request runs at a time — a concurrent mm.acquire()
// can dispose a model that another request is actively generating
// into. And the abort route must reach the request that is running.
//
// They are a module because the route and the handler were coupled
// through a mutable module-level `activeController`. A module that
// owns both cannot be half-wired.
app.use('/v1', makeAbortRoutes());

// The SHADOW route — chatRoutes.ts, the newer architecture, mounted
// BESIDE the live one so the two can be compared.
//
// It runs at a different path, so it cannot be reached by accident.
// The editor talks to /v1/chat/completions; the shadow answers at
// /shadow/chat/completions.
//
// The shadow is a MEASUREMENT, not a replacement. Nothing in the
// editor uses it yet — it exists so that a request can be sent to
// both routes and the results compared.
app.use('/shadow', makeChatRoutes());

app.post('/v1/chat/completions', async (req, res) => {
	if (!mm.status.loaded && mm.status.loading) {
		return res.status(503).json({ error: 'Model swap in progress. Retry in a moment.' });
	}

	// Serialise: queue this request until the current one finishes
	const releaseSlot = await acquireRequestSlot();

	let context: LlamaContext | null = null;

	// The request lifecycle: the abort controller, the abort
	// listeners, the timeout, and the per-request tracking state.
	//
	// It is a module because the CLEANUP is the valuable part — the
	// slot must be released, the timer cleared, the context disposed
	// and the controller deregistered on EVERY exit path, including
	// the ones that throw. One owner for all four cannot get it
	// wrong, and cannot leak a slot when a new exit path is added.
	const life = beginRequest(req, res, {
		releaseSlot,
		timeoutMs: REQUEST_TIMEOUT_MS,
		registerController: (c) => { setActiveController(c); },
		deregisterController: (c) => { if (getActiveController() === c) setActiveController(null); },
		getContext: () => context,
		clearContext: () => { context = null; },
	});
	const { controller, fileWriteAttempts, responseHistory, timeoutId, totalCorrections } = life;

	try {
		const prep = await prepareRequest(req, res);
		if (prep.done) return;
		const {
				workspaceRoot, hasWorkspace, requestedContextSize,
				backendFileCount, frontendFileCount, pkgContent: initialPkgContent,
				lastUserMsg, stackProfile, plainStack,
				genMaxTokens, AGENT_ITERATIONS, readWriteMode,
				intent, userScope, advisorSaysCreate, rawAdvisorIntent,
				plannerContract, validationContract,
				filesModified, scaffoldedFiles, lastFailedEdits,
				beBootstrapped, needsFrontend,
				enrichedLastMessage, features, architecture,
				plannedModules, inspection, v2ForGraph, advisorV2Result,
				openFiles,
			} = prep;

		// pkgContent needs to be mutable for scaffold bootstrap in both VNext and monolithic paths
		let pkgContent = initialPkgContent;

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
		// needsFrontend is already computed in prepareRequest and destructured above

		// ============================================================================
		// A frontend-only request must never run a backend pass. The specialist is
		// derived from the router's intent (HEAD: index.ts:911); hardcoding 'be'
		// fed the FE model a backend system prompt and bootstrapped
		// package.json / tsconfig.json / .env into React-only projects.
		// ============================================================================
		const isFrontendOnly = intent === 'frontend';
		const isFullStackExecution = intent === 'general' ||
			rawAdvisorIntent === 'create_fullstack' || rawAdvisorIntent === 'edit_fullstack';

		// ============================================================================
		// PRIMARY PHASE — BE for backend/fullstack, FE for frontend-only
		// ============================================================================
		const primaryResult = await runSpecialistPhase(req, res, controller, timeoutId, {
			specialist: isFrontendOnly ? 'fe' : 'be',
			modelIntent: intent,
			buildPrompt: ({ userMsg, hasWorkspace, mode, specialist, activeFile, workspaceRoot, pkgContent, openFiles, readWriteMode, stackProfile }) =>
		buildSystemPrompt(userMsg, hasWorkspace, mode, specialist, activeFile, workspaceRoot, pkgContent, openFiles, readWriteMode, stackProfile),
		scaffold: isFrontendOnly ? ensureFrontendScaffold : ensureBackendScaffold,
		artifactType: isFrontendOnly ? 'fe' : 'be',
		// index.ts owns the BE artifact write under its fullstack guard — writing
		// here too duplicated it, and for BE-only requests it wrote an artifact
		// that was deleted again at the end of the same request.
		writeArtifact: false,
		phaseLabel: isFrontendOnly ? 'Frontend' : 'Backend',
		contextSize: requestedContextSize,
		genMaxTokens,
		maxIterations: AGENT_ITERATIONS,
		isFullStackExecution: isFullStackExecution && !isFrontendOnly,
		originalUserRequest: enrichedLastMessage,
		}, {
		workspaceRoot,
		hasWorkspace,
		filesModified,
		scaffoldedFiles,
		lastFailedEdits: [],
		backendFileCount,
		frontendFileCount,
		pkgContent,
		openFiles,
		readWriteMode,
		stackProfile,
		advisorSaysCreate,
		rawAdvisorIntent,
		activeFile: openFiles?.[0],
		lastUserMsg,
		});

		const generatedCount = primaryResult.generatedCount;

		// --- Write BE artifact + patch Tier-2 caches ---
		// Gives FE specialist deterministic context without extra LLM calls.
		if (primaryResult.isFullStackExecution && filesModified.length > 0 && workspaceRoot) {
		const beArtifact = buildArtifactFromFiles(workspaceRoot, filesModified, 'be');
		writeArtifact(workspaceRoot, beArtifact);
		patchCachesFromArtifact(workspaceRoot, beArtifact);
		console.log(`[ARTIFACT] BE artifact ready: ${beArtifact.symbols.length} symbols, ${beArtifact.routes?.length ?? 0} routes.`);
		}
		// ============================================================================
		// SECONDARY PHASE — FE after BE (fullstack only; skipped otherwise)
		// ============================================================================
		const feResult = await runSpecialistPhase(req, res, controller, timeoutId, {
		specialist: 'fe',
		modelIntent: 'frontend',
		buildPrompt: ({ userMsg, hasWorkspace, mode, specialist, activeFile, workspaceRoot, pkgContent, openFiles, readWriteMode, stackProfile }) =>
		buildSystemPrompt(userMsg, hasWorkspace, mode, specialist, activeFile, workspaceRoot, pkgContent, openFiles, readWriteMode, stackProfile),
		scaffold: ensureFrontendScaffold,
		artifactType: 'fe',
		writeArtifact: false,
		phaseLabel: 'Frontend',
		contextSize: requestedContextSize,
		genMaxTokens,
		maxIterations: AGENT_ITERATIONS,
		isFullStackExecution: isFullStackExecution,
		skipOnNoSignals: true,
		skipPhase: isFrontendOnly || !isFullStackExecution,
		originalUserRequest: enrichedLastMessage,
		}, {
		workspaceRoot,
		hasWorkspace,
		filesModified,
		scaffoldedFiles,
		lastFailedEdits: [],
		backendFileCount,
		frontendFileCount,
		pkgContent,
		openFiles,
		readWriteMode,
		stackProfile,
		advisorSaysCreate,
		rawAdvisorIntent,
		activeFile: openFiles?.[0],
		lastUserMsg,
		});

		if (!isFrontendOnly && isFullStackExecution) {
		console.log(`[Router] FE phase complete. Total files written: ${filesModified.length}.`);
		}

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
		// Compute primary mode for the zero-output guard
		const mode = determineMode(lastUserMsg, isFrontendOnly ? 'fe' : 'be', backendFileCount, frontendFileCount);

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
		const errorMsg = `The request asked for new files, but no application file was generated. ` +
		`${scaffoldedFiles.size} scaffolding file(s) were created, but the model produced no code. ` +
		`See the router log for the raw model response.`;
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
		// The lifecycle owns the cleanup: the timer, the context
		// disposal, the controller deregistration and the slot
		// release. It is idempotent, so a second call is harmless.
		await life.cleanup();
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
// The diff and approval routes. They were inline here AND in
// router/src/router/editRoutes.ts, with byte-identical bodies — the
// module was written but never mounted. The module is mounted now.
app.use('/v1', makeEditRoutes());


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

// The server object is KEPT. app.listen(PORT, ...) does not keep it,
// and a failed bind — EADDRINUSE, another router already on the port
// — is an unhandled 'error' event on a server nobody holds a
// reference to. Node throws it, and with no handler the process
// exits 1 with no explanation.
const server = app.listen(PORT, () => {
	console.log(`CodeCrab Native Model Router running on http://localhost:${PORT}`);
	console.log(`Engine: node-llama-cpp`);
	console.log(`Runtime Directory: ${config.runtime.root}`);
});

// The crash handlers. They used to be inline here, and the refactor
// commit 0b82970 deleted them — so the router died with exit code 1
// and no explanation, which is the exact failure they were added to
// prevent. They live in their own module now, so moving code around
// index.ts cannot lose them again.
installCrashHandlers(() => server);
