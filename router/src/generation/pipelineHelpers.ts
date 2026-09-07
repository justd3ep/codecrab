/**
 * pipelineHelpers.ts — Helper utilities for generation streaming, fallback parsing,
 * JSX symbol validation, loop detection, and backend contract summarization.
 *
 * Extracted from index.ts.
 */

import fs from 'fs';
import path from 'path';
import type { Response } from 'express';
import type { AgentMode } from '../routing/agentMode.js';
import { readFileSafe, inferFilePath } from '../tools/toolEngine.js';

// ---------------------------------------------------------------------------
// BackendSummary — structured contract passed from BE phase to FE phase
// ---------------------------------------------------------------------------

export interface BackendSummary {
	routes: string[];      // e.g. ["POST /api/auth/login", "GET /api/users/:id"]
	entities: string[];    // e.g. ["User", "Session", "Post"]
	auth: string;          // e.g. "JWT Bearer token in Authorization header"
	database: string;      // e.g. "PostgreSQL via Prisma"
	files: string[];       // relative paths written by BE
}

export function extractBackendSummary(filesModified: string[], workspaceRoot: string): string {
	const summary: BackendSummary = {
		routes: [],
		entities: [],
		auth: 'Unknown',
		database: 'Unknown',
		files: filesModified,
	};

	for (const f of filesModified) {
		const absPath = path.isAbsolute(f) ? f : path.join(workspaceRoot, f);
		const content = readFileSafe(absPath);
		if (!content) continue;

		// Extract route definitions (Express-style)
		const routeMatches = content.matchAll(/(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi);
		for (const m of routeMatches) {
			if (m[1] && m[2]) summary.routes.push(`${m[1].toUpperCase()} ${m[2]}`);
		}

		// Extract entity/model names (TypeScript interfaces, classes, Prisma models)
		const entityMatches = content.matchAll(/(?:interface|class|model)\s+([A-Z][a-zA-Z]+)/g);
		for (const m of entityMatches) {
			if (!summary.entities.includes(m[1]!)) summary.entities.push(m[1]!);
		}

		// Detect auth strategy
		if (/jwt|jsonwebtoken/i.test(content)) summary.auth = 'JWT Bearer token';
		else if (/session|express-session/i.test(content)) summary.auth = 'Session-based';
		else if (/passport/i.test(content)) summary.auth = 'Passport.js';

		// Detect database
		if (/prisma/i.test(content)) summary.database = 'Prisma ORM';
		else if (/mongoose|mongodb/i.test(content)) summary.database = 'MongoDB/Mongoose';
		else if (/pg|postgres/i.test(content)) summary.database = 'PostgreSQL';
		else if (/mysql2?/i.test(content)) summary.database = 'MySQL';
		else if (/sqlite/i.test(content)) summary.database = 'SQLite';
	}

	// Deduplicate routes
	summary.routes = [...new Set(summary.routes)].slice(0, 20);

	return [
		summary.routes.length > 0 ? `API routes:\n${summary.routes.map(r => `  ${r}`).join('\n')}` : '',
		summary.entities.length > 0 ? `Entities: ${summary.entities.join(', ')}` : '',
		`Auth: ${summary.auth}`,
		`Database: ${summary.database}`,
	].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Fallback: extract code blocks with file paths from model output
// ---------------------------------------------------------------------------

export interface FallbackEdit {
	path: string;
	content: string;
}

export function cleanCodeBlock(content: string, filePath?: string): string {
	content = content.trim();
	const match = content.match(/^```\w*\r?\n([\s\S]*?)\r?\n```$/);
	if (match) {
		content = match[1]!.trim();
	}
	// Deterministically strip Next.js "use client" directive from frontend React/TSX files
	if (!filePath || /\.(tsx|jsx|ts|js)$/i.test(filePath)) {
		content = content.replace(/^(\s*['"]use client['"];?\s*\r?\n?)+/gi, '').trimStart();
	}
	return content;
}

export function extractFallbackEdits(text: string, openFiles?: string[], workspaceRoot?: string, userPrompt?: string, mode?: AgentMode, onlyClosed: boolean = false): FallbackEdit[] {
	const edits: FallbackEdit[] = [];
	const seenPaths = new Set<string>();

	// Pattern 0: <file path="relative/path.ext">content</file>
	if (/<file\s+path=["'][^"']+["']\s*>/i.test(text)) {
		console.log(`[Router] Pattern 0: <file> tags detected, parsing...`);
		const openTagRegex = /<file\s+path=["']([^"']+)["']\s*>/gi;
		const openTags: { path: string; startIndex: number; tagEnd: number }[] = [];
		let tagMatch;
		while ((tagMatch = openTagRegex.exec(text)) !== null) {
			openTags.push({
				path: tagMatch[1]!.trim(),
				startIndex: tagMatch.index,
				tagEnd: tagMatch.index + tagMatch[0].length,
			});
		}

		for (let i = 0; i < openTags.length; i++) {
			const tag = openTags[i]!;
			const afterTag = tag.tagEnd;

			let endIndex = text.length;
			const remainingText = text.substring(afterTag);

			const closeMatch = remainingText.match(/<\/file>/i);
			const nextOpenMatch = i + 1 < openTags.length ? openTags[i + 1]!.startIndex : text.length;

			let hasClosingTag = false;
			if (closeMatch && (afterTag + closeMatch.index!) < nextOpenMatch) {
				endIndex = afterTag + closeMatch.index!;
				hasClosingTag = true;
			} else {
				endIndex = nextOpenMatch;
			}

			if (onlyClosed && !hasClosingTag) {
				console.log(`[Router] Pattern 0: skipping unclosed/truncated file "${tag.path}" during compaction harvest`);
				continue;
			}

			let content = text.substring(afterTag, endIndex).trim();
			content = content.replace(/<\/file>\s*$/i, '').trim();
			content = cleanCodeBlock(content, tag.path);

			if (tag.path && content && content.length > 5 && !seenPaths.has(tag.path)) {
				seenPaths.add(tag.path);
				edits.push({ path: tag.path, content });
				console.log(`[Router] Pattern 0: extracted → "${tag.path}" (${content.length} chars)`);
			}
		}
	}

	if (edits.length > 0) {
		console.log(`[Router] Pattern 0: ${edits.length} file block(s) extracted. Bypassing P1–P4.`);
		return edits;
	}
	console.log(`[Router] Pattern 0: no <file> blocks detected. Falling through to P1–P4.`);

	// Pattern 1: ```lang\n// filepath\ncontent```
	const p1 = /```\w*\s*\r?\n\s*\/\/\s*([\w./\\-]+\.\w+)\s*\r?\n([\s\S]*?)```/g;
	let match;
	while ((match = p1.exec(text)) !== null) {
		const p = match[1]!.trim();
		const c = match[2]!.trim();
		if (p && c && c.length > 10 && !seenPaths.has(p)) {
			seenPaths.add(p);
			edits.push({ path: p, content: c });
		}
	}

	// Pattern 2: File: path\n```\ncontent```
	const p2 = /(?:File|file|Path|path):\s*([\w./\\-]+\.\w+)\s*\r?\n\s*```\w*\r?\n([\s\S]*?)```/g;
	while ((match = p2.exec(text)) !== null) {
		const p = match[1]!.trim();
		const c = match[2]!.trim();
		if (p && c && c.length > 10 && !seenPaths.has(p)) {
			seenPaths.add(p);
			edits.push({ path: p, content: c });
		}
	}

	// Pattern 3: Code fenced block — any ```lang ... ```
	if (mode !== 'create') {
		const p3f = /```(?:jsx|tsx|javascript|js|typescript|ts|css|html|vue|svelte|json|sh|bash)\r?\n([\s\S]+?)```/g;
		while ((match = p3f.exec(text)) !== null) {
			const code = match[1]!.trim();
			if (code.length > 30 && !seenPaths.size) {
				const targetPath = inferFilePath(code, openFiles, workspaceRoot, userPrompt);
				if (targetPath && !seenPaths.has(targetPath)) {
					seenPaths.add(targetPath);
					edits.push({ path: targetPath, content: code });
				}
			}
		}
	}

	// Pattern 4: Raw unfenced code detection
	if (edits.length === 0 && workspaceRoot && mode !== 'create') {
		const code = extractRawCode(text);
		if (code && code.length > 30) {
			const targetPath = inferFilePath(code, openFiles, workspaceRoot, userPrompt);
			if (targetPath) {
				console.log(`[Router] Fallback P4: detected raw unfenced code → ${targetPath}`);
				edits.push({ path: targetPath, content: code });
			}
		}
	}

	return edits;
}

// ---------------------------------------------------------------------------
// JSX Symbol Validator
// ---------------------------------------------------------------------------

export interface JsxSymbolIssue {
	file: string;
	component: string;
	kind: 'missing_import' | 'missing_file';
	importPath?: string;
}

export function validateJsxSymbols(
	generatedFiles: Array<{ path: string; content: string }>,
	workspaceRoot: string,
): JsxSymbolIssue[] {
	const issues: JsxSymbolIssue[] = [];
	const responsePathsRel = new Set(generatedFiles.map(f => f.path.replace(/\\/g, '/')));

	const REACT_BUILTINS = new Set([
		'React', 'Fragment', 'StrictMode', 'Suspense', 'Profiler',
	]);

	const RESOLVE_EXTS = [
		'', '.tsx', '.jsx', '.ts', '.js',
		'/index.tsx', '/index.jsx', '/index.ts', '/index.js',
	];

	for (const { path: filePath, content } of generatedFiles) {
		const ext = path.extname(filePath).toLowerCase();
		if (!['.tsx', '.jsx'].includes(ext)) continue;

		const usedComponents = new Set<string>();
		const jsxTagRe = /<([A-Z][A-Za-z0-9]*)(?:\s|\s*\/?>)/g;
		let m: RegExpExecArray | null;
		while ((m = jsxTagRe.exec(content)) !== null) {
			if (m[1]) usedComponents.add(m[1]);
		}
		if (usedComponents.size === 0) continue;

		const importedSymbols = new Map<string, string>();

		const defRe = /import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"]([^'"]+)['"]/g;
		while ((m = defRe.exec(content)) !== null) {
			if (m[1] && m[2]) importedSymbols.set(m[1], m[2]);
		}
		const namedRe = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
		while ((m = namedRe.exec(content)) !== null) {
			const iPath = m[2]!;
			const names = m[1]!.split(',')
				.map(s => s.trim().split(/\s+as\s+/).pop()!.trim())
				.filter(Boolean);
			for (const name of names) importedSymbols.set(name, iPath);
		}
		const nsRe = /import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"]([^'"]+)['"]/g;
		while ((m = nsRe.exec(content)) !== null) {
			if (m[1] && m[2]) importedSymbols.set(m[1], m[2]);
		}

		for (const comp of usedComponents) {
			if (REACT_BUILTINS.has(comp)) continue;

			if (!importedSymbols.has(comp)) {
				console.log(`[Validator] missing ${comp} in ${filePath}`);
				issues.push({ file: filePath, component: comp, kind: 'missing_import' });
				continue;
			}

			const importPath = importedSymbols.get(comp)!;
			if (!importPath.startsWith('.')) continue;

			const fileDir = path.dirname(filePath).replace(/\\/g, '/');
			const resolvedBase = path.normalize(path.join(fileDir, importPath)).replace(/\\/g, '/');

			const existsInResponse = RESOLVE_EXTS.some(e =>
				responsePathsRel.has(resolvedBase + e) || responsePathsRel.has(resolvedBase),
			);
			const existsOnDisk = RESOLVE_EXTS.some(e => {
				try {
					return fs.existsSync(path.join(workspaceRoot, resolvedBase + e))
						|| fs.existsSync(path.join(workspaceRoot, resolvedBase));
				} catch { return false; }
			});

			if (!existsInResponse && !existsOnDisk) {
				console.log(`[Validator] missing file: ${resolvedBase} (import "${importPath}" → <${comp} /> in ${filePath})`);
				issues.push({ file: filePath, component: comp, kind: 'missing_file', importPath });
			}
		}
	}

	if (issues.length === 0) console.log('[Validator] all JSX symbols OK');
	return issues;
}

export function buildJsxRepairPrompt(issues: JsxSymbolIssue[]): string {
	const byFile = new Map<string, JsxSymbolIssue[]>();
	for (const iss of issues) {
		if (!byFile.has(iss.file)) byFile.set(iss.file, []);
		byFile.get(iss.file)!.push(iss);
	}

	const lines: string[] = [
		'<validation_errors>',
		'JSX symbol validation failed. The following components are broken:',
		'',
	];
	for (const [file, fileIssues] of byFile) {
		lines.push(`File: ${file}`);
		for (const iss of fileIssues) {
			if (iss.kind === 'missing_import') {
				lines.push(`  - <${iss.component} /> used but NOT imported.`);
				lines.push(`    Fix: add  import ${iss.component} from "./${iss.component}";`);
			} else {
				lines.push(`  - <${iss.component} /> import path "${iss.importPath}" → file does not exist.`);
				lines.push(`    Fix: create the missing file OR correct the import path.`);
			}
		}
		lines.push('');
	}
	lines.push(
		'Rules:',
		'  1. Every JSX component must be imported before use.',
		'  2. Every import path must resolve to a file in this response or the workspace.',
		'  3. Re-emit ONLY the file(s) listed above that need fixing using <file path="...">...</file> format. Do NOT re-emit other already completed files.',
		'</validation_errors>',
		'',
		'[Validator] repairing — output only the fixed file(s) now.',
	);
	return lines.join('\n');
}

export function extractRawCode(text: string): string | null {
	const lines = text.split('\n');
	let codeLines: string[] = [];
	let nonCodeLines: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const isCode =
			/^import\s+/.test(trimmed) ||
			/^from\s+['"]/.test(trimmed) ||
			/^const\s+\w+\s*=\s*require/.test(trimmed) ||
			/^export\s+(default\s+)?/.test(trimmed) ||
			/^(const|let|var|function|class|interface|type|enum)\s+/.test(trimmed) ||
			/^\s*<\/?[\w]+/.test(trimmed) ||
			/^\s*\/>/.test(trimmed) ||
			/^\s*[\w.-]+\s*\{/.test(trimmed) ||
			/^\s*[\w-]+\s*:.*[;{]/.test(trimmed) ||
			/^[}\]);,]+$/.test(trimmed) ||
			/^\s*return\s*[\s(]/.test(trimmed) ||
			/^\s*(className|onClick|onChange|style|href|src|alt|type)=/.test(trimmed) ||
			/=>\s*[{(]/.test(trimmed);

		if (isCode) {
			codeLines.push(line);
		} else {
			nonCodeLines.push(line);
		}
	}

	const totalNonEmpty = codeLines.length + nonCodeLines.length;
	if (totalNonEmpty < 3) return null;

	const codeRatio = codeLines.length / totalNonEmpty;
	if (codeRatio >= 0.6) {
		const allLines = text.split('\n');
		let startIdx = 0;
		let endIdx = allLines.length - 1;

		while (startIdx < allLines.length) {
			const l = allLines[startIdx]!.trim();
			if (!l || /^(import |export |const |let |var |function |class |<|\/\/|\/\*|\*|@|#|\{|\(|return )/.test(l)) break;
			startIdx++;
		}
		while (endIdx > startIdx) {
			const l = allLines[endIdx]!.trim();
			if (!l || /^[}\]);]|^<\/|^\*\/|^export |^module\.exports/.test(l)) break;
			endIdx--;
		}

		const codeBlock = allLines.slice(startIdx, endIdx + 1).join('\n').trim();
		if (codeBlock.length > 30) {
			return codeBlock;
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Streaming & Pipeline Event Helpers
// ---------------------------------------------------------------------------

export function streamChunk(res: Response, content: string): void {
	res.write(JSON.stringify({ message: { content } }) + '\n');
}

export interface PipelineEvent {
	type: 'progress' | 'success' | 'warning' | 'error' | 'info' | 'context_usage';
	stage?: 'read' | 'plan' | 'generate' | 'write' | 'validate' | 'repair' | 'complete';
	message?: string;
	file?: string;
	used?: number;
	total?: number;
	percent?: number;
}

export function streamEvent(res: Response, evt: PipelineEvent): void {
	if (evt.type === 'context_usage') {
		res.write(JSON.stringify({ type: 'context_usage', used: evt.used, total: evt.total, percent: evt.percent }) + '\n');
		return;
	}
	const icon =
		evt.type === 'success' ? '✓'
			: evt.type === 'error' ? '✗'
				: evt.type === 'warning' ? '!'
					: '•';
	const markdown = `${icon} ${evt.message}\n`;
	res.write(JSON.stringify({ message: { content: markdown }, event: evt }) + '\n');
}

export function isExplicitCodeRequest(msg: string): boolean {
	return /\b(show|display|print|output|give me|return|see)\b.{0,30}\b(code|implementation|diff|changes|output|result|file)\b/i.test(msg)
		|| /\bshow (the )?(generated|full|complete|entire|updated)\b/i.test(msg)
		|| /\b(explain|walk me through|describe)\b.{0,20}\b(implementation|code|changes)\b/i.test(msg);
}

export function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function detectRepetitionLoop(text: string): { detected: boolean; reason?: string } {
	if (text.length < 200) return { detected: false };

	const windowSizes = [30, 50];
	for (const size of windowSizes) {
		const suffix = text.substring(text.length - size).trim();
		if (!suffix || suffix.length < size * 0.6) continue;

		const recentText = text.substring(Math.max(0, text.length - 400));
		const allMatches: number[] = [];
		const escaped = escapeRegExp(suffix);
		const re = new RegExp(escaped, 'g');
		let m: RegExpExecArray | null;
		while ((m = re.exec(recentText)) !== null) {
			allMatches.push(m.index);
		}

		if (allMatches.length < 6) continue;

		const windowLen = recentText.length;
		const tail3 = allMatches.slice(-3);
		const allInTail = tail3.every(idx => idx >= windowLen * 0.4);
		if (allInTail) {
			return { detected: true, reason: `Suffix loop: "${suffix}" repeated ${allMatches.length} times in recent output` };
		}
	}

	const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	if (lines.length >= 8) {
		const lastLine = lines[lines.length - 1]!;
		if (lastLine.length > 15) {
			let repeatCount = 0;
			for (let i = lines.length - 2; i >= Math.max(0, lines.length - 8); i--) {
				if (lines[i] === lastLine) repeatCount++;
			}
			if (repeatCount >= 4) {
				return { detected: true, reason: `Line repetition loop: "${lastLine}" repeated ${repeatCount + 1} times` };
			}
		}
	}

	if (text.length >= 200) {
		const recent = text.substring(text.length - 150);
		const uniqueChars = new Set(recent).size;
		if (uniqueChars < 5) {
			return { detected: true, reason: `Stagnation: only ${uniqueChars} unique characters in the last 150 characters` };
		}
	}

	const fileTagMatches = text.match(/<file\s+path="([^"]+)"/gi) || [];
	if (fileTagMatches.length >= 3) {
		const tagCounts = new Map<string, number>();
		for (const tag of fileTagMatches) {
			const pathMatch = tag.match(/path="([^"]+)"/i);
			if (pathMatch?.[1]) {
				const p = pathMatch[1];
				tagCounts.set(p, (tagCounts.get(p) || 0) + 1);
			}
		}
		for (const [filePath, count] of tagCounts) {
			if (count >= 3) {
				return { detected: true, reason: `File-block loop: <file path="${filePath}"> repeated ${count} times` };
			}
		}
	}

	return { detected: false };
}
