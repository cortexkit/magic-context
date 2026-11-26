# Pinned host-runner integration

Bridge plugins can pin a package version or repository commit and import
`@cortexkit/opencode-magic-context/host-runner`. This typed subpath has no database,
logger, tokenizer initialization or mutable singleton state at import time. It
exports the pure `record` transitions, `isFallbackAdmissible`, and
`recordProviderUsage`, plus the supported lazy `createBridgeAdapter` constructor.
The low-level `loadOpenCodeProviderAdapter()` factory remains available, but bridge
callers do not need its private dependency types or a separately built database,
module client, legacy transform, or `SessionMeta`.

## Supported bridge constructor

```ts
import { createBridgeAdapter } from "@cortexkit/opencode-magic-context/host-runner";

const adapter = await createBridgeAdapter({
    openCodeClient, // OpenCode 1 SDK client, or OpenCode 2 host context
    projectRoot: "/absolute/project",
    connectionFile: "/absolute/subc-connection.json",
    storageDir: "/absolute/magic-context", // contains the shared context.db
    configPath: "/absolute/magic-context.jsonc",
    // allowMigration: true, // deliberate installation-wide schema upgrade only
});
const unsubscribe = adapter.onOutcome(async (messageId, subject, outcome) => {
    // Observe committed ops/unavailability; context.db remains the replay owner.
});
const { messages: view, kind } = await adapter.run({ sessionId, messages: rawHostWindow, kind: "model" });
// Send this view, including its synthetic user head, not the unchecked rawHostWindow.
// Log kind: "ordinary", "bootstrap", or "rebuild".
unsubscribe();
await adapter.dispose();
```

All four filesystem inputs are absolute. `configPath` uses the normal loader's
`MAGIC_CONTEXT_CONFIG_PATH` semantics (trimmed exact user-tier file, JSONC,
relative file substitutions, project-tier security, and no XDG/legacy user
fallback if missing). The loader now accepts an explicit override; the bridge
passes it with runtime-global updates disabled and never changes `process.env`.
The bridge does not run config-location migration or install reload timers.

The bridge **always selects the provider lane**. `transform_mode` and
`rust_pipeline` are retired: the in-tree plugin ignores them, logs one warning and
runs its TypeScript transform. They never applied to the bridge; the harness's own
off-by-default bridge flag owns opt-in. `kind` has exactly one
supported value, **`"model"`**, because the OpenCode messages-transform hook has no
caller kind and the provider adapter emits model steps. Rebuilds are not another
kind: the adapter compares the host window to saved message identities and checks
whether the selected model, system/tool fingerprint or persisted source state has
changed. Idle-cache time and token pressure can also require a rebuilt history
view, using the same rules as the low-level provider adapter.
`run` owns `SessionMeta`, publication, normalization through `providerIncoming`,
and the bootstrap/rebuild record; it returns `Promise<{ messages: MessageLike[],
kind: "ordinary" | "bootstrap" | "rebuild" }>`.
Supply the complete raw host window in append order with its real identities,
not just the new tail or a previous provider projection. No private type or
mutable output parameter is needed.

### Head placement and project identity

The OpenCode provider's head is **inside `messages`**, not a system contribution.
Its first two entries, m[0] and m[1], are id-less synthetic **user** messages, just
as in the in-tree plugin. m[0] carries project docs, the user profile,
`<session-history>` and `<project-memory>`; m[1] carries incremental history and
memory corrections when present. Send both entries at the head of the provider
window. Do not filter them out, turn them into system text, persist them as raw
host history, or add a second memory injection. `run` does not drop a separate
system field: there is no such head field on the OpenCode provider answer.

Pass `projectRoot` **exactly as the host spells it; do not realpath it first**.
The shared identity resolver uses `git:<root-commit>` for repositories with
history and `dir:<MD5-prefix of path.resolve(root)>` otherwise. A trailing slash
does not change the key, but symlink spellings and macOS `/var` versus
`/private/var` can. Transport still binds a realpath for filesystem authority.
Before provider rendering the bridge records the host-resolved identity in
`session_projects` under its instance's harness. ck-mc prefers that binding to
recomputing the identity from the canonical route. Host watermarks and all
project-scoped module reads use that identity; docs use the equivalent bound
filesystem directory. Re-keying existing directory memories is not part of this
API. Seed/write memories using the same host spelling and shared resolver.

Setup's `answer: "ready"` inserts placeholders; the bootstrap's final status pass
renders the real head even with **zero compartments** (stored history summaries)
and no historian execution (background model calls that create those summaries).
Memory and profile injection need `memory.enabled` (default true),
`memory.injection_budget_tokens` (default 4,000) and
`memory.user_profile_budget_tokens`; docs need `dreamer.inject_docs` (default true). The provider lane requires
`compaction.enabled` (default true); disabling it refuses setup, rather than
silently serving a memory-less provider window.

The TS facade's `configPath` does not configure an independently launched ck-mc.
At this pin ck-mc reads its user tier from
`$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc` (or `.json`) plus the project's
`.cortexkit` tier; it does **not** read `MAGIC_CONTEXT_CONFIG_PATH`.
`MAGIC_CONTEXT_STORAGE_DIR` selects storage, not head settings. An env-only
launch still gets the default enabled head, but explicit overrides must be
installed in ck-mc's isolated XDG config tier as well. Staged ck-mc `cc8617ec`
has identical Rust provider/identity/render/config code to `245aa977`; it does
not need rebuilding for this fix.

### Whole-step budgets and cancellation

The facade classifies the pass using the provider adapter's own bootstrap and
rebuild checks (source revert, model/system/tool manifest, explicit refresh and
idle cache). `kind: "model"` remains the input; it is not a budget hint.

| Result/error `kind` | Whole-pass budget |
| --- | --- |
| `ordinary` | 5,000 ms |
| `bootstrap` | 30,000 ms |
| `rebuild` | 30,000 ms |

The budget starts on entry to `run` and covers preflight, all provider/ck-mc calls,
assembly and the final host-record commit. Individual RPC limits can refuse
earlier. At the deadline `run` rejects with `StepBudgetExceededError`, carrying
`{ code: "step_budget_exceeded", budget_ms, kind }`. Errors from other pass
failures also carry the classified `kind`. The caller may then use
`isFallbackAdmissible`; timeout itself never authorizes unchecked raw history.

Bridge host-record writes are staged until a single final atomic transaction.
Cancellation is checked between asynchronous stages, before each record write,
and immediately before COMMIT, including a clock check when synchronous SQLite
work prevents the timer from running. An expired transaction rolls back whole;
no outcomes, served state, request fences or usage from an unserved timed-out
pass are published. Request fences associate a fresh RPC ID with its lineage and
newest ordinal, preventing stale replies from overwriting a newer view. A retry
reloads the prior durable record. Transport receives
the cancellation signal; a remotely finishing ck-mc reply is discarded and
cannot resume host writes. Session/project binding and module state-sync are
independent authority metadata, not proof that a provider step was served.

Bridge `onOutcome` is a fire-and-forget notification **after successful commit
and publication**, outside the step budget. It emits nothing for cancelled
passes, is not awaited by `run`, and has no ordering guarantee relative to
`run`'s resolution. Observer failures are isolated and logged once per session.
`dispose` drains outstanding notifications before closing handles.

### Raw host-history markers and open items

Budgeted bridge passes **do not invoke the native raw-history marker writer**.
That writer commits OpenCode's own database independently of `context.db`; it
cannot safely trim raw history inside a transaction that might roll back the
bridge view at the deadline. Coverage is still committed in the bridge's durable
view. Marker advancement is an optimization, never a condition for serving a
step.

Without markers, OpenCode keeps handing the full raw history to each step. The
returned compacted view stays correct, but per-step host work grows with the
session. The bridge integration must also **keep OpenCode's native
auto-compaction declined while Magic Context owns compaction**; the facade does
not install the host's compaction-decline hook on the integration's behalf.

`run()` returns `{messages,kind,receipt}`. The receipt has `request_id`,
`delivery: "pending" | "clean"`, `lineage_id`, `served_through_ordinal`,
`unserved_subjects`, optional `last_applied:{compaction_id,version,range:{from,to}}`,
optional `coverage:{end_mid,ordinal}`, and optional
`last_not_applied:{compaction_id,version,reason}`. The replaced range is half-open
in the relay's message positions; coverage is in native raw-history coordinates.
Do not compare the two ordinals or use the served watermark as coverage.

After the carrying provider request ends, call
`completeRequest(sessionId, receipt.request_id, {status,cleanEnd,stop_reason?})`.
Only a terminal 200 with a clean end of stream advances the watermark (including
a refusal stop). Headers alone, truncated streams and non-200 responses do not.
This persists the clean receipt before returning it. `receipt(sessionId)` reloads
the current pending/clean receipt after restart. Unknown or superseded request IDs
do not acknowledge anything.

After `run()` commits an applied covering view, call
`advanceNativeMarker(sessionId, receipt, fallbackInputs)` for OpenCode 1.
Delivery may still be `pending`: native admission requires the current durable
applied receipt, not provider completion. Pending-apply, superseded, unpersisted
or not-applied receipts cannot authorize a cut. Clean delivery remains required
for the served/tag watermark only. Supply the complete canonical raw window and the **current** model,
usable context window and complete system/tool envelope, just as for fallback
admission. The exact applied representation must pass both the token and byte
fit checks, preserve uncovered parts, and retain paired tool calls/results. The
existing OpenCode writer uses its separate host connection; its 5-second deletion
timeout is unchanged. OpenCode 2 does not have this OpenCode 1 marker integration.
The native in-tree marker paths are unchanged.

For Pi, `createPiBridgeMarkerOwner({db,reloadSession}, sessionId)` exposes
`publish`, `complete`, `current`, `isFallbackAdmissible(record, fallbackInputs)`,
and `advance(receipt, record, fallbackInputs)`.
The relay supplies the real applied runner record, not a scalar watermark.
`reloadSession()` must reload the current host journal and return its
`readBranchEntries`/`appendCompaction` methods together. It runs under the shared
MC database writer lease, so different processes cannot append concurrently;
retry rechecks the journal before appending. All native Pi appends to that
session must use this owner, not the standalone context-handler appender.
Use the owner's fallback method rather than the record-only helper: it loads the
committed native boundary from MC's store and checks it against the active
journal branch. Preserve `/tree`'s selected leaf when reloading: simply reopening
at the last entry in the file can select an abandoned branch.

OpenCode admission records the completed user-compaction/assistant-summary pair
written by MC. The writer deliberately omits `tail_start_id`, so its existing
boundary user message is the first retained source; no dangling tail is created.
Fallback and subsequent bridge runs validate the pair in the actual host array,
not mere marker presence. Missing/unfinished summaries, edited tail pointers,
dangling tails, or a returned hidden prefix refuse with `covered_range_changed`
(the detail names the broken boundary). A retained pre-boundary tail, when part
of the recorded native cut, is restored to append order for source comparison.
Pi likewise validates the recorded compaction and live `firstKeptEntryId`.

Both hosts accept a shorter post-cut array by aligning its first retained source
ID to the runner record and checking hidden source evidence in that record.
Visible covered source and coverage beyond the effective cut are still checked.
An unplaceable cut or missing stored evidence refuses with
`covered_range_changed`; missing pre-cut messages alone are not a source change.
Old cut records without native boundary identities must be recovered or rebuilt,
not used as proof that the current host window is cut.

Receipt/cut state uses JSON in the existing host-runner table; no schema change is
needed. Marker admission failures return `deferred` and leave valid messages
servable. Before entering either irreversible host writer, persist `unknown` in
a separate transaction. A killed owner releases the SQLite lease but leaves
`unknown`, not a false no-cut acknowledgement. Retry after restart revalidates
fit/coverage and heals deterministic OpenCode upserts or adopts Pi's already
appended journal entry. An unknown cut blocks pre-cut fallback replay until
recovery; it does not refuse a fresh bridge representation.

The store is an independently owned handle opened by the shared storage module,
with the ordinary WAL/NORMAL policy, foreign keys, 5-second busy timeout, private
permissions and write-transaction helpers. It does not reuse or close another
host's cached handle, copy legacy stores, or start unrelated store backfills.
**Schema changes affect every host sharing `context.db`.** By default any version
other than this build's `LATEST_SUPPORTED_VERSION` throws
`StoreVersionMismatchError`, with `code: "store_version_mismatch"`, `found` and
`expected` version fields and both versions in its message, **before schema
initialization or migration**. This includes a fresh store at version 0. Only an
explicit `allowMigration: true` initializes/migrates an older store using the
ordinary migration/write-lock implementation. A newer store is always refused:
allowing migration cannot downgrade it. Older hosts must update to a build that
supports the newer store's schema version.

The constructor builds `SubcModuleTransport` from the supplied connection file.
It binds the canonical project root and each call's session, with `opencode` for
the SDK client or `opencode2` for a host context whose `session.hook` is a function.
The harness is instance-scoped; no global harness switch is needed. Route opening
passes `consumerIdentity: null`, so inherited `SUBC_MODULE_ID`/
`SUBC_LAUNCH_NONCE` never identify this independent host.

Bootstrap uses the native canonical-store ordinal resolver, **never ordinals
invented from `session.messages`**. OpenCode 1 reads its canonical host store.
OpenCode 2 must already have a per-session raw-history provider registered, as the
in-tree v2 context integration registers with `setBoundedRawMessageProvider`.
The host integration must register a reader for its own canonical history; the
module transport only sends provider requests and cannot supply that host reader.
Without it, `run` refuses before any canonical-store fallback or module call.
The constructor supports v2 detection and this boundary, not a replacement for
v2's host-history registration lifecycle.

`dispose()` is idempotent and returns the same promise on repeated calls. It
rejects new calls immediately, drains in-flight passes and stops the historian,
then closes the module connection and its store handle exactly once. Methods
other than repeated disposal refuse after disposal. Observers can unsubscribe;
the bridge dispatches them after durable commit, as described above.

### Refused provider handoffs

The low-level adapter still takes a "legacy transform": the Rust **full-request**
transform. Rust transform mode is retired, so no in-tree host selects that transform.
The adapter uses its message-id to canonical-ordinal cache for bootstrap. The
low-level adapter can also hand a session to it when bootstrap is declined or the
provider exits. The bridge constructs that transform for its ordinal cache only and
**never executes a full-request handoff**. These throw `BridgeRefusalError` (an emergency fail-closed error) with
stable `code` and `reason` fields:

| Code | Reason / handoff |
| --- | --- |
| `bridge_bootstrap_declined` | `bootstrap_declined`: initialization cannot produce a committed provider view (missing/noncanonical IDs or unfinished messages, host window changed before initialization completed, declaration unavailable, setup refused/unavailable, or no applied bootstrap replacement) |
| `bridge_provider_message_too_large` | `provider_message_too_large`: a message cannot be admitted within the provider request cap |
| `bridge_provider_history_lost` | `provider_history_lost`: the module cannot preserve the required history |
| `bridge_provider_record_lost` | `provider_record_lost`: a module-ahead setup cannot be adopted without a durable host record |
| `bridge_provider_foreign_history` | `provider_foreign_history`: host window belongs to incompatible history |
| `bridge_provider_revert_ambiguous` | `provider_revert_ambiguous`: the record cannot resolve the host revert |
| `bridge_rollback` | `rollback`: a previously rolled-back provider record cannot complete re-entry |
| `bridge_provider_disabled` | `provider_disabled`: defensive low-level reason; unreachable with the bridge's fixed provider lane |
| `bridge_raw_history_provider_missing` | `raw_history_provider_missing`: OpenCode 2 session has no registered raw-history provider |
| `bridge_served_bytes_changed` | `served_bytes_changed`: the new view changes a message the bridge already returned, outside a rebuild, or a rebuild puts such a message back to the host's raw text (tags or other hook edits stripped); `retryable: true` |

No handoff refusal authorizes sending raw history. The caller may ask
`isFallbackAdmissible` and send **only** its returned admissible view, or refuse the
step. Other native failures (durability, store-ahead, transport and explicit
provider refusal) retain their native error codes; they are not disguised as a
full-request handoff.

**Served bytes.** Across all lineages of a session, every admitted message the bridge returned in
its last view comes back byte for byte unless the step rebuilds history (the step
is classified `rebuild`, or the module applies a new view). Even a rebuild may not
put such a message back to the host's raw text. ck-mc rebuilds history from hook
answers whose delivery the host confirmed; while delivery stays pending
(`served_through_ordinal` 0), a rebuild would render those messages raw, so `run()`
refuses it with `bridge_served_bytes_changed` (`retryable: true`; nothing is
committed). After `completeRequest` confirms a clean delivery, the same step renders
the confirmed tags and is served. Messages no longer in the host's history are not
compared. The bridge saves the last served baseline atomically with its pending
receipt in the existing store, so restarting an adapter does not clear this guard.
Receipts written by older versions have no such snapshot; their baseline becomes
durable on the first successful publication with the new adapter.

### OpenCode 1 measured usage is not an automatic bridge witness

`message.updated` exposes assistant reply id, model, input and cache-read/write
tokens and completion metadata. The in-tree event handler uses these for session
pressure, rejecting older reply ids. Pressure is not exact-request fit evidence.
Its last-known-good (LKG) saved-request path is stricter: an initial empty assistant
update establishes the v1
response id; the messages pass claims that identity and captures a saved request;
a completed nonfailed reply must match the response id/model. Replay then checks
that the saved prefix is unchanged and that the first appended message is that
assistant reply (`lkg-measured-request.ts`). This also relies on private
request/capture state, not merely the assistant's final `tokens`.

The LKG envelope compares model, system-token count, agent and measured tool-token
count. Those counts do **not** prove equal system/tool bytes. The provider adapter
separately uses `system_prompt_hash` from the system hook and the tool-set hash to
trigger rebuilds, but neither that manifest nor the next pass's preceding messages
proves that a particular reply measured that exact sent envelope. This facade has
no final provider-request record or system/tool hook witness. There is therefore
**no sound automatic `recordReplyUsage(sessionId, assistantMessage)` helper** on
this surface. Do not turn the session's most recent usage into such a witness.
OpenCode 1 bridges lacking additional request attribution should skip
`recordProviderUsage` and supply conservative system/tool token bounds instead;
fallback will refuse when fit cannot be proven.

`recordProviderUsage` remains an explicit, caller-attested API for integrations
that can attribute a count (including cache reads/writes) to the exact returned
view, model and complete system/tool envelope. Fallback matches lineage, view
version, message-prefix digests, model and envelope; changed prefix/model/system/
tools never borrow that count. The constructor regression test proves the matching
control admits without local envelope bounds and each changed identity refuses.


## Reproducing

`packages/e2e-tests/src/bridge-memory.test.ts` is an opt-in, real-module fixture.
The v1 cases run **OpenCode 1.18.35** with `serve --pure` (no in-tree plugin), a
loopback mock Anthropic provider and a real `createOpencodeClient` from the v1 SDK.
Both v1 cases seed an active `ARCHITECTURE` memory in `context.db` **before
OpenCode, ck-mc or the adapter starts**. The existing-history case creates a
session and completes two real user/assistant turns, verifies their four IDs in
the private `opencode.db`, then constructs the bridge adapter. No v1 raw-history
provider is registered: bootstrap must resolve those IDs from the canonical host
store. The fixture sends the adapter's complete returned projection to a fake
HTTP provider on both bootstrap and an ordinary pass of the same raw window,
asserting the memory is in `messages[0]`, with role `user`, and both turns remain.
The first-turn case instead constructs the adapter before any prompt, persists
one real user message with the SDK's `noReply: true`, and bootstraps with no
assistant history. It then completes that same user ID through OpenCode and
runs an ordinary pass over the user/assistant pair. Both provider requests must
contain the seeded memory in `messages[0]`. The raw bridge answer and the sent
request are captured separately: these tests send the projection directly to the
mock HTTP provider, not through an external bridge plugin's OpenCode conversion.
Both cases assert zero compartments (stored conversation summaries), so summaries
created by historian model calls cannot be the source of the injected memory.
The two existing v2 cases instead register a canonical raw-history reader and
exercise symlink and macOS `/var` versus `/private/var` project spellings.

Seed order matters: setup's `ready` response contains `replacement: []`; the
bootstrap's final status pass materializes the real head. A memory added **after**
that head is materialized appears only on the next rebuild, by design. Ordinary
passes replay the frozen head, not a freshly queried memory list. At this pin the
v1 fixture's bootstrap already renders the seeded head; the no-new-tail ordinary
pass exposed a separate wire error: its state-sync barrier used nested `params`
instead of the module's flat envelope and ck-mc refused it with
`missing field shadow_generation`. Both the seed's pass-complete/model-chain
fields and the no-tail barrier must be top-level state-sync fields.

Run locally with copied native binaries, niced, using a fresh scratch tree for
each invocation. Resolve the OpenCode binary before replacing `HOME`; it may be
on `PATH` or at `~/.opencode/bin/opencode`. This example uses the staged schema-100
fixture that accompanies the pinned ck-mc rather than any live store:

```sh
OPENCODE_BIN="$(command -v opencode || printf '%s/.opencode/bin/opencode' "$HOME")"
mkdir -p "$TMPDIR/magic-context"
ROOT="$(mktemp -d "$TMPDIR/magic-context/bridge-memory.XXXXXX")"
mkdir -p "$ROOT/bin" "$ROOT/home" "$ROOT/config" "$ROOT/data" \
  "$ROOT/cache" "$ROOT/state" "$ROOT/runtime"
cp "$HOME/.local/share/cortexkit/bin/staging/ckdev-mc.cc8617ec" "$ROOT/bin/ck-mc"
cp "$HOME/.local/share/cortexkit/bin/ck-subc" "$ROOT/bin/ck-subc"
cp "$HOME/.local/share/cortexkit/bin/staging/ckdev-mc.cc8617ec.context-v100.db" \
  "$ROOT/context-v100.db"
env HOME="$ROOT/home" XDG_DATA_HOME="$ROOT/data" \
  XDG_CONFIG_HOME="$ROOT/config" XDG_CACHE_HOME="$ROOT/cache" \
  XDG_STATE_HOME="$ROOT/state" XDG_RUNTIME_DIR="$ROOT/runtime" \
  OPENCODE_DB="$ROOT/data/opencode/opencode.db" \
  MAGIC_CONTEXT_STORAGE_DIR="$ROOT/data/cortexkit/magic-context" \
  MC_BRIDGE_MEMORY_E2E=1 MC_BRIDGE_MEMORY_ROOT="$ROOT" \
  MC_BRIDGE_MEMORY_BIN="$ROOT/bin/ck-mc" \
  MC_BRIDGE_MEMORY_SUBC_BIN="$ROOT/bin/ck-subc" \
  MC_BRIDGE_MEMORY_DB="$ROOT/context-v100.db" \
  MC_BRIDGE_MEMORY_OPENCODE_BIN="$OPENCODE_BIN" \
  nice -n 10 bun test packages/e2e-tests/src/bridge-memory.test.ts
```

The v1 cases further isolate each HOME/XDG root under `$ROOT/v1/` (existing
history) or `$ROOT/v1-first-turn/` (first user turn). The existing-history facade
`configPath` (also `MAGIC_CONTEXT_CONFIG_PATH`) is
`$ROOT/v1/config/selected.jsonc`. Separately, `stack.writeModuleConfig(config)`
writes `$ROOT/v1/data/module-config/cortexkit/magic-context.jsonc` in **ck-mc's**
private XDG config tier, not the facade's tier or the user's daemon configuration.
Both files explicitly enable memory, set injection/profile budgets to 4,000/1,000
tokens, enable compaction, and disable historian, dreamer and embeddings. The
private daemon has its own empty modules config and launches no supervised
modules. The fixture copies ck-mc; it never modifies the staged executable or
connects to the live subc daemon.

For this non-git project, the persisted binding is
`session_projects(session_id=<real SDK session ID>, harness='opencode',
project_path='dir:<MD5-prefix of path.resolve(projectRoot)>')`, using the host's
spelling `$ROOT/v1/project`. Transport binds `{ project_root: realpath(projectRoot),
harness: 'opencode', session: <same SDK session ID> }` with
`consumerIdentity: null`. Both processes use
`$ROOT/v1/data/cortexkit/magic-context/context.db`. The v2 cases use harness
`opencode2`, not `opencode`.

The test captures `lsof -nP -p <pid> -Fn` for the bridge, OpenCode, private daemon
and ck-mc **while they are running** and rejects every database/WAL/SHM path
outside the throwaway root. It additionally compares canonical paths to prove
the bridge and ck-mc hold the **same** `context.db`, and OpenCode holds the expected
`opencode.db`. For a manual run, use the printed bridge/module PIDs:

```sh
lsof -nP -p "$BRIDGE_PID" -Fn
lsof -nP -p "$CK_MC_PID" -Fn
# Both must list n<canonical ROOT>/v1/data/cortexkit/magic-context/context.db.
# Any database path outside ROOT is an isolation failure: stop the fixture.
```

Each v1 root's `requests.json`, `bridge-views.json`, `opencode.log` and
`lsof-{bridge,opencode,daemon,module}.txt` remain available after teardown as
reproduction evidence. `bridge-views.json` preserves the adapter's returned
`{ messages, kind }`, including the id-less synthetic text parts, before the
fixture converts them to HTTP provider messages. Never substitute live
OpenCode/CortexKit databases or configs for these throwaway inputs.

## Adapter-owned record access

The adapter is multi-session. Bridges call
`adapter.isFallbackAdmissible(sessionId, inputs)` and
`adapter.recordProviderUsage(sessionId, usage)`; neither method exposes the record.
They hydrate and use that session's current record. Missing, inactive or exited
provider sessions refuse admission and cannot record usage. Usage recording is
synchronous and commits immediately to `context.db` (and refuses while a pass is
in flight); failed persistence does not leave speculative usage in the cache.
The pure exports described below remain available for other record owners.

## Durable step-transform outcomes

The adapter's durable store is **Magic Context's `context.db`**, keyed by session
and harness (`opencode` or `opencode2`), not a bridge cache or the ck-mc process.
An ordinary pass already committed frozen message bytes before publication:
`commitHostRunnerPass` writes `host_runner_entries.ingest_json`, `op_version` and
`hook_json`, the message/ordinal IDs, and `host_runner_state` together in one
immediate SQLite transaction. `run()` publishes its output only after that commit.
Restart hydration re-applies the recorded op version and answers to the saved
ingest, or replays saved raw ingest when unavailable; it never re-hooks retained
messages against the current provider.

Previously, unavailability was frozen only at whole-message granularity; the
per-subject unserved list could later be acknowledged away. `hook_json.outcomes`
now retains each **effective** subject outcome in that same transaction. The
existing all-or-nothing message rule is unchanged: if any subject is unavailable,
every subject for that message is recorded as unavailable and the whole message
stays raw, including text for which another hook returned successful ops. Otherwise
each answer's ops (including empty pass ops) are frozen. Bootstrap imports retained
history without running hooks, so those admissions have no hook outcomes. Older
records still replay their frozen whole-message result; unavailable subjects
cannot be reconstructed retroactively. When compaction consumes entries, their
outcomes are superseded by the durable replacement in `host_runner_views`; covered
messages are not re-hooked. A lineage descent/revert can deliberately re-admit a
changed suffix.

The low-level native `OpenCodeProviderOptions.onOutcome(messageId, subject, outcome)`
is optional and awaited for newly committed outcomes, after the pass commit and
before publication or `run()` returning. The supported bridge instead dispatches
observers after publication, without awaiting them, as described above. Both
observe/mirror the record; neither replaces persistence.
On the native path an observer failure refuses publication but leaves the frozen outcomes
committed. Notifications are not an exactly-once delivery queue and are not re-sent
on replay; a process can die after commit but before observation. Bridges must not
depend on a separate mirror to reconstruct the served view. The SIGKILL fixture
test kills a process between steps and opens the same temporary `context.db` in a
new process, proving identical ops/raw replay with no hook or declaration calls.

## Host-lane subjects and positions

ck-mc's host declaration (`crates/mc-module/src/providers/step_transform.rs`,
the declaration builder and the host hook handler) selects `observation: "answer"`
with `serializer_profile: "opencode-aisdk"`. It declares `pre_user` and `post_tool`,
plus `post_assistant` when MC owns reduction. **It does not declare or act on
`pre_tool` on this lane**; unsupported host hooks return `not_subscribed`.
Consequently the adapter does not run `pre_tool`, despite the broader subject list
in THALAMUS's design. There is no new position encoding: completed messages get
append-order ordinals within the lineage; a completed/error tool result shares its
assistant message's ordinal and uses `subject_part` to identify its part. Messages
with unfinished tools remain unnumbered passthrough until terminal. Inventing an
ordinal for a pre-tool event would not enable an MC host-lane effect.

## Fallback admission versus restart recovery

`adapter.recoverOutput(sessionId, output)` reloads committed storage and assembles
the last durable replacement plus retained frozen entries. It has no incoming host
window, model limit or envelope, cannot check fit/source continuity, and cannot add
a newly arrived raw tail. It is **restart recovery only**, not permission to send
that view as fallback for a new request. If `recoverOutput` returns false, it leaves
the supplied output unchanged.

For a new fallback step, serve **exactly the `view` returned by an admissible
result** from `adapter.isFallbackAdmissible`. That is the last durable replacement
plus unchanged retained frozen entries plus the current raw unadmitted tail. This
also preserves frozen hook ops in an identity view before any compaction. Source
continuity and fit must both be proven; never append a tail to `recoverOutput` and
assume the result was judged admissible.

`isFallbackAdmissible(record, inputs)` is synchronous. Supply the full incoming
host window in append order, normalized exactly as the record's admissions for
the pure/low-level API (the adapter's `providerIncoming(message).read()`
representation). The supported bridge facade takes the **raw** window and owns
this normalization. Supply its first provider
ordinal if the window starts later than `record.first_ordinal`, the selected
`provider/model`, a system/tool-envelope fingerprint, and the **usable prompt
window after output reserve**, not a guessed default. MC's id-less synthetic heads
and host compaction markers do not consume ordinals. Covered input digests
are retained after source bodies are pruned; restored older records lacking those
digests must refuse until rebuilt by the provider.

Record provider input usage only after attributing it to the exact served request,
including input and cache-read/cache-write tokens, with that request's model and
envelope. Persist `record.measured_usage` and `record.source_digests` with the rest
of the record; the built-in adapter's usage method commits them in its existing
`host_runner_state.setup_json` metadata.
A session's latest usage from an unrelated request is not evidence. Matching usage
prices only the new tail; otherwise callers must supply conservative local-token
bounds for system text and tool definitions. The fit calculation shares MC's
wire-field traversal, calibrated fit margin and byte-risk guard, and uses a UTF-8
byte upper bound instead of loading a tokenizer. This intentionally may decline
some requests that a full tokenized pass would admit.

A successful result is `{ admissible: true, view }`. Failures include
`covered_range_changed` (edits, removals, insertion or changed ordinal in the covered
range) and `fit_unproven` (unknown window or insufficient fit evidence). Refuse the
model step on either failure; do not fall back to unchecked raw history. The helper
never contacts ck-mc or opens storage and does not mutate the record or its inputs.

The subpath import test exercises the built package in a clean process with a
scratch HOME and XDG directories, blocking SQLite module loads, filesystem writes
and timers, and checking global properties and process listeners/handles. Build
before running it (`bun run --cwd packages/plugin build`).
