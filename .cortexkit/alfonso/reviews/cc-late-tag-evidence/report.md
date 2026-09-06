# Claude Code late assistant tag: source proof, fix, and evidence

## Result

**Fix class: mint and render at first sight, restricted to Claude Code.** A completed assistant's text prefix does not wait for its whole-message mutation exemption to move to another assistant. Reductions, reasoning edits, temporal markers, hints, lineage-anchor protection, and OpenCode's native whole-message replay policy retain their existing guards. The TS `tagMessages` reference already prefixes text on first sight; holding an untagged representation until a priced pass would preserve the parity defect rather than repair it.

`TAGGER_FEATURE_EPOCH` advances **3 → 4** so established active sessions price the representation change with their existing render-identity HARD fold. No master push, provider request, module restart, or module bounce was performed.

## Capture confirmation: the brief's newest-assistant premise was false

The parent copied 16 capture files plus their SHA256 manifest into `captures/` within this worktree. `python3 .cortexkit/alfonso/reviews/cc-late-tag-evidence/analyze-captures.py` verified all 16 hashes and produced `capture-summary.json`. Raw captures and execution logs stay local, uncommitted, because they contain full session data and request metadata.

| Exchange | Served count | Last assistant | Last reasoning-first assistant selected by old guard | Decision |
|---|---:|---|---|---|
| 12989 | 56 | index 54, `ccm-285`, tool_use only | index 52, `ccm-283` | SOFT+, defer / mid_turn_boundary |
| 12990 | 58 | index 56, `ccm-287`, thinking + tool_use | index 56, `ccm-287` | SOFT+, defer / mid_turn_boundary |

Message 52 is **not the newest assistant on either captured pass**. Both requests include its result at 53, another assistant call at 54, and its result at 55. Exchange 12990 appends a reasoning-bearing assistant at 56 and result at 57. The *newest reasoning-first* assistant changes, which is what the problematic rule actually searched for.

The first differing served message is 52. Its text changes only by `§186§ `:

- Before: `No existing tests cover the quick-switcher yet. Let me find a similar overlay test to model regression tests after.`
- After: `§186§ No existing tests cover the quick-switcher yet. Let me find a similar overlay test to model regression tests after.`

Thinking and tool_use blocks are identical; m0/m1 are identical. The module's second response independently reports `content_changed`, `served_message:52#1`, approximate token depth 28848. The captured model key is `anthropic/claude-sonnet-5`, not a captured Fable/Opus run.

Selected provenance SHA256s:

- `12989-fwd-body`: `f88a7f4955871b8fdc7275c249c4cf8281d04549ec962511536022adbff198e0`
- `12990-fwd-body`: `05ee0fd2e52ffabbde04a7d02f48a344d22a03db25d517afd0a1d78c2103f1c6`
- `0a1a49682f157a5c.request.json`: `104fda0d378737e9a49437b955e5c02407a1966272a03297b3af1e642ea6b520`
- `a348f0d1ff95c0d3.request.json`: `2a0e409846fae433f167f68b170836d12944f334915350e421d365cb4a195878`

## Source mechanism (baseline 43fe7e87)

1. `crates/mc-module/src/transform.rs:3310-3314` computes the whole-message exemption. `latest_assistant_message_mutation_exempt_mid` at **13599-13630** searches backwards for *any* nonsynthetic assistant whose first meaningful block is reasoning. It does not first select the latest assistant and then test it. Thus a newer tool-only assistant cannot dislodge `ccm-283`; a newer reasoning-bearing assistant can.
2. `compute_active_overlay_decisions` at **9013-9066** passes that exemption into `tag_mint_inputs_from`. The mint loop at **8240-8304**, specifically **8265-8269**, skips every block in the exempt message. It is not the temporal frontier deferring this text tag.
3. Rendering independently withholds overlays from exempt messages: `apply_tag_overlay_to_message` at **8655-8657** returned immediately for an exempt message, and `build_output` at **13331-13371** placed the normal overlay call inside its non-exempt branch. Candidate (a) is the normal first-sight mechanism; both mint and render were suppressed. The captures do not contain the historical tag-table snapshot, so they alone cannot prove whether an older persisted tag row ever existed. Candidate (b), a renderer-only delay with otherwise normal same-pass minting, does not describe the source path reproduced by the regression.
4. Once `ccm-287` arrives, `ccm-283` becomes mintable and renderable in the same ordinary SOFT+ pass. There was no frozen untagged decision to stop first application on that defer.
5. The earlier pass-one bootstrap fix is **3444-3454**: a brand-new tagging surface may mint on its bootstrap HARD. It did not remove the separate per-message exclusion above, so it cannot repair a later tool-loop tail.

## TS differential and scope

The actual TS path is `packages/plugin/src/hooks/magic-context/tag-messages.ts` (not `features/...`). Source citations at the task base:

- **492-494** walks all messages, with no newest-assistant exemption.
- **644-655**, **701-706** qualify text and exclude whitespace-only assistant framing.
- **742-760** calls `assignTag` for text at first sight.
- **783-791** calls `prependTag` unless prefix injection is explicitly disabled.
- **738-740**, **748**, **757** attribute reasoning accounting to the text tag, rather than prefixing reasoning itself.
- **809**, **839-877** mint and render completed tool outputs; unfinished invocations alone do not acquire output tags.

The shared golden `crates/mc-module/testdata/cc-tool-loop-tag-golden.json` pins the first-sight visible text. The new TS test executes the real `tagMessages` with a real temporary database and compares against that golden on two tool-loop arrays. The Rust test executes the real Claude Code transform against the same expected text. This is a TS/OpenCode tagger versus Rust/Claude Code differential, **not a claim that Rust OpenCode native serialization was changed**. Inspection found OpenCode's separate raw native-envelope exemption (`crates/mc-module/src/codec/opencode.rs:460-477`); expanding this CC fix into that independent policy would not be a minimal change.

## Implementation and signed-thinking safety

Current source locations:

- `crates/mc-module/src/transform.rs:9018` (`compute_active_overlay_decisions`): the CC path mints without the live assistant exemption; frozen reductions and lineage anchors still gate candidates.
- `crates/mc-module/src/transform.rs:8651` (`apply_tag_overlay_to_message`): a tag-only mode excludes temporal/hint/channel overlays.
- `crates/mc-module/src/transform.rs:13302`: the exempt CC assistant receives only tag prefixes. Existing reductions and reasoning guards remain separate.
- `crates/mc-module/src/lib.rs:621-625`: tagger epoch 4 forces the normal priced upgrade fold.
- `crates/mc-module/src/transform.rs:8418` (`taggable_source`): only user/assistant text and textual completed tool results qualify. Reasoning and redacted reasoning fall through to `None`.
- `crates/mc-module/src/transform.rs:13614`: latest provider-visible assistant reasoning retains its independent exemption.

The tag mutator edits a text block and invalidates that block's retained serialization, not the thinking block. The regression compares the complete serialized served assistant before/after the new reasoning assistant, and separately compares its serialized reasoning block (including the signature) to ingress on both passes. Tool shape and block order remain covered by whole-message equality and the existing transform tool-arc assertions.

At true first sight, the source never changes the signed thinking bytes. However, the statement “there is no later assistant on the observed continuation” is refuted by the bodies: there is already a later tool-only assistant on exchange 12989. No local source inspection can prove an external provider's complete cryptographic validation policy for Fable-5.1/Opus, and no live Fable/Opus acceptance probe was run. This delivery proves preservation of the signed block and the no-late-prefix invariant; it does not invent a provider validation result.

## Red-first and executed mutation

Regression: `transform::tests::tool_loop_first_sight_tag_bytes_survive_new_reasoning_assistant` at `crates/mc-module/src/transform.rs:26646`.

The synthetic fixture uses target `message-52` (ordinal 52), thinking + text + tool call, its tool result, a newer tool-only assistant/result, then a newer reasoning-bearing assistant/result. Both observed passes must remain SOFT+. The first pass must already have the TS golden prefix, and the serialized target must be byte-identical across passes.

Before implementing the fix:

```
cargo test -p mc-module tool_loop_first_sight_tag_bytes_survive_new_reasoning_assistant
exit 101
...tool_loop_first_sight_tag_bytes_survive_new_reasoning_assistant ... FAILED
assertion `left == right` failed: claude-code-anthropic: message 52 must not acquire a tag one pass late
```

After implementing the fix the test passed. Then the following mutation was actually executed on the completed implementation:

1. Ran `git add -A` unconditionally to snapshot the live implementation in the index.
2. Replaced the CC first-sight mint argument with `mutation_exempt_mid`, marked `NON-VACUITY BREAK` in the temporary code.
3. Captured non-empty `git diff --stat` against the index (`mutation-applied.stat`):
   `crates/mc-module/src/transform.rs | 11 ++---------`; **1 file changed, 2 insertions(+), 9 deletions(-)**.
4. Ran the named regression unpiped, saving `mutation.log`: **exit 101**, exactly that test failed (0 passed, 1 failed).
5. With the same mutant still applied, ran `cargo test -p mc-module claude_code_first_requested_surface_tags_bootstrap_pass_one`: **exit 0**, that bootstrap test passed. The old bootstrap test therefore did not defend the recurring tool-loop case.
6. Restored with `git checkout -- crates/mc-module/src/transform.rs && touch crates/mc-module/src/transform.rs`.
7. Captured `git diff --stat` against the index again: **empty**, saved in `mutation-restored.stat`.
8. Reran the named regression: **exit 0**, 1 passed. No mutation remains in production code.

## Verification

- `bun install --frozen-lockfile` — passed; no manifest or Bun lockfile changes.
- `bun test packages/plugin/src/hooks/magic-context/transform-operations.test.ts` — passed, 16 tests / 30 assertions.
- `bun run --cwd packages/plugin typecheck` — passed (retina build tsc, plugin `tsc --noEmit`, scripts tsc).
- `cargo test -p mc-module` — **exit 0**, 1067 unit tests passed, 4 ignored; all three integration tests passed; no failures. Unpiped, full log at `cargo-test.log`.
- `cargo clippy -p mc-module --all-targets -- -D warnings` — **exit 0**, full log at `clippy.log`.
- `cargo fmt --all --check` — passed.
- `git diff --check` — passed.
- AFT inspect — fresh but incomplete Rust/TS producer coverage; not used as the compiler authority.
- Sidekick changed-comment reviews — no unclear comments flagged.
- Optional TS formatter invocation skipped: local Biome binary unavailable. Typecheck and tests passed.

Two deliberate contract/accounting adjustments are explicit: epoch expectations now assert 4; the existing CC reasoning-age test's frozen tag cutoff changes from 1 to 2 because the newest assistant text now receives its own tag on first sight. Its protections are unchanged: old thinking remains byte-stable until HARD, old signed blocks are removed only on HARD, and newest thinking survives. No test claiming signed-thinking preservation was weakened.

During verification a concurrent sibling subc-protocol change broke compilation (0.18 → 0.19, `ModuleManifest::builder` API). At the parent's instruction this task fast-forwarded to master **830becc24de3c0ba783bf9bc306ae8d1935debed**, which already contained the compatibility fix. No sibling checkout was edited and no temporary API shim was used. Subsequent shared sibling patch bumps were observed by Cargo; their automatic lockfile churn is not part of this delivery.

The requested `knowhow({id:"mc-cache-bust-triage"})` was attempted first and returned unknown skill id. Search also found no such managed skill; the suggested worktree-local SKILL.md was absent. Investigation proceeded from source and staged captures under the worktree fence.
