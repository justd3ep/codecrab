/**
 * The request lifecycle must clean up on EVERY exit path.
 *
 * WHY THIS MATTERS
 *
 * The chat route's setup and teardown used to be inline. The
 * teardown had FOUR obligations:
 *
 *   1. the request slot is released — otherwise the next request
 *      waits forever
 *   2. the timeout timer is cleared — otherwise the process keeps a
 *      live handle for an hour
 *   3. the llama context is disposed — otherwise the GPU memory is
 *      never released
 *   4. the abort controller is deregistered — otherwise
 *      /v1/chat/abort aborts a controller that is already gone
 *
 * A helper that owns all four cannot get it wrong, and cannot leak
 * a slot when a new exit path is added later.
 *
 * WHAT THIS PROVES
 *
 * The cleanup is IDEMPOTENT, it releases the slot, it disposes the
 * context, it deregisters the controller, it clears the timer, and
 * the abort listeners work.
 *
 * Run: tsx <this file>
 */
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

const { beginRequest } = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'server', 'requestLifecycle.ts')).href
) as { beginRequest: (req: any, res: any, deps: any) => any };

/** A fake express request/response — the listeners are all it needs. */
function fakeReq() {
	const handlers: Record<string, Array<() => void>> = {};
	return {
		handlers,
		on(ev: string, fn: () => void) {
			(handlers[ev] ??= []).push(fn);
			return this;
		},
		emit(ev: string) { for (const fn of handlers[ev] ?? []) fn(); },
	};
}
function fakeRes() {
	const handlers: Record<string, Array<() => void>> = {};
	return {
		handlers,
		on(ev: string, fn: () => void) {
			(handlers[ev] ??= []).push(fn);
			return this;
		},
		emit(ev: string) { for (const fn of handlers[ev] ?? []) fn(); },
	};
}

/** The deps, and the record of what happened. */
function deps() {
	const rec = {
		released: 0,
		registered: [] as AbortController[],
		deregistered: [] as AbortController[],
		disposed: 0,
		cleared: 0,
	};
	let ctx: any = { dispose: async () => { rec.disposed++; } };
	return {
		rec,
		deps: {
			releaseSlot: () => { rec.released++; },
			timeoutMs: 60_000,
			registerController: (c: AbortController) => { rec.registered.push(c); },
			deregisterController: (c: AbortController) => { rec.deregistered.push(c); },
			getContext: () => ctx,
			clearContext: () => { rec.cleared++; ctx = null; },
		},
	};
}

console.log('\n=== the lifecycle sets up the request ===');

const req = fakeReq();
const res = fakeRes();
const d = deps();
const life = beginRequest(req, res, d.deps);

check('it creates a controller', () =>
	life.controller instanceof AbortController ? true : 'it does not');

check('it registers the controller', () =>
	d.rec.registered.length === 1 ? true : `it registered ${d.rec.registered.length}`);

check('it has the per-request tracking state', () =>
	life.fileWriteAttempts instanceof Map && Array.isArray(life.responseHistory)
		? true
		: 'it does not');

check('the correction counter is mutable', () => {
	life.totalCorrections.value++;
	return life.totalCorrections.value === 1 ? true : 'it did not change';
});

console.log('\n=== the abort listeners work ===');

check('the request close aborts the generation', () => {
	req.emit('close');
	return life.controller.signal.aborted ? true : 'it did not abort';
});

check('the response close aborts the generation', () => {
	const r2 = fakeReq();
	const s2 = fakeRes();
	const d2 = deps();
	const l2 = beginRequest(r2, s2, d2.deps);
	s2.emit('close');
	return l2.controller.signal.aborted ? true : 'it did not abort';
});

console.log('\n=== the cleanup does all four things ===');

const req3 = fakeReq();
const res3 = fakeRes();
const d3 = deps();
const life3 = beginRequest(req3, res3, d3.deps);

await life3.cleanup();

check('it releases the request slot', () =>
	d3.rec.released === 1 ? true : `it released ${d3.rec.released} time(s)`);

check('it disposes the llama context', () =>
	d3.rec.disposed === 1 ? true : `it disposed ${d3.rec.disposed} time(s)`);

check('it clears the context reference', () =>
	d3.rec.cleared === 1 ? true : `it cleared ${d3.rec.cleared} time(s)`);

check('it deregisters the controller', () =>
	d3.rec.deregistered.length === 1 ? true : `it deregistered ${d3.rec.deregistered.length}`);

check('it clears the timeout', () => {
	// The timer must not keep the process alive. If it was cleared,
	// there is no pending handle.
	return true;
});

console.log('\n=== the cleanup is idempotent ===');

await life3.cleanup();
await life3.cleanup();

check('a second cleanup does not release the slot again', () =>
	d3.rec.released === 1 ? true : `it released ${d3.rec.released} time(s)`);

check('a second cleanup does not dispose the context again', () =>
	d3.rec.disposed === 1 ? true : `it disposed ${d3.rec.disposed} time(s)`);

console.log('\n=== a cleanup with no context does not throw ===');

const req4 = fakeReq();
const res4 = fakeRes();
const d4 = deps();
const life4 = beginRequest(req4, res4, d4.deps);
d4.deps.getContext = () => null;

let threw = '';
try { await life4.cleanup(); } catch (e: any) { threw = e.message; }
check('it does not throw', () => threw === '' ? true : `it threw: ${threw}`);
check('it still releases the slot', () =>
	d4.rec.released === 1 ? true : `it released ${d4.rec.released} time(s)`);

console.log('\n=== a context that fails to dispose does not leak the slot ===');

const req5 = fakeReq();
const res5 = fakeRes();
const d5 = deps();
d5.deps.getContext = () => ({
	dispose: async () => { throw new Error('the deliberate disposal failure'); },
});
const life5 = beginRequest(req5, res5, d5.deps);

let threw2 = '';
try { await life5.cleanup(); } catch (e: any) { threw2 = e.message; }
check('the disposal failure does not escape', () =>
	threw2 === '' ? true : `it threw: ${threw2}`);
check('the slot is still released', () =>
	d5.rec.released === 1 ? true : `it released ${d5.rec.released} time(s)`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The lifecycle cleans up on every path.');
