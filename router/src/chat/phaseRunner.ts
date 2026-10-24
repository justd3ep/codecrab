/**
 * phaseRunner.ts — unified specialist phase runner.
 *
 * Extracts the common logic from the BE loop (~804 lines) and FE phase (~508 lines)
 * into a single parameterised function. Differences are injected via config object.
 *
 * Called from index.ts for both backend and frontend phases.
 */

import { mm } from '../models/legacyModelManager.js';
import { LlamaChatSession } from 'node-llama-cpp';
import { buildSystemPrompt, buildFESystemPrompt } from '../prompts/promptBuilder.js';
import { determineMode } from '../routing/agentMode.js';
import { ensureBackendScaffold, ensureFrontendScaffold } from '../frontendScaffold.js';
import { executeToolCall } from '../tools/toolEngine.js';
import { extractFallbackEdits, type FallbackEdit } from '../generation/pipelineHelpers.js';
import { updateContextUsage } from '../telemetry/contextUsage.js';
import { streamChunk, streamEvent } from '../generation/pipelineHelpers.js';
import { REPEAT_PENALTY, REPEAT_PENALTY_TOKENS, MAX_AGENT_ITERATIONS } from '../generation/limits.js';
import { buildArtifactFromFiles, writeArtifact, patchCachesFromArtifact, deleteArtifact } from '../rag/artifact.js';
import { shouldRunFrontend } from '../routing/ensembleRouter.js';
import type { Request, Response } from 'express';
import type { PlannerContract } from '../parsing/plannerContract.js';
import type { AgentMode } from '../routing/agentMode.js';

export interface PhaseConfig {
	/** 'be' or 'fe' — determines model, prompt builder, scaffold function, artifact type */
	specialist: 'be' | 'fe';
	/** Model intent key for mm.acquire ('backend' | 'frontend' | 'general') */
	modelIntent: 'backend' | 'frontend' | 'general';
	/** System prompt builder — receives (userMsg, hasWorkspace, mode, activeFile, workspaceRoot, pkgContent, openFiles, readWriteMode, stackProfile) */
	buildPrompt: (args: {
		userMsg: string;
		hasWorkspace: boolean;
		mode: AgentMode;
		specialist: 'be' | 'fe';
		activeFile: string | undefined;
		workspaceRoot: string | undefined;
		pkgContent: string;
		openFiles: string[] | undefined;
		readWriteMode: 'write' | 'read' | undefined;
		stackProfile: any;
	}) => string;
	/** Scaffold function for create mode */
	scaffold: (workspaceRoot: string, userMsg: string, stackProfile?: any) => string[];
	/** Artifact type for writeArtifact/patchCachesFromArtifact */
	artifactType: 'be' | 'fe';
	/** Whether to write artifact after phase (BE phase only) */
	writeArtifact?: boolean;
	/** Pre-phase context blocks (e.g., BE artifact for FE phase) */
	preContextBlocks?: string[];
	/** Post-phase artifact cleanup (FE phase deletes BE artifact) */
	cleanupArtifact?: boolean;
	/** Phase label for logging */
	phaseLabel: 'Backend' | 'Frontend';
	/** Context size for this phase */
	contextSize: number;
	/** Max tokens per generation */
	genMaxTokens: number;
	/** Maximum iterations for this phase */
	maxIterations: number;
	/** Whether this is a fullstack execution (affects handoff logic) */
	isFullStackExecution: boolean;
	/** Original user request (for FE context) */
	originalUserRequest: string;
	/** Whether to skip FE based on prompt signals (FE phase only) */
	skipOnNoSignals?: boolean;
	/** Skip this phase entirely — returns without acquiring a model or scaffolding */
	skipPhase?: boolean;
}

export interface PhaseResult {
	filesModified: string[];
	scaffoldedFiles: Set<string>;
	generatedCount: number; // non-scaffold files
	contextDisposed: boolean;
	/** Whether this was a fullstack execution (affects FE handoff logic) */
	isFullStackExecution: boolean;
}

export async function runSpecialistPhase(
	req: Request,
	res: Response,
	controller: AbortController,
	timeoutId: NodeJS.Timeout,
	config: PhaseConfig,
	shared: {
		workspaceRoot: string | undefined;
		hasWorkspace: boolean;
		filesModified: string[];
		scaffoldedFiles: Set<string>;
		lastFailedEdits: string[];
		backendFileCount: number;
		frontendFileCount: number;
		pkgContent: string;
		openFiles: string[] | undefined;
		readWriteMode: 'write' | 'read' | undefined;
		stackProfile: any;
		advisorSaysCreate: boolean;
		rawAdvisorIntent: string;
		activeFile: string | undefined;
		lastUserMsg: string;
	}
): Promise<PhaseResult> {
	const {
		workspaceRoot,
		hasWorkspace,
		filesModified,
		scaffoldedFiles,
		lastFailedEdits,
		backendFileCount,
		frontendFileCount,
		pkgContent: initialPkgContent,
		openFiles,
		readWriteMode,
		stackProfile,
		advisorSaysCreate,
		rawAdvisorIntent,
		activeFile,
		lastUserMsg,
	} = shared;

	const {
		specialist,
		modelIntent,
		buildPrompt,
		scaffold,
		artifactType,
		writeArtifact: shouldWriteArtifact,
		preContextBlocks = [],
		cleanupArtifact,
		phaseLabel,
		contextSize: requestedContextSize,
		genMaxTokens,
		maxIterations,
		isFullStackExecution,
		originalUserRequest,
		skipOnNoSignals,
		skipPhase,
	} = config;

	// pkgContent needs to be mutable for scaffold bootstrap
	let pkgContent = initialPkgContent;

	// ---- Skip this phase entirely (frontend-only must not run a BE pass) ----
	if (skipPhase) {
		return { filesModified, scaffoldedFiles, generatedCount: 0, contextDisposed: true, isFullStackExecution };
	}

	// ---- FE phase: early skip if no frontend signals (prompt-based) ----
	if (specialist === 'fe' && skipOnNoSignals && isFullStackExecution) {
		const runFE = shouldRunFrontend({
			intent: rawAdvisorIntent,
			prompt: lastUserMsg,
			beFilesWritten: filesModified,
		});
		if (!runFE) {
			console.log(`[Router] Cross-specialist skip: prompt has no FE signals → skipping ${phaseLabel} phase.`);
			return { filesModified, scaffoldedFiles, generatedCount: 0, contextDisposed: true, isFullStackExecution };
		}
		console.log(`[Router] Fullstack: ${phaseLabel} signals present → proceeding to ${phaseLabel} phase.`);
	}

	// ---- Acquire model ----
	const model = await mm.acquire(modelIntent);
	console.log(`[Router] ${phaseLabel} model acquired. Creating fresh context...`);

	// ---- Scaffold foundation files on create mode ----
	if (workspaceRoot && hasWorkspace && (readWriteMode === 'write' || advisorSaysCreate)) {
		const bootstrapped = scaffold(workspaceRoot, lastUserMsg, stackProfile);
		if (bootstrapped.length > 0) {
			for (const f of bootstrapped) if (!filesModified.includes(f)) filesModified.push(f);
			for (const f of bootstrapped) scaffoldedFiles.add(f);
			// Use dynamic import to avoid circular import issues
			const fs = await import('fs');
			const path = await import('path');
			try { pkgContent = fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf-8'); } catch { }
			console.log(`[Router] Initializer bootstrapped ${bootstrapped.length} ${phaseLabel.toLowerCase()} foundation files.`);
		}
	}

	// ---- Build system prompt ----
	const mode = determineMode(lastUserMsg, specialist, backendFileCount, frontendFileCount);
	console.log(`[Router] Phase Specialist=${specialist}, Mode=${mode}`);

	const systemPrompt = buildPrompt({
		userMsg: lastUserMsg,
		hasWorkspace,
		mode,
		specialist,
		activeFile,
		workspaceRoot,
		pkgContent,
		openFiles,
		readWriteMode,
		stackProfile,
	});

	// ---- Build user prompt for this phase ----
	let currentPrompt: string;
	if (specialist === 'be' && isFullStackExecution) {
		currentPrompt = [
			`You are the Backend Specialist. Generate ONLY backend files for this request.`,
			`Do NOT generate frontend, React, UI, or component files. Stop when backend is done.`,
			`\n--- Original Request ---\n${originalUserRequest}`,
		].join('\n\n');
	} else if (specialist === 'fe') {
		const contextBlocks = [
			...preContextBlocks,
			`You are the Frontend Specialist. Generate ONLY frontend files for this request.`,
			`Do NOT generate backend, Node.js, Express, or server files.`,
			`--- Original Request ---\n${originalUserRequest}`,
		].filter(Boolean);
		currentPrompt = contextBlocks.join('\n\n');
	} else {
		currentPrompt = originalUserRequest;
	}

	// ---- Create fresh context and session ----
	const context = await model.createContext({ contextSize: requestedContextSize });
	const session = new LlamaChatSession({
		contextSequence: context.getSequence(),
		systemPrompt,
	});

	const activeContextSize = (context as any)?.contextSize || requestedContextSize;

	// ---- Emit initial context usage ----
	try {
		const promptTokens = model ? model.tokenize(systemPrompt + '\n' + currentPrompt).length : 0;
		const initialTokens = Math.max(session?.sequence?.nextTokenIndex || 0, promptTokens);
		updateContextUsage(initialTokens, activeContextSize, specialist);
		streamEvent(res, {
			type: 'context_usage',
			used: initialTokens,
			total: activeContextSize,
			percent: Math.min(100, Math.round((initialTokens / activeContextSize) * 100)),
			model: specialist,
		});
		console.log(`[Router] Initial ${phaseLabel} context usage: ${initialTokens}/${activeContextSize} tokens (${Math.round((initialTokens / activeContextSize) * 100)}%)`);
	} catch (e) { }

	// ---- Agentic tool-calling loop ----
	let loopRecoveryCount = 0;
	let justCompacted = false;
	let compactionRetryDone = false;
	let jsxRepairDone = false; // allow one JSX repair pass

	for (let iteration = 0; iteration < maxIterations; iteration++) {
		if (controller.signal.aborted) {
			throw new Error(`${phaseLabel} phase aborted.`);
		}

		if (iteration === 0) {
			streamEvent(res, { type: 'progress', stage: 'generate', message: `Generating ${specialist === 'fe' ? 'frontend' : 'backend'} files...` });
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
				penalizeNewLine: false,
			},
			signal: iterController.signal,
			stopOnAbortSignal: true,
			onTextChunk(chunk) {
				fullResponse += chunk;
				chunkCount++;
				if (chunkCount % 12 === 0) {
					try {
						const liveTokens = session?.sequence?.nextTokenIndex || 0;
						if (liveTokens > 0) {
							updateContextUsage(liveTokens, activeContextSize, specialist);
							streamEvent(res, {
								type: 'context_usage',
								used: liveTokens,
								total: activeContextSize,
								percent: Math.min(100, Math.round((liveTokens / activeContextSize) * 100)),
								model: specialist,
							});
						}
						// Check 75% cutoff threshold
						const COMPACTION_THRESHOLD = Math.round(activeContextSize * 0.75);
						if (liveTokens >= COMPACTION_THRESHOLD && !compactionTriggered && iteration < maxIterations - 1) {
							compactionTriggered = true;
							console.log(`[Router] ${phaseLabel} 75% cutoff reached (${liveTokens}/${activeContextSize} tokens). Halting for auto-compaction.`);
							iterController.abort();
						}
					} catch { }
				}
			},
		});

		try {
			const finTokens = session?.sequence?.nextTokenIndex || 0;
			if (finTokens > 0) {
				updateContextUsage(finTokens, activeContextSize, specialist);
				streamEvent(res, {
					type: 'context_usage',
					used: finTokens,
					total: activeContextSize,
					percent: Math.min(100, Math.round((finTokens / activeContextSize) * 100)),
					model: specialist,
				});
			}
		} catch { }

		if (!workspaceRoot) break;

		// Extract edits from response
		const edits = extractFallbackEdits(fullResponse, openFiles, workspaceRoot, lastUserMsg, mode as AgentMode);
		if (edits.length > 0) {
			for (const edit of edits) {
				streamEvent(res, { type: 'progress', stage: 'write', message: `Writing \`${edit.path}\`...`, file: edit.path });
				const writeResult = executeToolCall(
					{ name: 'writeFile', arguments: { path: edit.path, content: edit.content } },
					workspaceRoot,
					openFiles,
					lastUserMsg,
					specialist,
					readWriteMode as 'write' | 'read' | undefined,
					rawAdvisorIntent.startsWith('create_') === true
				);
				if (writeResult.success) {
					if (!filesModified.includes(edit.path)) filesModified.push(edit.path);
					streamEvent(res, { type: 'success', stage: 'write', message: `Written \`${edit.path}\``, file: edit.path });
					if (writeResult.diffMsg) streamChunk(res, writeResult.diffMsg);
				}
			}
			// Successful write — continue to next iteration for potential more files
			continue;
		}

		// No edits extracted — check if model is done or needs repair
		const looksComplete = fullResponse.includes('DONE') || fullResponse.includes('complete') || fullResponse.length < 50;
		if (looksComplete) {
			console.log(`[Router] ${phaseLabel} phase: model appears complete.`);
			break;
		}

		// Prepare next iteration prompt with the response as context
		currentPrompt = `${originalUserRequest}\n\n--- Previous Response ---\n${fullResponse}\n\nContinue generating ${specialist === 'fe' ? 'frontend' : 'backend'} files.`;
	}

	// ---- Write artifact (BE phase only) ----
	if (shouldWriteArtifact && workspaceRoot && hasWorkspace && filesModified.length > 0) {
		const artifact = buildArtifactFromFiles(workspaceRoot, filesModified, artifactType);
		writeArtifact(workspaceRoot, artifact);
		patchCachesFromArtifact(workspaceRoot, artifact);
		console.log(`[ARTIFACT] ${phaseLabel} artifact ready: ${artifact.symbols.length} symbols, ${artifact.routes?.length ?? 0} routes.`);
	}

	// ---- Cleanup artifact (FE phase deletes BE artifact) ----
	if (cleanupArtifact && workspaceRoot) {
		deleteArtifact(workspaceRoot, 'be');
		console.log('[ARTIFACT] Cleanup complete');
	}

	const generatedCount = filesModified.filter(f => !scaffoldedFiles.has(f)).length;
	console.log(`[Router] ${phaseLabel} phase complete. Total files written: ${filesModified.length}.`);

	return {
		filesModified,
		scaffoldedFiles,
		generatedCount,
		contextDisposed: true,
		isFullStackExecution,
	};
}