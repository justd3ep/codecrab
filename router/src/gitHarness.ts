import fs from 'fs';
import path from 'path';
import { exec, execSync } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

/**
 * Ensures the workspace has an active git repository with basic author config.
 */
export async function ensureGitRepo(workspaceRoot: string): Promise<boolean> {
	try {
		const gitDir = path.join(workspaceRoot, '.git');
		if (!fs.existsSync(gitDir)) {
			await execPromise('git init', { cwd: workspaceRoot });
			try { await execPromise('git config core.filemode false', { cwd: workspaceRoot }); } catch { /* ignore */ }
			try { await execPromise('git config user.name "CodeCrab Agent"', { cwd: workspaceRoot }); } catch { /* ignore */ }
			try { await execPromise('git config user.email "agent@codecrab.local"', { cwd: workspaceRoot }); } catch { /* ignore */ }
			console.log(`[GitHarness] Initialized new git repository at ${workspaceRoot}`);
		}
		return true;
	} catch (e: any) {
		console.warn(`[GitHarness] Could not initialize git repository: ${e?.message || e}`);
		return false;
	}
}

/**
 * Mechanical Verification Hook: runs a non-destructive typecheck check if tsconfig.json exists.
 */
export async function verifyBuildStatus(workspaceRoot: string): Promise<{ passed: boolean; message: string }> {
	const tsconfig = path.join(workspaceRoot, 'tsconfig.json');
	if (!fs.existsSync(tsconfig)) {
		return { passed: true, message: 'No tsconfig.json found (check skipped).' };
	}

	try {
		await execPromise('npx tsc --noEmit', { cwd: workspaceRoot, timeout: 15000 });
		return { passed: true, message: 'Mechanical Quality Gate: TypeScript check passed (0 errors).' };
	} catch (e: any) {
		const stdout = e?.stdout || '';
		const stderr = e?.stderr || '';
		const combined = `${stdout}\n${stderr}`;
		const firstError = combined.split('\n').find((l: string) => l.includes('error TS')) || 'Type errors detected';
		return { passed: false, message: `Mechanical Quality Gate: ${firstError.trim()}` };
	}
}

/**
 * Stage the files an agent turn produced — and nothing else.
 *
 * Two rules, both learned the hard way:
 *
 *  1. NEVER `git add .` — it stages deletions. A run that removed or
 *     replaced an existing file would make that removal permanent.
 *  2. NEVER stage a deletion at all. If the agent deleted a file, the
 *     deletion stays in the working tree for the user to review.
 *
 * When `writtenFiles` is given, exactly those paths are staged. When it is
 * not, the modified and newly-created files are derived from
 * `git status --porcelain` — skipping every entry marked as deleted.
 *
 * Returns the number of paths staged.
 */
async function stageAgentFiles(workspaceRoot: string, writtenFiles?: string[]): Promise<number> {
	const paths: string[] = [];

	if (writtenFiles && writtenFiles.length > 0) {
		for (const f of writtenFiles) {
			// Skip anything that no longer exists on disk — a missing file is
			// a deletion, and deletions are never staged.
			if (!fs.existsSync(path.join(workspaceRoot, f))) continue;
			paths.push(f);
		}
	} else {
		// Fall back to the porcelain status, minus deletions.
		const { stdout } = await execPromise('git status --porcelain', { cwd: workspaceRoot });
		for (const line of (stdout || '').split('\n')) {
			if (!line.trim()) continue;
			const code = line.slice(0, 2);
			const file = line.slice(3).trim();
			if (!file) continue;
			// 'D' in either column means deleted. Never stage those.
			if (code.includes('D')) continue;
			// Renames appear as "R  old -> new"; stage the new path.
			const target = file.includes(' -> ') ? file.split(' -> ').pop()! : file;
			paths.push(target);
		}
	}

	if (paths.length === 0) return 0;

	// Stage them one at a time so a single bad path cannot abort the batch
	// and leave the index half-updated.
	let staged = 0;
	for (const p of paths) {
		try {
			await execPromise(`git add -- "${p}"`, { cwd: workspaceRoot });
			staged++;
		} catch (e: any) {
			console.warn(`[GitHarness] Could not stage "${p}": ${e?.message || e}`);
		}
	}
	console.log(`[GitHarness] Staged ${staged} agent-written file(s); deletions were NOT staged.`);
	return staged;
}

/**
 * Automatically creates an atomic git commit after an agent turn.
 */
export async function commitHarnessTurn(
	workspaceRoot: string,
	mode: 'create' | 'edit' | 'needs_context',
	userRequest: string,
	/** Files the agent actually produced. When provided, ONLY these are staged. */
	writtenFiles?: string[],
): Promise<{ committed: boolean; hash?: string; message?: string; buildStatus?: { passed: boolean; message: string } }> {
	try {
		const ready = await ensureGitRepo(workspaceRoot);
		if (!ready) return { committed: false };

		// Run mechanical check before finalizing commit
		const buildStatus = await verifyBuildStatus(workspaceRoot);

		// Check if there are uncommitted changes
		const { stdout: status } = await execPromise('git status --porcelain', { cwd: workspaceRoot });
		if (!status || !status.trim()) {
			return { committed: false, buildStatus };
		}

		// Stage ONLY what the agent produced.
		//
		// NEVER `git add .`: it stages deletions as well, so a run that
		// removed or replaced an existing file made that removal permanent.
		// In the test repo, commit 0aea0e8 deleted a working Kanban app
		// (src/KanbanBoard.tsx, src/KanbanColumn.tsx, src/types/kanban.ts)
		// and replaced src/App.tsx with a stub — because `git add .` staged
		// the deletions and the commit made them permanent.
		//
		// Rule: stage the specific paths the agent wrote, and never stage a
		// deletion.
		const staged = await stageAgentFiles(workspaceRoot, writtenFiles);
		if (staged === 0) {
			console.log('[GitHarness] No agent-written files to stage — nothing committed.');
			return { committed: false, buildStatus };
		}

		let commitMsg = '';
		if (mode === 'create') {
			commitMsg = 'chore(harness): initial scaffold, init.sh, and features.json';
		} else {
			// Find newly passed feature from features.json if available
			const featuresPath = path.join(workspaceRoot, 'features.json');
			let featureDesc = '';
			if (fs.existsSync(featuresPath)) {
				try {
					const raw = fs.readFileSync(featuresPath, 'utf-8');
					const features = JSON.parse(raw);
					if (Array.isArray(features)) {
						const passing = features.filter((f: any) => f.passes);
						if (passing.length > 0) {
							featureDesc = passing[passing.length - 1].description;
						}
					}
				} catch { /* ignore */ }
			}
			const summary = featureDesc || userRequest.replace(/[\r\n]+/g, ' ').slice(0, 60);
			commitMsg = `feat(harness): ${summary}`;
		}

		const escapedMsg = commitMsg.replace(/"/g, '\\"');
		await execPromise(`git commit -m "${escapedMsg}"`, { cwd: workspaceRoot });
		const { stdout: hash } = await execPromise('git rev-parse --short HEAD', { cwd: workspaceRoot });
		const shortHash = hash.trim();
		console.log(`[GitHarness] Commit created: ${shortHash} - "${commitMsg}"`);
		return { committed: true, hash: shortHash, message: commitMsg, buildStatus };
	} catch (e: any) {
		console.warn(`[GitHarness] Commit failed: ${e?.message || e}`);
		return { committed: false };
	}
}

/**
 * Returns a short log of recent git commits to orient subsequent agent sessions.
 */
export function getGitLogSummarySync(workspaceRoot: string, maxCommits = 5): string {
	try {
		const gitDir = path.join(workspaceRoot, '.git');
		if (!fs.existsSync(gitDir)) return '';
		return execSync(`git log -n ${maxCommits} --oneline`, { cwd: workspaceRoot, timeout: 2000, encoding: 'utf-8' }).trim();
	} catch {
		return '';
	}
}
