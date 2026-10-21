/**
 * The parity test for the executeToolCall consolidation.
 *
 * WHAT WAS FIXED
 *
 * There were TWO copies of executeToolCall:
 *
 *   index.ts (LIVE)              tools/toolEngine.ts (STALE)
 *   174 lines                    159 lines
 *   has the P1.7 scaffold guard   no scaffold guard at all
 *
 * The P1.7 guard is a SAFETY property: a CREATE request must never
 * let the model overwrite the files the project scaffold owns. The
 * stale copy had no `isCreateRequest` parameter and no guard, so
 * mounting chatRoutes.ts (which imports the module's copy) would
 * have silently removed it.
 *
 * The live copy now lives in tools/toolEngine.ts, and the guard
 * itself — `wouldClobberScaffold` and `SCAFFOLD_OWNED_FILES` — lives
 * in tools/scaffoldGuard.ts.
 *
 * WHAT THIS PROVES
 *
 *   1. The module holds the LIVE implementation — it has the guard.
 *   2. index.ts imports it rather than defining it.
 *   3. The guard's BEHAVIOUR, exercised by calling it:
 *      - a create request cannot write vite.config.ts
 *      - a create request CAN write src/App.tsx (the model must
 *        generate it — that is the whole point)
 *      - an edit request CAN write vite.config.ts
 *      - the path is matched case-insensitively and with './'
 *      - Windows backslashes are normalised
 *   4. The guard is actually WIRED IN: executeToolCall with
 *      isCreateRequest=true must REFUSE to write a scaffold file, and
 *      must leave the file on disk untouched.
 *   5. MUTATION: see verify-parity-execute-toolcall-mutation.ts.
 *
 * The guard is checked BEHAVIOURALLY — by writing a file and looking
 * at the disk — not by grepping the source. A source-text check would
 * be defeated by a rename and would not catch a guard that is
 * computed but not applied.
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

const read = (p: string) => fs.readFileSync(p, 'utf8');

console.log('\n=== 1. the module holds the LIVE implementation ===');

const toolSrc = read(path.join(ROUTER, 'src', 'tools', 'toolEngine.ts'));
const indexSrc = read(path.join(ROUTER, 'src', 'index.ts'));
const guardSrc = read(path.join(ROUTER, 'src', 'tools', 'scaffoldGuard.ts'));

check('toolEngine.ts has the scaffold guard', () =>
	toolSrc.includes('wouldClobberScaffold')
		? true : 'the guard is not called in the module');

check('toolEngine.ts has the isCreateRequest parameter', () =>
	toolSrc.includes('isCreateRequest')
		? true : 'the parameter is missing');

check('index.ts does NOT define executeToolCall', () =>
	/^function executeToolCall\(/m.test(indexSrc)
		? 'index.ts still defines it' : true);

check('index.ts imports executeToolCall from the module', () =>
	/from '\.\/tools\/toolEngine\.js'/.test(indexSrc) && /executeToolCall/.test(indexSrc)
		? true : 'the import is missing');

check('index.ts does NOT define wouldClobberScaffold', () =>
	/^function wouldClobberScaffold\(/m.test(indexSrc)
		? 'index.ts still defines it' : true);

check('scaffoldGuard.ts holds the guard', () =>
	guardSrc.includes('export function wouldClobberScaffold')
		? true : 'the guard is not exported from scaffoldGuard.ts');

console.log('\n=== 2. the guard BEHAVIOUR ===');

const { wouldClobberScaffold } = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'tools', 'scaffoldGuard.ts')).href
);

check('a create request cannot write vite.config.ts', () =>
	wouldClobberScaffold('vite.config.ts', true) ? true : 'it was allowed');

// package.json is NOT scaffold-owned: it has its own MERGE path, so
// the model may write it and the two are merged. If the guard blocked
// it, the merge would never happen.
check('a create request MAY write package.json (it has a merge path)', () =>
	wouldClobberScaffold('package.json', true)
		? 'the guard blocked it — the merge path would never run'
		: true);

check('a create request cannot write index.html', () =>
	wouldClobberScaffold('index.html', true) ? true : 'it was allowed');

check('a create request cannot write tsconfig.json', () =>
	wouldClobberScaffold('tsconfig.json', true) ? true : 'it was allowed');

check('a create request cannot write src/main.tsx', () =>
	wouldClobberScaffold('src/main.tsx', true) ? true : 'it was allowed');

check('a create request CAN write src/App.tsx (the model must generate it)', () =>
	wouldClobberScaffold('src/App.tsx', true)
		? 'it was blocked — the model could never write App.tsx'
		: true);

check('a create request CAN write a component', () =>
	wouldClobberScaffold('src/components/TaskCard.tsx', true)
		? 'it was blocked' : true);

check('an EDIT request can write vite.config.ts', () =>
	wouldClobberScaffold('vite.config.ts', false)
		? 'it was blocked — an edit must be able to change it' : true);

check('the path is matched case-insensitively', () =>
	wouldClobberScaffold('VITE.CONFIG.TS', true) ? true : 'the case was not normalised');

check("a './' prefix is normalised", () =>
	wouldClobberScaffold('./vite.config.ts', true) ? true : 'the prefix was not normalised');

check('a Windows backslash path is normalised', () =>
	wouldClobberScaffold('src\\main.tsx', true) ? true : 'the backslashes were not normalised');

console.log('\n=== 3. the guard is WIRED IN: the write is really refused ===');

const { executeToolCall } = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'tools', 'toolEngine.ts')).href
);

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-verify-guard-'));
try {
	// A scaffold file exists.
	fs.writeFileSync(path.join(WS, 'vite.config.ts'), 'ORIGINAL SCAFFOLD\n', 'utf8');

	// The guard returns success: TRUE on purpose — the write was
	// skipped, but the run did not fail, because the model's OTHER
	// files should still land. What matters is that the file on disk
	// is unchanged and the output says it was skipped.
	check('a create request SKIPS the write to vite.config.ts', () => {
		const r = executeToolCall(
			{ name: 'writeFile', arguments: { path: 'vite.config.ts', content: 'MODEL VERSION\n' } },
			WS, undefined, undefined, 'frontend', 'write', true,
		);
		return /skipped/i.test(r.output)
			? true : `it said: ${r.output}`;
	});

	check('the scaffold file on disk is UNCHANGED', () =>
		fs.readFileSync(path.join(WS, 'vite.config.ts'), 'utf8') === 'ORIGINAL SCAFFOLD\n'
			? true : 'the file was overwritten');

	check('the refusal says the file is scaffold-owned', () => {
		const r = executeToolCall(
			{ name: 'writeFile', arguments: { path: 'vite.config.ts', content: 'MODEL VERSION\n' } },
			WS, undefined, undefined, 'frontend', 'write', true,
		);
		return /scaffold/i.test(r.output) ? true : `it said: ${r.output}`;
	});

	check('an EDIT request MAY overwrite vite.config.ts', () => {
		const r = executeToolCall(
			{ name: 'writeFile', arguments: { path: 'vite.config.ts', content: 'MODEL VERSION\n' } },
			WS, undefined, undefined, 'frontend', 'write', false,
		);
		if (!r.success) return `it refused: ${r.output}`;
		return fs.readFileSync(path.join(WS, 'vite.config.ts'), 'utf8') === 'MODEL VERSION\n'
			? true : 'the file was not written';
	});

	check('a create request CAN write src/App.tsx', () => {
		fs.mkdirSync(path.join(WS, 'src'), { recursive: true });
		const r = executeToolCall(
			{ name: 'writeFile', arguments: { path: 'src/App.tsx', content: 'export default function App() { return null; }\n' } },
			WS, undefined, undefined, 'frontend', 'write', true,
		);
		if (!r.success) return `it refused: ${r.output}`;
		return fs.existsSync(path.join(WS, 'src', 'App.tsx'))
			? true : 'the file was not written';
	});
} finally {
	fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The module holds the live executeToolCall, and the P1.7');
console.log('scaffold guard is wired in and working.');
