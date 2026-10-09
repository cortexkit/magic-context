# Rust-mode tool attachments: adversarial re-review

## Verdict: do not merge yet

Reviewed delivery `7237303f156cfc6e72ddaa7de91181721f2172d9` on
`alfonso/task/bg_7dc416ffc106c49c-fix-rust-mode-tool-result-attachments-per-review`,
including its repair report and commits, against current master
`30f43e7f03bdd485f5f5f750590efeac3af2ac99`.
Read the first review from `refs/alfonso/accepted/bg_3dccac7c5cf58f54`
(`9bd22c7fb0`); the delivery includes its historical report and test witnesses.
This re-review branch starts **at the delivery tip**, not at master. Its only
changes are this report and three appended Rust tests. No product repair,
compatibility shim, migration, epoch change, or live-store access is included.

**The five original final assertions pass, but the permission/replay guarantee
is still incomplete.** Two additional triggers fail: previously served
provisional tool results restore on an unpermitted defer (and introduce a new
write), and compaction-off sessions undo a permitted restoration on the next
defer. Both need fixes before merging.

## Disposition of the five original findings

Locations below refer to the delivery source; appended test locations refer to
this review. Test names have their actual Rust module qualification.

| Original finding | Disposition and trigger check |
| --- | --- |
| **1 — P1: first restoration on a defer** | **Closed for the original stable, identity-pinned fixture; not fully closed as a guarantee.** `transform::tests::attachment_review_upgrade_defer_preserves_previously_served_result` passes. `attachment_projection_replay` reconstructs the old scalar result only for matching stored message identities (`crates/mc-module/src/transform.rs:7733–7764`); `:5778–5784` requires independently granted prefix permission before changing projections. A previously served provisional result has no such stored identity: new finding A below. |
| **2 — P1: frozen identity drift prevents normal serving** | **Closed for the original trigger.** `transform::tests::attachment_review_upgrade_reaches_normal_serving_with_frozen_assistant_decisions` passes both the ordinary pass and the armed bust with `strip:trailing_blank_strip:screenshot` present. The narrow adoption path at `transform.rs:4765–4797` handles only recognized upgrades; `attachment_repair_does_not_adopt_unrelated_frozen_identity_drift` still rejects a changed call input. The restart/bust control also proves actual image restoration rather than merely `Ok`. |
| **3 — P2: media-only result has no tag carrier** | **Closed.** `transform::tests::attachment_review_media_only_result_retains_a_taggable_text_carrier` passes its text-plus-media and old-empty-text controls, preserves the image, and finds a separate tagged text child. TS now always supplies that child (`packages/plugin/src/hooks/magic-context/module-wire.ts:882–883`); the native codec creates it when media has no text sibling (`crates/mc-module/src/codec/opencode.rs:725–740`). The TS completed/error media-only control also passes. |
| **4 — P2: 48 MiB screenshots exceed projection admission** | **Closed for the measured workload without raising a cap.** `tests::attachment_review_screenshot_history_fits_projection_admission` passes actual parsed ingress and `ProjectionCache` admission. Derivable source fields are removed from the raw carrier (`module-wire.ts:935–953`, `opencode.rs:742–767`) and reconstructed at `opencode.rs:1498–1519`. The TS control independently counts one payload occurrence per CK result. Measurements are below. |
| **5 — P3: empty synthesized URL silently counts as shown** | **Closed.** `codec::opencode::tests::attachment_review_empty_synthesized_url_has_a_visible_notice` passes. `opencode.rs:1489–1495` rejects an empty synthesized URL, while `:1397–1412,1429–1435` emits the notice and omits the unencodable attachment. The byte-stable unsupported-source notice and malformed native-carrier exemption controls pass too. |

The repair's two changes to old review fixtures were inspected, not hidden:
the contradictory length-1 defect-witness assertion was removed before the
original final byte-equality assertion, and the frozen-identity fixture reloads
before its manual CAS. Neither removes the original final contract assertion.

## New finding A — P1: a previously served provisional result bypasses upgrade detection

**Trigger:** Initialize an OpenCode session, then serve a completed screenshot
result with the historical attachment-blind adapter during `mid_turn=true`.
The newest assistant is provisional even though its tool result is completed.
Restart with the repaired adapter before a non-provisional pass has pinned that
assistant's identity. The next request can be either the identical tool-loop
history or that history followed by newer signed thinking and a user message.
There is no execute/flush/TTL permission in either witness.

**Cause / file:line:** `provisional_tail_mid` selects the newest assistant during
a tool loop (`crates/mc-module/src/transform.rs:7662–7670`).
`apply_ingress_meta` removes its identity and does not insert it
(`:7946–7949,7962–7968`). The new upgrade detector requires a stored identity
(`:7738–7740`), so it treats an already-served result as first-sight. Identity
enforcement also skips the provisional assistant (`:7823–7824`) or accepts the
now-historical assistant without a pin (`:7826–7827`). No legacy projection is
selected, so the restoration permission guard has no upgrade to gate.
The native encoder installs the attachment at
`crates/mc-module/src/codec/opencode.rs:1552–1556`.

**Failing tests (both are committed, neither is skipped):**

* `transform::tests::attachment_rereview_provisional_result_upgrade_waits_for_permission_after_restart`
  (`crates/mc-module/src/tests/tool_attachment_upgrade_review.rs:492–540`).
  Positive controls prove old serving was a defer, actually omitted the image,
  and stored no screenshot identity. The fixture closes/reopens the tempfile
  store. The upgraded pass is also unpermitted and keeps the newer signed
  reasoning, but its actual native screenshot now has the image:

  ```text
  assertion `left == right` failed:
  a previously served provisional tool result must not restore media on a defer
  left:  state { attachments: [image], output: "§2§ Screenshot", ... }
  right: state {                       output: "§2§ Screenshot", ... }
  ```

* `transform::tests::attachment_rereview_provisional_discovery_does_not_write_on_defer`
  (`tool_attachment_upgrade_review.rs:593–621`).
  An identical old-adapter replay is first shown to be write-free after hygiene
  settles; there is no appended tail, usage change, flush, or manual store edit
  between that control and discovery. The upgraded request is still mid-turn and
  unpermitted, but changes the durable row version:

  ```text
  discovering media on an already-served provisional result must not introduce a defer write
  left: Some(3)
  right: Some(2)
  ```

This is not the repair report's acknowledged old second-pass hygiene write or
ordinary writes caused by growing host tails. It is an additional discovery
write on an unchanged history. The signed-thinking consequence remains that
an earlier provider byte changes without `prefix_bust_permitted`; the host's
proactive strip still requires that permission
(`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:1019–1025`).
The witness proves the edit and retained signed CK reasoning, not a live
Anthropic rejection. Recognition needs a way to distinguish previously served
provisional results from genuine first-sight media without adding defer writes.

## New finding B — P2: compaction-off restores on a bust, then removes the image on defer

**Trigger:** With `compaction_enabled=false`, serve the historical scalar
screenshot result, upgrade, and defer once (correctly replaying the old form).
Arm `soft_refresh_pending` and rebuild with permission (the image is restored).
Close/reopen the store and send the identical upgraded request again: the next
unpermitted defer returns the old attachment-free result.

**Cause / file:line:** The compaction-off branch is dispatched at
`crates/mc-module/src/transform.rs:4118–4119` and retries a legacy replay on an
additive bust at `:3697–3703`. However, its metadata adoption call supplies no
identity re-adoptions (`:3737–3738`), and `apply_ingress_meta` only inserts missing
identities (`:7962–7968`). The existing scalar identity therefore survives the
permitted restoration. `attachment_projection_replay` recognizes the same
upgrade again (`:7738–7764`), and the following defer selects the scalar legacy
projection (`:2973–2975`). The successful first restoration is not durable as a
serving decision; every later bust can restore again and every defer can undo it.

**Failing test:**
`transform::tests::attachment_rereview_compaction_off_restoration_replays_on_the_next_defer`
(`crates/mc-module/src/tests/tool_attachment_upgrade_review.rs:544–590`).
It checks real native bytes on the initial defer, verifies permission and exact
original attachments on the restoring bust, then reopens the store and checks
an unpermitted replay:

```text
assertion `left == right` failed:
compaction-off must not undo an admitted restoration on the next defer
left:  state {                       output: "Screenshot", ... }
right: state { attachments: [image], output: "Screenshot", ... }
```

The compaction-on adoption path does not cover this separate additive path.
The fix must commit the recognized upgrade's identity/serving decision with the
same permitted additive rebuild, not relax replay or originate another bust.

## Other requested adversarial checks

* **Omitted TS defaults / restarts:** The retained raw shell replacement at
  `transform.rs:7712–7725` avoids introducing `provider_executed=false` into the
  old TS fingerprint. `attachment_repair_ts_omitted_defaults_preserve_old_identity_on_defer`
  passes three write-free defers; the independent restart/one-bust control passes
  and then checks actual restored native bytes over three growing-tail defers.
  Finding A is a different restart seam: absence of the pin, not wrong defaults.
* **Ingress versus served projection cache:**
  `attachment_repair_projection_cache_retains_ingress_during_legacy_replay`
  passes actual prefix reconstruction and subsequent restoration. The wrapper
  returns the repaired ingress projection while serving legacy bytes
  (`transform.rs:3018–3023`); it does not cache served Text as future delta ingress.
  No new counterexample was found for the identity-pinned compaction-on path.
* **Signed thinking on a permitted restoring rebuild:**
  `attachment_repair_waits_write_free_then_restores_on_one_bust_after_restart`
  proves restoration sets permission and does **not** claim `reasoning_trim_only`.
  The explicit exclusion is at `transform.rs:5940–5942`. The host permission and
  trim-only gate at `transform-postprocess-phase.ts:1019–1025` then opens the
  proactive binding strip. Both Rust-mode host/subagent postprocess tests pass
  and persist/replay those strips. This is composed module/host unit evidence,
  not a new real-provider acceptance claim. Finding A bypasses the permission.
* **CEREB-scale retention:** For the unchanged 64 × 768 KiB base64 fixture,
  request bytes are **100,747,858**, old projection charge **313,190**, repaired
  projection charge **151,605,608**, cap **301,989,888**. Compared with the first
  review's **302,595,944**, the projection now admits without increasing the cap.
  TS confirms one payload occurrence per CK carrier, for completed/error results;
  native and CK ingress still each carry their own logical representation. Paging
  independently reassembles the emitted media and checks every page's limit.
  These are retained-size and serialized-wire measurements, not allocator RSS,
  image validity, throughput, or an inspection of a live CEREB session.
* **Claude Code / Pi:** The gateway, common child classifier, Pi codec and Pi
  transcript product paths are unchanged in `git diff master...delivery`.
  Detection is guarded to `SerializerProfile::OpencodeAiSdk` (`transform.rs:7685`).
  `lib.rs` delivery changes are tests only. All 51 codec tests pass, including
  15 Pi tests and both adapter golden controls; all 17 Pi transcript tests pass.
  No new gateway/provider freshness or real CC/Pi host claim is made.
* **Scope against current master:** Merge base is
  `a4aae7ae7f2bcafe21cd03e81f9750168643373b`. Master has no intervening changes to
  the touched transform, OpenCode codec, facade, TS adapter, mode manifest or
  Rust harness. Its later TUI/dependency, dreamer/quota and daemon-test changes
  are outside this repair and were not reverted into this review branch.
* **Test-name caveat:** The inherited
  `attachment_review_restored_result_replays_without_a_second_rewrite` no longer
  proves a restoration: it has no bust arm or image-presence assertion and can
  compare lossy defers after the permission fix. The newer
  `attachment_repair_waits_write_free_then_restores_on_one_bust_after_restart`
  supplies that missing positive witness. No existing test was weakened or
  renamed in this re-review.

## Verification and containment

Live-store rule, verbatim: never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`).

No OpenCode/Pi/CC host, `ck-mc`, or daemon product executable was launched in this
re-review. Thus no local product build/`--version` SHA or host `lsof` evidence is
claimed. Rust lib tests use tempfile stores; Bun tests use this worktree's
ignored `target/re-review-ts-root` with isolated HOME, XDG data/config/cache/state,
TMPDIR, OPENCODE_DB, storage and log paths. No live store was opened or migrated.
If host acceptance is repeated, it still requires a throwaway root proven by
`lsof`, an env-prefixed local binary build and proof of its `--version` SHA.

Tools: Cargo **1.99.0**, rustc **1.99.0**, rustfmt **1.10.0-stable**, Bun **1.4.2**,
TypeScript **5.9.3**. Cargo commands ran on the Linux runner, one build at a time,
with `CARGO_TARGET_DIR=target/attachment-re-review`. Rust compilation is also the
authoritative typecheck for the only changed test source. Bun commands ran
locally against the worktree's prepared dependencies.

* Background, long-timeout
  `cargo test --locked -p mc-module --lib attachment -- --nocapture` at the
  delivery tip: **17 passed**, including all six original review tests, five
  repair tests and six other attachment controls. A slot was available; the
  background task completed and was explicitly watched (45 s total).
* Same attachment command after the final test additions: **17 passed / 3
  intentional failures**, exactly the three new witnesses above (exit 101).
  The original five findings' assertions and all repair controls remain green.
* `cargo test --locked -p mc-module --lib codec:: -- --nocapture`:
  **51 passed**, no failures (caught duplicate-tool-id panics are expected
  positive guard evidence, not suite failures).
* `bun test` on `module-wire.attachments-review.test.ts` and `module-wire.test.ts`:
  **29 passed / 150 assertions**.
* `bun test packages/plugin/src/hooks/magic-context/transform-postprocess-phase.test.ts --test-name-pattern 'Rust-mode.*busting'`:
  **2 passed / 14 assertions / 259 filtered**.
* `bun test packages/pi-plugin/src/transcript-pi.test.ts`:
  **17 passed / 61 assertions**.
* `bun run --cwd packages/plugin typecheck`: all **3 configured tsc commands
  passed** (silent success); TypeScript **5.9.3**. The initial attempted root
  TypeScript version path did not exist; the package-local compiler supplied
  the version. No TS source was changed here.
* `cargo fmt --check`, explicit `rustfmt --edition 2021 --check` on the modified
  included test file, and `git diff --check`: passed (silent success).
* AFT inspection: **partial** (Rust analyzer still indexing; checkout call graph
  unavailable). Cargo compilation and executed tests are authoritative.
* Not rerun: real-host e2e/shard gates, live Anthropic, CC/Pi hosts, full package
  suites, full build/lint, RSS/throughput. The prepared build was at the initial
  master worktree, not a new acceptance build of this delivery. No dependency or
  lockfile change is part of this re-review.

The three red tests are intentional committed review artifacts, not a green
package claim. Fix both triggers without adding defer writes or bypassing the
shared prefix permission, then rerun them and the original controls before merge.


## Follow-up repair: provisional replay and additive adoption

The historical verdict above describes `7237303f15`. The follow-up imports
`b08d39ca8d8bfa8b49e0ebf64dbad677f1951d47` into current master without reverting
master's intervening work (merge commit `b8968a9e`). Both remaining findings are
now repaired; the three re-review witnesses keep their original expectations.
Only `transform.rs`, appended upgrade-review controls, and this report changed
in the follow-up repair itself. The other delivery files are inherited from the
requested review/repair branch.

### A: persisted served evidence, with a conservative fallback

Recognition now checks the **served result block fingerprint** when the assistant
has no stored identity. A match against either the raw media-bearing result or
that result with its already-persisted overlays proves the media-bearing CK form
was already served. This evidence survives restart and prevents the repair from
removing an image that was admitted earlier. Reading evidence does not mint tags,
change metadata, or commit a new discovery record.

Otherwise, an identity-less result that was served, or belongs to the current or
last-observed provisional tail of an initialized session, replays the historical
scalar form until independent prefix permission arrives. **I chose the safe
fallback for ambiguous first-sight provisional results.** The persisted hashes
cannot identify a result never recorded by the old process, so an absence of a
pin/hash cannot safely certify first sight. A genuinely new provisional
screenshot can therefore wait for the next permitted rebuild, as allowed by the
brief. Fresh bootstrap still admits media on its already-permitted first render.

Pinned messages still require the entire reconstructed block vector to match.
Recognition replaces only scalar slots matching their stored fingerprint, so a
mixed previously-provisional assistant can keep an already-admitted image while
another lossy result waits. No arbitrary tool-input/sibling drift is exempted.

### B: adopt and serve atomically on the permitted additive rebuild

The compaction-off dispatch now passes the recognized upgrade into the additive
path. That path forwards its re-adoptions through `apply_ingress_meta` only when
the existing plan permits a rebuild, committing the restored identity with the
served media. It also records OpenCode served fingerprints on permitted additive
rebuilds, so later identity-less provisional replays can prove media was admitted.
It does **not** add fingerprint writes on additive defers, relax the identity
fence, add an epoch/schema change, or originate a bust. Both paths reject an
attempt to adopt a recognized upgrade if the retry loses rebuild permission.

### Additional controls and containment

Five controls were appended: compaction-on/off provisional first-sight deferral,
compaction-on/off media admitted at bootstrap and replayed from persisted hashes,
and a mixed scalar/media vector's read-only recognition before and after pinning.
The four native-byte controls reopen tempfile stores, check actual attachments,
check growing history after demotion, and check settled identical defers remain
write-free. The mixed-vector control seeds real served fingerprints and checks
recognition without involving unrelated native multi-tool normalization. During
fixture development, the attempted multi-tool bootstrap control did not retain
its first tool; that path was not changed in this repair. An initial extra
provisional test incorrectly expected no pin immediately after explicit additive
adoption; the final control checks absence after provisional replay removes the
pin and proves the subsequent hash-only replay.

No live store, daemon, host, or provider was opened. Rust stores are tempfile
fixtures. Bun tests used `target/attachment-rereview-ts-root` for HOME, XDG paths,
TMPDIR, OpenCode DB, context storage and logs. Existing prepared dependencies were
used; no manifest/lockfile install changes were needed.

### Final gates

Tools: Cargo **1.99.0**, rustc **1.99.0**, rustfmt **1.10.0-stable**, Bun **1.4.2**,
TypeScript **5.9.3**. Cargo gates ran serially on Linux with
`CARGO_TARGET_DIR=target/attachment-rereview-repair`. The final gate chain used a
60-minute hard timeout and foreground `wait:true` under the worker's serial-build
policy, rather than starting concurrent background builds.

* Imported baseline: `cargo test --locked -p mc-module --lib attachment_rereview
  -- --nocapture`: exactly **3 failed**, matching findings A and B.
* Final `cargo test --locked -p mc-module --lib attachment -- --nocapture`:
  **25 passed**, 0 failed (all five original assertions and all three new witnesses).
* Final `cargo test --locked -p mc-module --lib codec:: -- --nocapture`:
  **51 passed**, 0 failed.
* Final `cargo test --locked -p mc-module --lib attachment_rereview -- --nocapture`:
  **3 passed**, 0 failed, original expectations unchanged.
* Final `cargo test --locked -p mc-module --lib`: **1,672 passed**, **22 ignored**,
  0 failed; 1,694 discovered tests, 248.87 seconds. Compilation is the Rust
  authoritative typecheck.
* `bun run --cwd packages/plugin typecheck`: all **3 configured tsc commands
  passed** (silent success, TypeScript 5.9.3).
* Adapter `bun test` on `module-wire.attachments-review.test.ts` and
  `module-wire.test.ts`: **29 passed / 150 assertions**.
* Pi transcript `bun test`: **17 passed / 61 assertions**.
* `bun run --cwd packages/e2e-tests test:validate-manifest`:
  **7 passed / 63 assertions**.
* `bun run build`: all **3 package builds passed**, including
  **4 v2 server tests / 19 assertions** and declaration emission.
* `cargo fmt --all --check`, explicit included-test `rustfmt --edition 2021
  --check`, and `git diff --check`: passed (silent success).
* AFT inspection remained **partial**: Rust analyzer still indexing and this
  checkout's call graph unavailable; the compiled full Cargo suite is authoritative.
* Not repeated: real-host/provider e2e, full Rust workspace tests/clippy, full Bun
  package suites, and e2e TypeScript checking (no e2e source edits beyond the
  imported previously-reviewed harness/tests). No new host-acceptance claim.

Two staged/restored `NON-VACUITY BREAK` controls were applied to `transform.rs`:
ignoring identity-less discovery reddened only
`attachment_rereview_provisional_discovery_does_not_write_on_defer` (Some(3)
versus Some(2)); suppressing additive identity adoption reddened only
`attachment_rereview_compaction_off_restoration_replays_on_the_next_defer`, with
both provisional re-review tests still green. Each mutation had a non-empty
working diff while applied and an empty working diff after checkout-and-touch
restoration. The final complete green gates ran after both mutations were removed.
