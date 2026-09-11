/**
 * plannerContract.ts — Deterministic keyword extraction, no model call.
 *
 * Extracted from index.ts (lines 66–177).
 * Produces a PlannerContract from user message + advisor intent.
 * No async, no I/O.
 */

import type { ValidationContract } from '../validator.js';
import type { UserScope } from './constraintParser.js';

export interface PlannerContract {
	scope: 'backend' | 'frontend' | 'fullstack';
	architecture: 'repository' | 'mvc' | 'clean' | 'flat' | 'unknown';
	framework: string;
	language: 'typescript' | 'javascript';
	requiredFeatures: string[];
	requiredFolders: string[];
	estimatedFiles: number;
}

const FEATURE_DETECTION: Array<{ key: string; re: RegExp }> = [
	{ key: 'jwt', re: /\bjwt\b|json.?web.?token|access.?token/i },
	{ key: 'refresh_tokens', re: /refresh.?token/i },
	{ key: 'repository', re: /repository.?pattern|repo.?pattern/i },
	{ key: 'service_layer', re: /service.?layer|service\s+class/i },
	{ key: 'uploads', re: /\bupload\b|file.?upload|image.?upload/i },
	{ key: 'logging', re: /\blogg?ing\b|\blogger\b/i },
	{ key: 'pagination', re: /\bpaginat/i },
	{ key: 'email', re: /\bemail\b|send.?mail|nodemailer/i },
	{ key: 'payments', re: /\bpayment\b|\bstripe\b|\bpaypal\b|\bcheckout\b/i },
	{ key: 'rbac', re: /\brbac\b|role.?based|permission|admin.?role/i },
	{ key: 'oauth', re: /\boauth\b|google.?auth|github.?auth|social.?login/i },
	{ key: 'password_reset', re: /password.?reset|forgot.?password/i },
	{ key: 'email_verification', re: /email.?verif|verify.?email/i },
	{ key: 'transactions', re: /\btransaction\b/i },
	{ key: 'dto', re: /\bdto\b|data.?transfer.?object|class.?validator/i },
	{ key: 'bcrypt', re: /\bbcrypt\b|hash.?password|password.?hash/i },
	{ key: 'middleware', re: /\bmiddleware\b/i },
];

const ARCH_DETECTION: Array<{ arch: PlannerContract['architecture']; re: RegExp }> = [
	{ arch: 'repository', re: /repository.?pattern|repo.?pattern/i },
	{ arch: 'clean', re: /clean.?arch|domain.?driven|ddd|hexagonal/i },
	{ arch: 'mvc', re: /\bmvc\b|model.?view.?controller/i },
];

const ARCH_FOLDERS_MAP: Record<string, string[]> = {
	repository: ['controllers', 'services', 'repositories'],
	mvc: ['models', 'controllers'],
	clean: ['domain', 'application', 'infrastructure'],
	flat: [],
};

export function buildPlannerContract(msg: string, advisorIntent: string, userScope?: UserScope): PlannerContract {
	// Scope
	const scope: PlannerContract['scope'] =
		userScope === 'FRONTEND_ONLY' || advisorIntent.includes('fe') ? 'frontend'
			: userScope === 'BACKEND_ONLY' || advisorIntent.includes('be') ? 'backend'
				: advisorIntent.includes('fullstack') ? 'fullstack'
					: 'fullstack';

	// Architecture
	let architecture: PlannerContract['architecture'] = 'unknown';
	for (const a of ARCH_DETECTION) {
		if (a.re.test(msg)) { architecture = a.arch; break; }
	}
	// repository pattern is implied when service + controller keywords present
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
	const language: 'typescript' | 'javascript' =
		/\bjavascript\b|\.js\b/i.test(msg) && !/\btypescript\b|\.ts\b/i.test(msg) ? 'javascript' : 'typescript';

	// Required features
	const requiredFeatures = FEATURE_DETECTION.filter(f => f.re.test(msg)).map(f => f.key);

	// Required folders from architecture
	const requiredFolders = ARCH_FOLDERS_MAP[architecture] ?? [];

	// Rough file estimate: (features * 2) + (folders * 2) + 3 base files
	const estimatedFiles = scope === 'fullstack'
		? Math.max(10, requiredFeatures.length * 2 + requiredFolders.length * 2 + 5)
		: Math.max(5, requiredFeatures.length * 2 + requiredFolders.length * 2 + 3);

	console.log(`[PlannerContract] scope=${scope} arch=${architecture} fw=${framework} features=[${requiredFeatures.join(',')}] est=${estimatedFiles}`);
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
		architecture: pc.architecture,
		framework: pc.framework,
		language: pc.language,
		requiredFeatures: pc.requiredFeatures,
		requiredFolders: pc.requiredFolders,
		expectedFiles: [],
		estimatedFiles: pc.estimatedFiles,
	};
}
