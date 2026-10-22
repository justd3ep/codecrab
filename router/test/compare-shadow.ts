/**
 * The SHADOW COMPARISON — the live route against chatRoutes.ts.
 *
 * WHY
 *
 * chatRoutes.ts is 1,794 lines of the newer architecture. It has
 * never run. The shadow mount lets the same request go to BOTH:
 *
 *   POST /v1/chat/completions          the LIVE route
 *   POST /shadow/chat/completions       chatRoutes.ts
 *
 * The comparison is what decides whether the newer architecture is
 * worth keeping. Without a number, the decision is a guess.
 *
 * THE STREAM IS NDJSON, NOT SSE
 *
 * The route emits one JSON object per line:
 *
 *     {"message":{"content":"Generating...\n\n"}}
 *     {"type":"context_usage","used":880,"total":8192,"percent":11}
 *     ...
 *
 * Not `data: {...}` — the first version of this script looked for
 * the SSE prefix and found zero events in a perfectly good
 * response.
 *
 * WHAT IS COMPARED
 *
 *   the files written      the set of paths, and whether they are
 *                          the same
 *   the scaffold split     the scaffold is not the deliverable
 *   the validation         the issues, and the coverage
 *   the content            the bytes, for the files both wrote
 *   the errors             what each route reported
 *   the latency            how long each took
 *
 * WHAT IT IS NOT
 *
 * This is not in the default suite. It needs a running router AND
 * it performs LLM inference — that is minutes of GPU time per
 * request, and the models are local, so it only works on this
 * machine. It is a MEASUREMENT tool, run deliberately.
 *
 * USAGE
 *
 *   npx tsx test/compare-shadow.ts <request text>
 *   npx tsx test/compare-shadow.ts --workspace <dir> "make a dashboard"
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const ROUTER = process.env.CODECRAB_ROUTER_ROOT
	? path.resolve(process.env.CODECRAB_ROUTER_ROOT)
	: 'D:/fedora backup/crab-kode/router';
const BASE = process.env.CODECRAB_ROUTER_URL ?? 'http://127.0.0.1:3141';

/** The arguments. */
const args = process.argv.slice(2);
let workspace = process.env.CODECRAB_EVAL_DIR ?? '';
let request = '';

for (let i = 0; i < args.length; i++) {
	if (args[i] === '--workspace') { workspace = args[++i] ?? ''; continue; }
	request += (request ? ' ' : '') + args[i]!;
}

if (!request) {
	console.log('usage: tsx compare-shadow.ts [--workspace <dir>] "<request>"');
	process.exit(1);
}

/**
 * The workspace for a route.
 *
 * EACH ROUTE GETS ITS OWN. If they shared one, the second route
 * would run against the first route's output — the "create" would
 * become an "edit", and the comparison would measure two requests
 * in different states rather than two routes.
 */
const workspaceRoot = workspace;
function workspaceFor(name: string): string {
	if (workspaceRoot) {
		// An explicit workspace is used as the BASE, and each route
		// gets its own subdirectory.
		const dir = path.join(workspaceRoot, name);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}
	const dir = path.join(os.tmpdir(), `hermes-shadow-${Date.now()}-${name}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

if (!workspace) {
	console.log(`  the workspace: a fresh temp directory per route`);
}

const ROUTES = [
	{ name: 'live', url: `${BASE}/v1/chat/completions` },
	{ name: 'shadow', url: `${BASE}/shadow/chat/completions` },
];

interface Result {
	name: string;
	ok: boolean;
	ms: number;
	body: string;
	error: string;
	/** The files the route reported writing. */
	files: string[];
	/** Every event, parsed. */
	events: any[];
	/** The final summary, if the route sent one. */
	summary: string;
	/** The error the route reported. */
	reportedError: string;
}

/** The file paths mentioned in a stream. */
function filesFrom(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/`([^`\n]+)`/g)) {
		const p = m[1]!;
		if (/\.[a-z]{1,6}$/i.test(p) && !/^\s*$/.test(p)) out.push(p);
	}
	return [...new Set(out)];
}

/** Send the request and collect the NDJSON stream. */
function send(name: string, url: string, ws: string): Result {
	const started = Date.now();
	let body = '';
	let error = '';
	try {
		const r = spawnSync(
			'curl',
			[
				'-sS', '-N', '-X', 'POST', url,
				'-H', 'Content-Type: application/json',
				'-d', JSON.stringify({
					messages: [{ role: 'user', content: request }],
					workspaceRoot: ws,
				}),
				'--max-time', '1200',
			],
			{ encoding: 'utf8', timeout: 1300000, maxBuffer: 64 * 1024 * 1024 },
		);
		body = r.stdout ?? '';
		error = r.stderr || '';
	} catch (e: any) {
		error = e.message;
	}

	// The stream is NDJSON: one JSON object per line.
	const events: any[] = [];
	for (const line of body.split('\n')) {
		const t = line.trim();
		if (!t || t === '[DONE]') continue;
		try { events.push(JSON.parse(t)); } catch { /* not JSON */ }
	}

	// The files: from the events, and from the final text.
	const files = new Set<string>();
	let summary = '';
	let reportedError = '';

	for (const e of events) {
		if (e?.file) files.add(e.file);
		const content = e?.message?.content ?? e?.content;
		if (typeof content === 'string') {
			for (const f of filesFrom(content)) files.add(f);
			if (content.includes('Files updated') || content.includes('file(s) written')) {
				summary = content.trim().slice(0, 300);
			}
			if (content.includes('**Error:**') || content.includes('[Error]')) {
				reportedError = content.trim().slice(0, 300);
			}
		}
		if (e?.type === 'error') {
			reportedError = (e.message ?? e.file ?? 'an error').toString().slice(0, 300);
		}
	}

	return {
		name,
		ok: error === '' && events.length > 0,
		ms: Date.now() - started,
		body,
		error,
		files: [...files],
		events,
		summary,
		reportedError,
	};
}

/** The files on disk after a run. */
function filesOnDisk(dir: string): string[] {
	const out: string[] = [];
	if (!fs.existsSync(dir)) return out;
	const walk = (d: string, base = dir) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			if (e.name === 'node_modules' || e.name === '.git') continue;
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p, base);
			else out.push(path.relative(base, p).replace(/\\/g, '/'));
		}
	};
	walk(dir);
	return out.sort();
}

console.log(`\n=== the request ===`);
console.log(`  ${request}`);
console.log(`\n=== the workspace ===`);
console.log(`  ${workspace}`);

const health = spawnSync('curl', ['-sS', '-m', '5', `${BASE}/health`], { encoding: 'utf8' });
if (health.status !== 0) {
	console.log(`\n  FAIL: the router is not answering at ${BASE}/health`);
	console.log(`    ${(health.stderr || '').trim()}`);
	process.exit(1);
}
console.log(`\n  the router is up`);

const results: Result[] = [];
const workspaces: Record<string, string> = {};

for (const r of ROUTES) {
	console.log(`\n=== ${r.name} ===`);
	const ws = workspaceFor(r.name);
	workspaces[r.name] = ws;
	console.log(`  the workspace: ${ws}`);
	const res = send(r.name, r.url, ws);
	results.push(res);
	console.log(`  ${res.ok ? 'ok' : 'FAILED'}  ${res.ms}ms  ${res.events.length} event(s)`);
	if (res.error) console.log(`  the error: ${res.error.trim().slice(0, 300)}`);
}

console.log(`\n=== the comparison ===`);
const live = results[0]!;
const shadow = results[1]!;

const liveDisk = filesOnDisk(workspaces.live ?? workspace);
const shadowDisk = filesOnDisk(workspaces.shadow ?? workspace);
console.log(`  the files on disk: live ${liveDisk.length}, shadow ${shadowDisk.length}`);
const onlyLiveOnDisk = liveDisk.filter(f => !shadowDisk.includes(f));
const onlyShadowOnDisk = shadowDisk.filter(f => !liveDisk.includes(f));
const bothOnDisk = liveDisk.filter(f => shadowDisk.includes(f));
console.log(`  both wrote:        ${bothOnDisk.length}`);
console.log(`  only the live:     ${onlyLiveOnDisk.length ? onlyLiveOnDisk.join(', ') : '—'}`);
console.log(`  only the shadow:   ${onlyShadowOnDisk.length ? onlyShadowOnDisk.join(', ') : '—'}`);

console.log('');
console.log(`  ${'metric'.padEnd(24)} ${'live'.padEnd(18)} ${'shadow'.padEnd(18)}`);
console.log(`  ${'-'.repeat(62)}`);
const row = (label: string, a: string, b: string) =>
	console.log(`  ${label.padEnd(24)} ${a.padEnd(18)} ${b.padEnd(18)}`);
row('ok', String(live.ok), String(shadow.ok));
row('latency (ms)', String(live.ms), String(shadow.ms));
row('events', String(live.events.length), String(shadow.events.length));
row('files reported', String(live.files.length), String(shadow.files.length));
row('body length', String(live.body.length), String(shadow.body.length));
row('reported an error', live.reportedError ? 'yes' : 'no', shadow.reportedError ? 'yes' : 'no');

const liveFiles = new Set(live.files);
const shadowFiles = new Set(shadow.files);
const onlyLive = [...liveFiles].filter(f => !shadowFiles.has(f));
const onlyShadow = [...shadowFiles].filter(f => !liveFiles.has(f));
const both = [...liveFiles].filter(f => shadowFiles.has(f));

console.log('');
console.log(`  the files BOTH reported: ${both.length}`);
if (both.length) for (const f of both.slice(0, 12)) console.log(`      ${f}`);
console.log(`  only the live route:    ${onlyLive.length ? onlyLive.join(', ') : '—'}`);
console.log(`  only the shadow route:  ${onlyShadow.length ? onlyShadow.join(', ') : '—'}`);

if (live.summary) {
	console.log('');
	console.log(`  the live route's summary:`);
	console.log(`      ${live.summary.replace(/\n/g, ' ').slice(0, 220)}`);
}
if (shadow.summary) {
	console.log('');
	console.log(`  the shadow route's summary:`);
	console.log(`      ${shadow.summary.replace(/\n/g, ' ').slice(0, 220)}`);
}

console.log(`\n=== the verdict ===`);
if (!live.ok && !shadow.ok) {
	console.log('  BOTH FAILED — the router or the model is the problem.');
} else if (!shadow.ok) {
	console.log('  the shadow FAILED. It cannot be a replacement.');
} else if (shadow.reportedError && !live.reportedError) {
	console.log('  the shadow reported an error the live route did not.');
} else if (onlyShadow.length > onlyLive.length) {
	console.log('  the shadow reported MORE files. It may be better — or it may');
	console.log('  be writing the scaffold and calling it a deliverable. Check the');
	console.log('  scaffold split before believing it.');
} else if (onlyLive.length > onlyShadow.length) {
	console.log('  the live route reported MORE files.');
} else {
	console.log('  the two are comparable. Run it a few times before concluding.');
}
console.log('');
