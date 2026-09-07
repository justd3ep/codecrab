/*---------------------------------------------------------------------------------------------
 *  CodeCrab RAG System — Level 1 (Naive RAG)
 *  CPU: nomic-embed-text (always resident in RAM)
 *  DB: LanceDB (local, embedded, no server)
 *--------------------------------------------------------------------------------------------*/

import path from 'path';
import fs from 'fs';
import { getLlama, Llama, LlamaModel, LlamaEmbeddingContext } from 'node-llama-cpp';
import * as lancedb from '@lancedb/lancedb';
import config from '@/config/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INDEXABLE_EXTS = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.py', '.css', '.html', '.vue',
	'.svelte', '.go', '.rs', '.json', '.md', '.yaml', '.yml', '.sql', '.sh', '.txt',
]);

const RAG_SKIP_DIRS = new Set([
	'node_modules', '.git', '.next', 'dist', 'build', '.build', 'out',
	'__pycache__', '.cache', '.svelte-kit', '.turbo', 'coverage', '.lancedb',
	'.rag-cache', '.codecrab', '.codecrab-shared', 'models',
]);

export const CHUNK_SIZE    = 1000;   // characters per chunk
export const CHUNK_OVERLAP = 200;    // overlap so we don't cut functions in half
export const RAG_TOP_K     = 5;      // chunks injected per query

// ---------------------------------------------------------------------------
// Specialist RAG filters
// ---------------------------------------------------------------------------

const FE_ALLOW_PATTERNS = [
	/\.tsx$/i, /\.jsx$/i, /\.css$/i, /\.scss$/i,
	/(?:^|[\/])App\.tsx$/i,
	/(?:^|[\/])components[\/]/i,
	/(?:^|[\/])styles[\/]/i,
	/(?:^|[\/])pages[\/]/i,
	/(?:^|[\/])hooks[\/]/i,
];

const FE_BLOCK_PATTERNS = [
	/(?:^|[\/])controllers[\/]/i,
	/(?:^|[\/])models[\/]/i,
	/(?:^|[\/])services[\/]/i,
	/(?:^|[\/])middleware[\/]/i,
	/(?:^|[\/])routes[\/]/i,
	/(?:^|[\/])database[\/]/i,
];

const BE_ALLOW_PATTERNS = [
	/(?:^|[\/])controllers[\/]/i,
	/(?:^|[\/])models[\/]/i,
	/(?:^|[\/])services[\/]/i,
	/(?:^|[\/])routes[\/]/i,
	/(?:^|[\/])middleware[\/]/i,
	/(?:^|[\/])database[\/]/i,
];

const BE_BLOCK_PATTERNS = [
	/\.tsx$/i, /\.jsx$/i,
	/(?:^|[\/])components[\/]/i,
	/(?:^|[\/])pages[\/]/i,
	/(?:^|[\/])styles[\/]/i,
];

function isChunkAllowed(filePath: string, intent: 'frontend' | 'backend' | 'general'): boolean {
	if (intent === 'general') return true;

	const allowPatterns = intent === 'frontend' ? FE_ALLOW_PATTERNS : BE_ALLOW_PATTERNS;
	const blockPatterns = intent === 'frontend' ? FE_BLOCK_PATTERNS : BE_BLOCK_PATTERNS;

	// Block takes priority
	if (blockPatterns.some(p => p.test(filePath))) return false;
	// Must match at least one allow pattern
	return allowPatterns.some(p => p.test(filePath));
}

// ---------------------------------------------------------------------------
// EmbeddingManager — CPU-only, lives in RAM permanently
// ---------------------------------------------------------------------------

class EmbeddingManager {
	private llama: Llama | null = null;
	private model: LlamaModel | null = null;
	private ctx: LlamaEmbeddingContext | null = null;
	private _ready = false;

	async init(): Promise<void> {
		try {
			if (!config.models.embedding) {
				console.warn('[EmbeddingManager] No embedding model configured — RAG disabled.');
				return;
			}
			const modelPath = config.models.embedding;
			console.log(`[EmbeddingManager] Loading on CPU: ${modelPath}`);

			this.llama = await getLlama();
			this.model = await this.llama.loadModel({ modelPath, gpuLayers: 0 }); // CPU only
			this.ctx   = await this.model.createEmbeddingContext();
			this._ready = true;
			console.log('[EmbeddingManager] Ready — RAG enabled.');
		} catch (e) {
			console.error('[EmbeddingManager] Load failed:', e);
		}
	}

	async embed(text: string): Promise<number[] | null> {
		if (!this.ctx) return null;
		try {
			const result = await this.ctx.getEmbeddingFor(text);
			return Array.from(result.vector);
		} catch (e) {
			console.error('[EmbeddingManager] embed() failed:', e);
			return null;
		}
	}

	get isReady() { return this._ready; }
}

export const em = new EmbeddingManager();

// ---------------------------------------------------------------------------
// LanceDB helpers
// ---------------------------------------------------------------------------

let _db: lancedb.Connection | null = null;

async function getDb(): Promise<lancedb.Connection> {
	if (!_db) _db = await lancedb.connect(config.cacheDirectory);
	return _db;
}

/** Stable table name derived from workspace path */
export function tableNameFor(workspaceRoot: string): string {
	return 'ws_' + Buffer.from(workspaceRoot).toString('base64url').replace(/\W/g, '_').slice(0, 48);
}

// ---------------------------------------------------------------------------
// File utilities
// ---------------------------------------------------------------------------

export function getAllCodeFiles(dir: string, results: string[] = []): string[] {
	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!RAG_SKIP_DIRS.has(entry.name)) getAllCodeFiles(full, results);
			} else if (INDEXABLE_EXTS.has(path.extname(entry.name).toLowerCase())) {
				results.push(full);
			}
		}
	} catch {}
	return results;
}

export interface Chunk {
	id: string;
	filePath: string;
	text: string;
}

export function chunkText(text: string, filePath: string): Chunk[] {
	const chunks: Chunk[] = [];
	let start = 0, idx = 0;
	while (start < text.length) {
		const slice = text.slice(start, start + CHUNK_SIZE).trim();
		if (slice.length > 50) chunks.push({ id: `${filePath}::${idx++}`, filePath, text: slice });
		start += CHUNK_SIZE - CHUNK_OVERLAP;
	}
	return chunks;
}

// ---------------------------------------------------------------------------
// Indexer — build or rebuild the vector table for a workspace
// ---------------------------------------------------------------------------

export async function indexWorkspace(workspaceRoot: string): Promise<{ chunks: number; files: number }> {
	if (!em.isReady) throw new Error('Embedding model not loaded.');

	const files = getAllCodeFiles(workspaceRoot);
	console.log(`[RAG] Indexing ${files.length} files in: ${workspaceRoot}`);

	const records: Array<{ id: string; filePath: string; text: string; vector: number[] }> = [];

	for (const filePath of files) {
		try {
			const stat = fs.statSync(filePath);
			if (stat.size > 200_000) continue; // skip huge files
			const content = fs.readFileSync(filePath, 'utf-8');
			const chunks = chunkText(content, filePath);
			for (const chunk of chunks) {
				const vector = await em.embed(chunk.text);
				if (vector) records.push({ ...chunk, vector });
			}
		} catch {}
	}

	if (records.length === 0) {
		console.log('[RAG] Nothing to index.');
		return { chunks: 0, files: files.length };
	}

	const db   = await getDb();
	const name = tableNameFor(workspaceRoot);
	await db.createTable(name, records, { mode: 'overwrite' });
	console.log(`[RAG] Indexed ${records.length} chunks → table "${name}".`);
	return { chunks: records.length, files: files.length };
}

// ---------------------------------------------------------------------------
// Incremental update — re-index a single file after save
// ---------------------------------------------------------------------------

export async function updateFile(workspaceRoot: string, filePath: string, content: string): Promise<void> {
	if (!em.isReady) return;
	try {
		const db   = await getDb();
		const name = tableNameFor(workspaceRoot);
		const names = await db.tableNames();
		if (!names.includes(name)) return; // index doesn't exist yet, skip

		const tbl = await db.openTable(name);

		// Delete old chunks for this file
		await tbl.delete(`filePath = '${filePath.replace(/'/g, "\\'")}'`);

		// Insert new chunks
		const chunks = chunkText(content, filePath);
		const records: Array<{ id: string; filePath: string; text: string; vector: number[] }> = [];
		for (const chunk of chunks) {
			const vector = await em.embed(chunk.text);
			if (vector) records.push({ ...chunk, vector });
		}
		if (records.length > 0) await tbl.add(records);
		console.log(`[RAG] Updated ${records.length} chunks for: ${path.relative(workspaceRoot, filePath)}`);
	} catch (e) {
		console.error('[RAG] updateFile failed:', e);
	}
}

// ---------------------------------------------------------------------------
// Retriever — search LanceDB and return formatted context string
// ---------------------------------------------------------------------------

export async function retrieveContext(
	workspaceRoot: string,
	query: string,
	intent: 'frontend' | 'backend' | 'general' = 'general'
): Promise<string | null> {
	if (!em.isReady) return null;
	try {
		const db    = await getDb();
		const name  = tableNameFor(workspaceRoot);
		const names = await db.tableNames();
		if (!names.includes(name)) {
			console.log('[RAG] No index yet. Trigger POST /v1/index first.');
			return null;
		}

		const queryVec = await em.embed(query);
		if (!queryVec) return null;

		const tbl     = await db.openTable(name);
		// Fetch more than RAG_TOP_K so filtering doesn't starve results
		const rawResults = await tbl.search(queryVec).limit(RAG_TOP_K * 4).toArray();

		// Retrieval safety layer — ghost vectors from deleted files never enter prompts
		const liveResults = rawResults.filter((r: any) => fs.existsSync(r.filePath));
		if (liveResults.length < rawResults.length) {
			console.warn(`[RAG] Safety filter removed ${rawResults.length - liveResults.length} chunk(s) from deleted files.`);
		}

		// Specialist-aware filtering
		const results = liveResults.filter((r: any) => isChunkAllowed(r.filePath, intent)).slice(0, RAG_TOP_K);

		console.log(`[RAG] intent=${intent} — raw=${rawResults.length}, after filter=${results.length}`);

		if (results.length === 0) return null;

		console.log("\n=== RAG RETRIEVAL ===");

		for (const chunk of results) {
			console.log({
				file: chunk.filePath,
				score: chunk._distance,
				chars: chunk.text.length,
				preview: chunk.text.slice(0, 200)
			});
		}

		let ragChars = 0;
		for (const chunk of results) ragChars += chunk.text.length;
		console.log("RAG Context:", ragChars, "chars");

		const formatted = results
			.map((r: any) => `--- RAG: ${path.relative(workspaceRoot, r.filePath)} ---\n${r.text}`)
			.join('\n\n');

		console.log(`[RAG] Retrieved ${results.length} chunks for query.`);
		return formatted;
	} catch (e) {
		console.error('[RAG] retrieveContext failed:', e);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Tier-2 raw chunk retrieval — used by rag/index.ts as the final fallback stage
// Returns raw chunk objects instead of formatted string so the assembler can merge them.
// ---------------------------------------------------------------------------

export async function retrieveEmbeddingChunks(
	workspaceRoot: string,
	query: string,
	intent: 'frontend' | 'backend' | 'general',
	limit: number,
): Promise<Array<{ filePath: string; text: string; score: number }>> {
	if (!em.isReady) return [];
	try {
		const db    = await getDb();
		const name  = tableNameFor(workspaceRoot);
		const names = await db.tableNames();
		if (!names.includes(name)) return [];

		const queryVec = await em.embed(query);
		if (!queryVec) return [];

		const tbl        = await db.openTable(name);
		const rawResults = await tbl.search(queryVec).limit(limit * 4).toArray();
		const live       = rawResults.filter((r: any) => fs.existsSync(r.filePath));
		const filtered   = live.filter((r: any) => isChunkAllowed(r.filePath, intent)).slice(0, limit);

		return filtered.map((r: any) => ({
			filePath: r.filePath as string,
			text: r.text as string,
			score: 1 - (r._distance ?? 0), // convert distance to similarity score
		}));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Batch delete — remove all chunks for a set of deleted files
// ---------------------------------------------------------------------------

export async function deleteFiles(workspaceRoot: string, filePaths: string[]): Promise<void> {
	if (filePaths.length === 0) return;
	try {
		const db   = await getDb();
		const name = tableNameFor(workspaceRoot);
		const names = await db.tableNames();
		if (!names.includes(name)) return;

		const tbl = await db.openTable(name);
		// Build a SQL IN-list predicate
		const escaped = filePaths.map(p => `'${p.replace(/'/g, "\\'")}'`).join(', ');
		await tbl.delete(`filePath IN (${escaped})`);
		console.log(`[RAG] Deleted chunks for ${filePaths.length} file(s): ${filePaths.map(p => path.basename(p)).join(', ')}`);
	} catch (e) {
		console.error('[RAG] deleteFiles failed:', e);
	}
}

// ---------------------------------------------------------------------------
// Startup sync — purge any vectors whose source files no longer exist on disk
// ---------------------------------------------------------------------------

export async function syncWorkspace(workspaceRoot: string): Promise<{ purged: number }> {
	try {
		const db   = await getDb();
		const name = tableNameFor(workspaceRoot);
		const names = await db.tableNames();
		if (!names.includes(name)) return { purged: 0 };

		const tbl = await db.openTable(name);

		// Fetch all unique filePaths stored in the table
		const rows = await tbl.query().select(['filePath']).toArray();
		const uniquePaths = [...new Set(rows.map((r: any) => r.filePath as string))];

		// Filter to paths that no longer exist
		const missing = uniquePaths.filter(p => !fs.existsSync(p));

		if (missing.length === 0) {
			console.log('[RAG] Sync complete — index is clean.');
			return { purged: 0 };
		}

		const escaped = missing.map(p => `'${p.replace(/'/g, "\\'")}'`).join(', ');
		await tbl.delete(`filePath IN (${escaped})`);
		console.log(`[RAG] Sync purged ${missing.length} stale file(s): ${missing.map(p => path.basename(p)).join(', ')}`);
		return { purged: missing.length };
	} catch (e) {
		console.error('[RAG] syncWorkspace failed:', e);
		return { purged: 0 };
	}
}
