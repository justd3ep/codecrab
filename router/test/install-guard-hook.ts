/**
 * The pre-commit guard.
 *
 * A test suite that nobody runs is a test suite that protects nothing.
 * This hook makes the suite run automatically before a commit that
 * touches the router's source.
 *
 * WHAT IT BLOCKS
 *   A commit that changes the router's source while the test suite is
 *   red. That is the rule that makes a refactor of `src/index.ts` safe:
 *   you cannot commit a behaviour change that the tests did not catch.
 *
 * WHAT IT DOES NOT BLOCK
 *   A commit that only touches docs, plans, prompts, or the scratch
 *   directory. Those cannot change the router's behaviour, and forcing
 *   a test run for them would train you to bypass the hook.
 *
 * HOW TO INSTALL
 *   node scratch/install-guard-hook.mjs
 *
 * It writes .git/hooks/pre-commit. The hook is NOT committed — it lives
 * in .git/, which is local to your machine. That is intentional: the
 * guard is a local safety net, and a hook that silently does nothing on
 * someone else's machine is worse than no hook at all. The hook prints
 * a warning if it detects that it is running in a repo where the suite
 * is expected but missing.
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.resolve(HERE, '..');
const REPO = path.resolve(ROUTER, '..');

/**
 * The paths that CAN change the router's behaviour. A commit touching
 * only anything else skips the test run.
 */
const WATCHED = [
	'router/src/',
	'router/package.json',
	'router/tsconfig.json',
	'vscode/src/',
];

/** Paths that never need the suite to run. */
const EXEMPT = [
	'router/scratch/',
	'plans/',
	'docs/',
	'.md',
	'.gitignore',
	'LICENSE',
];

function sh(cmd: string, args: string[], cwd = REPO): string {
	return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}

function isExempt(file: string): boolean {
	return EXEMPT.some(e => file === e || file.startsWith(e) || file.endsWith(e));
}

function isWatched(file: string): boolean {
	return WATCHED.some(w => file.startsWith(w)) && !isExempt(file);
}

function install() {
	const hooksDir = path.join(REPO, '.git', 'hooks');
	if (!fs.existsSync(hooksDir)) {
		console.error(`FATAL: ${hooksDir} does not exist — is this a git repo?`);
		process.exit(2);
	}

	const hookPath = path.join(hooksDir, 'pre-commit');
	if (fs.existsSync(hookPath)) {
		const existing = fs.readFileSync(hookPath, 'utf8');
		if (existing.includes('codecrab-guard')) {
			// Already installed. But is it the CURRENT version? An old
			// hook can be broken in ways that block every commit.
			// The marker below is bumped whenever the hook's logic
			// changes, so a stale hook is detected and replaced.
			const MARKER = 'codecrab-guard:v4';
			if (existing.includes(MARKER)) {
				console.log('The guard is already installed and up to date.');
				console.log(`  ${hookPath}`);
				return;
			}
			console.log('The guard is installed but is an OLDER version — replacing it.');
			console.log('  (an outdated hook can silently block every commit)');
		} else {
			const backup = hookPath + '.bak';
			fs.copyFileSync(hookPath, backup);
			console.log(`An existing hook was found. It was backed up to:\n  ${backup}`);
		}
	}

	const hook = `#!/bin/sh
# codecrab-guard:v4 — runs the router test suite before a commit that
# touches the router's source.
#
# Installed by router/test/install-guard-hook.ts
# To remove: delete .git/hooks/pre-commit
#
# NOTE: no \`set -e\` at the top. A hook that blocks a commit without
# explaining why is worse than no hook — the user learns to use
# --no-verify and the protection is gone. Every failure path below
# either explains itself or lets the commit through.

# Locate the repository root and the router directory.
#
# The paths MUST be absolute. Git runs the hook with the repo root as
# the working directory and $0 set to a RELATIVE path, so a relative
# candidate resolves correctly at first and then breaks after the hook
# changes directory — which made npm run in the wrong place and fail
# with "Missing script: test", blocking every commit.
HOOK_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
GIT_DIR="$(cd "$HOOK_DIR/.." 2>/dev/null && pwd)"
REPO_ROOT="$(cd "$GIT_DIR/.." 2>/dev/null && pwd)"

ROUTER_DIR=""
for candidate in "$REPO_ROOT/router" "$HOOK_DIR/../../router" "$HOOK_DIR/../../../router"; do
  if [ -f "$candidate/package.json" ] && [ -d "$candidate/test" ]; then
    ROUTER_DIR="$(cd "$candidate" 2>/dev/null && pwd)"
    break
  fi
done

if [ -z "$ROUTER_DIR" ]; then
  echo "  codecrab-guard: could not find the router directory — skipping the guard."
  echo "  (expected router/test/run-tests.ts next to the repo root)"
  exit 0
fi

# Which files are staged?
STAGED="$(git diff --cached --name-only 2>/dev/null || true)"
if [ -z "$STAGED" ]; then
  exit 0
fi

# Does anything staged touch the router's source?
NEEDS_TEST=0
for f in $STAGED; do
  case "$f" in
    router/scratch/*|plans/*|docs/*|*.md|.gitignore|LICENSE)
      continue ;;
  esac
  case "$f" in
    router/src/*|router/package.json|router/tsconfig.json|vscode/src/*)
      NEEDS_TEST=1
      ;;
  esac
done

if [ "$NEEDS_TEST" -eq 0 ]; then
  exit 0
fi

echo ""
echo "  codecrab-guard: the staged changes touch the router's source."
echo "  Running the test suite before the commit..."
echo ""

cd "$ROUTER_DIR" || {
  echo "  codecrab-guard: could not enter $ROUTER_DIR — skipping the guard."
  exit 0
}

# Prove we are in the right place before running npm. A wrong directory
# makes npm report "Missing script: test", which looks like a test
# failure rather than a hook bug.
if [ ! -f "test/run-tests.ts" ]; then
  echo "  codecrab-guard: $ROUTER_DIR does not look like the router — skipping the guard."
  exit 0
fi

# Mark the environment so the guard self-test knows it is running
# inside a hook and does not try to commit (which would recurse).
if ! CODECRAB_GUARD_ACTIVE=1 npm test; then
  echo ""
  echo "  codecrab-guard: the test suite FAILED — the commit was blocked."
  echo "  Fix the failures, or commit with --no-verify if you know why."
  echo ""
  exit 1
fi

exit 0
`;

	fs.writeFileSync(hookPath, hook, 'utf8');
	// Make it executable. On Windows the mode is not meaningful, but the
	// file is written with a shebang so Git Bash will run it.
	try { fs.chmodSync(hookPath, 0o755); } catch { /* Windows: no-op */ }

	console.log('The guard is installed.');
	console.log(`  ${hookPath}`);
	console.log('');
	console.log('From now on, a commit that touches router/src/ or vscode/src/');
	console.log('runs `npm test` first, and is blocked if the suite is red.');
	console.log('');
	console.log('Verify it:');
	console.log('  git add router/src/some-file.ts');
	console.log('  git commit -m "test"   # the suite should run');
}

function status() {
	const hookPath = path.join(REPO, '.git', 'hooks', 'pre-commit');
	if (!fs.existsSync(hookPath)) {
		console.log('The guard is NOT installed.');
		return;
	}
	const content = fs.readFileSync(hookPath, 'utf8');
	if (content.includes('codecrab-guard')) {
		console.log('The guard IS installed.');
		console.log(`  ${hookPath}`);
	} else {
		console.log('A pre-commit hook exists, but it is not the guard.');
		console.log(`  ${hookPath}`);
	}
}

const cmd = process.argv[2] || 'install';
if (cmd === 'install') install();
else if (cmd === 'status') status();
else {
	console.error(`unknown command: ${cmd} (use install | status)`);
	process.exit(2);
}
