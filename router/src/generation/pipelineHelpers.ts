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

	// Deterministic Next.js directive cleaner
	content = content.replace(/["']use client["'];?\r?\n?/g, '');

	// Harmonize exported component name with filename if in components directory
	if (filePath && (filePath.includes('components/') || filePath.includes('components\\'))) {
		const baseName = path.basename(filePath, path.extname(filePath));
		if (/^[A-Z][A-Za-z0-9]+$/.test(baseName)) {
			// If file is HabitCard.tsx and exports 'export default function Habit(' or 'export function Habit('
			content = content.replace(
				new RegExp(`(export\\s+(?:default\\s+)?function\\s+)([A-Z][A-Za-z0-9]*)(\\s*\\()`, 'g'),
				(full, prefix, currName, suffix) => {
					if (currName !== baseName && (currName.length < baseName.length || baseName.includes(currName))) {
						console.log(`[Harmonizer] Harmonized export function "${currName}" → "${baseName}" in ${filePath}`);
						return `${prefix}${baseName}${suffix}`;
					}
					return full;
				}
			);
		}
	}

	return content;
}

export function extractFallbackEdits(text: string, openFiles?: string[], workspaceRoot?: string, userPrompt?: string, mode?: AgentMode, onlyClosed: boolean = false): FallbackEdit[] {
	const edits: FallbackEdit[] = [];
	const seenPaths = new Set<string>();

	// =====================================================================
	// Pattern 0: <file path="relative/path.ext">content</file>
	// This is the primary output protocol instructed in agent.md.
	// Uses split-based parsing to handle both closed and truncated blocks.
	// =====================================================================
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

			// Determine the end of this block's content:
			// 1. A </file> closing tag for this block
			// 2. The start of the next <file> opening tag
			// 3. End of text (truncated output)
			let endIndex = text.length;
			const remainingText = text.substring(afterTag);

			// Look for </file> before the next <file> tag
			const closeMatch = remainingText.match(/<\/file>/i);
			const nextOpenMatch = i + 1 < openTags.length ? openTags[i + 1]!.startIndex : text.length;

			let hasClosingTag = false;
			if (closeMatch && (afterTag + closeMatch.index!) < nextOpenMatch) {
				// Found a </file> that belongs to this block
				endIndex = afterTag + closeMatch.index!;
				hasClosingTag = true;
			} else {
				// No </file> found before next block or end — truncated
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

	// If Pattern 0 found any edits, return immediately — skip all other fallback patterns
	if (edits.length > 0) {
		console.log(`[Router] Pattern 0: ${edits.length} file block(s) extracted. Bypassing P1–P4.`);
		return edits;
	}
	if (onlyClosed) {
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
	//
	// Previously gated on `mode !== 'create'`. That gate is what caused the
	// dashboard failure: the FE model emitted raw code with NO fences and NO
	// <file> tags, so Pattern 0 found nothing, Pattern 3 was disabled, and
	// Pattern 4 was also disabled — the whole response was discarded and the
	// run was reported as success.
	//
	// The rescue patterns must be available in create mode too. A fenced
	// block in a create response is still code worth keeping.
	{
		const p3f = /```(?:jsx|tsx|javascript|js|typescript|ts|css|html|vue|svelte|json|sh|bash)\r?\n([\s\S]+?)```/g;
		while ((match = p3f.exec(text)) !== null) {
			const code = match[1]!.trim();
			// > 30 chars of content, and the inferred path must not already
			// be taken — a second React block would infer the same path and
			// is correctly dropped rather than clobbering the first.
			if (code.length > 30) {
				const targetPath = inferFilePath(code, openFiles, workspaceRoot, userPrompt);
				if (targetPath && !seenPaths.has(targetPath)) {
					seenPaths.add(targetPath);
					edits.push({ path: targetPath, content: code });
					console.log(`[Router] Pattern 3: fenced block → "${targetPath}" (${code.length} chars)`);
				}
			}
		}
	}

	// Pattern 4 (CRITICAL): Raw unfenced code detection
	// The Qwen models output raw code without any code fences or tool tags.
	// Detect if the response IS code by checking for structural markers.
	//
	// Previously gated on `mode !== 'create'`. Disabled here, it was the
	// single reason a fully-written dashboard was thrown away. The gate was
	// presumably intended for edit mode (where a fragment is not a whole
	// file), but in create mode a code response with no wrapper is exactly
	// the case this pattern exists to handle.
	//
	// extractRawCode() already rejects prose (it requires a >= 0.6 code-line
	// ratio and a > 30 char body), so enabling it is safe: an explanation
	// with no code in it will not match.
	if (edits.length === 0 && workspaceRoot) {
		const code = extractRawCode(text);
		if (code && code.length > 30) {
			const targetPath = inferFilePath(code, openFiles, workspaceRoot, userPrompt);
			if (targetPath) {
				console.log(`[Router] Fallback P4: detected raw unfenced code → ${targetPath} (${code.length} chars)`);
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
	kind: 'missing_import' | 'missing_file' | 'missing_function' | 'orphan_file' | 'prop_mismatch' | 'missing_map' | 'no_output';
	importPath?: string;
	missingFileTarget?: string;
	functionName?: string;
}

export function validateJsxSymbols(
	generatedFiles: Array<{ path: string; content: string }>,
	workspaceRoot: string,
): JsxSymbolIssue[] {
	const issues: JsxSymbolIssue[] = [];

		// An EMPTY input is not "everything is fine" — it is "we looked at
		// nothing". Reporting success here is how a run that produced ZERO
		// files was logged as "all JSX symbols OK" and returned a clean 200.
		//
		// This is a distinct kind because the remedy is different: a JSX symbol
		// problem needs a symbol repair, whereas no output at all needs the
		// model to actually emit code.
		if (generatedFiles.length === 0) {
			issues.push({
				file: '(no files)',
				component: '(none)',
				kind: 'no_output',
			});
			return issues;
		}

	// All relative paths available in this response (normalized to forward slashes)
	const responsePathsRel = new Set(generatedFiles.map(f => f.path.replace(/\\/g, '/')));

	// React built-in component names — never need an explicit import
	const REACT_BUILTINS = new Set([
		'React', 'Fragment', 'StrictMode', 'Suspense', 'Profiler',
	]);

	const RESOLVE_EXTS = [
		'', '.tsx', '.jsx', '.ts', '.js',
		'/index.tsx', '/index.jsx', '/index.ts', '/index.js',
	];

	const JS_KEYWORDS = new Set([
		'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof', 'import', 'super', 'new', 'export', 'default'
	]);
	const COMMON_BUILTINS = new Set([
		'useState', 'useEffect', 'useRef', 'useCallback', 'useMemo', 'useContext', 'useReducer',
		'React', 'console', 'window', 'document', 'localStorage', 'sessionStorage',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Math', 'Date', 'JSON',
		'Array', 'Object', 'String', 'Number', 'Boolean', 'RegExp', 'Map', 'Set',
		'Promise', 'Error', 'TypeError', 'fetch', 'alert', 'confirm', 'prompt',
		'encodeURIComponent', 'decodeURIComponent', 'btoa', 'atob',
	]);

	for (const { path: filePath, content } of generatedFiles) {
		const ext = path.extname(filePath).toLowerCase();
		if (!['.tsx', '.jsx'].includes(ext)) continue;

		// ── Extract PascalCase JSX component names ──────────────────────────
		const usedComponents = new Set<string>();
		const jsxTagRe = /<([A-Z][A-Za-z0-9]*)(?:\s|\s*\/?>)/g;
		let m: RegExpExecArray | null;
		while ((m = jsxTagRe.exec(content)) !== null) {
			if (m[1]) usedComponents.add(m[1]);
		}
		const iconRefRe = /\b(Icon[A-Z][A-Za-z0-9]*)\b/g;
		while ((m = iconRefRe.exec(content)) !== null) {
			if (m[1]) usedComponents.add(m[1]);
		}

		// ── Extract imported symbols → importPath ───────────────────────────
		const importedSymbols = new Map<string, string>(); // symbol → raw import path

		// default: import Foo from './Foo'
		const defRe = /import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"]([^'"]+)['"]/g;
		while ((m = defRe.exec(content)) !== null) {
			if (m[1] && m[2]) importedSymbols.set(m[1], m[2]);
		}
		// named: import { Foo, Bar as B } from './foo'
		const namedRe = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
		while ((m = namedRe.exec(content)) !== null) {
			const iPath = m[2]!;
			const names = m[1]!.split(',')
				.map(s => s.trim().split(/\s+as\s+/).pop()!.trim())
				.filter(Boolean);
			for (const name of names) importedSymbols.set(name, iPath);
		}
		// namespace: import * as Icons from './icons'
		const nsRe = /import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"]([^'"]+)['"]/g;
		while ((m = nsRe.exec(content)) !== null) {
			if (m[1] && m[2]) importedSymbols.set(m[1], m[2]);
		}

		for (const comp of usedComponents) {
			if (REACT_BUILTINS.has(comp)) continue;

			// Check 1: symbol must be imported
			if (!importedSymbols.has(comp)) {
				console.log(`[Validator] missing ${comp} in ${filePath}`);
				issues.push({ file: filePath, component: comp, kind: 'missing_import' });
				continue;
			}

			// Check 2 & 3: import path must resolve to a real file
			const importPath = importedSymbols.get(comp)!;
			let resolvedBase: string;
			if (importPath.startsWith('@/') || importPath.startsWith('~/')) {
				resolvedBase = path.normalize(path.join('src', importPath.slice(2))).replace(/\\/g, '/');
			} else if (importPath.startsWith('.')) {
				const fileDir = path.dirname(filePath).replace(/\\/g, '/');
				resolvedBase = path.normalize(path.join(fileDir, importPath)).replace(/\\/g, '/');
			} else {
				continue; // skip node_modules
			}

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
				const targetExt = path.extname(resolvedBase) ? '' : '.tsx';
				const missingFileTarget = resolvedBase + targetExt;
				console.log(`[Validator] missing file: ${resolvedBase} (import "${importPath}" → <${comp} /> in ${filePath})`);
				issues.push({ file: filePath, component: comp, kind: 'missing_file', importPath, missingFileTarget });
			}
		}

		// ── Check for undeclared standalone function calls ─────────────────
		const declaredSymbols = new Set<string>(['React']);
		for (const name of importedSymbols.keys()) declaredSymbols.add(name);

		const funcDeclRe = /(?:function|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|:[^=]+=\s*)?(?:\(|=)/g;
		while ((m = funcDeclRe.exec(content)) !== null) declaredSymbols.add(m[1]!);

		const arrDestructRe = /(?:const|let|var)\s*\[\s*([A-Za-z0-9_$,\s]+)\s*\]/g;
		while ((m = arrDestructRe.exec(content)) !== null) {
			for (const part of m[1]!.split(',')) {
				const sym = part.trim();
				if (sym) declaredSymbols.add(sym);
			}
		}

		const objDestructRe = /(?:const|let|var)\s*\{\s*([A-Za-z0-9_$,\s:]+)\s*\}\s*=/g;
		while ((m = objDestructRe.exec(content)) !== null) {
			for (const part of m[1]!.split(',')) {
				const sym = part.trim().split(':')[0]?.trim();
				if (sym) declaredSymbols.add(sym);
			}
		}

		const cleanCode = content
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/.*/g, '')
			.replace(/'(?:\\.|[^'\\])*'/g, "''")
			.replace(/"(?:\\.|[^"\\])*"/g, '""');

		const callRe = /(?:^|[^.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
		const seenMissingFuncs = new Set<string>();
		while ((m = callRe.exec(cleanCode)) !== null) {
			const sym = m[1]!;
			if (JS_KEYWORDS.has(sym) || COMMON_BUILTINS.has(sym) || declaredSymbols.has(sym) || seenMissingFuncs.has(sym)) continue;
			seenMissingFuncs.add(sym);
			console.log(`[Validator] undeclared function call "${sym}()" in ${filePath}`);
			issues.push({ file: filePath, component: sym, kind: 'missing_function', functionName: sym });
		}
	}

	// ── Check 4: Orphan component detection ────────────────────────────────
	const allImportedPaths = new Set<string>();
	for (const { path: fp, content: fc } of generatedFiles) {
		const fDir = path.dirname(fp).replace(/\\/g, '/');
		const impMatchRe = /import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g;
		let im: RegExpExecArray | null;
		while ((im = impMatchRe.exec(fc)) !== null) {
			const rawPath = im[1]!;
			if (rawPath.startsWith('.')) {
				const normTarget = path.normalize(path.join(fDir, rawPath)).replace(/\\/g, '/');
				allImportedPaths.add(normTarget);
				for (const ext of RESOLVE_EXTS) allImportedPaths.add(normTarget + ext);
			}
		}
	}

	for (const { path: filePath } of generatedFiles) {
		const normFp = filePath.replace(/\\/g, '/');
		if (normFp.includes('/components/') && (normFp.endsWith('.tsx') || normFp.endsWith('.jsx'))) {
			const noExt = normFp.replace(/\.[^/.]+$/, '');
			const isImported = allImportedPaths.has(normFp) || allImportedPaths.has(noExt);
			if (!isImported) {
				console.log(`[Validator] orphan component detected: ${normFp} is never imported in App.tsx or parent components`);
				issues.push({
					file: filePath,
					component: path.basename(filePath, path.extname(filePath)),
					kind: 'orphan_file',
					missingFileTarget: filePath
				});
			}
		}
	}

	// ── Check 5: Prop contract & array mapping validation ──────────────────
	const fileMap = new Map<string, string>();
	for (const f of generatedFiles) {
		fileMap.set(f.path.replace(/\\/g, '/'), f.content);
	}

	for (const { path: parentPath, content: parentContent } of generatedFiles) {
		const pDir = path.dirname(parentPath).replace(/\\/g, '/');
		const compCallRe = /<([A-Z][A-Za-z0-9]*)\s+([^>]*?)(?:\/?>)/g;
		let cm: RegExpExecArray | null;
		while ((cm = compCallRe.exec(parentContent)) !== null) {
			const compName = cm[1]!;
			const rawPropsStr = cm[2]!;
			if (REACT_BUILTINS.has(compName)) continue;

			const passedPropMatches = rawPropsStr.matchAll(/([a-zA-Z_$][a-zA-Z0-9_$]*)(?:=|\s)/g);
			const passedProps = Array.from(passedPropMatches).map(p => p[1]!).filter(p => p !== 'key' && p !== 'className');
			if (passedProps.length === 0) continue;

			for (const ext of RESOLVE_EXTS) {
				const candidatePath = path.normalize(path.join(pDir, 'components', compName + ext)).replace(/\\/g, '/');
				const candidateDirect = path.normalize(path.join(pDir, compName + ext)).replace(/\\/g, '/');
				const targetPath = fileMap.has(candidatePath) ? candidatePath : fileMap.has(candidateDirect) ? candidateDirect : null;
				if (targetPath) {
					const childContent = fileMap.get(targetPath)!;
					for (const p of passedProps) {
						const hasProp = new RegExp(`\\b${p}\\b`).test(childContent);
						if (!hasProp) {
							console.log(`[Validator] prop mismatch: <${compName}> passed "${p}", but ${targetPath} does not declare it.`);
							issues.push({
								file: targetPath,
								component: compName,
								kind: 'prop_mismatch',
								functionName: p,
								missingFileTarget: targetPath
							});
						} else if (/^(?:habits|tasks|items|bookmarks|todos|transactions|rows|products|cards|records|elements)$/i.test(p)) {
							if (!childContent.includes('.map(') && !childContent.includes('.forEach(')) {
								console.log(`[Validator] missing array mapping: ${targetPath} receives array "${p}" but contains no .map()`);
								issues.push({
									file: targetPath,
									component: compName,
									kind: 'missing_map',
									functionName: p,
									missingFileTarget: targetPath
								});
							}
						}
					}
					break;
				}
			}
		}
	}

	if (issues.length === 0) console.log('[Validator] all JSX symbols OK');
	return issues;
}

export function buildNoOutputPrompt(mode: AgentMode): string {
const contract = `You did not output any file blocks. Your previous response could not be parsed.

Output EVERY file as a complete block using exactly this format:
<file path="src/Component.tsx">
...the complete file content...
</file>

Rules:
  - Every file MUST be wrapped in <file path="...">...</file>.
  - Do NOT wrap the code in markdown fences.
  - Do NOT add explanations, commentary, or prose before or after the blocks.
  - Emit the COMPLETE file, not a fragment.
  - Emit ALL requested files, not just the first one.`;

if (mode === 'edit') {
return `${contract}

<validation_errors>
No file blocks were found in your previous response. Re-emit the edited file(s) using the <file path="..."> format.
</validation_errors>`;
}

return `${contract}

<validation_errors>
No file blocks were found in your previous response. Re-emit ALL requested files using the <file path="..."> format.
</validation_errors>`;
}

export function buildJsxRepairPrompt(issues: JsxSymbolIssue[]): string {
	const byFile = new Map<string, JsxSymbolIssue[]>();
	for (const iss of issues) {
		if (!byFile.has(iss.file)) byFile.set(iss.file, []);
		byFile.get(iss.file)!.push(iss);
	}

	const missingFilesToGenerate = new Set<string>();

	const lines: string[] = [
		'<validation_errors>',
		'Frontend code validation failed with the following critical errors:',
		'',
	];
	for (const [file, fileIssues] of byFile) {
		lines.push(`File: ${file}`);
		for (const iss of fileIssues) {
			if (iss.kind === 'missing_import') {
				lines.push(`  - Component <${iss.component} /> used but NOT imported.`);
				lines.push(`    Fix: add  import ${iss.component} from "./${iss.component}";`);
			} else if (iss.kind === 'missing_file') {
				lines.push(`  - Component <${iss.component} /> was imported from "${iss.importPath}", but "${iss.missingFileTarget || iss.importPath}" was NEVER generated!`);
				if (iss.missingFileTarget) missingFilesToGenerate.add(iss.missingFileTarget);
			} else if (iss.kind === 'missing_function') {
				lines.push(`  - Function "${iss.functionName}()" is called, but it is NEVER declared, defined, or imported.`);
				lines.push(`    Fix: define "const ${iss.functionName} = ..." or import it.`);
			} else if (iss.kind === 'orphan_file') {
				lines.push(`  - Component file "${iss.file}" was generated, but it is NEVER imported or rendered anywhere.`);
				lines.push(`    Fix: import and render <${iss.component} /> in its parent container or src/App.tsx, or delete it.`);
			} else if (iss.kind === 'prop_mismatch') {
				lines.push(`  - Component <${iss.component} /> is passed prop "${iss.functionName}", but "${iss.file}" does NOT declare "${iss.functionName}" in its props interface.`);
				lines.push(`    Fix: update ${iss.file} props interface to accept "${iss.functionName}".`);
			} else if (iss.kind === 'missing_map') {
				lines.push(`  - Component <${iss.component} /> in "${iss.file}" receives array prop "${iss.functionName}", but does NOT map over it.`);
				lines.push(`    Fix: update ${iss.file} to map over "${iss.functionName}" (e.g. {${iss.functionName}.map(...)}) to render the child items.`);
			}
		}
		lines.push('');
	}

	lines.push('Requirements for resolution:');
	if (missingFilesToGenerate.size > 0) {
		lines.push(`  1. You MUST generate the following missing component file(s) right now:`);
		for (const mf of missingFilesToGenerate) {
			lines.push(`     <file path="${mf}">\n     // Complete working React implementation\n     </file>`);
		}
	}
	lines.push('  2. Ensure all referenced helper functions, props, and state variables are declared in the component where they are used.');
	lines.push('  3. Output ONLY the missing or corrected files as valid <file path="...">...</file> blocks.');
	lines.push('</validation_errors>');
	lines.push('');
	lines.push('[Validator] output the required files now.');
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
			// Import/require statements
			/^import\s+/.test(trimmed) ||
			/^from\s+['"]/.test(trimmed) ||
			/^const\s+\w+\s*=\s*require/.test(trimmed) ||
			// Export statements
			/^export\s+(default\s+)?/.test(trimmed) ||
			// Function/class/variable declarations
			/^(const|let|var|function|class|interface|type|enum)\s+/.test(trimmed) ||
			// JSX/HTML tags
			/^\s*<\/?[\w]+/.test(trimmed) ||
			/^\s*\/>/.test(trimmed) ||
			// CSS rules
			/^\s*[\w.-]+\s*\{/.test(trimmed) ||
			/^\s*[\w-]+\s*:.*[;{]/.test(trimmed) ||
			// Closing braces, parens
			/^[}\]);,]+$/.test(trimmed) ||
			// Return statements
			/^\s*return\s*[\s(]/.test(trimmed) ||
			// JSX attributes / className etc
			/^\s*(className|onClick|onChange|style|href|src|alt|type)=/.test(trimmed) ||
			// Arrow functions
			/=>\s*[{(]/.test(trimmed);

		if (isCode) {
			codeLines.push(line);
		} else {
			nonCodeLines.push(line);
		}
	}

	const totalNonEmpty = codeLines.length + nonCodeLines.length;
	if (totalNonEmpty < 3) return null;

	// If >60% of lines look like code, treat entire text as code
	const codeRatio = codeLines.length / totalNonEmpty;
	if (codeRatio >= 0.6) {
		// Strip any leading/trailing prose (e.g. "Here's the code:" or "I've created...")
		const allLines = text.split('\n');
		let startIdx = 0;
		let endIdx = allLines.length - 1;

		// Trim leading prose lines
		while (startIdx < allLines.length) {
			const l = allLines[startIdx]!.trim();
			if (!l || /^(import |export |const |let |var |function |class |<|\/\/|\/\*|\*|@|#|\{|\(|return )/.test(l)) break;
			startIdx++;
		}
		// Trim trailing prose lines
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
	model?: string;
}

export function streamEvent(res: Response, evt: PipelineEvent): void {
	if (evt.type === 'context_usage') {
		res.write(JSON.stringify({ type: 'context_usage', used: evt.used, total: evt.total, percent: evt.percent, model: evt.model }) + '\n');
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

	// 1. Suffix loop check — true loop means the TAIL of output is stuck repeating.
	// Use larger window (400 chars) and require matches to cluster at the end,
	// not simply appear anywhere in the window (catches import blocks with same identifier).
	const windowSizes = [30, 50]; // 20 removed — too short, matches identifiers like ", controller"
	for (const size of windowSizes) {
		const suffix = text.substring(text.length - size).trim();
		if (!suffix || suffix.length < size * 0.6) continue; // skip if suffix is mostly whitespace

		const recentText = text.substring(Math.max(0, text.length - 400));
		const allMatches: number[] = [];
		const escaped = escapeRegExp(suffix);
		const re = new RegExp(escaped, 'g');
		let m: RegExpExecArray | null;
		while ((m = re.exec(recentText)) !== null) {
			allMatches.push(m.index);
		}

		if (allMatches.length < 6) continue; // threshold raised: <6 matches is not a loop

		// Clustering check: a real loop has matches bunched at the end of the window.
		// If the last 3 matches are all in the final 60% of the window → loop confirmed.
		const windowLen = recentText.length;
		const tail3 = allMatches.slice(-3);
		const allInTail = tail3.every(idx => idx >= windowLen * 0.4);
		if (!allInTail) continue;

		// Distinctness check: In a genuine loop, the text between consecutive matches is identical
		// (e.g. repeating the exact same block). In legitimate repetitive code (like <Select.Item value="a">,
		// <Select.Item value="b">, <td className="...">, etc.), the segments between matches contain
		// different attributes and text. Require at least 3 consecutive identical inter-match segments.
		let consecutiveIdentical = 0;
		for (let i = 1; i < allMatches.length - 1; i++) {
			const segPrev = recentText.substring(allMatches[i - 1]!, allMatches[i]!);
			const segCurrent = recentText.substring(allMatches[i]!, allMatches[i + 1]!);
			if (segPrev === segCurrent && segCurrent.length >= suffix.length) {
				consecutiveIdentical++;
			}
		}
		if (consecutiveIdentical >= 3) {
			return { detected: true, reason: `Suffix loop: "${suffix}" repeated ${allMatches.length} times in recent output` };
		}
	}

	// 2. Line repetition check — same line must appear 4+ times in last 8 lines (was 3 in 6)
	const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	if (lines.length >= 8) {
		const lastLine = lines[lines.length - 1]!;
		if (lastLine.length > 15) { // must be a non-trivial line (raised from 10)
			let repeatCount = 0;
			for (let i = lines.length - 2; i >= Math.max(0, lines.length - 8); i--) {
				if (lines[i] === lastLine) repeatCount++;
			}
			if (repeatCount >= 4) {
				return { detected: true, reason: `Line repetition loop: "${lastLine}" repeated ${repeatCount + 1} times` };
			}
		}
	}

	// 3. Stagnation check — extremely limited character set
	if (text.length >= 200) {
		const recent = text.substring(text.length - 150);
		const uniqueChars = new Set(recent).size;
		if (uniqueChars < 5) {
			return { detected: true, reason: `Stagnation: only ${uniqueChars} unique characters in the last 150 characters` };
		}
	}

	// 4. File-block repetition check — same <file path="..."> tag 3+ times
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
