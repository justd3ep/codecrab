/*
 * Execution Artifact — request-local specialist handoff
 *
 * Flow:
 *   BE finishes → writeArtifact() → patchCachesFromArtifact()
 *   FE starts   → loadArtifact() → boost files in tier2Retrieve()
 *   Request end → deleteArtifact()
 *
 * Permanent caches (symbols, ownership, imports) survive the request.
 * artifact.json is ephemeral — per-request only.
 *
 * Future: db.artifact, flutter.artifact, devops.artifact all use same interface.
 */

import fs   from 'fs';
import path from 'path';
import { getCachePath, readCache, writeCache } from './cache.js';
import { classifyFile } from './fileOwnership.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpecialistRole = 'be' | 'fe' | 'db' | 'flutter' | 'devops';

export interface ExecutionArtifact {
	/** Which specialist produced this artifact */
	specialist: SpecialistRole;
	/** Absolute paths of files written during this phase */
	files: string[];
	/** Exported symbol names found/written */
	symbols: string[];
	/** API route strings (BE only) */
	routes?: string[];
	/** Model/entity names (BE/DB) */
	models?: string[];
	/** Controller names */
	controllers?: string[];
	/** Component names (FE) */
	components?: string[];
	/** Page names (FE) */
	pages?: string[];
	/** Timestamp — used for staleness detection */
	ts: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function sessionDir(workspaceRoot: string): string {
	const dir = getCachePath(workspaceRoot, 'session');
	// getCachePath already creates parent dir; create session/ explicitly
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function artifactPath(workspaceRoot: string, role: SpecialistRole = 'be'): string {
	return path.join(sessionDir(workspaceRoot), `${role}.artifact.json`);
}

// ---------------------------------------------------------------------------
// Save / Load / Delete
// ---------------------------------------------------------------------------

/** Write artifact after specialist phase completes */
export function writeArtifact(workspaceRoot: string, artifact: ExecutionArtifact): void {
	const p = artifactPath(workspaceRoot, artifact.specialist);
	try {
		fs.writeFileSync(p, JSON.stringify(artifact, null, 2), 'utf-8');
		console.log(`[ARTIFACT] Written: ${path.basename(p)} (${artifact.files.length} files, ${artifact.symbols.length} symbols)`);
	} catch (e) {
		console.error('[ARTIFACT] Write failed:', e);
	}
}

/** Load artifact from a previous specialist phase. Returns null if missing or stale (>1h). */
export function loadArtifact(workspaceRoot: string, role: SpecialistRole = 'be'): ExecutionArtifact | null {
	const p = artifactPath(workspaceRoot, role);
	if (!fs.existsSync(p)) return null;
	try {
		const a = JSON.parse(fs.readFileSync(p, 'utf-8')) as ExecutionArtifact;
		// Stale guard: artifact older than 1 hour is discarded
		if (Date.now() - a.ts > 3_600_000) {
			console.warn('[ARTIFACT] Stale artifact discarded:', path.basename(p));
			fs.unlinkSync(p);
			return null;
		}
		console.log(`[ARTIFACT] Loaded: ${path.basename(p)} (${a.files.length} files)`);
		return a;
	} catch {
		return null;
	}
}

/** Delete a specific role artifact — call on request end or skip */
export function deleteArtifact(workspaceRoot: string, role: SpecialistRole = 'be'): void {
	const p = artifactPath(workspaceRoot, role);
	try {
		if (fs.existsSync(p)) {
			fs.unlinkSync(p);
			console.log(`[ARTIFACT] Deleted: ${path.basename(p)}`);
		}
	} catch {}
}

/** Delete ALL session artifacts for this workspace (call at request end) */
export function cleanupArtifacts(workspaceRoot: string): void {
	const dir = path.join(getCachePath(workspaceRoot, 'session'), '');
	const sessionDirPath = path.dirname(dir);
	try {
		const files = fs.readdirSync(sessionDirPath).filter(f => f.endsWith('.artifact.json'));
		for (const f of files) {
			fs.unlinkSync(path.join(sessionDirPath, f));
		}
		if (files.length > 0) console.log(`[ARTIFACT] Cleaned up ${files.length} artifact(s).`);
	} catch {}
}

// ---------------------------------------------------------------------------
// Artifact → Tier-2 cache patching (incremental only)
// ---------------------------------------------------------------------------

/**
 * After BE phase writes an artifact:
 * - Patches symbol cache with new exported symbols
 * - Patches ownership cache with new files
 * - Patches import graph with inferred file relationships
 *
 * Never rebuilds entire workspace. Pure incremental.
 */
export function patchCachesFromArtifact(workspaceRoot: string, artifact: ExecutionArtifact): void {
	_patchSymbols(workspaceRoot, artifact);
	_patchOwnership(workspaceRoot, artifact);
	_patchImportGraph(workspaceRoot, artifact);
}

// --- Symbol patch ---
function _patchSymbols(workspaceRoot: string, artifact: ExecutionArtifact): void {
	const cachePath = getCachePath(workspaceRoot, 'symbols.json');
	const existing: Record<string, string> = readCache<Record<string, string>>(cachePath) ?? {};

	const definingFiles = artifact.files.filter(f =>
		/(?:controller|service|middleware)/i.test(f)
	);
	const fallback = artifact.files[0];

	let patched = 0;
	for (const sym of artifact.symbols) {
		if (existing[sym]) continue;
		const def = definingFiles.find(f => f.toLowerCase().includes(sym.toLowerCase().slice(0, 6))) ?? fallback;
		if (def) { existing[sym] = def; patched++; }
	}

	writeCache(cachePath, existing);
	console.log(`[ARTIFACT] Symbol cache: +${patched} symbols patched`);
}

// --- Ownership patch ---
function _patchOwnership(workspaceRoot: string, artifact: ExecutionArtifact): void {
	const cachePath = getCachePath(workspaceRoot, 'ownership.json');
	const existing: Record<string, string> = readCache<Record<string, string>>(cachePath) ?? {};

	let patched = 0;
	for (const f of artifact.files) {
		if (existing[f]) continue;
		existing[f] = classifyFile(f);
		patched++;
	}

	writeCache(cachePath, existing);
	console.log(`[ARTIFACT] Ownership cache: +${patched} entries patched`);
}

// --- Import graph patch ---
function _patchImportGraph(workspaceRoot: string, artifact: ExecutionArtifact): void {
	const cachePath = getCachePath(workspaceRoot, 'imports.json');
	const existing: Record<string, string[]> = readCache<Record<string, string[]>>(cachePath) ?? {};

	if (artifact.routes && artifact.controllers) {
		const routeFiles      = artifact.files.filter(f => /route/i.test(f));
		const controllerFiles = artifact.files.filter(f => /controller/i.test(f));
		for (const rf of routeFiles) {
			if (!existing[rf]) {
				existing[rf] = controllerFiles;
				console.log(`[ARTIFACT] Import graph: ${path.basename(rf)} → [${controllerFiles.map(c => path.basename(c)).join(', ')}]`);
			}
		}
	}

	writeCache(cachePath, existing);
}

// ---------------------------------------------------------------------------
// Artifact boost helper — used inside tier2Retrieve
// ---------------------------------------------------------------------------

/**
 * Returns a score map { filePath: 100 } for all files in the artifact.
 * These scores are merged into symbol/AST hits before assembly.
 * Artifact files always outrank embedding chunks.
 */
export function artifactBoostScores(artifact: ExecutionArtifact): Record<string, number> {
	const scores: Record<string, number> = {};
	for (const f of artifact.files) scores[f] = 100;
	return scores;
}

// ---------------------------------------------------------------------------
// Build artifact from BE written files (called by router after BE phase)
// ---------------------------------------------------------------------------

/**
 * Constructs an ExecutionArtifact from the list of files BE just wrote.
 * Extracts symbols, routes, models, controllers by path pattern heuristics.
 * No LLM required.
 */
export function buildArtifactFromFiles(
	workspaceRoot: string,
	files: string[],
	specialist: SpecialistRole = 'be',
): ExecutionArtifact {
	const abs = files.map(f => path.isAbsolute(f) ? f : path.join(workspaceRoot, f));

	const routes: string[]      = [];
	const models: string[]      = [];
	const controllers: string[] = [];
	const components: string[]  = [];
	const pages: string[]       = [];
	const symbols: string[]     = [];

	for (const f of abs) {
		const base = path.basename(f, path.extname(f));
		if (/route/i.test(f))      routes.push(base);
		if (/model/i.test(f))      models.push(base);
		if (/controller/i.test(f)) { controllers.push(base); symbols.push(...inferControllerSymbols(base)); }
		if (/component/i.test(f))  components.push(base);
		if (/page/i.test(f))       pages.push(base);
		// Generic: export name = file basename (PascalCase → camelCase)
		symbols.push(toCamel(base));
	}

	return {
		specialist,
		files: abs,
		symbols: [...new Set(symbols)],
		routes,
		models,
		controllers,
		components,
		pages,
		ts: Date.now(),
	};
}

function toCamel(s: string): string {
	return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Infer likely exported function names from controller name */
function inferControllerSymbols(controllerBase: string): string[] {
	const entity = controllerBase.replace(/[Cc]ontroller$/, '');
	const e = entity.charAt(0).toLowerCase() + entity.slice(1);
	return [`get${entity}`, `create${entity}`, `update${entity}`, `delete${entity}`, `${e}Controller`];
}
