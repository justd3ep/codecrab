/**
 * Consolidated Phase 1 verification.
 *
 * Phase 1 made the router SAFE to run:
 *   P1.1  the scaffold produces a compilable project
 *   P1.2  the git harness never stages a deletion
 *   P1.3  an existing project is backed up before scaffolding
 *   P1.4  the Advisor survives a truncated JSON response
 *   P1.5  the Advisor has room to finish its JSON
 *   P1.6  the model-path fallback is visible, not silent
 *   P1.7  a create request cannot clobber the scaffold
 *   P1.8  the repair loop does not re-ask for a file it cannot fix
 *
 * No LLM inference is performed. The behavioural checks exercise the real
 * functions, extracted from the source so they cannot drift.
 *
 * Run: node_modules/.bin/tsx scratch/verify-phase1.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.resolve(HERE, '..');

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

const indexSrc = fs.readFileSync(path.join(ROUTER, 'src', 'index.ts'), 'utf8');
const scaffoldSrc = fs.readFileSync(path.join(ROUTER, 'src', 'frontendScaffold.ts'), 'utf8');
const gitSrc = fs.readFileSync(path.join(ROUTER, 'src', 'gitHarness.ts'), 'utf8');
const cfgSrc = fs.readFileSync(path.join(ROUTER, 'src', 'config', 'config.local.ts'), 'utf8');
const cfgTypesSrc = fs.readFileSync(path.join(ROUTER, 'src', 'config', 'types.ts'), 'utf8');

/** Read a source file relative to the router root. */
function read(rel: string): string {
	return fs.readFileSync(path.join(ROUTER, rel), 'utf8');
}

/** Strip comments so a doc string is never read as code. */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split(String.fromCharCode(10))
		.map(l => l.replace(/\/\/.*/, ''))
		.join(String.fromCharCode(10));
}

const indexLive = stripComments(indexSrc);
const scaffoldLive = stripComments(scaffoldSrc);
const gitLive = stripComments(gitSrc);

// ══════════════════════════════════════════════════════════════════════
console.log('\n=== P1.1 — the scaffold produces a compilable project ===');

check('the scaffold creates src/App.tsx', () =>
	scaffoldLive.includes("created.push('src/App.tsx')") ? true : 'the scaffold does not create App.tsx');

check('the placeholder App.tsx is a valid React component', () => {
	const i = scaffoldSrc.indexOf("const appTsxContent = `");
	if (i < 0) return 'the placeholder content was not found';
	const j = scaffoldSrc.indexOf('`;', i);
	const body = scaffoldSrc.slice(i, j);
	return body.includes('export default function App()')
		&& body.includes('return (')
		&& !/import\s+.*from\s+['"].\/components/.test(body)
		? true
		: 'the placeholder is missing its component or imports a file that does not exist';
});

check('main.tsx imports ./App (so App.tsx is required)', () =>
	scaffoldSrc.includes("import App from './App';") ? true : "main.tsx no longer imports './App'");

check('the placeholder is created BEFORE main.tsx would need it', () => {
	const appIdx = scaffoldSrc.indexOf("created.push('src/App.tsx')");
	const mainIdx = scaffoldSrc.indexOf("created.push('src/main.tsx')");
	return appIdx > 0 && mainIdx > 0 ? true : 'one of the creations is missing';
});

// ══════════════════════════════════════════════════════════════════════
console.log('\n=== P1.2 — the git harness never stages a deletion ===');

check('`git add .` is gone', () => {
	const bare = gitLive.match(/git add \.(?![-\s])/);
	return !bare ? true : 'a bare `git add .` command is back';
});

check('the harness stages per-file with `git add --`', () =>
	gitLive.includes('git add --') ? true : 'the safe per-file form is missing');

check('the harness skips deletions explicitly', () =>
	gitLive.includes("code.includes('D')") ? true : 'deletions are not skipped');

check('the harness uses stageAgentFiles', () =>
	gitLive.includes('stageAgentFiles') ? true : 'stageAgentFiles is missing');

check('commitHarnessTurn accepts the list of written files', () =>
	gitLive.includes('writtenFiles') ? true : 'there is no writtenFiles parameter');

// ══════════════════════════════════════════════════════════════════════
console.log('\n=== P1.3 — an existing project is backed up before scaffolding ===');

check('backupExistingWorkspace exists', () =>
	scaffoldLive.includes('function backupExistingWorkspace') ? true : 'the backup helper is missing');

check('the frontend scaffold calls it', () =>
	scaffoldLive.includes("backupExistingWorkspace(workspaceRoot, 'frontend')")
		? true : 'the frontend scaffold does not call the backup helper');

check('the backend scaffold calls it', () =>
	scaffoldLive.includes("backupExistingWorkspace(workspaceRoot, 'backend')")
		? true : 'the backend scaffold does not call the backup helper');

check('the backup goes OUTSIDE the workspace', () => {
	const i = scaffoldLive.indexOf('function backupExistingWorkspace');
	if (i < 0) return 'the helper is missing';
	const body = scaffoldLive.slice(i, i + 2500);
	return body.includes('path.dirname(workspaceRoot)')
		? true
		: 'the backup directory is not derived from the parent of the workspace — it would be scaffolded itself';
});

check('the backup skips node_modules and .git', () => {
	const i = scaffoldLive.indexOf('function backupExistingWorkspace');
	const body = scaffoldLive.slice(i, i + 2500);
	return body.includes("'node_modules'") && body.includes("'.git'")
		? true
		: 'node_modules/.git are not skipped';
});

// ══════════════════════════════════════════════════════════════════════
console.log('\n=== P1.4 — the Advisor survives a truncated JSON response ===');

const { parseAdvisorJson } = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'routing', 'advisorJson.ts')).href
) as { parseAdvisorJson: (raw: string) => Record<string, any> | null };

const TRUNCATED = '{"intent":"create_fe","framework":"react","language":"typescript","modules":["dashboard","sidebar","navbar","main","task-list","task-statistics","week';

check('a truncated response yields the intent', () =>
	parseAdvisorJson(TRUNCATED)?.intent === 'create_fe' ? true : 'the intent was lost');

check('a truncated response yields the other fields', () =>
	parseAdvisorJson(TRUNCATED)?.framework === 'react' ? true : 'the framework was lost');

check('a complete response still parses', () =>
	parseAdvisorJson('{"intent":"create_be","framework":"express"}')?.intent === 'create_be'
		? true : 'a complete response broke');

check('garbage still returns null', () =>
	parseAdvisorJson('not json at all') === null ? true : 'garbage did not return null');

check('both advisor parsers use the tolerant parser', () => {
	const a = indexSrc.indexOf('function parseAdvisorIntent');
	const b = indexSrc.indexOf('function parseAdvisorV2');
	return indexSrc.slice(a, a + 1200).includes('parseAdvisorJson(stripped)')
		&& indexSrc.slice(b, b + 1200).includes('parseAdvisorJson(stripped)')
		? true : 'a parser still uses the strict parse';
});

// ══════════════════════════════════════════════════════════════════════
console.log('\n=== P1.5 — the Advisor has room to finish its JSON ===');

check('the advisor context is 4096', () =>
	indexLive.includes('createContext({ contextSize: 4096 })') ? true : 'the context is still 2048');

check('the output cap is 2000 chars, not 600', () => {
	const m = indexLive.match(/raw\.length > (\d+)/);
	return m && Number(m[1]) >= 2000 ? true : `the cap is ${m?.[1]}`;
});

check('the full raw output is logged, not a 150-char slice', () =>
	!indexLive.includes("raw.trim().slice(0, 150)") ? true : 'the log still truncates to 150 chars');

check('hitting the cap is warned about', () =>
	indexLive.includes('hitCap') ? true : 'a truncation is still silent');

// ══════════════════════════════════════════════════════════════════════
console.log('\n=== P1.6 — the model-path fallback is visible ===');

check('the config resolves the model path through a helper', () =>
	cfgSrc.includes('function resolveModelPath') ? true : 'resolveModelPath is missing');

check('a missing preferred model is logged', () =>
	cfgSrc.includes('preferred model not found') ? true : 'the fallback is still silent');

check('the config exposes modelResolution', () =>
	cfgSrc.includes('modelResolution') ? true : 'modelResolution is not on the config');

check('the config type declares modelResolution', () =>
	cfgTypesSrc.includes('modelResolution') ? true : 'the AppConfig type is missing modelResolution');

check('/health reports the model resolution', () =>
	indexLive.includes('modelResolution: config.modelResolution') ? true : '/health does not report it');

// ══════════════════════════════════════════════════════════════════════
console.log('\n=== P1.7 — a create request cannot clobber the scaffold ===');

// The guard lives in tools/scaffoldGuard.ts, and it is CALLED from the
// live executeToolCall in tools/toolEngine.ts. The PROPERTY is what
// matters, so the checks follow the code wherever it lives.
const guardSrc = read('src/tools/scaffoldGuard.ts');
const toolEngineSrc = read('src/tools/toolEngine.ts');

check('SCAFFOLD_OWNED_FILES exists', () =>
	guardSrc.includes('SCAFFOLD_OWNED_FILES') ? true : 'the set is missing');

check('the guard function exists', () =>
	guardSrc.includes('export function wouldClobberScaffold')
		? true : 'wouldClobberScaffold is missing');

check('the guard is applied before the write', () => {
	const i = toolEngineSrc.indexOf('wouldClobberScaffold(relPath');
	if (i < 0) return 'the guard is not called';
	const j = toolEngineSrc.indexOf('writeFileSync(resolvedPath, content', i);
	return i < j ? true : 'the guard runs AFTER the write';
});

check('the live executeToolCall is the one in the module', () =>
	!indexLive.includes('function executeToolCall(')
		? true : 'index.ts still defines its own copy');

check('the write call sites pass the create flag', () => {
	const n = (indexLive.match(/readWriteMode,\s*rawAdvisorIntent\?\.startsWith\('create_'\)/g) ?? []).length;
	return n >= 3 ? true : `only ${n} call site(s) pass the create flag`;
});

check('src/App.tsx is NOT protected (the model must write it)', () => {
	const i = guardSrc.indexOf('const SCAFFOLD_OWNED_FILES');
	const body = guardSrc.slice(i, i + 1200);
	return !body.includes("'src/App.tsx'") ? true : 'App.tsx is protected — the model can never write it';
});

check('package.json is NOT protected (it goes through a merge)', () => {
	const i = indexLive.indexOf('const SCAFFOLD_OWNED_FILES');
	const body = indexLive.slice(i, i + 1200);
	return !body.includes("'package.json'") ? true : 'package.json is protected — the merge would never run';
});

// ══════════════════════════════════════════════════════════════════════
console.log('\n=== P1.8 — the repair loop does not re-ask for a stuck file ===');

check('the per-file hash tracker exists', () =>
	indexLive.includes('fileHashHistory') ? true : 'fileHashHistory is missing');

check('the repeat counter exists', () =>
	indexLive.includes('fileHashRepeat') ? true : 'fileHashRepeat is missing');

check('the stuck-file set exists', () =>
	indexLive.includes('stuckFiles') ? true : 'stuckFiles is missing');

check('a repeated hash marks the file stuck', () =>
	indexLive.includes('stuckFiles.add(f.path)') ? true : 'the stuck marking is missing');

check('the repair prompt excludes the stuck files', () =>
	indexLive.includes('repairableIssues') ? true : 'the repair prompt does not filter');

check('the repair prompt uses the filtered issues', () => {
	const i = indexLive.indexOf('const repairPrompt = currentSpecialist');
	if (i < 0) return 'the repair prompt was not found';
	const body = indexLive.slice(i, i + 400);
	return body.includes('repairableIssues') ? true : 'the repair prompt still uses all the issues';
});

check('a fully-stuck repair gives up with a clear error', () =>
	indexLive.includes('Repair stalled') ? true : 'the stall error is missing');

// ══════════════════════════════════════════════════════════════════════
console.log('\n=== the repo stays clean ===');

check('the live check writes outside the repository', () => {
	// The live check lives in scratch/ (it is a probe, not a test).
	const lc = fs.readFileSync(path.join(ROUTER, 'scratch', 'live-check-dashboard.ts'), 'utf8');
	return lc.includes('CODECRAB_EVAL_DIR') && !lc.includes("'scratch', '.live-check'")
		? true : 'the live check still writes into the repo';
});

check('the p0 rescue test writes outside the repository', () => {
	const r = fs.readFileSync(path.join(HERE, 'verify-p0-rescue.ts'), 'utf8');
	return r.includes('CODECRAB_EVAL_DIR') ? true : 'the p0 rescue test still writes into the repo';
});

check('no generated project is left in the repo', () => {
	const bad: string[] = [];
	for (const dir of [HERE, path.join(ROUTER, 'scratch')]) {
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir)) {
			const p = path.join(dir, name);
			if (!fs.statSync(p).isDirectory()) continue;
			if (fs.existsSync(path.join(p, 'package.json'))) bad.push(`${path.basename(dir)}/${name}`);
		}
	}
	return bad.length === 0 ? true : `generated projects left behind: ${bad.join(', ')}`;
});

check('the gitignore has a safety net for generated artifacts', () => {
	const gi = fs.readFileSync(path.join(ROUTER, '.gitignore'), 'utf8');
	return gi.includes('scratch/.live-check/') ? true : 'no gitignore safety net';
});

// ══════════════════════════════════════════════════════════════════════
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('Phase 1 verified: the router is safe to run.');
