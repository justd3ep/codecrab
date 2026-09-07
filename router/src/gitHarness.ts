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
 * Automatically creates an atomic git commit after an agent turn.
 */
export async function commitHarnessTurn(
	workspaceRoot: string,
	mode: 'create' | 'edit' | 'needs_context',
	userRequest: string,
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

		await execPromise('git add .', { cwd: workspaceRoot });

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
