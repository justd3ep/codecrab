/**
 * Test the pre-commit guard end-to-end.
 *
 * THE MOST IMPORTANT TEST IN THIS FILE.
 *
 * A guard that has never been observed to BLOCK a commit is a guard that
 * might not work. This proves three things:
 *
 *   1. A commit that touches ONLY docs/plans does NOT run the suite and
 *      is NOT blocked.
 *   2. A commit that touches router/src/ DOES run the suite.
 *   3. A commit that touches router/src/ while the suite is RED is
 *      BLOCKED — and the staged change is left in the index, not committed.
 *
 * The third is the point of the whole exercise: a behaviour change that the
 * tests did not catch cannot be committed.
 *
 * SAFETY
 * This test must never be able to destroy the thing it tests. So it does
 * NOT:
 *   - stash your working tree
 *   - switch branches
 *   - run `git reset --hard`
 *
 * It commits on the current branch and then undoes the commit with
 * `git reset --mixed HEAD~1`, which restores the index without touching
 * the working tree. Your uncommitted work is never at risk.
 *
 * Run: tsx test/verify-guard.ts
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.resolve(HERE, '..');
const REPO = path.resolve(ROUTER, '..');

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

/** Remove a file, tolerating its absence. */
function safeUnlink(p: string): void {
	try {
		if (fs.existsSync(p)) fs.unlinkSync(p);
	} catch (e: any) {
		console.warn(`  WARNING: could not remove ${p}: ${e.message}`);
	}
}

const git = (args: string[], cwd = REPO): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8' });

/**
 * Undo a commit WITHOUT touching the working tree.
 *
 * `git reset --mixed HEAD~1` moves HEAD back and resets the index, but
 * leaves every file on disk exactly as it is. The user's uncommitted
 * work is untouched.
 *
 * The guard is important: this MUST only be called when a commit was
 * actually made. Calling it when the commit was BLOCKED would reset HEAD
 * to the PARENT of the user's real commit — silently moving their
 * history back one. That happened once during development; this check
 * is why it cannot happen again.
 */
function undoLastCommit(expectedHead: string): void {
	const current = git(['rev-parse', 'HEAD']).trim();
	if (current === expectedHead) {
		// Nothing was committed — the commit was blocked. Do NOT reset.
		return;
	}
	git(['reset', '--mixed', 'HEAD~1']);
}

console.log('\n=== 1. the guard is installed ===');

const hookPath = path.join(REPO, '.git', 'hooks', 'pre-commit');
check('the pre-commit hook exists', () =>
	fs.existsSync(hookPath) ? true : `${hookPath} does not exist`);

check('the hook is the codecrab guard', () => {
	if (!fs.existsSync(hookPath)) return 'no hook';
	return fs.readFileSync(hookPath, 'utf8').includes('codecrab-guard')
		? true : 'the hook is not the guard';
});

check('the hook is the CURRENT version', () => {
	if (!fs.existsSync(hookPath)) return 'no hook';
	const hook = fs.readFileSync(hookPath, 'utf8');
	// Compare the marker in the INSTALLER against the marker in the
	// INSTALLED hook. Hard-coding a version here would make this check
	// lie the moment the installer is bumped.
	const installer = fs.readFileSync(path.join(HERE, 'install-guard-hook.ts'), 'utf8');
	const m = installer.match(/const MARKER = '(codecrab-guard:v\d+)'/);
	if (!m) return 'could not find the version marker in the installer';
	return hook.includes(m[1]!)
		? true
		: `the hook is stale — the installer wants ${m[1]}, the hook does not have it. Reinstall it.`;
});

// The hook must be able to find the router. This is the exact check the
// hook makes, so a failure here is a failure there.
check('the hook can locate the router directory', () => {
	const candidates = [
		path.join(REPO, '.git', 'hooks', '..', '..', 'router'),
		path.join(REPO, 'router'),
	];
	for (const c of candidates) {
		if (fs.existsSync(path.join(c, 'package.json')) && fs.existsSync(path.join(c, 'test'))) {
			return true;
		}
	}
	return 'the hook would not find the router — it would skip the guard entirely';
});

// ── RECURSION GUARD ───────────────────────────────────────────────────
//
// This test COMMITS to the repo. The pre-commit hook runs `npm test`,
// which includes THIS test. Without this check:
//
//     guard test -> git commit -> hook -> npm test -> guard test -> ...
//
// It recursed until the runner's 300s timeout killed it.
//
// The hook sets CODECRAB_GUARD_ACTIVE=1, and Git sets GIT_INDEX_FILE.
// Both are inherited by the processes the hook spawns, so a guard test
// running inside a hook sees them.
const insideHook =
	process.env.CODECRAB_GUARD_ACTIVE === '1' ||
	process.env.GIT_INDEX_FILE !== undefined;

if (insideHook) {
	console.log('');
	console.log('  the pre-commit guard blocks a red suite   SKIPPED (inside a hook)');
	console.log('  (this test commits, and it is already running inside a commit)');
	console.log('');
	console.log('=== 0 passed, 0 failed ===');
	console.log('Guard self-test skipped: it is already running inside a git hook.');
	process.exit(0);
}

const originalHead = git(['rev-parse', 'HEAD']).trim();

// The file the test deliberately breaks, and its original content. Both
// are declared OUTSIDE the try so the finally block can restore it even
// if the test fails partway through.
const fixturePath = path.join(ROUTER, 'test', 'fixtures', 'truncated.json');
let victimOriginal: string | null = null;

try {
	console.log('\n=== 2. a docs-only commit SKIPS the suite ===');

	// A docs-only change.
	const docFile = path.join(REPO, 'GUARD_SELFTEST.md');
	fs.writeFileSync(docFile, '# guard self test\n');
	git(['add', 'GUARD_SELFTEST.md']);

	const docsCommit = spawnSync('git', ['commit', '-m', 'selftest: docs only'], {
		cwd: REPO, encoding: 'utf8',
	});
	const docsOut = (docsCommit.stdout ?? '') + (docsCommit.stderr ?? '');

	check('the docs-only commit succeeded', () =>
		docsCommit.status === 0 ? true : `exit ${docsCommit.status}: ${docsOut.slice(0, 300)}`);

	check('the docs-only commit did NOT run the suite', () =>
		!docsOut.includes('ALL GREEN') && !docsOut.includes('the staged changes touch')
			? true
			: 'the suite ran for a docs-only commit — that trains you to bypass the hook');

	undoLastCommit(originalHead);
	safeUnlink(docFile);

	console.log('\n=== 3. a source change RUNS the suite ===');

	// A change that touches the router's source.
	const probe = path.join(ROUTER, 'src', '__guard_probe.ts');
	fs.writeFileSync(probe, '// guard self-test probe\nexport const probe = 1;\n');
	git(['add', 'src/__guard_probe.ts'], ROUTER);

	const srcCommit = spawnSync('git', ['commit', '-m', 'selftest: source change'], {
		cwd: REPO, encoding: 'utf8',
	});
	const srcOut = (srcCommit.stdout ?? '') + (srcCommit.stderr ?? '');

	check('the suite RAN for a source change', () =>
		srcOut.includes('ALL GREEN') || srcOut.includes('the staged changes touch')
			? true
			: `the suite did not run — the guard is not watching router/src/\n${srcOut.slice(0, 400)}`);

	check('the source commit succeeded (the suite was green)', () =>
		srcCommit.status === 0
			? true
			: `exit ${srcCommit.status}\n${srcOut.slice(0, 600)}`);

	undoLastCommit(originalHead);
	safeUnlink(probe);

	console.log('\n=== 4. a source change is BLOCKED when the suite is red ===');

	// Break the suite FOR REAL.
	//
	// The first version appended a COMMENT to a test file, which broke
	// nothing — the suite stayed green, the commit went through, and
	// this test failed for entirely the wrong reason.
	//
	// Corrupting a fixture's recorded expectation makes the fixture
	// test fail on a real assertion.
	//
	// NOTE: use the OUTER fixturePath. An inner `const fixturePath`
	// shadows it, and the `finally` block — which restores the file —
	// would then target a different binding. The corrupted fixture
	// survived the test and left the suite red.
	victimOriginal = fs.readFileSync(fixturePath, 'utf8');
	const fixture = JSON.parse(victimOriginal);
	// Change an expected path so the extraction no longer matches.
	const first = fixture.expect.create[0];
	if (first) first.path = 'src/__deliberately_broken_path.tsx';
	fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), 'utf8');

	fs.writeFileSync(probe, '// guard self-test probe\nexport const probe = 1;\n');
	git(['add', 'src/__guard_probe.ts'], ROUTER);
	git(['add', 'test/fixtures/truncated.json'], ROUTER);

	const blockedCommit = spawnSync('git', ['commit', '-m', 'selftest: should be blocked'], {
		cwd: REPO, encoding: 'utf8',
	});
	const blockedOut = (blockedCommit.stdout ?? '') + (blockedCommit.stderr ?? '');

	check('the commit was BLOCKED', () =>
		blockedCommit.status !== 0 ? true : 'the commit went through — the guard did not block it');

	check('the failure message says the suite failed', () =>
		blockedOut.includes('codecrab-guard') && /FAILED|failed/.test(blockedOut)
			? true
			: `the output does not explain the failure:\n${blockedOut.slice(0, 500)}`);

	check('the blocked change is still STAGED (not lost)', () => {
		const staged = git(['diff', '--cached', '--name-only']);
		return staged.includes('src/__guard_probe.ts')
			? true : 'the staged change was lost';
	});

	// Restore: unstage, put the file back, remove the probe.
	git(['reset', '--mixed', 'HEAD']);
	fs.writeFileSync(fixturePath, victimOriginal!);
	safeUnlink(probe);

} finally {
	// ── always restore ────────────────────────────────────────────────
	// Unstage anything the test staged, and remove the test's files.
	// NEVER `reset --hard` and NEVER stash: the user's work must not
	// be at risk from a test.
	//
	// The victim file MUST be restored too. If the test failed between
	// breaking the suite and restoring it, the suite would stay red —
	// and the user would find a broken suite they never broke.
	if (fixturePath && victimOriginal) {
		try {
			fs.writeFileSync(fixturePath, victimOriginal);
		} catch (e: any) {
			console.warn(`  WARNING: could not restore ${fixturePath}: ${e.message}`);
		}
	}
	try {
		git(['reset', '--mixed', 'HEAD']);
	} catch (e: any) {
		console.warn(`  WARNING: could not unstage: ${e.message}`);
	}
	safeUnlink(path.join(REPO, 'GUARD_SELFTEST.md'));
	safeUnlink(path.join(ROUTER, 'src', '__guard_probe.ts'));
}

console.log('\n=== 5. the repo is back to where it was ===');

check('HEAD is unchanged', () =>
	git(['rev-parse', 'HEAD']).trim() === originalHead
		? true : `HEAD is ${git(['rev-parse', 'HEAD']).trim()}, expected ${originalHead}`);

check('the probe file is gone', () =>
	!fs.existsSync(path.join(ROUTER, 'src', '__guard_probe.ts')) ? true : 'the probe file was left behind');

check('the docs file is gone', () =>
	!fs.existsSync(path.join(REPO, 'GUARD_SELFTEST.md')) ? true : 'the docs file was left behind');

check('nothing is left staged', () => {
	const staged = git(['diff', '--cached', '--name-only']).trim();
	return staged === '' ? true : `still staged:\n${staged}`;
});

check('the suite is green again', () => {
	const r = spawnSync(process.execPath,
		[path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(HERE, 'run-tests.ts')],
		{ cwd: ROUTER, encoding: 'utf8' });
	return r.status === 0 ? true : 'the suite is still red';
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The guard is proven: it skips docs, runs on source, and blocks a red suite.');
