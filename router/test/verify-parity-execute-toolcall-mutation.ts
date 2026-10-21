/**
 * MUTATION CHECK for the executeToolCall parity test.
 *
 * A test that has never been observed to FAIL is not evidence.
 *
 * This deliberately breaks the scaffold guard in five different ways
 * and confirms the parity test catches each one.
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

const GUARD = path.join(ROUTER, 'src', 'tools', 'scaffoldGuard.ts');
const TOOL = path.join(ROUTER, 'src', 'tools', 'toolEngine.ts');
const PARITY = path.join(ROUTER, 'test', 'verify-parity-execute-toolcall.ts');

const guardOriginal = fs.readFileSync(GUARD, 'utf8');
const toolOriginal = fs.readFileSync(TOOL, 'utf8');

/**
 * Clear tsx's transpile cache.
 *
 * tsx caches the transpiled output of each file. A mutation writes a
 * broken module to the SAME path, and the cache can serve the stale
 * transpile — so the mutation is on disk but invisible to the import.
 * Clearing the cache before each run makes the mutation observable.
 */
function clearTsxCache(): void {
	const tmp = os.tmpdir();
	for (const entry of fs.readdirSync(tmp)) {
		if (!/^tsx-|^esbuild-|^node-compile-cache/i.test(entry)) continue;
		const p = path.join(tmp, entry);
		try {
			if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
		} catch {
			/* the cache is best-effort */
		}
	}
}

function runParity(): { status: number | null; out: string } {
	clearTsxCache();
	const r = spawnSync(
		process.execPath,
		[path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), PARITY],
		{ cwd: ROUTER, encoding: 'utf8', timeout: 120000 },
	);
	return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

function restore() {
	fs.writeFileSync(GUARD, guardOriginal, 'utf8');
	fs.writeFileSync(TOOL, toolOriginal, 'utf8');
}

console.log('\n=== 0. the parity test passes on the unmodified source ===');
{
	const r = runParity();
	check('the parity test passes', () =>
		r.status === 0 ? true : `it failed:\n${r.out.slice(-400)}`);
}

console.log('\n=== 1. removing the guard call must FAIL the test ===');
{
	// Remove the call to the guard in toolEngine.ts.
	const m = toolOriginal.replace(
		/if \(wouldClobberScaffold\(relPath, isCreateRequest === true\)\) \{/,
		'if (false) {',
	);
	if (m === toolOriginal) {
		check('the mutation applies', () => 'the guard call was not found');
	} else {
		fs.writeFileSync(TOOL, m, 'utf8');
		const r = runParity();
		restore();
		check('removing the guard call makes the test fail', () =>
			r.status !== 0 ? true : 'the test still passed — the guard is not covered');
	}
}

console.log('\n=== 2. making the guard always return false must FAIL ===');
{
	const m = guardOriginal.replace(
		'if (!isCreateRequest) return false;',
		'if (!isCreateRequest) return false;\n\treturn false;',
	);
	if (m === guardOriginal) {
		check('the mutation applies', () => 'the guard body was not found');
	} else {
		fs.writeFileSync(GUARD, m, 'utf8');
		const r = runParity();
		restore();
		check('a guard that never blocks makes the test fail', () =>
			r.status !== 0 ? true : 'the test still passed');
	}
}

console.log('\n=== 3. making the guard always return true must FAIL ===');
{
	const m = guardOriginal.replace(
		'if (!isCreateRequest) return false;',
		'if (!isCreateRequest) return false;\n\treturn true;',
	);
	if (m === guardOriginal) {
		check('the mutation applies', () => 'the guard body was not found');
	} else {
		fs.writeFileSync(GUARD, m, 'utf8');
		const r = runParity();
		restore();
		check('a guard that always blocks makes the test fail', () =>
			r.status !== 0 ? true : 'the test still passed');
	}
}

console.log('\n=== 4. blocking src/App.tsx must FAIL the test ===');
{
	// The model MUST be able to write App.tsx. If the guard blocked
	// it, every create request would produce nothing.
	//
	// The entry MUST be lowercase: the guard lowercases the path
	// before the lookup, so an entry with an uppercase letter can
	// never match. Adding 'src/App.tsx' would be a no-op — and a
	// no-op mutation would make this check pass for the WRONG reason.
	const m = guardOriginal.replace(
		"'src/main.tsx',",
		"'src/main.tsx',\n	'src/app.tsx',",
	);
	if (m === guardOriginal) {
		check('the mutation applies', () => 'the file list was not found');
	} else {
		fs.writeFileSync(GUARD, m, 'utf8');
		const r = runParity();
		restore();
		check('blocking src/App.tsx makes the test fail', () =>
			r.status !== 0 ? true : 'the test still passed');
	}
}

console.log('\n=== 5. removing the case normalisation must FAIL the test ===');
{
	const m = guardOriginal.replace(
		"const normalised = relPath.replace(/\\\\/g, '/').replace(/^\\.\\//, '').toLowerCase();",
		'const normalised = relPath;',
	);
	if (m === guardOriginal) {
		check('the mutation applies', () => 'the normalisation line was not found');
	} else {
		fs.writeFileSync(GUARD, m, 'utf8');
		const r = runParity();
		restore();
		check('removing the normalisation makes the test fail', () =>
			r.status !== 0 ? true : 'the test still passed');
	}
}

console.log('\n=== 6. the source files are byte-identical ===');
check('scaffoldGuard.ts is byte-identical', () =>
	fs.readFileSync(GUARD, 'utf8') === guardOriginal ? true : 'it was not restored');
check('toolEngine.ts is byte-identical', () =>
	fs.readFileSync(TOOL, 'utf8') === toolOriginal ? true : 'it was not restored');

console.log('\n=== 7. the parity test passes again ===');
{
	const r = runParity();
	check('the parity test passes', () =>
		r.status === 0 ? true : `it failed:\n${r.out.slice(-400)}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The parity test catches every mutation of the scaffold guard.');
