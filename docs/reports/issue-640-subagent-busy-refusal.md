# Issue 640: a refused OMP subagent turn is not a recoverable resend

Investigation date: 2026-10-08. Product revision: `6c8637a10bd9bf52bc6398047aff985651dbfbfb` (master, Pi package **0.46.1**). Incident source comparison: tag `v0.45.0`. **Report only; no product, schema, configuration-default, or dependency changes are proposed as already implemented.**

## Findings and design recommendation

1. **Reproduced on the actual OMP 18.8.5 CLI**, not a simulated extension API. A separate Python process holding the disposable `context.db` writer for 60 seconds caused four refused child requests, three real OMP reminders, four empty aborted replies, `session_exit {reason: "dispose"}`, and a parent result with `status="cancelled"` / `Interrupted by user`. The child made **zero provider HTTP requests**. Shorter 0.46 holds do not change this failure mechanism when a writer outlasts the retry ladder.
2. There are **two demonstrated false-rejection mechanisms on this OMP version**:
   - Full-object LKG input hashing includes late `completedAt` and `contextSnapshot` bookkeeping. A real parent prefix changed only in those fields, yet was rejected as `lkg_content_mismatch`. OMP's actual Anthropic conversion produces **identical message bytes** with and without those changes.
   - OMP's `getAllTools()` returns callable schemas for built-ins. The current fit-envelope reader requires an object. Calling that reader on the **real child API** returned `undefined` (first rejected tool: `read`, `parametersType="function"`). Thus even a content-valid LKG can reach `raw_fallback_refused completeness=partial`. Waiting for more turns does not repair either incompatibility.
3. `pi_compaction_queue` is **fallback-tag identity adoption**, not a queue awaiting a model or a historian. The old admitted loop probed every historical fingerprint. Master batches the candidate discovery but still performs atomic rekeys/collision folds under the writer. A matched synthetic fixture shows substantially shorter holds, but does **not** reproduce the reporter's exact 2.2 seconds on their 1.6 GB Linux store.
4. Recommended design order, subject to approval: repair the demonstrated LKG projection/envelope incompatibilities without weakening real content/model/reshape fences; then give trusted non-resendable turns a **bounded, yielding, acquisition-only writer wait**; continue shortening foreground work. Do **not** adopt `no LKG => raw` as a safety predicate. A genuinely fresh, exclusively owned, never-managed session can support a narrowly defined first-pass exception, but absence of an LKG or a small usage percentage alone cannot establish that condition.
5. OpenCode's ordinary task children are also non-resendable at a refused turn. They are less exposed to a 2.2-second writer because the plugin already has a separate ~16.5-second asynchronous privileged preflight. That is mitigation, not immunity. Neither inspected OpenCode task implementation promises to resend a plugin-refused prompt.

## 1. Real-host reproduction and isolation

### What was run

Host: **OMP 18.8.5**, Bun **1.4.2 (744846f84)**, macOS arm64 / Darwin 27.0.0. This is a real OMP-host reproduction of the reported lifecycle, **not a Linux filesystem or 1.6 GB load reproduction**. OMP was installed in this worktree's ignored `.cache/issue-640/host`, pinned to the incident version. The built 0.46.1 extension came from this worktree's `packages/pi-plugin/dist/index.js`. It was not loaded from the operator's installation.

The provider was the existing local Anthropic mock (`packages/e2e-tests/src/mock-provider/server.ts`), bound to `127.0.0.1`; no paid provider or real key was used. It instructed the parent to call OMP's real `task` tool, with `async.enabled=true`, `task.batch=false`, no worktree isolation, and the child model pinned to `mock/mock-model`. The child's successful control response calls its real `yield` tool with `{data: "control completed"}`. Native compaction was disabled in host settings; Magic Context remained enabled. Memory/embedding work was disabled to isolate contention. The mock context window was 1,000,000 tokens, max output 8,192. Mock usage numbers are not asserted as real token accounting.

The fixture initializes the current schema before starting OMP (the existing `prepareContextDatabase` helper). This avoids an unrelated running Pi process preventing a migration on an obviously disposable database. It creates **no repository-root `context.db`**. A fixture extension registered **before** Magic Context observes the child's `parentSession`, then, at its first context hook, starts an independent native Python SQLite connection:

```python
import sqlite3, sys, time
c = sqlite3.connect(sys.argv[1])  # explicit throwaway context.db
c.execute("BEGIN IMMEDIATE")
print("LOCKED", flush=True)
time.sleep(float(sys.argv[2]))
c.rollback()
```

The hook awaits `LOCKED` before allowing the unmodified product context handler to execute. OMP itself spawns the child, creates the reminders, records the aborted replies and disposes it. The fixture does not manually append a reminder, call abort, or manufacture a cancelled task result. The task child's extensions run in the same OMP process, so the host PID's descriptor check covers its Magic Context handle too.

### Live-store rule and proof

**never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`)**

No live store was copied either. Each host invocation, including setup experiments, used a separate fresh root under:

```text
<worktree>/.cache/issue-640/tmp/omp-e2e-<random>/
```

Before launch, `HOME`, `CFFIXED_USER_HOME`, `PI_CODING_AGENT_DIR`, all XDG data/config/cache/state/runtime locations, `OPENCODE_DB`, and `MAGIC_CONTEXT_STORAGE_DIR` were redirected using `packages/e2e-tests/src/pi-runner/spawn.ts:261-284`. The project directory was that root's `work/`, not the operator's project. `TMPDIR` pointed into the worktree; the existing runner's native extraction cache also remained there. `MAGIC_CONTEXT_LOG_PATH` was per-fixture in subsequent runs (the first baseline used the isolated extraction-cache log). Version invocations received the same isolated environment.

`/usr/sbin/lsof -p <hostPID>` was captured before the prompt, during the long-held writer, and after the result; the locker's descriptors were captured while it held the transaction. The baseline's relevant actual descriptors, with only the repeated worktree prefix abbreviated:

```text
bun    64335  23u REG ... <worktree>/.cache/issue-640/tmp/omp-e2e-e4to7L/data/cortexkit/magic-context/context.db
bun    64335  24u REG ... <worktree>/.cache/issue-640/tmp/omp-e2e-e4to7L/data/cortexkit/magic-context/context.db-wal
bun    64335  25u REG ... <worktree>/.cache/issue-640/tmp/omp-e2e-e4to7L/data/cortexkit/magic-context/context.db-shm
Python 65721   3u REG ... <worktree>/.cache/issue-640/tmp/omp-e2e-e4to7L/data/cortexkit/magic-context/context.db
```

The host also had OMP's `agent.db`, `models.db`, `skill-descriptions.db`, and extension-cache database open, **all below the same disposable root**. Across **35 lsof snapshots from 12 OMP process launches**, searching all descriptor paths for the operator's four protected live prefixes found **zero matches**. This is positive descriptor evidence plus launch-time path isolation; an lsof snapshot alone is not a historical syscall audit of every already-closed file.

| Root suffix | Host PID | Locker PID | Purpose / disposition |
| --- | ---: | ---: | --- |
| `e4to7L` | 64335 | 65721 | Shipping 0.46.1, 60 s hold; decisive refusal/disposal reproduction |
| `QZTml7` | 38698 | — | Corrected unlocked successful yield control |
| `db2xcW` | 52691 | 53113 | Shipping 0.46.1, 2.2 s hold |
| `bsCOby` | 4880 | 5471 | Explicit verified-empty first-context bypass, 60 s hold |
| `PBb4TJ` | 15960 | 17306 | Original product bundle + acquisition-only preflight, 2.2 s hold |
| `PEWUqo` | 32627 | — | Current fit-envelope reader called on actual OMP APIs |
| `g35coL` | 35062 | — | Unlocked API type observation |
| `tjRgXm` | 24740 | — | Excluded setup attempt: mock did not recognize OMP's `_task` wire name |
| `afk8xq` | 20847 | — | Excluded setup attempt: invalid `yield` argument; not a storage refusal |
| `Pn95F1` | 59705 | — | Excluded 80 ms trial: locker exited before its lsof snapshot; cannot establish in-hook admission timing |
| `2YJaOT` | 41304 | 41593 | Excluded bypass prototype: wrong pending-table name caused a fixture exception |
| `FCjN0F` | 39179 | 39617 | Earlier preflight trial re-bundled the extension; superseded by original-bundle `PBb4TJ` |

The excluded runs are not evidence of policy success. Their host lsof snapshots still establish throwaway-store use. No installed `omp`, `pi`, or `opencode` command was launched with its default live HOME.

### The refusal chain on 0.46.1

Child ID: `01a11c4d-dcdc-72e6-9d3f-e97c3869135a`. Parent ID: `01a11c4d-d94d-75bf-b66b-1b8cc40373d7`. OMP's child session header contained `parentSession` pointing to the disposable parent JSONL.

| UTC | Observed event |
| --- | --- |
| 16:17:07.336 | Child session starts |
| 16:17:07.351 | Child's first context; one assignment message |
| 16:17:07.727 | Fixture has acquired independent writer; host/locker lsof captured |
| 16:17:07.980 | `BEGIN IMMEDIATE lane=foreground acquire_ms=251 attempts=1 outcome=busy` |
| 16:17:07.983 | `LKG unavailable (lkg_entry_ids_unavailable); refusing unreduced 1-message input`; `turn refused` |
| 16:17:07.992 | Empty assistant, `stopReason="aborted"`, zero usage |
| 16:17:18.421 | Reminder 1 / 3-message input refused: `lkg_miss` |
| 16:17:33.740 | Reminder 2 / 5-message input refused: `lkg_miss` |
| 16:17:44.054 | Reminder 3 / 7-message input refused: `lkg_miss` |
| 16:17:54.062 | Child JSONL records `customType="session_exit"`, `reason="dispose"`, `kind="normal"` |
| 16:17:54.063 | Observed child `session_shutdown` |
| 16:17:54.111 | Parent's host-started result-consumption turn enters context |
| 16:17:54.370 | Parent also refused (`lkg_content_mismatch`) while writer still held |

The child JSONL has four `magic-context-turn-refused` display entries and four empty aborted assistant entries. Its actual OMP reminder text includes `Last turn had no tool call → session idle. Reminder 1 of 3.` (then 2 and 3). Parent delivery:

```text
<task-result id="Busy640" agent="task" status="cancelled" duration="46.8s">
<abort-reason>Interrupted by user</abort-reason>
<output>
(no output) after 4 req
</output>
</task-result>
```

OMP's `4 req` is an attempted-request count: the HTTP mock recorded **zero child requests**. Its two recorded requests were the parent's initial task call and immediate follow-up. The word `normal` in the disposal record describes teardown, not successful assignment completion.

The reproduction's first context contains one message rather than the reporter's three, and initially cannot map a stable JSONL entry. That difference changes the first diagnostic from `lkg_miss` to `lkg_entry_ids_unavailable`, not the lifecycle outcome. On each reminder the reason is `lkg_miss`. No inference about the reporter's omitted first-pass entry alignment is needed.

OMP source, pinned 18.8.5 (`@oh-my-pi/pi-coding-agent/src/task/executor.ts:2308,2440-2500`), permits three yield reminders. It skips them for `stopReason="error"`, **not** `aborted`. The terminal aborted-reply interpretation is at `:2593-2605`; teardown calls `session.dispose()` at `:3353`. Those paths match the real transcript. Product refusal is `packages/pi-plugin/src/pi-context-refusal.ts:33-65`: log, append a display-only entry, **abort the operation signal**, return the host messages. Throwing alone would be unsafe because Pi-compatible extension runners catch context exceptions. A provider request may still be constructed after abort; the measured baseline did not dispatch one for the child.

### Do shorter holds change the outcome?

They change incidence, not the terminal refusal contract. A single 2.2-second external writer on shipping 0.46.1 (`db2xcW`) caused **one initial refusal**, then the first reminder ran after release and yielded successfully (`completed`, 2.6 s). That does **not** make refusal costless: recovery depended on the host creating a later reminder while still holding the original assignment in history. The sustained 60-second lock killed the child. Several shorter, overlapping writers across projects can expose every reminder, even though no individual holder spans the whole ladder.

A small fresh store intentionally held externally is a mechanism test. It neither estimates production refusal frequency nor demonstrates how often 0.46's maintenance improvements prevent an unlucky overlap.

## 2. Exact LKG rejection paths and their safety

All following repository line references are to the master revision above. The common Pi path is:

- Snapshot the **pristine incoming** messages and stable entry IDs before reduction: `packages/pi-plugin/src/context-handler.ts:2605-2640`.
- On a failed managed pass, try LKG unless compaction is off or emergency recovery is armed: `:4161-4172`.
- Validate prefix + tail, then fit the complete replay: `:4173-4190`.
- Log rejection / throw `PiStorageBusyError`: `:4201-4225`.
- Guarded registration aborts the real host operation: `pi-context-refusal.ts:33-65`.

The standing recovery policy remains **LKG replay, then backed-off BEGIN IMMEDIATE acquisition retries, then a visible refusal; never unreduced raw under contention**. There is an important implementation distinction: today's Pi path first spends the synchronous aggregate 250 ms admission allowance **inside the pass**, then tries LKG at its error boundary, and otherwise refuses. It does not have OpenCode's separate yielding preflight. `packages/plugin/src/shared/sqlite.ts:632-650,678-680,726-794` bounds admission, not hold time or whole-turn wall time. No report-only experiment below installs a new product recovery order.

| Reporter class | Exact Pi / shared path | Verdict |
| --- | --- | --- |
| `lkg_miss` | `pi-lkg.ts:497-510`: no slot after snapshot preparation; `:640-644` also covers absent replay anchor/tail. Slots are held/hydrated by shared `lkg-slot.ts:564-576`; durable loads are `lkg-persist.ts:309-358`. | **Correct** for a truly new session: no reduced request exists to replay. Does not prove raw is unsafe or safe; it proves replay is unavailable. A missing slot in a resumed/mature session requires capture/eviction/hydration diagnostics. |
| `lkg_model_mismatch` | Pi contracted-suffix branch `pi-lkg.ts:648-656`; ordinary replay delegates at `:693-710` to shared `lkg-replay.ts:644-651`, which canonicalizes model/provider keys and drops the slot on mismatch. | **Correct conservative refusal for a real route/model change.** Model-specific window, calibration and signed-thinking binding cannot be borrowed indiscriminately. Text-only bytes could sometimes be portable after fresh validation, so a mismatch is not proof that every conceivable replay is inherently unsafe. No actual reporter model pair is supplied; an alias/metadata-only mismatch would be a false rejection, not justification to remove the gate. |
| `lkg_content_mismatch` | Pi suffix digest comparison `pi-lkg.ts:668-675`; ordinary prefix comparison in shared `lkg-replay.ts:662-664` / `entryContentIsValid` at `:453-458`. Snapshot fields come from `pi-lkg.ts:418-450`; shared `lkg-slot.ts:230-278` hashes **all enumerable message fields**, except the explicitly normalized empty OpenCode user diff summary at `:166-189`. | **Correct for changed provider content; false for the demonstrated OMP bookkeeping-only change.** Mere tail append is already accepted; it is not compared as old-prefix content. Do not disable this check for edits/reverts or changed tool results. |
| `lkg_invalidated_reshape` | Pi `beginPass`, `pi-lkg.ts:512-537`, cannot find the saved anchor; replay drops it at `:633-637`. Suffix survivors must be contiguous and exactly cover the retained saved suffix (`:657-667`). Shared replay requires the anchor at the saved prefix length and exact ID sequence (`lkg-replay.ts:653-660`, `entryIdsAreValid` at `:438-451`). Shared missing-slot replay also returns this reason at `:643`. | **Correct for a lost/replaced anchor or interior gap**: reintroducing removed instructions/tool results would undo the host reshape. **A head-only contraction is not inherently unsafe**: Pi already supports it when persisted output ownership is complete (`pi-lkg.ts:676-690`). Without the reporter's before/after IDs, one cannot label their reshape a false rejection. Stable-ID misalignment or a newly unmapped injected entry can also trigger this conservative fence. |
| `raw_fallback_refused completeness=partial` | A **successful LKG validation** reaches `context-handler.ts:4175-4190`; `pi-raw-fallback.ts:332-345` refuses an absent/incomplete envelope or unknown limit; `:405-408` separately names unavailable tokenizer. Host metadata reader: `pi-lkg-fit-envelope.ts:24-49,52-87,130-148`. Shared sizing/calibration is used through the imports at `pi-raw-fallback.ts:1-12` and `:410-419`. | **Correct when fit really is unobservable**, even if a byte-sized message looks tiny. **False unavailability on real OMP's callable tool schemas**: the registry can describe the provider's tools, but this reader cannot consume its representation. This is an adapter problem, not permission to omit tools from the bound. The diagnostic's historical name does not mean a raw busy fallback was served or attempted. |

### The content mismatch is not caused by appending messages

The baseline parent's second successful context had three inputs; its later busy context had five. Compare the first three **incoming, pre-MC** messages of the latter with the earlier incoming array. Exactly two fields differed on the task-call assistant:

```text
completedAt: absent -> 1791476227227
contextSnapshot: absent -> {promptTokens:1000, nonMessageTokens:11922, compactionEpoch:0}
```

No role, text, tool name, tool arguments, result, usage, model, provider or timestamp changed. OMP stamps completion time at `@oh-my-pi/pi-coding-agent/src/session/agent-session.ts:3824-3835`, and adds the context snapshot during persistence at `:3513-3525`. Those are late local statistics, not conversation instructions.

The investigation fixture feeds these actual detached arrays to the current `createPiLkgCoordinator`. It rejects them as `lkg_content_mismatch`. Removing **only those two newly added fields** from the new prefix makes it accept the exact saved prefix + untouched appended tail. More importantly, the real OMP 18.8.5 `@oh-my-pi/pi-ai/src/providers/anthropic.ts:5136` `convertAnthropicMessages` was run on both prefixes with the actual fixture model: serialized converted arrays are **identical**. That validates the false-rejection conclusion against the host's converter rather than a hand-written projection.

This is demonstrated on the parent's mature, already-served prefix. It is a concrete mechanism available to subagents too, not proof that those exact fields caused T13SettingsCentre or T5SupplyModels in the reporter's run. A future repair should project verified provider-relevant fields consistently at capture and validation, and test late metadata separately from actual content edits. Ignoring every unfamiliar field would be an unsafe generalization.

### Partial completeness still occurs on current OMP

In real child `PEWUqo`, the host returned 23 tool definitions: 17 callable schemas, 6 object schemas. The current reader's first rejected definition was `read`, whose `parameters` is a **function**. Direct observation using the current exported reader:

```json
{"type":"envelope_observation","child":true,"registrySize":23,"firstRejected":{"name":"read","parametersType":"function"},"envelopeDefined":false}
```

The host system prompt is an array, but **that is supported**: `packages/pi-plugin/src/host-system-prompt.ts:10-19` joins string segments. The blocker is the schema representation at `pi-lkg-fit-envelope.ts:45-49`, before the tokenizer/size checks. OMP's real registry returns each `tool.parameters` unchanged (`@oh-my-pi/pi-coding-agent/src/session/session-tools.ts:734-754`). The provider does have a schema-conversion path (`@oh-my-pi/pi-ai/src/providers/anthropic.ts:6121`, `convertTools`). A future adapter should use the host's supported wire-schema representation, not call a validator as though it were a zero-argument schema factory or silently count `{}`.

The archived **0.45.0** handler already calls `readPiLkgFitEnvelope` in its replay fit path (`context-handler.ts:4037-4051` at that tag). Thus the earlier, historical issue-601 four-argument wiring defect described in `issue-601-background-writers.md` is **not** sufficient to explain this particular release's OMP `partial` observations. A usable prefix can still be refused because complete tools cannot be priced on this host API.

### Why 32–287 prior turns did not guarantee a usable LKG

A saved request is not an append-only transcript backup. It pairs exact **input identities/digests** with exact **served output bytes**, model/provider, and an anchor. Pi captures successful managed passes at `context-handler.ts:4086-4112`, including SOFT/SOFT+; `pi-lkg.ts:719-965` detaches the snapshot, schedules capture, installs the slot and persists it. The latest saved slot normally exists after an applied pass. Fixture histories of **32, 71 and 287 assistant turns** replayed successfully after a plain append. Long history by itself is not a miss condition.

But on a busy pass:

- A model change invalidates the old slot until the first successful capture for the new route. Many old turns do not validate current-model replay.
- **One old-prefix field changing is enough**, irrespective of total turns. Late OMP statistics can invalidate an otherwise good slot; the real reproduction demonstrates that defect.
- Native compaction, fork/revert, changed entry mapping, or a materialized representation can move/remove the anchor. Head contraction with valid ownership is supported; arbitrary reshape is not.
- A cache-busting capture drops stale replay authority immediately until replacement capture lands (`pi-lkg.ts:836-849`). Failed serialization/capture/scheduling forces another synchronous capture (`:754-764,926-962`). Heap limits are 24 MiB per slot / 64 MiB aggregate (`lkg-slot.ts:31-33,423-486`), with durable hydration, not unlimited process memory.
- Even a validation-successful slot needs a current complete model/system/tools bound. OMP's callable-schema mismatch makes that fail independently of history length.
- Shared model/content/reshape rejection drops the in-memory slot. Durable clear is best-effort (`lkg-slot.ts:588-600`, `lkg-persist.ts:292-305`); under the same busy writer it can fail, leaving a stale durable slot which is hydrated and rejected again. Repeated identical rejection reasons do not prove four independent model switches or four new content edits.

The issue supplies reason counts, not the rejected model pairs, prefix digests/fields, or branch IDs. It cannot establish which specific condition affected each production session. The six losses are adequately explained as **availability failures at a refusal boundary with no resender**, with demonstrated adapter defects reducing replay availability. It would be unjustified to claim all five rejection classes were valid, or all were false.

## 3. What holds the writer in `pi_compaction_queue`?

The site label is in `packages/pi-plugin/src/context-handler.ts:2128-2143`, an immediate transaction helper. Its sole production caller in this file is `adoptPiFallbackTags` at `:2242`. Timing starts **after successful BEGIN**, and includes COMMIT, not acquisition waiting. The same named helper exists in 0.45.0 (`:2100-2114`).

Before the transaction, the pipeline builds raw message identity fingerprints (`context-handler.ts:2002-2067,5989-6009`). It checks for fallback message/tool-owner rows. The transaction then:

1. Discovers fallback message tags whose raw fingerprints now map to real JSONL IDs, rejecting ambiguous duplicate fallback bases.
2. Rekeys `pi-msg-*:pN` text tags to real `entry:pN` identities; folds collisions while preserving served tag identity/drop decisions and MAX token/byte accounting; retargets dependent pending operations.
3. Builds `(timestamp, callId) -> real assistant owner` mappings, resolves fallback tool-owner tags, rekeys/folds them and refreshes tagger aliases/accounting.

Shared row lookup/mutation is in `packages/plugin/src/features/magic-context/storage-tags.ts:1148-1163,1733-1820` and the collision-fold helpers preceding it. `adoptPiFallbackToolOwnerTag` specifically preserves an already-served real-owner row's number at `:1772-1779`. There is no provider call, embedding inference, sleep, model prompt construction, or compaction render in this callback.

**0.45 versus master:** the old message branch queried `findAdoptableFallbackTags` once for every real historical fingerprint while holding the writer (0.45 `context-handler.ts:2171-2182`). Master first discovers matching fingerprints in <=900-parameter batches (`context-handler.ts:2182-2207`), then skips every absent fingerprint before the per-row atomic migration (`:2243-2257`). This is already-shipped shortening, not a change made by this investigation.

### Matched fixture measurements

Synthetic **file-backed WAL** stores with production schema / `busy_timeout=5000`, on the macOS machine above. Each arm has N real message-tag rows, N+1 raw fingerprints and one newly resolvable fallback tag. No tool-owner branch or collision backlog. Three fresh stores per arm/size; after each measurement the expected real-ID row and original tag number are checked.

The baseline is a **v0.45 message-loop-shape fixture using the same shared adoption helpers**, not a full old-package host run. The other arm calls master's actual exported test seam for `adoptPiFallbackTags`. Both clocks measure successful BEGIN through COMMIT; setup/seeding and preflight are excluded from hold time. Thus it isolates the admitted full-map probing cost without pretending to benchmark every 0.45 subsystem.

| Historical rows N | 0.45 loop holds (ms) | Current actual holds (ms) | Fingerprint SQL calls under writer, old -> current |
| --- | --- | --- | --- |
| 2,400 | 27.71 / 28.40 / 23.01 | 4.42 / 13.98 / 1.94 | 2,401 -> 4 |
| 9,600 | 88.79 / 101.56 / 106.83 | 11.32 / 16.51 / 8.64 | 9,601 -> 12 |

Median hold: **27.71 -> 4.42 ms**, **101.56 -> 11.32 ms**. Current median whole-call time, including preflight, is **9.16 / 19.74 ms** at the two sizes. Fewer calls under the writer are causal evidence of reduced admitted work; these small, mostly warm stores do **not** account quantitatively for 2,190 ms on the reporter's disk. Cold pages, a much larger tag/index working set, many genuine adoptions/collisions, tool-owner work, COMMIT/checkpoint or filesystem scheduling can still extend a hold. No production query plan or exact callback phase timing was supplied.

### What can move outside the lock?

Pure raw-message fingerprinting is already outside. Building the tool-owner map, de-duplicating fingerprint batches and materializing placeholder strings can also be prepared outside; they depend on immutable pass input, not current database authority. Candidate discovery may be advisory outside, but **must be revalidated after acquisition**. A negative preflight can race a sibling's new fallback tag; skipping without a fresh check would allocate a second number or miss an existing drop.

The authoritative candidate set, uniqueness/collision decisions, guarded row rekeys, MAX accounting, pending-op retargets and corresponding tagger alias publication must stay coordinated with the atomic database mutation. Moving all adoption to a detached job or splitting a live collision fold can expose inconsistent owners/drop state during tagging. Arbitrary row caps also require a rule preventing the unadopted remainder from receiving new duplicate tags on that pass. Measure the tool/collision phase before promising a 100 ms cap. Shortening holds is safe work reduction, not permission to weaken publication or replay consistency.

## 4. The three proposed policies

### (a) Fail open only when there is nothing to protect

**Not safe as written** (`no LKG and no applied drops/compartments`). LKG can be missing through restart, failed capture, eviction or invalidation. There may already be served §N§ tags, reduction decisions, pending operations, a materialization/recovery barrier, or a larger system/tool envelope than the message-only percentage suggests. A failed pass may also have committed tags before its later write failed. Using its partially mutated array is not equivalent to the pristine input.

A potentially safe exception is **before the very first managed attempt for an exclusively owned, freshly created, non-forked/non-resumed session**, and requires all of:

- Trustworthy host provenance that this session has never served managed tags, a managed system prefix or any managed request; no inherited decisions from parent/fork/resume. `parentSession` indicates non-resendability, **not** absence of inherited state.
- No durable or in-memory drop, compartment, removal/strip, pending operation/marker/materialization or emergency/overflow/checkout-claim barrier. Establish this with fresh-session exclusive ownership or previously validated monotonic authority, not a stale read made while an unknown other writer may be creating protection state.
- Bypass **before** any product mutation/partial commit; the outbound array must be a detached pristine host request, with valid tool seams/reasoning binding and no duplicate stable identities.
- A complete current request envelope and known current usable hard limit, including system, actual active tool schemas, images/non-text handling, host/provider additions and output reserve. Both conservative calibrated mass and serialized-byte checks need ample margin. The reporter's 39,108 / 922,000 message usage is suggestive, not an envelope proof.
- Record that raw was actually served and require the next healthy pass to reconcile from that fact. Never mark the bypass as a successfully reduced capture. Bound exceptions and provide cancellation/telemetry; do not generalize to an arbitrary resumed session with an empty LKG heap.

**Cache/tag consequences even in the safe case:** no existing managed prefix is sacrificed on the first provider call. However, the next healthy pass introduces tags/system scaffolding into the previously raw prefix, so it can rebuild the provider cache. Delayed tagging can shift allocation order relative to concurrent/pending tags. Do not promise identical §N§ numbering or skip token accounting merely because the previous request was untagged; preserve actual served numbers, adopt fallback identities atomically and suppress reduction tools until an authoritative namespace exists. After even one managed serve, raw fallback is again prohibited. A window overestimate can still produce a provider overflow; unknown/partial envelopes must refuse, not borrow the mock fixture's large limit.

**Measured effect:** fixture-only `bsCOby` bypasses exactly the first child context registration, before calling the product handler. It explicitly checked zero rows in `tags`, `lkg_slots`, `compartments`, `pending_ops`; pristine input was 191 serialized bytes. With the 60 s writer still held, one child HTTP request was dispatched ~319 ms after initial context observation (~6 ms after the lsof/check stage), the child yielded and was reported `completed` after 20.6 s, with **no child refusal/reminder**. The **parent still refused** on result consumption. Several out-of-transform message-end bookkeeping writes waited their connection timeout, so this is not a 319 ms whole-task latency guarantee.

This experiment demonstrates availability gained by a raw first pass, **not a production-safe predicate implementation**: its closed fixture proves fresh ownership, its mock always accepts the request, and it does not prove complete real-provider envelope fit. On real OMP the current fit reader is partial, so these conditions cannot presently be certified through that reader. Recommendation: do not relax the standing rule yet; decide the first-pass exception only with an explicit authority/envelope contract.

### (b) Longer backed-off acquisition when nobody will resend

This preserves the standing safety rule and is the preferred availability improvement. Trusted OMP `parentSession` can select a child budget. Host-started primary turns (async-result delivery, continuation/reminders) have the same need; detecting them must use host-provided provenance, not a substring in user text. When provenance is unavailable, a uniform bounded yielded preflight is less speculative than guessing from conversation contents.

Safety requirements:

1. Try an admissible LKG first, with current fit and emergency fences. If unavailable, retry **only `BEGIN IMMEDIATE`**, before invoking a mutating callback. Do not rerun the whole transform or retry COMMIT/failed callbacks.
2. Yield between short native attempts; respect abort/deadline; bound the total wait rather than restarting the budget on every contention error. Existing shared `withAsyncPrivilegedWriter` (`sqlite.ts:873-917`) provides 25 ms native attempts and 500/1,000 ms backoff with ~16.5 s total acquisition allowance. That is a candidate policy reference, not a chosen Pi budget in this report.
3. Recheck session state, source identities, pending work and barriers after admission. Keep the callback synchronous/atomic; never sleep while holding the writer or leave connection-local busy_timeout changed across an await.
4. An empty preflight followed by releasing the writer is **not a lock reservation**. Another writer can take it before actual work. A production design must acquire at the real transaction boundary or safely decline a later busy write without replaying partial work.
5. On exhaustion retain guarded host abort + visible refusal. OMP swallowing an unguarded preflight exception would accidentally fail open. A bounded longer wait reduces losses; it cannot guarantee success under unbounded contention, and may delay cancellation if implemented without signal checks.

No raw overflow or cache rebuild is introduced if a fresh managed pass eventually succeeds. Waiting can make existing pending work stale and cause different, but authoritative, tag allocation/compaction on admission; the normal revalidation must account for it. Synchronized siblings can herd at the same backoff cadence; jitter/fairness and shared-store writer load need consideration.

**Measured effect:** `PBb4TJ` wraps the original built product registration in a fixture-only first-child-context preflight. It invokes the existing shared `withAsyncPrivilegedWriter(db, () => undefined)` on the disposable store, then calls the original callback once. Against the same 2.2 s external writer, preflight waited **2,589.95 ms**, the child made one provider request and yielded on its first attempt, **zero child refusals/reminders**, task result `completed` in **3.4 s**. Shipping policy's matching-size external hold (`db2xcW`) refused once and recovered via a reminder in 2.6 s. The backoff can be slower than a fortuitous reminder; its advantage is avoiding loss of the original operation, not always minimizing wall time.

This trial establishes acquisition-only recovery for a releasing writer. It does not measure a production LKG-first implementation, cancellation, fairness, or retake races. A 60 s hold exceeds the candidate ~16.5 s budget and would still require a loud refusal; no guaranteed rescue is claimed.

### (c) Shorter foreground holds

Keep this work regardless of the policy choice. The queue fixture above measures an already-shipped reduction in actual admitted work. Precompute pure input work outside the lock; revalidate authoritative state and publish related changes atomically inside. Remaining large adopted/collision sets need phase measurements rather than an assumed cap.

**Safety/cost effects:** fewer held milliseconds do not relax fit or LKG validation and should not introduce raw cache rebuilds. Unsafe reordering of tag allocation/adoption can renumber served tags or resurrect drops; splitting atomic collision/pending-op updates can expose wrong tool ownership. A faster writer still cannot service unlimited concurrent demand. Disk/COMMIT pauses are not hard-bounded by a row count.

**Measured effect on this reproduction:** 0.46.1 is the baseline that still loses the sustained-lock child. A 2.2 s hold permits reminder recovery; shortening the real queue's matched fixture hold from ~102 ms median to ~11 ms median reduces occupancy but cannot remove an independent 60 s external lock. The excluded 80 ms run is not used to claim in-hook timing, because lsof instrumentation outlived that locker. Existing installed-handler bounded-background tests are listed below. No production refusal-rate improvement or exact 2.2 s elimination is asserted.

## 5. OpenCode comparison

Ordinary user-requested task children are **not** MC's hidden historian/dreamer children. Internal-child bypasses must not be generalized to them. They have a managed context pass and may have no LKG on their first request.

**OpenCode 1:** versioned host source **v1.18.0**, `packages/opencode/src/tool/task.ts:186-199`, resolves and prompts the child once. Its background job wraps that run (`:259-272`), and result handling surfaces error/cancelled (`:309-319`) or injects background results into the parent (`:202-239`). There is no refusal-specific resend in that task path. The plugin's `packages/plugin/src/plugin/messages-transform.ts:366-387` snapshots LKG entry then performs `withAsyncPrivilegedWriter` preflight before managed transformation. On propagated failure it attempts validated replay (`:484-561`), otherwise storage refusal (`:587-605`). `packages/plugin/src/index.ts:976-986` notifies and confirms session abort. A child request can therefore fail without anyone resending, just without OMP's particular three-reminder disposal ladder.

**OpenCode 2:** tagged source **v2.0.22** calls the analogous tool `subagent`, not `task`: `packages/core/src/tool/plugin/subagent.ts:203-217` prompts a child, then starts its job (`:220-227`). Failure/cancelled outcomes surface with the child session ID (`:245-251`); continuation requires another explicit call using that ID. `packages/core/src/session/subagent-job.ts:37-53` resumes the child and reads a terminal assistant; it does not implement a storage-refusal resend loop. The product adapter at `packages/plugin/src/v2/hooks/context.ts:1754-1762,1817-1857` uses the shared managed path / replay, plus a recorded notice and `refuseBeforeProvider`; interruption confirmation is in `v2/hooks/refusal.ts:29-49`. Its hidden-child fast path at `context.ts:1322` is separate and does not exempt ordinary subagents.

Thus **same availability exposure, different mitigations/lifecycle**. A 2.2 s writer normally fits OpenCode's separate yielding ~16.5 s preflight; a longer hold, a later in-pass write failure, an unusable LKG, or a recovery fence can still end the host-started child operation. Parent-result delivery is also a host-started primary turn. UI text saying `recoverable` / `send your message again` does not install a resender in a task scheduler.

This section is versioned source inspection, **not a new real OpenCode task run**. The existing real-host OpenCode storage-contention evidence in `storage-busy-policy-pins.md:159-175,213-215` proves preflight recovery/refusal on disposable stores, not this particular task lifecycle. No OpenCode live installation/store was inspected.

## Verification, artifacts and limits

Investigation-only scripts, downloaded host sources, raw provider captures, JSONL transcripts, lsof snapshots and queue fixtures are retained under this worktree's ignored `.cache/issue-640/`. They are not product files or committed dependencies. The report includes the material observations so its conclusions do not rely solely on ephemeral ignored artifacts.

Relevant commands / checks:

- `bun install --cwd .cache/issue-640/host` with an exact `@oh-my-pi/pi-coding-agent:18.8.5` fixture manifest: 112 packages installed; two postinstalls were blocked; the actual CLI nevertheless launched and completed the controls. Product manifests/lockfiles unchanged.
- `TMPDIR="$PWD/.cache/issue-640/tmp" MC_E2E_KEEP=1 bun .cache/issue-640/omp-repro.ts`: real shipping-policy 60 s trial above. Other arms use `MC640_HOLD=2.2`, `MC640_LOCK=0`, or explicitly opt-in `MC640_PROPOSAL=a|b`; the proposal wrappers are not loaded in shipping baselines.
- `bun .cache/issue-640/aggregate.ts`: 35 lsof snapshots, zero protected live-path matches; separates failed setup trials from policy measurements.
- `bun .cache/issue-640/queue-bench.ts`: 12 matched fresh-store arms, all real adoptions checked, successful-BEGIN-to-COMMIT clocks above.
- `bun test --cwd packages/pi-plugin ../../.cache/issue-640/lkg-probe.test.ts`: **10 passed, 0 failed, 15 assertions** (Bun 1.4.2). Includes actual OMP bookkeeping rejection, metadata-normalized prefix+tail acceptance, actual provider-converter byte equality, 32/71/287-turn append controls, genuine model change, lost anchor, new-session miss, and partial envelope refusal. The initial root-CWD run tripped the repository's storage-leak scan because deliberate disposable stores are under root `.cache`; rerunning from the package scope, with its unchanged isolation preload, passed. No guard was disabled.

- `bun run --cwd packages/pi-plugin test:serial src/context-handler-lkg.test.ts src/pi-lkg.test.ts src/pi-lkg-fit-envelope.test.ts src/issue-601-pi-admission-review.test.ts src/fallback-adoption-cost.test.ts`: **52 passed, 0 failed, 270 assertions across 5 files**, Bun 1.4.2. Existing installed-handler production-timeout replay/refusal and bounded-hold controls pass; they do not exercise OMP's callable-schema API.
- `bun run --cwd packages/plugin test src/hooks/magic-context/lkg-transform-replay.test.ts src/hooks/magic-context/lkg-replay.test.ts`: **24 passed, 0 failed, 50 assertions in the matching transform-replay file**, Bun 1.4.2. There is no second matching test file; no two-file coverage claim is made.
- Product typecheck/build/lint were not rerun for a documentation-only edit; the prepared worktree build was already green. No new TypeScript is part of the delivery. Markdown inspection has no configured authoritative analyzer/formatter in this tree.

The evidence does **not** identify the exact production differing fields/models/branch IDs, reproduce Linux cold-disk timing on a 1.6 GB store, choose a final subagent wait budget, prove a full first-pass exemption predicate, or measure real OpenCode task cancellation. Those are explicit limits, not reasons to assume raw fallback safe. The report requests a design ruling before any product edits.

## Appendix: recreating the baseline without a live HOME

The following is the reduced baseline recipe; save the TypeScript block as `.cache/issue-640/recreate.ts` **inside a worktree**. It uses the existing test provider/JSONL helpers but launches the pinned OMP CLI directly (the normal e2e resolver currently pins a different OMP version). Start with a built worktree; install only into the ignored fixture directory:

```sh
mkdir -p .cache/issue-640/host .cache/issue-640/tmp
printf '%s\n' '{"private":true,"dependencies":{"@oh-my-pi/pi-coding-agent":"18.8.5"}}' > .cache/issue-640/host/package.json
bun install --cwd .cache/issue-640/host
TMPDIR="$PWD/.cache/issue-640/tmp" MC_E2E_KEEP=1 bun .cache/issue-640/recreate.ts
```

```ts
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPiIsolatedEnv, childEnv, writeConfigs } from "../../packages/e2e-tests/src/pi-runner/spawn";
import { prepareContextDatabase } from "../../packages/e2e-tests/src/prepare-context-db";
import { PiRpcProtocol, attachStrictJsonlReader } from "../../packages/e2e-tests/src/pi-runner/rpc-client";
import { MockProvider } from "../../packages/e2e-tests/src/mock-provider/server";

const mock = new MockProvider();
const { baseURL } = await mock.start();
const iso = createPiIsolatedEnv(undefined, "omp");
prepareContextDatabase(iso.dataDir);
writeConfigs(iso, {
  host: "omp", mockProviderURL: baseURL, modelContextLimit: 1000000,
  magicContextConfig: { memory: { enabled: false }, embedding: { provider: "off" }, dreamer: { disable: true } },
  piSettingsExtra: { task: { batch: false, isolation: { enabled: false }, agentModels: { task: "mock/mock-model" } }, async: { enabled: true } },
});
const env = childEnv(iso);
Object.assign(env, {
  MAGIC_CONTEXT_LOG_PATH: join(iso.baseDir, "magic-context.log"),
  MC640_DB: join(iso.dataDir, "cortexkit/magic-context/context.db"),
  MC640_AUDIT: join(iso.baseDir, "audit.jsonl"),
});
const auditExtension = join(iso.baseDir, "lock-probe.mjs");
writeFileSync(auditExtension, `
  import { appendFileSync } from 'node:fs';
  import { spawn, execFileSync } from 'node:child_process';
  export default function(pi) {
    let locked = false;
    pi.on('context', async (event, ctx) => {
      if (!ctx.sessionManager.getHeader()?.parentSession || locked) return;
      locked = true;
      const p = spawn('python3', ['-u','-c',
        "import sqlite3,sys,time;c=sqlite3.connect(sys.argv[1]);c.execute('BEGIN IMMEDIATE');print('LOCKED',flush=True);time.sleep(60);c.rollback()",
        process.env.MC640_DB], {stdio:['ignore','pipe','pipe']});
      await new Promise((done, fail) => { p.stdout.once('data', done); p.once('error', fail); });
      for (const pid of [process.pid, p.pid]) {
        appendFileSync(process.env.MC640_AUDIT,
          JSON.stringify({pid, lsof: execFileSync('/usr/sbin/lsof',['-p',String(pid)],{encoding:'utf8'})})+'\\n');
      }
    });
  }
`);
const usage = { input_tokens: 1000, output_tokens: 40 };
let spawned = false;
mock.setDefault({ text: "parent done", usage });
mock.addMatcher(body => {
  const tools = (body.tools ?? []) as Array<{name: string}>;
  const yieldTool = tools.find(t => t.name.replace(/^_/, "") === "yield");
  if (yieldTool) return { content: [{type:"tool_use", id:"yield640", name:yieldTool.name, input:{data:"control completed"}}], stop_reason:"tool_use", usage };
  const task = tools.find(t => t.name.replace(/^_/, "") === "task");
  if (!task || spawned) return null;
  spawned = true;
  return { content: [{type:"tool_use", id:"task640", name:task.name, input:{name:"Busy640", agent:"task", task:"Read the throwaway fixture then yield a result.", solutionSpace:"A single concrete tool action and result."}}], stop_reason:"tool_use", usage };
});
const cli = resolve(".cache/issue-640/host/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
console.log(execFileSync(process.execPath, [cli,"--version"], {env,cwd:iso.workdir,encoding:"utf8"}).trim(), iso.baseDir);
const host = spawn(process.execPath, [cli,"--mode","rpc","--no-extensions","--extension",auditExtension,"--extension",iso.pluginDir,"--no-skills","--no-rules","--model","mock/mock-model","--api-key","test-key-not-real"], {env,cwd:iso.workdir,stdio:["pipe","pipe","pipe"]});
const rpc = new PiRpcProtocol();
attachStrictJsonlReader(host.stdout, line => rpc.dispatchLine(line));
const command = (type: string, params = {}) => rpc.sendCommand(line => host.stdin.write(line), type, params, {timeoutMs:120000});
host.stderr.on("data", data => appendFileSync(join(iso.baseDir,"stderr.txt"),data));
rpc.onEvent(event => appendFileSync(join(iso.baseDir,"events.jsonl"),JSON.stringify(event)+"\n"));
try {
  await command("get_state");
  writeFileSync(join(iso.baseDir,"lsof-start.txt"),execFileSync("/usr/sbin/lsof",["-p",String(host.pid)],{encoding:"utf8"}));
  const result = rpc.waitForEvent(e => e.type === "message_end" && (e.message as any)?.customType === "async-result", {timeoutMs:120000});
  await command("prompt", {message:"Use task to start one subagent and wait for its result."});
  console.log(JSON.stringify(await result));
  writeFileSync(join(iso.baseDir,"provider-requests.json"),JSON.stringify(mock.requests(),null,2));
} finally {
  host.kill("SIGTERM");
  await new Promise(done => host.once("exit",done));
  await mock.stop();
}
```

Inspect **only that printed root**: its MC log, `events.jsonl`, `audit.jsonl`, and the `Busy640.jsonl` under the disposable parent-session artifact directory. Require actual reminder entries, actual `session_exit` / `dispose`, a cancelled result, zero child HTTP captures, and lsof paths confined to the disposable root before calling the reproduction successful. The independent locker exits after its bounded 60-second hold. For a positive control remove the probe extension, rather than fabricating a provider success after a refused hook. The original investigation records all-context observations and start/held/end lsof, in addition to this minimal recipe.
