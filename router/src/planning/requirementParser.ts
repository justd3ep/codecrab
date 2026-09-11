/**
 * RequirementParser — extract scope, architecture, framework, features from prompt.
 *
 * Deterministic keyword extraction, no model call.
 * Extracted from index.ts (lines 58-145).
 */

import type { ArchitectureType, LanguageType, ScopeType, ValidationContract } from '../core/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlannerContract {
	scope:            ScopeType;
	architecture:     ArchitectureType;
	framework:        string;
	language:         LanguageType;
	requiredFeatures: string[];
	requiredFolders:  string[];
	estimatedFiles:   number;
}

export type UserScope = 'BACKEND_ONLY' | 'FRONTEND_ONLY' | 'ANY';

// ---------------------------------------------------------------------------
// Detection tables
// ---------------------------------------------------------------------------

const FEATURE_DETECTION: Array<{ key: string; re: RegExp }> = [
	{ key: 'jwt',                re: /\bjwt\b|json.?web.?token|access.?token/i },
	{ key: 'refresh_tokens',     re: /refresh.?token/i },
	{ key: 'repository',         re: /repository.?pattern|repo.?pattern/i },
	{ key: 'service_layer',      re: /service.?layer|service\s+class/i },
	{ key: 'uploads',            re: /\bupload\b|file.?upload|image.?upload/i },
	{ key: 'logging',            re: /\blogg?ing\b|\blogger\b/i },
	{ key: 'pagination',         re: /\bpaginat/i },
	{ key: 'email',              re: /\bemail\b|send.?mail|nodemailer/i },
	{ key: 'payments',           re: /\bpayment\b|\bstripe\b|\bpaypal\b|\bcheckout\b/i },
	{ key: 'rbac',               re: /\brbac\b|role.?based|permission|admin.?role/i },
	{ key: 'oauth',              re: /\boauth\b|google.?auth|github.?auth|social.?login/i },
	{ key: 'password_reset',     re: /password.?reset|forgot.?password/i },
	{ key: 'email_verification', re: /email.?verif|verify.?email/i },
	{ key: 'transactions',       re: /\btransaction\b/i },
	{ key: 'dto',                re: /\bdto\b|data.?transfer.?object|class.?validator/i },
	{ key: 'bcrypt',             re: /\bbcrypt\b|hash.?password|password.?hash/i },
	{ key: 'middleware',         re: /\bmiddleware\b/i },
];

const ARCH_DETECTION: Array<{ arch: ArchitectureType; re: RegExp }> = [
	{ arch: 'repository', re: /repository.?pattern|repo.?pattern/i },
	{ arch: 'clean',      re: /clean.?arch|domain.?driven|ddd|hexagonal/i },
	{ arch: 'mvc',        re: /\bmvc\b|model.?view.?controller/i },
];

const ARCH_FOLDERS_MAP: Record<string, string[]> = {
	repository: ['controllers', 'services', 'repositories'],
	mvc:        ['models', 'controllers'],
	clean:      ['domain', 'application', 'infrastructure'],
	flat:       [],
};

const BACKEND_ONLY_PATTERNS = [
	/\bbackend[\s-]?only\b/i, /\bbackend\s+files?\s+only\b/i,
	/\bgenerate\s+(?:only\s+)?backend\b/i, /\bserver[\s-]?only\b/i,
	/\bapi[\s-]?only\b/i, /\bno\s+frontend\b/i, /\bwithout\s+frontend\b/i,
	/\bexpress\s+backend\b/i, /\bnestjs\s+backend\b/i,
	/\bno\s+react\b/i, /\bno\s+ui\b/i,
	// Natural language backend requests
	/\b(?:build|create|implement|make)\s+(?:a\s+)?(?:[\w-]+\s+)*(?:rest\s+|server\s+)?backend\b/i,
	/\bbackend\s+for\b/i,
	/\bbackend\s+(?:service|server|api|application)\b/i,
	/\bonly\s+(?:the\s+)?(?:backend|server|api)\b/i,
];

const FRONTEND_ONLY_PATTERNS = [
	/\bfrontend[\s-]?only\b/i, /\breact[\s-]?only\b/i,
	/\bnext\.?js[\s-]?only\b/i, /\bui[\s-]?only\b/i,
	/\bcomponent[\s-]?only\b/i, /\bno\s+backend\b/i,
	/\bwithout\s+backend\b/i, /\bno\s+server\b/i, /\bno\s+api\b/i,
	// Natural language frontend requests
	/\b(?:build|create|implement|make|design)\s+(?:a\s+)?(?:[\w-]+\s+){0,3}(?:dashboard\s+|web\s+)?frontend\b/i,
	/\bfrontend\s+for\b/i,
	/\bfrontend\s+(?:dashboard|app|application|ui|interface|client)\b/i,
	/\bclient[\s-]?side\b/i,
	/\bfrontend\s+code\b/i,
	/\bonly\s+(?:the\s+)?(?:frontend|ui)\b/i,
	/\buse\s+mock\s+(?:data|api|functions)\b/i,
];

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export function parseUserScope(msg: string): UserScope {
	const isFullStack = /\bfull[\s-]?stack\b/i.test(msg) ||
		(/\b(?:frontend|react|ui|client)\b/i.test(msg) && /\b(?:backend|server|express|nestjs|database)\b/i.test(msg));

	if (isFullStack) return 'ANY';
	if (FRONTEND_ONLY_PATTERNS.some(p => p.test(msg))) return 'FRONTEND_ONLY';
	if (BACKEND_ONLY_PATTERNS.some(p => p.test(msg)))  return 'BACKEND_ONLY';
	return 'ANY';
}

export function buildPlannerContract(msg: string, advisorIntent: string, userScope?: UserScope): PlannerContract {
	// Scope
	const resolvedScope = userScope || parseUserScope(msg);
	const scope: ScopeType =
		resolvedScope === 'FRONTEND_ONLY' || advisorIntent.includes('fe') ? 'frontend'
			: resolvedScope === 'BACKEND_ONLY' || advisorIntent.includes('be') ? 'backend'
				: advisorIntent.includes('fullstack') ? 'fullstack'
					: 'fullstack';

	// Architecture
	let architecture: ArchitectureType = 'unknown';
	for (const a of ARCH_DETECTION) {
		if (a.re.test(msg)) { architecture = a.arch; break; }
	}
	if (architecture === 'unknown' && scope !== 'frontend') {
		if (/\bservice\b/i.test(msg) && /\bcontroller\b/i.test(msg)) architecture = 'repository';
	}

	// Framework
	const framework =
		/\bnestjs\b/i.test(msg) ? 'nestjs'
			: /\bexpress\b/i.test(msg) ? 'express'
				: /\bnext\.?js\b/i.test(msg) ? 'nextjs'
					: /\bvite\b/i.test(msg) ? 'vite'
						: /\bfastify\b/i.test(msg) ? 'fastify'
							: 'unknown';

	// Language
	const language: LanguageType =
		/\bjavascript\b|\.js\b/i.test(msg) && !/\btypescript\b|\.ts\b/i.test(msg) ? 'javascript' : 'typescript';

	// Features
	const requiredFeatures = FEATURE_DETECTION.filter(f => f.re.test(msg)).map(f => f.key);

	// Folders
	const requiredFolders = ARCH_FOLDERS_MAP[architecture] ?? [];

	// Rough file estimate
	const estimatedFiles = scope === 'fullstack'
		? Math.max(10, requiredFeatures.length * 2 + requiredFolders.length * 2 + 5)
		: Math.max(5, requiredFeatures.length * 2 + requiredFolders.length * 2 + 3);

	return { scope, architecture, framework, language, requiredFeatures, requiredFolders, estimatedFiles };
}

export function plannerContractToValidationContract(pc: PlannerContract, userScope: UserScope): ValidationContract {
	const scope: ValidationContract['scope'] =
		userScope === 'BACKEND_ONLY' ? 'backend'
			: userScope === 'FRONTEND_ONLY' ? 'frontend'
				: pc.scope === 'backend' ? 'backend'
					: pc.scope === 'frontend' ? 'frontend'
						: pc.scope === 'fullstack' ? 'fullstack'
							: 'unknown';
	return {
		scope,
		architecture:     pc.architecture,
		framework:        pc.framework,
		language:         pc.language,
		requiredFeatures: pc.requiredFeatures,
		requiredFolders:  pc.requiredFolders,
		expectedFiles:    [],
		estimatedFiles:   pc.estimatedFiles,
	};
}
