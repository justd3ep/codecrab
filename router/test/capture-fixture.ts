/**
 * Capture golden fixtures.
 *
 * A golden fixture is a REAL model response, saved to disk, together with
 * the extraction result it must produce. It is the artifact that makes a
 * refactor of `src/index.ts` safe: if the extraction path changes
 * behaviour, the fixture test fails.
 *
 * WHY REAL RESPONSES
 * Invented inputs test the code against your assumptions. Real inputs
 * test it against reality — including the weird shapes the model
 * actually produces (truncated mid-word, prose before the code, a
 * missing closing tag, a stray ``` fence).
 *
 * HOW TO CAPTURE
 *   1. Start the router:      npm start
 *   2. Send a prompt to it and keep the raw response.
 *   3. Run:  tsx scratch/capture-fixture.ts <name> <file>
 *      or pipe it:  ... | tsx scratch/capture-fixture.ts <name> -
 *
 * The script extracts the response with the LIVE extractor, records the
 * result, and writes it to router/scratch/fixtures/.
 *
 * A fixture is only trustworthy if it came from a real model. Hand-made
 * fixtures are allowed but must be labelled `synthetic: true` so nobody
 * mistakes them for evidence.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.resolve(HERE, '..');
const FIXTURES = path.join(HERE, 'fixtures');





// ══════════════════════════════════════════════════════════════════════
// Lexical scanning
// ══════════════════════════════════════════════════════════════════════

export async function loadAll() {
	const helpers = await import('../src/generation/pipelineHelpers.js');
	return {
		extractFallbackEdits: helpers.extractFallbackEdits as (
			text: string, openFiles?: string[], workspaceRoot?: string, userPrompt?: string, mode?: string, onlyClosed?: boolean,
		) => Array<{ path: string; content: string }>,
	};
}

/**
 * Load ONE exported function from ONE source module, by importing it.
 *
 * @param file   a path relative to the router root, e.g.
 *               'src/generation/pipelineHelpers.ts'
 * @param name   the export to load
 */
export async function loadFunction(file: string, name: string): Promise<(...args: any[]) => any> {
	const abs = path.join(ROUTER, file);
	if (!fs.existsSync(abs)) {
		throw new Error(`${file} does not exist`);
	}
	const mod = await import(pathToFileURL(abs).href) as Record<string, unknown>;
	const fn = mod[name];
	if (typeof fn !== 'function') {
		throw new Error(`${file} does not export a function named ${name}`);
	}
	return fn as (...args: any[]) => any;
}

// ══════════════════════════════════════════════════════════════════════

async function main() {
	const name = process.argv[2];
	const source = process.argv[3];

	if (!name || !source) {
		console.error('usage: tsx scratch/capture-fixture.ts <name> <file|->');
		console.error('');
		console.error('  <file>  a file containing the raw model response');
		console.error('  -       read the response from stdin');
		console.error('');
		console.error('Example:');
		console.error('  tsx scratch/capture-fixture.ts dashboard-tagged response.txt');
		process.exit(2);
	}

	let response: string;
	if (source === '-') {
		const chunks: Buffer[] = [];
		for await (const c of process.stdin) chunks.push(Buffer.from(c));
		response = Buffer.concat(chunks).toString('utf8');
	} else {
		const p = path.resolve(source);
		if (!fs.existsSync(p)) {
			console.error(`FATAL: ${p} does not exist`);
			process.exit(2);
		}
		response = fs.readFileSync(p, 'utf8');
	}

	if (response.trim().length === 0) {
		console.error('FATAL: the response is empty — an empty fixture would assert nothing');
		process.exit(2);
	}

	const { extractFallbackEdits } = await loadAll();

	// Extract under both modes, so the fixture pins the create/edit
	// distinction too, and under onlyClosed, which the compaction paths
	// use.
	const asCreate = extractFallbackEdits(response, undefined, undefined, undefined, 'create', false);
	const asEdit = extractFallbackEdits(response, undefined, undefined, undefined, 'edit', false);
	const onlyClosed = extractFallbackEdits(response, undefined, undefined, undefined, 'create', true);

	fs.mkdirSync(FIXTURES, { recursive: true });

	const fixture = {
		name,
		capturedAt: new Date().toISOString(),
		synthetic: false,
		note:
			'Captured from a real model response. The `expect` block is the ' +
			'extraction result at capture time; the fixture test asserts it ' +
			'does not change.',
		response,
		expect: {
			create: asCreate.map(e => ({ path: e.path, content: e.content })),
			edit: asEdit.map(e => ({ path: e.path, content: e.content })),
			onlyClosed: onlyClosed.map(e => ({ path: e.path, content: e.content })),
		},
	};

	const outPath = path.join(FIXTURES, `${name}.json`);
	fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2), 'utf8');
	fs.writeFileSync(path.join(FIXTURES, `${name}.response.txt`), response, 'utf8');

	console.log(`Captured "${name}"`);
	console.log(`  response:    ${response.length} chars`);
	console.log(`  create mode: ${asCreate.length} edit(s)`);
	for (const e of asCreate) console.log(`      ${e.path}  (${e.content.length} chars)`);
	console.log(`  edit mode:   ${asEdit.length} edit(s)`);
	console.log(`  onlyClosed:  ${onlyClosed.length} edit(s)`);
	console.log(`  written to:  ${outPath}`);
	console.log('');
	console.log('Review the result before committing it — the fixture now asserts this behaviour.');
}

// Only run the capture when this file is executed directly. When it is
// IMPORTED (by the golden fixture test), the loader is used and no
// capture happens.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main();
}
