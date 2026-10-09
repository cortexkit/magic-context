# Auto-search deadline adversarial review

## Scope and disposition

Reviewed candidate **785d8c397e47de5ce9b35599288eaf8f60837894** on
`alfonso/task/bg_f09bdde51289595d-auto-search-hint-takes-3-7-s-per-user-turn-and-o`.
Comparison master was **de7e3a2520d4376d603d5d5e7abf605fb416838e**; merge base was
**77f54a691090a8927c3686735e912e46789e25c4**. The review branch is based on the
candidate, not on master. I read the candidate's
`docs/reports/auto-search-turn-deadline.md` first, then the transform-pass mechanics
and cache invariants in `ARCHITECTURE.md`.

**Recommendation: do not merge unchanged.** Two high-priority correctness findings
and three medium-priority findings have executable counterexamples below. Changes
in this review are tests, test fixtures, and this requested report only. No product
code, package manifest, lockfile, schema, or original delivery report was changed.
The counterexample tests deliberately remain red on the candidate; they are not
skipped, inverted into expected failures, or presented as passing verification.

File:line references below refer to the candidate's product sources. All five
counterexamples are in
`packages/plugin/src/hooks/magic-context/auto-search-deadline-review.test.ts`.

## Findings

### 1. P1 — Passage RPC loses the provider contract and can persist vectors under the wrong model

**Trigger:** a project registration changes after the query embedding was captured
but before the worker's missing-memory passage RPC starts. An explicit search,
embedding drain, bootstrap, or configuration refresh can replace the registration
while the auto-search worker is running. The passage RPC then uses the owner's
*new* provider, while the worker still has the *old* registration bridge.

- `auto-search-worker-client.ts:320-328` keeps only `.vectors` from
  `embedBatchForProject`; it discards `modelId` and `generation`.
- `auto-search-worker.ts:62-63` returns those vectors as though they came from the
  worker's provider. `project-embedding-registry.ts:2578-2598` wraps that provider
  result in the worker-local, old model identity and generation.
- `memory/embedding-backfill.ts:42-79` commits the vectors under that old identity.
  Its generation check observes the fabricated old contract and passes.
- The owner generation check at `auto-search-worker-client.ts:303-307` discards
  the final search result, **after the database corruption has occurred**.

**Failing test:**
`review: a provider generation change must not label new passage vectors with the old model`

The test uses the real source search worker and a missing memory vector. The owner
passage callback changes generation 1 to generation 2 and returns a generation-2
vector tagged `new-provider`. The final result is correctly empty, but the test
finds that vector in the old `fixture-provider` namespace: expected absent,
received present. This is not a test of an arbitrary late query promise; it reaches
the actual passage bridge and actual guarded SQLite embedding write.

**Impact:** switching back to the previous model, or another reader using that
model namespace, can rank against incompatible vectors. Discarding hint bytes at
the final generation check does not repair the stored embedding identity.

**Repair direction:** transport the whole passage embedding contract and validate
it against the captured worker generation before saving or scoring. Do not re-tag
vectors received from another generation with the bridge's old identity.

### 2. P1 — The provisional-row fence protects one Database object, not the shared store

**Trigger:** two owners/connections read the same session in the same context
store, such as simultaneous hosts attached to one OpenCode session. A hint commits
on connection A, but its acknowledgement is delayed beyond the owner's deadline.
After A has returned a no-hint timeout, connection B runs a defer/tool continuation
before the delayed acknowledgement has triggered durable retirement.

- `shared/auto-search-hint-fence.ts:3-29` keys the fence by `Database` object.
- `auto-search-worker-client.ts:156` marks only the submitting object's fence;
  coalescing is likewise object-local (`:27,71-88`).
- The direct and replay-snapshot filters in
  `storage-meta-persisted.ts:1581-1587,3058-3065` consult the reader's object, so B
  sees the provisional row as an ordinary accepted hint.
- `auto-search-runner.ts:241-249` replays that row **before** the live-tail gate at
  `:262-263`. A non-tail user message therefore acquires unserved hint bytes.

**Failing test:**
`review: a second connection must not replay a committed but unacknowledged hint`

A real SQLite decision writer uses the candidate's existing late-ack fixture. The
test waits for the actual commit, awaits the owner's timeout result (`null`), and
then runs the actual runner against a second connection with an assistant tail.
Connection A's read is fenced; B's replay snapshot contains the hint and B's served
user text gains `\n\n<ctx-search-hint>unserved</ctx-search-hint>`. The expected full
serialized array is the original no-hint array. After retirement, a subsequent
unfenced read loses that row again, creating another potential byte transition.

**Impact:** violates the SOFT+ byte-replay invariant and can introduce/remove a
hint behind already-sent assistant messages. This does **not** require a process
crash or restart; the delivery's disclaimer that it is not a crash-recovery
protocol does not cover this concurrent live-reader case. The test models two
connections, not an entire Desktop/CLI attachment workflow.

**Repair direction:** accepted/provisional state needs a durable reader-visible
protocol, or a strictly enforced single owner for a session. A store-path-local
in-process fence alone would still not protect a second process.

### 3. P2 — A second failed skip overwrites the first turn's in-process freeze

**Trigger:** another SQLite writer holds `BEGIN IMMEDIATE` while two different
user turns time out or cold-skip. Both best-effort skip writes fail. The user then
rewinds/navigates back to the first raw user turn, making it the live tail again
without closing the database or deleting the session.

- `auto-search-deadline.ts:11-17` stores only one `messageId` per session and
  connection, not a set of frozen skipped turns.
- `:37-38,76` replaces that record when the second message skips.
- `auto-search-runner.ts:235-249` no longer sees either an in-process freeze or a
  durable decision for the first message; the live-tail gate now allows fresh
  search and persistence.

**Failing test:**
`review: a failed durable skip remains frozen after another turn skips`

The test holds a real independent writer lock and proves that both skip writes
returned `false`. It releases the lock, restores the first user message as the
tail, and calls the actual runner with a now-successful search result. Expected:
frozen=true and the exact no-hint message array. Actual: frozen=false and a newly
appended full hint payload.

**Impact:** the frozen skip guarantee is narrower than "same-turn retries remain
replay-only": it holds only until another skipped message overwrites the latch.
Ordinary append-only continuations remain protected by the live-tail gate. The
counterexample specifically exercises branch/rewind semantics and failed durable
writes; it is not a claim that ordinary successful skip persistence is broken.

**Repair direction:** retain frozen skipped ids until durable persistence or an
explicit lifecycle decision makes replay impossible. Do not evict the only
remaining record of an unpersisted served skip on the next message.

### 4. P2 — Background skip writes can recreate a session after successful deletion

**Trigger:** a timeout/cold skip queues its unreferenced persistence worker, and
the session is deleted before that worker starts its SQLite work.

- `auto-search-deadline.ts:44-67` launches an untracked skip writer.
- `clearAutoSearchForSession` (`auto-search-runner.ts:457-460`), called from
  `hook-handlers.ts:467`, clears only the skip cache, not the writer.
- `auto-search-worker.ts:98-99` appends the skip unconditionally.
- `storage-meta-persisted.ts:1603-1608` ensures a row; the creation path in
  `storage-meta-shared.ts:381-386` has no deleted-session/generation fence.
- `storage-meta-session.ts:305-323` can have successfully completed cleanup before
  the background writer recreates that row.

**Failing test:**
`review: background skip persistence must not resurrect a deleted session`

The test seeds the row, queues real off-thread skip persistence, calls
`clearSession` and the runner cleanup hook, and verifies that no row remains.
After the worker finishes, `SELECT 1` returns a newly created row. The failure is
at the *second* absence assertion, not a backend null-versus-undefined assumption.

**Impact:** deleted session metadata and decisions can reappear after cleanup;
repeated session creation/deletion can accumulate orphan metadata. This is a
lifecycle/data-cleanup race, not evidence of an unbounded live Worker leak.

**Repair direction:** track/cancel pending writers at cleanup, and/or make late
writes conditional on the session incarnation still existing. The durable check
must also protect writes that have already started when cancellation happens.

### 5. P2 — Zero worker busy timeout changes successful hint bytes under a short backfill lock

**Trigger:** a sibling writer briefly owns SQLite's writer lock while an otherwise
warm auto-search backfills missing memory vectors. The existing owner connection
has a bounded busy timeout; the new worker sets it to zero.

- `auto-search-worker.ts:68-69` resets the search connection to
  `PRAGMA busy_timeout = 0` without adopting the owner's connection policy.
- `memory/embedding-backfill.ts:42-69,80-84` uses `BEGIN IMMEDIATE` and silently
  falls back to existing embeddings after the immediate lock failure.
- `search.ts:860-868` ranks the resulting hits as FTS-only instead of hybrid.
  The successful hint can therefore change even though the provider contract,
  query, corpus, and deadline all match.

**Failing test:**
`review: a successful worker hint must preserve legacy bytes across a short backfill writer lock`

The independent writer fixture releases 100 ms after provider completion. The
legacy `unifiedSearch` path (unchanged versus master) runs in the real
`withSqliteTransformPass` scope and waits under its 250 ms foreground acquisition
budget, then backfills successfully; the real worker cannot acquire the lock
and returns FTS fallback results. Two matching memories reverse bullet order.
Both top scores exceed the normal 0.6 threshold. The test deliberately waits for
the writer to finish before decision persistence to isolate search parity from a
second decision-lock failure; both decision writes are accepted and the actual
append helper produces differing serialized message arrays within the budget.
This is a search/write-stage composition test, not a whole host transform timing
benchmark.

**Impact:** contradicts unconditional successful-hint byte parity with master.
The immediate fallback is not reported as a pass degradation; a successfully
served altered hint is treated as healthy. It is not a frozen-prefix violation
on its first fresh-tail application, but it is a ranking/hint behavior change.

**Repair direction:** use a deadline-bounded writer acquisition policy that
preserves the ordinary short-lock behavior, or explicitly specify and test the
changed successful-hint fallback contract rather than claiming byte parity.

## Results for the remaining requested hunts

### Served bytes, replay, and thinking strips

The candidate's ordinary no-contention golden hint test passed. Its same-connection
late-search, late-commit, late-ack, concurrent-pass, and timeout/no-hint byte tests
also passed. Those tests do not cover the second-connection counterexample above.
The normal live-tail gate remains intact.

The new positive test in `transform-postprocess-phase.test.ts`,
`review: a served hint still strips signed thinking and its defer replay is byte-identical`,
uses the real runner and persistence path, mocking only the search executor and
registration snapshot. It appends a real hint, removes all eight signed blocks
on the eligible busting pass, and checks full role/part bytes against a fresh defer
replay. It passed. The existing
`timeout skips do not treat provisional hint rows as served prefix edits` test
also passed. I found no standalone regression in the new `autoSearchOutcome.ok`
gate for a successful hint: on success it is true and the pre-existing decision
count-delta rule still applies. Existing replay-only count-delta limitations were
not relabeled as candidate defects.

### LKG eligibility

`pass-outcome.ts:105-123` permits only finalized passes whose degradations are
all nonfatal `auto-search-timeout`; other and fatal sites remain excluded. Both
accessors and the mixed/fatal cases passed their existing policy test. On a single
healthy owner with replay complete, skipping an optional new-tail hint is a
faithful actually-served request, and capturing it is defensible. I did not find
an independent fail-open relaxation that captures a known managed-prefix failure.

However, finding 2 makes "replay complete" unsafe across owners: a reader can
accept a row that another owner never served, while a timeout owner captures
no-hint bytes. LKG policy does not validate hint acceptance and cannot repair this
ambiguity. Fix the decision protocol rather than using the new capture exception
as evidence that every shared-store request is a faithful replay baseline.

### Snapshot registration / first turn / configuration refresh

A cold turn now intentionally returns no hint, freezes an `empty` skip, and queues
registration (`auto-search-runner.ts:266-278`, Pi `auto-search-pi.ts:345-353`). That
is a real first-turn behavior change versus awaiting registration, not just a
performance optimization. The candidate report explicitly records parent approval
for this behavior, so it is not classified as an unapproved defect here. Startup
registration still exists; a normal already-registered first turn can hint.

A warm hint never calls the supplied registration callback. Thus configuration
changes are not polled by auto-search itself; absent another refresh, they can
remain stale indefinitely, including feature/provider changes. This is the other
explicitly approved behavior in the candidate report. Actual refresh sites are
broader than just tools: OpenCode history embedding calls registration at
`embed-history-runner.ts:65`, and dream/bootstrap paths also call it. There is no
new guarantee that one of those paths runs before the next hint. Background cold
registration still executes synchronous preparation on the owner after the stage,
so it moves, rather than eliminates, that potential event-loop stall.

### Worker lifecycle / bundling / WAL

The real generated entries and their real split chunks were exercised, not a
source replacement worker. Probes cover a real search with a held embedding RPC,
invalid-path startup failure, restart, accepted decision write, exact retirement,
an independent `BEGIN IMMEDIATE` conflict, and twelve further session searches.
Each worker is required to close its connection/port and exit without a caller
termination on the successful paths. Attribution and durable retirement are read
back from SQLite. They demonstrate ordinary startup, crash recovery-by-new-worker,
finite many-session cleanup, and zero busy-wait behavior. They do not prove that
arbitrarily long native SQLite calls are interruptible or that process-kill crash
recovery is safe.

The packaging probes use `npm pack --ignore-scripts`, extract the tarballs into the
throwaway root, and execute the worker **from the extracted package**, including
OpenCode 2's `dist/v2` entry. This checks the worker's reachable load graph without
relying on the repository's dist files remaining next to the extracted entry.
No package manifest or dependency changed in this review.

The standalone Node worker smoke is a runtime surrogate for Desktop's Node/Electron
SQLite backend, not an OpenCode Desktop application run. No `electron` executable
was available on PATH; I did not launch the Desktop application or claim Electron
loader/lifecycle coverage from a Node run.

## Containment and reproducibility

Live-store rule, verbatim: never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`).

All stores in this review were newly generated under
`$TMPDIR/magic-context/bg_a8d894f629e2c52f/`. Host worker children receive explicit
throwaway `HOME`, `XDG_*`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR`, and
`MAGIC_CONTEXT_LOG_PATH`. Actual Pi and exploratory OMP host launches additionally
isolate their agent config/session roots and inherit no API credentials. Package-test invocations use
a throwaway HOME and **unset**, rather than export, `OPENCODE_DB`.

During every held-query worker probe, `lsof -nP -p <owner-pid> -Fn` must see the
actual worker database path and every open `.db`, `.db-wal`, and `.db-shm` path
must be below that fixture's canonical root. It also rejects live OpenCode/CortexKit
configuration directory paths. For example, the verified Bun OpenCode probe
observed:

```
n/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/bg_a8d894f629e2c52f/mc-test-owned-bundle-oCef8b/context.db
```

The test prints runtime version, harness, check count and the observed `lsof` paths;
its generated `evidence.json` preserves the same record. These are fixture artifacts,
not copied live stores. No live logger was read or written in this review.

An exploratory OMP print-mode attempt did not deliver its `session_start` callback
and attempted a request with a **fixed synthetic prompt and a visibly dummy API
key**; OpenAI rejected it with HTTP 401. No user content, real credential, or live
store/config was used. Final host probes use extension-initialization execution,
RPC mode, and no prompt/input so a model request is not necessary. Actual Pi
completed all worker checks in that mode. Actual OMP's extension-initialization
attempt did not reach the worker and timed out at 60 seconds; its experimental
CLI-driver case is not retained as a claimed product regression. OMP attribution,
startup/restart/retirement, and the packed worker are verified under Node 24, but
**actual OMP extension-loader integration remains unverified**. Earlier probe
failures from inherited Node `--input-type`, macOS `/var` versus `/private/var`
path spelling, and a 30-second packing timeout were test-driver issues, not
product-worker findings; the corrected real-worker probes passed.

To run after building, with a disposable root:

```sh
root="${TMPDIR%/}/magic-context/bg_a8d894f629e2c52f"
mkdir -p "$root/home" "$root/config" "$root/data" "$root/cache" "$root/storage" "$root/runtime"
env -u OPENCODE_DB HOME="$root/home" XDG_CONFIG_HOME="$root/config" \
  XDG_DATA_HOME="$root/data" XDG_STATE_HOME="$root/data" XDG_CACHE_HOME="$root/cache" \
  XDG_RUNTIME_DIR="$root/runtime" MAGIC_CONTEXT_STORAGE_DIR="$root/storage" \
  MAGIC_CONTEXT_LOG_PATH="$root/review.log" bun run build:dists
# Same environment prefix for each of:
# bun test packages/plugin/src/hooks/magic-context/auto-search-bundle-review.test.ts
# bun test packages/plugin/src/hooks/magic-context/auto-search-deadline-review.test.ts
# The second command is expected to exit 1 and name the five review counterexamples.
```

The dist probes require built candidate dists. The installed Pi host probe skips
only if its executable is absent; missing Bun/Node coverage is visible the same
way. No mutation proof is claimed: the findings are direct red behavior/data tests,
not temporary product-code mutants.

## Verification record

Toolchain: Bun **1.4.2**, Node **v24.16.0**, TypeScript **5.9.3**, Biome **2.5.1**.
All commands below ran in the candidate-based review worktree with the containment
prefix above. Long test runs used background tasks followed by a blocking watch.

| Gate | Result |
| --- | --- |
| `bun run build:dists` | Passed: OpenCode 1, OpenCode 2, and Pi distributions rebuilt; worker entries emitted; 4 v2 server tests passed; dist load probe passed. |
| Plugin test run: `auto-search-bundle-review.test.ts`, `auto-search-deadline-review.test.ts`, `auto-search-bounded.test.ts`, `auto-search-runner.test.ts`, `pass-outcome.test.ts`, `transform-postprocess-phase.test.ts` | **301 passed, 5 failed, 306 total across 6 files.** Exactly the five named review counterexamples failed; all existing affected tests and the added positive thinking-strip/defer test passed. Exit 1 is intentional evidence against the candidate, not a green-suite claim. |
| Pi test run: `auto-search-bounded.test.ts`, `auto-search-pi.test.ts`, `context-handler.test.ts` | **174 passed, 0 failed**, 3 files, 673 assertions. |
| `bun run --cwd packages/plugin typecheck` | Passed: the repository's complete package TypeScript command, including script typechecking. |
| `bun run --cwd packages/pi-plugin typecheck` | Passed. |
| Plugin Biome check | Passed over 1,279 files; six existing warnings and two existing infos, no errors. Formatting/import organization changed only the new review files. |
| `git diff --check` | Passed. |
| Scoped AFT inspection | Partial: checkout call graph unavailable and no authoritative analyzer snapshot for all changed test files. The package TypeScript and Biome commands above are the authoritative diagnostics, not a claimed clean AFT result. |

The ten passing bundle cases are:

| Artifact | Runtime / harness | Worker executions |
| --- | --- | ---: |
| `packages/plugin/dist/auto-search-worker.js` | Bun 1.4.2 / OpenCode 1 | 18 |
| Same entry | Node 24.16.0 / OpenCode 1, Desktop backend surrogate | 18 |
| `packages/plugin/dist/v2/auto-search-worker.js` | Node 24.16.0 / OpenCode 2 | 18 |
| `packages/pi-plugin/dist/auto-search-worker.js` | Node 24.16.0 / Pi | 18 |
| Same entry | Node 24.16.0 / OMP attribution | 18 |
| Extracted OpenCode npm tarball | Bun 1.4.2 / OpenCode 1 | 18 |
| Extracted OpenCode npm tarball, `dist/v2` | Node 24.16.0 / OpenCode 2 | 18 |
| Extracted Pi npm tarball | Node 24.16.0 / Pi | 18 |
| Same extracted Pi tarball | Node 24.16.0 / OMP attribution | 18 |
| Pi entry loaded by a probe extension in the actual `pi` CLI | Node 24.16.0 / Pi | 18 |

Total: **180 real bundled-worker executions**, including 120 repeated-session
searches, with lsof containment checks on the held query RPCs. This is not 180
whole-product host sessions. Actual OMP loader and Electron/Desktop app execution
remain the disclosed coverage gaps. Workspace-wide/full package suites were not
run; this is a test/report-only review and the affected behavioral families were
run explicitly. No dependency installation was needed: the candidate changes
build scripts but not dependency versions or the lockfile, and the prepared
worktree installation was retained.
