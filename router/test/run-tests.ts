/**
 * The test runner.
 *
 * The router has no canonical test suite. Every check lives in
 * router/test/ as a script, and each prints a line like
 * "=== 43 passed, 0 failed ===" and exits non-zero on failure.
 *
 * This script runs all of them and aggregates the result. It is the
 * single gate every commit must pass.
 *
 *   npm test    run everything
 *
 * Scripts that need a running router or the network are EXCLUDED and
 * listed in EXCLUDED with the reason. They are not silently skipped.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.resolve(HERE, '..');
// The test scripts live in router/test/. They are CODE, not findings —
// they are committed so the safety net travels with the router.
const TESTDIR = path.join(ROUTER, 'test');

/**
 * The scripts that make up the suite. Every one of these must pass.
 *
 * They are listed explicitly rather than globbed, so that adding a new
 * script is a deliberate act: a new check that nobody wired into the
 * suite is a check that never runs.
 */
const SUITE: Array<{ file: string; what: string }> = [
	{ file: 'verify-phase0.ts',       what: 'Phase 0 — truthful failure and output recovery' },
	{ file: 'verify-phase1.ts',       what: 'Phase 1 — the router is safe to run' },
	{ file: 'verify-p0-rescue.ts',    what: 'P0.1 — the create-mode rescue path' },
	{ file: 'verify-p0-validator.ts', what: 'P0.6 — the undefined_symbol false positives' },
	{ file: 'verify-p1-advisor.ts',   what: 'P1.4 — the Advisor survives truncated JSON' },
	{ file: 'verify-roadmap-refs.ts', what: 'the roadmap doc matches the source' },
	{ file: 'verify-supervisor.ts',   what: 'the editor↔router supervisor lifecycle' },
	{ file: 'check-undefined-symbol.ts', what: 'the undefined-symbol scanner analysis' },
	{ file: 'check-chaining-defect.ts',  what: 'the chained-call analysis' },
	{ file: 'verify-golden-fixtures.ts', what: 'the golden fixtures — the whole extraction path' },
	// The guard self-test COMMITS to the repo and takes ~80s. It is NOT
	// in the default suite for two reasons:
	//   1. It is a diagnostic, not a regression test — it proves the hook
	//      is installed and working, which changes rarely.
	//   2. It commits, so running it inside a hook would recurse, and
	//      running it in the suite would make every commit take 80s.
	//
	// Run it explicitly:  tsx test/verify-guard.ts
];

/**
 * Scripts that are NOT part of the suite, and why.
 *
 * A script is excluded only if it needs something the suite cannot
 * provide (a running router, the network, a live model). Excluded
 * scripts are reported on every run, so they never quietly rot.
 */
const EXCLUDED: Array<{ file: string; why: string }> = [
	{ file: 'live-check-dashboard.ts', why: 'needs a running router AND performs LLM inference' },
	{ file: 'repro-dashboard.ts',      why: 'performs LLM inference' },
	{ file: 'be-probe.ts',             why: 'performs LLM inference' },
	{ file: 'send.ts',                 why: 'sends a live request to a running router' },
	{ file: 'test-supervisor.ts',      why: 'spawns the editor build' },
	{ file: 'stackcontract.check.ts',  why: 'one-off analysis, superseded by verify-phase1' },
	{ file: 'stackprofile.check.ts',   why: 'one-off analysis, superseded by verify-phase1' },
];

interface Result {
	file: string;
	what: string;
	passed: number;
	failed: number;
	ok: boolean;
	durationMs: number;
	error?: string;
}

function runScript(file: string): Promise<{ passed: number; failed: number; ok: boolean; error?: string }> {
	return new Promise(resolve => {
		const proc = spawn(
			process.execPath,
			[path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(TESTDIR, file)],
			{ cwd: ROUTER, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
		);
		let out = '';
		let err = '';
		proc.stdout.on('data', d => { out += d.toString(); });
		proc.stderr.on('data', d => { err += d.toString(); });
		const timer = setTimeout(() => { proc.kill(); }, 300000);
		proc.on('close', code => {
			clearTimeout(timer);
			const m = out.match(/(\d+)\s+passed,\s*(\d+)\s+failed/);
			if (!m) {
				resolve({
					passed: 0, failed: 0, ok: false,
					error: `no "N passed, M failed" summary was printed (exit ${code})\n` +
						`  stderr: ${err.split('\n').filter(l => l.trim()).slice(0, 6).join('\n  ')}\n` +
						`  stdout tail: ${out.split('\n').filter(l => l.trim()).slice(-6).join('\n  ')}`,
				});
				return;
			}
			resolve({
				passed: Number(m[1]), failed: Number(m[2]),
				ok: code === 0 && Number(m[2]) === 0,
			});
		});
		proc.on('error', e => {
			clearTimeout(timer);
			resolve({ passed: 0, failed: 0, ok: false, error: e.message });
		});
	});
}

async function main() {
	console.log('='.repeat(72));
	console.log('  CodeCrab router — test suite');
	console.log('='.repeat(72));
	console.log('');

	// A missing script is a hard error: the suite must not silently shrink.
	const missing: string[] = [];
	for (const s of SUITE) {
		if (!fs.existsSync(path.join(TESTDIR, s.file))) missing.push(s.file);
	}
	if (missing.length > 0) {
		console.error('FATAL: these suite scripts do not exist:');
		missing.forEach(m => console.error('  - ' + m));
		console.error('\nThe suite cannot shrink silently. Restore them or update the list.');
		process.exit(2);
	}

	const results: Result[] = [];
	let totalPassed = 0;
	let totalFailed = 0;

	for (const s of SUITE) {
		process.stdout.write(`  ${s.what.padEnd(52)}`);
		const t0 = Date.now();
		const r = await runScript(s.file);
		const dur = Date.now() - t0;
		totalPassed += r.passed;
		totalFailed += r.failed;
		results.push({ file: s.file, what: s.what, ...r, durationMs: dur });

		if (r.ok) {
			console.log(`  ${String(r.passed).padStart(3)} passed  (${dur}ms)`);
		} else {
			console.log(`  ${r.failed > 0 ? `${r.failed} FAILED` : 'ERROR'}  (${dur}ms)`);
			if (r.error) {
				console.log('');
				r.error.split('\n').forEach(l => console.log('      ' + l));
				console.log('');
			}
		}
	}

	console.log('');
	console.log('-'.repeat(72));
	if (EXCLUDED.length) {
		console.log('  Not in the suite (need a live router / LLM inference):');
		for (const e of EXCLUDED) {
			// The excluded scripts live in scratch/ — they are probes, not
		// tests, and they are not committed.
		const exists =
			fs.existsSync(path.join(TESTDIR, e.file)) ||
			fs.existsSync(path.join(ROUTER, 'scratch', e.file));
			console.log(`    ${exists ? '·' : '?'} ${e.file.padEnd(28)} ${e.why}`);
		}
		console.log('');
	}
	console.log('-'.repeat(72));

	const broken = results.filter(r => !r.ok);
	if (broken.length === 0) {
		console.log(`  ALL GREEN — ${totalPassed} assertions passed across ${results.length} scripts`);
		console.log('-'.repeat(72));
		process.exit(0);
	} else {
		console.log(`  ${broken.length} script(s) FAILED — ${totalPassed} passed, ${totalFailed} failed`);
		for (const b of broken) console.log(`    - ${b.file}`);
		console.log('-'.repeat(72));
		process.exit(1);
	}
}

main();
