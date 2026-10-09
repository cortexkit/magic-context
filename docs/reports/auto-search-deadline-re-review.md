# Auto-search deadline adversarial re-review

## Disposition and comparison

**Do not merge `ca57ba3d85516e3c3b1546c710b2f1dbba771ea0` unchanged.**
All five original counterexample tests now pass, but that is not equivalent to
closing all five correctness claims. Passage identity and multi-turn skip freezing
are repaired. Publication, lifecycle fencing, and unconditional successful-hint
byte parity still have executable counterexamples. This review adds **two P1 and
three P2 findings**, with five deliberately failing tests.

Reviewed the candidate and both reports on
`alfonso/task/bg_f09bdde51289595d-auto-search-hint-takes-3-7-s-per-user-turn-and-o`.
Comparison master is **`41eedb38821dba886ce8ea1c65963eab54bf52f3`**; the candidate's
original base is `77f54a691090a8927c3686735e912e46789e25c4`. The review worktree was
initially on master, where the two reports were absent. I moved this isolated task
branch to the specified candidate before reading/testing them; no compatibility
files or product fixes were invented. The committed delta from the candidate is
only tests, test fixtures, and this report. The old-reader test executes the actual
getter/validator declarations from the pinned comparison master, rather than an
approximation of the old protocol. The legacy search comparison calls the real
`unifiedSearch` inside the real transform-pass scope; `search.ts` is unchanged
between comparison master and candidate.

All source references below are candidate paths unless explicitly labeled master.
Paths starting `hooks/` or `features/` are relative to `packages/plugin/src/`.

## Re-run of the original five findings

Command: `bun test --timeout 30000` with
`packages/plugin/src/hooks/magic-context/auto-search-deadline-review.test.ts` and
`auto-search-followup.test.ts`, using the isolated environment below.
**9 passed, 0 failed, 32 assertions**, Bun 1.4.2. The original five assertions were
not edited.

| Original finding and exact test | Closure assessment |
| --- | --- |
| P1 passage identity: `review: a provider generation change must not label new passage vectors with the old model` | **Closed.** `hooks/magic-context/auto-search-worker-client.ts:369-385` transports model/generation plus provider identity, fingerprint and dimensions. `auto-search-worker.ts:79-98` rejects incompatible contracts and invalid vectors before returning them to backfill. The original generation trigger and added provider/dimension triggers pass. The final-result generation check is no longer the sole defense. |
| P1 provisional visibility: `review: a second connection must not replay a committed but unacknowledged hint` | **Exact provisional trigger repaired; shared-store publication claim not closed.** New-version readers really reject durable provisional state, including a separate process. However, an older reader accepts it (finding 1), and the new accepted transaction creates another unacknowledged-visible state (finding 2). |
| P2 freeze overwrite: `review: a failed durable skip remains frozen after another turn skips` | **Closed.** `hooks/magic-context/auto-search-deadline.ts:27-30,51-57,108` retains a message-id map, not one last id. Both failed durable skips remain frozen and rewind cannot create new hint bytes for the first one. |
| P2 deleted-session resurrection: `review: background skip persistence must not resurrect a deleted session` | **Exact same-owner skip trigger repaired; lifecycle claim not fully closed.** Cancellation is checked after writer acquisition, and a missing captured row is rejected. Hint/no-hint decision workers are outside this registration, and a reused rowid defeats another owner's skip fence (findings 3 and 4). |
| P2 short-lock parity: `review: a successful worker hint must preserve legacy bytes across a short backfill writer lock` | **Exact 100 ms trigger repaired; byte-parity claim not closed.** Remaining-budget waiting handles the original short lock. It is not the legacy 250 ms foreground lease: a 400 ms lock now produces the opposite successful-hint difference (finding 5). |

These are substantive repairs, not just altered expectations. The distinctions in
the table matter: a passing provisional-ack test does not exercise the new *final*
acknowledgement, and a successful 100 ms wait does not prove writer-policy parity.

## Findings still blocking merge

All five tests below are in
`packages/plugin/src/hooks/magic-context/auto-search-re-review.test.ts`. They remain
red, not skipped or inverted into expected failures. The final run was **4 passed,
5 failed, 35 assertions, 9 tests**, with exactly the five named counterexamples
failing. No product-code mutation is needed to reproduce any of them.

### 1. P1 — The publication JSON protocol is unsafe for an older reader

**Trigger:** a new owner writes a provisional entry while an older Pi/plugin build
is still using the same context store/session, or that build reads the entry after
a restart/downgrade. Vendor-scoped shared stores explicitly permit multiple hosts;
there is no reader-version or ownership gate.

- `features/magic-context/storage-meta-persisted.ts:1769-1770` stores the full
  `decision: "hint"` object, including its provisional publication metadata, in the
  existing `auto_search_hint_decisions` column.
- The filtering at `storage-meta-persisted.ts:319-330,1614-1618` and Pi's
  `packages/pi-plugin/src/context-handler.ts:7548-7559,7603-7614` exists **only in
  new readers**. A JSON field is not a backwards-compatible served-state fence.
- Comparison master's `storage-meta-persisted.ts:288-290` validates a hint by its
  nonempty text; its `getAutoSearchHintDecisions` returns the original parsed
  object. The previous Pi projection uses the same permissive text validation.
  Replay appends the returned hint text before the live-tail gate.

**Failing test:**
`re-review: an older master reader must not expose a provisional publication`
(`auto-search-re-review.test.ts:103`).

The actual candidate writer commits a provisional hint. The candidate getter sees
`[]`; the actual pinned-master getter sees the hint **and its `publication`
object/token**. Thus the metadata reaches an older reader, and that reader treats
unserved hint text as a served replay decision. This is not a claim that the token
itself is interpolated into normal user text.

**Repair direction:** use a representation old readers cannot mistake for a served
hint, or enforce a durable, version-aware exclusive session owner/upgrade barrier.
Changing only the current decoder cannot protect an already-running old build.

### 2. P1 — Accepted state becomes visible before the final owner acknowledgement

**Trigger:** provisional commit and its acknowledgement are timely. The worker
receives `publish`, commits `accepted`, but delivery of the *final* result is delayed
past the stage deadline. A sibling writer can delay retirement while another WAL
reader performs a defer/tool-continuation replay.

- `features/magic-context/storage-meta-persisted.ts:1819-1825,1842` commits accepted
  state before the worker sends its outcome.
- `hooks/magic-context/auto-search-worker.ts:169-178` sends the accepted outcome
  only after that transaction.
- `auto-search-worker-client.ts:185-189,198,248-249` returns `null` on owner timeout
  and queues off-thread retirement; it does not prevent a different connection
  reading the accepted entry during this gap.
- `storage-meta-persisted.ts:324` exposes accepted entries, and
  `hooks/magic-context/auto-search-runner.ts:245-249` replays them before the
  live-tail check at `:262`.

**Failing test:**
`re-review: an accepted commit with a late final ack must remain invisible to a second owner`
(`auto-search-re-review.test.ts:117`).

`auto-search-publication-ack-review.fixture.ts` imports the **real worker** and
changes only final-message delivery timing after the real acceptance commit. It
does not replace search, the database writer, or the acceptance function. The test
observes an accepted-commit marker, holds an independent writer lock to delay
retirement, and proves the owner returned `null`. The owner's object-local read is
empty, but the second connection's real runner changes the buried user's text from
`question` to `question\n\n<ctx-search-hint>unserved</ctx-search-hint>`.

**Impact:** the repaired protocol moves, rather than eliminates, the original
unserved-hint replay window. Later retirement can remove those bytes again.
This needs neither an old reader nor a process crash.

**Repair direction:** bind shared replay to the actual served decision and session
ownership. Do not merely add another acknowledgement: an additional asynchronous
ack boundary can reproduce the same visibility/timeout gap.

### 3. P2 — Session cleanup does not fence pending hint decision writers

**Trigger:** a turn queues a hint decision while another connection owns the writer
lock. Cleanup deletes the session in that connection's transaction and commits.
The already-queued hint worker then acquires the lock and creates the row again.

- `hooks/magic-context/auto-search-worker-client.ts:171-183` launches decision
  writers without `registerAutoSearchWriter`, cancellation, or captured row identity.
- `features/magic-context/storage-meta-session.ts:311` cancels only registered
  writers; `hooks/magic-context/auto-search-deadline.ts:66-82` registers skip writers,
  not these hint/no-hint decision writers.
- `auto-search-worker.ts:139` calls `appendAutoSearchHintDecision` with default
  row creation; `storage-meta-persisted.ts:1756-1772` permits ensuring the row.

**Failing test:**
`re-review: pending hint publication must not recreate a cleared session`
(`auto-search-re-review.test.ts:163`).

This uses the real decision worker, a real independent writer transaction, and real
`clearSession` plus the runner cleanup hook. Absence immediately after deletion
passes. After the pending publication finishes, `SELECT 1` finds the session again.
No delayed/mock writer entry is necessary.

**Repair direction:** include every decision writer and queued turn in lifecycle
cancellation, and condition appends on a non-reusable session incarnation rather
than unconditionally ensuring a row. Cancellation alone is not a durable
cross-owner deletion fence.

### 4. P2 — A SQLite rowid is not a session incarnation fence

**Trigger:** owner A queues a background skip. Owner B deletes and recreates the
same session while holding the writer lock. SQLite reuses the deleted row's rowid.
A's cancellation registry is in another module instance/process, so B cannot set
its flag. A's old skip passes the rowid comparison and contaminates the new row.

- `hooks/magic-context/auto-search-deadline.ts:59-61,80-82` captures only `rowid`.
- `hooks/magic-context/auto-search-worker.ts:188-195` checks equality of that rowid,
  not an incarnation/generation that survives deletion.
- `packages/plugin/src/shared/auto-search-hint-fence.ts:4,31-35` has a process-local
  writer registry. SharedArrayBuffer cancellation only reaches workers registered
  with that specific owner.
- `features/magic-context/storage-db.ts:1759-1760` defines `session_meta` with a TEXT
  primary key, not an unreusable generation; SQLite may reuse its implicit rowid.

**Failing test:**
`re-review: another owner's old skip must not contaminate a recreated session with a reused rowid`
(`auto-search-re-review.test.ts:193`).

A Worker is used as the second **owner module instance**, which calls the real
`persistAutoSearchSkip` and launches the real nested persistence worker. It has
separate module globals just like another host process. The test confirms the old
and new rowids are equal, the old write reports success, and the recreated session
contains `{messageId:"old-user", decision:"no-hint", reason:"timeout"}` instead of
`[]`. No cancellation/rowid predicate was neutralized for the test.

**Repair direction:** use an explicit non-reusable incarnation or durable
session-deletion/ownership generation. Reusable rowid equality cannot prove that
the session observed when queuing still exists.

### 5. P2 — Remaining-deadline busy timeout changes successful bytes beyond the legacy lease

**Trigger:** a sibling writer holds the backfill lock for 400 ms after passage
completion. This exceeds master's foreground writer lease, but is comfortably
inside the auto-search stage budget. Both searches and both hint decisions succeed.

- `packages/plugin/src/shared/sqlite.ts:691,777-780` gives the real legacy
  transform-pass writer attempt a 250 ms foreground lease.
- `hooks/magic-context/auto-search-worker.ts:41-42,54` instead sets SQLite's timeout
  to the whole remaining stage budget, including on passage continuation. A worker
  has no owner's transform-pass AsyncLocalStorage lease.
- Legacy backfill times out and ranks FTS-only; the worker waits longer, backfills,
  and ranks hybrid. This is the inverse of the original zero-timeout failure.

**Failing test:**
`re-review: successful hint bytes must match master when a backfill lock exceeds the foreground lease`
(`auto-search-re-review.test.ts:356`).

The real legacy path and real search worker use identical provider contracts,
queries and two-memory corpora with an independently timed writer fixture. Both
scores exceed 0.6, both decision writes are accepted, and both stages finish inside
3 seconds. Nevertheless the hint bullet order reverses:
legacy starts with `historian cache wiring details`; worker starts with
`historian cache wiring retry correctness budgeting`.

**Repair direction:** carry the legacy acquisition lease as well as the absolute
stage deadline and use the smaller remaining bound, or explicitly change the
successful-hint parity contract. The 100 ms positive test does not defend the
250–3000 ms interval.

## Other requested hunts

### Metadata and served surfaces

For **current readers**, I found no token/publication-object leak into ordinary
served text or explicit `ctx_search` output. The direct and coherent-snapshot
readers filter provisional entries and strip publication metadata. Pi's separate
sticky projection rejects provisional state and reconstructs public hint objects
at `context-handler.ts:7603-7614`.

The added green control
`re-review control: publication metadata is absent from public decisions, served bytes and ctx_search`
checks the exact public decision shape, exact replayed user text, and calls the
real OpenCode `ctx_search` tool against a real memory. It observes the memory result
and no internal marker/publication field. The tool searches corpus lanes, not
session decision JSON (`packages/plugin/src/tools/ctx-search/tools.ts:188-225`).
The new-version projection is not evidence of compatibility with old readers:
finding 1 explicitly disproves that. Finding 2 concerns *hint acceptance*, not a
literal token leak.

### `BEGIN IMMEDIATE`, refusal, and spent budget

The new transactions run in workers on file-backed runtime stores. I did **not**
find a new owner-thread writer-lock wait that holds the turn past its stage budget,
or a turn refusal caused simply by this acquisition. The added contention control
holds a real writer lock with only 250 ms of stage budget left; publication returns
`null` within its bounded tolerance and exposes no hint. This proves bounded owner
waiting, not interruptibility of arbitrarily slow native SQLite/COMMIT calls.

When the budget is already spent, `auto-search-deadline.ts:124-125` returns `null`
without starting publication. The exhausted-budget control verifies that under an
independent writer lock. The runner then queues its separate best-effort skip.
That skip has a separate 250 ms lock budget; if worker startup consumes it,
`auto-search-worker.ts:42` clamps `busy_timeout` to zero. **Zero timeout does not
mean zero permission to write**: the skip path has no expired-deadline rejection,
so an uncontended freeze can still commit. The added expired-skip control executes
that real path and confirms it. Contended writes fail best-effort while the
in-process freeze remains. This is not itself a turn refusal or a new finding;
its lifecycle protections are the problems in findings 3 and 4.

### OMP evidence

The follow-up's no-prompt factory really starts the built Pi worker, so its narrow
**actual OMP loader/search** claim is sound. It is not evidence that the shipped
`dist/index.js` extension registration, a full turn, or embedding RPCs all work in
OMP. Its fixture at `auto-search-omp-loader.fixture.ts:52` explicitly terminates the
worker on success; that probe alone cannot establish autonomous worker shutdown.

I added an **actual OMP** case to `auto-search-bundle-review.test.ts`, using the
existing 18-check bundled-worker driver and a small OMP initialization fixture.
OMP 17.0.4 / Bun 1.4.2 (Node-compatible `process.version` v26.3.0) passed **18 real
worker executions**: load/search, held query RPC, startup failure, restart,
writer conflict, decision write/retirement, and repeated-session self-closing
workers. Its `lsof` sample observes the real context database plus OMP's own
`agent.db` and `models.db` handles, all beneath the fixture root.

An initial test-driver attempt awaited all checks inside a factory and then called
`process.exit`: OMP's guarded loader rejected that exit, despite all 18 worker
checks executing. The corrected fixture returns from initialization and runs the
no-prompt driver after the guard has released. This is a probe correction, not a
product-loader defect. The passing check still uses a probe extension loading the
real built worker, not the complete Magic Context extension. No model request or
RPC prompt was sent; the isolated host is configured with a visibly dummy API key
only to allow readiness, and inherits no credentials.

## Containment, reproduction, and verification

Live-store rule, verbatim: never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`).

All database fixtures, package-test HOME, logs and XDG directories are below
`$TMPDIR/magic-context/bg_a0f7b373d3df719d/`. Package suites **unset OPENCODE_DB**;
`TMPDIR` is itself nested beneath that task root, so older tests with their own
fixture subdirectory names also remain contained. Host children explicitly set
throwaway `HOME`, `XDG_*`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` and
`MAGIC_CONTEXT_LOG_PATH`; Pi/OMP config/session directories are isolated too.
The held-query `lsof -nP -p <host-pid> -Fn` checks require an actual worker database
handle and every open database handle under the canonical fixture root, and reject
live config paths. For the actual OMP run the context path was:

```
/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/bg_a0f7b373d3df719d/tmp/magic-context/bg_a8d894f629e2c52f/mc-test-owned-bundle-3NMzeP/context.db
```

A reproducible package-test prefix is:

```sh
root="${TMPDIR%/}/magic-context/bg_a0f7b373d3df719d"
mkdir -p "$root"/{home,tmp,config,data,cache,state,storage}
export HOME="$root/home" TMPDIR="$root/tmp"
export XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data"
export XDG_CACHE_HOME="$root/cache" XDG_STATE_HOME="$root/state"
export MAGIC_CONTEXT_STORAGE_DIR="$root/storage"
export MAGIC_CONTEXT_LOG_PATH="$root/re-review.log"
unset OPENCODE_DB
# From the candidate-based worktree:
bun run build:dists
bun test --timeout 30000 packages/plugin/src/hooks/magic-context/auto-search-re-review.test.ts
# Expected: exactly 5 red counterexamples, 4 green controls, exit 1.
```

| Gate | Result |
| --- | --- |
| Toolchain | Bun 1.4.2; Node v24.16.0; OMP 17.0.4; TypeScript 5.9.3; Biome 2.5.1. |
| `bun run build:dists` | Passed: candidate OpenCode 1, OpenCode 2 and Pi workers rebuilt; 4 v2 server tests passed, both distribution imports reported `dists LOAD OK`. |
| Original review + follow-up tests | 9 passed, 0 failed, 32 assertions, 2 files. |
| Plugin bounded/runner/pass-outcome/postprocess families + original 10-case bundle matrix | 301 passed, 0 failed, 1709 assertions, 5 files. The bundle matrix ran 180 real workers, including the actual Pi host, with `lsof` checks. |
| Added actual OMP bundle case, `--test-name-pattern 'omp worker under omp'` | 1 passed, 0 failed, 10 cases filtered out, 5 assertions plus 18 driver checks. Original 10 cases were run separately as above. |
| Added re-review tests, final run | **4 passed, 5 failed**, 35 assertions, 9 tests; exactly the five findings above. These are intentional candidate counterexamples, not a passing verification claim. |
| Pi `auto-search-bounded`, `auto-search-pi`, `context-handler` families | 174 passed, 0 failed, 673 assertions, 3 files. |
| `bun run --cwd packages/plugin typecheck` | Passed after final TypeScript edits; includes `tsc --noEmit` and script checking, TypeScript 5.9.3. |
| `bun run --cwd packages/pi-plugin typecheck` | Passed, TypeScript 5.9.3. |
| Package-local installed Biome check of the six changed TypeScript files | Passed, Biome 2.5.1. A first repository-root invocation rejected nested configs; rerunning in the package directory resolved that driver error. |
| Scoped AFT inspection | Partial: no authoritative current checkout callgraph/complete diagnostics, Biome producer unavailable. The actual TypeScript and Biome commands are the authoritative gates. |
| `git diff --cached --check` | Passed for the final seven-file review-only delta; unstaged diff empty. |
| Full workspace/package suites and Desktop/Electron host | Not run; this is a test/report-only adversarial review. Existing behavior families and built/packed runtime probes were targeted explicitly. |

The prepared installation was retained: no dependency or lockfile changes, no
package install required. No product code, existing counterexample assertion,
schema, or previous report was changed. Merge remains unsafe until the shared
publication and lifecycle issues are resolved and the successful-hint writer
policy is made consistent with its stated byte-parity contract.
