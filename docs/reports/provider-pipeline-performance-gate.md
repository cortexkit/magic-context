# Provider pipeline performance gate: verified partial, cutover blocked

## Decision and evidence boundary

The four cutover requirements—ordinary latency (P1), rebuild latency (P2),
logical durable payload limits (P3), and 24-hour cache stability (P4)—are **not
passed**. No read-only ALF session capture or 24-hour ALF canary
was supplied. The owner approved a partial delivery: real-host lanes, a fail-closed
measurement gate, synthetic Mac early signals, an instrumentation plan and a canary
runbook. The canary must wait until the migration branch reaches master and ships.
This slice neither changes defaults nor adds production instrumentation. No operator
database, live configuration, external repository source or model credentials was read.

The new manifest rows select the provider pipeline on OpenCode **1.18.x** and
**2.0.x**, not Pi/OMP. They test routing using durable `host_runner_state`/entries
and tagged bytes at the recording provider, then compare the surviving wire prefix
across two turns. The OpenCode 1 lane checks host descriptors with `lsof`; the
OpenCode 2 runner performs its existing descriptor/write-fence checks.
Execution is **blocked** here: the Linux run reached both tests, but neither passed
its preflight because `MC_E2E_CK_SUBC_BIN` was absent. Supply a complete CI-built
module/daemon pair and the fault variant (`MC_E2E_CK_MC_PREBUILT_BIN`,
`MC_E2E_CK_SUBC_BIN`, `MC_E2E_CK_MC_DRIVE_FAULT_BIN`), matching this source revision,
plus the pinned hosts and `lsof`. These tests do not build an operator's daemon checkout.

```sh
bun test --max-concurrency=1 --timeout 600000 \
  packages/e2e-tests/tests/rust-provider-pipeline-opencode1.test.ts \
  packages/e2e-tests/tests/rust-provider-pipeline-opencode2.test.ts
```

## Synthetic Mac signal — not P1 or P2 acceptance

Command, executed on the Mac with its local optimized real `McHandler` test
executable (not a remote binary):

```sh
bun packages/e2e-tests/scripts/provider-pipeline-synthetic.ts /tmp/provider-pipeline-synthetic-t2.json
```

Bun **1.4.2**, Cargo **1.99.0 (5f94df478 2026-08-27)**, darwin/arm64.
The fixture has **17,000 messages**, **10,200 tool-bearing assistant messages** and
**20,400 completed tool parts**. Each five-message cycle contains one user, three
assistants with text plus two tool results, and one final assistant. Prose/output
is deterministic fixture content; this is an explicit density assumption, not a
measurement of ALF's live distribution. The context window is 4,000,000 to keep
fixture pressure from being confused with engine throughput. There is no live
OpenCode subprocess in this replay: both host bindings use the real adapter and
real module test handler over a JSON-lines pipe, with isolated stores.

Original synthetic performance replay (T2), before the identity fix (five
full-request engine+codec samples per binding, including the cold
first sample; nearest-rank quantiles):

| Synthetic binding | full-request engine+codec p50 | p95 | Provider ordinary / rebuild |
| --- | ---: | ---: | --- |
| OpenCode 1 | 1835.369 ms | 35942.171 ms | blocked at bootstrap |
| OpenCode 2 | 2423.781 ms | 23248.332 ms | blocked at bootstrap |

The original OpenCode 1 and OpenCode 2 switch attempts returned exactly:

```json
{"code":"transient","message":"CK message block identity drift for mid synthetic-16998"}
```

The last successful step answer before that refusal was `wait`, reason
`Awaiting the next host status page`, `bound_ms: 1`. The test handler then refused
the final `compaction.step` carrying `prefix_rebuilding.reason: pipeline_switch`.
That replay recorded the refusal and left ordinary/rebuild statistics **null**;
it does not time full-request fallback as a provider pass. Its diagnostic process
exit 0 means the report was produced, not that the performance gate passed.
The identity mismatch is resolved by the follow-up below; the drift refusal has
not been waived. The earlier user-text-only bootstrap fixtures did not exercise
the same protected assistant identities.

An exploratory incremental-ingest alternative (about 5,667 three-message passes)
hit the 30-minute cap before emitting results. It was stopped, not counted as a
measurement. The final driver uses a bounded bootstrap instead; it never retries
that timed-out alternative. No live store was involved.

The reusable script measures provider adapter entry to native output installation
(`publishMessages` uses `splice`, not property assignment), including the fixture's
sync seam, before recording/serializing the served corpus. It gathers 20 ordinary
samples after three warmups, with three appends each. The fixture clock advances
between turns instead of assigning every request the same timestamp.
Rebuild comparisons publish a completed historical cycle and append an assistant
with a new model key, then copy both isolated fixture databases (`store.db` cache
and `context.db` authority) using `VACUUM INTO`, outside the timer while the handler
is idle. Both arms must perform the same visible HARD rebuild and serve equal
output. A returned but unapplied view, timeout or fallback is not a P2 sample.
However, full-request timings include engine, codec and pipe rather than the
complete legacy host handler; sync is a no-change fixture seam and there are no
mirror pages. Hook round-trip samples are **not module-only timings**. Those
limitations prevent claiming the same-store live P2 comparison
or the sync/mirror-inclusive live P1 measurement requested by the spec.

### Bootstrap identity diagnosis and source fix

The deterministic small reproducer is **two assistant messages**, with **one
completed tool part** in the first message and a completed text-only second
message. The first message can contain only the tool: parallel calls, attachments,
many parts and an unfinished newest assistant are not necessary. Seed it through
the full-request handler, publish a compartment covering ordinal 1, run the full
handler again, then switch pipelines. Without the fix, the final
`compaction.step` with `prefix_rebuilding.reason: pipeline_switch` refuses
`CK message block identity drift for mid covered` on both bindings. Publication
provides a small, deterministic protected identity without manufacturing a large
context or editing cache rows. Unprotected small tails can instead re-adopt a
different identity, hiding the incompatibility.

The refusing path is `providers::compaction` into the transform engine's
`apply_once`, then `enforce_block_identity` → `identity_drift_requires_reject` →
`TransformError::IdentityDrift`. The display implementation supplies the exact
error string. The source identity vector is stored in `mc_block_identities`
(`mc-store/src/lib.rs`); provider ingestion/publication also compares those vectors
in `mc-store/src/provider_log.rs`. Stored/incoming ordered-vector equality, and
transform rejection for covered messages, boundary anchors or frozen-unit targets,
are unchanged.

The disagreement is the **CK block serialization**, not a reordered call/result
arc or a prematurely identified newest message. Full-request TypeScript ingress
supplies parsed CK JSON without Rust codec metadata and without the default-false
`provider_executed` tool flag. Native provider decoding adds
`provider_extras._cortexkit_codec` (`blockIndex`, `nativeIndex`,
`decodedFingerprint`) for lossless native-part alignment, and serializes typed
fields in a different key order, including the false tool flag. The projection
previously fingerprinted that complete stamped serialization as source identity.
For the isolated `tool` fixture (`assistant response`, call id `tool-call-1`,
empty input, output `tool output`), the exact conflicting SHA-256 values were:

| Block | Persisted full-request/TS identity | Old native-provider identity |
| --- | --- | --- |
| text | `317feebdeae7407eb2e8f1be42afd5696e09bd9404a75e8f9e8188e6f22caa0d` | `5501e71f04452e47dd660c447944698c0185b98d114b15259799399be50b3855` |
| tool_call | `6707a48c7d0b32532cc10776b580e4050c65096ca42ec4a7ba4d4a94d9e416a9` | `0a39becdc242c774d3fda692f85308a92605c8691d036d05734b7926403dd0d8` |
| tool_result | `f3e9b44238d3fd7d4a1949418673a2fc33b5333d20d1003fdcc2117512683626` | `07db854df13ad18fc1b1da10bdbd800f60395758bd7a4a208b45188f7ba75659` |

`providers/codec_opencode.rs` now marks the message-level identity profile, and
`ck_wire::block_identity_fingerprint` reconstructs the legacy sorted source JSON
for that profile only. It excludes private block-origin coordinates and the
omitted false tool flag; real content, true flags, and non-codec provider extras
remain in the identity. Block bytes, `content_hash`, native origin stamps and
other decoder callers retain their old representation. No stored row is rewritten
to excuse a mismatch, and no check is weakened or bypassed.

The new differential switch case also covers two parallel tools, a result with a
PNG attachment, 32 tool parts in one message, and an unfinished newest assistant
whose tool result is complete. It requires no fallback, byte-identical serving,
and unchanged persisted identities (not re-adoption). A separate changed covered
tool-output case still refuses with the exact drift error. Rust controls pin
legacy/native identity equality and detect changed output, input, call id, tool
name and a true `provider_executed` flag.

Two restored mutation runs replaced the source identity basis with the old
stamped-wire hash. Only
`providers::codec_opencode::tests::opencode_source_identities_match_legacy_tool_ingress`
failed in the two-test Rust run; the content-drift test stayed green. Only
`OpenCode1/A10.legacy-tool-identity-switch` failed in the two-case adapter run,
with the provider rebuild request (`compaction.step`) refused for a covered
source-identity mismatch; the intentionally changed tool-output refusal case
stayed green. Each run had a one-file diff (+2/-7) while mutated and an empty
unstaged diff after restoring the staged live source.

### Follow-up synthetic P1 result; P2 remains blocked

Final command (Bun 1.4.2, Cargo 1.99.0, darwin/arm64, local optimized handler):

```sh
bun packages/e2e-tests/scripts/provider-pipeline-synthetic.ts /tmp/provider-identity-t2-delivery.json
```

Both **OpenCode 1 and OpenCode 2 bindings complete the provider switch**, with
17,000 base messages, 10,200 tool-bearing assistants and 20,400 completed tool
parts. Ordinary samples contain three appends and no fallback. These are
**synthetic measurements, not real-host or ALF acceptance**:

| Synthetic binding | Ordinary samples | P1 p50 | P1 p95 | Hook round-trip samples / p50 / p95 | P2 |
| --- | ---: | ---: | ---: | --- | --- |
| OpenCode 1 | 20 | 2670.971 ms | 3608.649 ms | 100 / 426 ms / 1139 ms | blocked |
| OpenCode 2 | 20 | 2150.691 ms | 2795.513 ms | 100 / 332 ms / 823 ms | blocked |

These ordinary-pass results exceed the P1 thresholds; completing bootstrap is
not performance acceptance. P2's five applied-view pairs were not obtained, so
`provider_rebuild` and `rebuild_vs_full_ratio` remain **null**, not fallback or
timeout timings. The only full-request rebuild sample per binding was 41770.998 ms
and 41785.057 ms respectively; a one-sample population is diagnostic, not a P2
quantile. The first provider attempt installed output after 31071.319 ms / 30717.605 ms
without applying a new view. A late `compaction_message` arrived on both bindings;
the subsequent diagnostic retry also failed to apply within its budget.

### Separate large-rebuild deadline diagnosis — not fixed here

The remaining stop is **not block identity drift, status-frame oversize or an
unfinished newest assistant**. The adapter's model-switch path calls
`ProviderClient.bootstrap` (`opencode-adapter.ts:1328-1363`), with the
30,000 ms bootstrap budget supplied at `opencode-adapter.ts:327,431-437`.
`ProviderClient.page` uses that budget for the request fence
(`provider-client.ts:790-803`). In `ProviderClient.send`, the timer expires while
the module call is outstanding (`provider-client.ts:532-563`); the aborted-call
catch returns `unavailable`, reason `timeout` (`:583-589`). The adapter's
`answer` returns false without applying a view (`opencode-adapter.ts:703-710`),
and `bootstrap` ends the attempt (`provider-client.ts:866-868`). Ordinary hooks
can still succeed and the existing prefix can still be served, with no module
error or full-request fallback in the fixture.

A read-only runtime wrapper around the real client methods observed a **701/702
byte status request**, 30,000 ms remaining budget, and timeout returns after
30000.969–30007.022 ms. This rules out the 3 MiB frame cap and pagination as the
stop in these runs. Draining the isolated handler's outstanding reply produced a
late `compaction_message`: the engine does finish, but the timed-out host attempt
does not apply it.

There is **no message-count predicate or deterministic size threshold** in this
path: the condition is response latency exceeding 30 seconds. The smallest
deterministic existing control has **one message**, with its real reply delayed
30,050 ms (`A10.bootstrap-timeout-full-request-late-retry`, still green). For
unmodified tool-dense workload probes on this machine, 7,500 base messages completed
all five rebuild pairs on both bindings (provider p95 7565.098 / 7805.188 ms).
The **smallest tested failing dense corpus was 15,000 base messages** on OpenCode 2,
at the first rebuild after 24 ordinary appends plus one model-switch append
(15,025 total messages, 18,000 base tool parts). OpenCode 1 completed all five at
that size. Both 16,000 and 17,000 base-message probes had timed-out attempts; exact
onset varies with CPU/cache load and must not be presented as a fixed session-size
limit or an exhaustively minimized latency boundary.

This is a **production deadline/liveness risk exposed by the synthetic backend**,
not just the driver's former one-pass assertion. It does **not establish that a
real session can never rebuild**: a 17,000-message OpenCode 1 probe and a
16,000-message OpenCode 2 probe applied a subsequent retry when the response fit
the budget; other retries exceeded it again. No live-host latency was measured.
The separate follow-up should profile the large native rebuild and its retry
epoch, then test whether repeated over-budget attempts can be acknowledged safely
without rebuilding forever. This slice leaves the deadline and retry policy alone.

The earlier measurement-driver assumptions were also corrected: an unchanged
flush may legitimately return noop; copying only `store.db` omitted the
`context.db` publication rows; full/plain-HARD versus provider-SOFT outputs are
not equivalent paired rebuilds. New pairs include authority snapshots and a
publication/model-switch trigger, and require an actually applied, matching view.
The original report had **no P1/P2 provider timings** (they were null), so none
are retroactively invalidated. Its pre-switch full-request-only p50/p95 figures
remain historical engine+codec diagnostics, **not P2 baselines**; they are not
comparable to the newly published/model-switched rebuild samples. Any exploratory
store-only clone comparison must be discarded. Per the reviewer decision, the
identity fix is delivered without a second production latency/policy fix.

Follow-up verification: Linux `cargo test -p mc-module --lib` passed **1857 tests**
(25 ignored), including all provider and step-transform controls; Linux
`cargo test -p mc-store` passed **314 tests** (5 ignored). T1
`pure-replay-differential.ts --provider-pipeline` passed **88 cases**: the original
84 plus the new success/refusal cases on both bindings. Plugin typecheck passed
with TypeScript 5.9.3. The provider-script typecheck still reports only the two
inherited errors listed in the original verification record below. A project-parsed
compiler check covered both edited scripts and 1,688 source files, allowing only
those exact two inherited diagnostics; no new diagnostics remained. Scoped edited
file diagnostics report no errors or warnings (one deprecated `context.exec` API
hint; call-graph health categories unavailable). Evidence is retained outside build directories
in `/tmp/provider-identity-t2-delivery.json`, `/tmp/provider-identity-t1.log`,
`/tmp/provider-identity-mutation.log`, `/tmp/provider-identity-switch-mutation.log`
and `/tmp/provider-rebuild-diagnose-{7500,15000,16000,17000-complete}.log`.

## Fail-closed gate and input contract

```sh
bun packages/plugin/scripts/perf-audit/provider-pipeline-gate.ts capture/measurements.json
```

The script reads capture JSON and captured provider dumps only. It never opens a
live store. Exit **0** means all measured gates passed, **1** means a measured
threshold failed, **2** means evidence is absent/invalid (blocked). The exported
`MeasurementBundle` type in that script is the exact version-1 input schema.
Synthetic bundles, missing counters, unsupported host versions, wrong timer scope,
small corpora, empty timing populations and missing canary dumps cannot pass.

The collector must supply `measurement_kind: live`, `machine`, a
`session_copy_sha256`, `message_count`, `frozen_unit_count`, and
`timing_scope: handler_entry_to_output_assignment_including_sync_and_mirror`.
The minimum fixture is 7,500 messages/49,000 frozen units. Every pass supplies
`host`, `host_version`, `pipeline`, `pass_kind`, `appended`, `pass_ms`,
`hook_count`, `hook_module_ms` and every byte/page counter below. The hook population
must match its independently recorded count. Each host has at least 20
ordinary samples and five rebuild/full pairs. These minimum sample counts are
gate policy for meaningful quantiles, not additional spec performance targets.
Use nearest-rank p50/p95, reported separately per host, never pooled.
Full-request/rebuild pairs have unique `comparison_id` and identical
`starting_store_sha256`; zero full-request baselines are rejected.

| Criterion | Implemented threshold |
| --- | --- |
| P1 | Ordinary/no rebuild/≤3 appends: p50 ≤30 ms, p95 ≤120 ms; module hook p50 ≤5 ms |
| P2 | Rebuild p50 ≤1.10 × same-starting-store full-request p50 |
| P3 host | `host_logical_payload_bytes` ≤ `ingest_json_bytes` + `hook_ops_json_bytes` + 1024 |
| P3 module | `module_logical_payload_bytes` ≤ `appended_message_bytes` + `answer_json_bytes` + `tag_row_bytes` + 1024 |
| Background | Report `background_delta_bytes` alongside P3, **exclude** from both limits; ≤20 pages, each ≤1,000 rows |
| Physical | Report `host_db_bytes`, `host_wal_bytes`, `module_db_bytes`, `module_wal_bytes`; do not gate |
| P4 | ≥24h ALF canary; zero priced busts without an applied-view, declared-prefix-event or exit-pass ledger entry |

Both host populations require ordinary fixtures `large-replace`, `many-text-block`
and `post-publication`. The latter has zero appends and nonzero background bytes;
its message/ops/answer/tag budget components must all be zero, leaving only 1 KiB
of state on either side. Budget fields must come from independently counted
actual encoded payloads, not from expected values in a fixture or WAL growth.

P4 invokes `analyzeOpenCodeCacheBustSession` from `analyze-cache-busts.ts`, with
an exact session id, explicit captured Anthropic/OpenAI directories and explicit
start/end times. It requires observations within five minutes of both edges of
the ≥24h window. This edge tolerance is a coverage policy, not permission to
lose requests inside the window. `UNMETERED`/`LATENCY` observations block sign-off.
Each priced `BUST` must join the event ledger by exact request timestamp. The
ledger contains `at`, `kind: applied_view | host_prefix_event | exit_pass`, and
nonempty `evidence_id`. Duplicate event timestamps are rejected. The collector
must bind durable evidence to actual request timestamps; a nearest-in-time
scheduler decision is not authority to explain a provider-pipeline bust.
This gate trusts the capture collector's counters and ledger; it is not a
replacement for implementing/test-driving that collector.

## Exact instrumentation required before live measurements

**None of the following production emitters is added by this slice.** Implement
them as a separate slice, with independent counter tests and restored mutations,
before enabling the canary. Append structured pipeline fields to the existing
pass log and correlate module completion rows by pass id/request id/session/harness.
Do not sample or round before producing quantiles.

| Fields | Emission/accounting site | Reader |
| --- | --- | --- |
| `pass_id`, `session_id`, `host`, `host_version`, `pipeline`, `pass_kind`, `appended`, `pass_ms` | Begin at `createOpenCodeProviderTransform.run` entry in `host-runner/opencode-adapter.ts`; stop after actual `publishMessages` output splice. Include sync and bounded memory drain before installation. Classify applied rebuilds and exits explicitly; extend full-request handler logging to the same boundary. | Capture collector → gate P1/P2 |
| `hook_count`, `hook_module_ms`, module `request_id`/`pass_id` | `McHandler::provider_hook` / `provider_host_hook` in `crates/mc-module/src/providers/step_transform.rs`: monotonic entry through completed answer serialization; count issued hooks independently and record module duration separately from host transport duration. Missing timings for issued hooks block measurement. | Joined capture collector → gate P1; never substitute RPC duration |
| `ingest_json_bytes`, `hook_ops_json_bytes` | UTF-8 encoded admission `ingest` and persisted ops at `commitHostRunnerPass` in `storage-host-runner.ts`; count once per newly appended message, not the whole served array. | Gate P3 host budget |
| `host_logical_payload_bytes` | Count actual logical serialized transcript/ops and state values submitted to durable writes in `commitHostRunnerPass`/`writeState`, after successful transaction. Count rewrites as writes, not net database growth. | Gate P3 host actual |
| `appended_message_bytes`, `answer_json_bytes`, `tag_row_bytes`, `module_logical_payload_bytes` | `insert_message_tx`, `insert_tags_tx`, `commit_provider_delta`/`commit_provider_hook_with_parts` in `crates/mc-store/src/provider_log.rs`: actual UTF-8 message/answer/tag/state row payload written after commit. Idempotent no-op writes count zero; existing-message rewrites must be observable. Track state separately so message totals cannot borrow the background budget. | Gate P3 module budget and actual |
| `background_delta_bytes`, `background_page_rows` | Attribute state-sync delta writes in `syncModuleState`/`resolveStateSyncDeltas` (`module-state-sync.ts`) and corresponding module authority transactions; attribute memory-mirror page commits in the provider sync/drain path. Emit one combined pass ledger, with page row counts; prevent two separate drains from each consuming 20 pages. Include their time in `pass_ms`, never include their bytes in message payload actuals. | Gate P3 report/page bound; P1 includes elapsed work |
| `host_db_bytes`, `host_wal_bytes`, `module_db_bytes`, `module_wal_bytes` | Collector stats on isolated copy files immediately before/after each pass; retain both readings, checkpoints and deltas for diagnosis. The measurement bundle's pass rows contain after-pass sizes, which the gate's P3 output reports without a threshold. | Gate physical report only |
| `comparison_id`, `starting_store_sha256`, `session_copy_sha256`, message/frozen-unit counts, machine/build ids | Collector snapshots/checksums an isolated, checkpointed starting store before branching paired arms; bind host and module stores in the combined digest. Preserve provenance outside target/dist. | Gate P2 pair validation and fixture-size admission |
| `request_timestamp`, `provider_request_id`, `pass_id`, `event_kind`, `evidence_id` | At applied durable view (`commitHostRunnerAnswer`), declared `record.ts` prefix event, and durable `commitHostRunnerExit`, then bind the event to the request actually emitted by the host. Also log pipeline routing on every pass, including unavailable/refused passes; never infer from default config. | Collector's canary ledger → gate P4 exact timestamp join |
| Complete `.meta.json`, `.body.json`, `.response.json` dump triads, exact session id and timestamps, response usage meters | Existing provider wire capture; export all requests/responses for the canary, not just busts. Track capture sequence continuity and refusals so missing data cannot be signed off as stability. | `analyze-cache-busts.ts` CLI/API → gate P4 |

The module/host counter accounting needs tests for large replace answers, many
text blocks, zero-appends after memory publication, retries, no-change sync and
the combined 20-page bound. Actual write totals and budget components must be
independent. This report does not claim that production currently emits them.

## Canary runbook after shipment and instrumentation

1. **Session:** use the owner's long-lived live **ALF head session**, not the
   synthetic fixture, a fork, or a worker child. Record its exact OpenCode session
   id as `ALF_SESSION_ID`, host generation/version, model, build revisions and
   copy provenance in the capture. No id was supplied for this partial. Obtain it
   from the running host/owner at rollout; never enumerate the operator's stores
   from an editing worktree. Abort if exact session or capture provenance is absent.
2. First run paired isolated-copy P1/P2/P3 measurement on the shipped binary with
   the instrumentation above. Keep source stores read-only; all writes target
   separately owned throwaway copies. Verify the gate's required fixtures and both
   pinned host versions. Resolve the tool-dense bootstrap's `CK message block
   identity drift` refusal first: it prevents provider admission and leaves no
   ordinary/rebuild population to measure.
3. With owner approval, set the ALF host's **user-level** config to
   `transform_mode: "rust"`, `rust_pipeline: "provider"`, with compaction **enabled**.
   Restart that host to recreate its transform dependencies, preserving its session.
   Project config strips `rust_pipeline`; it is absent from the live-reload path
   list, so a project edit or ordinary live-config refresh is not a rollout.
   Verify a logged provider pass and durable runner admission, not
   merely the config text. Choice is process-wide; do not promise per-session
   isolation if the host serves other sessions. Do not alter defaults for other users.
4. Capture ≥24 continuous hours of this session after successful bootstrap. Set
   explicit `OPENCODE_ANTHROPIC_AUTH_DUMP_DIR` and `OPENCODE_OPENAI_AUTH_DUMP_DIR` for
   the host's existing authenticated-provider dump capture, and retain its complete
   dump triads, host `MAGIC_CONTEXT_LOG_PATH`, module timing/write ledger, config/build
   provenance and applied-view/prefix/exit ledger. Check that the installed provider
   adapters actually write both bodies and metered responses before starting the
   clock; directory variables alone do not enable an adapter lacking capture support.
   This repository's live-provider helper identifies Anthropic's auth config via
   `OPENCODE_ANTHROPIC_AUTH_FILE` (its fixture disables `dump.enabled`) and OpenAI's
   via `OPENCODE_OPENAI_AUTH_FILE` (its fixture disables `dump` and
   `CORTEXKIT_OPENAI_AUTH_DUMP`). Adapter implementations are not in this worktree:
   verify the shipped adapters' enablement instructions and observed triads rather
   than assuming that reversing those disable controls enables capture.
   Restrict artifacts: request dumps can contain sensitive user content. Do not
   commit them. Export to a permission-restricted read-only capture directory outside
   regenerable build output; export an untruncated machine-readable measurement bundle.
5. Record ISO `CANARY_START`/`CANARY_END` spanning at least 24h. Analyze the complete
   explicit capture (no request `--limit` and no live database reads):

   ```sh
   bun packages/plugin/scripts/analyze-cache-busts.ts \
     --session "$ALF_SESSION_ID" \
     --anthropic-dir "$CAPTURE/anthropic" --openai-dir "$CAPTURE/openai" \
     --mc-log "$CAPTURE/host.log" \
     --since "$CANARY_START" --until "$CANARY_END" --all-rows --all-busts \
     > "$CAPTURE/cache-bust-analysis.txt"
   bun packages/plugin/scripts/perf-audit/provider-pipeline-gate.ts \
     "$CAPTURE/measurements.json" > "$CAPTURE/gate-result.json"
   ```

   Analyzer success alone does not prove P4: every priced bust must also join the
   durable event ledger; gate exit 0 and an independent completeness check are required.
   Apply the table's P1–P4 thresholds exactly. Missing meters, dropped captures,
   unexplained busts, missing payload counters or a shorter window block cutover.
6. **Off/rollback:** change the effective `rust_pipeline` back to `"full_request"`
   (leave Rust mode and compaction enabled) in user config, then restart the host.
   Preserve runner rows; do not erase evidence or reset
   namespaces manually. Zero-divergence sessions roll back without a rebuild;
   diverged sessions use the declared fresh-namespace rebuild once. Record that exit
   pass and keep collecting through recovery. An unexpected bust aborts the canary
   and keeps default-provider cutover blocked until resolved and remeasured.

## Verification record

- Linux Bun 1.4.2: gate + manifest validator: **13 passed**, 0 failed, 86 assertions.
  Inventory assertions increased from 184 to 186 files and 59 to 61 Rust entries
  solely because this slice adds two real-host tests; no behavior contract was reversed.
- Gate's P3 non-vacuity control: ignored host payload overruns only on append passes.
  `P3 gates logical payload while reporting and excluding background delta bytes`
  alone failed; the other six gate tests passed. Restored from the staged live file;
  diff-stat was one file/+1/-1 while mutated and empty after restoration.
  A preliminary broader mutation also reddened the zero-append test (five passed,
  two failed), then was restored before applying the selective control. Neither
  mutation remains in this tree.
- Root required Linux gates: `npm run build` passed all three package builds;
  `npm run typecheck` passed all four package scripts; `npm run lint` passed
  (Biome 2.5.1: 1,352 + 258 + 137 + 6 = **1,753 files**, existing warnings).
  TypeScript **5.9.3**. Root `npm run test` failed at plugin: **8,110 passed,
  9 skipped, 2 failed**, 8,121 tests/760 files. Failures were unchanged
  `Node WASM Transformers fixture > builds with real fs and persists a model for
  offline reuse` (cannot resolve `onnxruntime-web/webgpu` from temp bundle) and
  `sqlite writer diagnostics > a writer that waited for the lock reports the wait,
  not its short hold` (309 ms against <250 ms). Root chaining therefore did not
  reach the other packages' test scripts.
- Focused unchanged failure files: six tests, three passed/three failed. WASM
  failure reproduced; sqlite wait passed, while `a writer that held the lock reports
  the hold, not its quick acquisition` and `a fast writer stays out of the log`
  failed with extra diagnostic rows. No unrelated source or expectation was edited.
- `tsc --noEmit -p packages/e2e-tests/tsconfig.provider-pipeline-gate.json` passed.
  The broader `tsconfig.provider-pipeline.json` reports only two inherited errors:
  unchanged `src/rust-harness.ts:805`'s SDK `session.get` type and plugin
  `command-handler.ts:223`'s readonly `[ignore]` assignment. No new-file diagnostics
  remain. Scoped AFT diagnostics: four of four files authoritative, 0 errors/warnings;
  call-graph health categories were unavailable (partial inspection).
- Real-host tests: **0 passed/2 failed preflights**, absent prebuilt daemon. No
  claim of real-host execution beyond that preflight. Synthetic final Mac replay:
  ten full-engine samples and two provider refusals recorded above, not acceptance.
- Mac `provider-pipeline-differential.ts --case OpenCode1/T2.timing-boundary
  --case OpenCode2/T2.timing-boundary`: **two passed**, no failures, Bun 1.4.2 /
  Cargo 1.99.0. Both append and no-append timed passes reach output installation
  without fallback, preserve bytes, and exclude corpus serialization from timing.
- `cargo fmt --all`, `git diff --check` and `git diff --cached --check` passed.
  Read-only independent comment review completed; clarified the four requirements,
  physical-size report, bootstrap refusal, user-only/restart rollout and default
  cutover wording. No package-manager manifest or lockfile changed; no install needed.

### Outstanding gates

P1, P2, P3 and P4 remain unpassed. The identity refusal is resolved, but the
synthetic P1 signal is over budget and P2 is blocked by the separate rebuild
transport deadline described above. Next actions are: profile large provider
rebuild latency and deadline/retry behavior; run the two real-host lanes with the
matching binaries;
land the separate production instrumentation/capture collector; ship; obtain an
authorized ALF copy and live session id; then run and retain the paired measurement
and full 24-hour canary. Switching the default to the provider pipeline is not
authorized by this partial.
