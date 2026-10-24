/**
 * fileKnowledge.ts — what the router knows about the workspace, as facts.
 *
 * THE GAP THIS CLOSES
 *
 * Every measurement showed `[EMBED] 0 chunks retrieved` and
 * `[ASSEMBLER] 0 blocks selected`, because nothing told the router which
 * files existed before it routed. Retrieval was a fallback for a fact
 * nobody had collected. This collects it: one entry per source file with
 * hash, loc, role, symbols and imports, ready before the route is decided.
 *
 * INCREMENTAL BY (path, contentHash)
 *
 * The index is persisted per workspace and reused. A file whose size and
 * mtime are unchanged is not even read; a file that was touched but whose
 * content hash still matches keeps its facts. Only real edits are
 * re-parsed, so a second request on a 500-file workspace costs stats, not
 * 500 parses.
 *
 * WHERE IT LIVES
 *
 * `router/.rag-cache/<ws-hash>/file-knowledge.json` — the same cache the
 * rest of Tier-2 uses, not `.crabcode/` inside the user's repo. The router
 * must not litter the project it is editing.
 *
 * Retrieval here is lexical and deterministic (path > symbol > import), not
 * embedding-based: it needs no model, so the brief can be built before the
 * engine is loaded and the hit-rate is reproducible in tests.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { getAllCodeFiles } from '../rag.js';
import { classifyFile } from './fileOwnership.js';
import { getCachePath, readCache, writeCache } from './cache.js';
import type { FileFacts, FileKnowledge, RetrievedChunk } from '../brief/types.js';

const INDEX_VERSION = 1;
const MAX_RETRIEVED = 5;

interface IndexEntry {
	facts: FileFacts;
	size: number;
	mtimeMs: number;
}

interface IndexFile {
	version: number;
	files: Record<string, IndexEntry>;
}

export interface FileKnowledgeResult {
	knowledge: FileKnowledge;
	/** Files actually re-parsed on this call. Everything else was reused. */
	reindexed: string[];
	reused: number;
}

const SYMBOL_RE = /(?:^|\n)[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const IMPORT_RE = /(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"])/g;

function rel(root: string, abs: string): string {
	return path.relative(root, abs).replace(/\\/g, '/');
}

export function hashContent(text: string): string {
	return crypto.createHash('sha1').update(text, 'utf-8').digest('hex');
}

/** Declarations only — no call sites, so a name means "this file defines it". */
export function extractSymbols(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(SYMBOL_RE)) {
		const name = m[1];
		if (name && !out.includes(name)) out.push(name);
	}
	return out;
}

/** Module specifiers as written — relative paths stay relative on purpose. */
export function extractImports(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(IMPORT_RE)) {
		const spec = m[1] || m[2] || m[3];
		if (spec && !out.includes(spec)) out.push(spec);
	}
	return out;
}

/** First line that is actually code — a header comment is not a summary. */
export function summarise(text: string, limit = 120): string {
	const line = text
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'));
	return (line ?? '').slice(0, limit);
}

function factsFrom(root: string, key: string, abs: string, text: string, hash: string): FileFacts {
	return {
		path: key,
		hash,
		loc: text.split('\n').length,
		role: classifyFile(abs),
		symbols: extractSymbols(text),
		imports: extractImports(text),
		summary: summarise(text),
	};
}

/**
 * Lexical retrieval over the index. Deterministic: same query, same
 * chunks, no engine, no network — which is what makes the hit-rate
 * measurable and the test stable.
 */
export function retrieveFromIndex(files: FileFacts[], query: string, limit = MAX_RETRIEVED): RetrievedChunk[] {
	const tokens = query
		.toLowerCase()
		.split(/[^a-z0-9_$]+/)
		.filter((t) => t.length > 2);
	if (tokens.length === 0) return [];

	const scored = files
		.map((f) => {
			const pathLower = f.path.toLowerCase();
			const symbolsLower = f.symbols.map((s) => s.toLowerCase());
			const importsLower = f.imports.map((i) => i.toLowerCase());
			let score = 0;
			for (const t of tokens) {
				if (pathLower.includes(t)) score += 3;
				if (symbolsLower.some((s) => s.includes(t))) score += 2;
				if (importsLower.some((i) => i.includes(t))) score += 1;
			}
			return { f, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || a.f.path.localeCompare(b.f.path))
		.slice(0, limit);

	return scored.map(({ f, score }) => ({
		path: f.path,
		score,
		chunk: `${f.path}:${f.loc}L role=${f.role} symbols=[${f.symbols.slice(0, 6).join(',')}]`,
	}));
}

export function buildFileKnowledge(workspaceRoot: string, query = ''): FileKnowledgeResult {
	const empty = (): FileKnowledgeResult => ({
		knowledge: { indexedAt: new Date().toISOString(), fileCount: 0, edges: 0, files: [], retrieved: [] },
		reindexed: [],
		reused: 0,
	});
	if (!workspaceRoot || !fs.existsSync(workspaceRoot)) return empty();

	const cachePath = getCachePath(workspaceRoot, 'file-knowledge.json');
	const cached = readCache<IndexFile>(cachePath);
	const previous = cached && cached.version === INDEX_VERSION && cached.files ? cached.files : {};

	const files: FileFacts[] = [];
	const next: Record<string, IndexEntry> = {};
	const reindexed: string[] = [];
	let reused = 0;

	for (const abs of getAllCodeFiles(workspaceRoot)) {
		const key = rel(workspaceRoot, abs);
		let st: fs.Stats;
		try {
			st = fs.statSync(abs);
		} catch {
			continue;
		}

		const prev = previous[key];
		if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
			files.push(prev.facts);
			next[key] = prev;
			reused++;
			continue;
		}

		let text: string;
		try {
			text = fs.readFileSync(abs, 'utf-8');
		} catch {
			continue;
		}
		const hash = hashContent(text);

		// Touched but byte-identical (a save with no edit): keep the facts.
		if (prev && prev.facts.hash === hash) {
			const entry: IndexEntry = { facts: prev.facts, size: st.size, mtimeMs: st.mtimeMs };
			files.push(prev.facts);
			next[key] = entry;
			reused++;
			continue;
		}

		const facts = factsFrom(workspaceRoot, key, abs, text, hash);
		files.push(facts);
		next[key] = { facts, size: st.size, mtimeMs: st.mtimeMs };
		reindexed.push(key);
	}

	files.sort((a, b) => a.path.localeCompare(b.path));
	writeCache(cachePath, { version: INDEX_VERSION, files: next } as IndexFile);

	const edges = files.reduce((n, f) => n + f.imports.length, 0);
	return {
		knowledge: {
			indexedAt: new Date().toISOString(),
			fileCount: files.length,
			edges,
			files,
			retrieved: retrieveFromIndex(files, query),
		},
		reindexed,
		reused,
	};
}
