/*
 * Component 6 — File Ownership
 * Classifies every workspace file as fe | be | shared.
 * Uses path patterns — no AST needed.
 * Persists to ownership.json.
 */

import fs from 'fs';
import path from 'path';
import { getCachePath, readCache, writeCache } from './cache.js';
import { getAllCodeFiles } from '../rag.js';

export type Owner = 'fe' | 'be' | 'shared';

export interface Ownership {
	path: string;
	owner: Owner;
}

export type OwnershipMap = Record<string, Owner>; // filePath → owner

const FE_PATTERNS = [
	/\.(tsx|jsx|css|scss|sass|less)$/i,
	/(?:^|\/)(?:components|pages|hooks|contexts|styles|ui|views|features)\//i,
	/(?:^|\/)App\.[jt]sx?$/i,
	/tailwind\.config/i,
	/vite\.config/i,
];

const BE_PATTERNS = [
	/(?:^|\/)(?:controllers|routes|middleware|services|repositories|models|database|jobs|guards|strategies)\//i,
	/(?:^|\/)server\.[jt]s$/i,
	/(?:^|\/)main\.[jt]s$/i,
	/prisma\//i,
	/schema\.prisma$/i,
	/migration/i,
];

export function classifyFile(filePath: string): Owner {
	const rel = filePath.replace(/\\/g, '/');
	if (BE_PATTERNS.some(p => p.test(rel))) return 'be';
	if (FE_PATTERNS.some(p => p.test(rel))) return 'fe';
	return 'shared';
}

export function buildOwnershipMap(workspaceRoot: string): OwnershipMap {
	const cachePath = getCachePath(workspaceRoot, 'ownership.json');
	const cached    = readCache<OwnershipMap>(cachePath);
	if (cached) return cached;
	return rebuildOwnershipMap(workspaceRoot);
}

export function rebuildOwnershipMap(workspaceRoot: string): OwnershipMap {
	const files = getAllCodeFiles(workspaceRoot);
	const map: OwnershipMap = {};
	for (const f of files) map[f] = classifyFile(f);
	writeCache(getCachePath(workspaceRoot, 'ownership.json'), map);
	return map;
}

export function patchOwnershipMap(workspaceRoot: string, filePath: string): void {
	const cachePath = getCachePath(workspaceRoot, 'ownership.json');
	const existing  = readCache<OwnershipMap>(cachePath) ?? {};
	if (fs.existsSync(filePath)) {
		existing[filePath] = classifyFile(filePath);
	} else {
		delete existing[filePath];
	}
	writeCache(cachePath, existing);
}

/** Filter files by ownership + intent */
export function filterByOwnership(
	files: string[],
	ownership: OwnershipMap,
	intent: 'frontend' | 'backend' | 'general',
): string[] {
	if (intent === 'general') return files;
	const allowed: Owner[] = intent === 'frontend' ? ['fe', 'shared'] : ['be', 'shared'];
	return files.filter(f => {
		const o = ownership[f] ?? classifyFile(f);
		return allowed.includes(o);
	});
}
