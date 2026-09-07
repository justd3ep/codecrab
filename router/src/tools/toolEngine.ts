/**
 * toolEngine.ts — Workspace tool execution and filesystem helpers.
 *
 * Extracted from index.ts (Step 7).
 * Pure Node.js fs/crypto/path operations — zero HTTP or model manager dependencies.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Content Validation
// ---------------------------------------------------------------------------

export function validateContentForExtension(filename: string, content: string, intent?: string): { valid: boolean; error?: string } {
	const ext = path.extname(filename).toLowerCase();
	const basename = path.basename(filename);

	const hasReactJSX = /import\s+React|from\s+['"]react['"]|useState\s*\(|useEffect\s*\(|useRef\s*\(|useMemo\s*\(|useCallback\s*\(|className\s*=\s*|htmlFor\s*=\s*|onClick\s*=\s*\{|style\s*=\s*\{\{/.test(content);
	const hasTS = /\b(?:interface|namespace)\s+\w+\s*\{|\btype\s+\w+\s*=\s*[^;=]+;|\bas\s+(?:string|number|boolean|any|object|unknown|never)\b|:\s*(?:string|number|boolean|any|void|unknown|never|Record<|Array<)\b/.test(content);
	const hasHTML = /<!DOCTYPE|<html|<head|<body|<div\b|<span\b|<p\b|<a\s+href=|<\/\w+>/.test(content);
	const hasJS = /\b(?:const|let|var)\s+\w+\s*=|^\s*import\s+[\w{}*,\s]+\s+from\s+['"]|^\s*export\s+(?:default|const|let|var|class|function)\b|\bfunction\s+\w+\s*\(|\bconsole\.log\b/m.test(content);

	if (ext === '.js') {
		if (hasReactJSX) {
			if (intent === 'backend') {
				return { valid: false, error: `React/JSX syntax detected in ${basename}.\n\nThis is a BACKEND Node.js project. You MUST write backend JavaScript/TypeScript.\nDo NOT generate frontend React, JSX, or TSX code.\n\nRe-emit only the corrected backend file.` };
			} else {
				return { valid: false, error: `React/JSX syntax detected in ${basename}.\n\nThis project is currently a vanilla HTML/CSS/JavaScript project.\n\nYou MUST rewrite the code using vanilla JavaScript.\nDo NOT create React, JSX, TSX, or framework files.\n\nRe-emit only the corrected file.` };
			}
		}
		if (hasTS) {
			return { valid: false, error: 'TypeScript syntax (type annotations, interfaces) is not allowed in plain JavaScript (.js) files.' };
		}
	} else if (ext === '.ts') {
		if (hasReactJSX) {
			return { valid: false, error: 'React/JSX syntax is not allowed in plain TypeScript (.ts) files. Use .tsx instead.' };
		}
	} else if (ext === '.css') {
		if (hasHTML) {
			return { valid: false, error: 'HTML tags are not allowed in CSS (.css) files.' };
		}
		if (hasJS || hasReactJSX) {
			return { valid: false, error: 'JavaScript or React code is not allowed in CSS (.css) files.' };
		}
	} else if (ext === '.html' || ext === '.htm') {
		if (hasReactJSX) {
			return { valid: false, error: 'React/JSX code is not allowed in HTML (.html) files.' };
		}
		if ((content.includes('import ') || content.includes('export ')) && !content.includes('<script')) {
			return { valid: false, error: 'JavaScript imports/exports are not allowed in HTML files outside of <script> tags.' };
		}
	}

	return { valid: true };
}

// ---------------------------------------------------------------------------
// Path validation (rejects directories, escapes, missing parents)
// ---------------------------------------------------------------------------

export function validateTargetPath(
	resolvedPath: string,
	workspaceRoot: string,
	rawPathArg: string
): { valid: boolean; error?: string } {
	// 1. Must stay inside workspace
	const absRoot = path.resolve(workspaceRoot);
	if (!resolvedPath.startsWith(absRoot + path.sep) && resolvedPath !== absRoot) {
		return { valid: false, error: `Path "${rawPathArg}" escapes the workspace root. Write rejected.` };
	}

	// 2. Trailing slash or no extension and already exists as dir → directory target
	if (rawPathArg.endsWith('/') || rawPathArg.endsWith('\\')) {
		return { valid: false, error: `Path "${rawPathArg}" is a directory (trailing slash). Provide a file path with an extension, e.g. controllers/users.ts` };
	}

	// 3. Path resolves to an existing directory on disk
	try {
		const stat = fs.statSync(resolvedPath);
		if (stat.isDirectory()) {
			return { valid: false, error: `Path "${rawPathArg}" resolves to a directory on disk (EISDIR). Provide a full file path with an extension.` };
		}
	} catch { /* file doesn't exist yet — that's fine */ }

	// 4. Must have a file extension
	if (!path.extname(resolvedPath)) {
		return { valid: false, error: `Path "${rawPathArg}" has no file extension. Provide a valid file path (e.g. src/utils/helpers.ts).` };
	}

	// 5. Parent directory must either exist or be creatable inside the workspace
	const parentDir = path.dirname(resolvedPath);
	if (!parentDir.startsWith(absRoot)) {
		return { valid: false, error: `Parent directory of "${rawPathArg}" is outside the workspace. Write rejected.` };
	}

	return { valid: true };
}

// ---------------------------------------------------------------------------
// Pending Edits Store (diff / approval workflow)
// ---------------------------------------------------------------------------

export interface PendingEdit {
	relPath: string;           // relative to workspaceRoot
	absPath: string;
	newContent: string;
	oldContent: string | null; // null = new file
	diff: string;              // unified diff
}

export interface PendingSession {
	id: string;
	workspaceRoot: string;
	query: string;
	edits: PendingEdit[];
	createdAt: number;
}

export function buildLCS(a: string[], b: string[]): Array<{ old: number; nw: number }> {
	const bMap = new Map<string, number[]>();
	for (let i = 0; i < b.length; i++) {
		const key = b[i]!;
		if (!bMap.has(key)) bMap.set(key, []);
		bMap.get(key)!.push(i);
	}
	const pairs: Array<{ old: number; nw: number }> = [];
	let lastNw = -1;
	for (let oi = 0; oi < a.length; oi++) {
		const matches = bMap.get(a[oi]!) ?? [];
		for (const ni of matches) {
			if (ni > lastNw) {
				pairs.push({ old: oi, nw: ni });
				lastNw = ni;
				break;
			}
		}
	}
	return pairs;
}

export function generateUnifiedDiff(oldContent: string | null, newContent: string, relPath: string): string {
	const oldLines = (oldContent ?? '').split('\n');
	const newLines = newContent.split('\n');
	const header = `--- a/${relPath}\n+++ b/${relPath}\n`;

	const lcs = buildLCS(oldLines, newLines);
	const hunks: string[] = [];
	let ol = 0, nl = 0, lc = 0;
	const changes: Array<{ type: '+' | '-' | ' '; line: string }> = [];

	while (ol < oldLines.length || nl < newLines.length) {
		if (lc < lcs.length && ol === lcs[lc]!.old && nl === lcs[lc]!.nw) {
			changes.push({ type: ' ', line: oldLines[ol]! });
			ol++; nl++; lc++;
		} else if (nl < newLines.length && (lc >= lcs.length || nl < lcs[lc]!.nw)) {
			changes.push({ type: '+', line: newLines[nl]! });
			nl++;
		} else {
			changes.push({ type: '-', line: oldLines[ol]! });
			ol++;
		}
	}

	const CONTEXT = 3;
	const changeIndices = changes.map((c, i) => c.type !== ' ' ? i : -1).filter(i => i >= 0);
	if (changeIndices.length === 0) return header + '(no changes)';

	const ranges: Array<[number, number]> = [];
	let start = Math.max(0, changeIndices[0]! - CONTEXT);
	let end = Math.min(changes.length - 1, changeIndices[0]! + CONTEXT);
	for (let i = 1; i < changeIndices.length; i++) {
		const next = changeIndices[i]!;
		if (next - CONTEXT <= end + CONTEXT) {
			end = Math.min(changes.length - 1, next + CONTEXT);
		} else {
			ranges.push([start, end]);
			start = Math.max(0, next - CONTEXT);
			end = Math.min(changes.length - 1, next + CONTEXT);
		}
	}
	ranges.push([start, end]);

	for (const [s, e] of ranges) {
		const slice = changes.slice(s, e + 1);
		const oldStart = s + 1;
		const oldCount = slice.filter(c => c.type !== '+').length;
		const newStart = s + 1;
		const newCount = slice.filter(c => c.type !== '-').length;
		hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
		for (const c of slice) hunks.push(`${c.type}${c.line}`);
	}

	return header + hunks.join('\n');
}

// In-memory store: sessionId → PendingSession
export const pendingStore = new Map<string, PendingSession>();

export function createPendingSession(
	workspaceRoot: string,
	query: string,
	rawEdits: Array<{ path: string; content: string }>
): PendingSession {
	const id = `ps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const edits: PendingEdit[] = rawEdits.map(e => {
		const absPath = path.resolve(workspaceRoot, e.path);
		const relPath = path.relative(workspaceRoot, absPath);
		let oldContent: string | null = null;
		try { oldContent = fs.readFileSync(absPath, 'utf-8'); } catch { /* new file */ }
		const diff = generateUnifiedDiff(oldContent, e.content, relPath);
		return { relPath, absPath, newContent: e.content, oldContent, diff };
	});
	const session: PendingSession = { id, workspaceRoot, query, edits, createdAt: Date.now() };
	pendingStore.set(id, session);
	// Auto-expire after 10 minutes
	setTimeout(() => pendingStore.delete(id), 10 * 60 * 1000);
	return session;
}

export function applyPendingSession(session: PendingSession): { written: string[]; errors: string[] } {
	const written: string[] = [];
	const errors: string[] = [];
	for (const edit of session.edits) {
		try {
			const dir = path.dirname(edit.absPath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(edit.absPath, edit.newContent, 'utf-8');
			written.push(edit.relPath);
			console.log(`[PendingStore] ✅ Applied: ${edit.relPath}`);
		} catch (e: any) {
			errors.push(`${edit.relPath}: ${e.message}`);
			console.error(`[PendingStore] ❌ Failed: ${edit.relPath} — ${e.message}`);
		}
	}
	return { written, errors };
}

/**
 * Determine the most appropriate file path for a piece of code.
 * Uses: open files, user prompt keywords, and code content analysis.
 */
export function inferFilePath(code: string, openFiles?: string[], workspaceRoot?: string, userPrompt?: string): string {
	const isReact = /import\s+React|from\s+['"]react['"]|jsx|tsx|<\w+[\s/>]/.test(code);
	const isHTML = /<!DOCTYPE|<html|<head|<body/.test(code);
	const isCSS = /@media|@import|@keyframes|\.[\w-]+\s*\{|#[\w-]+\s*\{/.test(code) && !isReact;
	const isVue = /<template>|<script setup|defineComponent/.test(code);
	const isTS = /(?:interface|type|public|private|readonly|namespace)\s+\w+/.test(code) && !isHTML && !isCSS && !isReact;
	const isJS = /(?:const|let|var|function|console\.log|import|export|class)\b/.test(code) && !isHTML && !isCSS && !isReact;

	// 1. Check if user mentions a specific file name (highest priority)
	if (userPrompt) {
		const fileMatch = userPrompt.match(/(?:file|create|make|write|save|name(?:d)?)\s+(?:it\s+)?(?:as\s+|to\s+)?['"]?([\w./\\-]+\.\w+)['"]?/i);
		if (fileMatch) {
			return fileMatch[1]!;
		}
	}

	// 2. If there's exactly one open file, write to it (high priority, ignores model content inference)
	if (openFiles && openFiles.length === 1 && workspaceRoot) {
		return path.relative(workspaceRoot, openFiles[0]!);
	}

	// 3. Determine from project structure if we have a workspace
	if (workspaceRoot) {
		const hasSrc = fs.existsSync(path.join(workspaceRoot, 'src'));
		const prefix = hasSrc ? 'src/' : '';

		if (isHTML) return `${prefix}index.html`;
		if (isCSS) return `${prefix}styles.css`;
		if (isVue) return `${prefix}App.vue`;
		if (isReact) return `${prefix}App.jsx`;
		if (isTS) return `${prefix}index.ts`;
		if (isJS) return `${prefix}index.js`;
		return `${prefix}App.jsx`;
	}

	// 4. No workspace - best guess
	if (isHTML) return 'index.html';
	if (isCSS) return 'styles.css';
	if (isVue) return 'App.vue';
	if (isReact) return 'App.jsx';
	if (isTS) return 'index.ts';
	if (isJS) return 'index.js';
	return 'App.jsx';
}

// ---------------------------------------------------------------------------
// Server-side workspace tools (Node.js fs)
// ---------------------------------------------------------------------------

export function buildDirectoryTree(dirPath: string, indent: string = '', depth: number = 0, maxDepth: number = 3): string {
	if (depth >= maxDepth) return indent + '...\n';
	try {
		const entries = fs.readdirSync(dirPath, { withFileTypes: true });
		const skipDirs = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.vscode', '__pycache__', '.cache', '.svelte-kit']);
		const lines: string[] = [];

		const sorted = [...entries].sort((a, b) => {
			if (a.isDirectory() && !b.isDirectory()) return -1;
			if (!a.isDirectory() && b.isDirectory()) return 1;
			return a.name.localeCompare(b.name);
		});

		for (const entry of sorted) {
			if (entry.isDirectory()) {
				if (skipDirs.has(entry.name)) {
					lines.push(`${indent}${entry.name}/ (skipped)`);
					continue;
				}
				lines.push(`${indent}${entry.name}/`);
				lines.push(buildDirectoryTree(path.join(dirPath, entry.name), indent + '  ', depth + 1, maxDepth));
			} else {
				lines.push(`${indent}${entry.name}`);
			}
		}
		return lines.join('\n');
	} catch {
		return '';
	}
}

export function readFileSafe(filePath: string): string | null {
	try {
		const stat = fs.statSync(filePath);
		if (stat.size > 100_000) return `(file too large: ${(stat.size / 1024).toFixed(0)}KB)`;
		return fs.readFileSync(filePath, 'utf-8');
	} catch {
		return null;
	}
}

export function extractReferencedFiles(message: string, workspaceRoot: string): string[] {
	const filePatterns = message.match(/(?:^|[\s'"`(])([./]?(?:[\w.-]+\/)*[\w.-]+\.(?:json|jsx|tsx|js|ts|css|html|md|vue|svelte|py|rs|go|yaml|yml|toml|env|sh|lock|mjs|cjs))\b/gm);
	if (!filePatterns) return [];

	const files: string[] = [];
	const seen = new Set<string>();

	for (let match of filePatterns) {
		match = match.trim().replace(/^['"`(]/, '');
		const fullPath = path.isAbsolute(match) ? match : path.join(workspaceRoot, match);
		if (!seen.has(fullPath) && fs.existsSync(fullPath)) {
			seen.add(fullPath);
			files.push(fullPath);
		}
	}
	return files;
}

// ---------------------------------------------------------------------------
// Tool Execution Engine
// ---------------------------------------------------------------------------

export interface ToolCallParsed {
	name: string;
	arguments: Record<string, any>;
}

export interface ToolResult {
	success: boolean;
	output: string;
	diffMsg?: string;
}

export function parseToolCall(text: string): { toolCall: ToolCallParsed; textBefore: string; textAfter: string } | null {
	const match = text.match(/([\s\S]*?)<tool_call>\s*([\s\S]*?)\s*<\/tool_call>([\s\S]*)/);
	if (!match) return null;

	try {
		const parsed = JSON.parse(match[2]!.trim());
		if (parsed.name && parsed.arguments) {
			return {
				toolCall: parsed as ToolCallParsed,
				textBefore: match[1]!.trim(),
				textAfter: match[3]!.trim(),
			};
		}
	} catch (e) {
		console.error(`[Router] Failed to parse tool call JSON:`, e);
	}
	return null;
}

export function executeToolCall(
	tool: ToolCallParsed,
	workspaceRoot: string,
	openFiles?: string[],
	lastUserMsg?: string,
	intent?: string,
	readWriteMode?: 'read' | 'write'
): ToolResult {
	const resolvedPath = path.resolve(workspaceRoot, tool.arguments.path || '.');

	// Security: ensure the path stays within the workspace
	if (!resolvedPath.startsWith(path.resolve(workspaceRoot))) {
		return { success: false, output: 'Error: path is outside the workspace boundary.' };
	}

	switch (tool.name) {
		case 'listFiles': {
			try {
				const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
				const skipDirs = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out']);
				const listing = entries
					.filter(e => !skipDirs.has(e.name))
					.sort((a, b) => {
						if (a.isDirectory() && !b.isDirectory()) return -1;
						if (!a.isDirectory() && b.isDirectory()) return 1;
						return a.name.localeCompare(b.name);
					})
					.map(e => e.isDirectory() ? `${e.name}/` : e.name)
					.join('\n');
				return { success: true, output: listing || '(empty directory)' };
			} catch (e: any) {
				return { success: false, output: `Error listing directory: ${e.message}` };
			}
		}

		case 'readFile': {
			try {
				const content = fs.readFileSync(resolvedPath, 'utf-8');
				if (content.length > 100_000) {
					return { success: true, output: `(file too large: ${(content.length / 1024).toFixed(0)}KB — showing first 2000 chars)\n${content.substring(0, 2000)}` };
				}
				return { success: true, output: content };
			} catch (e: any) {
				return { success: false, output: `Error reading file: ${e.message}` };
			}
		}

		case 'writeFile': {
			try {
				// READ mode guard
				if (readWriteMode === 'read') {
					console.log(`[Router] READ mode — blocked write to: ${tool.arguments.path}`);
					return { success: false, output: `[READ MODE] File write blocked. This is a read-only request. No files will be modified.` };
				}

				// Part A — path safety validation
				const rawPathArg = tool.arguments.path || '';
				const pathValidation = validateTargetPath(resolvedPath, workspaceRoot, rawPathArg);
				if (!pathValidation.valid) {
					console.log(`[Router] Path validation failed: ${pathValidation.error}`);
					return { success: false, output: `Path Error: ${pathValidation.error}` };
				}

				let content = tool.arguments.content || '';
				if (/\.(tsx|jsx|ts|js)$/i.test(resolvedPath)) {
					content = content.replace(/^(\s*['"]use client['"];?\s*\r?\n?)+/gi, '').trimStart();
				}
				const validation = validateContentForExtension(resolvedPath, content, intent);
				if (!validation.valid) {
					return { success: false, output: `Validation Error: ${validation.error}` };
				}

				// Part B — actual disk write instead of staging
				const oldContent = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf-8') : '';
				const relPath = path.relative(workspaceRoot, resolvedPath);
				const dir = path.dirname(resolvedPath);
				if (!fs.existsSync(dir)) {
					fs.mkdirSync(dir, { recursive: true });
				}

				// ─── Pipeline SHA trace (Stage 5–6) ───────────────────────────────
				const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
				const oldHash = sha(oldContent);
				const newHash = sha(content);
				const contentIdentical = oldHash === newHash;
				console.log(`[Writer] ${relPath} | old=${oldHash} new=${newHash} same=${contentIdentical}`);
				if (contentIdentical) {
					console.warn(`[Writer] ⚠️ IDENTICAL CONTENT — LLM generated the same code as disk. No change will be visible.`);
					console.log(`[Writer] Existing first 200: ${oldContent.slice(0, 200).replace(/\n/g, '␊')}`);
					console.log(`[Writer] Generated first 200: ${content.slice(0, 200).replace(/\n/g, '␊')}`);
				}

				fs.writeFileSync(resolvedPath, content, 'utf-8');

				// Stage 7: disk read-back verification
				const diskContent = fs.readFileSync(resolvedPath, 'utf-8');
				const diskHash = sha(diskContent);
				if (diskHash !== newHash) {
					console.error(`[Writer] ❌ DISK MISMATCH! written=${newHash} disk=${diskHash} — write failed silently!`);
				} else {
					console.log(`[Writer] ✓ Disk verified: ${diskHash}`);
				}

				// ─── Proper sequential line diff (not Set-based) ───────────────────────
				const oldLines = oldContent ? oldContent.split('\n') : [];
				const newLines = content.split('\n');
				let addedLines = 0;
				let deletedLines = 0;
				if (!contentIdentical) {
					const maxLen = Math.max(oldLines.length, newLines.length);
					for (let i = 0; i < maxLen; i++) {
						const o = oldLines[i];
						const n = newLines[i];
						if (o === undefined) addedLines++;        // new file has more lines
						else if (n === undefined) deletedLines++;  // old file has more lines
						else if (o !== n) { addedLines++; deletedLines++; } // line changed
					}
				}

				let diffMsg = '';
				if (addedLines > 0 || deletedLines > 0) {
					diffMsg = `\n\`\`\`diff\n`;
					if (addedLines > 0) diffMsg += `+ ${addedLines} lines added\n`;
					if (deletedLines > 0) diffMsg += `- ${deletedLines} lines deleted\n`;
					diffMsg += `\`\`\`\n`;
				} else {
					diffMsg = `\n\`\`\`diff\n  (No changes — LLM generated identical content)\n\`\`\`\n`;
				}

				console.log(`[Router] ✏️ Written: ${relPath} (+${addedLines}/-${deletedLines} lines)`);
				return { success: true, output: `WRITTEN:${relPath}`, diffMsg };
			} catch (e: any) {
				return { success: false, output: `Error staging file: ${e.message}` };
			}
		}

		default:
			return { success: false, output: `Unknown tool: ${tool.name}` };
	}
}
