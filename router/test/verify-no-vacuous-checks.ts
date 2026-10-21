/**
 * The vacuity check.
 *
 * A SOURCE-TEXT CHECK CAN PASS FOR THE WRONG REASON.
 *
 * The dangerous shape is:
 *
 *     const i = SRC.indexOf('MARKER');
 *     const body = SRC.slice(i, i + 2000);
 *     return !body.includes('X') ? true : '...';
 *
 * If MARKER is not in SRC, `i` is -1 and `slice(-1, 1999)` returns
 * the LAST 2000 characters of the file. The `!body.includes('X')`
 * check then passes — for the wrong reason.
 *
 * This bit us for real: when the scaffold guard moved out of
 * src/index.ts, the P1.7 check for package.json still looked in
 * indexLive, so it read the end of the file instead of the set, and
 * passed without checking anything.
 *
 * WHAT THIS PROVES
 *
 *   1. Every source-text check in the suite is either
 *        - guarded: it asserts the marker was found, or
 *        - about the ABSENCE of the marker, which is safe.
 *   2. The P1.7 checks look at the guard's real home.
 *   3. The checks that read a CONCATENATED source still find their
 *      markers.
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
import path from 'path';

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

const TEST = path.join(ROUTER, 'test');
const read = (rel: string) => fs.readFileSync(path.join(ROUTER, rel), 'utf8');

console.log('\n=== 1. the P1.7 checks look at the guard\'s real home ===');

const phase1 = read('test/verify-phase1.ts');

check('the package.json check reads the guard module, not index.ts', () =>
	/const i = guardSrc\.indexOf\('const SCAFFOLD_OWNED_FILES'\)/.test(phase1)
		? true : 'it still reads indexLive');

check('the App.tsx check reads the guard module, not index.ts', () =>
	!/const i = indexLive\.indexOf\('const SCAFFOLD_OWNED_FILES'\)/.test(phase1)
		? true : 'it still reads indexLive');

check('no P1.7 check slices indexLive for the set', () =>
	!/indexLive\.(indexOf|slice)\([^)]*SCAFFOLD_OWNED_FILES/.test(phase1)
		? true : 'a check still looks in indexLive');

console.log('\n=== 2. every indexOf(marker) in the suite is guarded or about absence ===');

// A source-text check that slices from an indexOf result must either
// guard the -1, or be checking for the marker's ABSENCE.
const PAT = /const\s+(\w+)\s*=\s*(\w+)\.indexOf\(\s*'([^']*)'\s*\);/g;

for (const file of fs.readdirSync(TEST).filter(f => f.endsWith('.ts'))) {
	const text = read(path.join('test', file));
	const lines = text.split('\n');

	for (let n = 0; n < lines.length; n++) {
		for (const m of lines[n].matchAll(PAT)) {
			const [, varName, src, marker] = m;
			if (!marker) continue;

			// Does this index get sliced?
			const window = lines.slice(n, n + 12).join('\n');
			if (!new RegExp(`\\b${varName}\\.slice\\(`).test(window)) continue;

			// Is the -1 guarded?
			const guarded =
				new RegExp(`${varName}\\s*<\\s*0`).test(window) ||
				new RegExp(`${varName}\\s*===\\s*-1`).test(window) ||
				new RegExp(`${varName}\\s*!==\\s*-1`).test(window);

			// Is the check about the marker's ABSENCE? Then -1 is
			// harmless — but the check is still meaningless, so it
			// must be written the other way round.
			const aboutAbsence = new RegExp(
				`!\\s*${varName}\\s*===?\\s*-1|!\\w+\\.includes\\(`
			).test(window) && new RegExp(`!.*includes\\('${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(window);

			check(
				`${file}:${n + 1} — ${src}.indexOf('${marker}') is guarded`,
				() => guarded
					? true
					: aboutAbsence
						? 'it slices from an unguarded index, and the check is about absence'
						: 'it slices from an unguarded index',
			);
		}
	}
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('No source-text check can pass for the wrong reason.');
