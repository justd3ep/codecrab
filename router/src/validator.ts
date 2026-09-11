/**
 * PostGenerationValidator V2.5 + Local File Validator
 * ====================================================
 * Full 18-pass semantic validation for project-level use.
 * Per-file local validator (runLocalFileValidator) runs only passes that are
 * safe during incremental generation — no project-level checks.
 *
 * Both validators are DependencyStatus-aware: Planned/Generated imports are
 * never flagged as errors (only Missing imports are real errors).
 *
 * Pass order (sealed):
 *  1.  Normalize paths        — repair
 *  2.  Remove duplicates      — repair
 *  3.  Scope validator        — error
 *  4.  Framework validation   — repair
 *  5.  Package validation     — repair
 *  6.  Import validation      — warning  [DependencyStatus-aware]
 *  7.  Requirement coverage   — error (weighted)
 *  8.  Architecture validator — error
 *  9.  Layer boundary         — error
 *  10. Business logic leak    — warning
 *  11. Route size             — warning
 *  12. Undefined symbol       — error
 *  13. Dependency validator   — error    [DependencyStatus-aware]
 *  14. Dead code              — warning
 *  15. Workspace collision    — warning
 *  16. Security               — warning
 *  17. TypeScript quality     — warning
 *  18. React validation       — repair + warning
 *  19. HTML/CSS validation    — repair
 *  20. Compile validation     — error (tsc, temp dir)
 *  21. Project completeness   — error
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { classifyDependency, DependencyStatus, isImportError } from './dependencyStatus.js';
import type { ExecutionGraph } from './planner.js';

const execPromise = util.promisify(exec);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GeneratedFile {
	path: string;
	content: string;
}

export interface ValidationContract {
	scope: 'backend' | 'frontend' | 'fullstack' | 'unknown';
	architecture: 'repository' | 'mvc' | 'clean' | 'flat' | 'unknown';
	framework: string;
	language: 'typescript' | 'javascript';
	requiredFeatures: string[];   // keys from FEATURE_WEIGHTS
	requiredFolders: string[];
	expectedFiles: string[];
	estimatedFiles: number;
}

export type IssueKind =
	| 'scope_violation'
	| 'missing_coverage'
	| 'missing_architecture'
	| 'business_logic_leak'
	| 'route_too_large'
	| 'undefined_symbol'
	| 'missing_import'
	| 'dead_code'
	| 'security'
	| 'typescript_quality'
	| 'compile_error'
	| 'completeness';

export interface ValidationIssue {
	kind: IssueKind;
	file?: string;
	message: string;
	severity: 'error' | 'warning';
}

export interface ValidationResult {
	passed: boolean;
	files: GeneratedFile[];
	issues: ValidationIssue[];
	coverageScore: number;   // weighted score achieved
	coverageMax: number;     // max possible weighted score
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void  { console.log(`[Validator] ${msg}`); }
function warn(msg: string): void { console.warn(`[Validator] WARN: ${msg}`); }

// ---------------------------------------------------------------------------
// Feature weights — used for requirement coverage (Pass 7)
// ---------------------------------------------------------------------------

interface FeatureSpec {
	weight: number;
	patterns: RegExp[];
}

const FEATURE_WEIGHTS: Record<string, FeatureSpec> = {
	jwt:                { weight: 10, patterns: [/jsonwebtoken|jwt\.sign|jwt\.verify|createJwt|generateToken/i] },
	refresh_tokens:     { weight: 10, patterns: [/refresh.?token|refreshToken|rotateToken/i] },
	repository:         { weight: 15, patterns: [/class\s+\w+Repository\b|implements\s+I?\w*Repository\b|@InjectRepository/i] },
	service_layer:      { weight: 15, patterns: [/class\s+\w+Service\b|@Injectable\(\)|@Service\(\)/i] },
	uploads:            { weight:  5, patterns: [/multer|diskStorage|memoryStorage|upload\.\w+/i] },
	logging:            { weight:  2, patterns: [/winston|pino|morgan|bunyan|log\.info|log\.error/i] },
	pagination:         { weight:  2, patterns: [/\bpage\b.*\blimit\b|\boffset\b.*\blimit\b|\bskip\b.*\btake\b|\bpaginate\b/i] },
	email:              { weight:  5, patterns: [/nodemailer|sendgrid|mailgun|sendEmail|transporter\.send/i] },
	payments:           { weight: 10, patterns: [/stripe|paypal|razorpay|braintree|payment_intent/i] },
	rbac:               { weight:  8, patterns: [/role.*guard|permission.*check|@Roles\(|checkPermission|isAdmin/i] },
	oauth:              { weight: 10, patterns: [/passport\.use|GoogleStrategy|GithubStrategy|oauth/i] },
	password_reset:     { weight:  5, patterns: [/resetPassword|passwordReset|forgot.?password|reset.?token/i] },
	email_verification: { weight:  5, patterns: [/verifyEmail|emailVerification|verify.?token|confirmEmail/i] },
	transactions:       { weight:  8, patterns: [/\$transaction|\.transaction\(|BEGIN.*COMMIT|beginTransaction/i] },
	dto:                { weight:  3, patterns: [/class\s+\w+Dto\b|\.dto\.ts|@IsString\(\)|@IsEmail\(\)|@IsNotEmpty\(\)/i] },
	bcrypt:             { weight:  5, patterns: [/bcrypt\.hash|bcrypt\.compare|argon2\.hash/i] },
	middleware:         { weight:  3, patterns: [/app\.use\(|router\.use\(|@UseGuards\(|@UseInterceptors\(/i] },
};

// Architecture → required folder patterns
const ARCH_FOLDERS: Record<string, string[]> = {
	repository: ['controllers', 'services', 'repositories'],
	mvc:        ['models', 'controllers'],
	clean:      ['domain', 'application', 'infrastructure'],
};

// ---------------------------------------------------------------------------
// PASS 1 — Normalize Paths
// ---------------------------------------------------------------------------

const SRC_BARE_EXTS = new Set(['.tsx', '.jsx', '.ts', '.js', '.css', '.scss', '.less']);

const BARE_SRC_NAMES: Record<string, string> = {
	'app.tsx':    'src/App.tsx',
	'app.jsx':    'src/App.jsx',
	'app.ts':     'src/App.ts',
	'app.js':     'src/App.js',
	'main.tsx':   'src/main.tsx',
	'main.jsx':   'src/main.jsx',
	'main.ts':    'src/main.ts',
	'main.js':    'src/main.js',
	'index.tsx':  'src/index.tsx',
	'index.ts':   'src/index.ts',
	'style.css':  'src/style.css',
	'styles.css': 'src/styles.css',
	'index.css':  'src/index.css',
	'app.css':    'src/App.css',
};

function normalizePath(filePath: string): string {
	let p = filePath.replace(/\\/g, '/').trim();
	if (p.startsWith('@/') || p.startsWith('~/')) {
		p = p.slice(2);
		return p.startsWith('src/') ? p : `src/${p}`;
	}
	const KEEP_PREFIXES = [
		'src/', 'public/', 'app/', 'components/', 'pages/',
		'hooks/', 'lib/', 'utils/', 'api/', 'styles/', 'assets/',
		'controllers/', 'services/', 'repositories/', 'middleware/',
		'models/', 'routes/', 'dto/', 'config/', 'domain/',
		'application/', 'infrastructure/', 'guards/', 'interceptors/',
		'prisma/', 'migrations/', 'uploads/', 'test/', 'tests/',
	];
	if (KEEP_PREFIXES.some(prefix => p.startsWith(prefix))) return p;
	const lower = p.toLowerCase();
	if (BARE_SRC_NAMES[lower]) return BARE_SRC_NAMES[lower]!;
	const hasNoDir = !p.includes('/');
	const ext = path.extname(p).toLowerCase();
	if (hasNoDir && SRC_BARE_EXTS.has(ext)) return `src/${p}`;
	const firstSegment = p.split('/')[0]!;
	const FE_SEGMENTS = new Set([
		'api', 'components', 'pages', 'hooks', 'lib', 'utils',
		'styles', 'assets', 'store', 'stores', 'types', 'context',
		'contexts', 'services', 'features', 'layouts', 'views',
		'screens', 'icons',
	]);
	if (FE_SEGMENTS.has(firstSegment.toLowerCase())) return `src/${p}`;
	return p;
}

function pass1NormalizePaths(files: GeneratedFile[]): GeneratedFile[] {
	return files.map(f => {
		const normalized = normalizePath(f.path);
		if (normalized !== f.path) log(`normalized ${f.path} -> ${normalized}`);
		return { ...f, path: normalized };
	});
}

// ---------------------------------------------------------------------------
// PASS 2 — Remove Duplicates
// ---------------------------------------------------------------------------

function contentScore(content: string): number {
	return content.replace(/\s/g, '').length;
}

function pass2RemoveDuplicates(files: GeneratedFile[]): GeneratedFile[] {
	const best = new Map<string, GeneratedFile>();
	for (const f of files) {
		const existing = best.get(f.path);
		if (!existing) {
			best.set(f.path, f);
		} else if (contentScore(f.content) > contentScore(existing.content)) {
			log(`merged duplicate ${f.path} (kept more complete)`);
			best.set(f.path, f);
		} else {
			log(`merged duplicate ${f.path} (kept existing)`);
		}
	}
	return Array.from(best.values());
}

// ---------------------------------------------------------------------------
// PASS 2B — Duplicate Identifier & Collision Sanitizer (Zero-Token TS2440 repair)
// ---------------------------------------------------------------------------

function passDuplicateIdentifierSanitizer(files: GeneratedFile[]): GeneratedFile[] {
	return files.map(f => {
		const ext = path.extname(f.path).toLowerCase();
		if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return f;

		const content = f.content;
		let modified = false;

		// 1. Find all local declarations in the file (excluding imports)
		// Matches: function Foo, const Foo, let Foo, class Foo, interface Foo, type Foo
		const localDeclRegex = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type)\s+([A-Za-z0-9_$]+)\b/g;
		const localDecls = new Set<string>();
		let declMatch: RegExpExecArray | null;
		while ((declMatch = localDeclRegex.exec(content)) !== null) {
			if (declMatch[1]) localDecls.add(declMatch[1]);
		}

		if (localDecls.size === 0) return f;

		// 2. Scan import statements and check for collisions
		const lines = content.split('\n');
		const newLines: string[] = [];

		for (const line of lines) {
			const trimmed = line.trim();
			// Check if line is an import statement
			if (/^import\s+/.test(trimmed) && /from\s+['"][^'"]+['"]/.test(trimmed)) {
				// Check named imports: import { A, B } from '...'
				const namedMatch = trimmed.match(/^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
				if (namedMatch && namedMatch[1]) {
					const importList = namedMatch[1];
					const specifiers = importList.split(',').map(s => s.trim()).filter(Boolean);
					const keptSpecifiers = specifiers.filter(spec => {
						const parts = spec.split(/\s+as\s+/);
						const importedName = (parts[1] || parts[0] || '').trim();
						if (importedName && localDecls.has(importedName)) {
							log(`Sanitizer: Removed conflicting import "${importedName}" from ${f.path} (locally declared in same file)`);
							modified = true;
							return false;
						}
						return true;
					});

					if (keptSpecifiers.length === 0) {
						// All imports in this statement were locally declared; drop the entire line!
						continue;
					} else if (keptSpecifiers.length < specifiers.length) {
						// Reconstruct import statement with remaining specifiers
						newLines.push(line.replace(/\{[^}]+\}/, `{ ${keptSpecifiers.join(', ')} }`));
						continue;
					}
				}

				// Check default import: import Foo from '...'
				const defaultMatch = trimmed.match(/^import\s+([A-Za-z0-9_$]+)\s+from\s+['"]([^'"]+)['"]/);
				if (defaultMatch && defaultMatch[1]) {
					const defaultName = defaultMatch[1];
					if (localDecls.has(defaultName)) {
						log(`Sanitizer: Removed conflicting default import "${defaultName}" from ${f.path} (locally declared in same file)`);
						modified = true;
						continue; // drop the entire line
					}
				}
			}

			newLines.push(line);
		}

		return modified ? { ...f, content: newLines.join('\n') } : f;
	});
}

// ---------------------------------------------------------------------------
// PASS 2C-2 — Auto-Synthesize Common Utils (currency, cn, date, etc.)
// ---------------------------------------------------------------------------

function passAutoSynthesizeUtils(files: GeneratedFile[], workspaceRoot: string): GeneratedFile[] {
	const fileMap = new Set(files.map(f => path.normalize(f.path).replace(/\\/g, '/')));
	const onDisk = (rel: string) => {
		try { return fs.existsSync(path.join(workspaceRoot, rel)); } catch { return false; }
	};

	let hasCurrencyImport = false;
	let hasLibUtilsImport = false;
	let hasDateImport = false;
	let hasUtilsBarrelImport = false;

	for (const f of files) {
		const ext = path.extname(f.path).toLowerCase();
		if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;
		if (/(?:@\/|\.\.?\/[a-zA-Z0-9_\-\/]*\/?)utils\/currency\b/.test(f.content) || (/\bformatCurrency\b/.test(f.content) && /from\s+['"][^'"]*currency['"]/.test(f.content))) {
			hasCurrencyImport = true;
		}
		if (/(?:@\/|\.\.?\/[a-zA-Z0-9_\-\/]*\/?)lib\/utils\b/.test(f.content) || (/\bcn\s*\(/.test(f.content) && /from\s+['"][^'"]*lib\/utils['"]/.test(f.content))) {
			hasLibUtilsImport = true;
		}
		if (/(?:@\/|\.\.?\/[a-zA-Z0-9_\-\/]*\/?)utils\/date\b/.test(f.content) || (/\bformatDate\b/.test(f.content) && /from\s+['"][^'"]*utils\/date['"]/.test(f.content))) {
			hasDateImport = true;
		}
		if (/from\s+['"](?:@\/|\.\.?\/[a-zA-Z0-9_\-\/]*\/?)utils['"]/.test(f.content)) {
			hasUtilsBarrelImport = true;
		}
	}

	const result = [...files];
	const installed = readPackageJson(workspaceRoot);

	if (hasCurrencyImport && !fileMap.has('src/utils/currency.ts') && !fileMap.has('src/utils/currency.js') && !onDisk('src/utils/currency.ts') && !onDisk('src/utils/currency.js')) {
		log('AutoSynthesize: Synthesizing src/utils/currency.ts');
		result.push({
			path: 'src/utils/currency.ts',
			content: `export function formatCurrency(amount: number | string): string {\n  const num = typeof amount === 'number' ? amount : parseFloat(String(amount)) || 0;\n  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);\n}\n\nexport function formatNumber(amount: number | string): string {\n  const num = typeof amount === 'number' ? amount : parseFloat(String(amount)) || 0;\n  return new Intl.NumberFormat('en-US').format(num);\n}\n`,
		});
		fileMap.add('src/utils/currency.ts');
	}

	if (hasLibUtilsImport && !fileMap.has('src/lib/utils.ts') && !fileMap.has('src/lib/utils.js') && !onDisk('src/lib/utils.ts') && !onDisk('src/lib/utils.js')) {
		log('AutoSynthesize: Synthesizing src/lib/utils.ts');
		const hasTailwindPkgs = installed.has('clsx') && installed.has('tailwind-merge');
		const content = hasTailwindPkgs
			? `import { clsx, type ClassValue } from 'clsx';\nimport { twMerge } from 'tailwind-merge';\n\nexport function cn(...inputs: ClassValue[]): string {\n  return twMerge(clsx(inputs));\n}\n`
			: `export function cn(...inputs: any[]): string {\n  return inputs.flat().filter(Boolean).join(' ');\n}\n`;
		result.push({
			path: 'src/lib/utils.ts',
			content,
		});
		fileMap.add('src/lib/utils.ts');
	}

	if (hasDateImport && !fileMap.has('src/utils/date.ts') && !fileMap.has('src/utils/date.js') && !onDisk('src/utils/date.ts') && !onDisk('src/utils/date.js')) {
		log('AutoSynthesize: Synthesizing src/utils/date.ts');
		result.push({
			path: 'src/utils/date.ts',
			content: `export function formatDate(date: string | Date | number): string {\n  const d = date instanceof Date ? date : new Date(date);\n  return isNaN(d.getTime()) ? String(date) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });\n}\n\nexport function formatDateTime(date: string | Date | number): string {\n  const d = date instanceof Date ? date : new Date(date);\n  return isNaN(d.getTime()) ? String(date) : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });\n}\n`,
		});
		fileMap.add('src/utils/date.ts');
	}

	if (hasUtilsBarrelImport && !fileMap.has('src/utils/index.ts') && !fileMap.has('src/utils/index.js') && !fileMap.has('src/utils.ts') && !onDisk('src/utils/index.ts') && !onDisk('src/utils/index.js') && !onDisk('src/utils.ts')) {
		log('AutoSynthesize: Synthesizing src/utils/index.ts barrel');
		if (!fileMap.has('src/utils/currency.ts') && !onDisk('src/utils/currency.ts')) {
			result.push({
				path: 'src/utils/currency.ts',
				content: `export function formatCurrency(amount: number | string): string {\n  const num = typeof amount === 'number' ? amount : parseFloat(String(amount)) || 0;\n  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);\n}\n\nexport function formatNumber(amount: number | string): string {\n  const num = typeof amount === 'number' ? amount : parseFloat(String(amount)) || 0;\n  return new Intl.NumberFormat('en-US').format(num);\n}\n`,
			});
			fileMap.add('src/utils/currency.ts');
		}
		if (!fileMap.has('src/utils/date.ts') && !onDisk('src/utils/date.ts')) {
			result.push({
				path: 'src/utils/date.ts',
				content: `export function formatDate(date: string | Date | number): string {\n  const d = date instanceof Date ? date : new Date(date);\n  return isNaN(d.getTime()) ? String(date) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });\n}\n`,
			});
			fileMap.add('src/utils/date.ts');
		}
		result.push({
			path: 'src/utils/index.ts',
			content: `export * from './currency';\nexport * from './date';\n`,
		});
		fileMap.add('src/utils/index.ts');
	}

	return result;
}

// ---------------------------------------------------------------------------
// PASS 2C-3 — Auto-Synthesize Common Type Interfaces (@/types/..., ./types/...)
// ---------------------------------------------------------------------------

function passAutoSynthesizeTypes(files: GeneratedFile[], workspaceRoot: string): GeneratedFile[] {
	const fileMap = new Set(files.map(f => path.normalize(f.path).replace(/\\/g, '/')));
	const onDisk = (rel: string) => {
		try { return fs.existsSync(path.join(workspaceRoot, rel)); } catch { return false; }
	};

	const candidateExts = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];
	const missingTypeFiles = new Map<string, Set<string>>();

	// Matches named: import { A, B } from '@/types/foo' or import type { A } from './types' etc.
	const NAMED_TYPE_IMPORT_RE = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]((?:\.\.?\/|@\/|~\/)[^'"]*types[^'"]*)['"]/g;
	// Matches default: import type Foo from '@/types/foo' or import Foo from '@/types/foo'
	const DEFAULT_TYPE_IMPORT_RE = /import\s+(?:type\s+)?([A-Za-z0-9_$]+)\s+from\s+['"]((?:\.\.?\/|@\/|~\/)[^'"]*types[^'"]*)['"]/g;

	for (const f of files) {
		const ext = path.extname(f.path).toLowerCase();
		if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;

		let m: RegExpExecArray | null;
		const namedRe = new RegExp(NAMED_TYPE_IMPORT_RE.source, 'g');
		while ((m = namedRe.exec(f.content)) !== null) {
			const specifiers = m[1]!.split(',').map(s => {
				let clean = s.trim();
				if (clean.startsWith('type ')) clean = clean.slice(5).trim();
				return clean.split(/\s+as\s+/)[0]!.trim();
			}).filter(Boolean);
			const rawPath = m[2]!;
			let targetNorm: string;
			if (rawPath.startsWith('@/') || rawPath.startsWith('~/')) {
				targetNorm = path.normalize(path.join('src', rawPath.slice(2))).replace(/\\/g, '/');
			} else {
				targetNorm = path.normalize(path.join(path.dirname(f.path), rawPath)).replace(/\\/g, '/');
			}
			const targetExt = path.extname(targetNorm) ? '' : '.ts';
			const candidate = targetNorm + targetExt;

			const exists = fileMap.has(candidate) || onDisk(candidate) ||
				candidateExts.some(e => fileMap.has(targetNorm + e) || onDisk(targetNorm + e));

			if (!exists) {
				if (!missingTypeFiles.has(candidate)) missingTypeFiles.set(candidate, new Set());
				for (const s of specifiers) missingTypeFiles.get(candidate)!.add(s);
			}
		}

		const defaultRe = new RegExp(DEFAULT_TYPE_IMPORT_RE.source, 'g');
		while ((m = defaultRe.exec(f.content)) !== null) {
			const symbol = m[1]!.trim();
			if (symbol === 'type' || symbol === 'from') continue;
			const rawPath = m[2]!;
			let targetNorm: string;
			if (rawPath.startsWith('@/') || rawPath.startsWith('~/')) {
				targetNorm = path.normalize(path.join('src', rawPath.slice(2))).replace(/\\/g, '/');
			} else {
				targetNorm = path.normalize(path.join(path.dirname(f.path), rawPath)).replace(/\\/g, '/');
			}
			const targetExt = path.extname(targetNorm) ? '' : '.ts';
			const candidate = targetNorm + targetExt;

			const exists = fileMap.has(candidate) || onDisk(candidate) ||
				candidateExts.some(e => fileMap.has(targetNorm + e) || onDisk(targetNorm + e));

			if (!exists) {
				if (!missingTypeFiles.has(candidate)) missingTypeFiles.set(candidate, new Set());
				missingTypeFiles.get(candidate)!.add(symbol);
			}
		}
	}

	if (missingTypeFiles.size === 0) return files;

	const result = [...files];
	for (const [filePath, symbols] of missingTypeFiles.entries()) {
		log(`AutoSynthesize: Synthesizing types file ${filePath} with [${[...symbols].join(', ')}]`);
		const typeDecls: string[] = [];
		for (const sym of symbols) {
			typeDecls.push(`export interface ${sym} {\n  [key: string]: any;\n}`);
		}
		result.push({
			path: filePath,
			content: `// Auto-synthesized types\n${typeDecls.join('\n\n')}\n`,
		});
		fileMap.add(filePath);
	}

	return result;
}

const getTargetContent = (relPath: string, currentFile: string, fileMap: Map<string, string>, workspaceRoot: string): string | null => {
	let targetNorm: string;
	if (relPath.startsWith('@/') || relPath.startsWith('~/')) {
		targetNorm = path.normalize(path.join('src', relPath.slice(2))).replace(/\\/g, '/');
	} else {
		const dir = path.dirname(currentFile);
		targetNorm = path.normalize(path.join(dir, relPath)).replace(/\\/g, '/');
	}
	for (const ext of ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']) {
		const candidate = targetNorm + ext;
		if (fileMap.has(candidate)) return fileMap.get(candidate)!;
		const diskPath = path.join(workspaceRoot, candidate);
		if (fs.existsSync(diskPath)) {
			try { return fs.readFileSync(diskPath, 'utf-8'); } catch { /* ignore */ }
		}
	}
	return null;
};

function passHarmonizeExports(files: GeneratedFile[], workspaceRoot: string): GeneratedFile[] {
	const fileMap = new Map<string, string>();
	for (const f of files) {
		fileMap.set(path.normalize(f.path).replace(/\\/g, '/'), f.content);
	}

	return files.map(f => {
		const ext = path.extname(f.path).toLowerCase();
		if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return f;

		let content = f.content;
		let modified = false;

		// 1. Fix default import when target only has named export
		// e.g. import Foo from './Foo' where Foo.tsx has 'export function Foo' and no 'export default'
		const defaultImportRegex = /^import\s+([A-Za-z0-9_$]+)\s+from\s+['"]((?:\.\.?\/|@\/|~\/)[^'"]+)['"]/gm;
		content = content.replace(defaultImportRegex, (fullMatch, importedName, modulePath) => {
			if (importedName === 'React') return fullMatch;
			const targetContent = getTargetContent(modulePath, f.path, fileMap, workspaceRoot);
			if (!targetContent) return fullMatch;

			const hasDefault = /export\s+default\b/.test(targetContent);
			const hasNamed = new RegExp(`export\\s+(?:async\\s+)?(?:function|class|const|let|var|type|interface)\\s+${importedName}\\b|export\\s*\\{[^}]*\\b${importedName}\\b`).test(targetContent);

			if (!hasDefault && hasNamed) {
				log(`Harmonizer: Converted default import "${importedName}" → named "{ ${importedName} }" in ${f.path}`);
				modified = true;
				return fullMatch.replace(`import ${importedName} from`, `import { ${importedName} } from`);
			}
			return fullMatch;
		});

		// 2. Fix named import when target only has default export
		// e.g. import { Foo } from './Foo' where Foo.tsx has 'export default Foo' and no named export
		const namedImportRegex = /^import\s+\{\s*([A-Za-z0-9_$]+)\s*\}\s+from\s+['"]((?:\.\.?\/|@\/|~\/)[^'"]+)['"]/gm;
		content = content.replace(namedImportRegex, (fullMatch, importedName, modulePath) => {
			const targetContent = getTargetContent(modulePath, f.path, fileMap, workspaceRoot);
			if (!targetContent) return fullMatch;

			const hasDefault = /export\s+default\b/.test(targetContent);
			const hasNamed = new RegExp(`export\\s+(?:async\\s+)?(?:function|class|const|let|var|type|interface)\\s+${importedName}\\b|export\\s*\\{[^}]*\\b${importedName}\\b`).test(targetContent);

			if (hasDefault && !hasNamed) {
				log(`Harmonizer: Converted named import "{ ${importedName} }" → default "${importedName}" in ${f.path}`);
				modified = true;
				return fullMatch.replace(`import { ${importedName} } from`, `import ${importedName} from`);
			}
			return fullMatch;
		});

		return modified ? { ...f, content } : f;
	});
}

// ---------------------------------------------------------------------------
// PASS 2D — Auto-Import Resolver (Zero-Token Component, Hook & Icon repair)
// ---------------------------------------------------------------------------

const LUCIDE_ICON_MAP: Record<string, string> = {
	IconSend: 'Send',
	IconPlus: 'Plus',
	IconX: 'X',
	IconSettings: 'Settings',
	IconLayoutDashboard: 'LayoutDashboard',
	IconChatBot: 'Bot',
	IconBot: 'Bot',
	IconBuilding2: 'Building2',
	IconUserPlus: 'UserPlus',
	IconTrash: 'Trash2',
	IconTrash2: 'Trash2',
	IconEdit: 'Edit',
	IconCheck: 'Check',
	IconCopy: 'Copy',
	IconMoon: 'Moon',
	IconSun: 'Sun',
	IconSearch: 'Search',
	IconChevronDown: 'ChevronDown',
	IconChevronUp: 'ChevronUp',
	IconChevronLeft: 'ChevronLeft',
	IconChevronRight: 'ChevronRight',
	IconMenu: 'Menu',
	IconUser: 'User',
	IconUsers: 'Users',
	IconBell: 'Bell',
	IconFolder: 'Folder',
	IconFile: 'File',
	IconDownload: 'Download',
	IconUpload: 'Upload',
	IconEye: 'Eye',
	IconEyeOff: 'EyeOff',
	IconLock: 'Lock',
	IconUnlock: 'Unlock',
	IconMail: 'Mail',
	IconPhone: 'Phone',
	IconMessageSquare: 'MessageSquare',
	IconMessageCircle: 'MessageCircle',
	IconHelpCircle: 'HelpCircle',
	IconInfo: 'Info',
	IconAlertTriangle: 'AlertTriangle',
	IconAlertCircle: 'AlertCircle',
	IconCheckCircle: 'CheckCircle',
	IconExternalLink: 'ExternalLink',
	IconRefreshCw: 'RefreshCw',
	IconFilter: 'Filter',
	IconMoreVertical: 'MoreVertical',
	IconMoreHorizontal: 'MoreHorizontal',
	IconArrowLeft: 'ArrowLeft',
	IconArrowRight: 'ArrowRight',
	IconArrowUp: 'ArrowUp',
	IconArrowDown: 'ArrowDown',
};

const COMMON_LUCIDE_NAMES = new Set(Object.values(LUCIDE_ICON_MAP));

const REACT_HOOKS = new Set([
	'useState', 'useEffect', 'useRef', 'useCallback', 'useMemo', 'useContext', 'useReducer', 'useId', 'useLayoutEffect'
]);

function passAutoImportResolver(files: GeneratedFile[], workspaceRoot: string): GeneratedFile[] {
	// 1. Index exports across all files
	const fileExports = new Map<string, { path: string; hasDefault: boolean; named: Set<string> }>();

	const registerFile = (filePath: string, content: string) => {
		const norm = path.normalize(filePath).replace(/\\/g, '/');
		const named = new Set<string>();
		const hasDefault = /export\s+default\b/.test(content);
		const namedRe = /export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface)\s+([A-Za-z0-9_$]+)/g;
		let m: RegExpExecArray | null;
		while ((m = namedRe.exec(content)) !== null) {
			if (m[1]) named.add(m[1]);
		}
		const braceRe = /export\s*\{\s*([^}]+)\}/g;
		while ((m = braceRe.exec(content)) !== null) {
			if (m[1]) {
				m[1].split(',').forEach(s => {
					const n = s.trim().split(/\s+as\s+/).pop()?.trim();
					if (n) named.add(n);
				});
			}
		}
		fileExports.set(norm, { path: filePath, hasDefault, named });
	};

	for (const f of files) {
		registerFile(f.path, f.content);
	}

	if (workspaceRoot && fs.existsSync(workspaceRoot)) {
		const scanDir = (dir: string, depth = 0) => {
			if (depth > 4) return;
			try {
				const entries = fs.readdirSync(dir, { withFileTypes: true });
				for (const e of entries) {
					if (['node_modules', 'dist', 'build', '.git'].includes(e.name)) continue;
					const fullPath = path.join(dir, e.name);
					if (e.isDirectory()) {
						scanDir(fullPath, depth + 1);
					} else if (/\.(tsx|ts|jsx|js)$/.test(e.name)) {
						const rel = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
						if (!fileExports.has(rel)) {
							try {
								registerFile(rel, fs.readFileSync(fullPath, 'utf-8'));
							} catch { /* ignore */ }
						}
					}
				}
			} catch { /* ignore */ }
		};
		scanDir(workspaceRoot);
	}

	return files.map(file => {
		const ext = path.extname(file.path).toLowerCase();
		if (!['.tsx', '.jsx', '.ts', '.js'].includes(ext)) return file;

		let content = file.content;
		let modified = false;

		const getImportStatements = () => {
			const imps = new Set<string>();
			const re = /import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(content)) !== null) {
				if (m[1]) {
					const words = m[1].match(/[A-Za-z0-9_$]+/g);
					if (words) words.forEach(w => imps.add(w));
				}
			}
			return imps;
		};

		// A. React hooks auto-import
		if (['.tsx', '.jsx'].includes(ext) || content.includes("from 'react'") || content.includes('from "react"')) {
			const missingHooks: string[] = [];
			const importedSyms = getImportStatements();

			for (const hook of REACT_HOOKS) {
				const hookRegex = new RegExp(`\\b${hook}\\s*\\(`, 'g');
				if (hookRegex.test(content) && !importedSyms.has(hook)) {
					missingHooks.push(hook);
				}
			}

			if (missingHooks.length > 0) {
				log(`AutoImport: Injecting missing React hook(s) [${missingHooks.join(', ')}] in ${file.path}`);
				const reactImportRe = /import\s+React(?:\s*,\s*\{([^}]*)\})?\s+from\s+['"]react['"];?/;
				const match = reactImportRe.exec(content);
				if (match) {
					const existingSpecifiers = match[1] ? match[1].split(',').map(s => s.trim()).filter(Boolean) : [];
					const combined = [...new Set([...existingSpecifiers, ...missingHooks])];
					content = content.replace(match[0], `import React, { ${combined.join(', ')} } from 'react';`);
					modified = true;
				} else if (/import\s+\{([^}]*)\}\s+from\s+['"]react['"];?/.test(content)) {
					content = content.replace(/import\s+\{([^}]*)\}\s+from\s+['"]react['"];?/, (m, p1) => {
						const existingSpecifiers = p1.split(',').map((s: string) => s.trim()).filter(Boolean);
						const combined = [...new Set([...existingSpecifiers, ...missingHooks])];
						return `import React, { ${combined.join(', ')} } from 'react';`;
					});
					modified = true;
				} else {
					content = `import React, { ${missingHooks.join(', ')} } from 'react';\n` + content;
					modified = true;
				}
			}
		}

		// B. Local component auto-import (JSX tags)
		if (['.tsx', '.jsx'].includes(ext)) {
			const jsxTagRe = /<([A-Z][A-Za-z0-9]*)(?:\s|\s*\/?>)/g;
			const usedTags = new Set<string>();
			let m: RegExpExecArray | null;
			while ((m = jsxTagRe.exec(content)) !== null) {
				if (m[1]) usedTags.add(m[1]);
			}

			const fileDir = path.dirname(file.path).replace(/\\/g, '/');
			const importedSyms = getImportStatements();
			const codeWithoutImports = content.replace(/^import\s+[^;]+;?/gm, '');

			const missingComponents = new Map<string, { relPath: string; isDefault: boolean }>();

			for (const tag of usedTags) {
				if (['React', 'Fragment', 'StrictMode', 'Suspense', 'Profiler'].includes(tag)) continue;
				if (importedSyms.has(tag)) continue;
				const isLocallyDeclared = new RegExp(`(?:function|class|const|let|var|type|interface)\\s+${tag}\\b`).test(codeWithoutImports);
				if (isLocallyDeclared) continue;
				if (LUCIDE_ICON_MAP[tag] || COMMON_LUCIDE_NAMES.has(tag)) continue;

				const fileNorm = path.normalize(file.path).replace(/\\/g, '/');
				for (const [otherRelPath, exp] of fileExports.entries()) {
					if (otherRelPath === fileNorm) continue;
					const otherBase = path.basename(otherRelPath, path.extname(otherRelPath));
					if (exp.named.has(tag)) {
						let rel = path.relative(fileDir, otherRelPath).replace(/\\/g, '/');
						if (!rel.startsWith('.')) rel = './' + rel;
						rel = rel.replace(/\.(tsx|jsx|ts|js)$/, '');
						missingComponents.set(tag, { relPath: rel, isDefault: false });
						break;
					} else if (exp.hasDefault && otherBase === tag) {
						let rel = path.relative(fileDir, otherRelPath).replace(/\\/g, '/');
						if (!rel.startsWith('.')) rel = './' + rel;
						rel = rel.replace(/\.(tsx|jsx|ts|js)$/, '');
						missingComponents.set(tag, { relPath: rel, isDefault: true });
						break;
					}
				}
			}

			if (missingComponents.size > 0) {
				const importStatements: string[] = [];
				for (const [tag, { relPath, isDefault }] of missingComponents.entries()) {
					log(`AutoImport: Injecting component import "${tag}" from '${relPath}' in ${file.path}`);
					if (isDefault) {
						importStatements.push(`import ${tag} from '${relPath}';`);
					} else {
						importStatements.push(`import { ${tag} } from '${relPath}';`);
					}
				}
				const firstImportIdx = content.indexOf('import ');
				if (firstImportIdx >= 0) {
					const lineEnd = content.indexOf('\n', firstImportIdx);
					content = content.slice(0, lineEnd + 1) + importStatements.join('\n') + '\n' + content.slice(lineEnd + 1);
				} else {
					content = importStatements.join('\n') + '\n' + content;
				}
				modified = true;
			}
		}

		// C. Lucide Icon auto-import
		const neededLucideIcons = new Map<string, string>();
		const importedSyms = getImportStatements();
		const codeWithoutImports = content.replace(/^import\s+[^;]+;?/gm, '');

		for (const [iconAlias, lucideExport] of Object.entries(LUCIDE_ICON_MAP)) {
			const aliasPattern = new RegExp(`\\b${iconAlias}\\b`);
			if (aliasPattern.test(content) && !importedSyms.has(iconAlias)) {
				const isLocallyDeclared = new RegExp(`(?:function|class|const|let|var|type|interface)\\s+${iconAlias}\\b`).test(codeWithoutImports);
				if (!isLocallyDeclared) {
					neededLucideIcons.set(iconAlias, lucideExport);
				}
			}
		}

		const directJsxTagRe = /<([A-Z][A-Za-z0-9]*)(?:\s|\s*\/?>)/g;
		let directMatch: RegExpExecArray | null;
		while ((directMatch = directJsxTagRe.exec(content)) !== null) {
			const tag = directMatch[1]!;
			if (COMMON_LUCIDE_NAMES.has(tag) && !importedSyms.has(tag) && !neededLucideIcons.has(tag)) {
				const isLocallyDeclared = new RegExp(`(?:function|class|const|let|var|type|interface)\\s+${tag}\\b`).test(codeWithoutImports);
				if (!isLocallyDeclared) {
					neededLucideIcons.set(tag, tag);
				}
			}
		}

		if (neededLucideIcons.size > 0) {
			const importParts: string[] = [];
			for (const [alias, lucideExport] of neededLucideIcons.entries()) {
				if (alias === lucideExport) {
					importParts.push(lucideExport);
				} else {
					importParts.push(`${lucideExport} as ${alias}`);
				}
			}
			log(`AutoImport: Injecting Lucide icon(s) [${importParts.join(', ')}] in ${file.path}`);

			const lucideRe = /import\s+\{([^}]*)\}\s+from\s+['"]lucide-react['"];?/;
			const match = lucideRe.exec(content);
			if (match) {
				const existing = match[1] ? match[1].split(',').map(s => s.trim()).filter(Boolean) : [];
				const combined = [...new Set([...existing, ...importParts])];
				content = content.replace(match[0], `import { ${combined.join(', ')} } from 'lucide-react';`);
			} else {
				const lastImportIdx = content.lastIndexOf('import ');
				if (lastImportIdx >= 0) {
					const lineEnd = content.indexOf('\n', lastImportIdx);
					content = content.slice(0, lineEnd + 1) + `import { ${importParts.join(', ')} } from 'lucide-react';\n` + content.slice(lineEnd + 1);
				} else {
					content = `import { ${importParts.join(', ')} } from 'lucide-react';\n` + content;
				}
			}
			modified = true;
		}

		return modified ? { ...file, content } : file;
	});
}

// ---------------------------------------------------------------------------
// PASS 3 — Scope Validator
// ---------------------------------------------------------------------------

// FE artifacts that must not appear in a backend-only project
const BACKEND_SCOPE_VIOLATIONS = [
	{ pattern: /\.(tsx|jsx)$/, reason: 'TSX/JSX file in backend-only project' },
	{ pattern: /App\.tsx|main\.tsx|index\.tsx/, reason: 'React entry file in backend-only project' },
	{ pattern: /from ['"]react['"]|from ['"]react-dom['"]/, reason: 'React import in backend-only project' },
	{ pattern: /useState\s*\(|useEffect\s*\(|useRef\s*\(/, reason: 'React hooks in backend-only project' },
	{ pattern: /className\s*=|tailwind|@apply/, reason: 'Frontend styling in backend-only project' },
	{ pattern: /window\.|document\.|localStorage\./, reason: 'Browser API in backend-only project' },
];

// BE artifacts that must not appear in a frontend-only project
const FRONTEND_SCOPE_VIOLATIONS = [
	{ pattern: /schema\.prisma$|\.migration\.ts$/, reason: 'Database migration in frontend-only project' },
	{ pattern: /from ['"]express['"]|from ['"]fastify['"]/, reason: 'Express/Fastify in frontend-only project' },
	{ pattern: /class\s+\w+Controller\b/, reason: 'Controller class in frontend-only project' },
	{ pattern: /class\s+\w+Repository\b/, reason: 'Repository class in frontend-only project' },
];

function pass3ScopeValidator(files: GeneratedFile[], contract: ValidationContract | undefined, issues: ValidationIssue[]): GeneratedFile[] {
	if (!contract || contract.scope === 'unknown' || contract.scope === 'fullstack') return files;

	if (contract.scope === 'backend') {
		for (const f of files) {
			const pathAndContent = f.path + '\n' + f.content;
			for (const v of BACKEND_SCOPE_VIOLATIONS) {
				if (v.pattern.test(f.path) || v.pattern.test(f.content)) {
					issues.push({ kind: 'scope_violation', file: f.path, message: `${v.reason}: ${f.path}`, severity: 'error' });
					break;
				}
			}
		}
		// Filter out .tsx/.jsx files entirely — backend never needs them
		return files.filter(f => {
			const ext = path.extname(f.path).toLowerCase();
			if (['.tsx', '.jsx'].includes(ext)) {
				log(`scope: removed ${f.path} — TSX/JSX not allowed in backend-only scope`);
				return false;
			}
			return true;
		});
	}

	if (contract.scope === 'frontend') {
		for (const f of files) {
			for (const v of FRONTEND_SCOPE_VIOLATIONS) {
				if (v.pattern.test(f.path) || v.pattern.test(f.content)) {
					issues.push({ kind: 'scope_violation', file: f.path, message: `${v.reason}: ${f.path}`, severity: 'error' });
					break;
				}
			}
		}
	}

	return files;
}

// ---------------------------------------------------------------------------
// PASS 4 — Framework Validation (ported from v1)
// ---------------------------------------------------------------------------

type Framework = 'vite' | 'cra' | 'next' | 'unknown';

function detectFramework(files: GeneratedFile[]): Framework {
	const paths = new Set(files.map(f => f.path));
	const hasViteHtml = files.some(f => f.path === 'index.html' && /type=["']module["']/.test(f.content) && /src\/main/.test(f.content));
	const hasSrcMainTsx = paths.has('src/main.tsx') || paths.has('src/main.jsx');
	const hasSrcIndexTsx = paths.has('src/index.tsx') || paths.has('src/index.jsx');
	const hasAppPageTsx  = paths.has('app/page.tsx')  || paths.has('app/page.jsx');
	const hasAppLayout   = paths.has('app/layout.tsx') || paths.has('app/layout.jsx');
	const hasCRAEntry = files.some(f => f.path === 'public/index.html');
	const hasCreateRoot = files.some(f => /createRoot\s*\(/.test(f.content));
	const hasRenderLegacy = files.some(f => /ReactDOM\.render\s*\(/.test(f.content));
	if (hasCreateRoot && hasRenderLegacy) warn('mixed ReactDOM.render + createRoot detected');
	if (hasSrcIndexTsx && hasSrcMainTsx) warn('both index.tsx and main.tsx present — possible mixed convention');
	const isVite = hasViteHtml || hasSrcMainTsx;
	const isCRA  = hasCRAEntry || hasSrcIndexTsx;
	const isNext = hasAppPageTsx || hasAppLayout;
	if (isNext && !isVite && !isCRA) return 'next';
	if (isVite && !isCRA) return 'vite';
	if (isCRA && !isVite) return 'cra';
	if (isVite || isCRA) return 'vite';
	return 'unknown';
}

function pass4FrameworkValidation(files: GeneratedFile[]): GeneratedFile[] {
	const framework = detectFramework(files);
	log(framework === 'unknown' ? 'framework unknown — skipping framework-specific repair' : `${framework} detected`);
	if (framework === 'next') {
		return files.filter(f => {
			if (f.path === 'index.html' || f.path === 'public/index.html') {
				log(`removed index.html — Next.js does not use HTML entry`);
				return false;
			}
			return true;
		});
	}
	if (framework === 'vite') {
		return files.map(f => {
			if ((f.path === 'src/main.tsx' || f.path === 'src/main.jsx') && /ReactDOM\.render\s*\(/.test(f.content)) {
				warn(`ReactDOM.render in ${f.path} — rewriting to createRoot`);
				const fixed = f.content
					.replace(/ReactDOM\.render\(\s*([\s\S]+?),\s*document\.getElementById\(['"]root['"]\)\s*\)/, `const root = createRoot(document.getElementById('root')!);\nroot.render($1)`)
					.replace(/import ReactDOM from ['"]react-dom['"]/, `import { createRoot } from 'react-dom/client'`)
					.replace(/import \* as ReactDOM from ['"]react-dom['"]/, `import { createRoot } from 'react-dom/client'`);
				return { ...f, content: fixed };
			}
			return f;
		});
	}
	return files;
}

// ---------------------------------------------------------------------------
// PASS 5 — Package Validation (ported from v1)
// ---------------------------------------------------------------------------

function readPackageJson(workspaceRoot: string): Set<string> {
	try {
		const pkgPath = path.join(workspaceRoot, 'package.json');
		if (!fs.existsSync(pkgPath)) return new Set();
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
		const deps = { ...pkg.dependencies ?? {}, ...pkg.devDependencies ?? {}, ...pkg.peerDependencies ?? {} };
		return new Set(Object.keys(deps));
	} catch { return new Set(); }
}

function extractPackageImports(content: string): string[] {
	const pkgs = new Set<string>();
	const re = /import\s+(?:[\w{}\s*,]+\s+from\s+)?['"]([^'".][^'"]*)['\"]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) {
		if (m[1]) {
			if (m[1].startsWith('@/') || m[1].startsWith('~/')) continue;
			const spec = m[1].startsWith('@') ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0]!;
			pkgs.add(spec);
		}
	}
	return [...pkgs];
}

const NODE_BUILTINS = new Set([
	'fs', 'path', 'os', 'http', 'https', 'crypto', 'util', 'stream',
	'events', 'child_process', 'readline', 'url', 'buffer', 'assert',
	'module', 'process', 'timers', 'vm', 'zlib', 'net', 'tls',
	'node:fs', 'node:path', 'node:os', 'node:http', 'node:https',
	'node:crypto', 'node:util', 'node:stream', 'node:events',
	'node:child_process', 'node:url', 'node:buffer',
	'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime',
]);

function pass5PackageValidation(files: GeneratedFile[], workspaceRoot: string): GeneratedFile[] {
	const installed = readPackageJson(workspaceRoot);
	if (installed.size === 0) return files;
	return files.map(f => {
		const ext = path.extname(f.path).toLowerCase();
		if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return f;
		const pkgImports = extractPackageImports(f.content);
		let content = f.content;
		let changed = false;
		for (const pkg of pkgImports) {
			if (NODE_BUILTINS.has(pkg) || installed.has(pkg)) continue;
			warn(`${f.path}: import "${pkg}" not in package.json — removing`);
			const re = new RegExp(`^import\\s+(?:[\\w{}\\s*,]+\\s+from\\s+)?['"]${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\/[^'"]*)?['"][^\\n]*\\n?`, 'gm');
			content = content.replace(re, '');
			changed = true;
		}
		return changed ? { ...f, content } : f;
	});
}

// ---------------------------------------------------------------------------
// PASS 6 — Import Validation (ported from v1, warns)
// ---------------------------------------------------------------------------

const RESOLVE_EXTS = ['', '.tsx', '.jsx', '.ts', '.js', '/index.tsx', '/index.jsx', '/index.ts', '/index.js'];

function resolveLocalImport(importPath: string, fromFile: string, files: GeneratedFile[], workspaceRoot: string): boolean {
	let resolved: string;
	if (importPath.startsWith('@/') || importPath.startsWith('~/')) {
		resolved = path.normalize(path.join('src', importPath.slice(2))).replace(/\\/g, '/');
	} else {
		const fromDir = path.dirname(fromFile);
		resolved = path.normalize(path.join(fromDir, importPath)).replace(/\\/g, '/');
	}
	if (RESOLVE_EXTS.some(ext => files.some(f => f.path.replace(/\\/g, '/') === resolved + ext || f.path.replace(/\\/g, '/') === resolved))) return true;
	return RESOLVE_EXTS.some(ext => { try { return fs.existsSync(path.join(workspaceRoot, resolved + ext)); } catch { return false; } });
}

/**
 * Pass 6: Import validation — warns on unresolved local imports.
 * DependencyStatus-aware: Planned and Generated imports are never flagged.
 * When graph + committedPaths are provided, only Missing imports produce warnings.
 */
function pass6ImportValidation(
	files:          GeneratedFile[],
	workspaceRoot:  string,
	issues:         ValidationIssue[],
	graph?:         ExecutionGraph,
	committedPaths?: Set<string>,
): GeneratedFile[] {
	const LOCAL_IMPORT_RE = /import\s+(?:[\w{}\s*,]+\s+from\s+)?['"]((?:\.\.?\/|@\/|~\/).+?)['"]/g;
	for (const f of files) {
		const ext = path.extname(f.path).toLowerCase();
		if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;
		const re = new RegExp(LOCAL_IMPORT_RE.source, 'g');
		let m: RegExpExecArray | null;
		while ((m = re.exec(f.content)) !== null) {
			if (!m[1]) continue;
			const spec = m[1];

			// DependencyStatus-aware filter: skip Planned/Generated
			if (graph && committedPaths) {
				const status = classifyDependency(spec, f.path, graph, committedPaths, workspaceRoot);
				if (!isImportError(status)) continue;
			} else if (!resolveLocalImport(spec, f.path, files, workspaceRoot)) {
				// Fallback: resolve against current files + disk
				warn(`${f.path}: import "${spec}" unresolved`);
				issues.push({ kind: 'missing_import', file: f.path, message: `Unresolved import "${spec}" in ${f.path}`, severity: 'warning' });
			}
		}
	}
	return files;
}

// ---------------------------------------------------------------------------
// PASS 7 — Requirement Coverage (weighted)
// ---------------------------------------------------------------------------

function pass7RequirementCoverage(
	files: GeneratedFile[],
	contract: ValidationContract | undefined,
	issues: ValidationIssue[],
): { coverageScore: number; coverageMax: number } {
	if (!contract || contract.requiredFeatures.length === 0) return { coverageScore: 0, coverageMax: 0 };

	const allContent = files.map(f => f.content).join('\n');
	let score = 0;
	let maxScore = 0;

	for (const featureKey of contract.requiredFeatures) {
		const spec = FEATURE_WEIGHTS[featureKey];
		if (!spec) continue;
		maxScore += spec.weight;
		const matched = spec.patterns.some(p => p.test(allContent));
		if (matched) {
			score += spec.weight;
			log(`coverage: ✅ ${featureKey} (+${spec.weight})`);
		} else {
			log(`coverage: ❌ ${featureKey} (missing, -${spec.weight})`);
			issues.push({
				kind: 'missing_coverage',
				message: `Required feature "${featureKey}" not found in generated files (weight: ${spec.weight})`,
				severity: 'error',
			});
		}
	}

	if (maxScore > 0) {
		log(`coverage: ${score}/${maxScore} (${Math.round(score / maxScore * 100)}%)`);
	}

	return { coverageScore: score, coverageMax: maxScore };
}

// ---------------------------------------------------------------------------
// PASS 8 — Architecture Validator
// ---------------------------------------------------------------------------

function pass8ArchitectureValidator(
	files: GeneratedFile[],
	contract: ValidationContract | undefined,
	issues: ValidationIssue[],
): void {
	if (!contract || contract.architecture === 'unknown' || contract.architecture === 'flat') return;
	const expected = ARCH_FOLDERS[contract.architecture];
	if (!expected) return;

	const generatedPaths = files.map(f => f.path);
	for (const folder of expected) {
		const folderPresent = generatedPaths.some(p => p.startsWith(`${folder}/`) || p.includes(`/${folder}/`));
		if (!folderPresent) {
			issues.push({
				kind: 'missing_architecture',
				message: `Architecture "${contract.architecture}" requires "${folder}/" — folder missing from generated files`,
				severity: 'error',
			});
		}
	}
}


// ---------------------------------------------------------------------------
// PASS 9 — Layer Boundary Validator (ERROR)
// Enforces: routes→controllers→services→repositories→database
// bcrypt/jwt/sendEmail must only be in services
// prisma/mongoose must only be in repositories
// ---------------------------------------------------------------------------

// Layer classification by path prefix
function classifyLayer(filePath: string): 'route' | 'controller' | 'service' | 'repository' | 'model' | 'middleware' | 'other' {
	const p = filePath.toLowerCase();
	if (/\/(routes?|router)\/|\.router\.|\.routes?\./i.test(p)) return 'route';
	if (/\/controllers?\//i.test(p) || p.includes('.controller.')) return 'controller';
	if (/\/services?\//i.test(p) || p.includes('.service.')) return 'service';
	if (/\/repositor/i.test(p) || p.includes('.repository.') || p.includes('.repo.')) return 'repository';
	if (/\/models?\//i.test(p) || p.includes('.model.') || p.includes('.entity.') || p.includes('.schema.')) return 'model';
	if (/\/middleware\//i.test(p) || p.includes('.middleware.')) return 'middleware';
	return 'other';
}

// Which symbols must NOT appear at which layers
const LAYER_VIOLATIONS: Array<{ pattern: RegExp; allowedLayer: string; label: string }> = [
	{ pattern: /\bbcrypt\.(hash|compare)\s*\(/,       allowedLayer: 'service',    label: 'bcrypt belongs in Service layer' },
	{ pattern: /\bjwt\.(sign|verify)\s*\(/,           allowedLayer: 'service',    label: 'jwt.sign/verify belongs in Service layer' },
	{ pattern: /\bsendEmail\s*\(|\.sendMail\s*\(/,    allowedLayer: 'service',    label: 'email sending belongs in Service layer' },
	{ pattern: /\bprisma\.\w+\.(findMany|findUnique|findFirst|create|update|delete|upsert)\s*\(/, allowedLayer: 'repository', label: 'Prisma queries belong in Repository layer' },
	{ pattern: /\.find\s*\(|\.findOne\s*\(|\.save\s*\(|\.deleteOne\s*\(/,  allowedLayer: 'repository', label: 'Mongoose queries belong in Repository layer' },
	{ pattern: /pool\.query\s*\(|db\.query\s*\(|client\.query\s*\(/, allowedLayer: 'repository', label: 'Raw DB queries belong in Repository layer' },
];

// Illegal direct import patterns between layers
const ILLEGAL_IMPORTS: Array<{ from: string; to: string; message: string }> = [
	{ from: 'route',      to: 'repository', message: 'Route imports directly from Repository (must go through Service)' },
	{ from: 'route',      to: 'model',      message: 'Route imports directly from Model (must go through Service/Repository)' },
	{ from: 'controller', to: 'repository', message: 'Controller imports directly from Repository (must go through Service)' },
	{ from: 'controller', to: 'model',      message: 'Controller imports directly from Model (must go through Service/Repository)' },
];

function pass9LayerBoundaryValidator(files: GeneratedFile[], issues: ValidationIssue[]): void {
	// Build path→layer map for generated files
	const layerMap = new Map<string, string>();
	for (const f of files) layerMap.set(f.path, classifyLayer(f.path));

	for (const f of files) {
		const layer = layerMap.get(f.path) ?? 'other';
		if (layer === 'other' || layer === 'model' || layer === 'middleware') continue;

		// Check symbol violations (bcrypt in routes, prisma in controllers, etc.)
		for (const viol of LAYER_VIOLATIONS) {
			if (layer === viol.allowedLayer) continue; // allowed here
			if (layer === 'other') continue;
			if (viol.pattern.test(f.content)) {
				issues.push({
					kind: 'business_logic_leak',
					file: f.path,
					message: `Layer violation in ${layer}: ${viol.label}`,
					severity: 'error',
				});
			}
		}

		// Check illegal import directions
		const importRe = /from\s+['"]((?:\.[^'"]+|@\/[^'"]+|~\/[^'"]+))['"]/g;
		let m: RegExpExecArray | null;
		while ((m = importRe.exec(f.content)) !== null) {
			if (!m[1]) continue;
			const importedPath = (m[1].startsWith('@/') || m[1].startsWith('~/'))
				? path.normalize(path.join('src', m[1].slice(2)))
				: path.normalize(path.join(path.dirname(f.path), m[1]));
			// Find which generated file this resolves to
			const importedFile = files.find(other => {
				const base = other.path.replace(/\.(ts|tsx|js|jsx)$/, '');
				return base === importedPath || other.path === importedPath ||
					base === importedPath.replace(/\.(ts|tsx|js|jsx)$/, '');
			});
			if (!importedFile) continue;
			const importedLayer = classifyLayer(importedFile.path);

			for (const ill of ILLEGAL_IMPORTS) {
				if (layer === ill.from && importedLayer === ill.to) {
					issues.push({
						kind: 'missing_architecture',
						file: f.path,
						message: `${ill.message}: ${f.path} → ${importedFile.path}`,
						severity: 'error',
					});
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// PASS 10 — Business Logic Leak Detector (warning — kept from v1 pass 9)
// ---------------------------------------------------------------------------

// Patterns that belong in service layer, not route files

const SERVICE_PATTERNS: Array<{ re: RegExp; label: string }> = [
	{ re: /bcrypt\.(hash|compare)\s*\(/, label: 'bcrypt inside route' },
	{ re: /jwt\.(sign|verify)\s*\(/, label: 'JWT generation inside route' },
	{ re: /\.sendMail\s*\(|sendEmail\s*\(/, label: 'email sending inside route' },
	{ re: /prisma\.\w+\.(findMany|findUnique|create|update|delete)\s*\(/, label: 'Prisma query inside route' },
	{ re: /mongoose\.model\(|Model\.find\(|\.save\(\)/, label: 'Mongoose query inside route' },
	{ re: /pool\.query\s*\(|db\.query\s*\(/, label: 'raw DB query inside route' },
];

const ROUTE_FILE_PATTERN = /^(routes?\/|src\/routes?\/|src\/api\/|api\/)/i;

function pass10BusinessLogicLeak(files: GeneratedFile[], issues: ValidationIssue[]): void {
	for (const f of files) {
		if (!ROUTE_FILE_PATTERN.test(f.path)) continue;
		for (const sp of SERVICE_PATTERNS) {
			if (sp.re.test(f.content)) {
				issues.push({
					kind: 'business_logic_leak',
					file: f.path,
					message: `${sp.label} — move to a Service class`,
					severity: 'warning',
				});
			}
		}
	}
}

// ---------------------------------------------------------------------------
// PASS 10 — Route Size Validator (warning only)
// ---------------------------------------------------------------------------

function pass11RouteSize(files: GeneratedFile[], issues: ValidationIssue[]): void {
	const ROUTE_LINE_LIMIT = 120;
	for (const f of files) {
		if (!ROUTE_FILE_PATTERN.test(f.path)) continue;
		const lines = f.content.split('\n').length;
		if (lines > ROUTE_LINE_LIMIT) {
			issues.push({ kind: 'route_too_large', file: f.path, message: `Route file ${f.path} has ${lines} lines (>${ROUTE_LINE_LIMIT}). Business logic likely misplaced.`, severity: 'warning' });
		}
	}
}

// ---------------------------------------------------------------------------
// PASS 11 — Undefined Symbol Validator
// ---------------------------------------------------------------------------

function extractDefinedSymbols(content: string): Set<string> {
	const syms = new Set<string>();
	const re = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
	const constRe = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) if (m[1]) syms.add(m[1]);
	while ((m = constRe.exec(content)) !== null) if (m[1]) syms.add(m[1]);
	return syms;
}

function extractNamedImports(content: string): Set<string> {
	const syms = new Set<string>();
	const namedRe = /import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g;
	const defRe   = /import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"][^'"]+['"]/g;
	const nsRe    = /import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"][^'"]+['"]/g;
	let m: RegExpExecArray | null;
	while ((m = namedRe.exec(content)) !== null) {
		m[1]!.split(',').forEach(s => { const name = s.trim().split(/\s+as\s+/).pop()!.trim(); if (name) syms.add(name); });
	}
	while ((m = defRe.exec(content)) !== null) if (m[1]) syms.add(m[1]);
	while ((m = nsRe.exec(content)) !== null) if (m[1]) syms.add(m[1]);
	return syms;
}

function pass12UndefinedSymbols(files: GeneratedFile[], workspaceRoot: string, issues: ValidationIssue[]): void {
	const globalSymbols = new Set<string>();
	for (const f of files) extractDefinedSymbols(f.content).forEach(s => globalSymbols.add(s));

	for (const f of files) {
		const ext = path.extname(f.path).toLowerCase();
		if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;
		const impRe = /from\s+['"]((?:\.[^'"]+|@\/[^'"]+|~\/[^'"]+))['"]/g;
		let m: RegExpExecArray | null;
		while ((m = impRe.exec(f.content)) !== null) {
			if (!m[1]) continue;
			const resolved = (m[1].startsWith('@/') || m[1].startsWith('~/'))
				? path.normalize(path.join('src', m[1].slice(2)))
				: path.normalize(path.join(path.dirname(f.path), m[1]));
			for (const e2 of RESOLVE_EXTS) {
				const absPath = path.join(workspaceRoot, resolved + e2);
				try {
					if (fs.existsSync(absPath) && !fs.statSync(absPath).isDirectory()) {
						extractDefinedSymbols(fs.readFileSync(absPath, 'utf-8')).forEach(s => globalSymbols.add(s));
						break;
					}
				} catch { /* ignore */ }
			}
		}
	}

	const CTRL_RE = /(?:^|[\\/])(?:routes?|controllers?|services?|middlewares?|models?|validators?)[\\/]/i;
	const SKIP_SYMS = new Set([
		'require', 'import', 'typeof', 'next', 'res', 'req', 'err', 'error', 'console', 'process',
		'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
		'JSON', 'Math', 'Promise', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
		'data', 'result', 'Date', 'RegExp', 'Array', 'Object', 'String', 'Number', 'Boolean',
		'Symbol', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError',
		'SyntaxError', 'Buffer', 'URL', 'URLSearchParams', 'fetch', 'Headers', 'Request', 'Response',
		'FormData', 'AbortController', 'Blob'
	]);

	for (const f of files) {
		if (!CTRL_RE.test(f.path)) continue;
		const fExt = path.extname(f.path).toLowerCase();
		if (!['.ts', '.js'].includes(fExt)) continue;
		const localImports = extractNamedImports(f.content);
		const localDefined = extractDefinedSymbols(f.content);

		// 1. Calls: await someFunc() or await SomeClass.someFunc() or someFunc()
		const callRe = /\b(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/g;
		let m: RegExpExecArray | null;
		while ((m = callRe.exec(f.content)) !== null) {
			const sym = m[1]!;
			if (SKIP_SYMS.has(sym) || localImports.has(sym) || localDefined.has(sym) || globalSymbols.has(sym)) continue;
			issues.push({ kind: 'undefined_symbol', file: f.path, message: `"${sym}" called or referenced but not defined or imported`, severity: 'error' });
		}

		// 2. New instantiations: new SomeClass() or new somePackage.SomeClass()
		const newRe = /\bnew\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/g;
		while ((m = newRe.exec(f.content)) !== null) {
			const sym = m[1]!;
			if (SKIP_SYMS.has(sym) || localImports.has(sym) || localDefined.has(sym) || globalSymbols.has(sym)) continue;
			issues.push({ kind: 'undefined_symbol', file: f.path, message: `"${sym}" instantiated with new but not defined or imported`, severity: 'error' });
		}
	}
}

// ---------------------------------------------------------------------------
// PASS 12 — Dead Code Detector (warning)
// ---------------------------------------------------------------------------

function pass14DeadCode(files: GeneratedFile[], issues: ValidationIssue[]): void {
	for (const f of files) {
		const ext = path.extname(f.path).toLowerCase();
		if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;
		if (/main\.(ts|tsx|js)|index\.(ts|tsx|js)|app\.(ts|tsx|js)|server\.ts|\.config\./i.test(f.path)) continue;
		const base     = f.path.replace(/\.(ts|tsx|js|jsx)$/, '');
		const basename = path.basename(base);
		const aliasBase = base.startsWith('src/') ? '@/' + base.slice(4) : '';
		const imported = files.some(other => {
			if (other.path === f.path) return false;
			return other.content.includes(`'${base}'`) || other.content.includes(`"${base}"`) ||
				(aliasBase && (other.content.includes(`'${aliasBase}'`) || other.content.includes(`"${aliasBase}"`))) ||
				other.content.includes(`'${basename}'`) || other.content.includes(`"${basename}"`) ||
				other.content.includes(`/${basename}'`) || other.content.includes(`/${basename}"`);
		});
		if (!imported) {
			issues.push({ kind: 'dead_code', file: f.path, message: `${f.path} never imported by any other generated file`, severity: 'warning' });
		}
	}
}

// ---------------------------------------------------------------------------
// PASS 13 — Dependency Validator (ERROR — missing local imports)
// Separate from pass 6 (warning). Unresolved local imports = compile failure risk.
// ---------------------------------------------------------------------------

/**
 * Pass 13: Dependency validator — missing local imports = compile failure risk.
 * DependencyStatus-aware: Planned and Generated imports are NEVER errors.
 * When graph + committedPaths are provided, only Missing imports produce errors.
 */
function pass13DependencyValidator(
	files:           GeneratedFile[],
	workspaceRoot:   string,
	issues:          ValidationIssue[],
	graph?:          ExecutionGraph,
	committedPaths?: Set<string>,
): void {
	const LOCAL_IMPORT_RE = /import\s+(?:[\w{}\s*,]+\s+from\s+)?['"]((?:\.\.?\/|@\/|~\/).+?)['"]/g;
	for (const f of files) {
		const ext = path.extname(f.path).toLowerCase();
		if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;
		const re = new RegExp(LOCAL_IMPORT_RE.source, 'g');
		let m: RegExpExecArray | null;
		while ((m = re.exec(f.content)) !== null) {
			if (!m[1]) continue;
			const importPath = m[1];

			// DependencyStatus-aware: skip if Planned or Generated
			if (graph && committedPaths) {
				const status = classifyDependency(importPath, f.path, graph, committedPaths, workspaceRoot);
				if (!isImportError(status)) continue;
				issues.push({
					kind:     'missing_import',
					file:     f.path,
					message:  `Cannot resolve local import "${importPath}" — file missing from graph and workspace`,
					severity: 'error',
				});
				continue;
			}

			// Fallback (no graph context): check in generated files + disk
			let resolved: string;
			if (importPath.startsWith('@/') || importPath.startsWith('~/')) {
				resolved = path.normalize(path.join('src', importPath.slice(2))).replace(/\\/g, '/');
			} else {
				const fromDir  = path.dirname(f.path);
				resolved = path.normalize(path.join(fromDir, importPath)).replace(/\\/g, '/');
			}
			const inFiles  = RESOLVE_EXTS.some(ext2 => files.some(g => g.path.replace(/\\/g, '/') === resolved + ext2 || g.path.replace(/\\/g, '/') === resolved));
			if (inFiles) continue;
			const onDisk = RESOLVE_EXTS.some(ext2 => {
				try { return fs.existsSync(path.join(workspaceRoot, resolved + ext2)); } catch { return false; }
			});
			if (!onDisk) {
				issues.push({
					kind:     'missing_import',
					file:     f.path,
					message:  `Cannot resolve local import "${importPath}" — file missing from generated output and workspace`,
					severity: 'error',
				});
			}
		}
	}
}

// ---------------------------------------------------------------------------
// PASS 15 — Workspace Collision Detector (WARNING)
// Detect when generated files duplicate functionality already in workspace
// ---------------------------------------------------------------------------

// Module name extractors — get the semantic name from a file path
// e.g. services/auth.service.ts → 'auth', controllers/users.controller.ts → 'users'
function extractModuleName(filePath: string): string | null {
	const base = path.basename(filePath, path.extname(filePath));
	// Strip layer suffixes: .service, .controller, .repository, .router, .route, .middleware
	const cleaned = base
		.replace(/\.(service|controller|repository|router|route|routes|middleware|guard|module|dto|entity|model|schema)$/i, '')
		.toLowerCase();
	return cleaned.length > 0 ? cleaned : null;
}

function pass15WorkspaceCollision(files: GeneratedFile[], workspaceRoot: string, issues: ValidationIssue[]): void {
	// Collect existing workspace files (excluding node_modules, dist, build)
	const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.git', '.next', '__pycache__']);
	const existingFiles: string[] = [];

	function scanDir(dir: string, depth: number = 0): void {
		if (depth > 5) return;
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const e of entries) {
				if (SKIP_DIRS.has(e.name)) continue;
				if (e.isDirectory()) {
					scanDir(path.join(dir, e.name), depth + 1);
				} else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) {
					existingFiles.push(path.join(dir, e.name));
				}
			}
		} catch { /* ignore */ }
	}

	scanDir(workspaceRoot);

	// Build module→layer→absolutePath map for workspace
	const wsModuleMap = new Map<string, string[]>(); // moduleName → [paths]
	for (const absPath of existingFiles) {
		const rel = path.relative(workspaceRoot, absPath);
		const mod = extractModuleName(rel);
		if (!mod) continue;
		if (!wsModuleMap.has(mod)) wsModuleMap.set(mod, []);
		wsModuleMap.get(mod)!.push(rel);
	}

	// Check generated files against workspace
	for (const f of files) {
		const genMod = extractModuleName(f.path);
		if (!genMod) continue;
		const existing = wsModuleMap.get(genMod);
		if (!existing || existing.length === 0) continue;

		// Filter: skip if the generated file IS the existing file (same relative path)
		const genRel = f.path;
		const nonSelf = existing.filter(e => e !== genRel && path.basename(e, path.extname(e)).toLowerCase() !== path.basename(genRel, path.extname(genRel)).toLowerCase().replace(/\.(service|controller|repository|router|route)$/i, ''));
		if (nonSelf.length === 0) continue;

		issues.push({
			kind: 'dead_code',
			file: f.path,
			message: `Module "${genMod}" already exists in workspace: ${nonSelf.slice(0, 2).join(', ')}. Consider extending existing module rather than creating a duplicate.`,
			severity: 'warning',
		});
	}
}

// ---------------------------------------------------------------------------
// PASS 16 — Security Validator (warning)
// ---------------------------------------------------------------------------

const SECURITY_CHECKS: Array<{ re: RegExp; message: string }> = [
	{ re: /Math\.random\(\)/,                                                  message: 'Math.random() for token generation — use crypto.randomBytes()' },
	{ re: /JWT_SECRET\s*[=:]\s*['"][^'"]{1,20}['"]/,                          message: 'Hardcoded JWT secret — use process.env' },
	{ re: /crypto\.createHash\(['"]md5['"]|crypto\.createHash\(['"]sha1['"]/,  message: 'MD5/SHA1 for hashing — use bcrypt or SHA-256' },
	{ re: /eval\s*\(|new Function\s*\(/,                                       message: 'eval()/new Function() — remote code execution risk' },
	{ re: /cors\(\)(?!\s*\{)|origin:\s*['"]\*['"]/,                            message: 'CORS wildcard origin — restrict in production' },
];

function pass16Security(files: GeneratedFile[], issues: ValidationIssue[]): void {
	for (const f of files) {
		const ext = path.extname(f.path).toLowerCase();
		if (!['.ts', '.js', '.tsx'].includes(ext)) continue;
		for (const check of SECURITY_CHECKS) {
			if (check.re.test(f.content)) {
				issues.push({ kind: 'security', file: f.path, message: check.message, severity: 'warning' });
			}
		}
	}
}

// ---------------------------------------------------------------------------
// PASS 14 — TypeScript Quality (warning)
// ---------------------------------------------------------------------------

function pass17TypeScriptQuality(files: GeneratedFile[], issues: ValidationIssue[]): void {
	for (const f of files) {
		const ext = path.extname(f.path).toLowerCase();
		if (!['.ts', '.tsx'].includes(ext)) continue;
		const anyCount = (f.content.match(/:\s*any\b/g) || []).length;
		if (anyCount > 3) issues.push({ kind: 'typescript_quality', file: f.path, message: `${anyCount} uses of ": any" — add proper types`, severity: 'warning' });
		if (/req\.user\b/.test(f.content) && !/declare\s+namespace|interface.*Request|Express\.Request/.test(f.content)) {
			issues.push({ kind: 'typescript_quality', file: f.path, message: 'req.user accessed without Request interface augmentation', severity: 'warning' });
		}
		if (/query\s*:\s*any|params\s*:\s*any|body\s*:\s*any/.test(f.content)) {
			issues.push({ kind: 'typescript_quality', file: f.path, message: 'request.query/params/body typed as any — use typed interfaces', severity: 'warning' });
		}
	}
}

// ---------------------------------------------------------------------------
// PASS 15 — React Validation (ported from v1)
// ---------------------------------------------------------------------------

function hasClassComponent(content: string): boolean {
	return /class\s+\w+\s+extends\s+(?:React\.)?(?:Component|PureComponent)\b/.test(content);
}

function hasRouterImport(content: string): boolean {
	return /from\s+['"]react-router(?:-dom)?['"]/.test(content) ||
		/from\s+['"]@tanstack\/react-router['"]/.test(content);
}

function pass15ReactValidation(files: GeneratedFile[]): GeneratedFile[] {
	const reactFiles = files.filter(f =>
		['.tsx', '.jsx'].includes(path.extname(f.path).toLowerCase()) ||
		f.content.includes("from 'react'") || f.content.includes('from "react"')
	);
	if (reactFiles.length === 0) return files;
	if (!files.some(f => /createRoot\s*\(/.test(f.content))) warn('no createRoot() — React entry may be missing');
	const routerFiles = files.filter(f => hasRouterImport(f.content));
	const reactCount  = files.filter(f => ['.tsx', '.jsx'].includes(path.extname(f.path).toLowerCase())).length;
	if (routerFiles.length > 0 && reactCount <= 1) {
		warn(`react-router imported but only ${reactCount} React file(s) — removing router imports`);
		return files.map(f => {
			if (!hasRouterImport(f.content)) return f;
			const cleaned = f.content
				.replace(/^import\s+\{[^}]+\}\s+from\s+['"]react-router(?:-dom)?['"]\s*\n?/gm, '')
				.replace(/^import\s+\{[^}]+\}\s+from\s+['"]@tanstack\/react-router['"]\s*\n?/gm, '');
			return { ...f, content: cleaned };
		});
	}
	return files;
}

// ---------------------------------------------------------------------------
// PASS 16 — HTML/CSS Validation (ported from v1)
// ---------------------------------------------------------------------------

function pass16HtmlCssValidation(files: GeneratedFile[], framework: Framework): GeneratedFile[] {
	if (framework === 'next') {
		return files.filter(f => { if (f.path === 'index.html') { log('removed index.html — Next.js'); return false; } return true; });
	}
	if (framework !== 'vite') return files;
	let result = files.map(f => {
		if (f.path !== 'index.html') return f;
		let content = f.content; let changed = false;
		if (!content.includes('id="root"') && !content.includes("id='root'")) {
			warn('index.html missing <div id="root"> — injecting');
			content = content.replace('</body>', '  <div id="root"></div>\n</body>'); changed = true;
		}
		if (!/type=["']module["']/.test(content)) {
			warn('index.html missing module script — injecting');
			content = content.replace('</body>', '  <script type="module" src="/src/main.tsx"></script>\n</body>'); changed = true;
		}
		return changed ? { ...f, content } : f;
	});
	const mainFile = result.find(f => f.path === 'src/main.tsx' || f.path === 'src/main.jsx');
	if (mainFile && (/import\s+['"]\.\/.*\.css['"]/.test(mainFile.content) || /import\s+['"]\.\/.*\.scss['"]/.test(mainFile.content))) {
		result = result.map(f => {
			if (f.path !== 'index.html' || !/<link\s[^>]*rel=["']stylesheet["'][^>]*>/i.test(f.content)) return f;
			log('removed HTML stylesheet link — CSS imported by JS');
			return { ...f, content: f.content.replace(/<link\s[^>]*rel=["']stylesheet["'][^>]*>\n?/gi, '') };
		});
	}
	return result;
}

// ---------------------------------------------------------------------------
// PASS 17 — Compile Validation (tsc, temp dir, async)
// ---------------------------------------------------------------------------

async function pass17CompileValidation(files: GeneratedFile[], workspaceRoot: string, issues: ValidationIssue[]): Promise<void> {
	let tscBin = path.join(workspaceRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
	if (!fs.existsSync(tscBin)) {
		tscBin = path.join(workspaceRoot, 'node_modules', '.bin', 'tsc');
	}
	if (!fs.existsSync(tscBin)) {
		// Fallback to router's own tsc binary
		const routerTsc = path.join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
		if (fs.existsSync(routerTsc)) {
			tscBin = routerTsc;
			log(`pass17: using router fallback tsc binary: ${routerTsc}`);
		}
	}
	const nmSrc = path.join(workspaceRoot, 'node_modules');
	if (!fs.existsSync(tscBin) || !fs.existsSync(path.join(workspaceRoot, 'tsconfig.json')) || !fs.existsSync(nmSrc)) {
		log('pass17: tsc/tsconfig or node_modules not found — skipped (run npm install first)'); return;
	}
	const tsFiles = files.filter(f => ['.ts', '.tsx'].includes(path.extname(f.path).toLowerCase()));
	if (tsFiles.length === 0) return;

	const tmpDir = path.join(os.tmpdir(), `crabcode-validate-${Date.now()}`);
	try {
		fs.mkdirSync(tmpDir, { recursive: true });
		for (const f of tsFiles) {
			const dest = path.join(tmpDir, f.path);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.writeFileSync(dest, f.content, 'utf-8');
		}
		const nmSrc = path.join(workspaceRoot, 'node_modules');
		const nmDest = path.join(tmpDir, 'node_modules');
		if (fs.existsSync(nmSrc) && !fs.existsSync(nmDest)) {
			try {
				fs.symlinkSync(nmSrc, nmDest, process.platform === 'win32' ? 'junction' : 'dir');
			} catch { /* junction fallback non-fatal */ }
		} else if (!fs.existsSync(nmDest)) {
			const routerNm = path.join(process.cwd(), 'node_modules');
			if (fs.existsSync(routerNm)) {
				try {
					fs.symlinkSync(routerNm, nmDest, process.platform === 'win32' ? 'junction' : 'dir');
				} catch { /* junction fallback non-fatal */ }
			}
		}

		const genSet = new Set(tsFiles.map(f => f.path));
		for (const f of tsFiles) {
			const impRe = /from\s+['"]((?:\.[^'"]+|@\/[^'"]+|~\/[^'"]+))['"]/g;
			let m: RegExpExecArray | null;
			while ((m = impRe.exec(f.content)) !== null) {
				if (!m[1]) continue;
				let resolved: string;
				if (m[1].startsWith('@/') || m[1].startsWith('~/')) {
					resolved = path.normalize(path.join('src', m[1].slice(2)));
				} else {
					resolved = path.normalize(path.join(path.dirname(f.path), m[1]));
				}
				if (genSet.has(resolved)) continue;
				for (const e2 of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
					const abs = path.join(workspaceRoot, resolved + e2);
					try {
						if (fs.existsSync(abs)) {
							const dst = path.join(tmpDir, resolved + e2);
							fs.mkdirSync(path.dirname(dst), { recursive: true });
							fs.writeFileSync(dst, fs.readFileSync(abs, 'utf-8'), 'utf-8');
							break;
						}
					} catch { /* ignore */ }
				}
			}
		}

		let baseOpts: any = {};
		try { baseOpts = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'tsconfig.json'), 'utf-8')).compilerOptions ?? {}; } catch { /* ignore */ }
		const tmpCfg: any = { compilerOptions: { ...baseOpts, noEmit: true, skipLibCheck: true, ignoreDeprecations: '5.0' }, include: ['./**/*.ts', './**/*.tsx'], exclude: ['node_modules'] };
		delete tmpCfg.compilerOptions.rootDir;
		delete tmpCfg.compilerOptions.outDir;
		tmpCfg.compilerOptions.baseUrl = '.';
		tmpCfg.compilerOptions.paths = {
			...(baseOpts.paths ?? {}),
			'@/*': ['./src/*'],
			'~/*': ['./src/*'],
		};
		fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify(tmpCfg, null, 2));

		let tscOut = '';
		try { const { stdout, stderr } = await execPromise(`"${tscBin}" --noEmit`, { cwd: tmpDir }); tscOut = (stdout + stderr).trim(); }
		catch (e: any) { tscOut = ((e.stdout || '') + (e.stderr || '')).trim(); }

		if (!tscOut) { log('pass17: tsc clean'); return; }
		const errRe = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
		let em: RegExpExecArray | null;
		const normTmp = path.normalize(tmpDir).replace(/\\/g, '/');
		while ((em = errRe.exec(tscOut)) !== null) {
			const [, fp, , , code, rawMsg] = em;
			if (!fp || fp.includes('node_modules')) continue;
			const normFp = path.normalize(fp).replace(/\\/g, '/');
			const rel = normFp.startsWith(normTmp + '/') ? normFp.slice(normTmp.length + 1) : normFp;
			let msg = (rawMsg || '').replace(new RegExp(normTmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[/\\\\]?', 'g'), '');

			// If error is a missing local module (e.g. TS2307: Cannot find module './components/KanbanBoard'),
			// convert to a concrete missing_coverage issue targeting the missing file!
			if (code === 'TS2307') {
				const missingModMatch = msg.match(/Cannot find module ['"]((?:\.[^'"]+|@\/[^'"]+|~\/[^'"]+))['"]/);
				if (missingModMatch && missingModMatch[1]) {
					const mod = missingModMatch[1];
					const missingRel = (mod.startsWith('@/') || mod.startsWith('~/'))
						? path.normalize(path.join('src', mod.slice(2))).replace(/\\/g, '/')
						: path.normalize(path.join(path.dirname(rel), mod)).replace(/\\/g, '/');
					const missingCandidate = missingRel + (path.extname(missingRel) ? '' : '.tsx');
					issues.push({
						kind: 'missing_coverage',
						file: missingCandidate,
						message: `Missing component file: ${missingCandidate} (imported by ${rel}). You MUST generate <file path="${missingCandidate}">`,
						severity: 'error',
					});
					continue;
				}
			}

			issues.push({ kind: 'compile_error', file: rel, message: `${code}: ${msg}`, severity: 'error' });
		}
	} finally {
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

// ---------------------------------------------------------------------------
// PASS 18 — Project Completeness
// ---------------------------------------------------------------------------

function pass18ProjectCompleteness(files: GeneratedFile[], contract: ValidationContract | undefined, issues: ValidationIssue[]): void {
	if (!contract || contract.estimatedFiles <= 0) return;
	const threshold = Math.floor(contract.estimatedFiles * 0.5);
	if (files.length < threshold) {
		issues.push({ kind: 'completeness', message: `Only ${files.length} files generated — expected ~${contract.estimatedFiles} (min ${threshold}). Generation incomplete.`, severity: 'error' });
	} else {
		log(`completeness: ${files.length}/${contract.estimatedFiles} — OK`);
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Public API — project-level validator (unchanged)
export async function runPostGenerationValidator(
	files: GeneratedFile[],
	workspaceRoot: string,
	contract?: ValidationContract,
	editMode: boolean = false,
	graph?: ExecutionGraph,
	committedPaths?: Set<string>,
): Promise<ValidationResult> {
	if (files.length === 0) return { passed: true, files: [], issues: [], coverageScore: 0, coverageMax: 0 };

	console.log(`\n[Validator] ===== POST-GENERATION VALIDATION V2.5 (${files.length} file(s)) =====`);
	if (contract) console.log(`[Validator] Contract: scope=${contract.scope} arch=${contract.architecture} features=[${contract.requiredFeatures.join(',')}] est=${contract.estimatedFiles}`);

	const issues: ValidationIssue[] = [];
	let result = files;

	// ── Repair passes (no issues yet) ─────────────────────────────────────────
	result = pass1NormalizePaths(result);
	result = pass2RemoveDuplicates(result);
	result = passDuplicateIdentifierSanitizer(result);
	result = passAutoSynthesizeUtils(result, workspaceRoot);
	result = passAutoSynthesizeTypes(result, workspaceRoot);
	result = passHarmonizeExports(result, workspaceRoot);
	result = passAutoImportResolver(result, workspaceRoot);
	result = pass3ScopeValidator(result, contract, issues);     // error
	result = pass4FrameworkValidation(result);
	const framework = detectFramework(result);
	result = pass5PackageValidation(result, workspaceRoot);

	// ── Structural validation (errors stop tsc from running) ──────────────────
	// Pass 6: DependencyStatus-aware (Planned/Generated → skip)
	result = pass6ImportValidation(result, workspaceRoot, issues, graph, committedPaths);   // warning
	const { coverageScore, coverageMax } = pass7RequirementCoverage(result, contract, issues); // error
	pass8ArchitectureValidator(result, contract, issues);             // error
	pass9LayerBoundaryValidator(result, issues);                      // error
	pass10BusinessLogicLeak(result, issues);                          // warning
	pass11RouteSize(result, issues);                                  // warning
	pass12UndefinedSymbols(result, workspaceRoot, issues);            // error
	// Pass 13: DependencyStatus-aware (Planned/Generated → skip)
	pass13DependencyValidator(result, workspaceRoot, issues, graph, committedPaths);        // error
	pass14DeadCode(result, issues);                                   // warning
	pass15WorkspaceCollision(result, workspaceRoot, issues);          // warning
	pass16Security(result, issues);                                   // warning
	pass17TypeScriptQuality(result, issues);                          // warning

	// ── React/HTML repair (no issues) ────────────────────────────────────────
	result = pass15ReactValidation(result);
	result = pass16HtmlCssValidation(result, framework);

	// ── Compile validation — gated on zero structural errors ──────────────────
	const structuralErrors = issues.filter(i => i.severity === 'error').length;
	if (structuralErrors === 0) {
		await pass17CompileValidation(result, workspaceRoot, issues); // error
	} else {
		log(`pass18CompileValidation: skipped — ${structuralErrors} structural error(s) must be resolved first`);
	}

	// Skip completeness check in edit mode
	if (!editMode) {
		pass18ProjectCompleteness(result, contract, issues);              // error
	} else {
		log('pass18ProjectCompleteness: skipped (edit mode — single file modification)');
	}

	const errors   = issues.filter(i => i.severity === 'error');
	const warnings = issues.filter(i => i.severity === 'warning');
	const passed   = errors.length === 0;

	console.log(`[Validator] ===== DONE — ${result.length} file(s) | ${errors.length} error(s) | ${warnings.length} warning(s) | Coverage: ${coverageScore}/${coverageMax} =====\n`);
	errors.forEach(e   => console.log(`  ❌ [${e.kind}] ${e.file ? e.file + ': ' : ''}${e.message}`));
	warnings.forEach(w => console.log(`  ⚠️  [${w.kind}] ${w.file ? w.file + ': ' : ''}${w.message}`));

	return { passed, files: result, issues, coverageScore, coverageMax };
}

// ---------------------------------------------------------------------------
// Public API — Per-file local validator (safe during incremental generation)
// ---------------------------------------------------------------------------

/**
 * runLocalFileValidator
 * =====================
 * Runs only passes that are safe for per-file use during incremental generation.
 * NEVER runs: missing_import checks, missing_architecture, missing_coverage,
 * completeness, undefined symbols (cross-file), dead code, or compile.
 *
 * @param file           Single generated file to validate.
 * @param workspaceRoot  Absolute workspace path.
 * @param contract       Optional validation contract (scope/arch info).
 * @param graph          Optional graph — used for DependencyStatus-aware filtering.
 * @param committedPaths Optional set of already-committed paths.
 */
export async function runLocalFileValidator(
	file:            GeneratedFile,
	workspaceRoot:   string,
	contract?:       ValidationContract,
	graph?:          ExecutionGraph,
	committedPaths?: Set<string>,
): Promise<ValidationResult> {
	const issues: ValidationIssue[] = [];
	let files = [file];

	// ── Repair passes ─────────────────────────────────────────────────────────
	files = pass1NormalizePaths(files);
	files = pass2RemoveDuplicates(files);
	files = passDuplicateIdentifierSanitizer(files);
	files = passAutoSynthesizeUtils(files, workspaceRoot);
	files = passAutoSynthesizeTypes(files, workspaceRoot);
	files = passHarmonizeExports(files, workspaceRoot);
	files = passAutoImportResolver(files, workspaceRoot);
	files = pass3ScopeValidator(files, contract, issues);      // scope_violation errors
	files = pass4FrameworkValidation(files);                   // framework repair
	files = pass5PackageValidation(files, workspaceRoot);      // remove bad imports

	// ── Per-file structural checks ────────────────────────────────────────────
	// NOTE: pass6/pass13 (import validation) are intentionally EXCLUDED here.
	// They run in runPostGenerationValidator with DependencyStatus awareness.
	pass9LayerBoundaryValidator(files, issues);                // layer boundary errors
	pass10BusinessLogicLeak(files, issues);                    // business logic warnings
	pass16Security(files, issues);                             // security warnings
	pass17TypeScriptQuality(files, issues);                    // ts quality warnings

	// Route size (warning only — safe per-file)
	pass11RouteSize(files, issues);

	const errors   = issues.filter(i => i.severity === 'error');
	const warnings = issues.filter(i => i.severity === 'warning');
	const passed   = errors.length === 0;

	if (issues.length > 0) {
		console.log(
			`[LocalValidator] ${file.path}: ${errors.length} error(s), ${warnings.length} warning(s)`,
		);
	}

	return { passed, files, issues, coverageScore: 0, coverageMax: 0 };
}
