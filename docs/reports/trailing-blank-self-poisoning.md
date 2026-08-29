# Trailing-blank self-poisoning fix report

Date: 2026-08-28

## Outcome

The TypeScript transform now records trailing-blank decisions from a snapshot of the harness-derived message shape taken before Magic Context can insert sentinels, canonical blanks, or synthetic messages. A frozen `keep` decision can still canonicalize an existing blank suffix, but it cannot create a suffix when the current message has none. Existing poisoned keeps drain on cache-busting passes by demoting to `strip` when the source snapshot has no trailing blank.

This removes the insert → observe → keep → insert feedback loop without moving a persistence fence. The existing `session_meta.trailing_blank_decisions` JSON column remains the sole state surface; there is no schema change or migration.

## Pinned minting path

The integration reproduction uses the incident's store topology:

1. Consecutive assistant messages make an AI-SDK merged composite: a sibling carrying leading text and a target carrying `step-start`, reasoning, tool use, and `step-finish` parts.
2. The target ID is already present in `merged_reasoning_stripped_ids`, reproducing the frozen-ID replay that survives later marker windows.
3. `stripStructuralNoise` replaces the terminal `step-finish` store part with an empty-text sentinel.
4. Finalization replays the frozen merged-reasoning strip and replaces the target's reasoning with another empty-text sentinel.
5. Before this fix, post-finalize capture walked that composed array. Its sentinel-invisible suffix walk treated the terminal structural-noise sentinel as a blank and minted `keep`, even though the raw target had no trailing text part.

The reproduction therefore pins a more precise first planter than the initial merged-reasoning hypothesis: **the terminal artifact is the structural-noise sentinel replacing `step-finish`**. Frozen merged-reasoning replay is active in the reproducer and explains why this merged-assistant class reached the vulnerable finalization path, but its reasoning sentinel is not the terminal part in the verified store ordering.

With source capture enabled, the same target mints `strip`; the composed terminal sentinel is removed and cannot poison the frozen map.

## Fix mechanics

### Source-only capture

`transform.ts` snapshots each assistant's trailing-blank classification before tagging, structural-noise stripping, or synthetic injection. `runPostTransformPhase` receives that immutable map; direct callers get a fallback snapshot at phase entry. Candidate discovery reads the source map and intersects it with IDs still present in the final message array, so synthetic assistants and Magic Context-inserted parts are not observable inputs.

The newest-assistant rule is unchanged: only the live newest ID may refresh on a defer pass, and historical first decisions still wait for an independently cache-busting pass.

### Keep cannot manufacture bytes

A `keep` or `keep:N` decision canonicalizes only when a blank suffix already exists. When the current representation has no blank suffix, replay does nothing and does not splice in `CANONICAL_BLANK_PART`.

This deliberately accepts one cache miss if a formerly present suffix is now absent. Recreating the bytes would be worse: it would make Magic Context the source of the blank and allow every later capture/replay cycle to perpetuate it.

Clone-before-splice behavior is retained for the paths that still resize suffixes, so OpenCode-owned live objects are not mutated through stale aliases.

### Organic poison heal

On a cache-busting pass only, postprocess compares persisted historical keeps with the source snapshot. If the source decision is `strip`, the existing JSON-map entry is changed from `keep`/`keep:N` to `strip` through a compare-and-swap update of the current `session_meta` column. Each successful demotion is logged once with the message ID and reason.

The demotion happens before finalization, so the same already-priced bust removes the composed suffix. Later defer passes replay the persisted `strip` byte-identically. Defer passes never demote. The live newest assistant is excluded from healing because its existing refresh rule remains authoritative.

A source shape with a real trailing text blank is the negative arm: its keep remains a keep and the healer does not fire.

## Regression and mutation evidence

The focused regression coverage proves:

- a raw blank-less merged-composite store message does not mint `keep` from composed sentinels;
- `keep` plus an absent suffix leaves the provider-shaped fixture unchanged;
- a poisoned keep survives a pre-bust defer, demotes on execute, loses the terminal artifact, logs once, and replays identically over two fresh defer rebuilds;
- a store message ending in text `" "` remains a legitimate keep through bust and defer;
- the existing late-provider-blank test still strips a historical suffix frozen as `strip`.

Executed mutations used the exact `NON-VACUITY BREAK` marker and were restored immediately after each red run:

| Deliberate mutation | Command | Observed red evidence |
| --- | --- | --- |
| Re-enabled observation of the post-finalize message array | `bun test src/hooks/magic-context/transform-postprocess-phase.test.ts -t "mints from the raw store shape instead of a composed trailing sentinel" --timeout 30000` | `transform-postprocess-phase.test.ts:3134` failed: expected the target decision to be `strip`, received `keep`. |
| Restored the keep arm's insertion when the current suffix is absent | `bun test src/hooks/magic-context/strip-structural-noise.test.ts -t "does not manufacture a missing blank for a frozen keep decision" --timeout 30000` | `strip-structural-noise.test.ts:160` failed its byte-equality assertion: the received provider shape gained `{"type":"text","text":""}`. |
| Opened poisoned-keep healing on defer passes | `bun test src/hooks/magic-context/transform-postprocess-phase.test.ts -t "heals poisoned keeps only on a bust and replays the healed strip byte-stably" --timeout 30000` | `transform-postprocess-phase.test.ts:3189` failed its byte-stability assertion: the terminal empty-text part disappeared on the pre-bust defer. |

No `NON-VACUITY BREAK` mutation remains in the tree.

## Verification

- Frozen workspace dependency install: `bun install --frozen-lockfile` — passed.
- Focused trailing-blank, postprocess, and persistence tests — 96 passed, 0 failed.
- Post-mutation guard rerun — 3 passed, 0 failed.
- Plugin TypeScript gate: `bun run typecheck` — passed.
- Full plugin suite: `bun run test` — 4,169 passed, 0 failed across 379 files.
- Changed-file Biome check — passed.
