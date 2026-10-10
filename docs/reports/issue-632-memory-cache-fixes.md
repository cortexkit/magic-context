# Issue 632: bounded, coverage-checked native replay

This follow-up keeps invisible folding **opt-in** (`MC_OC2_INVISIBLE_FOLD=1`).
It changes only the OpenCode 2 TypeScript cache/replay lane and tests. There are
no migrations, lockfile changes, or Rust changes. The independent review's three
regression specifications are unchanged.

## Corrections

1. **Explicit raw-row membership.** Replay obtains the host's conversational row
   stamps for the requested interval and checks every required ID against the
   cache, without loading cached message blobs. Neither an admission nor a loaded
   sequence certifies completeness. On a missing ID, replay reloads the whole
   requested `(after, cut.seq - 1]` interval once and replaces its membership.
   It refuses a short authoritative read rather than returning a hole. Other
   cached intervals remain untouched. This includes previously trimmed capture.
   The task giver explicitly selected a whole-requested-interval refill over
   minimal per-row reads, preserving the review's required `(-1,4]` read.

2. **Leading system coordinates.** Id-less leading systems are associated, in
   order, with the systems immediately preceding the nearest following anchored
   row. This uses the native window's structural position, not the first system
   in the entire session. It changes no native message fields or encoded bytes.
   A window with no anchor does not cache ambiguous systems; the incoming draft
   is untouched and hidden rows are later restored from the source. The new test
   inspects capture before replay can repair a missing ID, then compares the
   complete wider prefix, protecting older system bytes as well as the new row.

3. **Finite retention.** The default budget is **16 MiB per session** and **16
   sessions per cache instance**. The accounting charges UTF-16 string sizes plus
   fixed record/map allowances, tail/admission records, source identities, and
   replay row stamps. It is a retained-cache budget, not a process RSS guarantee.
   All operations that use a session pin it until the current operation finishes.
   Inactive sessions over the byte cap are dropped; session-count pressure evicts
   the least recently used inactive session. Eviction also clears replay's
   metadata, loaded sequences, source identity, dirtiness and nomination flags.
   Active operations may transiently exceed the limits, but release enforces them.
   No partial row range is retained as if complete.

An evicted session that fits the budget takes one cold source read and then serves
warm again. A session whose requested history itself exceeds 16 MiB deliberately
remains uncached and reads again on future requests; promising a single read for
such a session would contradict a finite cap. It remains servable and byte-equal.

The older seventeenth-session test now asserts actual eviction. Its source fixture
previously said `served user`, while its capture/expected bytes said `session 0`.
Those fixture source bytes are aligned with capture for all 17 sessions; the
existing byte-equality assertion and test name are unchanged. This is necessary
because real eviction must reload the host, not a nonexistent saved-message file.
No independent-review assertion was edited.

## 25,000-row measurement

Separate Linux/Bun **1.4.2** processes used the review's exact row text:
`"native row N " + "fixed history ".repeat(20)`. The pre-fix cache comes from
`ee4ac9add3a3e3df712378cfe60244b59da5dadd`, materialized inside this worktree.
The fixture was created before the baseline memory sample. Returned messages were
dropped before forced GC; both runs independently verified 25,000 returned rows
and the same full-array digest (`16707074569427528154`).

| Measurement | Before | After |
|---|---:|---:|
| Retained encoded row bytes | 9,552,780 | 0 |
| Retained rows after restore / execution success | 25,000 / 25,000 | 0 / 0 |
| Heap-used increase | 38,035,731 | 19,378,429 |
| RSS increase | 113,950,720 | 115,003,392 |
| Source range reads after two restores | 1 | 2 |

This particular session exceeds the cap. Its retained encoded rows are released,
and the measured heap increase falls by 18,657,302 bytes (49.1%). Peak decoding and
allocator-reserved memory still cost memory; RSS is not reduced in this run. The
measurement is not an isolated allocator proof or a universal per-row multiplier.
The small-session LRU regression separately proves exactly one extra cold read,
then no second read, with unchanged complete JSON bytes.

## Mutation controls

All controls staged the live implementation first, captured a nonempty unstaged
diff during the mutation, restored only that file from the index, touched it, and
captured an empty unstaged diff. No mutation is present in a commit.

- Disable the warm membership predicate: only
  `review632: widening a partially captured range restores missing raw rows`
  fails; the empty-cache/later-cut control passes.
- Select the oldest system for an anchored leading window: only
  `leading systems anchor to the current window without overwriting older native bytes`
  fails. All three unchanged independent-review tests and the unanchored-system
  control pass. Membership repair alone can mask this defect in the original
  narrow-window assertion, which is why the new capture assertion matters.
- Disable session-count eviction: only
  `session-count LRU eviction preserves bytes and adds exactly one cold restore`
  fails; oversized-history servability passes.
- Disable per-session byte eviction: only
  `per-session byte budget releases oversized rows tails admissions and replay metadata`
  fails; the session-count/byte-identity control passes.

## Verification and evidence

The Linux and real-host results below are recorded after running the final gates.
Evidence is kept outside generated build directories. All driver and host roots
are private; hosts are checked with per-incarnation `lsof` inventories before use
and again during shutdown. No live database or configuration is opened, even
read-only.

### Real OpenCode provider bodies

Exact native hosts **2.0.22** and **2.0.24**, Bun **1.4.2**, each pass:

| Scenario | .22 | .24 |
|---|---:|---:|
| Queue checkpoint | 4/4 equal | 4/4 equal |
| Mid-loop steer checkpoint | 4/4 equal | 4/4 equal |
| Host restart after checkpoint | 4/4 equal | 4/4 equal |
| Plugin-only `location.reload()` | 4/4 equal | 4/4 equal |
| Native revert | 4/4 equal | 4/4 equal |
| Forced mid-session LRU eviction | 4/4 equal | 4/4 equal |

All four driver invocations exit 0: two five-scenario matrices plus one eviction
counterfactual per host version. An independent validator rereads **48 distinct
before/after full raw JSON body pairs** and **30 per-incarnation lsof inventories**;
all pairs are equal and every observed `.db`/WAL/SHM path is within its capture root.
The fixture includes real registered tool results, a built-in missing-file error,
PNG, provider-bound reasoning, and literal user `<recent-context>` text. The arms
restore the same stopped private snapshot; provider output IDs and priming output
are fixed. These are not normalized-message or same-file hash comparisons.

The eviction runs use a test-only bundle of this worktree's V2 entry. Instrumentation
exposes cache instances and records evictions/range reads; it does not alter row
encoding or rendering. Before the target context callback, it admits 17 empty
inactive cache sessions to exert real session-count pressure. The target must
already be warm, must actually be evicted, and must record exactly **one** subsequent
restore-range read across the four provider requests. Both versions record
`(-1,139]` once and preserve all four request bodies. This does not use a plugin
reload as a proxy for eviction or inject expected history into replay.

All driver HOME/TMPDIR/XDG/storage roots and host roots are beneath:

`/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/bg_4138ba024112c5b7/`

The runner requires the selector `OPENCODE_DB=opencode2.db`; each host's physical
DB is its private `XDG_DATA_HOME/opencode/opencode2.db`. Driver and Linux gates
unset `OPENCODE_DB`. Hosts use `--standalone`, no ambient plugins and private
configuration. An initial invocation was rejected **before host spawn** because
its noncanonical `/var` root failed the storage containment guard; canonicalizing
the task root resolved it. No isolation guard was disabled or weakened.

Retained local evidence: `evidence/body-lsof-validation.json`, `host22.log`,
`host24.log`, `eviction22.log`, `eviction24.log`, copied worktree-bound `host.ts`,
`build-host.ts`, memory probe source, gate/mutation logs, and failure-name summaries.
The four completed captures are `hosts/capture-1791579329092`,
`capture-1791579415137`, `capture-1791579431815`, and `capture-1791579437125`.
Raw provider bodies, private fixture stores, and inventories remain in those
captures. No source or product import points to the earlier review worktree.

### Linux package gates

All Linux jobs use private HOME/XDG/storage roots and `OPENCODE_DB` unset; none
falls back to macOS. Builds and tests run in background jobs awaited with
`bash_watch`. The local build is solely to supply bundles to the exact installed
macOS host binaries; a separate Linux build is the package gate.

- `bun run --cwd packages/plugin typecheck`: **passed**, TypeScript **5.9.3**,
  covering the plugin, retina build tsconfig, and plugin scripts tsconfig.
  TypeScript is silent on success; exit 0 is the result.
- `bun run build`: **passed**, Bun **1.4.2**; main plugin/V2/Pi/CLI bundles report
  **697 / 742 / 1,000 / 406 modules**. TUI generation checks 9 files, writes none.
- `bun run --cwd packages/plugin lint`: **passed**, Biome **2.5.1**, **1,329 files**,
  no errors, 10 existing warnings and 6 infos. Scoped `biome check` of the five
  changed TypeScript files also passes, with no warnings.
- `bun test packages/plugin/src/v2/fold --timeout 30000`: **81 pass, 10 skip,
  0 fail**, 91 tests / 13 files, 254 assertions. The independent-review file remains
  byte-identical to the task base.
- Full plugin suite, `bun run --cwd packages/plugin test`: **7,496 pass, 19 skip,
  34 fail**, 7,549 tests / 748 files, 218,398 assertions.
- Pristine `d55b44bcc713fe69f28ab98fe3396a7b74a4cf17` is materialized by `git archive`
  inside this worktree, frozen-installed (1,010 installs / 1,251 packages, no
  changes), built on Linux, then tested with the identical package command:
  **7,451 pass, 9 skip, 33 fail**, 7,493 tests / 738 files, 218,252 assertions.
- Exact full-suite failure-name comparison: **33 shared, no master-only**, and
  one branch-only timing failure:
  `slow embedding aborts at the deadline, freezes skip bytes, and cannot land late`.
  This unchanged test passes in isolation on **both** trees (1 pass, 0 fail,
  6 assertions each). The full suite is not reported as green or the timing failure
  silently subtracted. The review's original two branch-only failures are gone.
- AFT inspection is **partial**, with unavailable call-graph/Biome producers and
  an incomplete TypeScript snapshot; it is not substituted for package gates.

The Linux runner's final typecheck job succeeded but its subsequent build log
redirection failed because the expected temporary gate directory was absent.
The build/lint/full-suite chain was then run with explicitly created private
roots and succeeded through build/lint, producing the baseline-described suite
failure set above. There was no local fallback. Captured stdout/stderr and
summaries are retained under the local evidence directory, outside build output.

A live Rust/module-engine host was not rerun. The raw-range correction is exercised
by the unchanged trimmed-capture specification and the fold/boundary regressions;
the real-host matrix is the TypeScript lane. Arbitrary provider-native checkpoints
and all retry/engine combinations are not inferred from this small rich-history
fixture.

To reproduce the host checks, copy the retained `host.ts` into this worktree and
resolve `@opencode/client` from `packages/plugin/node_modules`; rebuild the local
plugin first. Give the driver private HOME/TMPDIR/XDG/storage roots under a fresh
`MC_TASK_ROOT`, unset driver `OPENCODE_DB`, set `MC_OC2_INVISIBLE_FOLD=1`,
`MC_E2E_FOLD_EXPECT_IDENTITY=1`, and select
`MC_REVIEW_SCENARIOS=queue,steer,restart,plugin-restart,revert`. Point
`MC_E2E_OPENCODE2_CLI` to the exact .22 or .24 binary. For eviction, run the retained
`build-host.ts`, select `MC_REVIEW_SCENARIOS=eviction`, and set
`MC_E2E_FOLD_BASELINE_PLUGIN` to its private `instrumented-product` directory.
The test-only build's dependency link must resolve to this worktree, not another
checkout. Retained mutation logs name the single failing control and passing
controls for each red run. The final restored-code fold gate is rerun and passes
with the same 81/10/0 totals.
