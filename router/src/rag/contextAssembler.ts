/*
 * Component 10 — Context Assembler
 * Merges results from all retrieval stages.
 * Priority: open-file > symbol > ast > graph > embedding
 * Deduplicates by file path. Caps at MAX_BLOCKS.
 */

import fs from 'fs';
import path from 'path';

export type BlockSource = 'open-file' | 'symbol' | 'ast' | 'graph' | 'embedding';

export interface ContextBlock {
	path: string;
	score: number;
	source: BlockSource;
	content: string;
}

const MAX_BLOCKS = 15;
const MAX_CHARS_PER_BLOCK = 2000;

/** Read file content safely, truncated */
function readFile(filePath: string): string | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const stat = fs.statSync(filePath);
		if (stat.size > 200_000) return null;
		const content = fs.readFileSync(filePath, 'utf-8');
		return content.slice(0, MAX_CHARS_PER_BLOCK);
	} catch {
		return null;
	}
}

export interface AssemblerInput {
	workspaceRoot: string;
	openFile: string | undefined;
	symbolHits: Record<string, number>;  // filePath → score
	astHits: Record<string, number>;     // filePath → score
	graphNeighbors: string[];            // ordered by relevance
	embeddingChunks: Array<{ filePath: string; text: string; score: number }>;
}

export function assembleContext(input: AssemblerInput): ContextBlock[] {
	const { workspaceRoot, openFile, symbolHits, astHits, graphNeighbors, embeddingChunks } = input;
	const seen   = new Set<string>();
	const blocks: ContextBlock[] = [];

	const add = (filePath: string, source: BlockSource, score: number) => {
		if (seen.has(filePath) || blocks.length >= MAX_BLOCKS) return;
		if (!fs.existsSync(filePath)) return;
		const content = readFile(filePath);
		if (!content) return;
		seen.add(filePath);
		blocks.push({ path: filePath, score, source, content });
	};

	// Priority 1 — open file
	if (openFile) add(openFile, 'open-file', 100);

	// Priority 2 — symbol hits (sorted desc by score)
	for (const [fp, sc] of Object.entries(symbolHits).sort((a, b) => b[1] - a[1])) {
		add(fp, 'symbol', sc);
	}

	// Priority 3 — AST hits (sorted desc by score)
	for (const [fp, sc] of Object.entries(astHits).sort((a, b) => b[1] - a[1])) {
		add(fp, 'ast', sc);
	}

	// Priority 4 — import graph neighbors
	for (const fp of graphNeighbors) add(fp, 'graph', 1);

	// Priority 5 — embedding chunks (last fallback)
	for (const chunk of embeddingChunks) {
		if (seen.has(chunk.filePath) || blocks.length >= MAX_BLOCKS) continue;
		if (!fs.existsSync(chunk.filePath)) continue;
		seen.add(chunk.filePath);
		blocks.push({ path: chunk.filePath, score: chunk.score, source: 'embedding', content: chunk.text });
	}

	console.log(`[ASSEMBLER] ${blocks.length} blocks selected (${blocks.map(b => b.source).join(', ')})`);
	return blocks;
}

/** Format assembled blocks into a context string for the specialist prompt */
export function formatBlocks(blocks: ContextBlock[], workspaceRoot: string): string {
	return blocks
		.map(b => `--- ${b.source.toUpperCase()}: ${path.relative(workspaceRoot, b.path)} ---\n${b.content}`)
		.join('\n\n');
}
