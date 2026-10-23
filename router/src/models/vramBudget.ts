/**
 * vramBudget.ts — how many models may be resident, based on the
 * VRAM that is actually present.
 *
 * THE PROBLEM
 *
 * The cache size was a constant: MAX_RESIDENT_MODELS = 2. That is
 * right for 8 GB of VRAM and WRONG for 4 GB.
 *
 * The machine this codebase was designed for has 4 GB. The design
 * is documented in index.ts:
 *
 *     ModelManager — exactly 0 or 1 model in VRAM at any time
 *
 * The reasoning: the specialist is 5.75 GB and does not fit in 4
 * GB of VRAM. It runs via OFFLOADING — as many layers as fit go to
 * the GPU, the rest to CPU. Every MB of VRAM the specialist does
 * not get is a layer that runs on the CPU, which is the whole
 * point of "rigorous offloading".
 *
 * So on a 4 GB box, keeping the 0.45 GB advisor resident STEALS
 * VRAM from the specialist and makes its offloading LESS rigorous.
 * The original one-model-at-a-time design was correct there.
 *
 * On an 8 GB box the advisor fits alongside, and keeping it
 * resident eliminates a measured 11.5 s reload per loop recovery.
 *
 * So the cache size is ADAPTIVE: it is set once at startup from the
 * detected VRAM, and the eviction is still LRU.
 *
 * THE BANDS
 *
 *   <= 4 GB   1 model   the specialist needs every MB for offloading
 *   6-8 GB    2 models the advisor fits alongside
 *   > 8 GB    3 models FE + BE + advisor, if they fit
 *
 * The bands are wide because the number that matters is not the
 * card's total but the usable VRAM after the driver, the context,
 * and the embedding model have taken theirs. The boundary is set
 * generously: a 4.5 GB card gets the 1-model band, because its
 * usable VRAM is under 4 GB.
 */
import { getLlama } from 'node-llama-cpp';

/** The number of models that may be resident at once. */
export type VramBudget = 1 | 2 | 3;

/**
 * How much VRAM the machine has, in bytes.
 *
 * Returns 0 when it cannot be determined — which is treated as the
 * most conservative band, because a 4 GB box is the design target
 * and the fallback must not make it slower.
 */
export async function getVramBytes(): Promise<number> {
	try {
		const llama = await getLlama();
		const state = await llama.getVramState?.();
		if (state && typeof state.total === 'number' && state.total > 0) {
			return state.total;
		}
	} catch {
		// Fall through to the conservative default.
	}
	return 0;
}

/**
 * The resident-model budget for the detected VRAM.
 *
 * The input is bytes; the bands are in GB. The boundaries are set
 * generously so a card whose usable VRAM is under 4 GB gets the
 * 1-model band even if its nominal total is 4.5 GB.
 */
export function budgetForVram(vramBytes: number): VramBudget {
	if (vramBytes <= 0) return 1; // unknown — the design target
	const gb = vramBytes / 1073741824;
	if (gb <= 5) return 1;   // 4 GB target: the specialist needs the VRAM
	if (gb <= 9) return 2;   // 6-8 GB: the advisor fits alongside
	return 3;                // > 8 GB: FE + BE + advisor, if they fit
}

/**
 * The human-readable band, for the startup log.
 */
export function budgetLabel(budget: VramBudget): string {
	switch (budget) {
		case 1: return '1 model (<= 4 GB VRAM — the specialist needs the VRAM for offloading)';
		case 2: return '2 models (6-8 GB VRAM — the advisor fits alongside the specialist)';
		case 3: return '3 models (> 8 GB VRAM — FE + BE + advisor)';
	}
}