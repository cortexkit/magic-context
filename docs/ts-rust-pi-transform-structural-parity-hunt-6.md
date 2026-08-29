# TS ↔ Rust ↔ Pi transform structural parity hunt #6

## Method and denominators

This hunt starts from durable state rather than provider-request shape. TypeScript remains the behavioral specification, but each leg is compared in its own value space: OpenCode TS and Rust share the OpenCode raw-message source and `context.db` read model; Rust additionally owns `store.db` engine truth; Pi owns JSONL source identity while reusing the shared context read model. Counts from unlike sessions are inventory, not parity evidence.

`scripts/audit-transform-wire-parity.py` retains every hunt 1–5 wire, facade, historian, and Pi axis. Its new `engine_adjacent_state` section inventories, per config-verified lane/session, message-index watermarks and FTS cardinality, session→project bindings, compartment/memory embedding coverage, smart-note state, commit-index presence, and Rust `mc_cache_state`/`mc_pass_trace` truth. It reports duplicate FTS identities and mis-scoped chunk vectors as unexplained invariants. It never emits indexed content, note bodies, or commit text. The built-in expected Rust set remains ASTROCYTE plus ENGRAM only.

The hermetic differ test executes the real script with one TS body, one Rust body, one Pi rendered capture, Pi JSONL, and synthetic context/store databases. Both OpenCode lanes have clean message indexes and identical searchable bytes, valid project bindings, vectors, smart-note state, and commit rows; Rust alone has the expected engine-truth rows. The engine-adjacent invariant bucket and both pre-existing unexplained-byte buckets are empty. No production dump, Pi session, or user database is versioned, so live counts remain a post-deploy evidence step rather than invented evidence.

## Axis verdicts

### A. Message index / FTS — pass

**Verdict: authority-neutral for OpenCode TS and Rust; Pi uses the same durable index machinery with a different source reader.** OpenCode terminal `message.updated`, first transform/event reconciliation, and `message.removed` hooks are outside the `transform_mode` branch. Both OpenCode lanes read the same `opencode.db` history through `readRawSessionMessages`, then call the shared `scheduleIncrementalIndex`, `scheduleReconciliation`, and `scheduleClearAndReindex` functions. A Rust transform therefore does not depend on module tags or mirror rows for raw-message search.

The regression baseline covers same-ID replacement, same-ID empty redaction, dirty-floor retry after a failed replacement, a later incremental event that cannot jump an earlier hole, and removal rebuilding. `message-index-maintenance.test.ts` deletes old orphaned OpenCode rows while retaining live, young, and Pi-owned rows. The LOOP R3 isolation rule remains intact: Rust authority still does not mirror-write host tag/compartment authority during this host-owned FTS maintenance.

Pi reads its JSONL entries through `readPiSessionMessages` and schedules the same async index operations on first context touch and terminal assistant publication. Its source identity differs, but FTS row identity, replacement, dirty-floor, and query semantics are shared.

### B. Embedding generation and vector search — three Rust trigger defects fixed

**B1 — fixed: Rust transforms skipped the host auto-embed hook.** `createTransform` returned immediately after `rustModeTransform.run`, before the TypeScript tail's `maybeAutoEmbedSession` call. Newly mirrored Rust compartments could therefore remain unembedded until an explicit `/ctx-embed` or a later project sweep, while a TS publish queued chunk embedding. Rust now invokes the same host-owned auto-embed hook after successful module application. The regression asserts the callback on a real Rust outer-transform pass; deliberately neutralizing the call made the test fail, and the restored call passes.

**B2 — fixed: Rust sessions did not persist the session→project binding needed by chunk backfill.** The TS-only continuation recorded `session_projects` after resolving `client.session.get(...).directory`; Rust returned before that block. Chunk candidates join `compartments` to `session_projects` by `(session_id, harness, project_path)`, so merely invoking the drain did not repair the missing scope. Rust preflight now records the binding only from a host-resolved directory, caches the recorded identity per session, and reuses the bounded mis-scoped-vector repair in `recordSessionProjectIdentity`. The authority-route test now proves the same host directory both routes the module and persists the OpenCode binding.

**B3 — fixed: mirrored Rust memory writes had no publish-time embedding trigger.** TS `ctx_memory` writes immediately queue a hash-guarded embedding. The Rust backend pulled the memory mirror and returned, leaving new/updated/merged rows for startup/nightly maintenance. After a successful Rust write/update/merge, the host now registers the resolved project and asynchronously drains unembedded mirrored memories. Reads and archives do not start unnecessary provider work; stale saves remain protected by the existing normalized-hash check.

**Vector-search verdict: pass once pools are populated.** Both authorities query the same context tables through `unifiedSearch`, `searchCompartmentChunks`, memory-vector loaders, and commit-vector loaders. Pi uses the same provider registry/storage/search core. The remaining evidence gap is a single matched-history integration fixture that publishes equivalent TS, Rust, and Pi compartments and compares ranked results over physically identical vectors; no divergent scoring path was found.

### C. Smart notes / wake plane — pass in source and integration fixtures

`wakePlaneStatus` recognizes only the affirmative `wake.create` catalog capability, caches it for a bounded TTL, and treats daemon failure as `unknown` so standalone evaluation resumes. Both the dream task and timer sweep gate before QuickJS when the wake plane is present. Otherwise all lanes use the same condition compiler, policy version, QuickJS sandbox, and evaluator.

Rust-authority smart-note writes additionally require `noteEvaluationAvailable(project)`. Rust preparation registers a per-project bridge; the host mirrors compilation metadata, evaluates the mirrored note, and sends `note.evaluate` back with status-version protection. A project without that bridge fails closed rather than accepting an unevaluable smart note. Pi's authoring adapter reaches the same compiler/wake gate. Existing wake-plane, sandbox, OpenCode tool, module facade, and Pi smart-note fixtures cover present/absent/unknown catalogs and identical condition decisions. No lane-specific condition interpreter was found.

### D. Dashboard reads versus engine truth — structural brief, no dashboard edit

**Verdict: the dashboard is not an engine-truth parity surface today.** OpenCode cache cards derive provider cache events from the OpenCode database. `mc_cache_state` is consulted only to identify managed external Claude Code/Codex sessions (including composite session keys); OpenCode is treated as plugin-managed independently. The dashboard has no `mc_pass_trace` query. By contrast, module `session.status` reads both `mc_cache_state` and `mc_pass_trace` and exposes scheduler history, receive/reject counters, and divergence state.

**Brief:** add a read-only engine-status projection keyed by OpenCode session ID for Rust-mode sessions. Join dashboard rows to live config-verified authority, read the exact `McStore::load_session_status_snapshot` projection (or one versioned RPC equivalent), and label provider cache metrics separately from scheduler/engine metrics. Acceptance requires a paired TS/Rust fixture with the same provider events where provider totals remain equal, Rust rows display engine receive/reject/decision/divergence fields, TS rows explicitly show “TS authority / no module trace,” composite child keys cannot leak into the parent, missing/stale stores degrade to “unavailable,” and the dashboard never infers historical decisions from current `mc_cache_state.meta`. This remains read-only and does not change engine state.

### E. Commit index and note nudges — index pass; Rust nudge defect fixed

Git ingestion is project maintenance, not transform authority: OpenCode TS/Rust register the same project timer, and Pi registers the same commit-indexing configuration. Storage, retention, FTS, embedding, and vector merge are shared.

**Fixed:** commit-detection note nudges were not authority-neutral. TS `tagMessages` scanned the five-message assistant tail with canonical `textMentionsRecentCommit`; Pi has a separate rising-edge adapter using that same detector. Rust returned before the TS tag walk and had no Rust twin, so an identical newly announced commit did not call `onNoteTrigger`. The recent-assistant scan is now a pure shared helper. TS tagging consumes it, while Rust runs it before module state sync without writing host tags. Both lanes use the same restart baseline and absent→present edge rule; subagents and compaction-off remain excluded. A two-pass Rust regression proves baseline silence followed by one durable trigger. Deliberately neutralizing the detector made it fail, and restoration passes.

### F. Differ unexplained-byte bucket — hermetic empty, live evidence pending

The existing TS↔Pi shape-space bucket still admits only divergent `same_effective_shape` axes, and facade parity still requires normalized byte equality for matched inputs. The new engine-adjacent inventory does not weaken either bucket or convert count differences into byte verdicts. The hermetic three-lane execution reports no unexplained wire/facade byte class, no duplicate FTS identity, and no mis-scoped chunk vector.

This is an honest narrow empty for the bucket only, not for the hunt. A live capture must adjudicate every lane-only byte shape against `packages/pi-plugin/PARITY.md`; durable coverage counts must be compared only for identical histories.

## Exclusion-fence addenda

No code was changed in `ctx_search` corpus/format, historian side-effect durability, `ctx_expand` titles, or wrapup/LKG fault handling. No new finding in those surfaces was required as an addendum. The vector-search conclusion concerns shared ranking over already-populated pools, not the fenced search result format.

## Verification

The hermetic differ, focused Rust outer-transform/binding regressions, plugin typecheck, and final plugin/Pi/Rust suites are the verification gates. The task delivery records exact commands and results. The two deliberate mutation runs described above reddened the intended regression assertions and were restored before final verification.

## Honest-empty declaration

Hunt #6 is **not empty**. It fixes three Rust embedding trigger/scope defects and one Rust commit-nudge trigger defect, extends the differ with privacy-preserving engine-adjacent state evidence, and records one dashboard engine-truth structural brief. The standing honest-empty counter remains **0/3**. No master push is part of this work.
