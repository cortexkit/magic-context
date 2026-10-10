# Independent correctness review: issue 640

Reviewed implementation: `b6d051fa17a480d94562d61d1d9618685fa5f309`, relative to `989a1d2756`. Read issue #640 and the investigation **and appended implementation evidence** in `issue-640-subagent-busy-refusal.md`. This delivery adds tests and this report only; it does not repair implementation or change existing assertions.

## Summary

The ordinary OMP Anthropic replay repair, callable-schema conversion, acquisition-only retry, and revision-fenced adoption are useful and mostly correct. However, the new cancellation/supersession fence ends too early and the input projection is not valid for every supported Pi transport. There are also pre-existing adoption and OpenCode-order defects exposed by the standing rules.

The committed tests are **intentionally red against the reviewed revision**: seven Pi tests and one shared/OpenCode test fail on native macOS. Each asserts the required behavior, not the broken behavior. Five Pi controls (ten with the pinned OMP fixture) and three shared controls pass. No production code was mutated to obtain these failures.

| Finding | Severity | Origin | Failing tests |
| --- | --- | --- | --- |
| Root bookkeeping is wire-visible on Pi's `pi-messages` transport | Medium | New normalization overreach | two root-field tests |
| Supersession/abort is not rechecked after an admitted pass yields | High | New fence is incomplete | successor and signal late-adoption tests |
| An aborted superseded waiter calls the replacement's session-wide abort | High for a signal-supplying host; not reached by OMP 18.8.5's unsignalled context | New check ordering | aborted-superseded waiter test |
| Revision revalidation cannot recover historical fingerprints excluded before preparation | High | Pre-existing optimization retained by the fix | historical racing-drop test |
| An unsent real-id row wins over a previously served fallback number | High | Pre-existing collision policy retained by the fix | served-fallback number test |
| OpenCode retries the writer before trying an admissible saved request | Medium | Pre-existing default caller order; not a shared-helper regression | OpenCode replay-order test |

## 1. LKG input projection is not transport-independent

**Input:** a Pi 0.83 `pi-messages` model, a captured user/assistant prefix, and a later assistant record that adds either root `completedAt: 42` or `contextSnapshot: {promptTokens: 1000}`.

**Expected:** reject that prefix as `lkg_content_mismatch`, because the real outbound request body differs. Alternatively, only use the normalization on transports whose provider constructors prove those fields non-wire.

**Actual:** both replays return `ok: true`. The test invokes the installed provider's actual `stream`, intercepts its `fetch` without a network request, and compares the two serialized HTTP bodies. The new field is present in the second body. The serializer is not a hand-written projection.

**Cause / rule:** `pi-lkg.ts:452-469` removes the two properties for every non-array message object, without checking host version, role, API, or transport. Pi 0.83's `dist/api/pi-messages.js:248-272` puts the entire `context` into its payload and JSON-stringifies it. This violates the required fence against converter-visible edits / byte-identical request replay. It does **not** prove that the downstream model behind an arbitrary gateway reads those statistics; it proves a real transport-byte difference that the fence admits. Direct Anthropic/OpenAI/Google model-content bytes are a separate, successful control below.

The pinned OMP 18.8.5 `src/providers/pi-native-client.ts:184-191` has the same whole-context serialization to `/v1/pi/stream`. That is another relevant transport, although I did not run a gateway or assert downstream cache behavior. The implementation report's statement that output serialization is unchanged is true; it is precisely why serving the old stored objects can produce different gateway bytes from the current objects.

Failing tests in `packages/pi-plugin/src/issue-640-review.test.ts`:

- `review: Pi pi-messages wire-visible root completedAt invalidates LKG`
- `review: Pi pi-messages wire-visible root contextSnapshot invalidates LKG`

### What the projection gets right

I installed **OMP 18.8.5** in the worktree's ignored `.cache/issue-640-review/host`, and inspected the worktree's installed **Pi 0.83.0** package. A source sweep finds OMP's two field names only in `pi-ai/src/types.ts:1213,1278`, not direct accesses in its provider implementations; Pi's JS provider sources do not read them. This is insufficient by itself for serializers that send entire objects, hence the exceptions above.

Real-converter differential controls cover:

- Pi Google, Chat Completions, and Responses;
- OMP Anthropic, Google, Chat Completions, Responses native-history input construction, and the complete Codex request-body builder.

For every control, adding **both** root fields to user, assistant and tool-result records leaves converted bytes equal and allows replay. Changing a nested tool argument literally called `completedAt` changes the converter's bytes and rejects replay. An unknown root `futureProviderField` also rejects replay. The mixed fixture includes signed thinking, text, tool calls/results, and user/result images. These controls add coverage beyond the fix's Google/Anthropic differential; they are not an exhaustive generated test of all provider variants.

Static checks of the Anthropic/Bedrock constructors and Google-family delegation paths likewise show explicit wire-message construction, not root bookkeeping reads. Native Responses `providerPayload.items`, provider-specific thinking/signatures, `historyRewriteAt`, `prunedAt`, and `credentialId` are not removed by this projection. Nested messages/arguments/payloads are not recursively normalized. The exclusion is a literal two-key list, **not** an unknown-field wildcard. A differently named future field remains fenced; reuse of an excluded name as meaningful data on another API/version is not protected by a version/API allow-list.

## 2. An admitted pass can resume after cancellation or supersession

**Input:** an older context pass at 96% usage, with an in-flight historian promise. Its metadata transaction succeeds, then it suspends in the real emergency historian wait. Either (a) a replacement pass on the same session completes, or (b) the supplied host signal aborts. Resolve the historian afterward.

**Expected:** the older pass must not proceed into adoption/tagging or publish a served-array/LKG result. It should reject as superseded/cancelled, without touching the newer operation.

**Actual:** the older pass still creates `older:p0` and successfully returns `§2§ abandoned input` in the successor case, or `§1§ abandoned input` in the signal case. Both passes on one session can run the transform. The tests check both the returned outcome and durable tag rows, not only a timing/log predicate.

**Cause / rule:** `assertCurrentPass` runs around initial metadata admission (`context-handler.ts:2663-2725`) and at the outer catch (`:4220`), but not after the historian await (`:3402`), before fallback adoption (`:6096`), or on the successful capture/return path (`:4185-4218`). There are additional later yields at `await runPipeline` and auto-search. A successful stale continuation never reaches the catch fence. This violates the requested cancellation/supersession fence across adoption and permits abandoned work to replace per-session replay/served state.

Failing tests:

- `review: successor fences an admitted Pi pass before late adoption`
- `review: signal fences an admitted Pi pass before late adoption`

This is narrower than a claim that every unsent transform is wrong. A lone unsignalled abandoned OMP hook can intentionally commit replayable reductions, as the implementation report explains. The defect is that the code **does know** a successor/cancellation exists and nevertheless resumes mutating and returns success. The fixtures use the existing compatibility usage lane without a model; the yield and missing recheck are the same production emergency path. No artificial await was inserted into implementation.

## 3. Aborted + superseded is different from merely superseded

**Input:** hold a disposable database writer. Start an older waiter with a supplied signal and a session-wide `ctx.abort`, then start its replacement. Abort the older operation's signal while it waits.

**Expected:** classify the old waiter as superseded and never call its session-wide abort method.

**Actual:** the old context's abort method is called once. A real host implementation binds this method to the session, so that call can cancel the replacement rather than only the abandoned operation.

**Cause / rule:** `assertCurrentPass` first executes `signal.throwIfAborted()` and only then checks generation (`context-handler.ts:2489-2498`). The catch repeats this ordering. Thus a superseded waiter with an aborted signal escapes as the generic signal reason, not `PiContextSupersededError`. `pi-context-refusal.ts:43-69` suppresses abort **only** for that specific supersession error; it invokes `ctx.abort()` for the generic reason. This violates the explicit replacement-preservation rule in the implementation evidence.

Failing test: `review: an aborted superseded waiter must not abort its replacement`.

OMP 18.8.5's `emitContext` passes the signal to its internal handler runner (`extensions/runner.ts:1969-2003`), but `createContext` and the event do not expose it (`:1367-1387`, `:1994`). This finding is conditional on a host supplying the newly supported signal; it is not an assertion that current OMP provides one. The generation-only waiting test in `pi-writer-wait.test.ts` does not cover this combination.

## 4. Discovery's input set is already incomplete before revision fencing

**Input:** a previously served real-id historical message (`§1§ historical text`), no visible fallback rows at the pipeline preflight, and a new tail. Before adoption's revision snapshot, a second connection commits a dropped fallback row whose raw fingerprint matches that historical message.

**Expected:** adopt/fold that row onto the real historical identity and serve `[dropped §1§]`; no fallback duplicate should remain.

**Actual:** the outgoing history still contains `§1§ historical text`. The dropped fallback row remains unmatched. This is not an IN-query revision race: even a perfect rescan of the supplied bind batches cannot find the missing fingerprint.

**Cause / rule:** the preflight at `context-handler.ts:6084-6095` passes its negative result as `includeReusable=false` to `buildEntryFingerprintMap`. That builder omits already-served/reusable ids (`:2075`). Adoption's otherwise-correct `data_version` / `total_changes()` revalidation (`:2219-2261`) rescans only the shortened batches. It cannot reconstruct excluded historical targets. This misses a concurrent writer's committed drop and violates reduction replay / authoritative adoption. On a subsequent pass the now-positive preflight can discover it, but the current pass has already served unreduced bytes for that target.

Failing test: `review: adoption discovers a racing drop for an already-served historical message`.

The test uses a file-backed database and an actual second connection commit. The inserted fingerprint is calculated from the **pristine** historical message, not text after tag injection. Only the commit's placement is controlled by a prepare spy. This optimization was present before `b6d051fa`; the new inner revision checks do not close the outer negative-gate hole.

## 5. A committed row is not proof that its number was served

**Input:** first serve an in-flight user message under fallback identity as `§1§ served fallback`. Its real entry id becomes available. Between lock-free preparation and adoption BEGIN, another connection commits a matching real-id row numbered 9, with matching source content, but sends no provider request.

**Expected:** preserve the message's actually served number 1.

**Actual:** the next output is `§9§ served fallback`. No text, timestamp, or other semantic content changed.

**Cause / rule:** `storage-tags.ts:1822-1836` always selects the existing real-id duplicate as survivor and deletes the fallback number. Its comment assumes that a real row's number is already visible. The handler rebinds aliases to that survivor (`context-handler.ts:2295-2303`). A writer can commit such a row and then abandon/fail its request; neither row identity nor commit implies a serve acknowledgement. This breaks the absolute standing rule **served tag numbers never change for a served message**.

Failing test: `review: a racing real-id row must not renumber the already-served fallback message`.

Matching source content is seeded for the racing row so this is a real adoption collision, not source-vector drift/intentional retagging. The implementation's existing collision test preserves a purportedly served **real** row; it does not preserve a genuinely served fallback against an **unsent** real row. The collision policy predates the fix. The report's abandoned-hook argument therefore needs this identity exception acknowledged even though ordinary stored drops and watermarks replay correctly.

## 6. OpenCode's default callers still violate LKG-first ordering

**Input:** the real `createMessagesTransformHandler`, a valid saved managed prefix, matching `openai/gpt-4.1` identity, recorded current system/tool sizes, a known 1,000,000-token window, and one failed BEGIN followed by a successful retry. The test explicitly checks `lkgReplayFits(...).fits === true` before inducing contention.

**Expected under the stated order:** after the first failed acquisition, serve the admissible saved request before backoff. One BEGIN, no transform callback.

**Actual:** it retries BEGIN after backoff, executes the transform once and serves its recomputed output (the focused run observes three total BEGIN calls, including other wrapper/persistence work). LKG is tried only if admission/transform eventually throws. With sustained contention that can spend the full admission allowance before replay.

**Cause / rule:** `plugin/messages-transform.ts:382-419` awaits the shared helper with an empty callback and **no** `beforeRetry`. LKG lives in the outer catch (`:484-558`). The new Pi caller supplies the option; OpenCode's default callers do not. This violates the literal cross-host **LKG, retries, visible refusal** ordering, but it is a pre-existing behavior, not a regression from the callback no-retry change. The test does not claim a raw-history escape or simulate a production transform implementation; it observes the actual wrapper's ordering and whether it calls its transform at all.

Failing test in `packages/plugin/src/shared/sqlite-640-review.test.ts`: `review: OpenCode tries a valid saved request before backed-off writer retry`.

## Shared writer review: every production OpenCode caller

A repository-wide `withAsyncPrivilegedWriter(` search found these four OpenCode call sites, the one Pi session-meta call, test/perf fixtures, and no other production callers. All four OpenCode operations passed to the helper are **empty synchronous callbacks**. There is no OpenCode transform body inside that transaction to rerun. A hypothetical callback-started busy error therefore means privilege cleanup/COMMIT, not the later managed transform.

| Caller | What a surfaced busy error does | Coverage / observations |
| --- | --- | --- |
| `plugin/messages-transform.ts:387` (OpenCode 1 and shared OpenCode 2 wrapper) | Outer catch tries validated/fit-checked LKG; if unavailable, throws `StorageBusyRefusalError` and notifies through the host callback. Compaction-off restores raw by explicit opt-out. | `plugin/storage-busy-policy.test.ts` covers both adapters' LKG, refusal, retry-on-BEGIN, uncontended byte equality and compaction-off paths. New COMMIT and rollback controls test the helper directly. Its LKG-first order remains the finding above. |
| `v2/hooks/context.ts:1403` | Catch at `:1813-1863` attempts wrapper LKG, otherwise records a visible notice, calls `refuseBeforeProvider`, and throws `V2ContextRefusal`. | Existing v2 refusal tests pass in the full suite. No new callback body is introduced; the first admission can precede the shared wrapper. |
| `v2/hooks/tools.ts:92` (`ctx_memory`, `ctx_note`, `ctx_reduce`) | Propagates a tool execution error before parsing/executing the definition. There is no request-history fallback or LKG for this tool action. | The definition is not run after failed admission. Existing registered-tool tests pass. This is a tool failure, not a provider-turn refusal mechanism. |
| `hooks/magic-context/rust-mode-transform.ts:4215` | Transient preflight failure is caught locally; proceeds with already-produced **module-managed** output and its narrow host postprocess. Optional marker admission can defer; other escaped failures go through Rust/wrapper replay-or-refuse handling. It does not return the original raw history because this admission failed. | Existing Rust acquisition test at `rust-mode-transform.test.ts:7709-7758` uses the helper in a fake module callback, not a proof of a nonempty production admission callback. Full Rust postprocess/marker tests also pass. |

The shared no-retry change is correct for these callers: none needs reexecution of a callback that has begun. New controls verify a callback that writes and throws `SqliteAcquisitionBusyError` runs once, rolls back, and never invokes `beforeRetry`; a COMMIT `SQLITE_BUSY` is surfaced once and leaves no transaction open. The default-option empty callback still retries only failed BEGIN and returns the same untouched output. More substantial byte-equivalence coverage remains the existing two-host storage-busy policy tests.

With default options there is no new jitter, signal, or LKG callback. Budget (16,500 ms), short timeout (25 ms), and 500/1,000 ms backoff remain unchanged. No OpenCode hashing or output serializer was edited. I found no new raw-history escape due to the shared callback-started error behavior; the ordering defect is in the unchanged caller arrangement.

## Other checks found correct, and limits

### Fit envelope

- The actual OMP 18.8.5 `utils/schema/wire.ts:598-607` resolves callable ArkType schemas via `arkToWireSchema` and upgrades legacy object schemas. The resolver imports the serving CLI's import-only export and does not invoke a validator as a factory. Existing import-resolution and pinned callable-schema tests cover those contracts.
- New control `review: an unavailable or broken wire-schema export cannot price callable parameters` verifies absent resolver, undefined result, and throwing conversion all produce an incomplete envelope; the callable validator throws if invoked, so accidental factory invocation cannot pass unnoticed. Plain Pi JSON-object parameters still produce a complete envelope without OMP installed.
- `readPiLkgFitEnvelope` rejects null, array, non-object or throwing conversion and incomplete metadata; `assertPiRawFallbackFits` declines an incomplete envelope. A missing export on an older/newer OMP with **callable** schemas therefore fails safe. An arbitrary future host that changes the meaning of an **object** schema is not proven compatible: the loader has no version negotiation and absent conversion deliberately falls back to the object. I did not install imaginary host versions or add compatibility shims.

### Acquisition and tag preparation

- Initial Pi session-meta read/create is inside the acquired transaction, not an empty reservation. Acquisition retry yields and never retries an entered callback. The existing tests for transaction ownership, short successful release, valid LKG before backoff, signal cancellation while waiting, and generation-only supersession all pass.
- The normal no-successor/no-signal abandoned-transform replay claim is supported by the existing repeated-raw tests and by the new fix's metadata/unsent-output equality test. It is **not** sufficient for the concurrent identity collision or known cancellation cases above.
- `data_version` observes other-connection commits; `total_changes()` observes this connection's writes. Inside successful BEGIN, authoritative fallback existence/rows and collision decisions are reread. The fix's external/local negative-discovery controls pass. Those checks are valid for fingerprints actually prepared.
- New control `review control: lock-free owner preparation adopts a sibling's later committed tool owner` starts with no fallback tool owner, prepares the `(timestamp, callId)` map outside a transaction, commits a dropped synthetic owner on a second connection immediately before BEGIN, and confirms one real owner with the same number/status plus the tagger alias. This specifically exercises a formerly negative owner discovery, rather than merely observing the map's construction. No wrong-owner mapping was found in that lane.
- Existing ambiguity, owner collision, pending-op retargeting, MAX accounting, and dropped-status controls pass. Message/owner preparation is synchronous and does not publish a detached partial transaction. These controls do not negate the missing historical fingerprint or actually-served-number findings.

### Sustained contention and timing assertion changes

The full Pi suite exercises the independent long-held writer in `issue-601-pi-admission-review.test.ts`: usable LKG stays fast, invalid/partial replay spends the shared allowance then visibly refuses, and the writer remains held at refusal. The 3.2 s first-pass holder now releases before a managed tagged request is served. The guarded abort/display-entry checks remain; no first-pass raw exemption was added. The investigation appendix's actual OMP 60 s trial likewise records visible refusals and zero provider requests while held. I did **not** repeat a real CLI 60 s child lifecycle run; that evidence is from the reviewed report, not a new observation.

The timing updates are legitimate contract changes, not deletion of the raw-send guard:

- `issue-601-pi-admission-review.test.ts` retains the short ceiling for replayable inputs; non-replayable inputs now have a 16.5 s lower bound and 18 s upper ceiling, plus held-writer and refusal checks.
- The old early-refusal assertion for a 3.2 s holder is replaced by an actual managed-tag success assertion, no abort/no display refusal, elapsed lower/upper bounds, and restored production busy timeout.
- The emergency test's timeout increase from the package's 30 s default to 40 s accommodates two sequential acquisition waits (about 33 s); its emergency/refusal assertions were not changed.
- The replaced no-owner-map gate asserted a now-unwanted optimization. The replacement verifies construction happens outside the writer; the new sibling-commit control verifies why that preparation is necessary.

The protected architecture section still requires identical defer replay and ride-only mutations. I did not change it. Existing byte-identical defer/drop/watermark tests passed, but the served-number collision demonstrates a separate violation that those ordinary replay cases cannot detect.

## Verification and isolation

Versions: **Bun 1.4.2 (744846f84)**, **TypeScript 5.9.3**, **Biome 2.5.1**.

| Final/native gate | Result |
| --- | --- |
| `bun run test`, `packages/pi-plugin` | **1,648 passed, 3 skipped, 7 intentionally failed**; 84,723 assertions, 1,658 tests across 160 files, 232.87 s. All failures are the seven new Pi review assertions listed above. |
| `bun run test`, `packages/plugin` | **7,335 passed, 7 skipped, 1 intentionally failed**; 214,125 assertions, 7,343 tests across 713 files, 147.13 s. The sole failure is the new OpenCode replay-order assertion. |
| Pinned OMP converter run plus both final review files | **13 passed, 8 intentionally failed**, 114 assertions across 2 files (21 tests). Includes all five OMP converter controls; only the declared findings fail. |
| `bun run --cwd packages/pi-plugin typecheck` and `bun run --cwd packages/plugin typecheck` (Linux, final files) | Passed, exit 0; TypeScript 5.9.3. |
| Project-installed `biome check --write` on the two new test files, followed by package-scoped `biome check` (Linux) | Passed: one file checked in each package, zero findings, Biome 2.5.1. Formatting was limited to the new tests. A root-CWD combined check was refused by the repository's nested root configurations; no config was changed. |

Both complete suites were first run through the Linux runner as requested by the worker guide. Pi: **1,632 passed / 3 skipped / 23 failed**, 84,615 assertions; the additional 16 failures were unchanged lsof-based HTTP isolation fixtures (`/proc/mounts` unavailable). Plugin: **7,318 passed / 7 skipped / 18 failed**, 214,012 assertions; the additional 17 failures comprised 14 of those lsof fixtures, two native WAL-close checks, and the node-WASM fixture's unresolved `onnxruntime-web/webgpu` in the runner's temporary build root. These are not attributed to the review. Native macOS suite runs were needed for those lsof/native-close/environment checks and isolated the intended red tests. The plugin fixture's final complete-fit assertion was then typechecked, run in the focused gate, and the plugin suite rerun above.

The ignored pinned host directory was not synchronized by the Linux runner (one remote `bun install --cwd` returned ENOENT before tests). The pinned converter gate therefore used the local architecture-specific installation; no CLI or credentialed provider was launched. The optional OMP controls run with:

```sh
MC640_HOST="$PWD/../../.cache/issue-640-review/host" \
  BUN_JSC_useOMGJIT=0 bun test src/issue-640-review.test.ts \
  ../plugin/src/shared/sqlite-640-review.test.ts --timeout 30000
```

Run that command from `packages/pi-plugin`, after installing exactly `@oh-my-pi/pi-coding-agent:18.8.5` into the ignored fixture as in the investigation recipe. Without `MC640_HOST`, the normal Pi suite still runs all seven failing tests, the three installed Pi converters, and the fit/owner controls; it does not silently claim OMP coverage.

No product manifests/lockfiles changed. The pinned fixture installed 112 packages, with two blocked postinstalls; package test scripts ran their unchanged frozen installs and made no dependency changes. The prepared worktree build was already successful; no new build was required for tests/docs only. AFT inspection was **partial**, with unavailable Biome/callgraph producers, so its missing diagnostics are not claimed as a clean result. Package typechecks and the explicit installed Biome check are authoritative here.

Live-store rule, verbatim: never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`)

I did not open/copy/migrate any live store or launch a host on a default HOME. File-backed review stores are owned temporary directories created by the repository's test-temp helper; other fixtures use `:memory:`. Both suites use their unchanged storage/config isolation preloads. The Pi gateway test substitutes `fetch` with a captured 400 response and sends nothing to a network; importing converter source is not a host-session launch. No guard was disabled, no existing expected behavior was rewritten, and no implementation mutant is left in the tree.
