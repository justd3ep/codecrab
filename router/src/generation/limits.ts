/**
 * The generation limits.
 *
 * THEY LIVE HERE, NOT IN index.ts
 *
 * chatRoutes.ts used to import them from index.ts:
 *
 *     import { MAX_AGENT_ITERATIONS, ... } from '../index.js';
 *
 * That is a circular import waiting to happen: the plan is to mount
 * chatRoutes.ts, and then index -> chatRoutes -> index. In ES
 * modules a cycle is a RUNTIME hazard, not a compile error — the
 * bindings can be in the temporal dead zone when the importing
 * module's body runs.
 *
 * So the limits have their own module, and both routes import them
 * from here.
 *
 * THE VALUES ARE THE CONSTANTS' VALUES — NOT THE CONFIG'S
 *
 * This module could have aliased the config:
 *
 *     export const REPEAT_PENALTY = config.generation.repeatPenalty;
 *
 * and that would have been a silent BEHAVIOUR CHANGE:
 *
 *     the constant   REPEAT_PENALTY = 1.18
 *     the config     repeatPenalty: 1.15
 *
 *     the constant   REPEAT_PENALTY_TOKENS = 256
 *     the config     repeatPenaltyTokens: 64
 *
 * The config's repeatPenalty was NEVER READ by the route — it was
 * inert. Aliasing it would have changed the sampling of every
 * generation, from 1.18 to 1.15 and from 256 tokens to 64.
 *
 * So the values stay exactly as they were. The config's
 * repeatPenalty settings are a separate question — they are dead
 * config, and the fix is to make the config match OR to read it
 * deliberately, not to change the behaviour by accident.
 */
import config from '@/config/index.js';

/** The agentic loop's iteration budget. */
export const MAX_AGENT_ITERATIONS = 6;

/** The repair attempts allowed for ONE file. */
export const MAX_CORRECTIONS_PER_FILE = 3;

/** The repair attempts allowed across all files. */
export const MAX_TOTAL_CORRECTIONS = 5;

/**
 * The repetition penalty.
 *
 * 1.18 — NOT config.generation.repeatPenalty, which is 1.15 and was
 * never read. See the note at the top of this file.
 */
export const REPEAT_PENALTY = 1.18;

/**
 * How many trailing tokens the penalty applies to.
 *
 * 256 — NOT config.generation.repeatPenaltyTokens, which is 64 and
 * was never read.
 */
export const REPEAT_PENALTY_TOKENS = 256;

/** The request timeout, in milliseconds — 60 minutes. */
export const REQUEST_TIMEOUT_MS = 3600000;

/**
 * The config's repetition settings, for the record.
 *
 * These are DEAD CONFIG: the route has always used the constants
 * above. Exposing them here makes the divergence visible instead of
 * leaving two different numbers for the same idea in the codebase.
 */
export const CONFIG_REPEAT_PENALTY = config.generation.repeatPenalty;
export const CONFIG_REPEAT_PENALTY_TOKENS = config.generation.repeatPenaltyTokens;
