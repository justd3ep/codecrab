/**
 * The golden fixture test.
 *
 * This is the artifact that makes a refactor of `src/index.ts` safe.
 *
 * The other 200+ assertions test the pieces in isolation. This one tests
 * the WHOLE extraction path — the live `extractFallbackEdits`, with its
 * real dependencies (`cleanCodeBlock`, `inferFilePath`, `extractRawCode`)
 * — against REAL model responses, and asserts the result is unchanged.
 *
 * If a refactor changes what the router extracts from a response, this
 * fails. That is the whole point.
 *
 * HOW TO ADD A FIXTURE
 *   1. Capture a real model response:
 *        tsx scratch/capture-fixture.ts <name> <file>
 *   2. Commit both `fixtures/<name>.json` and `fixtures/<name>.response.txt`.
 *   3. Re-run this test. It picks the new fixture up automatically.
 *
 * A fixture whose `expect` block is empty is rejected: an empty
 * expectation asserts nothing, and would let a regression through.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.resolve(HERE, '..');
const FIXTURES = path.join(HERE, 'fixtures');

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

/**
 * The LIVE extractor, loaded the same way the capture script loads it:
 * out of the real source, with its real dependencies, evaluated with the
 * real Node environment.
 *
 * The loader is imported from the capture script so there is ONE
 * implementation — if the two disagreed, the fixture would assert
 * against a different function than the one the router runs.
 */
const captureModule = await import(
	pathToFileURL(path.join(HERE, 'capture-fixture.ts')).href
) as { loadAll?: () => { extractFallbackEdits: (t: string, o?: string[], w?: string, u?: string, m?: string, oc?: boolean) => Array<{ path: string; content: string }> } };

if (typeof captureModule.loadAll !== 'function') {
	console.error('FATAL: capture-fixture.ts does not export loadAll()');
	process.exit(2);
}

const { extractFallbackEdits } = captureModule.loadAll();

// ── the fixtures ────────────────────────────────────────────────────────
const fixtureFiles = fs.existsSync(FIXTURES)
	? fs.readdirSync(FIXTURES).filter(f => f.endsWith('.json')).sort()
	: [];

console.log('\n=== the golden fixtures ===');

check('at least one fixture exists', () =>
	fixtureFiles.length > 0 ? true : `no fixtures in ${FIXTURES} — capture one with capture-fixture.ts`);

check('every fixture has a matching .response.txt', () => {
	const missing = fixtureFiles.filter(f => {
		const base = f.replace(/\.json$/, '');
		return !fs.existsSync(path.join(FIXTURES, `${base}.response.txt`));
	});
	return missing.length === 0 ? true : `missing: ${missing.join(', ')}`;
});

for (const file of fixtureFiles) {
	const name = file.replace(/\.json$/, '');
	const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
	const raw = fs.readFileSync(path.join(FIXTURES, `${name}.response.txt`), 'utf8');

	console.log(`\n--- ${name} ---`);

	check(`${name}: the response is non-empty`, () =>
		fixture.response && fixture.response.trim().length > 0 ? true : 'the response is empty');

	check(`${name}: the .response.txt matches the recorded response`, () => {
		// Compare the NORMALISED text. Git's core.autocrlf converts LF to
		// CRLF on checkout on Windows, so the committed .response.txt has
		// CRLF on disk while the JSON's string has LF. The line ending
		// is not part of the behaviour — the extractor sees the same
		// code either way — so the fixture must not pin it.
		const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
		return norm(raw) === norm(fixture.response)
			? true
			: 'the .txt and the .json disagree (ignoring line endings) — re-capture the fixture';
	});

	check(`${name}: the fixture is labelled`, () =>
		typeof fixture.synthetic === 'boolean' ? true : 'the fixture does not say whether it is synthetic');

	check(`${name}: the expectation is meaningful`, () => {
		// An empty expectation IS meaningful for a response that should
		// produce nothing (prose, an explanation). But it is only
		// meaningful if the fixture SAYS so — otherwise a fixture whose
		// extraction silently broke to zero would look fine.
		//
		// Two shapes are accepted:
		//   expect.create[]                    the workspace-independent form
		//   expect.withWorkspace[]             the workspace-dependent form
		const std = fixture.expect?.create?.length ?? 0;
		const ws = fixture.expect?.withWorkspace?.length ?? 0;
		if (std > 0 || ws > 0) return true;
		return fixture.expectNoFiles === true
			? true
			: 'the expectation is empty and the fixture is not labelled `expectNoFiles`';
	});

	// ── the actual assertions ──────────────────────────────────────────
	//
	// A fixture may have two shapes:
	//
	//   expect.create / expect.edit / expect.onlyClosed
	//     the workspace-independent extraction
	//
	//   expect.withWorkspace / expect.withoutWorkspace
	//     the workspace-DEPENDENT extraction, used by the raw-code-p4
	//     fixture. Pattern 4 only runs when a workspace is given, so
	//     these are the only assertions that cover it.
	//
	// A fixture with neither shape asserts nothing, so it is rejected
	// above.
	const hasStandardShape = Array.isArray(fixture.expect?.create);
	const hasWorkspaceShape = Array.isArray(fixture.expect?.withWorkspace);

	if (hasStandardShape) {
	for (const mode of ['create', 'edit'] as const) {
		check(`${name}: ${mode} mode extracts the same files`, () => {
			const actual = extractFallbackEdits(
				fixture.response, undefined, undefined, undefined, mode, false);
			const expected = fixture.expect[mode] as Array<{ path: string; content: string }>;
			const a = actual.map(e => e.path).join(', ');
			const e = expected.map(x => x.path).join(', ');
			return a === e ? true : `paths differ — expected [${e}], got [${a}]`;
		});

		check(`${name}: ${mode} mode extracts the same content`, () => {
			const actual = extractFallbackEdits(
				fixture.response, undefined, undefined, undefined, mode, false);
			const expected = fixture.expect[mode] as Array<{ path: string; content: string }>;
			if (actual.length !== expected.length) {
				return `count differs — expected ${expected.length}, got ${actual.length}`;
			}
			for (let i = 0; i < actual.length; i++) {
				if (actual[i]!.content !== expected[i]!.content) {
					return `content differs for ${expected[i]!.path} ` +
						`(expected ${expected[i]!.content.length} chars, got ${actual[i]!.content.length})`;
				}
			}
			return true;
		});
	}

	check(`${name}: onlyClosed extracts the same files`, () => {
		const actual = extractFallbackEdits(
			fixture.response, undefined, undefined, undefined, 'create', true);
		const expected = fixture.expect.onlyClosed as Array<{ path: string; content: string }>;
		const a = actual.map(e => e.path).join(', ');
		const e = expected.map(x => x.path).join(', ');
		return a === e ? true : `paths differ — expected [${e}], got [${a}]`;
	});
	} // end if (hasStandardShape)

	// ── the WORKSPACE-aware fixture ───────────────────────────────────
	//
	// Pattern 4 (the raw-code rescue) is guarded by
	// `edits.length === 0 && workspaceRoot`. Every other fixture calls
	// the extractor with workspaceRoot UNDEFINED, so Pattern 4 never
	// ran — a regression in the raw-code rescue would have passed every
	// test. This fixture is the one that exercises it.
	if (hasWorkspaceShape) {
		const WS = path.join(os.tmpdir(), `hermes-golden-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(path.join(WS, 'src'), { recursive: true });
		try {
			check(`${name}: WITH a workspace, the raw-code rescue still works`, () => {
				const actual = extractFallbackEdits(
					fixture.response, undefined, WS, undefined, 'create', false);
				const expected = fixture.expect.withWorkspace as Array<{ path: string; content: string }>;
				const a = actual.map(e => e.path).join(', ');
				const e = expected.map(x => x.path).join(', ');
				return a === e ? true : `paths differ — expected [${e}], got [${a}]`;
			});

			check(`${name}: WITHOUT a workspace, nothing is extracted`, () => {
				const actual = extractFallbackEdits(
					fixture.response, undefined, undefined, undefined, 'create', false);
				const expected = fixture.expect.withoutWorkspace as Array<{ path: string; content: string }>;
				const a = actual.map(e => e.path).join(', ');
				const e = expected.map(x => x.path).join(', ');
				return a === e ? true : `paths differ — expected [${e}], got [${a}]`;
			});
		} finally {
			fs.rmSync(WS, { recursive: true, force: true });
		}
	}

	// ── the fixture must be able to fail ───────────────────────────────
	// A fixture that asserts nothing is worse than no fixture: it looks
	// like protection and is not.
	check(`${name}: the fixture is capable of failing`, () => {
		// Append a <file> block and confirm the extraction CHANGES. If it
		// does not, the fixture is not actually pinning the behaviour.
		//
		// This mutation works for both kinds of fixture: one that expects
		// files gains another, and one that expects none gains its first.
		const mutated = fixture.response +
			'\n<file path="src/__mutation_probe.tsx">\nexport const probe = 1;\n</file>\n';
		// The workspace shape needs a workspace, or Pattern 4 never runs
		// and the mutation would not be observed.
		const WS2 = path.join(os.tmpdir(), `hermes-golden-mut-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(path.join(WS2, 'src'), { recursive: true });
		try {
			const run = (text: string, ws?: string) =>
				extractFallbackEdits(text, undefined, ws, undefined, 'create', false)
					.map(e => e.path).join('|');
			const before = hasWorkspaceShape
				? run(fixture.response, WS2)
				: run(fixture.response);
			const after = hasWorkspaceShape
				? run(mutated, WS2)
				: run(mutated);
			return before !== after
				? true
				: 'the extraction did not change when a file block was appended — the fixture pins nothing';
		} finally {
			fs.rmSync(WS2, { recursive: true, force: true });
		}
	});
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('Golden fixtures verified: the extraction path behaves exactly as captured.');
