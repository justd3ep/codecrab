/**
 * monolithicLoop.ts — MIGRATION PLACEHOLDER
 *
 * The original monolithic generation loop lives in index.ts around lines 2400–3750.
 * It is NOT moved here yet — it remains active in index.ts as the primary
 * generation path until the new JobService is fully validated in production.
 *
 * When to move / delete:
 *   - JobService handles `/v1/chat/completions` internally, OR
 *   - All clients migrated to `/v1/jobs`, AND
 *   - No import of this file exists anywhere in src/
 *
 * See REMOVAL_MILESTONE.md for full criteria.
 */

export {}; // module placeholder
