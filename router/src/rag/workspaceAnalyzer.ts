/*
 * Component 1 — Workspace Analyzer
 * Pure fs.readdir walk. No AST. Fast.
 */

import fs from 'fs';
import path from 'path';

export interface WorkspaceSignals {
	frontend: boolean;
	backend: boolean;
	hasReact: boolean;
	hasExpress: boolean;
	hasPrisma: boolean;
}

const FE_DIR_SIGNALS  = new Set(['components','pages','hooks','contexts','styles','store','stores','ui','views']);
const BE_DIR_SIGNALS  = new Set(['controllers','routes','middleware','services','repositories','models','database','jobs','guards']);
const FE_FILE_SIGNALS = new Set(['app.tsx','app.jsx','vite.config.ts','vite.config.js','tailwind.config.ts','tailwind.config.js','tailwind.config.cjs']);
const BE_FILE_SIGNALS = new Set(['server.ts','server.js','main.ts','main.js','prisma']);

export function analyzeWorkspace(workspaceRoot: string): WorkspaceSignals {
	const sig: WorkspaceSignals = { frontend: false, backend: false, hasReact: false, hasExpress: false, hasPrisma: false };
	if (!fs.existsSync(workspaceRoot)) return sig;

	walkDir(workspaceRoot, workspaceRoot, sig, 0);
	return sig;
}

function walkDir(root: string, dir: string, sig: WorkspaceSignals, depth: number): void {
	if (depth > 4) return; // don't go too deep
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

	for (const e of entries) {
		const name = e.name.toLowerCase();
		if (['node_modules','.git','dist','build','.next','out'].includes(name)) continue;

		if (e.isDirectory()) {
			if (FE_DIR_SIGNALS.has(name)) sig.frontend = true;
			if (BE_DIR_SIGNALS.has(name)) sig.backend  = true;
			if (name === 'prisma')         sig.hasPrisma = true;
			walkDir(root, path.join(dir, e.name), sig, depth + 1);
		} else {
			if (FE_FILE_SIGNALS.has(name)) sig.frontend = true;
			if (BE_FILE_SIGNALS.has(name)) sig.backend  = true;
			if (name === 'schema.prisma')  sig.hasPrisma = true;
		}
	}
}
