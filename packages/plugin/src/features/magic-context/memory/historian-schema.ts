/**
 * Historian wire contract, version 1. This table describes the prompt contract;
 * it is not passed to a provider's schema or tool-choice API. Unknown fields are
 * ignored locally. Integers below are JavaScript safe integers.
 *
 * | Object / action | Required fields | Optional fields |
 * | --- | --- | --- |
 * | envelope | result: object | — |
 * | result (turn one) | step: "turn_one", xml: string | — |
 * | result (turn two) | step: "turn_two", decisions: decision[] | scores: score[] (default []) |
 * | every decision | fact_id: integer, action: action literal below | — |
 * | new, abstain | — | — |
 * | conflict | target_id: integer | — |
 * | covered | target_id: integer, revision: integer, clauses: nonempty integer[] | excerpt: string |
 * | edit, replaces | target_id: integer, revision: integer, kept: kept[], final_text: string | removed: cited[], replaced: cited[], added: added[] (each default []) |
 * | merge | sources: source[] (at least two), survivor_id: integer, kept: kept[], final_text: string | removed: cited[], replaced: cited[], added: added[] (each default []) |
 * | source | id: integer, revision: integer | — |
 * | kept | memory_id: integer, clause: integer | — |
 * | cited | memory_id: integer, clause: integer, block: integer, excerpt: string | — |
 * | added | text: string, block: integer, excerpt: string | — |
 * | score | item: integer, importance: integer (1–100), class: string (1–64 UTF-16 code units) | — |
 *
 * `retire` and `promote_rule` are recognized only to leave the fact pending on
 * the read-only review list, never to apply or resend it. A duplicate decision invalidates that fact; duplicate scores
 * invalidate every score for that item, even if one duplicate is malformed.
 * Item failures do not invalidate the envelope. Missing decisions are resolved
 * by the turn-two resolver, which knows the reserved fact set. Unsent scores are
 * discarded by the score recorder. Item refusals do not consume the fact's retry
 * budget; malformed envelopes consume one attempt for every reserved fact.
 */
export const HISTORIAN_WIRE_VERSION = 1;

/** Clause-evidence and compatibility checks use fresh sessions and this separate prompt contract. */
export const CHECK_SCHEMA_CONTRACT =
    'Reply with exactly one JSON object: {"verdicts":[{"id":"operand or pair id","verdict":"yes|no"}]}. Each entry must be an object with a string id and a verdict of "yes" or "no". Include exactly one entry per requested id. Do not call tools.';
