/**
 * The generation limits must keep the values the constants had.
 *
 * THE BUG THIS GUARDS
 *
 * src/generation/limits.ts could have aliased the config:
 *
 *     export const REPEAT_PENALTY = config.generation.repeatPenalty;
 *
 * and that would have been a silent BEHAVIOUR CHANGE:
 *
 *     the constant   REPEAT_PENALTY = 1.18
 *     the config     repeatPenalty: 1.15
 *
 *     the constant   REPEAT_PENALTY_TOKENS = 256
 *     the config     repeatPenaltyTokens: 64
 *
 * The config's repeatPenalty was NEVER READ by the route — it was
 * inert. Aliasing it would have changed the sampling of every
 * generation.
 *
 * So the values are pinned here, and this check proves they are the
 * values the route was using.
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
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

/** The values the route was using, before the module existed. */
const EXPECTED: Record<string, number> = {
	MAX_AGENT_ITERATIONS: 6,
	MAX_CORRECTIONS_PER_FILE: 3,
	MAX_TOTAL_CORRECTIONS: 5,
	REPEAT_PENALTY: 1.18,
	REPEAT_PENALTY_TOKENS: 256,
	REQUEST_TIMEOUT_MS: 3600000,
};

console.log('\n=== the limits keep the values the constants had ===');

const limits = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'generation', 'limits.ts')).href
) as Record<string, number>;

for (const [name, expected] of Object.entries(EXPECTED)) {
	check(`${name} is ${expected}`, () => {
		const actual = limits[name];
		return actual === expected
			? true
			: `it is ${actual} — the route was using ${expected}`;
	});
}

console.log('\n=== the module is not aliased to the config ===');

const limitsSrc = fs.readFileSync(
	path.join(ROUTER, 'src', 'generation', 'limits.ts'), 'utf8',
);

// The check must look at the CODE. The file's header comment quotes
// the alias form it is warning against, and a naive search matches
// that.
const limitsCode = limitsSrc
	.split('\n')
	.filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('/*') && !l.trim().startsWith('//'))
	.join('\n');

for (const name of ['REPEAT_PENALTY', 'REPEAT_PENALTY_TOKENS']) {
	check(`${name} is not read from the config`, () => {
		// The config's repeatPenalty is 1.15 and was never read.
		const alias = new RegExp(
			`export const ${name}\\s*=\\s*config\\.generation\\.repeatPenalty`,
		);
		return !alias.test(limitsCode)
			? true
			: 'it aliases config.generation.repeatPenalty, which was never read';
	});
}

console.log('\n=== the config\'s inert repetition settings are visible ===');

const { default: config } = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'config', 'index.ts')).href
) as { default: any };

check('the config still says 1.15 — the divergence is recorded, not hidden', () =>
	config.generation.repeatPenalty === 1.15
		? true
		: `the config says ${config.generation.repeatPenalty}`);

check('the module exposes the config values for the record', () =>
	limits.CONFIG_REPEAT_PENALTY === config.generation.repeatPenalty
		? true
		: 'the module does not expose the config value');

console.log('\n=== neither route imports the limits from the other ===');

const indexSrc = fs.readFileSync(path.join(ROUTER, 'src', 'index.ts'), 'utf8');
const chatSrc = fs.readFileSync(
	path.join(ROUTER, 'src', 'router', 'chatRoutes.ts'), 'utf8',
);

check('chatRoutes.ts does not import from ../index.js', () =>
	!/from\s+'\.\.\/index\.js'/.test(chatSrc)
		? true
		: 'it still imports from index.ts — that is a circular import waiting to happen');

check('index.ts does not import from chatRoutes.ts', () =>
	!/from\s+'\.\/router\/chatRoutes\.js'/.test(indexSrc)
		? true
		: 'it imports chatRoutes.ts — that is a circular import');

console.log('\n=== both routes import the limits from the module ===');

check('index.ts imports them from generation/limits.js', () =>
	/from\s+'\.\/generation\/limits\.js'/.test(indexSrc)
		? true
		: 'it does not');

check('chatRoutes.ts imports them from generation/limits.js', () =>
	/from\s+'\.\.\/generation\/limits\.js'/.test(chatSrc)
		? true
		: 'it does not');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The limits keep the values the route was using.');
