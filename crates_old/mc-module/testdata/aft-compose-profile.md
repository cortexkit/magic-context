# AFT store-shaped compose profile

## Fixture and scope

Read-only snapshot of module-store session `ses_313660571ffeZTsf4koSJwk50Q`:
1,627 compartments, 635 active/permanent project memories, active user profile,
and the stored mural artifact. History budget: 60,000 tokens; memory budget:
15,000; profile budget: 4,000; temporal headings enabled. Filesystem project docs
are disabled so the fixture is hermetic. Tier columns contain 3,458,243 Unicode
characters (the reported store footprint also includes the flat content column).

The fixture is private and is **not committed**. `gen/copy-compose-fixture.py`
opens the source SQLite database with `mode=ro` and copies scoped rows in one read
transaction. Tests copy that fixture again before making any changes. They clear
only the copied cache baseline and reset the copied single-writer fence epoch.
The original live store is never modified.

The store does not retain the original adapter request's live tail. The transform
benchmark therefore uses 777 synthetic input messages anchored to the real final
coverage block, with real compartments, memories, profile and mural. This is a
full-pass sanity bound, not a claim about the original tool/native payload costs.
The task-giver approved this limitation. Optimized execution runs first in a fresh
test process, before the baseline can warm the process-local cache.

## Dominant term

The old drift guard re-renders and re-tokenizes the **entire remaining history**
after every oldest-first tier demotion. It does not tokenize all four tiers of
every compartment up front. An isolated original-renderer run measured:

- 13,745.3 ms total; 13,359.7 ms inside the token estimator; **819 full-body counts**.
- History SHA-256: `ed862c1aeb4563baec17606b72f5d6000fa0d61f1d07a0b21dade4ec6de781c4`.
- Cache-only prototype: 480.3 ms total / 208.3 ms counting, still 819 calls,
  with the same history SHA. A later cache-only run under higher load was 663 ms.

The structural fix prepares only visited `(compartment, tier)` renders, retains
those renders through pressure retries, and updates an exact running count when
one tier changes. It joins the final body once per pressure attempt. No binary
search or monotonicity assumption is used: denser tiers may cost more tokens.

Counting uses Claude pre-tokenization boundaries at `\n\n## ` headings, with a
sentinel to preserve the whitespace regex's end-of-input lookahead. Continued
paragraph counts include the separator; the final paragraph has its own count.
A process-local LRU retains at most 8 MiB of accounted key bytes plus per-entry
overhead (two key copies plus 128 bytes per entry). Oversized chunks bypass it;
contended cache access falls back to ordinary counting rather than serializing
transforms. The generic injected-estimator renderer remains available unchanged.

No store migration is needed. Neither Rust `mc_compartments` nor the TS
`Compartment` type in `compartment-storage.ts` has per-tier token counts; durable
tag `token_count` values are not interchangeable with rendered, escaped history
paragraph counts. Content-keyed process-local counts avoid schema and invalidation
changes.

## Final release-profile results

Commands ran on the same shared machine; wall times vary with concurrent load.
`transform_execute` here surrounds the real in-process transform call, without
adapter transport, state_sync, or response JSON encoding.

| Mode | Phase | compose_m0m1 ms | decay_render_ms | tier_tokenize_ms | memory_render_ms | mural_ms | user_profile_ms | retries | transform_execute ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Original loop + ordinary encoder | cold | 14720.5 | 14699.264 | 14274.912 | 10.357 | <0.001 | 0.849 | 0 | 14766.4 |
| Incremental + cached counts | cold | **97.2** | 60.938 | 48.320 | 25.171 | 0.030 | 1.020 | 0 | **134.8** |
| Original | SOFT+ | 0.0 | 0 | 0 | 0 | 0 | 0 | 0 | 18.7 |
| Incremental | SOFT+ | 0.0 | 0 | 0 | 0 | 0 | 0 | 0 | 10.1 |
| Original | SOFT | 9.3 | 0 | 0 | 0 | 0 | 0 | 0 | 35.6 |
| Incremental | SOFT | 9.2 | 0 | 0 | 0 | 0 | 0 | 0 | 22.4 |
| Original | HARD | 19757.7 | 19712.263 | 19160.095 | 13.022 | 0.001 | 1.071 | 0 | 19786.9 |
| Incremental | HARD | 20.8 | 3.274 | 1.073 | 1.095 | <0.001 | 0.049 | 0 | 34.5 |

The sub-stage fields describe m0 composition; SOFT's m1 work remains accounted
under the aggregate compose_m0m1 timer. `decay_render_ms` includes m0 framing and
retry fit checks; `tier_tokenize_ms` is nested within it. The generic baseline
counts full-history strings rather than individual tier strings. Memory/profile
timers cover store selection and budget trimming. Mural resolution is a data-URL
copy/hash, **not PNG decoding**, and happens once outside the retry loop. This
fixture needs no retries; the existing TS retry fixture separately exercises the
pressure-bump contract and matches its expected attempt count and output SHA.

## Byte identity and independent oracles

Both implementations produced these SHA-256 values in all four phases:

- m0 (all phases): `b13b172f944cafaa69096a2b5e65361878601de1bf9fde9b7472335c35aa03da`
- m1 (cold, SOFT+, HARD): `2ad4f63fd5234e268ffd00afe7c73c9785da420c5c16c50608e6b2ece003db2c`
- m1 (SOFT refresh): `6273eb30c2da25878a964cae9054266bd68006f556c8352869c4c70655001ee5`

The ignored live-fixture test checks every tier of every real compartment against
`encode_ordinary(...).len()`, including a following heading and Unicode tail.
The regular corpus adds emoji, CJK, contractions, trailing whitespace, mixed
newlines and Unicode whitespace. Loose and tight TS decay goldens now also invoke
the incremental renderer, and the TS m0 retry fixture checks the incremental path.
A separate nonmonotone-tier test compares the generic full-body oracle across
several budgets. No TS golden expectation was changed.

The TS twin already memoizes rendered tiers and their individual token counts
at `packages/plugin/src/hooks/magic-context/decay-render.ts:196-253`, using an
approximate running total for its first fit. Its exact correction loop at
`:256-261` still counts the full `body`, re-renders it after `demoteOldest`, and
counts it again. Thus only that residual exact-fit loop is a potential TS-lane
follow-up; the TS implementation is not wholly quadratic like the old Rust loop.
No TS code is changed here.

## Reproduction

From the repository root (the output directory must not contain an older store):

```sh
python3 crates/mc-module/gen/copy-compose-fixture.py \
  "$HOME/.local/share/cortexkit/magic-context/store.db" tmp/aft-compose \
  ses_313660571ffeZTsf4koSJwk50Q git:3fba0e3dcc1cb26da9af7a0ccbd98b749e46219b
AFT_COMPOSE_STORE="$PWD/tmp/aft-compose" cargo test -p mc-module --release --lib \
  aft_store_compose_replay_parity -- --ignored --nocapture
AFT_COMPOSE_FIXTURE="$PWD/tmp/aft-compose/compartments.json" cargo test -p mc-module \
  --release --lib aft_live_compose_profile -- --ignored --nocapture
```

The first benchmark asserts cold compose <1 s and synthetic-tail transform <2 s
in release builds and prints the permanent `mc-pass-timing` fields. The ordinary
baseline deliberately uses the uncached ordinary encoder and retained generic
renderer. The second benchmark measures the cache-only renderer, compares its
output with incremental fitting, and runs the full live tier-count corpus.

## Fences and gates

Fifteen safe staged mutations were restored with an empty unstaged diff each time:
six deleted timing writes, six constant timing-line substitutions, a disabled LRU
byte ceiling, corrupted separator/sentinel accounting, and bypassed incremental
budget fitting. Each named target test, and no other test in its targeted run,
failed. The delivery declaration carries the individual mutation evidence.

The full mc-module lib run had 1,102 passing tests, eight ignored, and two failures:
the new timing field initially lacked its old-wire serde default (fixed), and an
unrelated existing debug wall-clock assertion exceeded its 50-us threshold during
heavy load (53.571 us). Both failed tests passed individually afterward. Restored
compose, decay/TS goldens, retry and tokenizer tests pass. Module/store all-target
clippy and formatting pass. mc-store was not changed; no migration gate applies.
Cargo.lock sibling drift is restored, not committed.
