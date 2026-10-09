# Adversarial review: Rust-mode tool-result attachments

Historical failing-first review. The five findings below retain their original
evidence; fixes and current verification are in
[the repair report](rust-mode-tool-attachments-repair.md).

Reviewed master merge `1f0c5ec94e54fa2ef9bd4d83bf1f9d9888d4c321`, relative to its
first parent. Read `rust-mode-tool-attachments.md` first, then
`ARCHITECTURE.md:50–91`. This delivery changes **tests and this report only**;
the three Rust source edits are one-line includes inside existing `#[cfg(test)]`
modules. No compatibility shim, migration, product repair, or epoch bump is included.

## Verdict

The carrier repair works for ordinary text-plus-media results, and the tested
attachment-free projections remain byte-identical. However, the upgrade is not
safe to treat as an unconditional next-normal-pass repair. There are two
high-priority upgrade failures, a media-only tagging regression, a measurable
projection-admission cliff, and an unsupported-source edge case.

The original report explicitly approves repair on a defer (`:72–82`). That is
incompatible with the review's SOFT+ prohibition and the architecture's prefix
mutation contract (`ARCHITECTURE.md:75–83`). A restart clears process caches;
it does not erase provider prefix bindings or durable CK block identities.

## Findings (each has an executable failing test)

### 1. P1 — a previously served attachment is first-restored without bust permission

**Trigger:** A session is initialized before a screenshot arrives. The old adapter
serves that result on a defer as tagged `Text`; a later assistant has signed
reasoning. Upgrade the adapter and submit the same history as `Content` with the
image. No execute/flush/TTL expiry is needed.

**Locations:** `packages/plugin/src/hooks/magic-context/module-wire.ts:876–936`
introduces the new result shape unconditionally. Unfrozen, uncovered identities
are re-adopted at `crates/mc-module/src/transform.rs:7677–7684`; this does not grant
prefix-bust permission. Native encoding at
`crates/mc-module/src/codec/opencode.rs:1495–1509` installs the new attachments.
The host derives its permission solely from `response.prefix_bust_permitted`
(`rust-mode-transform.ts:3968–3982`). Its deferred divergence fence only checks
`mc_m0#0` / `mc_m1#0` (`:4005–4009`), not the restored tool result.

**Failing test:**
`transform::tests::attachment_review_upgrade_defer_preserves_previously_served_result`.
It exercises the transform/store and actual native encoder, not just a CK-shape
comparison. The result is `SOFT+`, `prefix_bust_permitted=false`; the old native
state has no attachments, the new native state has the image, and the later CK
signed-reasoning block remains. The native output text is `§2§ Screenshot` on
both sides; the first changed provider content is the restored image.

Captured failure:

```text
assertion `left == right` failed: restoring an already-served attachment must wait for prefix-bust permission
left:  state { attachments: [image], output: "§2§ Screenshot", ... }
right: state {                       output: "§2§ Screenshot", ... }
```

**Signed-thinking consequence:** The host's proactive binding strip requires
`cacheBustingPass === true` (`transform-postprocess-phase.ts:1019–1025`), which
this response does not supply. Its normal latest-assistant exemption therefore
cannot be used to justify preserving thinking after this newly edited prefix.
On the repository's prefix-bound Claude models, this violates the preserved-
thinking rule and can require reactive provider-error recovery. This review
proves the edit and retained reasoning locally; it does not claim a live
Anthropic rejection. Queue the restoration until a permitted bust and make its
prefix edit participate in the thinking policy, including `reasoning_trim_only`.

### 2. P1 — durable frozen identities can prevent the upgrade from ever serving normally

**Trigger:** The old projection has been served on an initial/busting pass. The
assistant carrying the screenshot has the ordinary frozen
`strip:trailing_blank_strip:screenshot` decision. The upgraded projection changes
its result fingerprint from `Text` to attachment-bearing `Content`.

**Locations:** Shape change at `module-wire.ts:936`; frozen decisions are recorded
at `crates/mc-module/src/transform.rs:15459–15530`. Identity enforcement returns
`IdentityDrift` at `:7677–7678` when `frozen_unit_targets_mid` is true
(`:7712–7746`). The facade returns `transform_failed` at
`crates/mc-module/src/lib.rs:10497–10545`; the merge added no upgrade-specific
adoption path there. Covered/boundary-anchor identities use the same reject fence.

**Failing test:**
`transform::tests::attachment_review_upgrade_reaches_normal_serving_with_frozen_assistant_decisions`.
It verifies the frozen unit exists, then attempts both the next ordinary pass and
a bust requested via `soft_refresh_pending`. Neither can install the repair:

```text
an attachment upgrade must reach normal serving, including the next bust:
defer=Err(IdentityDrift("screenshot")), bust=Err(IdentityDrift("screenshot"))
```

This is not cleared by restarting a process. An old LKG may remain replayable
under its normal admission rules, but that is not the promised transition back
to normal serving. Handle the narrowly identified projection upgrade atomically
with a permitted bust; do not disable the general identity/frozen-target fence.

### 3. P2 — media-only results lose their text tag carrier

**Trigger:** A completed tool has `output: ""` and one image attachment (equivalently,
an empty error text with media). There is no attached text child.

**Locations:** `module-wire.ts:882` omits the output text block when empty.
`crates/mc-module/src/transform.rs:10573–10583` only admits `Content` for tagging
when a text child exists; `:10855–10867` likewise has no carrier to prefix.

**Failing test:**
`transform::tests::attachment_review_media_only_result_retains_a_taggable_text_carrier`.
Both positive controls pass: the same screenshot with text is tagged, and the
old adapter's empty `Text` result receives a tag. The upgraded media survives,
but has no text carrier and no visible result tag:

```text
media-only completed results still need a text-only tag carrier for ctx_reduce
```

No tag is written into the image; that part is correct. The regression is lost
result addressability, not image corruption. Preserve/create a separate empty
text carrier for the tag rather than tagging media or changing the carrier bytes.

### 4. P2 — screenshot histories cross the projection ceiling at only 48 MiB of base64

**Trigger:** 64 tool screenshots, each with 768 KiB of base64 (576 KiB decoded),
with normal text, raw native carrier, and real facade JSON deserialization.
The fixture measures encoding size, not JPEG validity or actual CEREB contents.

**Locations:** `module-wire.ts:898–920,934` sends each payload twice in CK
(source plus raw carrier), in addition to `native_messages` in the transform
body. Non-scalar result shells are cloned at
`crates/mc-module/src/ck_wire.rs:203–207`; their canonical bytes and retained trees
are charged at `:405–443` and `retained_size.rs:120–138,172–212`.
`crates/mc-module/src/lib.rs:1503` sets the 288 MiB entry cap; `:3766–3782` rejects
these projections instead of admitting them.

**Failing test:** `tests::attachment_review_screenshot_history_fits_projection_admission`.
It submits real parsed ingress to the production `ProjectionCache`, checks the
request fits the staged-wire cap, and verifies the pre-upgrade projection fits.

```text
request_bytes=151079250
old_projection_charge=313190
projection_charge=302595944
cap=301989888
48 MiB screenshot history is no longer delta-admissible: charge=302595944, cap=301989888
```

**This is an admission/performance regression, not a bypass of the ceiling.** The
ceiling is correctly enforced. The warning advertises
`full_sync_each_pass_unless_request_snapshot_available`; a suitable retained
request snapshot is required to avoid that fallback. Payload retention is roughly
six times the base64 size here. Share/compact the lossless carrier rather than
raising the ceiling or silently dropping images. No allocator/RSS or throughput
measurement is claimed, and no live screenshot-heavy session was inspected.

The TS page limit is 48 MiB (`module-wire.ts:15–20`), with 64 KiB continuation
chunks; the module has a 256 MiB aggregate staging budget (`lib.rs:1468–1470`).
A new control independently reassembles oversized media from emitted pages and
checks every page including the late reply capability. Individual page splitting
is sound; it does not solve aggregate staging or projection admission.

### 5. P3 — an empty synthesized URL is treated as shown rather than noticed

**Trigger:** A CK image with no native raw carrier has
`source: { type: "url", url: "" }` and filename `screen.png`.

**Locations:** `crates/mc-module/src/codec/opencode.rs:1328–1331` emits the empty
string. `tool_media_is_unshown` at `:1454–1465` tests only whether the `url` field
is a string, not whether it is a usable source. Consequently `output_status_text`
at `:1370–1377` appends no notice and `output_attachments` at `:1399–1400` emits
a file with no usable URL.

**Failing test:**
`codec::opencode::tests::attachment_review_empty_synthesized_url_has_a_visible_notice`.

```text
assertion `left == right` failed: a synthesized empty URL is not an encodable attachment
left: ""
right: "[attachment not shown: image/png (screen.png)]"
```

This is specifically a synthesized carrier. Unchanged malformed native/opaque
carriers have a documented lossless-replay exemption and are not this finding.
The notice should use the same deterministic stored identity fields after
rejecting an empty source.

## Coverage of the other requested claims

* **Attachment-free bytes (a):** no counterexample found. Three new TS controls
  cover absent attachments, `part.attachments: []`, `state.attachments: []`, both
  empty, empty/nonempty text, and completed/error polarity against independent
  pre-repair wire literals. They also confirm a present empty state list masks
  a nonempty part alias, and an absent state list falls back to the part alias.
  These are object fields, not repository paths. Existing native attachment-free
  and no-attachment projection tests pass. This is bounded fixture evidence, not
  an exhaustive byte-equivalence proof for all malformed inputs.
* **Second rewrite (b):** no second rewrite reproduced after a successful
  restoration. The new replay control closes/reopens the throwaway store and
  compares the actual native screenshot bytes over three appended-tail defers.
  Existing native cache hit, cache eviction/rebuild, and delta-prefix attachment
  tests also pass. Findings 1 and 2 concern whether restoration is safely admitted
  in the first place; the passing replay control does not excuse them.
* **Tag placement (c):** text-plus-media tags stay on the text child; the media
  and raw carriers survive. Finding 3 covers the missing-text case.
* **Signed thinking (d):** finding 1. The documented defer exception is not a
  permission to edit a prefix used by later signed thinking.
* **Claude Code / Pi (e):** no changed gateway/Pi product path found in this merge.
  `lib.rs` changes in the reviewed merge are tests only; profile epochs are
  unchanged. The gateway's CK projection and Pi's codec do not invoke the new TS
  OpenCode helper. The affected native codec is OpenCode-specific. All 15 Pi
  codec tests and the Pi text/image tagging test pass. No real CC/Pi host was
  launched and no end-to-end gateway freshness claim is made.
* **LKG / frozen paths (f):** LKG hold/release rules are unchanged; an already
  lossful held capture is not force-restored. The existing explicit-drop test
  confirms frozen dropped results stay dropped, including cache/delta replay.
  Finding 2 exposes a durable frozen-unit admission failure. Real marker/LKG host
  recovery was not rerun; the original report's shard is not this review's evidence.
* **Notice stability (g):** for sources classified as unshown, notice construction
  uses MIME, stored id/filename and stored dimensions (`opencode.rs:1426–1452`),
  not time, route, cache counters, or randomness. The existing byte-stable notice
  and retained-carrier-drift test passes. Finding 5 concerns classification, not
  volatile formatting.
* **Memory / pages (h):** finding 4 plus the independent paging control above.
  Neither the 288 MiB cache cap nor the 256 MiB staging cap is raised by this merge.

## Verification and containment

Live-store rule followed verbatim: never open, read, write or migrate the live stores
(`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`,
`~/.config/opencode/*`, `~/.config/cortexkit/*`). No host process or `ck-mc`/daemon
product executable was launched. Thus there is no host `lsof` or local product
binary-version claim to make. Rust tests use throwaway tempfile stores; TS tests
use throwaway HOME, XDG data/config/cache/state, OPENCODE_DB, storage and log paths
under `$TMPDIR/magic-context/bg_3dccac7c5cf58f54/`. No live-store evidence was read.

Tools: Cargo 1.99.0 / rustc 1.99.0; rustfmt 1.10.0-stable; Bun 1.4.2;
TypeScript 5.9.3; Biome 2.5.1. Commands are run from this worktree. Cargo tests request the
Linux runner with `CARGO_TARGET_DIR=target/attachment-review`. One intermediate
run fell back locally when the remote was unreachable; the final finding runs
and existing Rust controls ran remotely. An initial default-target remote build
failed copying sqlite bindings; the isolated target resolved that build-artifact
problem. A replay fixture initially reopened a still-leased store; it was fixed
to close the old store first and is now green.

* `cargo test --locked -p mc-module --lib attachment_review -- --nocapture`:
  **6 tests: 1 pass, 5 intentional failures** listed above (exit 101). After adding
  the old-empty-result positive control, only the impacted media-only test was
  rerun: **1 expected failure** at the same final tag-carrier assertion.
* `cargo test --locked -p mc-module --lib codec::opencode::tests -- --skip attachment_review`:
  **27 passed**. The skip excludes only the new intentional notice failure.
* `cargo test --locked -p mc-module --lib codec::pi::tests`: **15 passed**.
* Native cache/explicit-drop and attachment-free native controls: **1 + 1 passed**.
* `bun run --cwd packages/plugin typecheck`: **passed**, all three configured
  TypeScript checks; silent success, TypeScript 5.9.3.
* `bun test` on `module-wire.attachments-review.test.ts` and `module-wire.test.ts`:
  **28 passed / 0 failed / 145 assertions**.
* Pi `transcript-pi.test.ts`, filtered to
  `tags only tool result text and replays image children byte-identically`:
  **1 passed / 0 failed / 3 assertions** (16 filtered).
* Project Biome check on the new TS test: **1 file passed**. `cargo fmt --check`,
  explicit `rustfmt --check` on all three included test files, and
  `git diff --check`: **passed** (silent success for formatting/whitespace).
* AFT inspection was **partial**, with Rust analyzer initially indexing and then
  timing out for two files; Biome was unavailable to that analyzer. Actual Cargo test compilation, project tsc and
  project Biome are the authoritative gates here.

The five red tests are deliberately committed review artifacts. They are not
skipped, rewritten to match the implementation, or represented as a green package
suite. Full package suites and real-host/shard gates were not rerun for this
report-only task. Fixes should make the named assertions pass without weakening
the architecture's shared prefix-bust permission or lossless-carrier contract.
