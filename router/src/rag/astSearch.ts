/*
 * Component 5 — AST Search
 * Extracts keyword entities from prompt. Searches identifiers/function/class names.
 * Returns candidate files ranked by hit frequency.
 * Caches per-workspace AST identifier map in ast.json.
 */

import path from 'path';
import { Project, SyntaxKind } from 'ts-morph';
import { getCachePath, readCache, writeCache } from './cache.js';
import { getAllCodeFiles } from '../rag.js';

export type AstMap = Record<string, string[]>; // filePath → [identifiers]

// Stopwords to strip from prompts before entity extraction
const STOPWORDS = new Set([
	'a','an','the','with','and','or','for','to','in','on','at','is','are','was','were',
	'it','its','this','that','from','by','of','as','be','do','use','using','add','make',
	'create','build','implement','update','edit','fix','change','write','into','need',
	'want','should','can','will','please','just','get','set','new','my','our','your',
	'i','we','you','they','how','what','where','when','which',
]);

/** Extract searchable entity tokens from a natural-language prompt */
export function extractEntities(prompt: string): string[] {
	// Split camelCase / PascalCase → words
	const expanded = prompt.replace(/([a-z])([A-Z])/g, '$1 $2');
	const tokens   = expanded.toLowerCase().match(/[a-z]{2,}/g) ?? [];
	return [...new Set(tokens.filter(t => !STOPWORDS.has(t)))];
}

/** Build/load the per-workspace AST identifier map */
export function buildAstMap(workspaceRoot: string): AstMap {
	const cachePath = getCachePath(workspaceRoot, 'ast.json');
	const cached    = readCache<AstMap>(cachePath);
	if (cached) return cached;
	return rebuildAstMap(workspaceRoot);
}

export function rebuildAstMap(workspaceRoot: string): AstMap {
	const files = getAllCodeFiles(workspaceRoot).filter(f => /\.(ts|tsx)$/.test(f));
	const map   = extractAstIdentifiers(files);
	writeCache(getCachePath(workspaceRoot, 'ast.json'), map);
	return map;
}

export function patchAstMap(workspaceRoot: string, filePath: string): void {
	const cachePath = getCachePath(workspaceRoot, 'ast.json');
	const existing  = readCache<AstMap>(cachePath) ?? {};
	if (/\.(ts|tsx)$/.test(filePath)) {
		const fresh = extractAstIdentifiers([filePath]);
		existing[filePath] = fresh[filePath] ?? [];
	} else {
		delete existing[filePath];
	}
	writeCache(cachePath, existing);
}

function extractAstIdentifiers(files: string[]): AstMap {
	const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
	const result: AstMap = {};

	for (const f of files) {
		try {
			const src  = project.addSourceFileAtPath(f);
			const ids  = new Set<string>();

			// Function names
			src.getFunctions().forEach(fn => { const n = fn.getName(); if (n) ids.add(n.toLowerCase()); });
			// Class names
			src.getClasses().forEach(cls => { const n = cls.getName(); if (n) ids.add(n.toLowerCase()); });
			// Interface names
			src.getInterfaces().forEach(i => ids.add(i.getName().toLowerCase()));
			// All identifiers (including variable names, import names)
			src.getDescendantsOfKind(SyntaxKind.Identifier).forEach(id => {
				const t = id.getText().toLowerCase();
				if (t.length >= 3) ids.add(t);
			});

			result[f] = [...ids];
			project.removeSourceFile(src);
		} catch {}
	}

	return result;
}

/** Score files by how many extracted entities appear in their identifiers */
export function searchAst(astMap: AstMap, entities: string[]): Record<string, number> {
	const hits: Record<string, number> = {};

	for (const [file, ids] of Object.entries(astMap)) {
		let score = 0;
		for (const ent of entities) {
			if (ids.some(id => id.includes(ent) || ent.includes(id))) score++;
		}
		if (score > 0) {
			hits[file] = score;
			console.log(`[AST] ${path.basename(file)} score=${score}`);
		}
	}

	return hits;
}
