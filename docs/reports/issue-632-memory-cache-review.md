# Issue 632: independent memory-cache correctness review

Reviewed **`b3e3c1bab508426f8c32334865031dc2e319dbd9`** against master
**`d55b44bcc713fe69f28ab98fe3396a7b74a4cf17`**. This review changes no product
code. The accompanying `memory-cache-independent-review.test.ts` deliberately
retains failing specifications; it is not a green regression suite.

## Verdict

**Not a general cache-correctness proof, and not ready for default-on rollout.**
The real-host TypeScript rich-history comparisons described below preserve complete
provider request bytes across the exercised queue, steer, host restart, plugin
reload and revert paths. Two additional class-level specifications expose missing
coverage validation and ambiguous id-less coordinates. Their production
reachability is narrower than their unit-test evidence: the range hole matters
when capture has been trimmed, particularly the Rust lane; the coordinate case
requires a captured window to start with an unanchored system row. Neither is
claimed as a reproduced ordinary TypeScript host failure. There is also **no
finite cache budget or inactive-session eviction**.

**This feature is NOT on for every OpenCode 2 user.** Both replay and automatic
nomination require `MC_OC2_INVISIBLE_FOLD=1`, and compaction must not be disabled
(`v2/hooks/context.ts:617–625`). With the flag absent, the new cache is not created.
The automatic threshold is 1,000 stored rows; `MC_OC2_HOST_FOLD_ROWS=0` disables
nomination but leaves opt-in replay of manual folds enabled. OpenCode 1 and Pi do
not acquire this cache.

| Area | Verdict | Evidence / limitation |
|---|---|---|
| Byte identity | Pass for the tested real-host TS fixture, not universal | Complete raw JSON bodies, native tool success/error, PNG, provider reasoning and literal user recent-context text; exact hosts 2.0.22 and 2.0.24. No Rust engine or unusual media/provider-native checkpoint proof. |
| Activation, duplicate/order safety | Opt-in; tested ordinary ordering passes; conditional coordinate defect | The local checkpoint message is removed as a row, including its entire host recent block. Literal user text remains. Hidden records sort by sequence. See finding 2 for windows starting with an id-less system. |
| Restart restore | Cold restore mechanism passes; raw-range coverage is not certified | A fresh cache reads `(-1, cut.seq - 1]` once, filters conversational rows, then serves memory. A real-host control advances the cut during plugin downtime and verifies that the later hidden range is recovered. A high-water mark alone is insufficient for partially captured ranges (finding 1). |
| Never refuse a servable turn because of cache | No new cache-caused refusal reproduced; silent loss is possible | Optional capture catches failures; thrown restore errors use `restoreRead`. An absent cached row does not itself throw or trigger that fallback (finding 1). |
| Memory bound/lifecycle | No budget; deletion cleanup exists | Measured 25,000 rows; ordinary execution completion retains them. `forget` clears rows/tails/admissions and replay bookkeeping. No LRU, byte cap or session-count cap. |
| Incoming edits/revert | Existing supported tests pass; real revert compared | Same-id capture replaces encoded bytes, replay returns detached copies, revert events invalidate membership. Direct out-of-band SQL edits are outside the stated contract and were not tested as supported edits. |
| Other hosts | Source fence and targeted behavioral differential | OpenCode 1/shared implementation and Pi source are identical to master. Identical existing marker tests are run in both trees with the opt-in flag set. |

## Findings, ranked by potential user impact

### 1. Required raw rows can be absent without a restore read (high, conditional)

**Failing test:** `review632: widening a partially captured range restores missing raw rows`.

The fixture has authoritative rows `u-covered@1` and `u-tail@4`. Capture receives
only `u-tail`. In Rust mode, the adapter removes messages before the module's
recorded summary boundary before it captures native input; covered earlier rows
can therefore be absent from capture. Supply answers
`cut@5`. A later unbounded request (`after: -1`) should restore both rows; it returns
only `u-tail`. The sole admission-time range read is `(4,4]`; no missing-prefix read
occurs. Expected IDs are explicit fixture facts, not computed through replay.

Cause: `capture` sets `loaded` to the maximum captured sequence
(`native-replay.ts:158–169`). `supply` reads only after that watermark, then marks
the latest sequence loaded (`:196–212`). `restore` checks dirtiness, a watermark
and admission existence, not range membership (`:235–264`). `storage.rows` simply
returns whatever records exist (`memory-cache.ts:79–84`), so a hole is a successful
short array, not a cache error. The context catch/fallback at `context.ts:1820–1832`
is consequently never entered.

The production adapter copies input **after** `trimToRecordedBoundary`
(`context.ts:1949–1972`). The ordinary full native TS capture normally retains old
raw rows, so this is not evidence that the exercised TS queue path drops history.
A legitimate widening/recovery that needs rows before a previously captured Rust
boundary has no completeness check in this cache. A cold restart happens to repair
this fixture, demonstrating that warm and cold results can differ. Real Rust
engine reachability and the module's independent stored-history behavior remain
unverified; do not claim a real Rust refusal from this class test alone.

Required resolution: certify the cached interval needed by the caller, or read
missing rows when coverage widens. A maximum sequence or an admission is not a
certificate that the earlier range exists. Also prove this through the actual
Rust/shared rebuild path before treating that lane as covered.

### 2. A leading visible system row can overwrite an older system's coordinate (medium, conditional)

**Failing test:** `review632: post-checkpoint id-less system stays at its current source row`.

Capture `sys-old@1` and `u-old@4`, supply a cut, then capture a new visible window
`[system("new instruction"), u-new@7]`; authoritative `sys-new` is at sequence 6.
Supply the next cut at 8. Restoring after sequence 4 should return `sys-new, u-new`;
it returns only `u-new`. The new system was stored against `sys-old@1`, replacing
the old instruction's bytes. Restoring the wider prefix would put the new text at
the old instruction's position instead.

Cause: `records` starts `cursor = -1` and assigns an id-less system to the first
system stamp after that cursor (`native-replay.ts:128–140`). It does not establish
where a fresh, id-less visible window begins. The reader's metadata includes
systems before the checkpoint. Incoming id-bearing rows or already-restored rows
with attached coordinates can anchor the cursor correctly; this test intentionally
exercises the missing-anchor case.

**Reachability qualification:** the real context hook prepends hidden replay before
capture. If that prefix always contains an id-bearing/coordinate-bearing row after
the old system, this class defect is not reached. The test is not a real-host
AGENTS.md reproduction, and is not evidence that every instruction update loses
rows. The adapter needs either a demonstrated invariant excluding this input or a
non-ambiguous association with the host's current window. OpenCode genuinely uses
id-less system carriers for instruction updates; the existing host-row boundary
fixture documents that representation, so IDs cannot simply be assumed present.

### 3. Cache retention is unbounded until deletion/disposal (medium, demonstrated)

`NativeFoldCache` has three unrestricted per-session maps; replay additionally
retains row metadata, loaded watermarks and source identities. `saveTail` upserts;
`truncate` removes only rows later than a supplied sequence. Neither drops old
covered rows or inactive sessions (`memory-cache.ts:31–35,44–84`). The historical
"16 entries" description in the design's historical prototype section does not
describe this implementation. The seventeenth-session historical test does not
assert an eviction and therefore is not evidence of a bound.

A Linux/Bun 1.4.2 measurement cold-restored 25,000 native user rows, each with
`"native row N " + "fixed history ".repeat(20)`. After dropping the returned decoded
array and forcing GC:

* Encoded row strings: **9,552,780 bytes** (9.11 MiB), excluding IDs, record/map
  overhead, digests, metadata, native source fixture and temporary decoded copies.
* Heap-used increase relative to the already-created fixture: **38,030,184 bytes**;
  RSS increase: **69,873,664 bytes**. These are illustrative process measurements,
  not a universal per-row multiplier or an isolated production cache allocator.
* After an ordinary execution-success event: **25,000 records still retained**.
* After `replay.forget("s")`: **0 records**, tail/admission state cleared. RSS stayed
  allocated, which is not proof that deleted rows remain reachable.

The context subscriber explicitly calls `forget` on `session.deleted`
(`context.ts:1242–1263`). Ordinary turn/session inactivity does not release cache
entries; an execution ending is not a deletion. Process/plugin disposal releases
its owner through ordinary lifetime/GC. There is no separately implemented
session-end eviction or enforceable memory budget. More sessions, larger tools or
media payloads increase retained memory without a ceiling. A bounded disposable
cache could evict safely to the cold restore path, but that policy is absent.

## Earlier defect classes

The persisted-message cache and its migrations/tables/files are gone. Durable
snapshot corruption, competing process writes to one recovery record,
lease/promotion/tombstone races and deletion of persisted native bytes have no
corresponding storage surface here. Independent plugin instances have independent
maps. This review does not modify any existing regression assertion to accept
previously incorrect output.

The remaining relevant classes are **raw-range loss**, **id-less source
association**, **media/native-renderer fidelity**, **mutation/revert membership**,
**optional capture/fallback servability**, and **retention**. Existing tests cover
bytes-backed media and bindings, detached message-level metadata/nested arguments,
newest-assistant replacement, repeated replay after a supported revert, reader
identity and busy optional capture. Their passing fixture cases do not establish
range completeness or a capacity policy. Unsupported direct hidden-user SQL edits
are not counted as fixed freshness defects, nor reintroduced as supported edits.

## Real OpenCode 2 checks and isolation

The reviewer independently ran the native provider-body probe identified in
`docs/reports/issue-632-memory-cache.md`, copied to
this worktree with every source/product import redirected here, against the newly
prepared local plugin bundle. No other worktree source was executed. The extended
probe uses `location.reload()` for a plugin-only restart and native
`session.revert.stage` / `commit` for reverts. Revert anchors must come from the
shared stopped-host snapshot, not each arm's newly generated priming user ID.

Each counterfactual restores the **same stopped private state** before each arm;
priming response IDs and model/tool outputs are fixed. The comparison is of complete
raw provider JSON entity bytes, not normalized messages, computed renderer output,
consecutive different conversations or m[0] hashes. Four provider calls per arm
include three real registered tool executions. The fixture additionally includes a
real built-in missing-file error, PNG attachment, provider-bound reasoning and
literal user `<recent-context>` text. Historian/dreamer/embeddings/memory/temporal
features are disabled and `cache_ttl: "never"` denies an expiry-based rewrite.

All driver and host HOME/TMPDIR/XDG/config/data/state/runtime roots and Magic Context
storage paths share the following task-specific temporary-directory ancestor:

`$TMPDIR/magic-context/bg_bf0ae7e48a6eac48/`

The runner requires the literal selector `OPENCODE_DB=opencode2.db`, whose physical
path is each capture's private `XDG_DATA_HOME/opencode/opencode2.db`; it is not a
live DB path. Driver/plugin suite commands unset `OPENCODE_DB`. Hosts use
`--standalone`, private working directories and no ambient default plugins.
Per-incarnation `lsof -p <pid>` inventories were saved before use; runner shutdown
checks inventories again and rejects outside DB/config paths. No live OpenCode or
Magic Context database/config was opened, even read-only. Fixture host rows came
only from native APIs, not projection SQL. The sole diagnostic SQL read was of a
**stopped throwaway store** to explain an invalid mock compaction response.

The stopped-store diagnostic showed `Compaction summary did not match the required
template` for an early moved-cut attempt: the default mock text was not a valid
host summary. The final moved-cut control disables Magic Context through a plugin
reload, admits an actual user/assistant exchange, and lets a **test-only compaction
hook** supply a valid summary. It verifies a newer completed cut, then reloads
Magic Context with an empty cache and compares against the same history with no
cut. The test-only hook supplies an arbitrary checkpoint summary, not restored
history or the expected target request. Equality therefore still depends on Magic
Context recovering and transforming the actual native rows after reloading.

### Provider-body results

| Scenario | OpenCode 2.0.22 | OpenCode 2.0.24 |
|---|---:|---:|
| Idle native queue fold | 4/4 equal | 4/4 equal |
| Mid-loop native steer fold | 4/4 equal | 4/4 equal |
| Fold then host restart | 4/4 equal | 4/4 equal |
| Fold then plugin-only `location.reload()` | 4/4 equal | 4/4 equal |
| Fold then native tail revert, versus the same revert without fold | 4/4 equal | 4/4 equal |
| Newer cut after a real conversation while Magic Context is down | 4/4 equal | 4/4 equal |

**48 scenario/version-specific comparisons pass.** An additional original .22
queue/steer/restart matrix adds 12 duplicate comparisons: **60 saved byte pairs**
were independently reread and checked, along with **55 lsof inventories**, including
incarnations from discarded setup attempts. All observed `.db`/WAL/SHM paths are
under their capture root. The original .22 automatic-threshold control also
completed one queue fold with no extra provider request and one completion log.
The independently run .24 matrix proves manual queue/steer admission, not a separate
.24 automatic-threshold control.

Queue/steer/restart/plugin-reload bodies in the extended fixture are 43,441–44,074
bytes on .22 and 43,448–44,081 on .24. Revert bodies are 42,901–43,534 / 42,908–43,541;
moved-cut bodies begin at 43,772 / 43,779 bytes. These small rich-history runs are
not an independent repeat of the implementation report's native 25k-row timings.
The 25k memory measurement above is a separate synthetic cache experiment.

Some extended driver invocations exited before their final aggregate assertion:
first because a revert used an arm-specific generated ID, then because the moved
cut's mock summary was invalid. Their already-written queue/steer/restart/reload
and corrected revert pairs were subsequently checked by an independent raw-file
validator. They are not reported as whole green driver invocations. The final
moved-cut invocations themselves exited 0 on both exact host versions and asserted
a newer completed checkpoint and all four equal bodies.

### Durable evidence locations and reproduction

Evidence is outside `dist`, `target`, `node_modules` and other regenerable build
output. The following machine-specific local directory contains the capture
inventories, provider bodies, driver source and saved Linux gate output listed below:

`/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/bg_bf0ae7e48a6eac48/`

* `independent-body-lsof-validation.json`: independently checked pair paths,
  byte sizes, PID inventories and private DB paths.
* `host22-extended/` and `host24-extended/`: queue, steer, host restart and
  plugin reload bodies, traces, private stores and lsof inventories.
* `host22-revert-moved/` and `host24-revert-moved/`: corrected real revert pairs.
* `host-2.0.22-moved-valid/` and `host-2.0.24-moved-valid/`: successful advanced-cut
  controls with Magic Context disabled and reloaded.
* `host22/`: original 12-pair .22 matrix and automatic folding control.
* `review-probes/`: the final worktree-bound native probe, memory measurement
  source and retained gate summaries.

To rerun the native probe, place a copy inside the reviewed worktree, resolve its
`@opencode/client` import using that worktree's prepared plugin dependencies, and
run with a private driver HOME and all XDG/storage roots under a new task directory.
Set `MC_OC2_INVISIBLE_FOLD=1` to enable the experimental cache/fold lane and
`MC_E2E_FOLD_EXPECT_IDENTITY=1` to assert complete request equality. Set
`MC_E2E_OPENCODE2_CLI` to the exact .22 or .24 executable. `MC_REVIEW_SCENARIOS`
selects comma-separated `queue,steer,restart,plugin-restart,revert,moved-cut`.
Do not run a copied serve command in an ambient environment or reuse the operator's
stores. The probe itself derives and checks the host's narrower private root.

The deliberately failing regression specifications are reproducible with private test roots and
`OPENCODE_DB` unset:

```sh
bun test packages/plugin/src/v2/fold/memory-cache-independent-review.test.ts --timeout 30000
```

Bun 1.4.2: **1 pass, 2 fail, 6 assertions, 3 tests / 1 file**. The passing control is
`review632 control: an empty cache follows a later host cut exactly once`, asserting
both IDs, the exact `(-1,7]` range, and no second restore read. No product mutation
was introduced to make either negative specification fail.

## Gates

All package gates below run on Linux with private HOME/XDG/storage roots and
`OPENCODE_DB` unset. No Linux gate fell back to macOS. Native host matrices run
locally because they execute the exact preinstalled macOS hosts and the local
prepared plugin bundle. The prepared worktree's `bun run build` had already exited
0; a Linux branch build is additionally used before the final suite comparison.

* Plugin typecheck: `bun run --cwd packages/plugin typecheck` **passed**,
  TypeScript **5.9.3**, including the plugin, retina build tsconfig and plugin
  scripts tsconfig. `tsc` is silent on success; exit status was 0.
* Scoped lint: from `packages/plugin`,
  `node_modules/.bin/biome check src/v2/fold/memory-cache-independent-review.test.ts`
  **passed**, Biome **2.5.1**, **1 file checked**.
* Automated file-tool (AFT) code inspection was **partial**, not a clean diagnostic proof: the checkout call
  graph was unavailable and its Biome producer reported unavailable. The package
  typecheck and scoped project Biome invocation above are the authoritative checks.

* `bun run build`: **passed** on Linux, Bun **1.4.2**. Main bundles reported
  **697 / 742 / 1,000 / 406 modules** for plugin union/V2, Pi and CLI respectively;
  TUI generation checked **9 files**, wrote none. No manifest or lockfile changed.
* Pristine master was materialized by `git archive` **inside this worktree**, with
  the identical lockfile/toolchain and private roots. Its frozen install checked
  **1,010 installs / 1,251 packages, no changes**, and its Linux build passed before
  the baseline suite.
* Final built-branch plugin suite (`bun run --cwd packages/plugin test`):
  **7,486 pass, 19 skip, 36 fail; 7,541 tests / 746 files; 218,358 assertions**.
* Built pristine master, same command: **7,451 pass, 9 skip, 33 fail;
  7,493 tests / 738 files; 218,252 assertions**. The exact name comparison in
  `review-probes/failure-name-comparison.json` has **33 shared failures**, no
  master-only failures, and these **three branch-only names**:
  * `review632: post-checkpoint id-less system stays at its current source row`
  * `review632: widening a partially captured range restores missing raw rows`
  * `sqlite writer diagnostics > a writer that waited for the lock reports the wait, not its short hold`
* The first two branch-only failures are the intentionally committed evidence.
  The unchanged writer-timing test passed in isolation on **both** trees:
  `bun test packages/plugin/src/shared/sqlite-writer-diagnostics.test.ts -t 'a writer that waited for the lock reports the wait, not its short hold' --timeout 30000`:
  **1 pass, 0 fail, 5 assertions each**, Bun **1.4.2**. Its full-suite failure is
  recorded, not silently subtracted from the count. The suite is not wholly green.
* An earlier branch invocation had not rebuilt its bundles on Linux; it produced
  nine additional worker-bundle failures absent from the built master run, plus a
  slow-embedding deadline failure. After the Linux branch build, all nine bundle
  failures disappeared; the slow-embedding name also did not fail in the final
  suite. The initial output is retained, but is not the authoritative built-branch
  comparison. No product source or existing expected value changed between runs.

### OpenCode 1 / Pi differential

The Git diff of `packages/pi-plugin`, OpenCode 1 `packages/plugin/src/hooks`, shared
features and `packages/plugin/src/shared` between master and the reviewed commit
is empty. The new adapter/cache imports are under `v2`. In separate Bun processes,
with `MC_OC2_INVISIBLE_FOLD=1` set to catch accidental cross-host activation:

* `bun test packages/plugin/src/hooks/magic-context/compaction-marker-manager.test.ts --timeout 30000`:
  **24 pass, 0 fail, 85 assertions** on each tree.
* `bun test packages/pi-plugin/src/marker-drain-wire-stability.test.ts --timeout 30000`:
  **1 pass, 0 fail, 16 assertions** on each tree.

Exact selected test names and failure sets are identical between trees. An initial
combined invocation loaded Pi's write guard into the same process as OpenCode 1,
producing the same 17 OpenCode marker failures in both trees; separating host
processes removes that test-environment collision. This is a targeted behavioral
and source differential, not a full live Pi/OpenCode 1 provider matrix.

## What remains unproven

* A real Rust/module-engine run that widens a formerly trimmed captured interval;
  the native replay range hole is a failing class specification, not that host run.
* Whether ordinary hook inputs can begin with the unanchored system shape in
  finding 2; hidden replay normally supplies earlier coordinates. This uncertainty
  is why the finding is explicitly conditional rather than a claimed real-host
  instruction-loss reproduction.
* Arbitrary media/provider-native checkpoints, all LKG/retry/generate paths,
  pending mutations and historian publications during compaction. No success of
  those combinations is inferred from the small rich-history matrix.
* A byte/session budget and inactive-session eviction policy. Deletion cleanup
  exists, but it does not bound a live long-running plugin instance.

The appropriate merge decision is narrower than “all historical defects fixed”:
retain the explicit experimental opt-in, resolve or constrain partial-range replay,
establish the id-less-window invariant, and specify a memory budget before calling
this cache generally safe. No new product code was changed to hide these gaps.
