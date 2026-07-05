/*
 * Component 3 — Symbol Index
 * ts-morph AST scan. Indexes exported: functions, classes, interfaces, enums, hooks.
 * Persists to symbols.json. Incremental patch on file save.
 */

import fs from 'fs';
import path from 'path';
import { Project, SyntaxKind } from 'ts-morph';
import { getCachePath, readCache, writeCache } from './cache.js';
import { getAllCodeFiles } from '../rag.js';

export type SymbolMap = Record<string, string>; // symbolName → absolute filePath

export function buildSymbolIndex(workspaceRoot: string): SymbolMap {
	const cachePath = getCachePath(workspaceRoot, 'symbols.json');
	const cached    = readCache<SymbolMap>(cachePath);
	if (cached) return cached;
	return rebuildSymbolIndex(workspaceRoot);
}

export function rebuildSymbolIndex(workspaceRoot: string): SymbolMap {
	const files   = getAllCodeFiles(workspaceRoot).filter(f => /\.(ts|tsx)$/.test(f));
	const symbols = extractSymbols(files, workspaceRoot);
	const cache   = getCachePath(workspaceRoot, 'symbols.json');
	writeCache(cache, symbols);
	console.log(`[SYMBOL] Indexed ${Object.keys(symbols).length} symbols from ${files.length} files`);
	return symbols;
}

/** Patch a single file into the existing symbol map (incremental rebuild) */
export function patchSymbolIndex(workspaceRoot: string, filePath: string): void {
	const cachePath = getCachePath(workspaceRoot, 'symbols.json');
	const existing  = readCache<SymbolMap>(cachePath) ?? {};

	// Remove old entries from this file
	for (const key of Object.keys(existing)) {
		if (existing[key] === filePath) delete existing[key];
	}

	// Add new entries
	if (fs.existsSync(filePath) && /\.(ts|tsx)$/.test(filePath)) {
		const fresh = extractSymbols([filePath], workspaceRoot);
		Object.assign(existing, fresh);
	}

	writeCache(cachePath, existing);
}

function extractSymbols(files: string[], workspaceRoot: string): SymbolMap {
	const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
	const result: SymbolMap = {};

	for (const f of files) {
		try {
			const src = project.addSourceFileAtPath(f);

			// Exported functions + hooks
			for (const fn of src.getFunctions()) {
				if (fn.isExported() || fn.getName()?.startsWith('use')) {
					const name = fn.getName();
					if (name) result[name] = f;
				}
			}

			// Arrow function exports (const useX = () => ...)
			for (const vd of src.getVariableDeclarations()) {
				const name = vd.getName();
				const init = vd.getInitializer();
				if (name && init && (init.getKind() === SyntaxKind.ArrowFunction)) {
					const parent = vd.getParent()?.getParent();
					if (parent?.getKind() === SyntaxKind.VariableStatement) {
						result[name] = f;
					}
				}
			}

			// Classes
			for (const cls of src.getClasses()) {
				const name = cls.getName();
				if (name) result[name] = f;
			}

			// Interfaces
			for (const iface of src.getInterfaces()) {
				result[iface.getName()] = f;
			}

			// Enums
			for (const en of src.getEnums()) {
				result[en.getName()] = f;
			}

			project.removeSourceFile(src); // free memory
		} catch {}
	}

	return result;
}

/** Search symbol map for entities extracted from a prompt */
export function searchSymbols(symbols: SymbolMap, entities: string[]): Record<string, number> {
	const hits: Record<string, number> = {}; // filePath → score
	const entLower = entities.map(e => e.toLowerCase());

	for (const [sym, file] of Object.entries(symbols)) {
		const symLower = sym.toLowerCase();
		for (const ent of entLower) {
			if (symLower.includes(ent) || ent.includes(symLower)) {
				hits[file] = (hits[file] ?? 0) + 1;
				console.log(`[SYMBOL] ${sym} → ${path.relative(process.cwd(), file)} (entity: ${ent})`);
			}
		}
	}

	return hits;
}
