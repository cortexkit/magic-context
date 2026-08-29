# TS ↔ Rust ↔ Pi parity hunt #12 — merge-wave seam audit

## Method, fence, and honest-empty counter

TypeScript remains the OpenCode specification and comparisons stay inside each provider/harness value space. Rust admission remains the two live configured projects only: ASTROCYTE and ENGRAM. The worktree started at `868fd978` (the current-master lock-wave commit immediately after requested coordinate `eea15003`); no schema, migration, authority, or deployment fence moved. No master push is part of this work.

The dump-first live command was:

```text
python3 scripts/audit-transform-wire-parity.py --live --date 2026-08-28 --after 2026-08-28T00-00-00 --per-session 1000
```

The final privacy-safe snapshot covered 5,838 captures from two auth-dump directories: 2,070 Anthropic and 3,768 OpenAI Responses. SQLite handles were read-only/query-only. The committed report contains only counts, hashes, fixed class names, and eight-character session prefixes; no provider prose, project path, full session id, database row, or live JSON artifact is committed.

This hunt found and fixed an explicit-language classifier defect and closed part of the provider lane-coordinate gap. It is **not an honest empty**. The standing counter remains **0/3**.

## Axis A — today's cache seams

### A1. Frozen LKG ↔ R4 delta ↔ model transition — PASS, strengthened fixtures

`lkgRepresentationFrozen` keeps the exact fallback representation, keeps `forceFullWire` asserted while that representation is provider-visible, and clears the freeze only when a cache-busting pass adopts module output (`rust-mode-transform.ts`, the freeze/adoption block around the existing LKG state machine). The existing transition fixture now also proves the next tail change resumes `tail_delta` after bust adoption, rather than remaining permanently full-wire (`rust-mode-transform.test.ts:3847`). A second fixture flips the model while the in-process LKG is frozen and proves the stale slot is removed and raw bytes are served (`rust-mode-transform.test.ts:3926`). The hydrated/restart model fence remains independently covered.

A marker advance does not alter the raw stable-id sequence used by LKG eligibility. While frozen, every successful defer still sends a full request, so no R4 delta can splice against the replayed provider representation. On the bust that adopts the new marker/module representation, full transport establishes the new acknowledgement; the following pass may use R4 delta.

### A2. Sentinel absence retention ↔ compaction-off ↔ Pi clone — PASS, strengthened fixtures

The absence-prune fix deliberately treats one transform-array absence as a marker-window projection gap, not source deletion (`transform-postprocess-phase.ts:1673-1692`). The existing execute↔defer marker-window matrix remains. A new off→on fixture proves compaction-off preserves original message bytes without deleting the durable frozen id, then re-enabling compaction replays the empty sentinel (`transform-postprocess-phase.test.ts:508`).

Pi clone inheritance already copies `stripped_placeholder_ids`, `stale_reduce_stripped_ids`, and processed-image frozen ids through the clone's prefix filter (`storage-clone.ts:431-487`). The clone fixture now directly pins placeholder ids as well as image ids and excludes ids beyond the copied prefix (`clone-inheritance.test.ts:631`).

### A3. Ride-only supersession ↔ hygiene ratio — PASS

The ride gate opens only for concrete already-scheduled work or an admitted two-pass batch (`selection.rs:1220-1274`). When open, the same selector outcome records eligible, tag-window-withheld, exempt-message-withheld, and finally applied arc counts after all protection filters (`selection.rs:1279-1401`). The hygiene measurement sees applied automatic reductions through the mutated `core`/`red_targets`, while queued agent drops ride through `pending_drop_target_ids` (`tail_hygiene.rs:516-620`; `transform.rs:5176-5199`). Therefore ride-only drops leave the measured live tail, while protected/withheld arcs remain in it. Existing Rust fixtures `supersession_measurements_distinguish_protection_sources_and_final_application`, `force_band_two_pass_batch_carries_pending_supersession`, and `independent_bust_applies_the_whole_aged_supersession_batch` cover the gate and accounting.

No production cache mutation was required for Axis A.

## Axis B — content-language directive twins

### Finding P12-LANGUAGE-CLASSIFY — fixed

Before this hunt, `classify-memories` did not carry `language` into `ClassifyArgs`. The TypeScript child sent bare `CLASSIFY_SYSTEM_PROMPT`, and the MODULE path sent the same English constant to Broca. Thus a configured-language classify on a Rust-authority project was **English**, even though historian fire/repair had just gained Rust localization.

The fix:

- passes the resolved task/global language from `task-executor.ts:571-585`;
- appends the shared TypeScript directive in `classify.ts:363-373`;
- applies the generated Rust twin to `CLASSIFY_SYSTEM_PROMPT` from the route's trusted config before every module producer attempt (`crates/mc-module/src/lib.rs:9596-9617`); and
- pins Turkish directive bytes in both the TS classifier test and the real Rust producer-driver test.

Directive inventory after the fix:

- registration-time TS agents: historian, recomp, editor (`packages/plugin/src/index.ts:758-772`), with historian repair using the same registered/system chain;
- runtime TS producers: sidekick (`sidekick/agent.ts:77-82`), user-memory review (`review-user-memories.ts:208-211`), refresh-primers (`refresh-primers.ts:264-267`), verify (`verify.ts:261-272`), retrospective deepen and curate (`task-executor.ts:1018-1026,1237-1244`), and classify (`classify.ts:372`);
- Rust module producers: historian fire and retry repair through `content_language`, plus classify through `binding.config.language`.

For Rust memory authority, classify is the only named Dreamer leg whose LLM call itself runs module-side (`dreamer.run_task` via Broca). `map-memories` and `verify` still run their bounded provider calls host-side; only their fenced appliers run module-side (`memory.set_mapping` and `memory.set_verification`). Map output contains only ids/paths/independent markers, while verify's authored prose is already directed.

## Axis C — mapping-origin twins (migration v82/51)

**PASS; cross-lane coverage strengthened.** When every proposed path fails host normalization, TS records `host_rejected_fallback` (`map-memories.ts:501-513`). Under MODULE authority the row carries `mapping_origin` through `memory.set_mapping` (`map-memories.ts:527-565`); Rust validates the two-value vocabulary (`mc-module/src/lib.rs:10088-10117`), persists it in `mc_memory_mappings`, emits it in the memory snapshot/changefeed, and restores it during authority seed (`mc-store/src/lib.rs:14571-14624,14795-14804,14964-14974,16605-16690`). Mirror application reconstructs the marked no-file sentinel (`context-authority.test.ts:465-563`).

Both lane gates intentionally key on mapping shape, not origin:

- `getUnmappedMemoryIds` excludes any memory with a mapping row, so both mapper independence and host fallback converge (`storage-memory-verifications.ts:87-99`);
- verify admits only mappings with at least one real file, so both no-file sentinel forms are excluded identically (`verify-gate.ts:105-115`).

New regressions prove the rejected fallback travels on the MODULE call without touching the context mirror (`map-memories.test.ts:213`) and both no-file origins remain outside verify (`verify-gate.test.ts:90`). Existing module/store and changefeed tests complete the transport chain. Live maintenance still reports only two aggregate Dreamer-applier command rows, so no claim is made that a live fallback-origin row was produced today.

## Axis D — `MAGIC_CONTEXT_STORAGE_DIR`

### Finding P12-STORAGE-HARNESS — fixed

The production override correctly sat below `MAGIC_CONTEXT_TEST_DATA_DIR`, but that guard also sat above deliberate per-test `XDG_DATA_HOME` fixture roots. Tests that expected a fresh XDG database therefore converged on one preload database. The first full plugin gate exposed this honestly: 112 failures, dominated by duplicate compartment/session rows and cross-test overflow/latch state.

The resolver now distinguishes the preload root from a changed per-test XDG root. While `MAGIC_CONTEXT_TEST_DATA_DIR` is present, a differing XDG path is still classified as `test isolation` and may select a fresh fixture database; `MAGIC_CONTEXT_STORAGE_DIR` can never escape that isolation (`data-path.ts:212-247`). The existing opposite test was deliberately changed because its old assertion encoded the collision: the new contract proves per-test XDG wins while a simultaneous production storage override remains ignored (`data-path.test.ts`). This restores the plugin and Pi e2e harness model rather than weakening the production override order.

Pi's preload still establishes the test variable before imports. A new Pi-suite regression uses a subprocess (so environment mutation cannot race sibling files), sets a conflicting production override, and proves the resolved path remains the preload directory with source `test isolation` (`storage-preload.test.ts`). Pi's preload comment now states both halves: per-test XDG fixtures may replace the root, while the production storage override cannot.

Normal doctor flows all render the same resolver origin: OpenCode (`doctor-opencode.ts:1267-1275`), Pi (`doctor-pi.ts:631-642`), and OMP (`doctor-omp.ts:275-278`).

**Structural brief P12-STORAGE-ORIGIN.** Startup success/fail-closed logs still print paths without the resolver source, doctor v22 early-return commands bypass the normal source line, and most doctor tests do not assert origin. Acceptance: make source non-optional in diagnostics, assert all three doctors including early returns, and include source in Pi/OpenCode startup diagnostics without weakening path redaction.

## Axis E — differ unexplained bucket and live lane coordinates

### Provider lane gap — partially closed with a privacy-safe read-only join

OpenAI Responses instructions frequently omit `Working directory`, so system-byte extraction alone cannot verify a lane. `--live` now sends only twelve-character SHA-256 session coordinates to the Bun helper. The helper joins those coordinates against both `session_projects` and the read-only OpenCode `session` directory, reads the live project config, rejects hash/lane collisions, and returns only session hash, project hash, and lane (`audit-transform-wire-parity-live.ts:220-313`; application at `audit-transform-wire-parity.py:3851-3902`). A rootless Responses regression proves this path and the privacy test proves no temp/project path enters output.

Final coverage:

- 70 capture session hashes requested; 14 resolved, zero ambiguous;
- 1,432 previously-unverified dumps admitted through the join;
- admitted inventory: Rust Anthropic 343; TS Anthropic 298; TS OpenAI Responses **791**;
- 4,406 dumps remain unverified, including 2,977 OpenAI Responses.

This closes the old 546-capture gap for a larger non-empty TS Responses denominator, but not every historical capture. The external auth-dump writer is not in this repository, and sessions absent from both durable binding sources cannot be reconstructed safely.

**Structural brief P12-CAPTURE-COORDINATE.** Have the external auth writer persist a one-way session/project coordinate in the metadata sidecar at capture time. Acceptance: no raw path/full id, collision detection, readable live config at audit time, and old sidecars remain valid but unverified.

### Count-space defect — fixed

The provider matrix said unlike-session counts were inventory only, but compared literal `calls=N;results=N` strings, creating guaranteed false divergences as transcript lengths differed. `compare_provider_matrix` now normalizes tool cardinality to balanced/unbalanced plus adjacency while preserving literal counts in evidence (`audit-transform-wire-parity.py:1124-1217`). A regression compares one-call TS and two-call Rust sessions and requires matched structural value space.

### Residual live findings

The final live source-contract unexplained bucket is empty, but the carried live legs remain intentionally loud:

1. three Anthropic value-space axes have Rust-only observed shapes (empty assistant text, post-result drop placement, and reasoning/signature shapes). These are unpaired-corpus observations, not yet a same-input defect;
2. two unverified OpenAI Responses captures (`9ee1b0ea69c…`, `f89ee8967f47…`, prefix `ses_fb7c`) contain a non-Anthropic empty-content shape;
3. 2,977 Responses captures still lack a lane coordinate;
4. the current live Caveman oracle reports a TS/Rust byte difference and the Pi inventory reports native compaction with a pending marker; and
5. post-cutoff Rust compartment publish coverage remains zero, while Rust recomp/wrapup command coverage remains zero.

Discriminating follow-up requires quiescent matched source hashes/ordinals for Caveman, inspecting the two hashed Responses shapes against the adapter's legal empty-item contract, draining/re-reading the Pi marker, and a same-input capture for each Anthropic lane-only shape. No speculative runtime mutation was landed for these structural/live findings.

## Executed non-vacuity mutations

Every temporary mutation carried the required non-vacuity marker and was restored before final gates:

1. replacing the TS classifier directive with the bare English prompt reddened `classify.test.ts:88` (expected Turkish directive absent);
2. disabling the hash-coordinate lane adoption reddened `audit-transform-wire-parity.test.py:633` (`unverified` instead of `ts`);
3. collapsing MODULE fallback origin to `mapper` reddened `map-memories.test.ts:267`; and
4. clearing `forceFullWire` while LKG was frozen reddened `rust-mode-transform.test.ts:3906` because a tail delta appeared before bust adoption.

A changed-file search after restoration found zero temporary mutation markers.

## Landed changes

1. localize classify-memories on both TS and Rust/Broca producer legs;
2. repair per-test XDG fixture isolation without allowing `MAGIC_CONTEXT_STORAGE_DIR` to escape the preload guard;
3. add cross-seam cache, clone, mapping-origin, verify-gate, and Pi-preload regressions;
4. add the hunt-12 merged-source contract and unexplained-bucket leg without removing hunts 1–11;
5. resolve rootless live provider captures through privacy-safe hashed durable bindings; and
6. normalize unlike-session tool-call cardinalities to structural adjacency classes.

## Verification

- `packages/plugin: bun run typecheck` — passed.
- `packages/pi-plugin: bun run typecheck` — passed.
- touched plugin regressions (7 files) — **278 passed, 0 failed**.
- `packages/pi-plugin: bun test` — **835 passed, 0 failed**.
- `cargo test -p mc-module` — **996 passed, 0 failed, 4 ignored** across the library/integration binaries.
- parity differ tests — **7 passed**; live-helper tests — **3 passed**.
- `cargo fmt --all -- --check` and `cargo check -p mc-module -p mc-store` — passed; the check retains two pre-existing `usable_window_tokens` dead-code warnings.
- full `packages/plugin: bun test` was executed repeatedly. The storage-harness fix reduced the first honest result from **4,039 pass / 112 fail** to **4,149 pass / 2 fail**. A serialized confirmation produced **4,148 pass / 3 fail**. The residual failures are load-sensitive unrelated timeout tests (observed examples: forced-final compartment wrapup and compaction-off `/ctx-aug`); each observed test passed in its focused file, and all touched regressions passed together. No residual failure names a changed assertion or source path.

No live JSON dump is committed.
