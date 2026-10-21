/*---------------------------------------------------------------------------------------------
 *  CodeCrab Router Supervisor
 *
 *  Guarantees the local Model Router is running before the workbench tries to
 *  talk to it.
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  The CodeCrab chat panel lives in the workbench (Chromium) and reaches the
 *  router over plain HTTP on localhost. When the router was not running, the
 *  workbench's fetch failed with the notoriously opaque
 *  `TypeError: Failed to fetch`, which surfaced in the chat panel as a raw
 *  stack trace with no hint about what was actually wrong.
 *
 *  The router is a separate Node process with its own GGUF models, so it has
 *  to be started independently. This supervisor makes that automatic:
 *
 *    1. Probe the router's /health endpoint.
 *    2. If it answers, do nothing — someone else already owns the port.
 *    3. If it does not answer, spawn the router and wait for it to come up.
 *
 *  The supervisor never throws: a failure to start the router degrades to
 *  "the router is offline" (which the UI already renders nicely) rather than
 *  blocking the editor from starting.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

const DEFAULT_ROUTER_URL = 'http://localhost:3141';
const HEALTH_TIMEOUT_MS = 2000;
const BOOT_TIMEOUT_MS = 180_000; // 3 min — GGUF models can take a while to mmap
const PROBE_INTERVAL_MS = 500;

/**
 * Probe the router's /health endpoint.
 * Resolves true when the router answers, false on any connection error.
 */
function probeHealth(routerUrl: string, timeoutMs: number): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		let url: URL;
		try {
			url = new URL('/health', routerUrl);
		} catch {
			resolve(false);
			return;
		}

		const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
		const req = transport(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port || (url.protocol === 'https:' ? 443 : 80),
				path: url.pathname,
				method: 'GET',
				timeout: timeoutMs,
			},
			res => {
				res.resume();
				resolve((res.statusCode ?? 500) < 500);
			}
		);

		req.on('error', () => resolve(false));
		req.on('timeout', () => {
			req.destroy();
			resolve(false);
		});
		req.end();
	});
}

/** Wait until the router answers /health, or the timeout elapses. */
async function waitForRouter(routerUrl: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await probeHealth(routerUrl, HEALTH_TIMEOUT_MS)) {
			return true;
		}
		await new Promise(r => setTimeout(r, PROBE_INTERVAL_MS));
	}
	return false;
}

/**
 * Locate the router directory relative to the editor install.
 *
 * Layout:
 *   <repo>/vscode/   ← the editor
 *   <repo>/router/   ← the router
 */
export function findRouterDir(appRoot: string): string | null {
	const candidates = [
		path.join(appRoot, '..', 'router'),
		path.join(appRoot, 'router'),
		path.join(appRoot, '..', '..', 'router'),
	];
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(path.join(candidate, 'package.json'))
				&& fs.existsSync(path.join(candidate, 'src', 'index.ts'))) {
				return path.resolve(candidate);
			}
		} catch {
			// ignore and try the next candidate
		}
	}
	return null;
}

/**
 * Resolve the router's entry script, preferring the local tsx runner.
 *
 * The tsx CLI is spawned as `node <tsx-cli.mjs> <entry>` rather than as a
 * bare executable: a bare `tsx.cmd` on Windows has to go through a shell,
 * which mangles paths containing spaces (this repo lives under
 * "D:\fedora backup\...") and fails with
 * "'D:\fedora' is not recognized as an internal or external command".
 * Going through node with an argv array avoids the shell entirely.
 */
function resolveRouterCommand(routerDir: string): { command: string; args: string[] } | null {
	const entry = path.join(routerDir, 'src', 'index.ts');
	const tsxCli = path.join(routerDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');

	// Preferred: node + local tsx (no shell involved).
	if (fs.existsSync(tsxCli)) {
		return { command: process.execPath, args: [tsxCli, entry] };
	}

	// Fall back to a global tsx / npx.
	if (process.platform === 'win32') {
		return { command: 'npx.cmd', args: ['tsx', entry] };
	}
	return { command: 'npx', args: ['tsx', entry] };
}

/**
 * Start the router if it is not already running.
 *
 * @param appRoot The editor's install root (used to locate the router).
 * @param routerUrl The configured router base URL.
 * @param log A logger with `info`/`warn`/`error` methods.
 */
export async function ensureRouterRunning(
	appRoot: string,
	routerUrl: string = DEFAULT_ROUTER_URL,
	log?: { info(m: string): void; warn(m: string): void; error(m: string): void }
): Promise<boolean> {
	const say = {
		info: (m: string) => log?.info(m),
		warn: (m: string) => log?.warn(m),
		error: (m: string) => log?.error(m),
	};

	try {
		if (await probeHealth(routerUrl, HEALTH_TIMEOUT_MS)) {
			say.info(`[CodeCrab] Router already running at ${routerUrl}.`);
			return true;
		}
	} catch {
		// probe never throws
	}

	const routerDir = findRouterDir(appRoot);
	if (!routerDir) {
		say.warn(`[CodeCrab] Could not locate the router directory near "${appRoot}". Start it manually with: cd router && npm run dev`);
		return false;
	}
	say.info(`[CodeCrab] Starting router from ${routerDir}...`);

	const cmd = resolveRouterCommand(routerDir);
	if (!cmd) {
		say.warn('[CodeCrab] Could not resolve a router start command.');
		return false;
	}

	// Log to a file descriptor rather than to pipes.
	//
	// Two reasons:
	//  1. A pipe breaks the moment the editor (or the test harness) exits.
	//     The router then gets EPIPE on its next log write and dies
	//     mid-session.
	//  2. Handing the child the real file descriptor means the router keeps
	//     writing to the log after the editor closes, and the model stays
	//     warm instead of re-loading several GB of GGUF weights on every
	//     launch.
	let logFd: number | null = null;
	let logPath: string | null = null;
	try {
		const logDir = path.join(routerDir, '.crabcode');
		fs.mkdirSync(logDir, { recursive: true });
		logPath = path.join(logDir, 'router.log');
		logFd = fs.openSync(logPath, 'a');
		fs.writeSync(logFd, `\n=== router started ${new Date().toISOString()} ===\n`);
	} catch {
		logFd = null;
		logPath = null;
	}

	let child: ChildProcess;
	try {
		child = spawn(cmd.command, cmd.args, {
			cwd: routerDir,
			// Detached on EVERY platform.
			//
			// On Windows, a non-detached child stays in the parent's job
			// object, so it is killed when the parent exits — verified:
			//   detached=false → router DIED with the parent
			//   detached=true  → router SURVIVED
			// The router is a service, not a child of the editor: it must
			// outlive the editor and be stopped explicitly (stop.bat, or
			// taskkill on port 3141).
			detached: true,
			// The child inherits the log file descriptor directly. No pipes,
			// so nothing can break when this process exits.
			stdio: logFd !== null
				? ['ignore', logFd, logFd]
				: ['ignore', 'ignore', 'ignore'],
			// No shell: the command is an argv array, so paths containing
			// spaces stay intact.
			shell: false,
			env: { ...process.env },
		});
	} catch (e: any) {
		say.error(`[CodeCrab] Failed to spawn the router: ${e?.message ?? e}`);
		if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* ignore */ } }
		return false;
	}

	child.on('error', (e: any) => {
		say.error(`[CodeCrab] Router process error: ${e?.message ?? e}`);
	});
	child.on('exit', (code: number | null) => {
		if (logFd !== null) {
			try {
				fs.writeSync(logFd, `=== router exited with code ${code} ===\n`);
				fs.closeSync(logFd);
			} catch { /* ignore */ }
		}
		if (code !== 0 && code !== null) {
			say.warn(`[CodeCrab] Router process exited with code ${code}.`);
		}
	});

	// The router is a service, not a child of the editor. `unref()` removes
	// the child handle from this process's event loop so the editor can
	// exit cleanly on its own while the router keeps running. Without it,
	// Node waits for the child forever and the editor never quits.
	//
	// The stdio streams need no equivalent: they are inherited file
	// descriptors (or /dev/null), never pipes, so they do not hold the
	// event loop open and `child.stdout` is always null.
	child.unref();

	const up = await waitForRouter(routerUrl, BOOT_TIMEOUT_MS);
	if (up) {
		say.info(`[CodeCrab] Router is up at ${routerUrl}${logPath ? ` (log: ${logPath})` : ''}.`);
	} else {
		say.warn(`[CodeCrab] Router did not answer on ${routerUrl} within ${BOOT_TIMEOUT_MS / 1000}s. The chat panel will report the router as offline.`);
	}
	return up;
}
