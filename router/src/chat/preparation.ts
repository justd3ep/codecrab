/**
 * preparation.ts — request preparation phase.
 *
 * Extracted from index.ts (lines 456–679). The try-block body up to
 * the VNext incremental pipeline decision: request parsing, workspace
 * inspection, stack profile, intent classification, advisor, ensemble,
 * planner contract, scaffolding.
 *
 * WHY A SEPARATE MODULE
 *
 * The preparation phase is 224 lines and 40+ declarations. It crosses
 * the boundary into the generation loops: most of those declarations
 * are used after L679. A separate module makes the boundary explicit
 * — the caller gets a struct, not a closure over 40 variables.
 *
 * NOTE: The VNext/incremental block (L680+) stays inline in
 * index.ts because it contains early returns that reference the
 * caller's `context` and `life` variables directly.
 */
import path from 'path';
import fs from 'fs';
import type { Request, Response } from 'express';

import { mm } from '../models/legacyModelManager.js';
import { tier2Retrieve, cleanupArtifacts } from '../rag/index.js';
import { deleteArtifact } from '../rag/artifact.js';
import { updateContextUsage, setEffectiveContextSize } from '../telemetry/contextUsage.js';
import { ensureFrontendScaffold, ensureBackendScaffold } from '../frontendScaffold.js';
import { detectStackProfile } from '../routing/stackProfile.js';
import { ensembleRoute, promptNeedsFrontend } from '../routing/ensembleRouter.js';
import { buildBESystemPrompt, buildSystemPrompt, workspaceHasTsx } from '../prompts/promptBuilder.js';
import { buildPlannerContract, plannerContractToValidationContract } from '../parsing/plannerContract.js';
import { parseUserScope } from '../parsing/constraintParser.js';
import { inspectWorkspace } from '../workspaceInspector.js';
import { buildDirectoryTree, readFileSafe, extractReferencedFiles, executeToolCall, parseToolCall } from '../tools/toolEngine.js';
import { buildExecutionGraph } from '../planner.js';
import type { AdvisorV2Result } from '../planner.js';
import { buildCapabilitySystemPrompt } from '../capabilityResolver.js';
import { determineMode } from '../routing/agentMode.js';
import { classifyIntent, detectBackendIntent, detectFrontendIntent, runAdvisor, scoreKeywords } from '../routing/intentClassifier.js';
import { extractBackendSummary, extractFallbackEdits, streamChunk, streamEvent } from '../generation/pipelineHelpers.js';
import { MAX_AGENT_ITERATIONS, REPEAT_PENALTY, REPEAT_PENALTY_TOKENS } from '../generation/limits.js';
import config from '@/config/index.js';
import { randomUUID } from 'crypto';
import { buildBrief } from '../brief/buildBrief.js';
import { writeBrief } from '../brief/serialize.js';
import { decodeAdvisorIntent } from '../brief/decode.js';
import { buildFileKnowledge } from '../rag/fileKnowledge.js';
import type { TurnBrief } from '../brief/types.js';

// ── Return type ──────────────────────────────────────────────────────

export interface PreparationResult {
	/** True if the preparation handled the response (e.g. clarification request). */
	done?: boolean;

	workspaceRoot: string;
	hasWorkspace: boolean;
	requestedContextSize: number;
	backendFileCount: number;
	frontendFileCount: number;
	pkgContent: string;
	lastUserMsg: string;
	stackProfile: any;
	plainStack: boolean;
	genMaxTokens: number;
	AGENT_ITERATIONS: number;
	readWriteMode: 'read' | 'write';
	intent: 'frontend' | 'backend' | 'general';
	userScope: string;
	advisorSaysCreate: boolean;
	rawAdvisorIntent: string;
	plannerContract: any;
	validationContract: any;
	filesModified: string[];
	scaffoldedFiles: Set<string>;
	lastFailedEdits: any[];
	beBootstrapped: string[];
	needsFrontend: boolean;
	openFiles?: string[] | undefined;
	enrichedLastMessage: string;
	features: any;
	architecture: any;
	plannedModules: any[];
	inspection: any;
	v2ForGraph: AdvisorV2Result;
	advisorV2Result: AdvisorV2Result | null;
	/**
	 * The reconciled turn brief. Phase 2 records it; no consumer reads it
	 * yet, so routing behaviour is unchanged. Serialized per request to
	 * `<workspace>/.crabcode/briefs/<id>.json` for replay, diffing, and SFT.
	 */
	brief: TurnBrief | null;
}

// ── The preparation function ─────────────────────────────────────────

export async function prepareRequest(
	req: { body: { workspaceRoot?: string; messages?: any[]; stream?: boolean; openFiles?: string[]; contextSize?: number } },
	res: Response,
): Promise<PreparationResult> {
	const workspaceRoot = req.body.workspaceRoot || config.workspace.defaultRoot;
	const { messages, stream, openFiles, contextSize: rawContextSize } = req.body;
	const hasWorkspace = Boolean(workspaceRoot && fs.existsSync(workspaceRoot));

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

			const treeLines = tree.split('\n');
			for (const line of treeLines) {
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

	// ── Stack profile (computed once per request) ─────────────────────
	const stackProfile = detectStackProfile(lastUserMsg, {
		workspaceHasReact: hasWorkspace && workspaceHasTsx(workspaceRoot as string | undefined),
		packageJson: pkgContent,
	});
	const plainStack = stackProfile.kind === 'vanilla' || stackProfile.kind === 'single-file';

	// ── Generation budget sized to the deliverable ─────────────────────
	const genMaxTokens = Math.min(
		stackProfile.recommendedMaxTokens,
		Math.max(2048, requestedContextSize - 4096),
		4096,
	);

	const AGENT_ITERATIONS = stackProfile.kind === 'single-file' ? 10 : MAX_AGENT_ITERATIONS;

	// ── RAG ────────────────────────────────────────────────────────────
	const referencedFiles = extractReferencedFiles(lastUserMsg, workspaceRoot);
	const alreadySeen = new Set(openFiles || []);
	for (const rf of referencedFiles) {
		if (alreadySeen.has(rf)) continue;
		alreadySeen.add(rf);
		const content = readFileSafe(rf);
		if (content) {
			const relPath = path.relative(workspaceRoot, rf);
			contextBlocks.push(`--- Referenced File: ${relPath} ---\n${content}`);
		}
	}

	const ragSpecialist: 'frontend' | 'backend' | 'general' =
		detectFrontendIntent(messages || []) && !detectBackendIntent(messages || []) ? 'frontend'
		: detectBackendIntent(messages || []) && !detectFrontendIntent(messages || []) ? 'backend'
		: 'general';

	const openFileForRAG = openFiles && openFiles.length > 0 ? openFiles[0] : undefined;
	const ragContext = await tier2Retrieve({
		workspaceRoot,
		query: lastUserMsg,
		advisorIntent: null,
		openFile: openFileForRAG,
		routerIntent: ragSpecialist,
	});
	if (ragContext) {
		contextBlocks.push(`--- RAG Context (Tier-2) ---\n${ragContext}`);
	}

	let enrichedLastMessage = lastUserMsg;
	// if context blocks present, prepend them to the last message
	if (contextBlocks.length > 0) {
		const ctxHeader = contextBlocks.join('\n\n');
		enrichedLastMessage = `${ctxHeader}\n\n--- User Request ---\n${lastUserMsg}`;
	}

	// ── READ / WRITE mode classification
	const readWriteMode = classifyIntent(lastUserMsg || '');
	console.log(`[Router] READ/WRITE mode: ${readWriteMode}`);

	// ── MODEL SETUP
	let intent: 'frontend' | 'backend' | 'general';

	const userScope = parseUserScope(lastUserMsg);

	// --- ADVISOR PASS + ENSEMBLE SCORING ---
	console.log('[Router] Running Advisor V2 pass...');
	const advisorStart = Date.now();
	const advisorResult = await runAdvisor(lastUserMsg, true);
	const advisorMs = Date.now() - advisorStart;
	const advisorIntent: any = advisorResult.intent;
	const advisorV2Result: AdvisorV2Result | null = advisorResult.v2Result;

	const { intent: ensembledIntent, isCreate: advisorSaysCreate } = ensembleRoute(
		advisorIntent,
		openFiles,
		messages || [],
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
		return { done: true } as PreparationResult;
	}

	// --- SCOPE MASKING (constraint parser overrides ensemble) ---
	if (userScope === 'BACKEND_ONLY') {
		intent = 'backend';
		console.log('[Router] Scope mask: BACKEND_ONLY → intent=backend (FE phase disabled)');
	} else if (userScope === 'FRONTEND_ONLY') {
		intent = 'frontend';
		console.log('[Router] Scope mask: FRONTEND_ONLY → intent=frontend (BE phase disabled)');
	} else {
		intent = ensembledIntent as 'frontend' | 'backend' | 'general';
	}

	// --- DECODE CONTRACT (R3) ---
	// Only a schema-valid decode may act. The advisor's vocabulary
	// (`create_fullstack`) and the schema's (`fullstack`) are reconciled in
	// one place; the literal "unknown" that used to survive the `??`
	// null-check now fails explicitly, and the ensemble's verdict takes
	// over instead of the contract's ternary defaulting to fullstack.
	const decode = decodeAdvisorIntent(advisorIntent);
	const rawAdvisorIntent: string = decode.ok ? String(advisorIntent) : ensembledIntent;

	// --- FILE KNOWLEDGE (Phase 4) ---
	// Built before the route so the brief carries facts, not zeros. The index
	// is keyed by (path, contentHash): a repeat request re-parses only what
	// actually changed, and an unchanged file is not even read.
	const fileKnowledge = buildFileKnowledge(hasWorkspace ? workspaceRoot : '', lastUserMsg);
	if (hasWorkspace) {
		console.log(
			`[INDEX] ${fileKnowledge.knowledge.fileCount} files (${fileKnowledge.reindexed.length} re-indexed, ${fileKnowledge.reused} cached) edges=${fileKnowledge.knowledge.edges} retrieved=${fileKnowledge.knowledge.retrieved.length}`,
		);
	}

	const briefScores = scoreKeywords(lastUserMsg);
	const briefNow = new Date().toISOString();
	const briefBase = {
		requestId: randomUUID(),
		lastUserMsg,
		// 'unknown' already returned above, so this is narrowed to the three
		// routable verdicts.
		ensembleIntent: ensembledIntent as 'frontend' | 'backend' | 'general',
		rawAdvisorIntent: advisorIntent,
		scores: { fe: Number(briefScores.feScore) || 0, be: Number(briefScores.beScore) || 0 },
		decode: {
			ms: advisorMs,
			// The advisor does not report token usage; 0 is honest here.
			promptTokens: 0,
			raw: JSON.stringify(advisorV2Result ?? advisorIntent ?? null),
			ok: decode.ok,
		},
		stack: {
			framework: stackProfile?.framework,
			language: stackProfile?.language,
			singleFile: stackProfile?.singleFile,
		},
		userScope,
		modules: Array.isArray(advisorV2Result?.modules) ? advisorV2Result!.modules! : [],
		fileKnowledge: fileKnowledge.knowledge,
		targets: [],
		now: briefNow,
	};

	// --- TURN BRIEF (Phase 3: it owns the routing decision) ---
	// Pass 1 resolves intent and scope. The planner contract is then a
	// projection of that result — it is never consulted while producing it,
	// so the two can no longer disagree (the measured bug: ensemble FE=8/BE=0,
	// contract fullstack).
	const draftBrief = buildBrief({ ...briefBase, features: [] });

	// --- PLANNER CONTRACT (deterministic, no model call) ---
	const plannerContract = buildPlannerContract(lastUserMsg, {
		scope: draftBrief.scope,
		framework: draftBrief.stack.framework,
	});
	const validationContract = plannerContractToValidationContract(plannerContract, userScope, stackProfile);

	// Pass 2 records the contract's feature list. `features` does not feed
	// the scope, so the route cannot change between the two builds — the
	// brief and the contract are guaranteed to agree by construction.
	const brief: TurnBrief = buildBrief({ ...briefBase, features: plannerContract.requiredFeatures });
	console.log(
		`[Brief] intent=${brief.intent} scope=${brief.scope} specialist=${brief.route.specialist} decode=${brief.decode.ok ? 'ok' : 'FAILED'} scores=fe${brief.route.scores.fe}/be${brief.route.scores.be} reason=${brief.route.reason}`,
	);
	console.log(`[PlannerContract] projected scope=${plannerContract.scope} fw=${plannerContract.framework} est=${plannerContract.estimatedFiles}`);
	if (hasWorkspace) {
		const briefFile = writeBrief(brief, workspaceRoot);
		if (briefFile) console.log(`[Brief] written: ${briefFile}`);
	}

	// --- V2 GRAPH CONSTRUCTION (deferred to index.ts for VNext path)
	// The VNext block will construct v2ForGraph, inspection, plannedModules
	// from advisorV2Result and plannerContract.
	// Here we just prepare the values needed.

	const filesModified: string[] = [];
	const scaffoldedFiles = new Set<string>();
	const lastFailedEdits: any[] = [];
	const beBootstrapped: string[] = [];

	// Return the prepared state — the VNext/incremental block in index.ts
	// will decide whether to use the incremental engine or the monolithic loop.
	return {
		workspaceRoot, hasWorkspace, requestedContextSize,
		backendFileCount, frontendFileCount, pkgContent,
		lastUserMsg, stackProfile, plainStack,
		genMaxTokens, AGENT_ITERATIONS, readWriteMode,
		intent, userScope, advisorSaysCreate, rawAdvisorIntent,
		plannerContract, validationContract,
		filesModified, scaffoldedFiles, lastFailedEdits,
		beBootstrapped, needsFrontend: false, openFiles,
		enrichedLastMessage, features: null, architecture: null,
		plannedModules: [], inspection: { analyzed: [], missing: [], existing: [] },
		v2ForGraph: {} as AdvisorV2Result, advisorV2Result,
		brief,
	};
}