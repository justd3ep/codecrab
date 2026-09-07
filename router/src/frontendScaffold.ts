import fs from 'fs';
import path from 'path';

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
		if (!fs.existsSync(pkgPath)) {
			const pkgContent = {
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
			fs.writeFileSync(pkgPath, JSON.stringify(pkgContent, null, 2), 'utf-8');
			created.push('package.json');
			console.log('[FrontendScaffold] Created package.json');
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

export default defineConfig({
  plugins: [react()],
});
`;
			fs.writeFileSync(viteConfigPath, viteConfigContent, 'utf-8');
			created.push('vite.config.ts');
			console.log('[FrontendScaffold] Created vite.config.ts');
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
				},
				include: ['src'],
			};
			fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfigContent, null, 2), 'utf-8');
			created.push('tsconfig.json');
			console.log('[FrontendScaffold] Created tsconfig.json');
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

		// 9. src/types/kanban.ts (Domain schema for kanban/trello boards)
		const isKanban = /kanban|trello|board/i.test(userPrompt);
		if (isKanban) {
			const typesDir = path.join(srcDir, 'types');
			if (!fs.existsSync(typesDir)) fs.mkdirSync(typesDir, { recursive: true });
			const kanbanTypesPath = path.join(typesDir, 'kanban.ts');
			if (!fs.existsSync(kanbanTypesPath)) {
				const kanbanTypesContent = `export type ColumnId = 'todo' | 'inProgress' | 'done';

export interface Task {
  id: string;
  title: string;
  columnId: ColumnId;
  description?: string;
}

export interface Column {
  id: ColumnId;
  title: string;
}
`;
				fs.writeFileSync(kanbanTypesPath, kanbanTypesContent, 'utf-8');
				created.push('src/types/kanban.ts');
				console.log('[FrontendScaffold] Created src/types/kanban.ts');
			}
		}

		// 10. init.sh
		const initShPath = path.join(workspaceRoot, 'init.sh');
		if (!fs.existsSync(initShPath)) {
			const initShContent = `#!/bin/bash
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
			fs.writeFileSync(initShPath, initShContent, 'utf-8');
			created.push('init.sh');
			console.log('[FrontendScaffold] Created init.sh');
		}

		// 10. features.json
		const featuresPath = path.join(workspaceRoot, 'features.json');
		if (!fs.existsSync(featuresPath)) {
			const isKanban = /kanban|trello|board/i.test(userPrompt);
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
			const progressContent = `## [Initial Setup]
- Stack: React + TypeScript + Vite + Tailwind CSS
- Scaffolding: package.json, index.html, vite.config.ts, tsconfig.json, src/main.tsx, src/style.css, init.sh, features.json created
- Next: Implement component state and column layout in src/App.tsx
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
