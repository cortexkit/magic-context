# Rust-mode tool attachments

## Diagnosis (written before implementation)

The supplied CEREB request-body evidence distinguishes **tagged text-only** results
from **untagged text-plus-image** results. The diagnosis references below use the
pre-repair source line numbers. No live database/configuration was opened.
The fault is in the adapter projection, not in persisted OpenCode tool parts or
Anthropic's image handling:

* `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:3482` calls
  `encodeOpenCodeMessagesToCk` on the ordinal-annotated input. It also supplies
  native messages for lossless reattachment (`buildTransformBody`, lines 1559–1673).
* `packages/plugin/src/hooks/magic-context/module-wire.ts:1002–1021` projects every
  completed/error tool output as `Text`/`ErrorText`, **without attachments**.
* `crates/mc-module/src/transform.rs:10559–10587` selects taggable results;
  `10596–10627` excludes pending tags; `10748–10873` adds the tag to the text and
  marks the edited block modified. Already-served late tags wait until a bust;
  synthetic/system rows and exempt native assistants also have mutation guards.
  Thus not every completed tool result is tagged on every pass. Untagged results
  are not evidence that the attachment survived the CK projection.
* Output build (`transform.rs:15911–16070`) copies CK ingress and applies overlays
  (or reuses a serialized output cache entry). The projected text-only type reaches
  native attach (`lib.rs:14935–14992`, `15074` onwards).
* Native attach decodes the original input into a **sidecar**, not a replacement
  CK decision surface. `codec/opencode.rs:432–506` clones the entire raw message
  for mutation-exempt mids (line 484); certified native reasoning keeps also
  restore native parts (`lib.rs:14994` onwards). These paths explain why a result
  can stay untagged and retain its image despite the lossy CK projection.
  Otherwise `encode_with_meta` compares typed fingerprints (`sidecar.rs:197–218,
  254–258`) and updates native parts from CK (`opencode.rs:892–920`, `1047–1108`,
  `1438–1452`). `output_attachments` at `1377–1390` returns an empty vector for
  `Text`/`ErrorText`; `apply_tool_output_to_part` then deletes `state.attachments`.
  Tagging is not an attachment-removal operation: it makes the lossy CK text
  authoritative at an editable native boundary. A non-exempt untagged result
  could lose attachments there too; the repair preserves those as well.
* The native codec itself decodes attachments correctly into `Content` or
  `ErrorContent` (`codec/opencode.rs:710–747`). It retains each raw attachment in
  `provider_extras.opencode.rawAttachment`, including opaque/unknown children.

The same projection handles `computer_use`, the host `read` tool's image and PDF
attachments, and any other completed tool; it does not branch on the tool name.

## Other adapters

OpenCode 1 TS mode writes only `toolPart.state.output = prependTag(...)`
(`tag-messages.ts:1002–1009`), leaving `state.attachments` untouched. Pi writes only
the selected text child into a shallow copy of the original content vector
(`packages/pi-plugin/src/transcript-pi.ts:927–942`); non-text children survive.
OpenCode 2's native bridge keeps the original result on no change and calls
`rebuildFileContent(bridge.files, state.output)` when text changes
(`packages/plugin/src/v2/hooks/payload.ts:455–466`). These paths do not have the
Rust projection loss. Existing explicit reduction paths are different: they may
replace/remove the whole tool result, with their existing frozen placeholder.
Regression tests will exercise these carrier-preserving paths, not just compare
source strings.

## Repair and cache policy

Project attachment-bearing results as `Content`/`ErrorContent`, tag only their
text child, and retain media **and opaque** children with their native metadata.
No-attachment outputs retain the exact old shape and bytes. For a synthesized
CK media child with no native raw carrier and a source that OpenCode cannot
represent, native output carries a deterministic visible
`[attachment not shown: ...]` line naming its MIME and stored id/filename (and
stored dimensions when present), rather than emitting a URL-less file. Native
raw children, including unknown/malformed opaque children, remain lossless.
The notice depends only on immutable stored data and the frozen served CK block;
the native attachment cache and a cache-miss rebuild make the same decision.
Explicit frozen reductions retain their existing placeholder instead.

The initial implementation restored already-served attachments on a defer. The
[adversarial review](rust-mode-tool-attachments-review.md) rejected that policy:
a restart does not erase the provider's cached prefix or durable frozen identities.
The corrected implementation replays the historical Text/ErrorText projection
until the shared prefix-bust gate independently permits a prefix edit. It adopts
the attachment-bearing identities atomically with that restoring bust, without
persisting upgrade discovery on a defer or relaxing unrelated identity fences.
The process-local delta cache retains the full attachment-bearing ingress during
the wait, rather than losing pending media to the old served projection. Restoration
is not a reasoning-only trim. Existing LKG hold/release and explicit frozen-drop
rules are unchanged; attachment-free sessions retain their old bytes. No database
migration or live-store edits are involved. The original measurements below are
historical; current acceptance is in
[the repair report](rust-mode-tool-attachments-repair.md).

## Verification

Failing-first tests, final commands, wire replay checks, and containment evidence
are recorded below after implementation. All host roots and captured outputs
stay under `$TMPDIR/magic-context/bg_db9030ba41707226/`; package suites use a
throwaway HOME and do not export OPENCODE_DB. Development binary paths use the
`ckdev-` prefix.

### Non-host gates and negative controls

* Bun 1.4.2 / TypeScript 5.9.3: plugin and Pi package `typecheck` passed.
  Plugin/Pi package lint passed (Biome 2.5.1; 1266 / 245 files respectively,
  existing warnings only). The plugin carrier/projection tests and Pi carrier
  test passed together: 50 tests. Final projection test: 25 passed, including
  the independent pre-repair full wire shape for attachment-free outputs.
* Manifest validator: 6 passed; 176 files, 61 TS invocations, 59 Rust invocations.
* The e2e project-wide tsc has 22 existing diagnostics in other files (including
  `rust-harness.ts`'s incomplete SDK type and old SQLite tests). A check using the
  same TypeScript program reports zero diagnostics in the two changed e2e TS
  files; neither diagnostic set is treated as a clean whole-project typecheck.
* `cargo test --locked -p mc-module`: library 1652 passed / 22 ignored, and the
  initial integration targets passed (5 + 1 + 5 + 1 + 2 + 1). The command stopped
  in the pre-existing `real_daemon` process-name guard: two cases saw `(sh)` and
  `(bash)` instead of `ckdev-*`. Fresh local-host results are recorded separately
  below, because the pre-update Cargo artifact transfer was not trustworthy.
* Clippy 0.1.99 / Cargo 1.99.0: package-scoped `cargo clippy --locked -p mc-module
  --all-targets -- -D warnings` passed, as did `cargo fmt --check`.
* The requested whole package tests ran under a throwaway HOME, with OPENCODE_DB
  unset. The first HOME had a redundant slash; normalizing it resolved unrelated
  HOME equality/expansion assertions (68 tests passed in those files). The final
  plugin full run had 7299 passed / 6 skipped / 3 failed: the existing static
  temp-directory policy names `e2e-tests/src/rust-runner/hermetic-subc.test.ts`,
  and two unrelated timed/load-sensitive tests failed (`skips 20,000 old files
  and resumes a bounded scan without losing requests`, and `yields to the event
  loop between pages while scanning 100k SQLite parts`). The Pi full run had
  1621 passed / 3 skipped / 1 failed in an unrelated background-writer fixture;
  `admits first Pi turns during bounded background holds without a saved request`
  passed on its narrower replay. None of these failures was repaired in this
  attachment change. A cross-package narrow replay also exposed existing
  raw-reader owner/yield failures; it is not a green replacement for package gates.

The tests were failing-first: the plugin attachment test received `text` instead
of `content` before the projection repair, and Rust's unsupported-source test
received only `§1§ Read result` before the visible notice repair. Controlled
negative runs were also made from a staged live tree, each explicitly marked
`NON-VACUITY BREAK` and restored from the index with an empty unstaged diff:

* Returning the old attachment-blind projection: only
  `projects tool attachments beside text for both completed and error results`
  failed; the other 24 projection/paging tests, including no-attachment byte
  identity, remained green. Mutation diff: `module-wire.ts | 2 ++`; restored: empty.
* Suppressing the native unsupported-source predicate: only
  `codec::opencode::tests::unsupported_tool_media_source_has_visible_byte_stable_notice`
  failed; the other 26 native codec tests remained green, including completed/error
  attachments and opaque-byte round trips. Mutation diff:
  `codec/opencode.rs | 2 ++`; restored: empty.

### Local-host binary freshness

All local-host runs made before the AFT artifact-transfer fix are **discarded as
verification evidence**. One such run did demonstrate that mock/read image and
PDF blocks arrived on first sight, then tripped on OpenCode's moving Anthropic
`cache_control` breakpoint; the regression now compares the complete logical
result with only that provider bookkeeping excluded. A later launch encountered
an empty daemon artifact. Neither is a passing real-host claim.

The accepted fresh local rebuild and host/shard results are recorded below
with compile-time module/daemon identities and digests, not clock-skewed mtimes.

Both local build commands used an environment assignment before Cargo:
`MC_BUILD_SHA=... cargo build --locked -p mc-module --bin ck-mc` and
`CARGO_TARGET_DIR=... cargo build --locked --manifest-path ... -p subc-core --bin
ck-subc`. This matters even after the AFT placement: plain Cargo build invocations
can still route remotely without transferring artifacts. None of the accepted
fresh-host results below relies on such a plain build. The module was built with
`MC_BUILD_SHA=d9116b4031201c3efa051ba18eee425746d59130` (the implementation
commit), and the daemon was rebuilt from the clean lock-pinned subconscious
revision `1a14993c120725fa1dce7267b6e7d0823835930c`. Version probes report:

* `ckdev-mc --version`: `ck-mc 0.1.0 (d9116b4031201c3efa051ba18eee425746d59130)`
* `ckdev-subc --version`: `ck-subc 0.20.55`

SHA-256 digests of the sealed host executables:

* normal module: `407fd7beaeda1a1f53b6e90479a15650746929d54abd332e967e6612bd73f48a`
* drive-fault module: `0c945167573977a039e840d732bbf67dc9adff909af9836941fbf1dbaf301187`
* daemon: `ae0190cc809c98d9f9f3c9170b8a61b7b32fa2beb7b4fcbbb663102ac712ac80`

The normal module digest differs from the rejected pre-update artifact
`ec50a60b28274e87d3c700cd7e32589faf88e1a1ba9e66f8292f83d605597204`.
The old integration tests were retried after rebuilding and still failed their
process-name assertions (`(bash)` / `<defunct>`; the store-ahead test also saw
`(bash)`). After an integration-test hardlink staging run, the earlier copied daemon was
observed empty; fresh host copies were therefore sealed in a separate `host-bin`
directory
and no Cargo integration run was allowed to overlap the host gates. The copies'
version and digest were rechecked before serving.

The codec negative-control restoration was verified separately: all 27 native
codec tests passed, including the loss-notice test, and fmt remained clean.

### Accepted fresh-host results

These results use the identified normal/drive-fault module and lock-pinned daemon
above, rebuilt using **environment-prefixed** Cargo commands. The module and
normal daemon digests were checked again after the shard and were unchanged.

* New real OpenCode 1.18.30 regression: **1 passed, 0 failed, 29 assertions**, both
  with the current source entry and again with the freshly built plugin bundle.
  It drives a custom screenshot tool and the host's real `read` tool on a PNG
  and PDF. All three results carry tagged text plus the actual image/document
  block on their first provider request, and their complete logical result
  bytes replay identically across three later scheduler-defer passes.
* The fold verdict on those appended-tail passes is `SOFT+`, because new tail
  tags are committed; the scheduler is **`defer`**, and diagnostics show
  `prefix_bust_permitted=false`. The new test checks the scheduler's actual
  verdict, rather than incorrectly treating the fold verdict as the scheduler.
  No existing test contract was weakened or renamed.
* `MC_E2E_SHARD=0/4 scripts/run-rust-hermetic-e2e.sh` exercised all **15 selected
  files**, including the new attachment regression. Fourteen files passed:
  **32 passed / 48 host-lane skips**. The marker-byte-identity file initially had
  a timeout plus three failures requiring `PLUGIN_ENTRY` to be the built dist
  entry (the source had changed since the prepared bundle). After `bun run --cwd
  packages/plugin build` passed (including 4 v2 loader tests), only that failed
  file and the bundle-loaded attachment regression were rerun. Marker file:
  **7 passed / 0 failed / 320 assertions**. Final selected-file coverage is thus
  **39 passed / 48 skipped / 0 remaining failures**; the initial full shard
  invocation itself exited 1, not 0.
* PID-scoped lsof checks covered the direct host and **63 host PIDs** in the
  full shard, then **25 host PIDs** in the corrected marker-file run. Every
  observed database path was under the task's throwaway root. Logs and
  inventories remain beneath `$TMPDIR/magic-context/bg_db9030ba41707226/`,
  including `fresh-host-shard-{stdout,stderr}.txt` and `host-containment/`.

Deployment must update the plugin adapter as well as ck-mc: native attachment
encoding treats the CK result as authoritative, so a module-only placement with
an old attachment-blind adapter is not the projection repair. The native codec
continues respecting explicit reduced outputs, while the new adapter provides
all unreduced media/opaque children. The follow-up commit corrects the new test's scheduler assertion and records
verification. A subsequent native loss-notice refinement is recorded below.

The live evidence alone cannot identify which particular tag-admission guard
held each untagged CEREB result; that would require ingress/module state not
present in request-body captures. The source-level exemption/pending-tag paths
explain the distinction without reading a forbidden live store. The confirmed
repair point is the attachment-blind adapter projection and its editable native
round trip, not a special case for computer_use or for one provider.

### Retained-carrier drift control

A final check also forces an unsupported CK media source **with** a retained
native attachment. A raw carrier can be replayed unchanged only while it still
represents the CK media; otherwise the renderer creates a fresh carrier and must
show the loss notice if that source is not representable. The extended existing
notice test failed first (only tagged text, no notice), then passed with the
predicate comparing the carrier's media before treating it as replayable.
Unchanged vendor/native carriers still replay losslessly.

After this refinement: all 27 native codec tests, the 2 attachment/cache tests,
and the attachment-free upgrade test passed; package-scoped clippy -D warnings
and fmt also passed. Final identified binaries and real-host rerun are recorded
below; the earlier full native-attach shard remains separately identified above.

### Final-source fresh-build gate (supersedes earlier host runs)

Product commit `8091d49bdae1e37a21f89c8c43e30ce60ff12d9c` was rebuilt with
`MC_BUILD_SHA=$(git rev-parse HEAD) cargo build ...`; both normal and drive-fault
outputs were copied into a new isolated `host-bin-final` directory. The daemon
was rebuilt with the environment-prefixed lock-pinned command again.

* Module version: `ck-mc 0.1.0 (8091d49bdae1e37a21f89c8c43e30ce60ff12d9c)`
* Module SHA-256: `1de7ca62b9967f26a75141b2c488517cb17e9092a1a59a427253d0fc5f8426ba`
* Drive-fault SHA-256: `bcc5aaf4664dcec8159361b3f3e8a3384c167f02530069492c29cfca268c2cfb`
* Daemon: `ck-subc 0.20.55`, SHA-256 unchanged at
  `ae0190cc809c98d9f9f3c9170b8a61b7b32fa2beb7b4fcbbb663102ac712ac80`
* rustfmt version: `1.10.0-stable (b940084d7e 2026-09-28)`.

With those exact final-source binaries and the current plugin bundle:

1. The new real-host attachment test passed: **1 pass / 0 fail / 29 assertions**.
2. The entire `MC_E2E_SHARD=0/4 scripts/run-rust-hermetic-e2e.sh` invocation passed
   **without retries**: **15 files, 39 pass / 48 host-lane skips / 0 fail**.
3. lsof containment passed for **55 host PIDs** in that full shard, plus the
   direct attachment-test host; all database inventories were inside the
   throwaway root. Final logs are `final-host-shard-{stdout,stderr}.txt` there.
4. Version and digest probes after the gates still match the identities above.

Only this final-source run is the final native-attach acceptance claim. The
remaining full package-suite/Cargo integration failures described above are
unrelated baseline failures, not hidden or relabeled as passes. No product source
changes follow this build; the delivery's last commit only records these results.
