/**
 * The compile check must RUN in a fresh project.
 *
 * THE BUG
 *
 * Pass 17 (the compile check) had this gate:
 *
 *     const nmSrc = path.join(workspaceRoot, 'node_modules');
 *     if (!fs.existsSync(tscBin)
 *         || !fs.existsSync(path.join(workspaceRoot, 'tsconfig.json'))
 *         || !fs.existsSync(nmSrc)) {
 *         log('pass17: tsc/tsconfig or node_modules not found — skipped');
 *         return;
 *     }
 *
 * The only `npm install` in a new project is inside the generated
 * init.sh — a script the USER runs later. So in a fresh project there
 * is no node_modules, and the check was ALWAYS skipped:
 *
 *     pass17: tsc/tsconfig or node_modules not found — skipped
 *
 * That is the strongest validation signal — it actually compiles the
 * generated TypeScript — and it was off in every fresh project. A
 * generation with a type error could pass validation.
 *
 * The requirement was REDUNDANT: the code below the gate symlinks
 * the ROUTER's node_modules into the temp dir when the workspace has
 * none. The gate returned before reaching that.
 *
 * WHAT THIS PROVES
 *
 * A workspace with a tsconfig.json and NO node_modules — exactly
 * what a fresh project looks like — now gets the compile check, and
 * a type error is caught.
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

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

const { runPostGenerationValidator } = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'validator.ts')).href
) as any;

// ── a fresh workspace: a tsconfig.json, and NO node_modules ─────────
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-tsc-'));
fs.writeFileSync(
	path.join(workspace, 'tsconfig.json'),
	JSON.stringify({
		compilerOptions: {
			target: 'ES2020',
			module: 'ESNext',
			moduleResolution: 'bundler',
			jsx: 'react-jsx',
			strict: true,
			noEmit: true,
			skipLibCheck: true,
			// TypeScript 6 deprecates 'baseUrl'. Without this the
			// compile check reports a CONFIG error, not a code
			// error — and the check below is about the code.
			ignoreDeprecations: '6.0',
		},
		include: ['src/**/*'],
	}, null, 2),
	'utf-8',
);

console.log('\n=== the workspace looks like a fresh project ===');
check('it has a tsconfig.json', () =>
	fs.existsSync(path.join(workspace, 'tsconfig.json')) ? true : 'it does not');
check('it has NO node_modules', () =>
	!fs.existsSync(path.join(workspace, 'node_modules')) ? true : 'it does');

/** A contract with no requirements — so only the compile check can fire. */
function contract() {
	return {
		scope: 'frontend' as const,
		architecture: 'unknown' as const,
		framework: 'react' as const,
		language: 'typescript' as const,
		requiredFeatures: [],
		requiredFolders: [],
		expectedFiles: [],
		estimatedFiles: 2,
	};
}

console.log('\n=== a generation with a TYPE ERROR is caught ===');

// A REAL type error. Note: `const count: string = '1'; count + 1` is
// NOT an error — TypeScript allows string + number. The first version
// of this test used that, and it passed for the wrong reason: before
// the ignoreDeprecations fix, tsc reported the CONFIG error (TS5101)
// and the validator filed THAT as the compile_error. So the test was
// proving "the check runs", not "the type error is caught".
const WITH_TYPE_ERROR = [{
	path: 'src/App.tsx',
	content: `export const count: number = 'one';
`,
}];

const result = await runPostGenerationValidator(
	WITH_TYPE_ERROR as any,
	workspace,
	contract() as any,
	false,
);

const compileIssues = (result.issues ?? []).filter(
	(i: any) => i.kind === 'compile_error',
);

check('the type error is reported as a compile_error', () => {
	return compileIssues.length > 0
		? true
		: `no compile_error — the issues were: ${(result.issues ?? []).map((i: any) => `${i.kind}: ${i.message}`).join(' | ').slice(0, 400) || 'none'}`;
});

check('the validation did NOT pass', () =>
	result.passed === false ? true : 'it passed despite the type error');

console.log('\n=== a clean generation still passes ===');

const CLEAN = [{
	path: 'src/App.tsx',
	content: `const count: number = 1;
export const total = count + 1;
`,
}];

const cleanResult = await runPostGenerationValidator(
	CLEAN as any,
	workspace,
	contract() as any,
	false,
);

const cleanCompileIssues = (cleanResult.issues ?? []).filter(
	(i: any) => i.kind === 'compile_error',
);

check('no compile_error for the clean code', () =>
	cleanCompileIssues.length === 0
		? true
		: `it reported: ${cleanCompileIssues.map((i: any) => i.message).join(' | ').slice(0, 300)}`);

console.log('\n=== a workspace with no tsconfig.json still skips ===');

const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-tsc-bare-'));
const bareResult = await runPostGenerationValidator(
	WITH_TYPE_ERROR as any,
	bare,
	contract() as any,
	false,
);
const bareCompile = (bareResult.issues ?? []).filter(
	(i: any) => i.kind === 'compile_error',
);
check('the check is skipped when there is no tsconfig', () =>
	bareCompile.length === 0
		? true
		: 'it tried to compile without a tsconfig');

// Clean up.
for (const d of [workspace, bare]) {
	try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* not fatal */ }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The compile check runs in a fresh project.');
