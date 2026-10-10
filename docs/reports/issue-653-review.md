# Independent correctness review: issue 653

Issue 653 reports minute-long main-thread freezes while OpenCode processes edit/write results containing workspace-wide LSP diagnostics. Reviewed `7224144016977b5ca128a51a2e8beab7af4453f8` against `2a40c58e`, including the issue's four comments, `docs/reports/issue-653-lkg-projection.md`, and all eleven commits in that range. This delivery changes **only review material and verification code**, not product code.

The review requirement is unchanged provider-visible content and unchanged cache decisions for existing sessions, including a digest-upgrade replay miss that must not refuse a turn. LKG means **last-known-good**: a saved managed request prefix used when a new transform cannot safely finish. m[0] is the plugin's synthetic cached prompt message containing history, memory and other fixed context.

## Result

**Do not certify the stated bar without resolving the upgrade replay regression below.** I found no provider-visible field demonstrably lost by the allowlist at the two pinned host versions, and no token-count drift in the paired fixtures exercised. However:

1. An old durable slot is not merely a harmless replay miss in every circumstance: the first post-upgrade BUSY pass can refuse a turn that the old version could replay.
2. The vendored OC1 fixture is not equivalent to the cited upstream conversion. Its green comparisons are useful examples, not the claimed complete upstream/provider proof.

These are separate findings. The fixture discrepancies are **not** evidence that the allowlist currently loses an attachment or signature.

## Finding: upgrade loses a previously available managed replay

**Priority: high under the requirement that no existing-session cache decision change.**

`lkg-slot.ts:294-360` replaces the digest encoding. Persisted slots have digest strings but no algorithm discriminator or compatibility reader. `replayLkg` compares current digests with persisted ones, drops the slot and returns `lkg_content_mismatch` (`lkg-replay.ts:598-609`). The top-level wrapper is intentionally replay-or-refuse, not raw fallback: `messages-transform.ts:220-358,360-389` and its error handling implement that policy.

Therefore, if the first managed transform after upgrade encounters SQLITE_BUSY, the unchanged saved input fails the new digest check. The wrapper cannot replay and raises the storage-busy refusal. A current-format slot, with the same input, model and served text, successfully replays under the same injected failure.

The new `issue-653-review.test.ts` contains:

- `legacy-format upgrade should retain managed replay availability on BUSY` — `test.failing`, specifying the required old availability.
- `current-format restart partner serves the managed prefix on BUSY` — passing partner.
- `legacy-format restart diagnoses content mismatch and the exact BUSY refusal` — passing diagnosis: loads a real persisted slot, observes exactly `lkg_content_mismatch`, then observes `STORAGE_BUSY_MESSAGE`, one refusal notification, and deletion of the durable slot.
- `a healthy post-upgrade pass can replace the legacy slot` — passing counterexample to an unconditional failure claim.

The legacy oracle independently implements the old token traversal and text hashing, including the old symbol descriptions. It does not call the new projection or binary encoder. Its fixture has no empty diff summary requiring the old normalization exception. The restart uses SQLite persistence and resets the process slot/cache state; the exception is injected into the real outer handler, not into a stand-in replay function.

**Scope:** this is conditional on a fallible first pass, not a claim that every upgrade refuses. A separate two-process healthy upgrade run completed and served exactly the baseline bytes. Nor is this a stale-slot acceptance bug: the old slot is rejected, not wrongly matched. Preserving fail-closed behavior is correct; losing replay availability because of the upgrade needs an explicit compatibility policy or an accepted exception to the stated bar. Merely documenting that digests change once does not prove “never a refusal.” No compatibility fix is included here.

## Finding: the OC1 proof fixture differs from its pinned source

**Priority: medium, a verification gap.**

Read-only upstream source was pinned in `/Users/ufukaltinok/Work/OSS/opencode`, separate from the Magic Context worktree:

- `v1.18.35` = `53d1eabb61e21162157817bf677da0a4ad3332e3`.
- `v2.0.24` = `e7a34f09bfd9134dfade5a8ddb843f7030bc9a69`.

For OC1, references below are `packages/opencode/src/session/message-v2.ts` at that tag; fixture references are `packages/plugin/src/hooks/magic-context/opencode1-to-model-messages.fixture.ts`.

| Real OC1 conversion | Vendored fixture | Consequence |
|---|---|---|
| Lines 137-163 support Bedrock Mantle, selected Bedrock image models, Google Vertex Anthropic, and Gemini 3 media in tool results, in addition to Anthropic/OpenAI. | Lines 46-49 recognize only Anthropic and OpenAI. | Google/Bedrock attachments take a different route in the fixture. |
| Lines 258-266 retain an aborted assistant with a text/tool part. | Line 90 skips every assistant with `info.error`. | The comparison can pass without exercising provider-visible aborted tool/text output. |
| Line 46 and lines 393-411 use `Attached media from tool result:` and a generated synthetic user ID. | Line 26 uses `Attached image(s) from tool result:`; lines 203-216 omit the ID. | Intermediate output is not a literal copy, even in the extraction branch. |
| Lines 131-135 accept `stripMedia` and `toolOutputMaxChars`; lines 221-235 and 303-310 apply them. | Neither option is exposed; line 110 always passes `undefined` to truncation. | Non-default compaction conversions are not covered. |
| Lines 419-427 invoke AI SDK `convertToModelMessages`, with tool output lowering. | Stops at UI messages. | There is no executed provider wire-format check. |

The fixture's header acknowledges several limitations; that acknowledgement is appropriate, but the implementation report's broader “hosts' own conversions” interpretation is too strong. The incorrect synthetic prompt is an additional difference, beyond omitting the generated ID.

Two expected-failing source-fidelity witnesses and their passing diagnoses are included:

- `vendored OC1 conversion should keep Gemini 3 attachments inside tool results`; partner `Google attachment fixture partner exposes its synthetic-user routing`.
- `vendored OC1 conversion should retain tool output from an aborted assistant`; partner `aborted assistant fixture partner confirms the entire message is skipped`.

These tests assert concrete behavior of the pinned source rather than deriving the expected answer through the projection under review. They deliberately leave the existing fixture and product behavior unchanged.

## Provider-visible coverage

The key safety fact is narrow: **only a `type: tool` part's `state` is reduced**. Non-tool parts, part-level metadata and message info remain whole (`provider-visible-parts.ts:102-125`). This is not a general allowlist of all message fields.

| Shape | Reads/retention checked | Assessment |
|---|---|---|
| OC1 completed tool | `status`, `input`, `output`, `attachments`, `time.compacted`; source lines 300-338 | All retained. Truncation uses the retained output; compaction preserves the `time` object and its compacted flag. |
| OC1 error/interrupted tool | `input`, `error`, `metadata.interrupted`, `metadata.output`; source lines 340-360 | All retained. Interrupted output is an error-state metadata exception, not discarded diagnostics. |
| OC1 pending/running | `input`; source lines 362-373 | Retained. These lower to interrupted errors. There is no separate `interrupted` member of the OC1 tool-state union. |
| Files/images and tool attachments | File URL, MIME, filename and full attachment objects; source lines 221-235,303-318,393-411 | Kept whole. Routing depends on model/provider and MIME, not discarded state metadata. |
| Reasoning and provider signatures | Part metadata, including Anthropic signatures; source lines 271-279,376-388 | Kept whole. Model-switch handling reads info fields which also remain whole. |
| Text, compaction, subtask | Text, ignored flag, part kind and message info; source lines 205-254,281-297 | Kept whole. |
| Summary, patch, agent, retry, step parts | Info and non-tool parts are not reduced | No newly dropped field. OC1 selectively emits parts rather than serializing every bookkeeping part. Step-start remains available to SDK conversion. |
| OC2 tools | Core `to-llm-message.ts:103-229` reads status/input/content/error and provider state; plugin `v2/hooks/payload.ts:322-470` restores original bridge content/provider properties and reads transformed state input/status/output/error/content | The state fields read by the plugin commit survive. Original bridge/provider properties are not discarded by the state projection. |

Downstream OC2 Open Responses (`packages/ai/src/protocols/open-responses.ts:521-635`), Anthropic (`anthropic-messages.ts:618-694`), and Gemini (`gemini.ts:286-303`) consume canonical content/media/provider metadata rather than reaching back into the discarded OC1-shaped tool state. In OC1 the model-sensitive routing occurs before the SDK conversion. The retained part-level metadata is distinct from tool **state** metadata.

**Limits:** I did not execute the real Anthropic, OpenAI Responses, Bedrock or Google transport serializers. The OC2 Bedrock Converse request entry (`bedrock-converse.ts:514-528`) was inspected, but its full media helper was not traced. The repository's OC2 replay test executes the real plugin commit, not the real OC2 core/provider lowering. Source inspection supports the projection at these tags; this is not a claim of exhaustive wire-body testing or forward compatibility with a future host field.

## Counts, measurements and served bytes against the actual baseline

Added `packages/plugin/scripts/perf-audit/issue-653-review-cycle.ts`, an **offline verification driver**, not a product path. It dynamically loads the selected revision's real `createTransform`, outer messages handler, tagger, SQLite readers, tail measurement, true-raw index and m[0] breakdown. Baseline source was extracted with `git archive 2a40c58e` inside this worktree, not borrowed from the parent checkout.

Fixture: 40 messages, 4,508,946 input characters, one edit tool with approximately 4.5 MB of LSP diagnostics, a fixed published v2 compartment covering only the first user message, and the diagnostic-bearing tool retained in the raw tail. The scheduler defers at 25% of a one-million-token window. Wall time, IDs, contents and model are fixed. This is a correctness fixture at reduced scale, not a reproduction of the full 873 MiB performance measurement.

Each revision ran in two separate Bun processes:

1. Cold render and healthy defer.
2. Set `cached_m0_upgrade_state='ready'`, omitting the cached renderer epoch identity. The resulting identity mismatch forces a real `compartment_render_epoch` rebuild of m[0]; healthy defer again.
3. Exit the process, reopen the same throwaway stores, and run two restart defers.

The driver fails if m[0] was not materialized, no LKG slot was captured, or the explicit rebuild was not reached. Earlier harness attempts lacking a session-directory API were rejected as degraded and were **not** counted as evidence.

Results: 50 paired comparisons across six pass pairs passed, plus two healthy cross-version restart passes. The comparisons used separately generated baseline/current artifacts, not the “frozen projector” helper in the existing differential test.

| Measurement | Baseline | Reviewed version |
|---|---:|---:|
| True-raw total across 40 per-message counts | 4,647 | 4,647 |
| Tail measurement `t` / `u` | 4,647 / 0 | 4,647 / 0 |
| Complete serialized tail measurement, including per-part hashes, counts and attribution | Equal | Equal |
| Suffix start for 1,000 tokens | 30 | 30 |
| Head cap end for 1,000 tokens | 6 | 6 |
| m[0] compartment tokens | 31 | 31 |
| m[0] docs/profile/memory/mural/facts | All 0 | All 0 |
| LKG prefix JSON characters | 4,501,022 | 41,696 |

All six healthy pass pairs had identical **full, unreduced served-message** SHA-256:

`299fd5d174f539153d3aadf91e70b2536036950cf45bb3f3462a51f19be165fc`

Their provider-view JSON was byte-compared and also identical (43,302 characters):

`cf0ed4084e1d47d32e39b5fed961ba9f673b3cb98e219fd4def8208f23700cb5`

Reduced stored-prefix views matched at:

`cd8bc63f711e77d763f2949d9e49f899c4910bba263353e9a8633677c524099d`

The unreduced served-byte comparison is important: comparing only two outputs through the same allowlist could conceal an allowlist error. Prefix-view equality alone is therefore not treated as an independent proof of actual provider wire bytes. This sequence uses the real plugin transform but **no real OpenCode host or provider**.

The independent tokenizer witness additionally compares five realistic strings—diagnostic prose, Unicode/signatures/special-token text, an unbroken letter run, whitespace, and base64—with the unchanged ai-tokenizer whole-text encoder. Existing randomized/long-piece tests exercise the heap and cache-generation boundaries. No new token drift was observed. The m[0] implementation itself is unchanged; its test spy moved to the new exact-count entry point rather than reversing a count assertion.

**Not proved:** equivalence for every possible input, a live provider cache meter, or an adversarial high-pressure emergency-drop/threshold matrix. The cycle's scheduler is deliberately forced to defer; its boundary checks and counts are real, but they do not independently prove every scheduler/drop decision at 80/95% pressure.

## Digest/reuse and retention

The binary encoding uses typed tags, explicit lengths, UTF-16 code units and float64 numbers (`lkg-slot.ts:276-360`). This removes the old text encoder's lone-surrogate replacement and signed-zero ambiguity. String length fits the uint32 representation for JavaScript's realizable strings. Per-message reuse compares retained typed fields exactly rather than trusting ID, object identity or FNV signature (`lkg-slot.ts:724-812,903-948`). Replay separately checks input ID order and prefix content.

Existing named randomized histories cover earlier edits, removal, reorder and append using both fresh and in-place objects; the digest tests cover types, splits, surrogates and signed zero. These are meaningful **current-encoder** checks. However, `lkg-entry-cache-differential.test.ts:51-67` applies today's projection and today's digest to its nominally frozen legacy selection logic. Its green result cannot establish unchanged legacy digests or legacy replay decisions. The upgrade witness does not use that helper.

A new passing test, `metadata-only updates deliberately change the legacy replay decision`, proves the intended semantic exception: legacy digests change on a diagnostics-only update; current digests do not. This is justified as provider-invisible in the implementation report and issue discussion, but is literally a changed replay-cache decision. The absolute “no cache decision may change” bar must distinguish semantic provider-cache stability from internal replay invalidation/retention decisions.

The 256 MiB/fair-share ceiling is the **entry digest cache**, with a 128 MiB session ceiling and at most 16 sessions (`lkg-slot.ts:871-1021`). The tail content memo is also 256 MiB. Durable replay-slot heap limits remain 64 MiB total and 24 MiB per slot (`lkg-slot.ts:32-34`); those were not raised to 256 MiB. Changing entry retention affects work/reuse rather than digest values because misses recompute. No structural digest collision or stale reused digest was demonstrated.

## Isolation, reproduction and gates

No live OpenCode/Magic Context database or user config was opened. No OpenCode host was launched. Every local audit invocation set XDG data/config/state/runtime/cache, HOME, OPENCODE_DB and MAGIC_CONTEXT_STORAGE_DIR beneath `$TMPDIR/magic-context/bg_8c0eda77457a1e20/` before importing storage. The successful processes' `lsof -p` proofs listed only their root's `opencode.db`, `storage/context.db` and its WAL/SHM.

Final paired process IDs: current 46236/46548, baseline 46723/47162, healthy upgrade 47348. Artifacts and lsof output are outside build directories, under `current-cycle-retained-tool/` and `baseline-cycle-retained-tool/` in that task temp root. The earlier failed scaffolding runs also used throwaway roots.

To reproduce the offline cycle from `packages/plugin`, provide a fresh root per revision and the selected source path:

```sh
bun scripts/perf-audit/issue-653-review-cycle.ts --root "$TMPDIR/magic-context/review653/current" --src src --phase seed --out "$TMPDIR/magic-context/review653/current/seed.json"
bun scripts/perf-audit/issue-653-review-cycle.ts --root "$TMPDIR/magic-context/review653/current" --src src --phase restart --out "$TMPDIR/magic-context/review653/current/restart.json"
```

For the baseline, extract the source into a temporary directory **inside the task worktree**, link its plugin `node_modules` to the worktree's installed dependencies, and point `--src` there. Do not reset or run against the parent checkout. The script requires macOS/another environment with `lsof` installed; it refuses roots outside `TMPDIR/magic-context` and validates every open DB path.

## Final verification

- **Required full plugin gate:** `bun run build && bun run --cwd packages/plugin test`, Linux `linux,8c`, background, Bun **1.4.2 (744846f84)**. Root build passed (TUI checked nine files, zero generated changes; plugin/Pi/CLI bundles produced). Plugin tests: **7,604 passed, 19 skipped, 2 failed**, 7,625 tests across 765 files, 224,367 assertions. This is **not** a green full-suite claim.
  - `Windows child processes > every plugin, Pi and CLI subprocess hides its Windows console`: names unchanged `packages/plugin/src/shared/sqlite.test.ts:34 spawnSync`.
  - `Node WASM Transformers fixture > builds with real fs and persists a model for offline reuse`: remote temporary bundle cannot resolve `onnxruntime-web/webgpu`.
  - The failing tests/sites have no changes between the baseline and reviewed commits, and none in this review. They were not rewritten or suppressed. The first suite attempt's global `OPENCODE_DB` override also interfered with fixtures (220 failures); it was removed for test runs, which use the repository preload isolation and their own fixture DBs. A subsequent run lacked remote dist artifacts; the root build fixed those packaging failures. No host was run without the mandated isolated environment.
- `bun run typecheck` — passed after correcting the review driver's fixture types; **TypeScript 5.9.3**. This runs retina-local-fs build types, plugin `tsc --noEmit`, and script typechecking.
- `tsc --noEmit -p .review-653-tsconfig.json` — passed, **TypeScript 5.9.3**, checking the two new TS files and their imports. The temporary config extends `tsconfig.scripts.json`, includes these two files plus `src/**/*.d.ts`, and clears the inherited test exclusions; it is removed before delivery. This catches review-test type errors which the standard package configuration deliberately excludes.
- Repository-installed `biome check src/hooks/magic-context/issue-653-review.test.ts` — passed, **Biome 2.5.1**, one file, no fixes. Perf-audit scripts are outside the repository Biome selection; the driver is covered by TypeScript and its executed cycle.
- `BUN_JSC_useOMGJIT=0 bun test <13 named review/relevant files> --timeout 30000` — passed, **Bun 1.4.2**, **111 tests, 0 failures, 3,158 assertions**. The files are `issue-653-review`, `token-count-exact`, `read-session-formatting-parity`, `m0-token-breakdown`, `lkg-entry-cache-differential`, `lkg-entry-cache-work`, `lkg-entry-digest-reuse`, `provider-visible-replay`, `provider-invisible-walkers`, `read-session-raw-tool-metadata`, `tail-hygiene-walk`, `lkg-persist`, and `lkg-transform-replay`, all `.test.ts` beneath `src/hooks/magic-context/`. The final ten new review tests are included, with three deliberately expected-failing specifications and their passing partners/diagnoses.
- Controlled negative run: staged the live review file, made only `legacy-format upgrade should retain managed replay availability on BUSY` an ordinary test, and captured the non-empty diff (one file, two insertions/one deletion). **Exactly that test failed** with `StorageBusyRefusalError`, code `STORAGE_BUSY_REFUSAL`; the other nine tests passed. Restored from the staged index, touched the file, and confirmed an empty working diff. The final 111-test run passed after restoration. No mutation is left in the commit.
- Offline cycles — **Bun 1.4.2**, six paired pass comparisons per revision plus two healthy upgrade passes; **Python 3.9.6**, 50 independent paired artifact checks and two upgrade served-hash checks passed. The final typed/isolation-hardened driver also passed six current-version passes in processes **70098/70114**, with the same served hashes and only throwaway DBs in both lsof proofs.
- Scoped editor diagnostics reported zero errors/warnings for the review test; the broader inspection was partial because the checkout call graph was not ready. The authoritative TypeScript checks above cover both new TS files.
- Comment/prose review completed; clarified the review requirement, LKG/m[0] terminology, the legacy text encoding, fixture-routing expectations, and the two-process driver's purpose. No existing product test assertion was changed to accept different behavior.

No provider-transport or real-host test is claimed. Those and the high-pressure decision matrix remain explicit gaps, not passing checks.
