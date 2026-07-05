/*
 * Tier-2 RAG Orchestrator
 *
 * Pipeline:
 *   Advisor Intent
 *   → Intent Filter (C7)
 *   → Workspace Analyzer (C1) + Package Analyzer (C2) [parallel, cached]
 *   → Symbol Search (C3) + AST Search (C5) [parallel, cached]
 *   → Import Graph Expansion (C4)
 *   → Ownership Filter (C6)
 *   → Embedding Search (fallback, last)
 *   → Context Assembly (C10)
 *   → formatted context string
 */

import path from 'path';
import fs from 'fs';

import { analyzeWorkspace }   from './workspaceAnalyzer.js';
import { analyzePackage }     from './packageAnalyzer.js';
import { buildSymbolIndex, searchSymbols, patchSymbolIndex } from './symbolIndex.js';
import { buildImportGraph, expandNeighbors, patchImportGraph } from './importGraph.js';
import { buildAstMap, extractEntities, searchAst, patchAstMap } from './astSearch.js';
import { buildOwnershipMap, filterByOwnership, patchOwnershipMap } from './fileOwnership.js';
import { applyIntentFilter }  from './intentFilter.js';
import { assembleContext, formatBlocks } from './contextAssembler.js';
import { retrieveEmbeddingChunks }       from '../rag.js';
import { loadArtifact, artifactBoostScores, cleanupArtifacts, patchCachesFromArtifact } from './artifact.js';

// ---------------------------------------------------------------------------
// Main entry point — replaces retrieveContext() from Tier-1
// ---------------------------------------------------------------------------

export async function tier2Retrieve(opts: {
	workspaceRoot: string;
	query: string;
	advisorIntent: string | null;
	openFile: string | undefined;
	routerIntent: 'frontend' | 'backend' | 'general';
}): Promise<string | null> {
	const { workspaceRoot, query, advisorIntent, openFile, routerIntent } = opts;

	if (!fs.existsSync(workspaceRoot)) return null;

	console.log(`[RAG] intent=${advisorIntent ?? routerIntent}`);

	// --- Parallel: load all caches (fast — already built on first load) ---
	const [symbols, graph, astMap, ownership] = await Promise.all([
		Promise.resolve(buildSymbolIndex(workspaceRoot)),
		Promise.resolve(buildImportGraph(workspaceRoot)),
		Promise.resolve(buildAstMap(workspaceRoot)),
		Promise.resolve(buildOwnershipMap(workspaceRoot)),
	]);

	// --- Entity extraction ---
	const entities = extractEntities(query);

	// --- Symbol search ---
	const symbolHits = searchSymbols(symbols, entities);

	// --- AST search ---
	const astHits = searchAst(astMap, entities);

	// --- Import graph expansion: take top AST hits, expand neighbors ---
	const astTopFiles = Object.entries(astHits)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([f]) => f);
	const graphNeighbors = expandNeighbors(graph, astTopFiles, 1);

	// --- Ownership filter: drop wrong-domain files ---
	const filteredSymbolHits = Object.fromEntries(
		Object.entries(symbolHits).filter(([f]) => {
			const o = ownership[f] ?? 'shared';
			if (routerIntent === 'frontend') return o !== 'be';
			if (routerIntent === 'backend')  return o !== 'fe';
			return true;
		})
	);

	const filteredAstHits = Object.fromEntries(
		Object.entries(astHits).filter(([f]) => {
			const o = ownership[f] ?? 'shared';
			if (routerIntent === 'frontend') return o !== 'be';
			if (routerIntent === 'backend')  return o !== 'fe';
			return true;
		})
	);

	const filteredNeighbors = filterByOwnership(graphNeighbors, ownership, routerIntent);

	// --- Intent filter: restrict dirs per advisor intent ---
	const filteredNeighborsByIntent = applyIntentFilter(filteredNeighbors, advisorIntent);

	// --- Artifact boost (C8): load BE artifact if exists, boost its files +100 ---
	// FE retrieval: BE-written files always outrank embeddings.
	// BE retrieval: no artifact yet — boost is a no-op.
	const artifact = (routerIntent === 'frontend' || routerIntent === 'general')
		? loadArtifact(workspaceRoot, 'be')
		: null;
	const artifactBoost = artifact ? artifactBoostScores(artifact) : {};
	if (artifact) {
		console.log(`[ARTIFACT] Boost applied: ${Object.keys(artifactBoost).length} BE files forced into context`);
	}

	// --- Embedding search (last fallback) ---
	// Slots budget accounts for artifact boost files (they always win a slot)
	const artifactCount = Object.keys(artifactBoost).length;
	const hasDetSig = Object.keys(filteredSymbolHits).length + Object.keys(filteredAstHits).length + artifactCount;
	const embeddingSlots = Math.max(0, 15 - hasDetSig - (openFile ? 1 : 0) - filteredNeighborsByIntent.length);
	let embeddingChunks: Array<{ filePath: string; text: string; score: number }> = [];

	if (embeddingSlots > 0) {
		embeddingChunks = await retrieveEmbeddingChunks(workspaceRoot, query, routerIntent, embeddingSlots);
		console.log(`[EMBED] ${embeddingChunks.length} chunks retrieved`);
	} else {
		console.log(`[EMBED] skipped — deterministic sources filled slots`);
	}

	// --- Context assembly ---
	// Merge artifact boost into symbolHits (score 100 overrides everything)
	const mergedSymbolHits = { ...filteredSymbolHits, ...artifactBoost };

	const blocks = assembleContext({
		workspaceRoot,
		openFile,
		symbolHits: mergedSymbolHits,
		astHits: filteredAstHits,
		graphNeighbors: filteredNeighborsByIntent,
		embeddingChunks,
	});

	if (blocks.length === 0) return null;
	return formatBlocks(blocks, workspaceRoot);
}

// Re-export cleanupArtifacts so index.ts only imports from rag/index.js
export { cleanupArtifacts, patchCachesFromArtifact };

// ---------------------------------------------------------------------------
// Incremental cache patcher — call on every file save event
// ---------------------------------------------------------------------------

export function patchTier2Caches(workspaceRoot: string, filePath: string): void {
	patchSymbolIndex(workspaceRoot, filePath);
	patchImportGraph(workspaceRoot, filePath);
	patchAstMap(workspaceRoot, filePath);
	patchOwnershipMap(workspaceRoot, filePath);
}

// ---------------------------------------------------------------------------
// Cross-specialist skip helper (C11)
// After BE phase, inspect touched files. If zero FE files → skip FE phase.
// ---------------------------------------------------------------------------

export function shouldSkipFEPhase(touchedFiles: string[]): boolean {
	const bePatterns = [
		/(?:^|\/)(?:controllers|routes|middleware|services|repositories|models|database|jobs|guards)\//i,
		/(?:^|\/)server\.[jt]s$/i,
		/schema\.prisma$/i,
	];
	const fePatterns = [
		/\.(tsx|jsx|css|scss)$/i,
		/(?:^|\/)(?:components|pages|hooks|styles|ui|views)\//i,
	];

	const hasBE = touchedFiles.some(f => bePatterns.some(p => p.test(f)));
	const hasFE = touchedFiles.some(f => fePatterns.some(p => p.test(f)));

	if (hasBE && !hasFE) {
		console.log('[RAG] Cross-specialist skip: BE-only files touched → skipping FE phase');
		return true;
	}
	return false;
}

export function shouldSkipBEPhase(touchedFiles: string[]): boolean {
	const fePatterns = [
		/\.(tsx|jsx|css|scss)$/i,
		/(?:^|\/)(?:components|pages|hooks|styles|ui|views)\//i,
	];
	const bePatterns = [
		/(?:^|\/)(?:controllers|routes|middleware|services|repositories|models|database|jobs)\//i,
	];

	const hasFE = touchedFiles.some(f => fePatterns.some(p => p.test(f)));
	const hasBE = touchedFiles.some(f => bePatterns.some(p => p.test(f)));

	if (hasFE && !hasBE) {
		console.log('[RAG] Cross-specialist skip: FE-only files touched → skipping BE phase');
		return true;
	}
	return false;
}
