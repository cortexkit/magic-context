# `/ctx-rescore` slice 3: independent Rust cache review

## Decision

**No-merge as-is.** Forward-only rendering and CAS behavior pass this review, but a downgrade/upgrade round trip loses the applied score view and lets a pending rescore originate a provider-prefix bust on an otherwise byte-identical marker HARD.

Reviewed product revision: `95c21df93aa5c7e30b5f40ffdb771e732bc034e8`, against `192f6346b139fff93764c561c91dba4be0f8c3a8`. The comparison implementation is the TypeScript OpenCode plugin and Pi/OMP plugin rescore change at `5e00954e1bdff3b96efb33cf3dbd17348bd848c9` (a sibling commit on the same base, not present in the Rust checkout). This review changes **tests and this report only**; no product fix or compatibility shim is included.

Terminology used below:

- **m[0]** is the frozen primary-agent history baseline; **m[1]** is its newer-content delta. A **prefix bust** means changing their served bytes or losing the provider's cache key, so the cached prompt prefix can no longer be reused.
- **SOFT+** replays both heads; **SOFT** refreshes only the delta; **HARD** rebuilds the baseline. A **marker HARD** is requested by a metadata marker, such as a memory-epoch flag, even if recomposition finds no actual content difference. That unchanged case must not authorize a new prefix bust.
- **W** is the persisted selection-log watermark used for the last baseline; **L** is the latest published selection sequence. The **applied score view** is the set of scores selected at W; **Latest** captures the view at L. Score **sidecars** hold revisions/selections separately from original compartment rows.
- **P1–P4** are stored summaries at decreasing levels of detail; P5 archives a compartment. **Pressure** is the shared budget-dependent decay multiplier: it can change the tier chosen for other compartments too.
- **CAS** means compare-and-swap on the cache row version: a stale writer must reload instead of replacing a newer writer's bytes.

| Area | Verdict |
| --- | --- |
| 1. No new bust origin | **Pass for forward-only sessions**, including no-rescore differentials, SOFT+, SOFT, and marker HARD. The downgrade case below violates this property after watermark loss. |
| 2. Watermark atomicity | **Pass** for late publication, a real row-version CAS retry, two concurrent transform writers, and interrupted commit/restart. |
| 3. Rollback and upgrade | **Fail** for downgrade/re-upgrade of an already rescored frozen head. **Pass** for a pre-v98/base-scored session acquiring the new tables. |
| 4. TS/Rust parity | **Pass for the exercised selections, tiers, and pressure.** The two slices' same-named JSON fixtures are different schedules; an additional same-schedule bridge was necessary. |
| 5. Historian references | **Pass**: effective scores change prompt reference copies, not stored/base-loaded rows or boundary identities. |

The governing contract is `ARCHITECTURE.md:63–83,99–104`: SOFT+ replays both heads; SOFT may refresh m[1] but not re-tier m[0]; deferred work must not originate a bust. The rescore-specific constraint is `docs/designs/compartment-rescore.md:65–71,100–103`: an unchanged marker HARD must keep the **applied** score view, and adopting Latest needs independent fold/bust authority.

## Blocking finding: loss of W is not safely equivalent to a base-scored head

**High severity, cache-safety regression across rollback.** Missing metadata correctly defaults to zero for genuinely old/base-scored sessions, but the same default is unsafe when an older writer removes the key while preserving an already rescored m[0]. The code cannot distinguish those states.

### Reproduction

The committed regression is:

`transform::tests::score_projection::review_downgrade_meta_rewrite_must_not_adopt_unserved_scores_on_marker_hard`

It uses 16 tiered compartments with original importance 50. Each summary body names its tier and compartment, such as `detail-P2-1;`, so assertions distinguish an actual change of detail level from a metadata-only update:

1. Publish a score of 1 for compartment 1, then naturally render the initial HARD. Frozen m[0] serves `detail-P2-1;` and commits **W=1**. Compartment 2 still serves P1.
2. Publish a score of 1 for compartment 2. **L=2, W=1**; that score has never been served.
3. Model the old writer's metadata rewrite by committing the identical frozen core with `score_selection_watermark` omitted. Restart the store. The new decoder reads **W=0**, but the frozen bytes still represent W=1.
4. A normal re-upgrade replay remains SOFT+ and byte-identical. Thus upgrade alone does **not** immediately force a fold.
5. Set only the project-memory epoch pending marker, without changing memory, compartments, model, system prompt, time, or coverage. With W retained, this is a cache-preserving marker HARD.
6. The new runtime instead probes the **base** score view. That probe disagrees with the frozen rescored head, grants bust permission, renders Latest, and commits **W=2**, serving compartment 2's previously unserved rescore.

The downgrade test reaches its final cache-preservation assertion and fails there, rather than at an unwrap, compilation, or unrelated fixture setup:

```text
a downgraded meta-only rewrite turned an unchanged epoch marker into a prefix bust:
watermark=2, pending score served=true
```

The full final library suite has exactly this one failing test; the other 1,864 tests pass and 25 are ignored. The regression is deliberately left failing rather than weakening the assertion to accept the new bust.

### Confirmed against the placed older binary

The placed binary identifies itself as:

```text
ck-mc 0.1.0 (77f54a691090a8927c3686735e912e46789e25c4)
ck-subc 0.20.68
```

I copied both executables into a throwaway directory inside this worktree and used `HermeticSubcStack.start` / `moduleRequest` (`packages/e2e-tests/src/rust-runner/hermetic-subc.ts:521–542,685–704,901–942`). HOME, CFFIXED_USER_HOME, XDG data/config/cache roots, TMPDIR and Magic Context's `context.db`/`store.db` storage were isolated; no live daemon was restarted and no live store was opened.

After an initial transform created the scratch cache, I stopped the module, inserted `score_selection_watermark: 123` into that scratch row's JSON, restarted the **copied old binary**, and appended an ordinary user-tail message. The old binary returned **SOFT+, committed=true, prefix_bust_permitted=false**, preserved both head bytes, advanced the observed row version **2 → 3**, and removed the watermark key. This is an actual old-executable serialization-loss observation, not merely inference from Serde. It did not attempt to serve a real rescored head: the scored re-upgrade consequence is established separately by the Rust regression above.

At the placed source revision, `ModuleMeta` has no watermark field and uses ordinary Serde deserialization/serialization (`77f54a6910:crates/mc-store/src/lib.rs:4687–5104`; `77f54a6910:crates/mc-store/src/cache_codec.rs:737–757`). The runtime observation agrees with that source.

### Why the forward-only fence fails after rollback

- The new field defaults to zero and zero is omitted (`crates/mc-store/src/lib.rs:4721–4729`). That preserves old golden bytes, but carries no distinction between “base-scored head” and “applied view forgotten.”
- The marker probe receives this persisted value (`crates/mc-module/src/transform.rs:5397–5418`) and uses `AtWatermark` (`:10018–10045`). At zero, no selection is active (`crates/mc-store/src/score_projection.rs:164–203`).
- If that probe differs, the retained composition is discarded and the HARD arm uses Latest (`crates/mc-module/src/transform.rs:6212–6237`). The apparent content difference here came from forgetting the score view, not independent content change.

**Required resolution:** retain/recover the applied view in a rollback-safe way, prevent unsupported downgrade of an applied head, or conservatively preserve an ambiguous frozen head until independently authorized cache loss/content work. Simply treating absent W as Latest, or forcing an upgrade HARD, would violate the same contract and the pre-v98 requirement. Do not merge this slice on the basis that an older binary merely “ignores the new key.”

## Forward-only behavior and CAS review

The score sidecars do not enter the HARD classifier or m[1] revision digest. Base rows and score selections are acquired in one context-domain read (`crates/mc-store/src/score_projection.rs:206–233`); the map is projected only onto `DecayRenderCompartment` copies (`crates/mc-module/src/m0_compose.rs:592–604`). The composer returns the acquired watermark, rather than querying a head during persistence (`:632–647`).

The marker-only classifier probes W and retains the actual composition that passed its byte comparison (`crates/mc-module/src/transform.rs:5381–5422,6212–6237`). Other committing HARDs and pressure refolds acquire Latest; both assign the returned watermark alongside the rendered core (`:6498–6507,6589–6611,6724–6732`).

`commit_transform_with_provider_policy` encodes the supplied core/meta before entering its fenced transaction, checks the loaded row version before writing, and does not re-read context-domain heads at CAS (`crates/mc-store/src/lib.rs:10830–10885,10901–10915`). A CAS conflict reloads/reclassifies/recomposes, rather than blindly retrying old bytes with a newer watermark (`crates/mc-module/src/transform.rs:3149–3159`).

### Additional executable probes

All names below are in `transform::tests::score_projection` and are committed with the review:

| Probe | What was observed |
| --- | --- |
| `review_marker_publication_between_probe_and_cas_keeps_exact_applied_render` | Start with applied W=1, publish L=2 after the marker probe's snapshot. The marker commits exact previous messages, keeps W=1, and grants no bust permission. |
| `review_score_cas_retry_recomposes_bytes_and_watermark_together` | After the first Latest snapshot, publish selection 2 and commit a competing meta change. The genuine model-change HARD conflicts at CAS and retries: the successful render includes both expected P2 bodies and W=2. Its row-version delta is exactly the competing commit plus the successful fold. |
| `review_two_score_writers_cannot_commit_stale_render_after_newer_fold` | Pause writer A after its W=1 snapshot. Writer B publishes/adopts selection 2 and commits the model-change HARD. Resume A: its stale CAS cannot overwrite B; the retry replays B's exact served array and W=2 without another HARD or row-version bump. These are two concurrent requests sharing the module's store, matching its single-store writer model. |
| `review_score_render_commit_failure_rolls_back_bytes_and_watermark` | Fail the actual transform commit after section writes, then close/reopen the store. Core, meta, row version, and W=0 remain exactly pre-fold. A subsequent natural HARD adopts W=1/P2 together. This uses a transaction-failure injection, not a power-loss emulator; the store's existing killed-writer test also passes. |
| `review_pressure_refold_commits_latest_snapshot_not_late_publication` | Forty-one ordinary memory updates cause a real `pressure_refold`. Its Latest snapshot includes selection 1, a publication in the snapshot/commit interval adds selection 2, and the refold commits W=1 with only the acquired score. |
| `review_pre_v98_session_installing_score_tables_does_not_rebuild` | Render with no score tables, install the real score schema, replay. No HARD, no changed messages, W=0, and no serialized watermark key. |

Existing tests additionally prove publication-only SOFT+ stability, fixed-P1 new-compartment SOFT, TTL/model-loss adoption, content-busting marker adoption, and pending undo across restart. The SOFT test changes m[1] for a **new compartment**, not for the rescore; m[0] and applied W remain frozen. The boundary test `score_publication_keeps_boundary_identity_warm_and_after_restart` observes unchanged base importance, revision identity, and no extra raw-body validation query.

## Parity and historian references

The Rust fixed schedule covers first fold, two publications, source-identity invalidation, Latest fold, undo-to-base, and another pending publication. I added explicit Rust pressure assertions against the fixture's constants, alongside its existing effective-vector, applied/latest-watermark, and expected-tier checks. The two folding steps produce pressures **2.809** and **3.022** and the fixture's exact 16-row tier vectors.

`bun test ./crates/mc-module/gen/score-projection-parity.test.mjs` passes: actual TS and Pi renderers match the Rust fixture's expected tiers/pressure. That test feeds them already projected rows, so **it alone does not prove TS sidecar selection parity**. The sibling TS slice's 40 projection tests also pass, including its own TS/Pi staging/fold/undo schedule.

The same-named JSON files are not one shared file: the Rust fixture has 16 uniformly base-scored rows, while the TS slice's fixture has eight rows and a different selection schedule. I therefore ran a temporary bridge in the archived TS slice: use its real schema, selection publisher, `projectCompartmentScores`, and TS/Pi materializers, but execute the **Rust six-step/16-row schedule** at budget 1,000. All 314 assertions passed: effective vectors, L/W, untouched original scores, exact tier presence/absence, TS/Pi rendered equality, and independently calculated pressures. Bridge source invalidation changed P1 in both host databases; undo selected base, not an older revision. This closes the selection gap for those cases, not every possible budget/threshold or race. The bridge's initial hand-written age formula omitted the index-minus-one conversion; that test-harness error was corrected before the passing run and is not a product finding.

Historian assembly returns original compartments plus a separate score map (`crates/mc-store/src/lib.rs:11903–11945`). The prompt constructor applies that map to `ReferenceCompartment` copies only (`crates/mc-module/src/historian_chunk.rs:1073–1083`). Its effective-score test passes: diverse picks and the displayed calibration importance change, recent references still omit score labels and remain the same recent rows, and the base loader remains unchanged (`crates/mc-module/src/historian_score_projection_tests.rs:70–103`). This does not refresh the primary-agent heads.

## Verification record

Build/test/check execution below used Linux (`runon: "linux"`) except the placed **Mac** executables, which were necessarily run locally. Heavy Cargo gates ran sequentially in blocking foreground calls. Toolchain: **cargo 1.99.0 (5f94df478 2026-08-27), rustc 1.99.0 (b940084d7 2026-09-28), clippy 0.1.99 (b940084d7e 2026-09-28), rustfmt 1.10.0-stable (b940084d7e 2026-09-28), Bun 1.4.2 (744846f84).**

| Gate | Base `192f6346b1` | Slice `95c21df93a` / final review |
| --- | --- | --- |
| `cargo test -p mc-module --lib` | 1,848 passed, 0 failed, 25 ignored | Unmodified slice: 1,858 passed, 0 failed, 25 ignored. Final tests: **1,864 passed, 1 intended failure, 25 ignored**. |
| `cargo test -p mc-store` | 311 passed, 0 failed, 5 ignored; 0 doc tests | 317 passed, 0 failed, 5 ignored; 0 doc tests. Store code/tests were not changed by this review. |
| `cargo clippy --workspace --all-targets -- -D warnings` | Pass across all four workspace crates/all targets | Pass on unmodified slice and again after final test edits. |
| `cargo fmt --check` plus `rustfmt --edition 2021 --check crates/mc-module/src/transform_score_projection_tests.rs` | Not needed for an immutable base archive | Pass after final test edits. The explicit rustfmt check covers the included test file. |
| `cargo test -p mc-module --lib transform::tests::score_projection:: -- --nocapture` | Rescore tests do not exist at base | Final: 15 passed, exactly the downgrade regression failed, 1,874 filtered. |
| `bun test ./crates/mc-module/gen/score-projection-parity.test.mjs` | Fixture does not exist at base | 1 passed, 36 assertions. |
| Sibling TS/Pi `score-projection.test.ts` | Not applicable | `5e00954e`: 40 passed, 1,013 assertions; same-schedule bridge: 1 passed, 314 assertions. |

Failure-name comparison: **no baseline product failure**, no failure in the untouched Rust slice, and exactly the new downgrade test red in the final full module suite. No existing test was renamed, weakened, or changed to invert its contract.

### No-rescore byte differentials

Both full module runs pass Rust's differential goldens (`dg_goldens_match_ts_wire_surface_and_gate_labels`, incremental-native differential mode, and the fixture perturbation guard), decay-render goldens, and M3/R2's `r2_review_720_pass_differential_with_new_seeds_and_real_reduce`. The latter exercises the real selection/reduction route and the 720-pass no-rescore matrix, not a rescore-only renderer stub.

I also captured the signed-thinking suites at both product revisions, in **default and strict capture mode**, for **rejected Opus 4.6 and prefix-bound Opus 5.5**. This uses the existing TS/Pi audit test files and Rust `signed_thinking_prefix_audit` integration target. For each revision/model class there were **5,810 files: 2,905 passes per audit mode**, covering all five hosts (OpenCode 1, OpenCode 2, Pi, Rust OpenCode-AI-SDK, Rust Claude Code). The comparator checked matching inventories and **all 11,620 serialized `wireBytes` pairs**, with **zero differences, no exception rules, and no eligibility exclusions**. Eight Rust capture invocations each passed all six integration tests; each TS/Pi capture invocation passed all 142 tests. These are byte-preservation captures: capture mode intentionally disables strict-provider assertions, so this is **not** a claim that every pre-existing strict-thinking scenario is provider-valid.

### Harness limitations and repairs

Baseline source was obtained with local `git archive`, inside this worktree; neither the parent checkout nor a live session database was used. The first remote attempt refused an ignored `.tmp-*` source directory; moving the archive to a non-ignored directory allowed the remote runner to copy it to Linux. The archived store suite initially had 13 `move_inventory` failures because its required local `target/` scratch directory did not exist when the runner supplied a shared Cargo target-dir. Creating that scratch directory and running the archive's frozen-lockfile install eliminated all 13 failures. Base and TS-slice installs each checked 1,010 installs/1,251 packages with no changes.

The first signed capture used Bun path filters without `./`, which also selected the nested base archive and caused duplicate-file `EEXIST` failures. Explicit file paths and a fresh destination produced the complete comparison above. These were harness/setup failures, not slice failures. AFT diagnostics reported zero errors/warnings for the changed Rust test file but a partial call-graph view; compiled tests and Clippy are the authoritative checks.

No paid model calls, schema/epoch product edits, live placement, or service restarts were performed. The copied-binary strip evidence and temporary probe scripts remain in ignored `.tmp-rescore-review/` scratch; the verdict, exact red failure, versions, and gate counts are preserved in this committed report rather than depending on regenerable build output.
