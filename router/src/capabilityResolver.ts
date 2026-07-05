/**
 * CapabilityResolver
 * ==================
 * Maps advisor-detected features → capability-specific prompt files.
 * Replaces generic prompt loading (node.md / express.md / sql.md) with
 * targeted, single-responsibility capability prompts.
 *
 * Extensible: add a new capability prompt file and register it in the map below.
 * No hardcoded prompt names in the router.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Capability =
	| 'repository-pattern'
	| 'controller-pattern'
	| 'service-pattern'
	| 'validation'
	| 'jwt'
	| 'refresh-token'
	| 'pagination'
	| 'uploads'
	| 'logging'
	| 'email'
	| 'error-handling'
	| 'dependency-injection'
	| 'websocket'
	| 'redis'
	| 'caching'
	| 'swagger'
	| 'testing';

// ---------------------------------------------------------------------------
// Feature key → capabilities map
// ---------------------------------------------------------------------------

/**
 * Maps advisor `requiredFeatures` keys → one or more capabilities to load.
 * Keys match FEATURE_DETECTION in index.ts exactly.
 */
const FEATURE_TO_CAPABILITIES: Record<string, Capability[]> = {
	jwt:                ['jwt'],
	refresh_tokens:     ['jwt', 'refresh-token'],
	repository:         ['repository-pattern'],
	service_layer:      ['service-pattern'],
	uploads:            ['uploads'],
	logging:            ['logging'],
	pagination:         ['pagination'],
	email:              ['email'],
	payments:           ['validation', 'error-handling'],        // no payment-specific prompt yet
	rbac:               ['validation', 'error-handling'],
	oauth:              ['jwt'],
	password_reset:     ['email', 'jwt'],
	email_verification: ['email', 'jwt'],
	transactions:       ['repository-pattern'],
	dto:                ['validation'],
	bcrypt:             ['service-pattern'],
	middleware:         ['error-handling'],
};

// ---------------------------------------------------------------------------
// Architecture → base capabilities (always loaded for that arch)
// ---------------------------------------------------------------------------

const ARCH_BASE_CAPABILITIES: Record<string, Capability[]> = {
	repository: ['repository-pattern', 'service-pattern', 'controller-pattern', 'error-handling'],
	mvc:        ['controller-pattern', 'error-handling'],
	clean:      ['repository-pattern', 'service-pattern', 'dependency-injection', 'error-handling'],
	flat:       ['error-handling'],
	unknown:    [],
};

// ---------------------------------------------------------------------------
// Capability → prompt file (relative to prompts/be/capabilities/)
// ---------------------------------------------------------------------------

const CAPABILITY_PROMPT_FILES: Record<Capability, string> = {
	'repository-pattern':    'repository-pattern.md',
	'controller-pattern':    'controller-pattern.md',
	'service-pattern':       'service-pattern.md',
	'validation':            'validation.md',
	'jwt':                   'jwt.md',
	'refresh-token':         'refresh-token.md',
	'pagination':            'pagination.md',
	'uploads':               'uploads.md',
	'logging':               'logging.md',
	'email':                 'email.md',
	'error-handling':        'error-handling.md',
	'dependency-injection':  'dependency-injection.md',
	'websocket':             'websocket.md',
	'redis':                 'redis.md',
	'caching':               'caching.md',
	'swagger':               'swagger.md',
	'testing':               'testing.md',
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPABILITIES_DIR = path.join(__dirname, '../prompts/be/capabilities');

function loadCapabilityFile(capability: Capability): string | null {
	const fileName = CAPABILITY_PROMPT_FILES[capability];
	if (!fileName) return null;
	const filePath = path.join(CAPABILITIES_DIR, fileName);
	try {
		return fs.readFileSync(filePath, 'utf-8').trim();
	} catch {
		// Capability prompt file not yet created — silent skip
		return null;
	}
}

/**
 * Resolve features + architecture → ordered list of unique capabilities.
 */
export function resolveCapabilities(
	requiredFeatures: string[],
	architecture: string,
): Capability[] {
	const seen = new Set<Capability>();
	const result: Capability[] = [];

	const add = (cap: Capability) => {
		if (!seen.has(cap)) { seen.add(cap); result.push(cap); }
	};

	// 1. Architecture base capabilities first
	const archBase = ARCH_BASE_CAPABILITIES[architecture] ?? [];
	for (const cap of archBase) add(cap);

	// 2. Feature-driven capabilities
	for (const feature of requiredFeatures) {
		const caps = FEATURE_TO_CAPABILITIES[feature];
		if (caps) for (const cap of caps) add(cap);
	}

	return result;
}

/**
 * Load all resolved capability prompts and concatenate them.
 * Falls back gracefully if a prompt file is missing.
 */
export function loadCapabilityPrompts(capabilities: Capability[]): string {
	const parts: string[] = [];
	const loaded: string[] = [];
	const missing: string[] = [];

	for (const cap of capabilities) {
		const content = loadCapabilityFile(cap);
		if (content) {
			parts.push(content);
			loaded.push(cap);
		} else {
			missing.push(cap);
		}
	}

	if (loaded.length > 0) {
		console.log(`[CapabilityResolver] Loaded: [${loaded.join(', ')}]`);
	}
	if (missing.length > 0) {
		console.log(`[CapabilityResolver] Missing prompt files (skipped): [${missing.join(', ')}]`);
	}

	return parts.join('\n\n');
}

/**
 * Build the backend system prompt using capability resolution.
 * This replaces the hardcoded addBE('express') / addBE('node') pattern.
 *
 * @param basePrompt     Already-loaded base agent prompt (be/agent.md etc.)
 * @param features       From AdvisorV2 result or PlannerContract.requiredFeatures
 * @param architecture   From AdvisorV2 result
 */
export function buildCapabilitySystemPrompt(
	basePrompt: string,
	features: string[],
	architecture: string,
): string {
	const capabilities = resolveCapabilities(features, architecture);
	const capContent   = loadCapabilityPrompts(capabilities);
	return capContent ? `${basePrompt}\n\n${capContent}` : basePrompt;
}
