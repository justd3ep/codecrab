/*
 * Cache helpers — shared by all Tier-2 components
 * Location: router/.rag-cache/<ws-hash>/
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const CACHE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.rag-cache');

export function wsHash(workspaceRoot: string): string {
	return crypto.createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 16);
}

export function getCachePath(workspaceRoot: string, file: string): string {
	const dir = path.join(CACHE_ROOT, wsHash(workspaceRoot));
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, file);
}

export function readCache<T>(cachePath: string): T | null {
	try {
		if (!fs.existsSync(cachePath)) return null;
		return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as T;
	} catch {
		return null;
	}
}

export function writeCache<T>(cachePath: string, data: T): void {
	try {
		fs.writeFileSync(cachePath, JSON.stringify(data), 'utf-8');
	} catch {}
}
