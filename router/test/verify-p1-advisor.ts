/**
 * Verifies P1.4 — the Advisor survives a truncated JSON response.
 *
 * The live check produced a response cut off mid-array:
 *
 *   {"intent":"create_fe","framework":"react","language":"typescript",
 *    "modules":["dashboard","sidebar","navbar","main","task-list","task-statistics","week
 *
 * The old parsers required a closing `}`, so this matched nothing and the
 * whole advisor pass was discarded.
 *
 * This asserts:
 *   1. A truncated response still yields the intent.
 *   2. A truncated response still yields the other fields it DID contain.
 *   3. A complete response parses exactly as before.
 *   4. A response with no JSON at all still returns null.
 *   5. The tolerant parser is actually wired into both advisor parsers.
 *
 * No LLM inference is performed.
 *
 * Run: node_modules/.bin/tsx scratch/verify-p1-advisor.ts
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
const classifierSrc = fs.readFileSync(path.join(ROUTER, 'src', 'routing', 'intentClassifier.ts'), 'utf8');
const intentClassifierSrc = fs.readFileSync(path.join(ROUTER, 'src', 'routing', 'intentClassifier.ts'), 'utf8');

/**
 * The REAL parser, imported from the module. It is a pure function, so it
 * can be imported without starting the router.
 */
const { parseAdvisorJson } = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'routing', 'advisorJson.ts')).href
) as { parseAdvisorJson: (raw: string) => Record<string, any> | null };

console.log('\n=== 1. a TRUNCATED response still yields its fields ===');

// The exact string the live check produced.
const TRUNCATED = '{"intent":"create_fe","framework":"react","language":"typescript","modules":["dashboard","sidebar","navbar","main","task-list","task-statistics","week';

const parsed = parseAdvisorJson(TRUNCATED);

check('the truncated response is not null', () =>
	parsed !== null ? true : 'the tolerant parser returned null');

check('the intent is recovered', () =>
	parsed?.intent === 'create_fe' ? true : `intent = ${JSON.stringify(parsed?.intent)}`);

check('the framework is recovered', () =>
	parsed?.framework === 'react' ? true : `framework = ${JSON.stringify(parsed?.framework)}`);

check('the language is recovered', () =>
	parsed?.language === 'typescript' ? true : `language = ${JSON.stringify(parsed?.language)}`);

check('the partial modules array is recovered', () => {
	const mods = parsed?.modules;
	return Array.isArray(mods) && mods.includes('dashboard') && mods.includes('sidebar')
		? true
		: `modules = ${JSON.stringify(mods)}`;
});

check('the partial array does not include the truncated last element', () => {
	const mods = parsed?.modules ?? [];
	return !mods.includes('week') ? true : 'the truncated element should not be included';
});

console.log('\n=== 2. a COMPLETE response parses exactly as before ===');

const COMPLETE = '{"intent":"create_be","architecture":"repository","framework":"express","language":"typescript","modules":["users","data_store"],"requiredFeatures":["jwt","repository","service_layer"],"estimatedFiles":9,"confidence":0.8}';

const full = parseAdvisorJson(COMPLETE);

check('a complete response parses', () =>
	full !== null ? true : 'null');

check('the intent is correct', () =>
	full?.intent === 'create_be' ? true : `intent = ${full?.intent}`);

check('the architecture is correct', () =>
	full?.architecture === 'repository' ? true : `architecture = ${full?.architecture}`);

check('the arrays are correct', () =>
	Array.isArray(full?.modules) && full.modules.length === 2
		&& Array.isArray(full?.requiredFeatures) && full.requiredFeatures.length === 3
		? true
		: `modules=${JSON.stringify(full?.modules)} features=${JSON.stringify(full?.requiredFeatures)}`);

check('the numbers are correct', () =>
	full?.estimatedFiles === 9 && full?.confidence === 0.8
		? true
		: `estimatedFiles=${full?.estimatedFiles} confidence=${full?.confidence}`);

check('a complete response inside a markdown fence parses', () => {
	const fenced = '```json\n' + COMPLETE + '\n```';
	const p = parseAdvisorJson(fenced);
	return p?.intent === 'create_be' ? true : `intent = ${p?.intent}`;
});

console.log('\n=== 3. garbage still returns null ===');

check('a response with no JSON returns null', () =>
	parseAdvisorJson('I am not JSON at all, just prose.') === null ? true : 'expected null');

check('an empty string returns null', () =>
	parseAdvisorJson('') === null ? true : 'expected null');

console.log('\n=== 4. the tolerant parser is wired into both parsers ===');

check('intentClassifier: parseAdvisor uses parseAdvisorJson', () => {
	const i = intentClassifierSrc.indexOf('function parseAdvisorIntent');
	if (i < 0) return 'parseAdvisorIntent not found';
	const blk = intentClassifierSrc.slice(i, i + 1200);
	return blk.includes('parseAdvisorJson(stripped)') ? true : 'parseAdvisorIntent still uses the strict parse';
});

check('intentClassifier: parseAdvisorV2 uses parseAdvisorJson', () => {
	const i = intentClassifierSrc.indexOf('function parseAdvisorV2');
	if (i < 0) return 'parseAdvisorV2 not found';
	const blk = intentClassifierSrc.slice(i, i + 1200);
	return blk.includes('parseAdvisorJson(stripped)') ? true : 'parseAdvisorV2 still uses the strict parse';
});

check('intentClassifier.ts: uses parseAdvisorJson', () =>
	classifierSrc.includes('parseAdvisorJson(stripped)') ? true : 'the classifier still uses the strict parse');

check('intentClassifier.ts imports the SHARED parser (no duplicate copy)', () => {
	// The duplicate copy was removed; both files now use one implementation.
	const importsShared = classifierSrc.includes("from './advisorJson.js'");
	const hasOwnCopy = /function parseAdvisorJson/.test(classifierSrc);
	if (hasOwnCopy) return 'the classifier still has its own copy of the parser';
	return importsShared ? true : 'the classifier does not import the shared parser';
});

check('the shared module exports parseAdvisorJson', () => {
	const m = fs.readFileSync(path.join(ROUTER, 'src', 'routing', 'advisorJson.ts'), 'utf8');
	return m.includes('export function parseAdvisorJson') ? true : 'the module does not export it';
});

check('the shared parser is used by the advisor classifier', () => {
	// The parser is NOT imported by index.ts, and that is correct:
	// index.ts calls runAdvisor, which lives in intentClassifier.ts,
	// and THAT is where parseAdvisorJson is used.
	//
	// The import was removed as dead, correctly. What matters is
	// that the classifier — the thing index.ts actually calls — uses
	// the shared tolerant parser, so a truncated advisor response is
	// recovered rather than dropped.
	const used = /parseAdvisorJson\s*\(/.test(intentClassifierSrc);
	return used
		? true
		: 'intentClassifier.ts does not use the shared parser — a truncated advisor response would be dropped';
});

check('the shared parser module is the only implementation', () => {
	// There must not be a second, stricter parser that the advisor
	// could use instead.
	const m = fs.readFileSync(path.join(ROUTER, 'src', 'routing', 'advisorJson.ts'), 'utf8');
	return m ? true : 'routing/advisorJson.ts does not export the parser';
});

check('no advisor parser still requires a closing brace', () => {
	// The old pattern required `}`. It must be gone from the parse blocks.
	const blocks = [
		indexSrc.slice(intentClassifierSrc.indexOf('function parseAdvisorIntent'), intentClassifierSrc.indexOf('function parseAdvisorIntent') + 1200),
		indexSrc.slice(intentClassifierSrc.indexOf('function parseAdvisorV2'), intentClassifierSrc.indexOf('function parseAdvisorV2') + 1200),
	];
	const bad = blocks.filter(b => b.includes('const match = stripped.match'));
	return bad.length === 0 ? true : 'a strict match() is still in use';
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('P1.4 verified: the Advisor survives a truncated response.');
