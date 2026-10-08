# Independent adversarial review: fold/refresh render lock split

**Reviewed revision:** `9cbb1dff3076665ea43660400e0ed0bf08192fb4`, branch
`alfonso/task/bg_86a62e7e608bf5da-fold-write-lock-held-9-3-s-render-m-1-and-fold-c`.
The review ran against that exact tree, not a merge approximation. Its parent is
`77a73237bf2cd6c42fce93d27b98f6ca4af0e19e`.

**Merge verdict: REQUEST CHANGES.** The lock shortening is structurally real and
the ordinary addition CAS and legacy-tag validation work. However, the new m[1]
CAS does not cover all renderer inputs. Real two-connection WAL fixtures persist
stale selections, stale compartment ranges and stale temporal headings, and Pi
also uses the wrong expiry cutoff for its new delta CAS. Resolve findings 1–4
before treating this as a cache-safe, behavior-preserving refactor. Findings 5–6
are inherited manifest defects, not regressions introduced by this commit.

This is a **report-only** delivery. No product code, repository tests, manifests,
ARCHITECTURE.md or STRUCTURE.md are changed. The independent tests executed as a
scratch file; their full source is retained below so the counterexamples can be
reproduced without keeping that file in the product tree.

## Isolation and verification

All fixture databases, HOME, XDG homes, runtime/storage directories and temporary
files were under `${TMPDIR}/magic-context/bg_21ecce0dbbd1ef0e/`. Package tests ran
with `OPENCODE_DB` **unset**, HOME redirected, and TMPDIR redirected into that
root before loading the repository test preload. No live store was opened, read
or written. The standalone differential driver alone required `OPENCODE_DB`;
it pointed to a nonexistent throwaway host file below its fresh root. The
driver's `lsof` checks independently listed only its throwaway SQLite stores.

Tools: **Bun 1.4.2 (744846f84)** and repository-local **TypeScript 5.9.3**.
The documentation inspection was partial because Markdown has no registered LSP
producer; it was not counted as a clean diagnostics result. A Python 3.9.6
one-comparison check confirmed the appendix exactly matches the executed scratch
source, and `git diff --check` found no whitespace errors.
Commands below were executed at the reviewed revision with the isolated
environment described above:

| Check | Result |
| --- | --- |
| In `packages/plugin`: `BUN_JSC_useOMGJIT=0 bun test --timeout 30000 src/hooks/magic-context/inject-compartments.test.ts src/hooks/magic-context/transform-postprocess-phase.test.ts src/hooks/magic-context/apply-operations.test.ts src/shared/fold-render-lock-fence.test.ts src/shared/write-transaction-timing.test.ts` | 358 passed, 0 failed, 5 files |
| In `packages/pi-plugin`: `BUN_JSC_useOMGJIT=0 bun test --timeout 30000 src/inject-compartments-pi.test.ts` | 72 passed, 0 failed |
| `bun run --cwd packages/plugin typecheck` | Passed: retina build tsconfig, plugin `tsc --noEmit`, scripts tsconfig |
| `bun run --cwd packages/pi-plugin typecheck` | Passed: retina build tsconfig and Pi `tsc --noEmit` |
| `BUN_JSC_useOMGJIT=0 bun test --tsconfig-override packages/pi-plugin/tsconfig.json scripts/fold-render-review.test.ts` | Final scratch run: 14 passed, 0 failed, 53 assertions |
| `bun --tsconfig-override packages/pi-plugin/tsconfig.json scripts/fold-lock-fixture.ts` | All 6 output hashes, 6 complete session_meta hashes and 6 tag-manifest hashes matched the checked-in, independently captured pre-change baseline |
| Restored control: plugin `bun test .../inject-compartments.test.ts -t 'two connections retry a fold'` | 2 passed, 0 failed |

The scratch tests deliberately **assert the counterexamples** (stale persisted
bytes differ from a fresh render), rather than pretending they are passing safety
regressions. Four other assertions establish the positive controls: tag retry,
OpenCode expiry rejection, and both hosts' actual image-bearing defer replay.
The fresh-render comparisons use the same baseline watermark/cutoff and the
actual persisted `cached_m1_bytes`; they do not reconstruct expected bytes from
the CAS probe. The candidate tests independently require A absent/B present in
the fresh render and the reverse in the persisted buffer.

One incorrectly ordered invocation, `bun --tsconfig-override ... test ...`, ran
the root package **test script** instead of the selected scratch test. Its plugin
leg completed with 7,274 pass, 6 skip and one unrelated failure,
`non-budget verification rejects a 2/22 manifest`. This was not counted as a
review gate, and no unrelated test was changed. The corrected `bun test
--tsconfig-override ...` command selected only the scratch file. Preliminary
scratch runs also exposed fixture mistakes (missing non-null FTS rowid and using
a nonexistent camel-case meta property); these were corrected to use the real
timestamp helper and raw `session_meta.memory_block_ids`. Bun printed a
nonfatal “directory mismatch” warning for the Pi tsconfig override; selected
tests and differential completed normally. No full build or Rust suite was
rerun: this delivery changes documentation only, and Rust is outside the changed
implementation. The prepared-worktree build was not used as proof for the target.

## Findings

### 1. Medium, merge-blocking: memory selection inputs are invisible to both delta CASes

`renderM1WithMetadata` at `inject-compartments.ts:2946–3015`, and its Pi counterpart
at `inject-compartments-pi.ts:2082–2156`, select new memories through
`trimMemoriesToBudgetV2`. `memory-selection.ts:22–43` ranks permanent status,
importance, then `max(last_seen_at, verified_at)`. Neither OpenCode's
`MarkerChangeProbe` nor Pi's `renderSnapshotIsCurrentPi` compares importance or
reinforcement timestamps.

These are ordinary writes, not invented out-of-band corruption:
`setMemoryClassification` changes importance without an epoch/log bump;
`dreamer/classify.ts:750–768` invokes it under the lease writer. Exact-dedup
observation calls `updateMemorySeenCount`, also without a render mutation cursor.
`ctx_memory`, durable historian fact promotion and `insertMemoryIdempotent` use
that reinforcement path. Verification timestamps are another selection input;
the independent executable control used `last_seen_at`, not a verification mock.

**Evidence:** four named scratch tests, one for each host × importance or
reinforcement. Start with an empty baseline and two equally sized new memories.
The m[1] budget admits exactly one. Read-render chooses A. On the second
connection, after rendering and before writer admission, raise B's importance
or reinforce B. The refresh commits without retry, its stored bytes contain A
and not B, and a fresh render with the same baseline contains B and not A:

```text
REPRO OpenCode importance: stale=A fresh=B writerAdmissions=1
REPRO OpenCode reinforcement: stale=A fresh=B writerAdmissions=1
REPRO Pi importance: stale=A fresh=B writerAdmissions=1
REPRO Pi reinforcement: stale=A fresh=B writerAdmissions=1
```

The printed `writerAdmissions=1` label counts the pre-admission test-hook
invocation; the successful refresh and persisted-buffer assertions establish
that it committed. Actual `.exec("BEGIN IMMEDIATE")` counts are instrumented
separately in the defer controls below.

Classification remaining cache-neutral on a **defer** is intentional. That does
not make it irrelevant to a **newly rendered** budget-bound m[1]. Previously the
m[1] read-render and persist were serialized by the writer; moving that render
out introduces this unchecked interval. The analogous m[0] selection-freeze
limitation existed already and is not attributed to this change.

**Requested resolution:** validate a selection-input revision/fingerprint for the
eligible new-memory set (including contenders trimmed out), or explicitly obtain
approval for this weaker snapshot policy instead of claiming commit-time parity.
Do not make every classification hard-bust defers to fix a delta CAS.

### 2. Medium, merge-blocking: in-place compartment rewrites bypass both delta CASes

Both CASes compare max sequence and m0 mutation cursor, but neither compares
`compartment_history_versions`. The installed v93 triggers increment that
revision on every compartment insert, update or delete. A rewrite need not
change max sequence, legacy state or end-message id.

A concrete production writer is `recoverUnresolvedCompartments` in
`store-generation-rebase.ts:1140–1242`. Its immediate transaction updates
`start_message`, `end_message` and `rebase_status` without appending an m0
mutation or clearing the cached pair. These fields affect rendered headings.
The broader coordinate rebase also clears cached bytes, but a HARD fold has no
cached-row CAS; the preserved m[0] stale check does not cover this revision
either. Normal recomp helpers that append m0 mutations are protected; this is
not a claim that recomp's existing log path is broken.

**Evidence:** the scratch test named
`<host>: second-connection compartment recovery commits stale m1 ranges despite a history revision`
uses the real recovery helper on connection two. The rendered compartment's
anchors recover to ordinals 3–4 after m[1] rendering. The history revision moves
2→3, but both refreshes commit the old heading; a fresh render contains `## 3-4`.

```text
REPRO OpenCode ranges: persisted lacks 3-4, fresh=3-4, historyVersion=2->3
REPRO Pi ranges: persisted lacks 3-4, fresh=3-4, historyVersion=2->3
```

**Requested resolution:** include the existing history generation/revision in
the read-render and writer validation, or a semantic revision covering the same
render inputs. Max sequence alone is an append watermark, not a content CAS.

### 3. Medium, merge-blocking: OpenCode temporal headings have no timestamp CAS

`withCompartmentDates` (`inject-compartments.ts:2109–2157`) reads
`message_fts_rowid_map.message_time_ms` and may fall back to the host message DB.
No timestamp revision/value is in the delta probe. The deferred context-store
transaction cannot freeze the separate host DB either.

**Evidence:** `OpenCode: second-connection timestamp backfill persists a stale m1 date`
seeds null indexed timestamps, renders a new compartment, then calls
`recordIndexedMessageTime` on the second connection before admission. That is
the same null→time update used by indexing/backfill; the real background
backfill writer is in `message-time-backfill.ts:134–155`. The commit keeps an
undated heading although the now-current render contains `2025-01-01`.
No live host DB or host-message rewrite was needed for the counterexample.

**Requested resolution:** validate the resolved temporal input snapshot or a
timestamp revision, including the fallback's resolved values where applicable.
If date availability is deliberately frozen independently of the commit store,
document/approve that exception to the claimed CAS contract. The old off-lock
m[0] date-read limitation also predates this refactor.

### 4. Medium, merge-blocking: Pi's new additive CAS uses wall-clock expiry, not the render cutoff

`readRenderSnapshotPi` uses `readCurrentMarkers`, which calls
`getMaxMemoryIdForProjects` without the expiry-cutoff argument
(`inject-compartments-pi.ts:1006–1014`). That helper defaults to live `Date.now()`.
The renderer instead uses `markers.materializedAt` (`:2088`, `:2096`). The writer
probe uses another live clock reading. OpenCode passes the fixed render timestamp
to both probes (`readRenderSnapshot` and `m1SnapshotIsCurrent`). Therefore the
worker report's “Memory expiry uses the same cutoff for both delta probes” is
not true for Pi relative to the bytes being rendered.

**Evidence:** two-connection deterministic clock test. Baseline cutoff is 1000;
m[1] read-render is at 2000. After rendering, connection two inserts a memory
expiring at 2500, and admission occurs at 3000. It is eligible for m[1]'s frozen
1000 cutoff but invisible to the writer's current-time MAX(id). Both Pi probes
see zero, so it commits an empty delta. A fresh Pi render with the same baseline
includes the memory. The identical OpenCode control rejects the snapshot.
This is a clock/eligibility boundary test, not a claim that normal TTLs are 500 ms;
any deadline crossed in that interprocess interval creates the same predicate
mismatch. No wall-clock sleeps or asynchronous timer races are involved.

**Requested resolution:** thread the renderer's cutoff through Pi's read and
writer probes. Do not substitute the delta read's wall-clock time for the cached
baseline cutoff on soft refresh.

### 5. Medium, inherited: OpenCode forced m[1] memories are missing from the visible manifest

`renderM1WithMetadata:3012–3061` renders `deltaMemories`, which includes forced
supersede/visibility replacements. Its returned `renderedMemoryIds` includes only
`trimmedNewMemories`, not the forced entries. `softRefreshCachedM1:3283–3289`
therefore omits those entries from the otherwise atomic visible-id union.

**Evidence:** `OpenCode: forced replacement in m1 is absent from memory_block_ids`.
The baseline watermark covers IDs 1 and 2 but its budget selected only ID 1.
Connection two supersedes 1 by eligible 2 and appends the real mutation row.
The refreshed persisted body contains `#2: replacement B`, while the raw manifest
remains `[1]`. A manifest used to hide already-visible memories and report the
injected count no longer describes the full served pair.

This return-value omission is unchanged from the parent implementation. It does
not invalidate the no-contention differential, which faithfully preserves the
defect. Track a separate manifest fix; do not quietly broaden this report-only
review into a product patch.

### 6. Medium, inherited: Pi's visible manifest describes m[0] only

Pi's fold stores `renderedMemoryIds` from m[0] (`:1850–1852`); its soft refresh
updates only m[1] bytes and boundary (`:2591–2595`). Its m[1] renderer returns no
rendered-id manifest. Ordinary additive delta memories are omitted, not just
forced replacements.

**Evidence:** `Pi: additive m1 memory is absent from memory_block_ids`.
An empty baseline persists `[]`; connection two adds ID 1; the refresh persists
`#1: visible additive memory` in m[1] while the manifest stays `[]`.
These writes and the renderer result shape also predate this commit. If the
manifest is meant to cover the served pair as in OpenCode, Pi is not at parity.

## Renderer-input audit

All store-dependent reads in the two m[1] renderers and their read-render
callbacks were mapped to the validation that is actually executed:

| Render input | OpenCode validation | Pi validation / limitation |
| --- | --- | --- |
| Eligible memory id/content/category/status/expiry/scope/shareable, including forced replacements | Eligible MAX(id), memory mutation cursor, project/workspace epochs. Normal update/archive/merge tool transactions append mutation rows; cross-session changes in the same project are included. | Same epoch/cursor/additive-max strategy, but expiry predicate differs: finding 4. Neither protects unlogged raw content writes; the write-helper/log contract matters. |
| Importance, last_seen_at, verified_at used to select among eligible memories | Not compared: finding 1 | Not compared: finding 1 |
| Memory mutation rows after the frozen baseline cursor, target-specific and supersede-chain queries | MAX(memory_mutation_log.id) across expanded project identities; append-only queue path changes it | Same. Render reads are not gated by pending/applied status. These logs are append-only by convention, not a hash of historical row values. |
| Workspace identities, aliases, names, sharing categories and canonical attribution | Workspace, workspace-epoch and alias signatures plus project epoch and eligibility probe | Canonical-identity/epoch/share-category fingerprint and eligible max. Public dashboard membership/name/category edits bump member epochs; raw name/alias rows are not fully fingerprinted by Pi. No claim of arbitrary-SQL immunity. |
| New compartment sequence, body/tiers, title, ordinals, rebase status and no-content filtering | Max sequence, legacy count/upgrade state and m0 mutation cursor; misses in-place history revision: finding 2 | Same, plus last boundary id; misses same-end-id rewrite: finding 2. Pi does not add OpenCode's temporal timestamp decoration. |
| OpenCode indexed boundary timestamps and host fallback timestamps | Not compared: finding 3 | Not a Pi m[1] input |
| Active global user profile and its content/order | Global user-profile version. Production reviewer writes and bumps this version together (`review-user-memories.ts:411–430`). | Same global version. Raw helpers alone do not provide this contract. |
| Baseline markers, already-rendered memory ids and cached row used by soft refresh | Cached m0 byte/marker comparison; delta probe then writer transaction. The manifest is incomplete for forced entries: finding 5. | Cached-row byte/marker comparison and delta probe, but manifest excludes m[1]: finding 6. |
| Model, budget, feature/temporal flags and supplied workspace context | Request-local inputs, not mutable store rows; retries use the same request settings | Same |
| Mural image/hash | Not read by either m[1] renderer. HARD fold freezes one resolved payload/hash and persists them with m0/m1; defer does not adopt a newer mural. | Same frozen pairing and process-cache replay. This is an intentional point-in-time mural, not an asserted current mural-manifest CAS. |
| session_facts | Not a render source; version signal is inert zero | Same |
| Pending operations and tag status | Not an m[1] byte input. Operations remain a separate pipeline phase. Legacy conversion rows are separately validated as below. | Not an m[1] byte input; no new Pi legacy-conversion split |

The two-connection addition controls exercise both hosts. Ordinary new
compartment publication changes max sequence; delete/merge/recomp helpers append
m0 mutations or clear cached rows. A sibling fold for another session does not
itself change this session's renderer inputs. Its shared memory promotions do
change the project-wide additive max, and its duplicate observations can hit
finding 1. This is why a session-only change counter is insufficient.

## Watermarks, retry behavior and defers

* `maxMemoryId` and mutation cursors remain **baseline** watermarks, not “every
  memory in the served pair.” Keeping them at the m[0] snapshot is correct:
  advancing them to the current delta probe would hide omitted/trimmed delta
  memories on subsequent refreshes. Additions between m0 read and delta render
  may appear in m1 without advancing that baseline. Do not fix the CAS by copying
  the current maximum into the persisted baseline.
* Fold bytes, frozen mural, cursors, manifest and baseline end-id updates remain
  in one writer transaction. Soft refresh renders its boundary from the same
  deferred snapshot as its delta and writes both together. Ordinary publication
  CAS tests found no torn row or over-advanced boundary. Findings 5–6 are wrong
  manifest **contents**, despite atomic writes.
* HARD retry loops are bounded to **three attempts**. OpenCode reenters all of
  `materializeM0`, including both read transactions and `onFoldPrepare`. Pi
  recreates the pass snapshot after contention and rerenders; request doc bytes
  remain intentionally frozen. The addition controls committed only the second,
  freshly rendered attempt. Repeated contention replays the captured complete
  prefix or uses the explicitly permitted fresh, nonpersisted fallback; it does
  not silently persist the rejected pair. Pi also translates BEGIN IMMEDIATE
  lock failures to its contention error; OpenCode's raw lock exception follows
  the surrounding degradation path.
* **Soft refresh has no local retry.** One detected post-render addition throws;
  the full old session_meta row is preserved (both hosts' tests pass). OpenCode's
  postprocess catch calls `failPass("m0-m1-fold-preexecution-degradation", ...)`,
  and the host replay-or-refuse machinery decides delivery. Pi retains the
  captured prefix and contended flag at preflight; force recovery can use a
  fresh nonpersisted pair. Thus contention can defer a fold or lead to a refusal
  when no safe replay fits. It is not an unbounded retry, and the full OpenCode
  postprocess suite includes replay/refusal checks. The Pi full context-handler
  suite was not separately rerun; no claim of an end-to-end Pi delivery proof is
  made from the injector tests alone. A future bounded soft-refresh retry would
  be an availability change, not part of this report's fixes.
* **Defers:** independent tests compare the actual two-message image-bearing
  prefix arrays across an executing refresh and two defers, after a sibling has
  added another memory. Both replay byte-identically, issue zero BEGIN IMMEDIATE,
  and preserve the complete session_meta row. Existing date-bearing OpenCode
  defer tests also pass. The standalone differential independently reports
  `writer holds (ms): none` for both defers. Its Pi output hash is a result-summary
  hash, not an outgoing-array hash; the new actual-prefix controls close that
  evidence gap. Its complete row hashes do cover the persisted buffers/images.
* Differential timing on this shared machine was noisy: OpenCode fold/refresh
  held 1403.7/1216.5 ms, with 1395.1/1212.6 ms in SQLite commit; Pi held 40.6/29.0
  ms. These numbers support the structural split but not an absolute latency
  guarantee or a reproduction of the original 9.3 s incident.

## onFoldPrepare and Rust-path review

The callback used by `transform-postprocess-phase.ts:2026–2050` validates the
prepared legacy conversion projection **inside** the writer transaction and
throws `MaterializeContentionError` before persisting modes when it differs.
`prepareLegacyToolSkeletonConversions:231–244` selects sorted dropped tool rows
with legacy `truncated`/`full` modes and captures tag number, mode and call id.
Status/type/mode transitions in/out of that predicate, insertion/deletion and
call-id changes invalidate the snapshot. Unrelated token-count metadata is not
a mode input; the wire target's input-size/topology is request-local and the
preparation/commit interval contains no await.

The existing real postprocess test
`fold preparation retries rather than overwriting a changed legacy tool tag`
passed. The independent WAL test uses the exported preparation helper and the
same validation/persist pattern under the real materialize retry transaction:
connection two changes a prepared tag to active/full. Attempt one rolls back,
attempt two prepares again, and active/full remains untouched. It does not
claim to replace the existing full-pipeline test with a callback-only proxy.
No stale legacy-mode overwrite was found. Mutable helper callers must still
invoke `isCurrent` before `persist`; the split helper does not enforce that on
its own. The inspected production callback does.

`git diff --name-only 9cbb1dff3076^ 9cbb1dff3076 -- crates` was empty.
The postprocess diff changes only the TypeScript fold preparation call site and
related timing/log wording; `runRustModePostprocess` is untouched. Pi's
context-handler diff is logging-only. This does not alter or certify Rust
materialization/CAS logic.

## Independent mutation control

The existing worker control was rerun against the reviewed revision. The exact
safe sequence was: stage `inject-compartments.ts`; confirm an empty tracked
`git diff --stat`; replace
`if (stale || !m1SnapshotIsCurrent(options, prepared))` with `if (stale)` and a
`NON-VACUITY BREAK` comment; capture the nonempty diff; run the two fold tests;
restore with `git checkout -- <path> && touch <path>`; capture empty tracked and
cached diffs; rerun the same tests. No mutation is retained or committed.

During mutation:

```text
packages/plugin/src/hooks/magic-context/inject-compartments.ts | 3 ++-
1 file changed, 2 insertions(+), 1 deletion(-)
(fail) m[0]/m[1] materialization > two connections retry a fold when a memory arrives after m[1] rendering
Expected: 2; Received: 1
(pass) m[0]/m[1] materialization > two connections retry a fold when a compartment arrives after m[1] rendering
1 pass, 1 fail, 88 filtered out
```

After restoration: empty diff stat and 2 passed / 0 failed. The named additive
test, and only that test, reddened; the compartment control stayed green because
the original m[0] stale check still defends that ordinary publication.

## Reproducing the independent fixtures

Save the TypeScript appendix as `scripts/fold-render-review.test.ts` in a clean
throwaway worktree of the reviewed revision, then run the following. This scratch
source is diagnostic evidence, not a proposed product test patch. Its use of
the existing test hooks places real connection-two writes precisely after the
deferred read commits and before writer admission. All database writes in that
interval use ordinary exported helpers (the raw setup updates happen before
rendering). The tests assert current broken behavior, so promoting them into
safety regressions would require reversing the bug assertions deliberately.

```sh
root="${TMPDIR:-/tmp/}magic-context/bg_21ecce0dbbd1ef0e"
mkdir -p "$root"/{home,tmp,data,config,state,runtime,storage,repro}
unset OPENCODE_DB
export HOME="$root/home" TMPDIR="$root/tmp" REVIEW_ROOT="$root/repro/"
export XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config"
export XDG_STATE_HOME="$root/state" XDG_RUNTIME_DIR="$root/runtime"
export MAGIC_CONTEXT_STORAGE_DIR="$root/storage"
BUN_JSC_useOMGJIT=0 bun test --tsconfig-override packages/pi-plugin/tsconfig.json \
  scripts/fold-render-review.test.ts
```

Final result: **14 tests passed, 0 failed, 53 assertions**. Every database is a
fresh disk-backed WAL file with two independent connections and current
migrations; the deterministic clock is restored in finally blocks.

### Executed scratch test source

```ts
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../packages/plugin/src/shared/sqlite";
import { initializeDatabase } from "../packages/plugin/src/features/magic-context/storage-db";
import { runMigrations } from "../packages/plugin/src/features/magic-context/migrations";
import { getOrCreateSessionMeta, queueMemoryMutation } from "../packages/plugin/src/features/magic-context/storage";
import { insertMemory, setMemoryClassification, updateMemorySeenCount, supersededMemory } from "../packages/plugin/src/features/magic-context/memory/storage-memory";
import { appendCompartments } from "../packages/plugin/src/features/magic-context/compartment-storage";
import { injectM0M1, materializeM0, materializeWithRetry, renderM1, renderMemoryBlockV2, MaterializeContentionError } from "../packages/plugin/src/hooks/magic-context/inject-compartments";
import { injectM0M1Pi, materializeM0Pi, renderM1Pi } from "../packages/pi-plugin/src/inject-compartments-pi";
import { prepareLegacyToolSkeletonConversions } from "../packages/plugin/src/hooks/magic-context/apply-operations";
import { recoverUnresolvedCompartments } from "../packages/plugin/src/features/magic-context/store-generation-rebase";
import { recordMessageFtsRowid, recordIndexedMessageTime } from "../packages/plugin/src/features/magic-context/message-fts-rowid-map";
import { estimateTokens } from "../packages/plugin/src/hooks/magic-context/read-session-formatting";

const root = process.env.REVIEW_ROOT!;
if (!root || !root.includes("/magic-context/bg_21ecce0dbbd1ef0e/")) throw new Error("throwaway REVIEW_ROOT required");
function fixture(label: string) {
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, label));
    const path = join(dir, "context.db");
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    db.exec("PRAGMA journal_mode=WAL");
    const sibling = new Database(path);
    const sid = label;
    const project = "git:review";
    getOrCreateSessionMeta(db, sid);
    return { db, sibling, dir, sid, project, close: () => { sibling.close(); db.close(); } };
}
function compartment(sequence = 0) {
    return { sequence, startMessage: 1, endMessage: 2, startMessageId: "a", endMessageId: "b", title: "review history", content: "review history", p1: "review history", p2: "review", p3: "review", p4: "review", legacy: 0 };
}

for (const host of ["OpenCode", "Pi"] as const) {
    for (const change of ["importance", "reinforcement"] as const) {
        test(`${host}: second-connection ${change} changes m1 selection without rejecting stale persisted bytes`, () => {
            const f = fixture(`${host}-${change}-`);
            try {
                const sample = insertMemory(f.db, { projectPath: "git:budget-only", category: "ARCHITECTURE", content: "candidate A ".repeat(40) });
                const cost = estimateTokens(renderMemoryBlockV2([sample], "new-memories"));
                const budget = 4 * (cost + 2);
                const options = { db: f.db, sessionId: f.sid, projectPath: f.project, projectDirectory: f.dir, injectDocs: false, memoryInjectionBudgetTokens: budget };
                const pi = { sessionId: f.sid, projectIdentity: f.project, projectDirectory: f.dir, injectDocs: false, injectionBudgetTokens: budget };
                const baseline = host === "OpenCode" ? materializeM0({ ...options, state: getOrCreateSessionMeta(f.db, f.sid) }) : materializeM0Pi(pi, f.db);
                const a = insertMemory(f.db, { projectPath: f.project, category: "ARCHITECTURE", content: "candidate A ".repeat(40) });
                const b = insertMemory(f.db, { projectPath: f.project, category: "ARCHITECTURE", content: "candidate B ".repeat(40) });
                setMemoryClassification(f.db, a.id, { importance: 50 });
                setMemoryClassification(f.db, b.id, { importance: 50 });
                f.db.prepare("UPDATE memories SET last_seen_at = CASE WHEN id = ? THEN 1000 ELSE 0 END, verified_at = NULL WHERE id IN (?, ?)").run(a.id, a.id, b.id);
                let writes = 0;
                const beforeCacheCommitForTest = () => {
                    writes++;
                    if (change === "importance") setMemoryClassification(f.sibling, b.id, { importance: 100 });
                    else updateMemorySeenCount(f.sibling, b.id);
                };
                if (host === "OpenCode") injectM0M1({ ...options, state: getOrCreateSessionMeta(f.db, f.sid), isCacheBustingPass: true, beforeCacheCommitForTest });
                else injectM0M1Pi({ ...pi, beforeCacheCommitForTest }, f.db, [], undefined, true);
                const meta = getOrCreateSessionMeta(f.db, f.sid);
                const fresh = host === "OpenCode" ? renderM1(options, baseline.snapshotMarkers, []) : renderM1Pi(pi, f.db, baseline.snapshotMarkers, []);
                expect(writes).toBe(1);
                expect(meta.cachedM1Bytes!.toString()).toContain("candidate A");
                expect(meta.cachedM1Bytes!.toString()).not.toContain("candidate B");
                expect(fresh).toContain("candidate B");
                expect(fresh).not.toContain("candidate A");
                console.log(`REPRO ${host} ${change}: stale=A fresh=B writerAdmissions=1`);
            } finally { f.close(); }
        });
    }
}

test("OpenCode: second-connection timestamp backfill persists a stale m1 date", () => {
    const f = fixture("dates-");
    try {
        const options = { db: f.db, sessionId: f.sid, projectPath: f.project, projectDirectory: f.dir, injectDocs: false, temporalAwareness: true };
        const baseline = materializeM0({ ...options, state: getOrCreateSessionMeta(f.db, f.sid) });
        appendCompartments(f.db, f.sid, [compartment()]);
        for (const ordinal of [1, 2]) recordMessageFtsRowid(f.db, f.sid, ordinal, ordinal);
        injectM0M1({ ...options, state: getOrCreateSessionMeta(f.db, f.sid), isCacheBustingPass: true, beforeCacheCommitForTest: () => {
            for (const ordinal of [1, 2]) recordIndexedMessageTime(f.sibling, f.sid, ordinal, Date.UTC(2025, 0, 1));
        } });
        const persisted = getOrCreateSessionMeta(f.db, f.sid).cachedM1Bytes!.toString();
        const fresh = renderM1(options, baseline.snapshotMarkers, []);
        expect(persisted).not.toContain("2025-01-01");
        expect(fresh).toContain("2025-01-01");
        expect(persisted).not.toBe(fresh);
        console.log("REPRO dates: stale=undated fresh=2025-01-01");
    } finally { f.close(); }
});

test("OpenCode: forced replacement in m1 is absent from memory_block_ids", () => {
    const f = fixture("forced-manifest-");
    try {
        const a = insertMemory(f.db, { projectPath: f.project, category: "ARCHITECTURE", content: "original A ".repeat(40) });
        const b = insertMemory(f.db, { projectPath: f.project, category: "ARCHITECTURE", content: "replacement B ".repeat(40) });
        setMemoryClassification(f.db, a.id, { importance: 100 });
        setMemoryClassification(f.db, b.id, { importance: 1 });
        const budget = estimateTokens(renderMemoryBlockV2([a])) + 2;
        const options = { db: f.db, sessionId: f.sid, projectPath: f.project, projectDirectory: f.dir, injectDocs: false, memoryInjectionBudgetTokens: budget };
        const baseline = materializeM0({ ...options, state: getOrCreateSessionMeta(f.db, f.sid) });
        expect(baseline.renderedMemoryIds).toEqual([a.id]);
        f.sibling.transaction(() => {
            supersededMemory(f.sibling, a.id, b.id);
            queueMemoryMutation(f.sibling, { projectPath: f.project, mutationType: "superseded", targetMemoryId: a.id, supersededById: b.id });
        }).immediate();
        injectM0M1({ ...options, state: getOrCreateSessionMeta(f.db, f.sid), isCacheBustingPass: true });
        const meta = getOrCreateSessionMeta(f.db, f.sid);
        expect(meta.cachedM1Bytes!.toString()).toContain(`#${b.id}: replacement B`);
        expect(JSON.parse((f.db.prepare("SELECT memory_block_ids AS ids FROM session_meta WHERE session_id = ?").get(f.sid) as any).ids)).not.toContain(b.id);
        console.log(`REPRO forced manifest: body contains #${b.id}, ids=${(f.db.prepare("SELECT memory_block_ids AS ids FROM session_meta WHERE session_id = ?").get(f.sid) as any).ids}`);
    } finally { f.close(); }
});

test("Pi: additive m1 memory is absent from memory_block_ids", () => {
    const f = fixture("pi-manifest-");
    try {
        const state = { sessionId: f.sid, projectIdentity: f.project, projectDirectory: f.dir, injectDocs: false };
        materializeM0Pi(state, f.db);
        const memory = insertMemory(f.sibling, { projectPath: f.project, category: "ARCHITECTURE", content: "visible additive memory" });
        injectM0M1Pi(state, f.db, [], undefined, true);
        const meta = getOrCreateSessionMeta(f.db, f.sid);
        expect(meta.cachedM1Bytes!.toString()).toContain(`#${memory.id}: visible additive memory`);
        expect(JSON.parse((f.db.prepare("SELECT memory_block_ids AS ids FROM session_meta WHERE session_id = ?").get(f.sid) as any).ids)).not.toContain(memory.id);
        console.log(`REPRO Pi manifest: body contains #${memory.id}, ids=${(f.db.prepare("SELECT memory_block_ids AS ids FROM session_meta WHERE session_id = ?").get(f.sid) as any).ids}`);
    } finally { f.close(); }
});

test("OpenCode: validated tag callback rejects a second-connection status change and retries", () => {
    const f = fixture("tags-");
    try {
        f.db.prepare("INSERT INTO tags (session_id, tag_number, type, status, drop_mode) VALUES (?, 1, 'tool', 'dropped', 'truncated')").run(f.sid);
        let attempts = 0;
        const targets = new Map([[1, { canDrop: () => true, inputStringBytes: () => 10, cannotRemove: () => false, wouldStrandConversationEnd: () => false }]]);
        materializeWithRetry({ db: f.db, sessionId: f.sid, projectPath: f.project, projectDirectory: f.dir, injectDocs: false, state: getOrCreateSessionMeta(f.db, f.sid),
            onFoldPrepare: () => {
                const prepared = prepareLegacyToolSkeletonConversions(f.db, f.sid, targets as any);
                return db => {
                    if (!prepared.isCurrent(db)) throw new MaterializeContentionError({ reason: "fold conversion snapshot changed" });
                    prepared.persist(db);
                };
            },
            beforeCacheCommitForTest: () => { if (++attempts === 1) f.sibling.prepare("UPDATE tags SET status = 'active', drop_mode = 'full' WHERE session_id = ? AND tag_number = 1").run(f.sid); }
        });
        expect(attempts).toBe(2);
        expect(f.db.prepare("SELECT status, drop_mode FROM tags WHERE session_id = ?").get(f.sid)).toEqual({ status: "active", drop_mode: "full" });
    } finally { f.close(); }
});

for (const host of ["OpenCode", "Pi"] as const) {
    test(`${host}: render-cutoff eligibility must catch a newly expired additive memory`, () => {
        const f = fixture(`${host}-expiry-`);
        const realNow = Date.now;
        let now = 1000;
        Date.now = () => now;
        try {
            const options = { db: f.db, sessionId: f.sid, projectPath: f.project, projectDirectory: f.dir, injectDocs: false };
            const pi = { sessionId: f.sid, projectIdentity: f.project, projectDirectory: f.dir, injectDocs: false };
            const baseline = host === "OpenCode" ? materializeM0({ ...options, state: getOrCreateSessionMeta(f.db, f.sid) }) : materializeM0Pi(pi, f.db);
            now = 2000;
            const beforeCacheCommitForTest = () => {
                insertMemory(f.sibling, { projectPath: f.project, category: "ARCHITECTURE", content: "new memory eligible at baseline cutoff", expiresAt: 2500 });
                now = 3000;
            };
            const refresh = () => host === "OpenCode" ? injectM0M1({ ...options, state: getOrCreateSessionMeta(f.db, f.sid), isCacheBustingPass: true, beforeCacheCommitForTest }) : injectM0M1Pi({ ...pi, beforeCacheCommitForTest }, f.db, [], undefined, true);
            if (host === "OpenCode") expect(refresh).toThrow(MaterializeContentionError);
            else {
                refresh();
                expect(getOrCreateSessionMeta(f.db, f.sid).cachedM1Bytes!.toString()).not.toContain("new memory eligible");
                expect(renderM1Pi(pi, f.db, baseline.snapshotMarkers, [])).toContain("new memory eligible");
                console.log("REPRO Pi expiry: writer max=0, stale=empty, fixed-cutoff fresh contains #1");
            }
        } finally { Date.now = realNow; f.close(); }
    });
}

for (const host of ["OpenCode", "Pi"] as const) {
    test(`${host}: two defers replay the actual image-bearing prefix byte-identically with no writer`, () => {
        const f = fixture(`${host}-defer-`);
        try {
            const mural = { enabled: true, supportsVision: true, dataUrl: "data:image/png;base64,ZmFrZQ==", contentHash: "frozen-image" };
            const options = { db: f.db, sessionId: f.sid, projectPath: f.project, projectDirectory: f.dir, injectDocs: false, mural };
            const pi = { sessionId: f.sid, projectIdentity: f.project, projectDirectory: f.dir, injectDocs: false, mural };
            const state = getOrCreateSessionMeta(f.db, f.sid);
            const serve = (bust: boolean) => {
                if (host === "OpenCode") return injectM0M1({ ...options, state, isCacheBustingPass: bust }).preparedMessages;
                const messages: any[] = [{ role: "user", content: "tail", timestamp: 1000 }];
                injectM0M1Pi(pi, f.db, messages, undefined, bust);
                return messages.slice(0, 2);
            };
            serve(false);
            insertMemory(f.sibling, { projectPath: f.project, category: "ARCHITECTURE", content: "frozen delta" });
            const expected = JSON.stringify(serve(true));
            expect(expected).toContain("frozen delta");
            insertMemory(f.sibling, { projectPath: f.project, category: "ARCHITECTURE", content: "not served on defer" });
            const before = f.db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get(f.sid);
            let admissions = 0;
            const exec = f.db.exec.bind(f.db);
            f.db.exec = sql => { if (sql === "BEGIN IMMEDIATE") admissions++; return exec(sql); };
            expect(JSON.stringify(serve(false))).toBe(expected);
            expect(JSON.stringify(serve(false))).toBe(expected);
            expect(admissions).toBe(0);
            expect(f.db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get(f.sid)).toEqual(before);
        } finally { f.close(); }
    });
}

for (const host of ["OpenCode", "Pi"] as const) {
    test(`${host}: second-connection compartment recovery commits stale m1 ranges despite a history revision`, () => {
        const f = fixture(`${host}-ranges-`);
        try {
            const options = { db: f.db, sessionId: f.sid, projectPath: f.project, projectDirectory: f.dir, injectDocs: false };
            const pi = { sessionId: f.sid, projectIdentity: f.project, projectDirectory: f.dir, injectDocs: false };
            const baseline = host === "OpenCode" ? materializeM0({ ...options, state: getOrCreateSessionMeta(f.db, f.sid) }) : materializeM0Pi(pi, f.db);
            appendCompartments(f.db, f.sid, [compartment()]);
            f.db.prepare("UPDATE compartments SET rebase_status = 'unresolved' WHERE session_id = ?").run(f.sid);
            const before = f.db.prepare("SELECT version FROM compartment_history_versions WHERE session_id = ?").get(f.sid) as any;
            const beforeCacheCommitForTest = () => {
                const result = recoverUnresolvedCompartments({ db: f.sibling, sessionId: f.sid, resolveOrdinal: id => id === "a" ? 3 : id === "b" ? 4 : undefined, reason: "fixture recovered anchors" });
                expect(result.rowsRewritten).toBe(1);
            };
            if (host === "OpenCode") injectM0M1({ ...options, state: getOrCreateSessionMeta(f.db, f.sid), isCacheBustingPass: true, beforeCacheCommitForTest });
            else injectM0M1Pi({ ...pi, beforeCacheCommitForTest }, f.db, [], undefined, true);
            const after = f.db.prepare("SELECT version FROM compartment_history_versions WHERE session_id = ?").get(f.sid) as any;
            const persisted = getOrCreateSessionMeta(f.db, f.sid).cachedM1Bytes!.toString();
            const fresh = host === "OpenCode" ? renderM1(options, baseline.snapshotMarkers, []) : renderM1Pi(pi, f.db, baseline.snapshotMarkers, []);
            expect(after.version).toBeGreaterThan(before.version);
            expect(persisted).not.toBe(fresh);
            expect(persisted).not.toContain("## 3-4");
            expect(fresh).toContain("## 3-4");
            console.log(`REPRO ${host} ranges: persisted lacks 3-4, fresh=3-4, historyVersion=${before.version}->${after.version}`);
        } finally { f.close(); }
    });
}
```
