/**
 * verify-file-knowledge.ts — the router knows what is on disk before it routes.
 *
 * Measured before this phase: `[EMBED] 0 chunks retrieved` and
 * `[ASSEMBLER] 0 blocks selected`, on every request, because nothing had
 * collected the file facts. The assertions below are the property that
 * fixes it, on a real fixture workspace:
 *
 *   1. every source file appears once, with a hash, its loc, its role and
 *      the symbols and imports parsed out of it
 *   2. a query that names an existing file retrieves that file (hit-rate is
 *      a number, not a hope)
 *   3. the index is persisted, and a second run re-parses ONLY the file
 *      that changed — the incremental part is the whole point of keying by
 *      (path, contentHash)
 *
 * The fixture is written to a temp dir and removed afterwards.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
	buildFileKnowledge,
	extractImports,
	extractSymbols,
	hashContent,
	retrieveFromIndex,
} from '../src/rag/fileKnowledge.js';
import { getCachePath } from '../src/rag/cache.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, fn: () => true | string): void {
	let res: true | string;
	try {
		res = fn();
	} catch (err: any) {
		res = `threw: ${err?.message || err}`;
	}
	if (res === true) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		failures.push(`${name}: ${res}`);
		console.log(`  FAIL  ${name} -> ${res}`);
	}
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-fk-'));

const FIXTURE: Record<string, string> = {
	'src/App.tsx': [
		"import React from 'react';",
		"import { Button } from './components/Button';",
		'',
		'export function App() {',
		'\treturn <Button label="hi" />;',
		'}',
	].join('\n'),
	'src/components/Button.tsx': [
		"import { cx } from '../lib/utils';",
		'',
		'export interface ButtonProps { label: string }',
		'',
		'export function Button({ label }: ButtonProps) {',
		'\treturn <button className={cx(label)}>{label}</button>;',
		'}',
	].join('\n'),
	'src/lib/utils.ts': [
		'// small helpers',
		'',
		'export function cx(...parts: string[]) {',
		"\treturn parts.filter(Boolean).join(' ');",
		'}',
	].join('\n'),
	'server.ts': [
		"import express from 'express';",
		"import { users } from './routes/users';",
		'',
		'const app = express();',
		'app.get("/users", users);',
	].join('\n'),
	'routes/users.ts': [
		"import { db } from '../database/db';",
		'',
		'export function users(req: any, res: any) {',
		'\tres.json(db.all());',
		'}',
	].join('\n'),
};

for (const [relPath, content] of Object.entries(FIXTURE)) {
	const abs = path.join(root, relPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
}

console.log('=== parsing: facts come from the source, not from guesses ===');

check('symbols are declarations, not call sites', () => {
	const got = extractSymbols(FIXTURE['src/components/Button.tsx']!);
	return JSON.stringify(got) === JSON.stringify(['ButtonProps', 'Button']) ? true : JSON.stringify(got);
});

check('imports keep the specifier as written, including bare packages', () => {
	const got = extractImports(FIXTURE['server.ts']!);
	const want = ['express', './routes/users'];
	return JSON.stringify(got) === JSON.stringify(want) ? true : JSON.stringify(got);
});

check('the hash is content-addressed and stable', () => {
	const a = hashContent('export const x = 1;');
	const b = hashContent('export const x = 1;');
	const c = hashContent('export const x = 2;');
	return a === b && a !== c && a.length === 40 ? true : `${a} / ${b} / ${c}`;
});

console.log('\n=== the index: one entry per file, before routing ===');

const first = buildFileKnowledge(root, 'add a Button variant');

check('all five fixture files are indexed', () => {
	const got = first.knowledge.files.map((f) => f.path);
	const want = Object.keys(FIXTURE).map((p) => p.replace(/\\/g, '/')).sort();
	return JSON.stringify(got) === JSON.stringify(want) ? true : JSON.stringify(got);
});

check('every entry carries hash, loc, role, symbols and imports', () => {
	const bad = first.knowledge.files
		.filter((f) => !f.hash || f.hash.length !== 40 || f.loc < 1 || !f.role || !Array.isArray(f.symbols) || !Array.isArray(f.imports))
		.map((f) => f.path);
	if (bad.length) return `missing facts: ${bad.join(', ')}`;
	const noSymbols = first.knowledge.files.filter((f) => f.symbols.length === 0).map((f) => f.path);
	return noSymbols.length === 0 ? true : `no symbols parsed from: ${noSymbols.join(', ')}`;
});

check('roles are classified fe vs be', () => {
	const byPath = Object.fromEntries(first.knowledge.files.map((f) => [f.path, f.role]));
	if (byPath['src/App.tsx'] !== 'fe') return `App.tsx role=${byPath['src/App.tsx']}`;
	if (byPath['server.ts'] !== 'be') return `server.ts role=${byPath['server.ts']}`;
	return true;
});

check('the edge count matches the imports actually parsed', () => {
	const sum = first.knowledge.files.reduce((n, f) => n + f.imports.length, 0);
	return first.knowledge.edges === sum && sum >= 5 ? true : `edges=${first.knowledge.edges} sum=${sum}`;
});

check('fileCount agrees with the array it just built', () => {
	return first.knowledge.fileCount === first.knowledge.files.length
		? true
		: `fileCount=${first.knowledge.fileCount} files=${first.knowledge.files.length}`;
});

console.log('\n=== retrieval: a named file is found ===');

check('a query naming an existing file retrieves it first', () => {
	const got = first.knowledge.retrieved;
	const top = got[0];
	if (!top) return 'no chunks retrieved';
	if (top.path !== 'src/components/Button.tsx') return `top=${top.path}`;
	return top.score > 0 ? true : `score=${top.score}`;
});

check('a backend query retrieves the backend file', () => {
	const hit = retrieveFromIndex(first.knowledge.files, 'where are the express users routes');
	return hit.length > 0 && Boolean(hit[0]?.path.startsWith('routes/')) || hit.some((c) => c.path === 'routes/users.ts')
		? true
		: JSON.stringify(hit.map((c) => c.path));
});

check('a query with no signal retrieves nothing', () => {
	const hit = retrieveFromIndex(first.knowledge.files, 'a b c');
	return hit.length === 0 ? true : JSON.stringify(hit.map((c) => c.path));
});

console.log('\n=== incremental: only the changed file is re-parsed ===');

const second = buildFileKnowledge(root, 'add a Button variant');

check('an unchanged workspace re-parses nothing', () => {
	return second.reindexed.length === 0 && second.reused === 5
		? true
		: `reindexed=${JSON.stringify(second.reindexed)} reused=${second.reused}`;
});

check('the index is persisted for the next request', () => {
	const cachePath = getCachePath(root, 'file-knowledge.json');
	return fs.existsSync(cachePath) ? true : `missing ${cachePath}`;
});

// Edit exactly one file.
fs.writeFileSync(
	path.join(root, 'src/components/Button.tsx'),
	`${FIXTURE['src/components/Button.tsx']}\n\nexport function IconButton({ label }: ButtonProps) {\n\treturn <Button label={label} />;\n}\n`,
	'utf-8',
);

const third = buildFileKnowledge(root, 'add a Button variant');

check('one changed file re-indexes exactly one file', () => {
	return third.reindexed.length === 1 && third.reindexed[0] === 'src/components/Button.tsx'
		? true
		: `reindexed=${JSON.stringify(third.reindexed)}`;
});

check('the other four are reused, not re-parsed', () => {
	return third.reused === 4 ? true : `reused=${third.reused}`;
});

check('the edited file picks up its new symbol and hash', () => {
	const f = third.knowledge.files.find((x) => x.path === 'src/components/Button.tsx');
	if (!f) return 'file missing';
	if (!f.symbols.includes('IconButton')) return `symbols=${JSON.stringify(f.symbols)}`;
	const before = first.knowledge.files.find((x) => x.path === 'src/components/Button.tsx')!;
	return f.hash !== before.hash ? true : 'hash did not change';
});

check('fileCount is stable across the edit', () => {
	return third.knowledge.fileCount === 5 ? true : `fileCount=${third.knowledge.fileCount}`;
});

console.log('\n=== a missing workspace is empty, not a crash ===');

check('a nonexistent root returns an empty knowledge block', () => {
	const got = buildFileKnowledge(path.join(root, 'does-not-exist'), 'anything');
	return got.knowledge.fileCount === 0 && got.knowledge.retrieved.length === 0 && got.reindexed.length === 0
		? true
		: JSON.stringify(got.knowledge);
});

check('an empty query retrieves nothing rather than everything', () => {
	return retrieveFromIndex(third.knowledge.files, '').length === 0 ? true : 'retrieved on empty query';
});

// cleanup — fixture and its cache entry
try {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(path.dirname(getCachePath(root, 'file-knowledge.json')), { recursive: true, force: true });
} catch {}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
	console.log('\nFailures:');
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
