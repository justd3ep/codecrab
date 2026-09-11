import fs from 'fs';
import path from 'path';


/**
 * Merges an existing package.json string with incoming package.json content.
 * Merges dependencies, devDependencies, and intelligently coordinates dev scripts.
 */
export function mergePackageJson(existingStr: string, incomingStr: string): string {
	let existingObj: any = {};
	let incomingObj: any = {};

	try {
		existingObj = JSON.parse(existingStr);
	} catch {
		existingObj = {};
	}

	try {
		incomingObj = JSON.parse(incomingStr);
	} catch {
		incomingObj = {};
	}

	if (!existingObj || typeof existingObj !== 'object') existingObj = {};
	if (!incomingObj || typeof incomingObj !== 'object') incomingObj = {};

	const merged: any = {
		name: existingObj.name || incomingObj.name || 'codecrab-app',
		private: existingObj.private !== undefined ? existingObj.private : (incomingObj.private !== undefined ? incomingObj.private : true),
		version: existingObj.version || incomingObj.version || '0.1.0',
		type: existingObj.type || incomingObj.type || 'module',
		scripts: {
			...(existingObj.scripts || {}),
			...(incomingObj.scripts || {}),
		},
		dependencies: {
			...(existingObj.dependencies || {}),
			...(incomingObj.dependencies || {}),
		},
		devDependencies: {
			...(existingObj.devDependencies || {}),
			...(incomingObj.devDependencies || {}),
		},
	};

	// Preserve other top-level metadata
	for (const key of Object.keys(existingObj)) {
		if (!(key in merged)) {
			merged[key] = existingObj[key];
		}
	}
	for (const key of Object.keys(incomingObj)) {
		if (!(key in merged)) {
			merged[key] = incomingObj[key];
		}
	}

	// Smart dev script coordination: if both client (vite) and server (tsx/node) exist
	const scripts = merged.scripts || {};
	const hasVite = Object.values(scripts).some((s: any) => typeof s === 'string' && s.includes('vite'));
	const hasServer = Object.values(scripts).some((s: any) => typeof s === 'string' && (s.includes('tsx') || s.includes('node') || s.includes('server')));

	if (hasVite && hasServer) {
		if (scripts.dev && scripts.dev.includes('vite') && !scripts['dev:client']) {
			scripts['dev:client'] = scripts.dev;
		}
		if (scripts.dev && (scripts.dev.includes('tsx') || scripts.dev.includes('node')) && !scripts['dev:server']) {
			scripts['dev:server'] = scripts.dev;
		}
		if (!scripts['dev:client'] && hasVite) {
			scripts['dev:client'] = 'vite';
		}
		if (!scripts['dev:server'] && hasServer) {
			scripts['dev:server'] = 'tsx watch src/server.ts';
		}
		scripts.dev = 'concurrently "npm run dev:server" "npm run dev:client"';
		if (!merged.devDependencies.concurrently && !merged.dependencies.concurrently) {
			merged.devDependencies.concurrently = '^8.2.2';
		}
	}

	return JSON.stringify(merged, null, 2) + '\n';
}

/**
 * Merges two init.sh bash scripts into a single deduplicated setup script.
 */
export function mergeInitSh(existingSh: string, incomingSh: string): string {
	if (!existingSh || !existingSh.trim()) return incomingSh;
	if (!incomingSh || !incomingSh.trim()) return existingSh;

	const filesToCheck = new Set<string>();
	const extractFiles = (sh: string) => {
		const match = sh.match(/for file in ([^;]+); do/);
		if (match && match[1]) {
			match[1].trim().split(/\s+/).forEach(f => {
				if (f && f.trim()) filesToCheck.add(f.trim());
			});
		}
	};
	extractFiles(existingSh);
	extractFiles(incomingSh);

	if (filesToCheck.size === 0) {
		['package.json', 'tsconfig.json'].forEach(f => filesToCheck.add(f));
	}

	const hasPrisma = /prisma generate|prisma\/schema\.prisma/i.test(existingSh) || /prisma generate|prisma\/schema\.prisma/i.test(incomingSh);
	const hasBuild = /npm run build/i.test(existingSh) || /npm run build/i.test(incomingSh);

	const filesList = Array.from(filesToCheck).join(' ');

	let merged = `#!/bin/bash
# Environment setup for CodeCrab project
set -e

echo "Checking essential files..."
for file in ${filesList}; do
  if [ ! -f "$file" ]; then
    echo "Warning: $file missing!"
  fi
done

echo "Installing dependencies..."
npm install
`;

	if (hasPrisma) {
		merged += `
if [ -f "prisma/schema.prisma" ]; then
  echo "Generating Prisma client..."
  npx prisma generate
fi
`;
	}

	if (hasBuild) {
		merged += `
echo "Verifying build..."
npm run build || true
`;
	}

	merged += `
echo "Setup complete! Run 'npm run dev' to launch application."
`;

	return merged;
}

/**
 * Ensures a new frontend project has its essential foundation files:
 * package.json, index.html, vite.config.ts, tsconfig.json, tailwind.config.js,
 * postcss.config.js, src/main.tsx, src/style.css, init.sh, features.json, and progress.txt.
 * Returns an array of file paths that were created.
 */
export function ensureFrontendScaffold(workspaceRoot: string, userPrompt: string): string[] {
	if (!workspaceRoot) return [];
	const created: string[] = [];

	try {
		if (!fs.existsSync(workspaceRoot)) {
			fs.mkdirSync(workspaceRoot, { recursive: true });
		}
		const srcDir = path.join(workspaceRoot, 'src');
		if (!fs.existsSync(srcDir)) {
			fs.mkdirSync(srcDir, { recursive: true });
		}

		// Windows NTFS Casing Collision Guard: rename legacy backend app.ts to prevent TS1149 collision with App.tsx
		const legacyAppTs = path.join(srcDir, 'app.ts');
		if (fs.existsSync(legacyAppTs)) {
			const backendBackup = path.join(srcDir, 'app.backend.ts');
			try {
				if (!fs.existsSync(backendBackup)) {
					fs.renameSync(legacyAppTs, backendBackup);
					console.log('[FrontendScaffold] Renamed legacy src/app.ts → src/app.backend.ts to prevent Vite casing conflict TS1149');
				}
			} catch { /* non-fatal */ }
		}

		// 0. .gitignore
		const gitignorePath = path.join(workspaceRoot, '.gitignore');
		if (!fs.existsSync(gitignorePath)) {
			fs.writeFileSync(gitignorePath, "node_modules\ndist\n.DS_Store\n", 'utf-8');
			created.push('.gitignore');
		}

		// 1. package.json
		const pkgPath = path.join(workspaceRoot, 'package.json');
		const defaultFrontendPkg = {
			name: 'codecrab-vite-app',
			private: true,
			version: '0.1.0',
			type: 'module',
			scripts: {
				dev: 'vite',
				build: 'tsc && vite build',
				preview: 'vite preview',
			},
			dependencies: {
				react: '^18.3.1',
				'react-dom': '^18.3.1',
				'lucide-react': '^0.344.0',
				clsx: '^2.1.1',
				'tailwind-merge': '^2.3.0',
			},
			devDependencies: {
				'@types/react': '^18.3.3',
				'@types/react-dom': '^18.3.0',
				'@vitejs/plugin-react': '^4.3.1',
				typescript: '^5.5.3',
				vite: '^5.4.1',
				tailwindcss: '^3.4.4',
				autoprefixer: '^10.4.19',
				postcss: '^8.4.38',
			},
		};

		if (!fs.existsSync(pkgPath)) {
			fs.writeFileSync(pkgPath, JSON.stringify(defaultFrontendPkg, null, 2) + '\n', 'utf-8');
			created.push('package.json');
			console.log('[FrontendScaffold] Created package.json');
		} else {
			try {
				const existingContent = fs.readFileSync(pkgPath, 'utf-8');
				const mergedContent = mergePackageJson(existingContent, JSON.stringify(defaultFrontendPkg, null, 2));
				if (mergedContent !== existingContent) {
					fs.writeFileSync(pkgPath, mergedContent, 'utf-8');
					created.push('package.json');
					console.log('[FrontendScaffold] Merged frontend dependencies into existing package.json');
				}
			} catch (e: any) {
				console.warn(`[FrontendScaffold] Warning merging package.json: ${e?.message || e}`);
			}
		}

		// 2. index.html
		const htmlPath = path.join(workspaceRoot, 'index.html');
		if (!fs.existsSync(htmlPath)) {
			const htmlContent = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CodeCrab App</title>
  </head>
  <body class="bg-gray-50 text-gray-900 dark:bg-zinc-950 dark:text-zinc-100 min-h-screen">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
			fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
			created.push('index.html');
			console.log('[FrontendScaffold] Created index.html');
		}

		// 3. vite.config.ts
		const viteConfigPath = path.join(workspaceRoot, 'vite.config.ts');
		if (!fs.existsSync(viteConfigPath)) {
			const viteConfigContent = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
`;
			fs.writeFileSync(viteConfigPath, viteConfigContent, 'utf-8');
			created.push('vite.config.ts');
			console.log('[FrontendScaffold] Created vite.config.ts');
		} else {
			try {
				let existingVite = fs.readFileSync(viteConfigPath, 'utf-8');
				if (!existingVite.includes("'@':") && !existingVite.includes('"@":')) {
					if (!existingVite.includes("import path from 'path'") && !existingVite.includes('import path from "path"')) {
						existingVite = "import path from 'path';\n" + existingVite;
					}
					if (existingVite.includes('plugins: [')) {
						existingVite = existingVite.replace('plugins: [', "resolve: {\n    alias: {\n      '@': path.resolve(__dirname, './src'),\n    },\n  },\n  plugins: [");
						fs.writeFileSync(viteConfigPath, existingVite, 'utf-8');
						console.log("[FrontendScaffold] Injected '@' alias into vite.config.ts");
					}
				}
			} catch { /* non-fatal */ }
		}

		// 4. tsconfig.json
		const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
		if (!fs.existsSync(tsconfigPath)) {
			const tsconfigContent = {
				compilerOptions: {
					target: 'ES2020',
					useDefineForClassFields: true,
					lib: ['ES2020', 'DOM', 'DOM.Iterable'],
					module: 'ESNext',
					skipLibCheck: true,
					moduleResolution: 'bundler',
					resolveJsonModule: true,
					isolatedModules: true,
					noEmit: true,
					jsx: 'react-jsx',
					strict: true,
					noUnusedLocals: false,
					noUnusedParameters: false,
					noFallthroughCasesInSwitch: true,
					baseUrl: '.',
					paths: {
						'@/*': ['./src/*'],
					},
				},
				include: ['src'],
			};
			fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfigContent, null, 2), 'utf-8');
			created.push('tsconfig.json');
			console.log('[FrontendScaffold] Created tsconfig.json');
		} else {
			try {
				const existingTsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
				if (!existingTsconfig.compilerOptions) existingTsconfig.compilerOptions = {};
				let modified = false;
				if (!existingTsconfig.compilerOptions.baseUrl) {
					existingTsconfig.compilerOptions.baseUrl = '.';
					modified = true;
				}
				if (!existingTsconfig.compilerOptions.paths || !existingTsconfig.compilerOptions.paths['@/*']) {
					existingTsconfig.compilerOptions.paths = {
						...(existingTsconfig.compilerOptions.paths || {}),
						'@/*': ['./src/*'],
					};
					modified = true;
				}
				if (modified) {
					fs.writeFileSync(tsconfigPath, JSON.stringify(existingTsconfig, null, 2), 'utf-8');
					console.log("[FrontendScaffold] Updated tsconfig.json with '@/*' path alias");
				}
			} catch { /* non-fatal */ }
		}

		// 5. tailwind.config.js
		const tailwindConfigPath = path.join(workspaceRoot, 'tailwind.config.js');
		if (!fs.existsSync(tailwindConfigPath)) {
			const tailwindConfigContent = `/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
`;
			fs.writeFileSync(tailwindConfigPath, tailwindConfigContent, 'utf-8');
			created.push('tailwind.config.js');
			console.log('[FrontendScaffold] Created tailwind.config.js');
		}

		// 6. postcss.config.js
		const postcssConfigPath = path.join(workspaceRoot, 'postcss.config.js');
		if (!fs.existsSync(postcssConfigPath)) {
			const postcssConfigContent = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
`;
			fs.writeFileSync(postcssConfigPath, postcssConfigContent, 'utf-8');
			created.push('postcss.config.js');
			console.log('[FrontendScaffold] Created postcss.config.js');
		}

		// 7. src/main.tsx
		const mainTsxPath = path.join(srcDir, 'main.tsx');
		if (!fs.existsSync(mainTsxPath)) {
			const mainTsxContent = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;
			fs.writeFileSync(mainTsxPath, mainTsxContent, 'utf-8');
			created.push('src/main.tsx');
			console.log('[FrontendScaffold] Created src/main.tsx');
		}

		// 8. src/style.css
		const styleCssPath = path.join(srcDir, 'style.css');
		if (!fs.existsSync(styleCssPath)) {
			const styleCssContent = `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  margin: 0;
  min-height: 100vh;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
}
`;
			fs.writeFileSync(styleCssPath, styleCssContent, 'utf-8');
			created.push('src/style.css');
			console.log('[FrontendScaffold] Created src/style.css');
		}

		// 9. init.sh
		const initShPath = path.join(workspaceRoot, 'init.sh');
		const defaultFrontendInitSh = `#!/bin/bash
# Environment setup for CodeCrab frontend project
set -e

echo "Checking essential frontend files..."
for file in package.json index.html vite.config.ts tsconfig.json; do
  if [ ! -f "$file" ]; then
    echo "Warning: $file missing!"
  fi
done

echo "Installing dependencies..."
npm install

echo "Verifying build..."
npm run build

echo "Setup complete! Run 'npm run dev' to launch local dev server."
`;

		if (!fs.existsSync(initShPath)) {
			fs.writeFileSync(initShPath, defaultFrontendInitSh, 'utf-8');
			created.push('init.sh');
			console.log('[FrontendScaffold] Created init.sh');
		} else {
			try {
				const existingInitSh = fs.readFileSync(initShPath, 'utf-8');
				const mergedInitSh = mergeInitSh(existingInitSh, defaultFrontendInitSh);
				if (mergedInitSh !== existingInitSh) {
					fs.writeFileSync(initShPath, mergedInitSh, 'utf-8');
					created.push('init.sh');
					console.log('[FrontendScaffold] Merged frontend setup into existing init.sh');
				}
			} catch (e: any) {
				console.warn(`[FrontendScaffold] Warning merging init.sh: ${e?.message || e}`);
			}
		}

		// 10. features.json
		const featuresPath = path.join(workspaceRoot, 'features.json');
		if (!fs.existsSync(featuresPath)) {
			const isKanban = /\b(?:kanban|trello|(?:task|kanban)\s+board)\b/i.test(userPrompt) && !/\b(?:dashboard|leaderboard|scoreboard|storyboard|onboarding)\b/i.test(userPrompt);
			const isDashboard = /\bdashboard\b/i.test(userPrompt);
			const defaultFeatures = isKanban ? [
				{
					category: 'layout',
					description: 'Render 3 Trello-style columns: To Do, In Progress, Done',
					steps: ['Open board', 'Verify 3 distinct column containers are displayed', 'Check column headers'],
					passes: false,
				},
				{
					category: 'interaction',
					description: 'HTML5 Drag and drop cards between columns',
					steps: ['Drag card from To Do', 'Drop into In Progress', 'Verify card moves to In Progress list'],
					passes: false,
				},
				{
					category: 'functional',
					description: 'Add new task card to a column',
					steps: ['Click Add Card', 'Enter task title', 'Submit', 'Verify card appears in column'],
					passes: false,
				},
				{
					category: 'ui',
					description: 'Modern Tailwind styling with dark mode support',
					steps: ['Inspect column background', 'Verify rounded corners, borders, and dark mode classes'],
					passes: false,
				},
			] : isDashboard ? [
				{
					category: 'layout',
					description: 'Modern responsive dashboard layout with navigation and main view',
					steps: ['Load dashboard', 'Verify sidebar navigation and main content area render cleanly'],
					passes: false,
				},
				{
					category: 'metrics',
					description: 'Dashboard statistics and summary cards',
					steps: ['Verify stat cards display totals, active items, and status breakdown'],
					passes: false,
				},
				{
					category: 'data',
					description: 'Interactive task/item list with search, filter controls, and status badges',
					steps: ['Search items by keyword', 'Filter items by status', 'Verify status badge rendering'],
					passes: false,
				},
				{
					category: 'modal',
					description: 'Create and edit modal dialog',
					steps: ['Open create modal', 'Enter item details', 'Submit to update list'],
					passes: false,
				},
				{
					category: 'ui',
					description: 'Responsive styling for desktop and mobile devices',
					steps: ['Inspect layout on desktop and mobile viewports', 'Verify empty and loading states'],
					passes: false,
				},
			] : [
				{
					category: 'functional',
					description: 'Core application interface renders',
					steps: ['Load root component', 'Verify main UI elements appear'],
					passes: false,
				},
				{
					category: 'ui',
					description: 'Responsive styling with Tailwind CSS',
					steps: ['Inspect layout on desktop and mobile'],
					passes: false,
				},
			];
			fs.writeFileSync(featuresPath, JSON.stringify(defaultFeatures, null, 2), 'utf-8');
			created.push('features.json');
			console.log('[FrontendScaffold] Created features.json');
		}

		// 11. progress.txt
		const progressPath = path.join(workspaceRoot, 'progress.txt');
		if (!fs.existsSync(progressPath)) {
			const isDashboard = /\bdashboard\b/i.test(userPrompt);
			const isKanban = /\b(?:kanban|trello|(?:task|kanban)\s+board)\b/i.test(userPrompt) && !/\b(?:dashboard|leaderboard|scoreboard|storyboard|onboarding)\b/i.test(userPrompt);
			const nextStep = isKanban
				? 'Implement component state and column layout in src/App.tsx'
				: isDashboard
					? 'Implement sidebar navigation, metric cards, and task list components in src/App.tsx'
					: 'Implement main application views and state in src/App.tsx';

			const progressContent = `## [Initial Setup]
- Stack: React + TypeScript + Vite + Tailwind CSS
- Scaffolding: package.json, index.html, vite.config.ts, tsconfig.json, src/main.tsx, src/style.css, init.sh, features.json created
- Next: ${nextStep}
- Blockers: None
`;
			fs.writeFileSync(progressPath, progressContent, 'utf-8');
			created.push('progress.txt');
			console.log('[FrontendScaffold] Created progress.txt');
		}
	} catch (err: any) {
		console.warn(`[FrontendScaffold] Warning: ${err?.message || err}`);
	}

	return created;
}

/**
 * Ensures a new backend project has its essential foundation files:
 * package.json, tsconfig.json, .env, .env.example, init.sh, features.json, and progress.txt.
 * If prisma or database is detected in the prompt, also scaffolds prisma/schema.prisma.
 * Merges cleanly with any existing frontend configuration.
 * Returns an array of file paths that were created or updated.
 */
export function ensureBackendScaffold(workspaceRoot: string, userPrompt: string): string[] {
	if (!workspaceRoot) return [];
	const created: string[] = [];

	try {
		if (!fs.existsSync(workspaceRoot)) {
			fs.mkdirSync(workspaceRoot, { recursive: true });
		}
		const srcDir = path.join(workspaceRoot, 'src');
		if (!fs.existsSync(srcDir)) {
			fs.mkdirSync(srcDir, { recursive: true });
		}

		// Ensure common backend folders exist
		for (const folder of ['routes', 'controllers', 'services', 'middleware', 'models']) {
			const folderPath = path.join(srcDir, folder);
			if (!fs.existsSync(folderPath)) {
				fs.mkdirSync(folderPath, { recursive: true });
			}
		}

		// 0. .gitignore
		const gitignorePath = path.join(workspaceRoot, '.gitignore');
		if (!fs.existsSync(gitignorePath)) {
			fs.writeFileSync(gitignorePath, "node_modules\ndist\n.env\n*.log\n.DS_Store\n", 'utf-8');
			created.push('.gitignore');
		}

		// 1. package.json
		const pkgPath = path.join(workspaceRoot, 'package.json');
		const isZod = /zod/i.test(userPrompt);
		const isDb = /prisma|postgres|postgresql|sqlite|database|db|mongo/i.test(userPrompt);
		const isAuth = /jwt|token|auth|bcrypt/i.test(userPrompt);

		const baseDependencies: Record<string, string> = {
			express: '^4.19.2',
			cors: '^2.8.5',
			dotenv: '^16.4.5',
		};
		const baseDevDependencies: Record<string, string> = {
			tsx: '^4.16.2',
			typescript: '^5.5.3',
			'@types/node': '^20.14.9',
			'@types/express': '^4.17.21',
			'@types/cors': '^2.8.17',
		};

		if (isZod) {
			baseDependencies['zod'] = '^3.23.8';
		}
		if (isDb) {
			baseDependencies['@prisma/client'] = '^5.16.1';
			baseDevDependencies['prisma'] = '^5.16.1';
		}
		if (isAuth) {
			baseDependencies['jsonwebtoken'] = '^9.0.2';
			baseDependencies['bcryptjs'] = '^2.4.3';
			baseDevDependencies['@types/jsonwebtoken'] = '^9.0.6';
			baseDevDependencies['@types/bcryptjs'] = '^2.4.6';
		}

		const defaultBackendPkg = {
			name: 'codecrab-backend-app',
			private: true,
			version: '0.1.0',
			type: 'module',
			scripts: {
				dev: 'tsx watch src/server.ts',
				build: 'tsc',
				start: 'node dist/server.js',
			},
			dependencies: baseDependencies,
			devDependencies: baseDevDependencies,
		};

		if (!fs.existsSync(pkgPath)) {
			fs.writeFileSync(pkgPath, JSON.stringify(defaultBackendPkg, null, 2) + '\n', 'utf-8');
			created.push('package.json');
			console.log('[BackendScaffold] Created package.json');
		} else {
			try {
				const existingContent = fs.readFileSync(pkgPath, 'utf-8');
				const mergedContent = mergePackageJson(existingContent, JSON.stringify(defaultBackendPkg, null, 2));
				if (mergedContent !== existingContent) {
					fs.writeFileSync(pkgPath, mergedContent, 'utf-8');
					created.push('package.json');
					console.log('[BackendScaffold] Merged backend dependencies into existing package.json');
				}
			} catch (e: any) {
				console.warn(`[BackendScaffold] Warning merging package.json: ${e?.message || e}`);
			}
		}

		// 2. tsconfig.json
		const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
		if (!fs.existsSync(tsconfigPath)) {
			const tsconfigContent = {
				compilerOptions: {
					target: 'ES2022',
					module: 'NodeNext',
					moduleResolution: 'NodeNext',
					lib: ['ES2022'],
					strict: true,
					esModuleInterop: true,
					skipLibCheck: true,
					forceConsistentCasingInFileNames: true,
					outDir: './dist',
					rootDir: './src',
				},
				include: ['src/**/*'],
			};
			fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfigContent, null, 2) + '\n', 'utf-8');
			created.push('tsconfig.json');
			console.log('[BackendScaffold] Created tsconfig.json');
		}

		// 3. .env and .env.example
		const envPath = path.join(workspaceRoot, '.env');
		const envExamplePath = path.join(workspaceRoot, '.env.example');
		let envContent = `PORT=3000\nNODE_ENV=development\n`;
		if (isDb) {
			envContent += `DATABASE_URL="file:./dev.db"\n`;
		}
		if (isAuth) {
			envContent += `JWT_SECRET="development-secret-key-change-in-production"\n`;
		}

		if (!fs.existsSync(envPath)) {
			fs.writeFileSync(envPath, envContent, 'utf-8');
			created.push('.env');
			console.log('[BackendScaffold] Created .env');
		}
		if (!fs.existsSync(envExamplePath)) {
			fs.writeFileSync(envExamplePath, envContent, 'utf-8');
			created.push('.env.example');
			console.log('[BackendScaffold] Created .env.example');
		}

		// 4. init.sh
		const initShPath = path.join(workspaceRoot, 'init.sh');
		let defaultBackendInitSh = `#!/bin/bash
# Environment setup for CodeCrab project
set -e

echo "Checking essential backend files..."
for file in package.json tsconfig.json .env; do
  if [ ! -f "$file" ]; then
    echo "Warning: $file missing!"
  fi
done

echo "Installing dependencies..."
npm install
`;

		if (isDb) {
			defaultBackendInitSh += `
if [ -f "prisma/schema.prisma" ]; then
  echo "Generating Prisma client..."
  npx prisma generate
fi
`;
		}

		defaultBackendInitSh += `
echo "Verifying build..."
npm run build || true

echo "Setup complete! Run 'npm run dev' to launch backend server."
`;

		if (!fs.existsSync(initShPath)) {
			fs.writeFileSync(initShPath, defaultBackendInitSh, 'utf-8');
			created.push('init.sh');
			console.log('[BackendScaffold] Created init.sh');
		} else {
			try {
				const existingInitSh = fs.readFileSync(initShPath, 'utf-8');
				const mergedInitSh = mergeInitSh(existingInitSh, defaultBackendInitSh);
				if (mergedInitSh !== existingInitSh) {
					fs.writeFileSync(initShPath, mergedInitSh, 'utf-8');
					created.push('init.sh');
					console.log('[BackendScaffold] Merged backend setup into existing init.sh');
				}
			} catch (e: any) {
				console.warn(`[BackendScaffold] Warning merging init.sh: ${e?.message || e}`);
			}
		}

		// 5. prisma/schema.prisma (if db requested)
		if (isDb) {
			const prismaDir = path.join(workspaceRoot, 'prisma');
			if (!fs.existsSync(prismaDir)) {
				fs.mkdirSync(prismaDir, { recursive: true });
			}
			const schemaPath = path.join(prismaDir, 'schema.prisma');
			if (!fs.existsSync(schemaPath)) {
				const schemaContent = `datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}
`;
				fs.writeFileSync(schemaPath, schemaContent, 'utf-8');
				created.push('prisma/schema.prisma');
				console.log('[BackendScaffold] Created prisma/schema.prisma');
			}
		}

		// 6. features.json (if not exists)
		const featuresPath = path.join(workspaceRoot, 'features.json');
		if (!fs.existsSync(featuresPath)) {
			const defaultFeatures = [
				{
					category: 'server',
					description: 'Express server initializes and listens on configured PORT',
					steps: ['Start server with npm run dev', 'Verify server console output'],
					passes: false,
				},
				{
					category: 'api',
					description: 'REST API endpoints return proper JSON responses with status codes',
					steps: ['Send request to API endpoints', 'Verify JSON response and error handling'],
					passes: false,
				},
				{
					category: 'middleware',
					description: 'CORS, JSON body parser, and error handler middleware configured',
					steps: ['Test CORS headers and invalid payload error handling'],
					passes: false,
				},
			];
			fs.writeFileSync(featuresPath, JSON.stringify(defaultFeatures, null, 2) + '\n', 'utf-8');
			created.push('features.json');
			console.log('[BackendScaffold] Created features.json');
		}

		// 7. progress.txt (if not exists)
		const progressPath = path.join(workspaceRoot, 'progress.txt');
		if (!fs.existsSync(progressPath)) {
			const progressContent = `## [Initial Setup]
- Stack: Node.js + Express + TypeScript
- Scaffolding: package.json, tsconfig.json, .env, init.sh, features.json created
- Next: Implement server entry point in src/server.ts and API routes
- Blockers: None
`;
			fs.writeFileSync(progressPath, progressContent, 'utf-8');
			created.push('progress.txt');
			console.log('[BackendScaffold] Created progress.txt');
		}
	} catch (err: any) {
		console.warn(`[BackendScaffold] Warning: ${err?.message || err}`);
	}

	return created;
}

