/*
 * Component 7 — Intent-Aware Directory Filter
 * Given advisor intent → returns allowed directory patterns for retrieval.
 * Applied before AST search and embedding search to restrict candidate pool.
 */

export type AdvisorIntent = string; // reuse string alias

interface IntentFilter {
	allowDirs: RegExp[];
	blockDirs: RegExp[];
}

const FE_FILTER: IntentFilter = {
	allowDirs: [
		/(?:^|\/)(?:components|pages|hooks|contexts|styles|ui|views|features)\//i,
		/\.(tsx|jsx|css|scss)$/i,
		/(?:^|\/)App\.[jt]sx?$/i,
	],
	blockDirs: [
		/(?:^|\/)(?:controllers|routes|middleware|services|repositories|models|database|jobs|guards)\//i,
	],
};

const BE_FILTER: IntentFilter = {
	allowDirs: [
		/(?:^|\/)(?:controllers|routes|middleware|services|repositories|models|database|jobs|guards|strategies)\//i,
		/schema\.prisma$/i,
		/migration/i,
		/(?:^|\/)server\.[jt]s$/i,
	],
	blockDirs: [
		/(?:^|\/)(?:components|pages|styles|ui|views)\//i,
		/\.(tsx|jsx)$/i,
	],
};

const NO_FILTER: IntentFilter = { allowDirs: [], blockDirs: [] };

export function getIntentFilter(intent: AdvisorIntent | null): IntentFilter {
	if (!intent) return NO_FILTER;
	if (intent.includes('fe')) return FE_FILTER;
	if (intent.includes('be')) return BE_FILTER;
	if (intent.includes('fullstack')) return NO_FILTER;
	return NO_FILTER;
}

/** Returns true if file passes the intent filter */
export function passesFilter(filePath: string, filter: IntentFilter): boolean {
	const rel = filePath.replace(/\\/g, '/');
	if (filter.blockDirs.some(p => p.test(rel))) return false;
	if (filter.allowDirs.length === 0) return true; // no filter = allow all
	return filter.allowDirs.some(p => p.test(rel));
}

export function applyIntentFilter(files: string[], intent: AdvisorIntent | null): string[] {
	const filter = getIntentFilter(intent);
	if (filter.allowDirs.length === 0 && filter.blockDirs.length === 0) return files;
	return files.filter(f => passesFilter(f, filter));
}
