/*
 * Component 2 — Package Analyzer
 * Pure JSON parse. Detects FE/BE deps from package.json.
 */

import fs from 'fs';
import path from 'path';
import { getCachePath, readCache, writeCache } from './cache.js';

export interface DependencySignals {
	react: boolean;
	express: boolean;
	prisma: boolean;
	redis: boolean;
	jwt: boolean;
	mongoose: boolean;
	bullmq: boolean;
	zustand: boolean;
	tailwind: boolean;
}

export function analyzePackage(workspaceRoot: string): DependencySignals {
	const empty: DependencySignals = { react:false, express:false, prisma:false, redis:false, jwt:false, mongoose:false, bullmq:false, zustand:false, tailwind:false };

	const pkgPath = path.join(workspaceRoot, 'package.json');
	if (!fs.existsSync(pkgPath)) return empty;

	// Check cache
	const cachePath = getCachePath(workspaceRoot, 'deps.json');
	const pkgMtime  = fs.statSync(pkgPath).mtimeMs;
	const cached    = readCache<{ mtime: number; signals: DependencySignals }>(cachePath);
	if (cached && cached.mtime === pkgMtime) return cached.signals;

	try {
		const pkg  = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
		const all  = { ...pkg.dependencies ?? {}, ...pkg.devDependencies ?? {} };
		const has  = (name: string) => name in all;

		const signals: DependencySignals = {
			react:    has('react'),
			express:  has('express') || has('@nestjs/core'),
			prisma:   has('prisma') || has('@prisma/client'),
			redis:    has('redis') || has('ioredis'),
			jwt:      has('jsonwebtoken') || has('jose'),
			mongoose: has('mongoose'),
			bullmq:   has('bullmq') || has('bull'),
			zustand:  has('zustand'),
			tailwind: has('tailwindcss'),
		};

		writeCache(cachePath, { mtime: pkgMtime, signals });
		return signals;
	} catch {
		return empty;
	}
}
