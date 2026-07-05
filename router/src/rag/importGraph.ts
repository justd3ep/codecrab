/*
 * Component 4 — Import Graph
 * ts-morph static import resolution. Builds file → [imported files] map.
 * Supports upstream + downstream traversal.
 * Persists to imports.json.
 */

import fs from 'fs';
import path from 'path';
import { Project } from 'ts-morph';
import { getCachePath, readCache, writeCache } from './cache.js';
import { getAllCodeFiles } from '../rag.js';

export type ImportGraph = Record<string, string[]>; // file → files it imports

export function buildImportGraph(workspaceRoot: string): ImportGraph {
	const cachePath = getCachePath(workspaceRoot, 'imports.json');
	const cached    = readCache<ImportGraph>(cachePath);
	if (cached) return cached;
	return rebuildImportGraph(workspaceRoot);
}

export function rebuildImportGraph(workspaceRoot: string): ImportGraph {
	const files   = getAllCodeFiles(workspaceRoot).filter(f => /\.(ts|tsx)$/.test(f));
	const graph   = extractImports(files, workspaceRoot);
	writeCache(getCachePath(workspaceRoot, 'imports.json'), graph);
	console.log(`[IMPORT] Built import graph: ${Object.keys(graph).length} files`);
	return graph;
}

/** Patch a single file's imports (incremental rebuild) */
export function patchImportGraph(workspaceRoot: string, filePath: string): void {
	const cachePath = getCachePath(workspaceRoot, 'imports.json');
	const existing  = readCache<ImportGraph>(cachePath) ?? {};

	if (fs.existsSync(filePath) && /\.(ts|tsx)$/.test(filePath)) {
		const fresh = extractImports([filePath], workspaceRoot);
		existing[filePath] = fresh[filePath] ?? [];
	} else {
		delete existing[filePath];
	}

	writeCache(cachePath, existing);
}

function extractImports(files: string[], workspaceRoot: string): ImportGraph {
	const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
	const graph: ImportGraph = {};

	for (const f of files) {
		try {
			const src = project.addSourceFileAtPath(f);
			const imports: string[] = [];

			for (const decl of src.getImportDeclarations()) {
				const spec = decl.getModuleSpecifierValue();
				// Only relative imports (skip node_modules)
				if (!spec.startsWith('.')) continue;
				const resolved = resolveImport(path.dirname(f), spec);
				if (resolved) imports.push(resolved);
			}

			graph[f] = imports;
			project.removeSourceFile(src);
		} catch {}
	}

	return graph;
}

function resolveImport(fromDir: string, spec: string): string | null {
	const exts = ['', '.ts', '.tsx', '.js', '.jsx'];
	for (const ext of exts) {
		const candidate = path.resolve(fromDir, spec + ext);
		if (fs.existsSync(candidate)) return candidate;
	}
	// try index file
	for (const ext of ['.ts', '.tsx', '.js']) {
		const candidate = path.resolve(fromDir, spec, 'index' + ext);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

/** Downstream: files imported by startFile (recursive up to depth) */
export function downstream(graph: ImportGraph, startFile: string, depth = 3): string[] {
	const visited = new Set<string>();
	const queue   = [{ file: startFile, d: 0 }];
	while (queue.length) {
		const { file, d } = queue.shift()!;
		if (visited.has(file) || d > depth) continue;
		visited.add(file);
		for (const dep of graph[file] ?? []) queue.push({ file: dep, d: d + 1 });
	}
	visited.delete(startFile);
	return [...visited];
}

/** Upstream: files that import targetFile */
export function upstream(graph: ImportGraph, targetFile: string): string[] {
	return Object.entries(graph)
		.filter(([, deps]) => deps.includes(targetFile))
		.map(([f]) => f);
}

/** Expand a set of seed files by adding their direct imports */
export function expandNeighbors(graph: ImportGraph, seeds: string[], hops = 1): string[] {
	const result = new Set<string>(seeds);
	let frontier = [...seeds];
	for (let h = 0; h < hops; h++) {
		const next: string[] = [];
		for (const f of frontier) {
			for (const dep of graph[f] ?? []) {
				if (!result.has(dep)) { result.add(dep); next.push(dep); }
			}
		}
		frontier = next;
	}
	seeds.forEach(s => result.delete(s)); // return only neighbors, not seeds themselves
	return [...result];
}
