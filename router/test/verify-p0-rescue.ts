/**
 * Verifies P0.1 — the create-mode rescue path.
 *
 * Before the fix, Pattern 3 and Pattern 4 were gated on `mode !== 'create'`.
 * A create-mode response with raw code and no <file> tags was therefore
 * discarded entirely, and the run reported success with zero files.
 *
 * This drives the router's REAL helper functions (extractRawCode,
 * inferFilePath) and replicates the parser's control flow, then asserts
 * against the CURRENT source in src/index.ts so the test cannot drift
 * from the implementation.
 *
 * It asserts:
 *   1. In create mode, a raw unfenced code response IS rescued (P4).
 *   2. In create mode, a fenced code response IS rescued (P3).
 *   3. A <file> tagged response still wins (P0 precedence preserved).
 *   4. A PROSE-only response is still rejected (no false rescue).
 *   5. The guards are actually gone from src/index.ts.
 *
 * No LLM inference is performed.
 *
 * Run: node_modules/.bin/tsx scratch/verify-p0-rescue.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_ROOT = path.resolve(HERE, '..');   // .../crab-kode/router
const ROOT = path.resolve(HERE, '..', '..');    // .../crab-kode

let pass = 0, fail = 0;
const failures: string[] = [];

function check(name: string, fn: () => true | string): void {
	try {
		const r = fn();
		if (r === true) { pass++; console.log(`  PASS  ${name}`); }
		else { fail++; failures.push(`${name} -> ${r}`); console.log(`  FAIL  ${name} -> ${r}`); }
	} catch (e: any) {
		fail++; failures.push(`${name} -> threw: ${e.message}`);
		console.log(`  FAIL  ${name} -> threw: ${e.message}`);
	}
}

const { extractRawCode } = await import(pathToFileURL(path.join(ROUTER_ROOT, 'src', 'generation', 'pipelineHelpers.ts')).href);
const { inferFilePath } = await import(pathToFileURL(path.join(ROUTER_ROOT, 'src', 'tools', 'toolEngine.ts')).href);

interface Edit { path: string; content: string }

/**
 * Mirrors extractFallbackEdits' control flow in src/index.ts.
 * The P3/P4 branches are unconditional after the P0.1 fix; the source-level
 * assertions at the end prove that is still true.
 */
function parse(text: string, workspaceRoot: string, userPrompt: string): Edit[] {
	const edits: Edit[] = [];
	const seen = new Set<string>();

	// Pattern 0 — <file path="...">...</file>
	if (/<file\s+path=["'][^"']+["']\s*>/i.test(text)) {
		const openTagRegex = /<file\s+path=["']([^"']+)["']\s*>/gi;
		let m: RegExpExecArray | null;
		while ((m = openTagRegex.exec(text)) !== null) {
			const p = m[1]!.trim();
			const start = m.index + m[0].length;
			const close = text.substring(start).match(/<\/file>/i);
			const end = close ? start + close.index! : text.length;
			const content = text.substring(start, end).replace(/<\/file>\s*$/i, '').trim();
			if (p && content.length > 5 && !seen.has(p)) { seen.add(p); edits.push({ path: p, content }); }
		}
	}
	if (edits.length > 0) return edits;

	// Pattern 3 — fenced block (unconditional after P0.1)
	const p3f = /```(?:jsx|tsx|javascript|js|typescript|ts|css|html|vue|svelte|json|sh|bash)\r?\n([\s\S]+?)```/g;
	let m: RegExpExecArray | null;
	while ((m = p3f.exec(text)) !== null) {
		const code = m[1]!.trim();
		if (code.length > 30) {
			const p = inferFilePath(code, [], workspaceRoot, userPrompt);
			if (p && !seen.has(p)) { seen.add(p); edits.push({ path: p, content: code }); }
		}
	}

	// Pattern 4 — raw unfenced code (unconditional after P0.1)
	if (edits.length === 0 && workspaceRoot) {
		const code = extractRawCode(text);
		if (code && code.length > 30) {
			const p = inferFilePath(code, [], workspaceRoot, userPrompt);
			if (p) edits.push({ path: p, content: code });
		}
	}
	return edits;
}

// The real dashboard code the FE model produced: raw TSX, no <file> tags.
const RAW_TSX = `"use client";

import {
  Calendar,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileText,
  Globe,
  Loader3,
  Plus,
} from "lucide-react";
import Link from "next/link";
import React, { useEffect, useState } from "react";

export default function Dashboard() {
  const [tasks, setTasks] = useState([]);
  const [filter, setFilter] = useState("all");

  const toggleTask = (id: string) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-zinc-950">
      <aside className="w-64 border-r">
        <Link href="/dashboard">Dashboard</Link>
      </aside>
      <main>
        <canvas id="weeklyProductivityChart" className="rounded-xl shadow-md w-full h-48" />
      </main>
    </div>
  );
}
`;

const FENCED = "Here is the component:\n\n```tsx\n" + RAW_TSX + "\n```\n";
const TAGGED = `<file path="src/components/Card.tsx">
export const Card = () => <div className="p-4">hi</div>;
</file>
`;
// A pure-prose response — must NOT be rescued.
const PROSE = `To build a REST API backend in Express with TypeScript, we'll implement
the following components:

1. **Data Store**: An in-memory array to store user data.
2. **Service Layer**: Handles business logic (CRUD operations).
3. **Repository Layer**: Acts as an abstraction layer between the service and the repository.

This setup ensures that our API is robust, secure, and easy to maintain.
`;

// The workspace is only used to give inferFilePath() a project shape to
// look at (it checks for a `src/` directory to decide the path prefix).
// It lives OUTSIDE the repository so a test can never leave generated
// files in the repo.
const WS = path.join(process.env.CODECRAB_EVAL_DIR || 'D:/fedora backup/test', '.p0-ws');

console.log('\n=== 1. create mode rescues a raw, tagless code response ===');

const raw = parse(RAW_TSX, WS, 'Build a task management dashboard');

check('P4 rescues the raw TSX in create mode', () =>
	raw.length > 0 ? true : 'nothing was rescued — P0.1 is not effective');

check('the rescued path is a source file', () =>
	raw.length > 0 && /[\w.-]+\.(jsx|tsx)$/.test(raw[0]!.path)
		? true
		: `unexpected path: ${raw.map(e => e.path).join(', ')}`);

check('the rescued content keeps the real code (canvas chart)', () =>
	raw.length > 0 && raw[0]!.content.includes('weeklyProductivityChart')
		? true
		: 'the canvas chart is missing from the rescued content');

check('the rescued content keeps the lucide import', () =>
	raw.length > 0 && raw[0]!.content.includes('lucide-react')
		? true
		: 'the lucide import is missing from the rescued content');

check('the rescued content is substantial (>500 chars)', () =>
	raw.length > 0 && raw[0]!.content.length > 500
		? true
		: `only ${raw[0]?.content?.length ?? 0} chars`);

check('the rescued content keeps useState (it is real code, not a fragment)', () =>
	raw.length > 0 && raw[0]!.content.includes('useState')
		? true
		: 'useState is missing');

console.log('\n=== 2. create mode rescues a fenced code response ===');

const fenced = parse(FENCED, WS, 'Build a task management dashboard');

check('P3 rescues the fenced block in create mode', () =>
	fenced.length > 0 ? true : 'nothing was rescued');

check('the fenced rescue keeps the code', () =>
	fenced.length > 0 && fenced[0]!.content.includes('weeklyProductivityChart')
		? true
		: 'the fenced rescue lost the code');

console.log('\n=== 3. <file> tagged responses still take precedence ===');

const tagged = parse(TAGGED, WS, 'anything');

check('Pattern 0 still wins', () =>
	tagged.length === 1 && tagged[0]!.path === 'src/components/Card.tsx'
		? true
		: `got ${tagged.map(e => e.path).join(', ')}`);

console.log('\n=== 4. a prose-only response is NOT rescued ===');

const prose = parse(PROSE, WS, 'Build a REST API');

check('prose is rejected by the rescue path', () =>
	prose.length === 0
		? true
		: `prose was rescued as ${prose.map(e => e.path).join(', ')} — a false positive`);

console.log('\n=== 5. the guards are actually gone from src/index.ts ===');

const src = fs.readFileSync(path.join(ROUTER_ROOT, 'src', 'index.ts'), 'utf8');
const p3Idx = src.indexOf('// Pattern 3: Code fenced block');
const p4Idx = src.indexOf('// Pattern 4 (CRITICAL): Raw unfenced code detection');

check('both pattern blocks exist in the source', () =>
	p3Idx > 0 && p4Idx > p3Idx ? true : `p3=${p3Idx} p4=${p4Idx}`);

/**
 * Strip comments so a guard mentioned in prose (e.g. "previously gated on
 * `mode !== 'create'`") is not mistaken for a live guard.
 */
function stripComments(block: string): string {
	return block
		.split('\n')
		.map(l => {
			const t = l.trim();
			if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
			return l.replace(/\/\/.*$/, '');
		})
		.join('\n');
}

const p3Block = src.slice(p3Idx, p4Idx);
const p4Block = src.slice(p4Idx, p4Idx + 1500);
const p3Code = stripComments(p3Block);
const p4Code = stripComments(p4Block);

check("Pattern 3 has no live `mode !== 'create'` guard", () =>
	!p3Code.includes("mode !== 'create'") ? true : 'the P3 guard is still present in code');

check("Pattern 4 has no live `mode !== 'create'` guard", () =>
	!p4Code.includes("mode !== 'create'") ? true : 'the P4 guard is still present in code');

check('Pattern 3 still extracts via a fenced-block regex', () =>
	/p3f\s*=\s*\/```/.test(p3Block) ? true : 'the P3 regex is gone');

check('Pattern 4 still uses extractRawCode + inferFilePath', () =>
	p4Block.includes('extractRawCode(text)') && p4Block.includes('inferFilePath(code')
		? true
		: 'the P4 implementation changed');

check('Pattern 3 no longer requires an empty seenPaths (multi-file works)', () =>
	!p3Code.includes('!seenPaths.size') ? true : 'the `!seenPaths.size` restriction is back');

check('Pattern 4 is guarded by `edits.length === 0` (does not override P0)', () =>
	p4Code.includes('edits.length === 0') ? true : 'the P4 ordering guard is gone');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('P0.1 verified: create-mode responses are no longer discarded.');
