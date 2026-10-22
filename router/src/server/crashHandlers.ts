/**
 * The router's crash handlers.
 *
 * WHY THEY LIVE HERE
 *
 * They used to be inline in index.ts, and a refactor deleted them:
 *
 *     0b82970  refactor: move the prompt builders and the ensemble router into their modules
 *
 * The router then died with exit code 1 and NO EXPLANATION — the
 * exact failure the handlers were added to prevent:
 *
 *     === router exited with code 1 ===
 *
 * So they live in their own module now, and index.ts imports them.
 * A module cannot be "lost" by moving code around it.
 *
 * WHAT THEY DO
 *
 * Without these, an unhandled rejection or an uncaught exception
 * terminates the router with exit code 1 and the reason goes
 * nowhere. A silent exit 1 is undiagnosable: it cost an hour of
 * bisection once. A logged one is a two-minute fix.
 *
 * The bind failure is reported explicitly, INCLUDING what to do about
 * it — EADDRINUSE is the common one, and the fix is a one-liner the
 * user can copy.
 */
import type { Server } from 'http';

/**
 * Install the crash handlers.
 *
 * @param getServer A getter for the server object, once it exists.
 *   The server is created after this call, so a getter is used
 *   rather than the object itself.
 */
export function installCrashHandlers(getServer: () => Server | undefined): void {
	// Without these, an unhandled rejection or an uncaught exception
	// terminates the router with exit code 1 and the reason goes
	// nowhere.
	process.on('uncaughtException', (err: any) => {
		console.error(`[Router] UNCAUGHT EXCEPTION: ${err?.stack ?? err?.message ?? String(err)}`);
		process.exit(1);
	});

	process.on('unhandledRejection', (reason: any) => {
		console.error(`[Router] UNHANDLED REJECTION: ${reason?.stack ?? reason?.message ?? String(reason)}`);
		process.exit(1);
	});

	// The bind failure. app.listen(PORT, ...) does not KEEP the
	// server object, and a failed bind — EADDRINUSE, another router
	// already on the port — is an unhandled 'error' event on a server
	// nobody holds a reference to. Node throws it, and with no
	// handler the process exits 1.
	const server = getServer();
	if (server) {
		server.on('error', (err: NodeJS.ErrnoException) => {
			console.error(`[Router] FAILED TO LISTEN on port ${process.env.CODECRAB_PORT ?? 'the configured port'}: ${err.code ?? ''} ${err.message}`);
			if (err.code === 'EADDRINUSE') {
				console.error('[Router] Another process is already listening on this port.');
				console.error('[Router] Stop it (taskkill /F /PID <pid>) or change config.server.port.');
			}
			process.exit(1);
		});
	}
}
