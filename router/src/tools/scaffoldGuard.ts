/**
 * The scaffold guard.
 *
 * A CREATE request must never let the model overwrite the files the
 * project scaffold owns. The scaffold created them; the model's
 * version is a guess, and a bad guess that clobbers vite.config.ts
 * or package.json breaks the project.
 *
 * An EDIT request may legitimately change vite.config.ts, so the
 * guard only applies to creates.
 */

/**
 * The files the scaffold owns.
 *
 * Note what is NOT here: `src/App.tsx`. The model MUST be able to
 * write it — the scaffold creates a placeholder, and the model's
 * version replaces it. That is the whole point of a create request.
 */
const SCAFFOLD_OWNED_FILES = new Set([
	'.gitignore',
	'index.html',
	'vite.config.ts',
	'vite.config.js',
	'tsconfig.json',
	'tailwind.config.js',
	'tailwind.config.ts',
	'postcss.config.js',
	'src/main.tsx',
	'src/main.jsx',
	'src/style.css',
]);

/**
 * Should this write be blocked because it would overwrite a scaffold file?
 *
 * Only for CREATE requests. An edit request may legitimately need to
 * change vite.config.ts.
 */
export function wouldClobberScaffold(relPath: string, isCreateRequest: boolean): boolean {
	if (!isCreateRequest) return false;
	const normalised = relPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
	return SCAFFOLD_OWNED_FILES.has(normalised);
}
