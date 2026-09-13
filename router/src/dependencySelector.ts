import fs from 'fs';
import path from 'path';

export interface DependencyContextFile {
	path: string;
	content: string;
	score: number;
	reason: string;
}

const EXCLUDED_FILES = new Set([
	'package.json',
	'package-lock.json',
	'tsconfig.json',
	'tsconfig.node.json',
	'vite.config.ts',
	'vite.config.js',
	'postcss.config.js',
	'tailwind.config.js',
	'tailwind.config.ts',
	'init.sh',
	'features.json',
	'progress.txt',
	'index.html',
	'src/main.tsx',
	'src/main.jsx',
	'src/index.tsx',
	'src/style.css',
	'src/index.css',
	'src/App.css',
]);

/**
 * Compresses an overly long file into a signature + interface summary
 * to prevent blowing the token budget while preserving exact type contracts.
 */
function compressFileContent(content: string, maxLines: number = 150): string {
	const lines = content.split('\n');
	if (lines.length <= maxLines) return content;

	// Keep imports, interfaces, type aliases, and exported component headers
	const keptLines: string[] = [];
	let inInterface = false;
	let inType = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();

		if (/^import\s+/.test(trimmed)) {
			keptLines.push(line);
			continue;
		}

		if (/^(?:export\s+)?(?:interface|type)\s+/.test(trimmed)) {
			inInterface = true;
			keptLines.push(line);
			if (trimmed.includes('}') || (trimmed.endsWith(';') && !trimmed.includes('{'))) {
				inInterface = false;
			}
			continue;
		}

		if (inInterface || inType) {
			keptLines.push(line);
			if (trimmed.includes('}') || trimmed.endsWith(';')) {
				inInterface = false;
				inType = false;
			}
			continue;
		}

		if (/^export\s+(?:default\s+)?(?:function|const)\s+/.test(trimmed)) {
			keptLines.push(line);
			// Include opening lines of component
			for (let j = 1; j <= 5 && i + j < lines.length; j++) {
				keptLines.push(lines[i + j]!);
			}
			keptLines.push('  // ... [component body omitted for brevity - use exported props and signature above] ...\n}');
			break;
		}
	}

	return keptLines.length > 0 ? keptLines.join('\n') : lines.slice(0, maxLines).join('\n') + '\n// ... (truncated)';
}

/**
 * Score and select the top 3 most important dependency files from disk
 * to maintain contracts (props, types, exports) in the sliding context window.
 */
export function selectTopDependencyFiles(
	workspaceRoot: string,
	filesWritten: string[],
	targetHint?: string,
	maxFiles: number = 3,
): DependencyContextFile[] {
	const candidates: Array<{ path: string; fullPath: string; content: string; score: number; reason: string }> = [];
	const seen = new Set<string>();

	// Normalize files written list
	const fileList = Array.from(new Set(filesWritten.map(f => path.normalize(f).replace(/\\/g, '/'))));

	for (let idx = 0; idx < fileList.length; idx++) {
		const relPath = fileList[idx]!;
		if (EXCLUDED_FILES.has(relPath)) continue;

		// If targetHint is specified (e.g. src/App.tsx), don't include target itself as its own dependency
		if (targetHint && path.normalize(relPath).replace(/\\/g, '/') === path.normalize(targetHint).replace(/\\/g, '/')) {
			continue;
		}

		const fullPath = path.join(workspaceRoot, relPath);
		if (!fs.existsSync(fullPath)) continue;

		let content = '';
		try {
			content = fs.readFileSync(fullPath, 'utf-8');
		} catch {
			continue;
		}

		let score = 0;
		const reasons: string[] = [];

		// 1. Shared Types & Data Models (+100)
		if (relPath.includes('/types/') || relPath.startsWith('src/types') || relPath.endsWith('.d.ts')) {
			score += 100;
			reasons.push('type_definition');
		} else if (/\bexport\s+(?:interface|type)\s+/.test(content)) {
			score += 70;
			reasons.push('has_exported_types');
		}

		// 2. Child Components (+80)
		if (relPath.includes('/components/')) {
			score += 80;
			reasons.push('component');
			if (/\binterface\s+\w+Props\b/.test(content) || /\btype\s+\w+Props\b/.test(content)) {
				score += 20;
				reasons.push('has_props_interface');
			}
		}

		// 3. Priority for root App.tsx target
		if (targetHint && (targetHint.endsWith('App.tsx') || targetHint.endsWith('App.jsx'))) {
			if (relPath.includes('/components/')) {
				score += 30;
				reasons.push('target_child_component');
			}
		}

		// 4. Shared Utilities (+40)
		if (relPath.includes('/utils/') || relPath.includes('/lib/')) {
			score += 40;
			reasons.push('utility');
		}

		// 5. Recency boost (+2 per index in generation order)
		score += idx * 2;

		candidates.push({
			path: relPath,
			fullPath,
			content: compressFileContent(content, 150),
			score,
			reason: reasons.join(','),
		});
		seen.add(relPath);
	}

	// Sort descending by score
	candidates.sort((a, b) => b.score - a.score);

	return candidates.slice(0, maxFiles).map(c => ({
		path: c.path,
		content: c.content,
		score: c.score,
		reason: c.reason,
	}));
}

/**
 * Formats selected dependency files into a clean markdown prompt block.
 */
export function buildDependencyContextBlock(dependencies: DependencyContextFile[]): string {
	if (!dependencies || dependencies.length === 0) return '';

	const lines: string[] = [
		'<dependency_context>',
		`The following ${dependencies.length} key dependency file(s) are already generated and saved on disk.`,
		'Reference their exact exported component names, prop types, and interfaces:',
		'',
	];

	for (const dep of dependencies) {
		lines.push(`<file path="${dep.path}">\n${dep.content.trim()}\n</file>\n`);
	}

	lines.push('</dependency_context>');
	return lines.join('\n');
}
