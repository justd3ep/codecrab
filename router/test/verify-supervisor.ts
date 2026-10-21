/**
 * Ad-hoc verification for the CodeCrab router supervisor.
 *
 * This repo has NO canonical test/lint command (no vitest/jest, no
 * "test" script in router/package.json), so this is AD-HOC verification,
 * not a green suite.
 *
 * What it proves, without running any LLM inference:
 *
 *   1. The supervisor's static contract holds
 *      (detached:true, no pipes, log via inherited fd, no shell).
 *   2. The compiled output matches the source.
 *   3. Behaviour: from a cold start the supervisor brings the router up,
 *      the parent exits cleanly on its own, and the router SURVIVES and
 *      keeps serving — checked from a separate process.
 *
 * The router boots the llama engine and loads the small CPU embedding model,
 * but no prompt is ever sent and no inference is performed.
 *
 * Run: node_modules/.bin/tsx scratch/verify-supervisor.ts
 */
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.resolve(HERE, '..');
const VSCODE = path.resolve(ROUTER, '..', 'vscode');
const SUP_SRC = path.join(VSCODE, 'src/vs/code/electron-main/codecrabRouterSupervisor.ts');
const SUP_JS = path.join(VSCODE, 'out/vs/code/electron-main/codecrabRouterSupervisor.js');
// A .cmd file cannot be spawned directly on Windows (EINVAL) without a shell,
// and we deliberately avoid a shell (paths here contain spaces). Spawn node
// with the tsx CLI entry point instead — the same approach the supervisor uses.
const TSX_CLI = path.join(ROUTER, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const NODE = process.execPath;
const ROUTER_URL = 'http://127.0.0.1:3141';

let pass = 0, fail = 0;
const failures: string[] = [];

async function check(name: string, fn: () => true | string | Promise<true | string>): Promise<void> {
	try {
		const r = await fn();
		if (r === true) { pass++; console.log(`  PASS  ${name}`); }
		else { fail++; failures.push(`${name} -> ${r}`); console.log(`  FAIL  ${name} -> ${r}`); }
	} catch (e: any) {
		fail++; failures.push(`${name} -> threw: ${e.message}`);
		console.log(`  FAIL  ${name} -> threw: ${e.message}`);
	}
}

function probe(timeoutMs = 2000): Promise<boolean> {
	return new Promise(resolve => {
		const req = http.get(`${ROUTER_URL}/health`, { timeout: timeoutMs }, res => {
			res.resume();
			resolve(true);
		});
		req.on('error', () => resolve(false));
		req.on('timeout', () => { req.destroy(); resolve(false); });
	});
}

function health(): Promise<any | null> {
	return new Promise(resolve => {
		const req = http.get(`${ROUTER_URL}/health`, { timeout: 5000 }, res => {
			let b = '';
			res.on('data', c => (b += c));
			res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
		});
		req.on('error', () => resolve(null));
		req.on('timeout', () => { req.destroy(); resolve(null); });
	});
}

function killRouter(): void {
	try {
		const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
		const pids = new Set(
			out.split('\n')
				.filter(l => l.includes(':3141') && l.includes('LISTENING'))
				.map(l => l.trim().split(/\s+/).pop()!)
		);
		for (const pid of pids) {
			try { execFileSync('taskkill', ['/F', '/PID', pid, '/T'], { stdio: 'ignore' }); } catch { /* gone */ }
		}
		if (pids.size) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
	} catch { /* nothing running */ }
}

const src = fs.readFileSync(SUP_SRC, 'utf8');

console.log('\n=== 1. static contract ===');

await check('detached: true on every platform (Windows job-object kill)', () =>
	src.includes('detached: true') ? true : 'detached:true missing — a non-detached child dies with the parent on Windows');

await check('no pipes: stdio is an inherited fd or /dev/null', () =>
	/logFd !== null[\s\S]{0,80}\['ignore', logFd, logFd\]/.test(src)
		? true
		: 'stdio does not use the inherited log fd');

await check('shell: false (argv array keeps paths-with-spaces intact)', () =>
	src.includes('shell: false') ? true : 'shell:false missing');

await check('the tsx CLI is spawned via node, not via a .cmd shell wrapper', () =>
	src.includes('process.execPath') && src.includes('cli.mjs')
		? true
		: 'tsx is not spawned through node');

await check('the child handle is unref\'d so the editor can exit cleanly', () =>
	/child\.unref\(\)/.test(src) ? true : 'child.unref() missing');

// The hang timeout must be LONGER than the supervisor's boot timeout.
//
// The router loads a 5.75GB GGUF off disk before it starts listening.
// On a warm page cache that is ~5s; on a cold one it can take
// minutes. The supervisor waits BOOT_TIMEOUT_MS for /health to
// answer — so if this test gives up at the SAME moment, a slow boot
// is reported as "the parent HUNG".
//
// This test failed once at 183s for exactly that reason.
await check('this test\'s hang timeout is longer than the supervisor\'s boot timeout', () => {
	const boot = src.match(/BOOT_TIMEOUT_MS\s*=\s*([\d_]+)/);
	if (!boot) return 'the supervisor\'s BOOT_TIMEOUT_MS was not found';
	const bootMs = Number(boot[1]!.replace(/_/g, ''));
	// The test's own hang timeout.
	const self = fs.readFileSync(path.join(HERE, 'verify-supervisor.ts'), 'utf8');
	const mine = self.match(/setTimeout\(\(\)\s*=>\s*\{\s*hung = true; resolve\(\); \},\s*([\d_]+)\)/);
	if (!mine) return 'the test\'s hang timeout was not found';
	const myMs = Number(mine[1]!.replace(/_/g, ''));
	return myMs > bootMs
		? true
		: `the test gives up after ${myMs}ms and the supervisor after ${bootMs}ms — a slow boot is reported as a hang`;
});

console.log('\n=== 2. compiled output matches source ===');

await check('compiled supervisor exists', () =>
	fs.existsSync(SUP_JS) ? true : 'run the vscode transpile first');

await check('compiled output has detached: true', () => {
	if (!fs.existsSync(SUP_JS)) return 'not compiled';
	return fs.readFileSync(SUP_JS, 'utf8').includes('detached: true')
		? true
		: 'compiled output lacks detached:true';
});

await check('compiled module loads and exports its API', () => {
	if (!fs.existsSync(SUP_JS)) return 'not compiled';
	const out = execFileSync(process.execPath,
		['-e', `import('${pathToFileURL(SUP_JS).href}').then(m=>console.log(Object.keys(m).sort().join(',')))`],
		{ cwd: VSCODE, encoding: 'utf8' }).trim();
	const want = ['ensureRouterRunning', 'findRouterDir'];
	const got = out.split(',');
	return want.every(w => got.includes(w)) ? true : `exports ${out}`;
});

console.log('\n=== 3. behaviour: cold start → parent exits → router survives ===');

killRouter();
const wasUp = await probe();
console.log(`      (router before test: ${wasUp ? 'up' : 'down'})`);

await check('port 3141 is free before the test', () =>
	wasUp ? 'router was still running — could not test cold start' : true);

const { ensureRouterRunning } = await import(pathToFileURL(SUP_SRC).href);

// Spawn a short-lived parent that calls the supervisor and then exits on
// its own. If the child handle were still referenced, Node would hang.
const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-verify-sup-'));
try {
	fs.writeFileSync(path.join(parentDir, 'package.json'),
		JSON.stringify({ name: 'v', private: true, type: 'module' }));
	const parentTs = path.join(parentDir, 'parent.ts');
	fs.writeFileSync(parentTs, [
		`import { ensureRouterRunning } from '${pathToFileURL(SUP_SRC).href}';`,
		`const up = await ensureRouterRunning(${JSON.stringify(VSCODE)}, ${JSON.stringify(ROUTER_URL)}, {`,
		`  info: () => {}, warn: () => {}, error: () => {},`,
		`});`,
		`console.log('RESULT ' + up);`,
	].join('\n'));

	let parentOut = '';
	let parentRc: number | null = null;
	let hung = false;
	const parent = spawn(NODE, [TSX_CLI, parentTs], { cwd: ROUTER, stdio: ['ignore', 'pipe', 'pipe'] });
	parent.stdout.on('data', c => (parentOut += c));
	parent.stderr.on('data', c => (parentOut += c));
	await new Promise<void>(resolve => {
		// The hang timeout must be LONGER than the supervisor's own
		// BOOT_TIMEOUT_MS (180_000ms), or a slow boot is reported as a
		// hang.
		//
		// The router loads a 5.75GB GGUF off disk before it starts
		// listening. On a warm page cache that is ~5s; on a cold one
		// it can take minutes. The supervisor waits 180s for the
		// router to answer /health — so the test must wait LONGER
		// than that before calling it a hang.
		//
		// This test failed once at 183s with "the parent HUNG": the
		// boot was simply slow, and the test gave up at exactly the
		// moment the supervisor did.
		const t = setTimeout(() => { hung = true; resolve(); }, 300_000);
		parent.on('exit', code => { parentRc = code; clearTimeout(t); resolve(); });
	});

	console.log(`      parent exit code: ${parentRc} (hung: ${hung})`);

	await check('the parent exits on its own — the child handle is not referenced', () =>
		!hung && parentRc === 0
			? true
			: hung
				? 'parent HUNG — child handle still referenced'
				: `parent exited ${parentRc}`);

	await check('the supervisor reported success', () =>
		parentOut.includes('RESULT true') ? true : `no RESULT true; output: ${parentOut.slice(-300)}`);

	await check('the router is serving after the parent exited', async () => {
		const up = await probe();
		return up ? true : 'router not answering /health';
	});

	const h = await health();
	await check('the health payload has the corrected shape', () =>
		!h
			? 'no health payload'
			: h.router === 'ok' && h.ollama === 'connected' && !!h.context
				&& h.models.every((m: any) => ['frontend', 'backend', 'general', 'security', 'database', 'devops'].includes(m.domain))
				? true
				: `shape wrong: ${JSON.stringify(h).slice(0, 300)}`);

	await check('the router log was written through the inherited fd', () => {
		const log = path.join(ROUTER, '.crabcode', 'router.log');
		if (!fs.existsSync(log)) return 'router.log missing';
		return fs.readFileSync(log, 'utf8').includes('router started') ? true : 'no start marker';
	});
} finally {
	// Always clean up the temp parent, even if a check throws.
	try { fs.rmSync(parentDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

killRouter();

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('AD-HOC verification complete (no canonical suite exists in this repo).');
