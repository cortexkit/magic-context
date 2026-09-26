# Anthropic thinking-block prefix binding: Opus 5.5 coverage, live specimen, recovery cost, `drop_block` status

Date: 2026-09-26. Investigation only; no product code changed.

Scope (narrowed by the operator): the reactive recovery arm from commit `925bb96d` is taken as given. This report covers
(1) whether Claude Opus 5.5 is enforced like Fable 5.1 and what widening the arm's model gate involves,
(2) a live 400 specimen for both models, checked against our doc-derived matcher and message-id extraction,
(3) what the arm costs per mutating pass on an enforced account, and
(4) whether proactive `drop_block` shipped in anthropic-auth or Thalamus, and the missing per-lane mechanism.

## Summary

- **Opus 5.5 is enforced exactly like Fable 5.1.** The Preserved thinking page names both models in every enforcement statement. MC's arm is gated to Fable 5.1 at six call sites (TS and Pi). The Rust crates have no arm of their own. Widening means one new predicate and six call-site swaps, plus tests.
- **Live specimen captured for both models.** The body is identical for Fable 5.1 and Opus 5.5 and matches `THINKING_BINDING_MISMATCH_PATTERN`. **Finding:** the real error has no message id of any kind. It names a wire path (`messages.1.content.0`) and the first changed position (`messages.0.content.0`). `extractThinkingBindingMessageId` therefore never fires on real traffic, and the arm always falls back to "newest reasoning-bearing assistant".
- **Finding: the arm does not converge in one step.** The 400 names the *earliest* failing thinking block. The arm strips the *newest* reasoning-bearing assistant, one per failed request. After an m0/m1 change every signed thinking block on the wire is invalid, so one mutation costs *K* user-visible failed turns, where *K* is the number of reasoning-bearing assistant messages still on the wire (the default `clear_reasoning_age` is 50 tags, so *K* can be large). The cycle repeats on the next prefix-mutating pass. This is inferred from the page's rules plus the live error's choice of block. It was not replayed end-to-end on an enforced account.
- **Finding: without the beta header, `block_binding` is a hard 400.** The error is `thinking.adaptive.block_binding: Extra inputs are not permitted`. It is not a binding error and no binding recovery applies. Any proactive lane must set the body field and the beta header together.
- **Finding: our OAuth account silently drops mismatched thinking by default.** The page says older accounts let failing blocks through and label them `thinking_mismatch_allowed`. On our OAuth route, a request with no `block_binding` field was billed exactly like the `drop_block` request. With the beta header, the response labelled the block `thinking_dropped` / `prefix_binding_mismatch`. So OAuth users on older accounts already lose the reasoning after each MC prefix edit, silently. The API-key route was not testable (no key available).
- **Proactive `drop_block` status:**
  - anthropic-auth shipped the mechanism, but it is gated to Fable 5.1 only, OAuth only, and opt-in. The default is `account-default`, which sends nothing, and the operator's own config does not set it.
  - Thalamus has not shipped it: no occurrence of `block_binding`, `thinking-binding-controls` or `prefix_mismatch` in the repo.
  - MC itself has no request-body or header hook on OpenCode, so plain API-key OpenCode users have no proactive path today.

## 1. Opus 5.5: is it enforced the same way?

Yes. Verbatim from the Preserved thinking page (extract file `~/.local/share/cortexkit/shared/ck-ext-r3-evidence/MC/excerpts/09-anthropic-preserved-thinking-extracts.md`, retrieved 2026-09-26):

- "On Claude Fable 5.1 and Claude Opus 5.5, a thinking block stays valid only while everything you sent before it is unchanged on later requests."
- "The API enforces the prefix check on Claude Fable 5.1 and Claude Opus 5.5 for new accounts."
- "Accounts created on or after August 31, 2026, 00:00 UTC: the API checks Claude Fable 5.1 and Claude Opus 5.5 requests and applies `"error"` unless you set `"drop_block"`. The same definition of a new account applies to the Claude API and to cloud platforms."

The live probe below confirms it on the wire. Opus 5.5 returns the same 400 byte for byte and the same `input_transformations` as Fable 5.1.

The page also says: "Claude Fable 5.1 reads blocks from Claude Opus 5 and, on the Claude API, from Claude Opus 5.5; neither Claude Opus 5 nor Claude Opus 5.5 reads blocks from Claude Fable 5.1." When a user switches models mid-session, the API drops the unreadable blocks silently. That is not a binding 400.

### What widening the gate involves

The model predicate is `isFable51ThinkingBindingModel(providerID, modelID)` in `packages/plugin/src/features/magic-context/overflow-detection.ts:236-242`. It requires `providerID === "anthropic"` and matches `/(?:^|[-_.])fable[-_.]?5[-_.]1(?:$|[-_.])/i`. The live model id `claude-fable-5-1` matches.

Arm and apply call sites that must accept Opus 5.5 (`claude-opus-5-5`):

| Lane | Site | Role |
|---|---|---|
| OpenCode 1/2 (TS mode) | `packages/plugin/src/hooks/magic-context/event-handler.ts:335` | arm on `session.error` |
| OpenCode 1/2 (TS mode) | `packages/plugin/src/hooks/magic-context/event-handler.ts:493` | arm on `message.updated` with `info.error` |
| OpenCode 1/2 (TS mode) | `packages/plugin/src/hooks/magic-context/transform.ts:2670` | `thinkingBindingRecoveryEnabledForModel`: consume the armed flag and strip |
| OpenCode (Rust mode) | `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:3726` | the same flag passed to `runRustModePostprocess` |
| Pi | `packages/pi-plugin/src/provider-error-recovery-pi.ts:74` | arm on `message_end` error |
| Pi | `packages/pi-plugin/src/provider-error-recovery-pi.ts:192` | consume the armed flag on the next context pass |

Minimal change: add a sibling predicate that also matches `opus[-_.]?5[-_.]5` (for example `isPrefixBoundThinkingModel`) and swap it in at those six sites. Also:

- **Do not** swap it into `packages/plugin/src/hooks/magic-context/sentinel.ts:61`. That call canonicalises the model id for the variant-cache table (`VARIANT_CACHE_PRESERVING_MODELS`), which already lists `anthropic/claude-opus-5-5` separately. It is unrelated to binding recovery.
- **Rust:** `crates/mc-module` has no binding detection or arm. Its only Fable regex (`crates/mc-module/src/transform.rs:6988`) is the Rust copy of that same variant-cache canonicaliser. In Rust mode, detection, arming and stripping all run in the TS event handler and the TS postprocess (`rust-mode-transform.ts:3726`). **No Rust change is needed.**
- Log strings say "Fable" (Pi `provider-error-recovery-pi.ts:85,223`). They are cosmetic and should be renamed alongside the predicate.
- Tests to extend: `event-handler.test.ts` ("arms documented Fable 5.1 binding mismatch recovery and ignores other models", which uses `fable-5-0` as the negative), `overflow-detection.test.ts`, and `provider-error-recovery-pi.test.ts`.
- **Out of scope but relevant:** the arm and `stripReasoningFromAssistantIds` both require `providerID === "anthropic"`. Bedrock and Vertex sessions are therefore not covered, although the page says cloud platforms enforce the same rule for new accounts.

## 2. Live specimen

### Method

- **Script:** a throwaway Bun script outside the repo, `/tmp/tb-probe/probe.ts`, not committed.
- **Credentials:** obtained only through anthropic-auth's own path. `ClaustrumScopedRuntime.authorize('main')` against the running ck-claustrum daemon returns a memory-only bearer, which was never printed or stored. Requests were built with anthropic-auth's `applyClaudeCodeHeaders`, `applyClaudeCodeMetadata`, `buildBillingHeaderValue` and `signRequestBody` (the OAuth Claude Code wire shape) and sent non-streaming to `POST https://api.anthropic.com/v1/messages?beta=true`.
- **Scrubbing:** signatures appear below as their length and `metadata` is redacted.

Each run:

1. **Turn 1:** m0 = `<project-context>project=alpha</project-context>` plus a small maths prompt, with `thinking: {type: "adaptive", display: "summarized"}` and `output_config.effort: "high"`. The response carried a `thinking` block.
2. **Unchanged control:** `[m0(alpha), assistant turn 1 verbatim, "Now subtract 1000."]` with `prefix_mismatch_behavior: "error"` and the beta header.
3. **MC-style m1 refresh:** the same request but m0 re-rendered with `project=beta`, sent five ways: `error` + beta; `drop_block` + beta; field unset + beta; `error` without beta; unset without beta.

Total spend was under 2k tokens across both models.

The second mutation (shortening an earlier `tool_result`) was attempted and **not captured**. Both models' first tool turn returned HTTP 400 `You're out of extra usage. Add more at claude.ai/settings/usage and keep going.` (request ids `req_011CfSansW9L1Bdr4QNbxE8u` and `req_011CfSanuEa9nNFNkdaBjVY3`). No further spend was attempted. The page's table covers that row: "Clear or shorten an earlier `tool_result` ... Invalid for every later thinking block".

### Transcript (keys redacted)

Request (Opus 5.5, mutated step; Fable 5.1 is identical apart from `model`):

```json
{
  "model": "claude-opus-5-5",
  "thinking": {"type": "adaptive", "display": "summarized",
               "block_binding": {"prefix_mismatch_behavior": "error"}},
  "output_config": {"effort": "high"},
  "messages": [
    {"role": "user", "content": [{"type": "text", "text": "<project-context>project=beta</project-context>\nFind the smallest positive integer n such that n^2 + n + 41 is composite, and show it is composite. Think it through carefully, then give only n."}]},
    {"role": "assistant", "content": [
      {"type": "thinking", "thinking": "n=40 works: 40²+40+41=1681=41², ...", "signature": "<1440 chars>"},
      {"type": "text", "text": "40"}]},
    {"role": "user", "content": [{"type": "text", "text": "Now subtract 1000. Only the number."}]}
  ]
}
```

(Turn 1 was generated with `project=alpha`. The `anthropic-beta` header included `thinking-binding-controls-2026-08-01` on the "+ beta" rows.)

| # | Model | Request | HTTP | request-id | input tok | output / thinking tok | `input_transformations` / error |
|---|---|---|---|---|---|---|---|
| 1 | fable-5-1 | turn 1 | 200 | req_011CfSajxPFEx9T7t1hZEXTu | 102 | 93 / 56 | — (blocks: thinking, text) |
| 2 | fable-5-1 | unchanged, `error` + beta | 200 | req_011CfSak8u1qA2hyCXe5u5As | 213 | 4 / 0 | `[]` |
| 3 | fable-5-1 | m0 changed, `error` + beta | **400** | req_011CfSakFxfwQ2vmA7q6iK45 | — | — | see body below |
| 4 | fable-5-1 | m0 changed, `drop_block` + beta | 200 | req_011CfSakH8s5NcwscVeQdApf | 154 | 4 / 0 | `[{"type":"thinking_dropped","path":"messages.1.content.0","reason":"prefix_binding_mismatch"}]` |
| 5 | fable-5-1 | m0 changed, unset + beta | 200 | req_011CfSakQBXLbkhJ321M7dT3 | 154 | 4 / 0 | `[{"type":"thinking_dropped","path":"messages.1.content.0","reason":"prefix_binding_mismatch"}]` |
| 6 | fable-5-1 | m0 changed, `error`, **no beta** | **400** | req_011CfSakXK9cpaiYjbn5Uqcy | — | — | `thinking.adaptive.block_binding: Extra inputs are not permitted` |
| 7 | fable-5-1 | m0 changed, unset, no beta | 200 | req_011CfSakYdXDyPcYPjBUEvAh | 154 | 4 / 0 | (field absent without beta) |
| 1 | opus-5-5 | turn 1 | 200 | req_011CfSakgN7eMkKn8Yjr2e6E | 102 | 189 / 186 | — (blocks: thinking, text) |
| 2 | opus-5-5 | unchanged, `error` + beta | 200 | req_011CfSam9G7rqhi5Xmh7Douo | 309 | 17 / 13 | `[]` |
| 3 | opus-5-5 | m0 changed, `error` + beta | **400** | req_011CfSamMwNRxGGA68cVirSS | — | — | see body below |
| 4 | opus-5-5 | m0 changed, `drop_block` + beta | 200 | req_011CfSamPTePuhdmyK5oE1Kj | 120 | 61 / 57 | `[{"type":"thinking_dropped","path":"messages.1.content.0","reason":"prefix_binding_mismatch"}]` |
| 5 | opus-5-5 | m0 changed, unset + beta | 200 | req_011CfSamfbWGfrYZXRRzUNCi | 120 | 99 / 95 | `[{"type":"thinking_dropped","path":"messages.1.content.0","reason":"prefix_binding_mismatch"}]` |
| 6 | opus-5-5 | m0 changed, `error`, **no beta** | **400** | req_011CfSamy11fT73J1n3JbgQ7 | — | — | `thinking.adaptive.block_binding: Extra inputs are not permitted` |
| 7 | opus-5-5 | m0 changed, unset, no beta | 200 | req_011CfSamzSKsu8kT2tgH5u9r | 120 | 55 / 51 | (field absent without beta) |

The 400 body for row 3 is identical for both models:

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to \"drop_block\". Content before this block differs from when it was created, first at `messages.0.content.0`."
  },
  "request_id": "req_011CfSakFxfwQ2vmA7q6iK45"
}
```

The page says an enforced account that did not send the beta gets one more sentence ("That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header."). We cannot produce that variant: our account is not enforced by default, and opting in requires the beta.

### Against our matcher and id extraction

- **`THINKING_BINDING_MISMATCH_PATTERN = /bound to a different conversation/i`** (`overflow-detection.ts:117`): **matches** the live text for both models. The doc-derived fixture in `overflow-detection.test.ts` and `event-handler.test.ts` is a prefix of the real message. The real message appends "Content before this block differs from when it was created, first at `messages.0.content.0`." The status guard (400 or absent) also holds. The row-6 "Extra inputs are not permitted" 400 correctly does **not** match.
- **`extractThinkingBindingMessageId`** (`overflow-detection.ts:171-189`, which walks the error object for `message_id` / `messageID` / `messageId`): **finds nothing on real traffic.** The body's only identifiers are `request_id` (`req_…`) and two wire paths: `messages.N.content.M` is the first failing block, and `first at messages.K.content.J` is the first changed position. Both index the lowered Anthropic array, not OpenCode or Pi message ids. The test "extracts a provider-supplied offending message id when present" is written against a `message_id` field that the API does not send. On the live path the arm always stores `NEWEST_REASONING_BEARING_ASSISTANT`. That behaviour is safe, but it is the root of the convergence problem in §3.
- The wire path *does* name the failing block. It is the earliest thinking block after the first changed position. It could in principle be mapped back to a host message. MC does not keep a wire-index map, and OpenCode's lowering merges and filters parts, so that mapping is not free.

### Other observations

- **Silent drop on our OAuth route.** With the field unset, rows 5 and 7 are billed exactly like row 4 (154 vs 154 input tokens for Fable; 120 vs 120 for Opus). The valid-prefix control costs 213 and 309, the difference being the replayed thinking block. With the beta header, row 5 is labelled `thinking_dropped`, not the documented `thinking_mismatch_allowed`. So on this OAuth account the unset default behaved as `drop_block`, not as the page's "older accounts ... let failing blocks through". We could not check whether the API-key route behaves as documented.
- **The model does re-think after a drop.** The page warns "Claude can sometimes think more to re-create the dropped thinking". On Opus 5.5 the follow-up turn thought 13 tokens with its 186-token block intact, and 57, 95 and 51 tokens when the block was dropped (rows 4, 5 and 7). This is a single tiny sample, directionally consistent with the warning.

## 3. What the arm costs per mutating pass on an enforced account

Current mechanism (`925bb96d`; TS `transform-postprocess-phase.ts` / Pi `applyPiThinkingBindingRecovery`):

1. The provider returns a 400. MC's event handler (`session.error` or `message.updated`; Pi `message_end`) arms `thinking_binding_recovery_target`. On live traffic that is always `NEWEST_REASONING_BEARING_ASSISTANT` (see §2).
2. MC does not issue a retry. OpenCode and Pi surface the 400 as a failed assistant turn, which the user sees. Neither host auto-retries a non-retryable 400 as far as this investigation read, but host retry policy was not re-verified here.
3. On the next request (the user re-sends), the postprocess resolves the newest assistant that still has reasoning. It persists `binding_mismatch:<id>` in the merged-reasoning frozen set and replaces that one message's reasoning parts with sentinels. The frozen set replays on every later pass, so a stripped block stays stripped. That respects the page's "Once you remove a block, leave it out."

Per the page, removing blocks from the end is permitted, but every block after the first changed position is invalid. The live 400 names the *earliest* failing block (`messages.1.content.0` in the probe), and the arm removes the *newest*. So:

- **m0/m1 re-render** (the page: "Invalid for every thinking block"): every signed thinking block on the wire fails. Recovery removes one per failed request, so it converges only after **K failed user turns**. K is the number of assistant messages that still carry signed reasoning. Reasoning older than `clear_reasoning_age` (default 50 tags, `config/schema/magic-context.ts:1225-1229`) is already cleared and stripped by MC, so K is bounded by the reasoning-bearing assistants in roughly the newest 50 tags. In an active tool loop that can be tens.
- **Mid-history edits** (drop, caveman or image strip at position P; shortened `tool_result`): K is the number of reasoning-bearing assistants after P.
- **It repeats.** Every later pass that edits the prefix before a surviving or newly produced thinking block triggers the same cycle for those blocks.

This is **inferred** from the page's rules plus the live error choosing the earliest block. It was not replayed on an enforced account (ours is not enforced by default, and the usage cap stopped further probes). Cost of each failed request: zero tokens (rejected before inference), one visible error, and one user re-send.

A cheap reactive fix, if the proactive lane is not available: on a binding mismatch, strip reasoning from **all** assistants on the wire (the page permits removing "all of them"). That converges in exactly one failed request per mutating event. Model cost: for m0/m1 edits it loses exactly what `drop_block` would drop (everything); for mid-history edits it additionally loses the blocks before P.

**Open risk, not verified here:** stripping the newest assistant's reasoning while a tool round is open (`tool_use` answered by a pending `tool_result`). The page says to "Send that assistant turn back with its thinking intact". The current arm can already select that message.

## 4. Proactive `drop_block`: what shipped, and the missing mechanism per lane

| Lane | Shipped? | Evidence | Missing mechanism |
|---|---|---|---|
| **anthropic-auth → OpenCode** (OAuth) | **Partially** | `anthropic-auth/packages/core/src/thinking-binding.ts` `applyThinkingBindingControls` sets `thinking.block_binding` only when (a) the account config `thinkingBinding.prefixMismatchBehavior` is `error` or `drop_block` (the default `account-default` sends nothing), (b) `isClaudeFable51Model(body.model)`, (c) the body replays a signed `thinking` / `redacted_thinking` block, and (d) thinking is not disabled. Called from `packages/opencode/src/transform.ts:1368`. The beta is added in the same request via `hasThinkingBindingControls` (`opencode/src/transform.ts:186-187`), which keeps field and header paired (see row 6 above for why that matters). Commits `db029242`, `74cca244`. | Add Opus 5.5 to the model gate (`isClaudeFable51Model` → a Fable-5.1-or-Opus-5.5 predicate). Decide whether MC-managed sessions should default to `drop_block` instead of `account-default`. The operator's own `~/.config/opencode/anthropic-auth.json` has no `thinkingBinding` key, so it runs `account-default`. |
| **anthropic-auth → Pi** (OAuth) | **Partially** (same limits) | `packages/pi/src/convert.ts:705` calls the same function with `controls.thinkingPrefixMismatchBehavior ?? 'account-default'`; the beta is paired at `packages/pi/src/stream.ts:307,339,634`. anthropic-auth's ARCHITECTURE.md:61 describes Pi as always adding `drop_block` on OAuth Fable 5.1 continuations. The code adds it only when configured. | Same as the OpenCode row. |
| **API-key routes via anthropic-auth** | **No** | By design: "First turns and API-key routes receive neither control" (anthropic-auth ARCHITECTURE.md:170). | Lift the OAuth-only restriction for these two models, or leave API-key users to MC's reactive arm. |
| **OpenCode 1 / OpenCode 2 without anthropic-auth** (`@ai-sdk/anthropic`, API key) | **No** | MC's plugin registers no `chat.params` or `chat.headers` hook (no occurrence in `packages/plugin/src`), and MC does not own the fetch. | A header hook can add the beta. The body field has to reach `thinking` inside the AI SDK's Anthropic request builder, and this investigation did **not** verify whether that builder passes unknown `thinking` sub-fields through (the SDK is bundled in the OpenCode binary and not on disk here). Unless pass-through is proven, there is **no mechanism** in this lane short of a custom `fetch` wrapper that rewrites the body. That is what anthropic-auth does, and it is out of MC's current surface. Sending the header without the field is harmless. Sending the field without the header is a hard 400. |
| **Pi without anthropic-auth** | **No** | MC's Pi extension edits context messages only. | Same shape: Pi's built-in Anthropic provider builds the body. MC would need a provider-payload hook in Pi, or anthropic-auth. Not verified here. |
| **Thalamus** (Claude Code leg) | **No** | No occurrence of `block_binding`, `thinking-binding-controls` or `prefix_mismatch` in the thalamus repo at `a08686d`. | Thalamus owns the final body and the forwarded headers. `crates/thalamus-core/src/proxy.rs` `forward` (~l.718, header copy ~l.1125) runs after the transform and the `outbound.rs` `validate_anthropic_outbound` gate. When the model is Fable 5.1 or Opus 5.5, the body replays signed thinking, and the transform edited the prefix: set `thinking.block_binding.prefix_mismatch_behavior = "drop_block"` and append `thinking-binding-controls-2026-08-01` to `anthropic-beta`, as one atomic step. anthropic-auth's Claude Code capture notes say Claude Code itself sends binding controls on some continuations; the value it sends was not checked here, and Thalamus must not blindly override it. |
| **MC Rust module** | n/a | The module transforms messages and has no wire access. The lane is whichever host carries the request. | none |

### Cost of `drop_block` (from the page, plus the probe)

- Dropped blocks are not billed. In the probe, the input shrank by the dropped block (Fable −59 tokens, Opus −189).
- "the prompt cache restarts at the edit". MC's prefix edits already bust the cache at that point, so this adds no cache cost.
- The model answers "without using reasoning from dropped blocks". It may think more to re-create them: "The increase tends to be larger when more thinking blocks are dropped, or when blocks are dropped on more turns of a long session." The page gives no number. The probe's single Opus sample: 13 thinking tokens intact vs 51 to 95 dropped.
- For an m0/m1 re-render, `drop_block` drops every thinking block, which is the same reasoning loss as a successful reactive recovery, but with zero failed requests. For a mid-history edit, it drops only from the first failing block onward.

## Recommendation

1. **Widen the reactive arm to Opus 5.5 now.** One predicate, six call sites (§1), tests. No Rust change. This is cheap and closes the gap for enforced new accounts on both models.
2. **Make the arm converge in one failure.** On a binding mismatch, strip reasoning from all assistants on the wire instead of only the newest (§3). Separately guard the open-tool-round case. Delete or relabel the dead `message_id` extraction path so nothing depends on it. Cost: one visible failed turn per prefix-mutating event, and the model loses all prior reasoning at that point. For m0/m1 edits, `drop_block` loses the same amount.
3. **Proactive lane where we own the wire:**
   - **anthropic-auth:** extend `applyThinkingBindingControls`' model gate to Opus 5.5, and default to `drop_block` for continuations that replay signed thinking. That removes every failed request for OAuth OpenCode and Pi users. Cost: dropped reasoning (unbilled) plus possible extra re-thinking, and it hides the error, so log `input_transformations` entries with `reason: "prefix_binding_mismatch"` as the page advises.
   - **Thalamus:** the same, at the proxy's final body.
   - **Plain API-key OpenCode and Pi:** MC has no proven mechanism. Stay reactive (items 1 and 2) unless `@ai-sdk/anthropic` pass-through of `thinking.block_binding` is demonstrated.
4. **Record the silent-drop finding.** On our OAuth route, older-account MC users already lose post-edit reasoning silently today (§2). The quality cost of MC's prefix edits on these models is therefore already being paid by grandfathered OAuth users. It is not the page's "let through" behaviour.

## Follow-up: recovery fix

Recommendations 1 and 2 are implemented after this report:

- **Model gate.** `isPrefixBoundThinkingModel` (`overflow-detection.ts`) covers Fable 5.1 and Opus 5.5. It replaces the Fable-only predicate at the six arm/apply sites listed in §1. `sentinel.ts:61` keeps `isFable51ThinkingBindingModel`, because it is the variant-cache canonicaliser.
- **Convergence.** An armed flag now freezes **every** reasoning-bearing assistant on the wire into the `binding_mismatch:` frozen set, not only the newest. One failed request per prefix-mutating event, then the retry succeeds. The flag value is `all_reasoning_bearing_assistants`. Any other non-empty stored value, such as the old `newest_reasoning_bearing_assistant` or a message id, is read the same way, so no migration is needed.
- **The old arm could not reach K.** OpenCode and Pi rebuild the message array for every pass. The old arm resolved "newest reasoning-bearing assistant" before the frozen strips were replayed, so on a rebuilt array it picked the already-frozen newest block every time and never moved to older blocks. A multi-assistant session could therefore fail indefinitely, not just K times. The regression tests reproduce this: six failures without converging.
- **Open tool round.** The newest assistant is stripped even when its `tool_use` is still waiting for the model to read its `tool_result`. After a prefix edit that block is invalid as well ("that block and every later thinking block are invalid"), so keeping it would fail the retry with the same 400. Removing all thinking blocks is listed as valid. `drop_block` removes exactly those blocks, whichever turn holds them, and the request succeeds; keep-tail compaction uses the same pattern ("the model reads the kept turns' `text` and `tool_use` blocks"). The page's "send that assistant turn back with its thinking intact" advises against editing the prefix in the middle of a tool round. It does not require re-sending a block the edit has already invalidated. The last request message is the user `tool_result`, so the rule that a final assistant message must start with thinking does not apply.
- **Message-id extraction removed.** `detectThinkingBindingMismatch` no longer looks for `message_id`. It reports the two provider request-array paths (`failingBlockPath`, `firstChangedPath`), for logs only. Tests use the captured §2 body as the fixture.
- **Served bytes.** Bytes change only on sessions using the `anthropic` provider with Fable 5.1 or Opus 5.5, and only after a binding 400 armed the flag. On the first live pass after the arm, every reasoning part still on the wire becomes an empty text sentinel. Later passes (defer included, plus the Rust last-known-good replay) replay that frozen set byte-identically. Sessions that never hit the 400 serve unchanged bytes.
- **Not covered: Bedrock and Vertex.** The arm and `stripReasoningFromAssistantIds` still require `providerID === "anthropic"`, although the page says cloud platforms enforce the same rule for new accounts.

## Not done / caveats

- The `tool_result`-shortening specimen was not captured: the account hit the extra-usage limit. The row is covered only by the page.
- K-failure convergence (§3) is derived, not replayed end-to-end on an enforced account.
- Host auto-retry behaviour for a 400 was not re-verified in the OpenCode and Pi sources.
- The API-key route was not probed (no key in env, and none used).
- The AI SDK's handling of unknown `thinking` sub-fields was not verified.
- Per the narrowed scope, the mutation × lane matrix, the reasoning-clearing analysis and the GitHub/log search were not repeated.
