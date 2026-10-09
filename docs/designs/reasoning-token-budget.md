# Reasoning token budget (issue 620)

Adopted design. Default and selection rulings: fixed 10,000 tokens, newest-first whole-step fit.
Inputs: [issue 620](https://github.com/cortexkit/magic-context/issues/620),
[`docs/reports/reasoning-resend-cost.md`](../reports/reasoning-resend-cost.md) (the resend
measurement), [`docs/reports/reasoning-removal-all-providers-design.md`](../reports/reasoning-removal-all-providers-design.md),
[`docs/reports/anthropic-thinking-binding.md`](../reports/anthropic-thinking-binding.md),
`ARCHITECTURE.md` (load-bearing invariants 2 to 4) and `docs/architecture/reclaim.md` ("Strip and replay").

## Decision summary

1. **Replace `clear_reasoning_age` with a token budget, `keep_reasoning_tokens`.** It is the number
   of reasoning tokens Magic Context keeps in the served prompt for one session. On each pass
   that already busts the cache, reasoning older than the newest `keep_reasoning_tokens` worth is
   removed. One knob replaces one knob. The name avoids `reasoning_budget_tokens` because
   Anthropic's thinking request already uses `budget_tokens` for something unrelated (how much
   the model may think).
2. **Unit:** one assistant step's reasoning, costed in input tokens. Use the provider's
   **reported reasoning count** for that step when it is positive (OpenCode `tokens.reasoning`,
   Pi `usage.reasoning`). Otherwise estimate the **kept plaintext of that assistant step**, using the frozen prose calibration. Legacy tool-tag estimates describe preceding thinking and cannot price their tool owner's step. When a step has opaque reasoning and neither number, count a
   **fixed 1,000 tokens**. The multiplier is 1.0 on every route: the measurement found about
   1.0 input token per reported reasoning token on every well-sampled route.
3. **Select newest to oldest, keeping whole steps while the running cost fits.** The first step
   that does not fit sets a single tag cutoff (everything older goes),
   which replaces `maxTag − clear_reasoning_age` in every existing lane. Those lanes are the TS
   whole-part removal, the TS canonical-Anthropic `[cleared]` to empty-sentinel watermark, the
   inline `<thinking>` strip, the Pi empty-thinking watermark, Pi native reasoning replay, and
   the Rust `reasoning_age` / `reasoning_clear` frozen units. The same prefix-bound walk,
   exemptions, frozen ids and watermarks apply. The budget changes **how much** reasoning goes,
   never **where** or **how** it goes.
4. **Only on passes that already bust the cache.** New removals happen only where the age lane
   is allowed to act today: `routineCleanupApplied` in TS, `is_bust_pass` in Rust, and the Pi
   execute pass. Defer passes replay the frozen set byte for byte. Being over budget never starts
   a bust of its own. Removed reasoning is never restored, even if the budget is raised later.
5. **Default: fixed 10,000 tokens**, independent of the model's context window. Users can
   override it globally or per model. Offline replay informs future decisions, not this default.
6. **Shape:** a number, or a per-model object `{ "default": n, "provider/model": n, "provider/*": n }` resolved
   with the existing `cache_ttl` lookup walk (`resolveModelConfigValue`). Allowed in user and
   project config. `0` means "keep no historical reasoning".
7. **Migration:** `clear_reasoning_age` becomes deprecated and ignored, with a load warning and
   a doctor fix that removes the key. An age is not converted to tokens. Persisted watermarks and
   frozen ids stay valid because the new cutoff feeds the same monotonic `max()`.
8. **Routes that resend nothing need no special case.** On a route that does not resend
   reasoning (Ollama Cloud DeepSeek measured k≈0.004), removing it changes no provider input, so
   counting it by its text estimate costs nothing. There is no zero-resend capability table.
9. **Parity:** one pure cutoff function, implemented in shared TS core (OpenCode and Pi) and in
   Rust, pinned by a shared golden fixture that extends
   `crates/mc-module/testdata/prefix-bound-reasoning-trim.json`.

## Background: what `clear_reasoning_age` does today

The schema (`packages/plugin/src/config/schema/magic-context.ts:1261`) is `number().min(10).default(50)`
with **no upper bound**. The brief's "10–200" does not match the code. Docs (`configuration.md:76`)
say `number (10–)`, and nothing caps it at 200.

Every lane derives the same cutoff, `maxTag − clear_reasoning_age`, and freezes its decision on
a busting pass:

| Lane | Where | Applies to | Persisted state | Replay |
|---|---|---|---|---|
| Whole-part removal (`selectReasoningRemovals` / `removeReasoningParts`) | `reasoning-removal.ts`, called from `transform-postprocess-phase.ts:2606-2662`, applied last at `:4019` | Every OpenCode provider except canonical Anthropic, plus prefix-bound models (Fable 5.1, Opus 5.5, Sonnet 5.5) on any provider | Removed assistant ids (`addRemovedReasoningIds`) | Every pass splices exactly the persisted id set |
| `[cleared]` then empty sentinel (`clearOldReasoning` + `stripClearedReasoning`) | `strip-content.ts:319-405`, `transform-postprocess-phase.ts:2562-2574` | Canonical Anthropic, non-prefix-bound models | `session_meta.cleared_reasoning_through_tag` | `replayClearedReasoning` by watermark |
| Inline `<thinking>` strip | `strip-content.ts:409`, `:291` | Assistant text on every provider, except prefix-bound models | The same watermark | `replayStrippedInlineThinking` |
| Pi empty-thinking clear | `packages/pi-plugin/src/reasoning-replay-pi.ts` (`piReasoningClearCutoff`, `piPrefixBoundReasoningCutoff`, `clearOldReasoningPi`) | All Pi providers; Pi serializers drop empty thinking | `cleared_reasoning_through_tag` | `replayClearedReasoningPi` |
| Pi native reasoning replay | `packages/pi-plugin/src/native-replay-state-pi.ts:108` | Pi native entries | Saved id set | Every pass |
| Rust `reasoning_age` (whole-block removal) | `crates/mc-module/src/transform.rs:13366` `opencode_reasoning_removal_mids` | OpenCode AI SDK profile, non-empty-content providers, plus prefix-bound models | `strip:reasoning_age:<mid>` frozen units | `remove_frozen_historical_reasoning` |
| Rust `reasoning_clear` (empty shell) | `transform.rs:15863` `reasoning_clear_cutoff_with_tags`, `transform/reasoning_clear.rs` | OpenCode canonical Anthropic, non-prefix-bound; Claude Code profile, non-prefix-bound | `reasoning_cleared_through_tag`, `strip:reasoning_clear:<mid>` | `replay_reasoning_clear` |

All of them read the age from one place: `tag_age_cutoff` in Rust (`transform.rs:13149`), and
inline `maxTag − clearReasoningAge` arithmetic in TS and Pi. The historian trigger's
projection (`compartment-trigger.ts:244-262`) uses the same arithmetic to estimate how many
reasoning bytes the next bust would reclaim.

An age in tags is a poor proxy for cost. On the measured routes, one assistant step's reasoning
ranges from tens of tokens to tens of thousands (see §3), so "the newest 50 tags" keeps anywhere
from about 4k to over 400k tokens of reasoning. The issue reports exactly that for overthinking
models.

## 1. Unit and scope

### What is counted

The budget counts **kept reasoning**: the reasoning of assistant steps that is still on the
served wire after this pass's frozen removals, watermark clears and binding-recovery strips. It
is per session, and covers only messages the host still sends. Compartmentalised history is
already gone, so it costs nothing.

The unit of selection is **one assistant step's whole reasoning group**: every
`reasoning`/`thinking`/`redacted_thinking` part of one assistant message, plus OpenRouter's
`reasoning_details` copies, which already leave together. This follows the resend report's
constraint 3: when a step has one usage count and several reasoning parts, do not apportion
opaque reasoning by summary length. OpenCode records one usage per assistant message (one model
step), and Pi records one per assistant entry.

Inline `<thinking>` markup in assistant text counts at its text estimate. It shares the
watermark, so it is cut by the same cutoff.

### Cost per step, by provider class

`cost(step)`, computed only on a pass that already busts the cache:

1. `reported` = the host's reasoning count for that step (OpenCode `info.tokens.reasoning`;
   Pi `usage.reasoning`; Rust OpenCode leg: `info.tokens.reasoning` in `native_messages`). If
   `reported > 0`, use it.
2. Otherwise, if the step has reasoning text, use a text estimate multiplied by the model's
   calibration `proseRatio`, as `storage-tags.ts:699` already does. On OpenCode, the served step's own plaintext is estimated directly, after exact frozen merged-part removals are accounted for. Message-tag estimates can support DB-only projections once deduplicated; tool-tag estimates are excluded because they belong to preceding thinking. Pi tag rows store `null` there
   (`shared/tag-transcript.ts:528/942/1048`), and Rust tag rows (`mc-store` `McTagRow`) have no
   such column. Those two tokenize the thinking text on the busting pass: Pi with core
   `estimateTokens`, Rust with `mc_tokenizer::estimate_tokens`. That work is bounded, because
   the walk stops at the first step that does not fit, so it tokenizes at most the budget plus
   one step.
3. Otherwise, if the step carries an opaque payload (signature only, encrypted content,
   `redacted_thinking`), count `UNKNOWN_REASONING_STEP_TOKENS = 1,000`.
4. Otherwise `0`.

| Class | Measured routes (resend report) | Measured k | Budget cost |
|---|---|---|---|
| Reported, resent about 1× | Anthropic Opus 5.5 (k=1.000, 43,277 pairs), Opus 5, Sonnet 5, Fable 5.1; OpenAI/Codex GPT-6 family on OpenCode and Pi (1.003–1.018; GPT-6.1-sol 0.9986 on the no-new-user subset); OpenRouter DeepSeek v4.1 Flash (0.994); Grok 4.7 (1.000); Muse (0.961) | ≈1 | `reported × 1` |
| Reported, signature bundle | Antigravity Gemini 3.8 Flash (1.218, 75 selected pairs). The thought signature lives on the **tool** part, so removing the reasoning part does not remove it | ≈1.22 for the bundle | `reported × 1` (see open question 3) |
| Not reported, text present | Ollama Cloud GLM 5.3 / Flash (unsettled), MiniMax, local GGUF Qwen (0.73–1.04), any route that stores R=0 next to reasoning text | unknown to ≈1 | text estimate |
| Not reported, nothing resent | Ollama Cloud DeepSeek v4.1 Flash (k=0.004, 41 pairs) | ≈0 | text estimate; removal is input-neutral (§5) |
| Not reported, opaque only | No measured route. It would be, for example, an OpenAI step whose usage is missing: its summary is empty and its payload encrypted | unknown | 1,000 fixed |

Two cautions from the report shape the rules:

- **Stored text is not a proxy where a count exists.** Opus 5.5's visible thinking
  undercounts by about half (text-based k=2.096), and OpenAI summaries are often empty despite
  large R. So reported R always wins over the text estimate.
- **Encrypted payloads and signatures are never tokenized as text.** Their byte length is
  transport, not model tokens (report, constraint 2).

The per-route multiplier is 1.0 everywhere in v1, with no table. The budget is a target, not
an invoice. The only well-sampled route that departs from 1 by more than the sampling noise is
Gemini at 1.22, and there the removable share is unknown (see open question 3).

### Measured how, per harness

| Harness | Reported count | Text estimate | Notes |
|---|---|---|---|
| OpenCode 1 (TS and Rust OpenCode leg) | `info.tokens.reasoning` on the assistant message; separate from `output` | Kept thinking plaintext on that step | Legacy tool-tag estimates cannot prove the owning step's reasoning cost |
| Pi / OMP | `usage.reasoning` (present on 3,989 of 4,020 Codex steps) | Thinking text tokenized on the busting pass (Pi tag rows store `null`) | Pi Anthropic coverage is unmeasured; the same rules apply |
| OpenCode 2 | No measured steps (the named store has no assistant rows) | Kept thinking plaintext on that step | Read the same field if the v2 message exposes it; otherwise text estimate |
| Claude Code (Rust CC profile) | Claude Code usage has no reasoning split | Thinking text where the transcript keeps it, tokenized on the pass | Undercounts summarised Claude thinking by about 2×; see open question 6 |

The counts are read **live from the host messages on the busting pass**. No new column is
needed: a completed message's usage does not change, and the cutoff is frozen once chosen, so
replay never reads them again. Pi and Rust could later persist a reasoning token count on tag
rows to share the OpenCode path, but the budget does not need it.

## 2. Selection and when it applies

### The cutoff

```text
reasoningBudgetCutoff(assistants newest→oldest, budget) -> tag (0 = remove nothing)

kept = sum(cost(step) for each on-wire newest or exempt step)
for step in assistants, newest first:
    if step's reasoning is already off the wire: continue        # contributes 0
    if step is newest or exempt: continue                       # already charged; cannot remove
    if kept + cost(step) <= budget: kept += cost(step); continue
    cutoff = step.tag, or the nearest older tagged step's tag when step is untagged
    break
cutoff = min(cutoff, tag(newest assistant) − 1, tag(reasoning-exempt assistant) − 1)
return max(cutoff, 0)
```

The cutoff then goes into each lane where `maxTag − clear_reasoning_age` goes today. The
lanes keep all of their existing eligibility rules:

- the newest assistant and `findLatestAssistantReasoningMutationExemptMessage` (the newest one
  with replayable content) are never newly selected;
- on Anthropic routes, every assistant step after the last real user request is charged but exempt from the budget cutoff, in primary and subagent sessions; synthetic context and tool-result user carriers do not start a new turn;
- frozen removals take precedence over every current exemption or lineage change: once removed, signed reasoning never returns;
- tag 0, no wire content left after removal, and OpenRouter Gemini-signature details all still
  make a message ineligible;
- **prefix-bound models** (Fable 5.1, Opus 5.5, Sonnet 5.5) still walk oldest first and stop at
  the first reasoning-bearing message they may not remove. They pass over messages whose
  reasoning is already gone (removed ids, or the thinking-binding recovery set).

The exempt newest steps **count toward** the budget but cannot be removed. If they alone exceed
it, everything older that is eligible goes.

**Whole-step means selection, not a new clearing capability.** The cutoff never splits an
assistant step and no reasoning block is truncated. Existing redacted/native eligibility and
replay shapes remain authoritative: Pi serializers always send redacted thinking, so the lane
keeps it while clearing ordinary siblings as before; native replay has its independent saved
ids. Kept redacted/native blocks still count toward the budget. Old watermarks must replay
byte-identically after upgrade, never restoring cleared signed bytes on a defer.

The kept total is **at most the budget right after a busting pass**, except where
it may exceed the budget:

1. a prefix-bound walk stopped early at an ineligible message;
2. the exempt newest steps are larger than the budget;
3. existing lane eligibility keeps immutable redacted/native or protected signature payloads.

Existing immutable payloads are also not a new removal capability: kept Pi redacted/native
blocks and protected OpenRouter Gemini details can remain above the target. They still count;
the budget never authorizes rewriting or restoring them just to hit a number.

Between busts, new steps add reasoning on top. The budget is enforced at the next bust, never
by starting one.

### Why this satisfies the signed-thinking constraints

- **Oldest contiguous prefix (project memory #23609).** Anthropic preserved thinking accepts
  removing thinking "from the start of the history, from the end, or all of them". Removing a
  block from the middle invalidates every later signed block. The budget produces a tag
  cutoff, so for a fixed message order, "older than the cutoff" is always a prefix. The prefix
  walk is still the guard for ineligible steps inside that prefix, and its stop rule is
  unchanged. A cutoff never splits a step: a step is either entirely older than the cutoff or
  entirely kept.
- **No `[cleared]` inside a signed block (#22050).** No new rewriting lane is added. Whole-part
  removal deletes the part along with its signature or encrypted metadata. The canonical
  Anthropic watermark lane writes `[cleared]` only into a part that `stripClearedReasoning`
  replaces with an empty sentinel on the same pass; the replay path does the same on every
  later pass (`transform.ts:2324-2350`). OpenCode's Anthropic adapter drops that empty
  sentinel before the wire, and prefix-bound models never take that lane. Pi empties the thinking text
  and drops the signature, and its serializers omit empty thinking.
- **Absorbing trailing-blank decisions (#16284).** Removal stays where it is today: last, after
  `finalizeMessageRepresentation` and after frozen trailing-blank decisions, which are captured
  from the unmodified host input (`sourceDecisions`). An established `strip` decision remains
  absorbing, so the budget never adds a new reason to revisit it. The removed id set is frozen,
  so the parts that remain, and therefore the trailing-blank result, are the same on every
  later pass.

### When it applies

- **Ride-only (ARCHITECTURE invariant 4).** A cutoff is computed and new ids or a new watermark
  are frozen only where the age lane may act today: TS `routineCleanupApplied && reasoningRemovalSelectable`
  (`transform-postprocess-phase.ts:2606`), Rust `is_bust_pass` (`new_frozen_strip_units`,
  `reasoning_clear_cutoff_with_tags`), and the Pi execute pass. Being over budget is never a
  bust reason. Like every other automatic lane, it rides the single per-pass bust permission.
- **Byte-identical defers (invariant 2).** Defer passes run no selection. They replay the
  persisted id set or watermark exactly as today. Persist-before-apply and the fail-closed read
  (`transform-postprocess-phase.ts:2231-2251`) are unchanged.
- **Monotonic.** Watermarks advance by `max()`, and frozen id sets only grow until their
  message leaves. Raising the budget mid-session stops further removal but restores nothing,
  which is also required because restoring a signed block would invalidate the blocks after it.
  Lowering it takes effect on the next riding bust.
- **The bust reaches further back.** Old reasoning sits near the head of the tail, so a removal
  re-caches from that point. Folds and m[1] refreshes already rewrite from the head, so for
  them this costs nothing extra. For a force-band bust that starts deeper in the tail, the
  rewrite starts at the oldest newly removed step. That is the same as today's age lane, not a
  new cost.

## 3. Default value

### Fixed default

```text
keep_reasoning_tokens (when omitted) = 10,000
```

The default does not scale with the context window or verbosity. Each kept reasoning token
costs about one input token on every request. A fixed budget caps that recurring cost, while
the per-model shape provides an explicit escape hatch. Exempt steps can exceed the budget.

### Worked examples

Per-step reasoning sizes are the resend report's example rows nearest the 50th and 90th
percentile of reported R. These are **selected small-body tool-loop pairs**: steps right after a
user message usually reason more, so treat them as typical tool-loop steps, not as a
distribution. "Age 50" assumes about one tag per tool-loop step (each step's tool result is one
tag); text-bearing steps add tags, so age 50 really spans somewhat fewer steps.

| Route and window | Usable (`usableSoft`) | Default budget | Per-step R (p50 / p90) | Age 50 keeps about | Budget keeps |
|---|---:|---:|---|---|---|
| Opus 5.5, 1M | 872,000 (repo reports' live figure) | **10,000** | 157 / 754 | 7.9k / 37.7k | up to 63 / 13 steps |
| GPT-6.1-sol on OpenCode, 272k | ≈204,000 with a 68k reserve (25% cap); 247,424 with a 24,576 reserve | **10,000** | 73 / 516 | 3.7k / 25.8k | 136 / 19 steps |
| GPT-6.1-sol on Pi, 272k | same | **10,000** | 516 / 2,588 | 25.8k / 129.4k (nearly half the window) | 19 / 3 steps |
| Antigravity Gemini 3.8 Flash, 1M assumed (separate output quota, so no reserve is subtracted) | ≈1,000,000 | **10,000** | 3,970 / 29,168 | 198.5k / 1.46M | 2 / 0 non-exempt steps |
| Fable 5.1 (one session, 4 pairs; illustrative; 1M window assumed) | 872,000 | **10,000** | 9,098 / 22,060 | 455k / 1.1M | 1 / 0 non-exempt steps |
| An overthinking Flash model (issue), 128k-class window with a 32k (25%) reserve | ≈96,000 | **10,000** | 4,000 assumed | 200k (more than the window) | 2 steps |

What changes for users:

- **Opus 5.5 and OpenCode GPT-6.1-sol** keep more steps at p50 and fewer at p90 than age 50.
- **Pi GPT-6.1-sol, Gemini, Fable and overthinkers are capped.** These are the issue's cases.
  At age 50, Pi GPT-6.1-sol at p90 kept about 129k tokens of reasoning in a 272k window.

Before the default ships, replay the budget offline over the sessions behind the resend report.
For each route, compare kept reasoning tokens and steps removed per bust against age 50. The
scripts and acquisition rules already exist in `packages/plugin/scripts/reasoning-resend-cost/`.
The table above is a sizing argument, not that replay.

## 4. Coexistence, config migration and doctor

**Replace; do not run both.** Two knobs over one cutoff would need a precedence rule ("whichever
removes more"). The tag-age half has no remaining job: anything it would cap, the token budget
caps by cost.

### Config shape

```jsonc
// omitted: fixed 10,000 tokens (recommended)
"keep_reasoning_tokens": 20000,
// or per model, using the cache_ttl lookup order
"keep_reasoning_tokens": { "default": 20000, "deepseek/deepseek-v4.1-flash": 6000, "openai/*": 30000 }
```

- Zod: `union([int().min(0).max(1_000_000), object({ default }).catchall(...)])`, optional.
- Resolution: an exact model key, then shorter keys, then `provider/*`, then `default`, then the
  fixed 10,000 default. Resolve once per pass with the active model, like `cache_ttl` and
  `output_reserve`.
- `0` keeps no historical reasoning: on the next riding bust, every eligible step goes. A value
  of at least the window means it is never removed.
- Pi: the shared core schema already covers it. OMP: the same. Rust module config: add a
  matching `keep_reasoning_tokens` for the Claude Code leg, which has no TS host.

### Migrating `clear_reasoning_age`

- Schema: `clear_reasoning_age: z.unknown().optional().meta({ deprecated: true })`, as was done
  for `protected_tags` (`magic-context.ts:1254`). A load warning, through the
  `config/index.ts:418` path and the Pi loader's `config/index.ts:307` path, reads:
  > `clear_reasoning_age` is deprecated and ignored. Magic Context now keeps reasoning up to a
   > token budget, `keep_reasoning_tokens` (default 10,000). Remove the
  > key, or set `keep_reasoning_tokens` to a token count.
- **No automatic conversion.** A tag age does not translate to tokens without knowing the
  route's step size. Mapping it to a token count would hide the change behind a number nobody
  chose.
- Doctor (`doctor-opencode.ts` near the `auto_drop_tool_age` removal at `:1415`, and
  `doctor-pi.ts`): remove the key and print
  > Removed deprecated clear_reasoning_age (reasoning is now kept up to a token budget,
   > keep_reasoning_tokens, default 10,000).
  If the removed value was below 50, add:
  > You had set a lower age to keep less reasoning; set keep_reasoning_tokens (for example 8000)
  > to keep less than the default.
- `migrate-config-location.ts`: drop the key the same way as `protected_tags` (`:281`, `:512`).
- Dashboard: replace the `clear_reasoning_age` field (`ConfigEditor.tsx:135`,
   `config-field-coverage.ts:37`) with "Keep reasoning tokens". Leave it blank for 10,000.
- Docs: regenerate `reference/configuration.md` (`scripts/build-config-docs.ts`), and update
  `concepts/context-reduction.mdx` and `docs/architecture/reclaim.md` ("Strip and replay").
- Rust wire: add `keep_reasoning_tokens_effective: Option<u64>`, resolved by the host the same
  way as `protected_tokens_effective`. Keep accepting `clear_reasoning_age` through serde so
  that older senders still parse, but ignore it. When the effective value is absent (an older
   plugin or the Claude Code leg), the module resolves its own config with a fixed 10,000 fallback.

### Existing sessions on upgrade

Frozen reasoning decisions are absorbing at the **part** level. Exact merged-part decisions replay their selected blocks without reconsidering exemptions, while retained sibling blocks stay retained. Bare legacy merged ids lack exact evidence and continue the established partial-layout replay; they never become an all-block removal merely because of this upgrade. The first riding
bust after upgrade computes a budget cutoff and advances by `max()`. It may remove more (Pi
GPT, overthinkers) or nothing new (Opus at 1M). It never restores anything. No migration of
stored state is needed.

### Status and doctor visibility

`/ctx-status` gets one line:

`Reasoning kept: 8.4k of 10k (reported)`

with `(estimated)` when any counted step used the text or fixed fallback, and
`(over budget: newest step)` or `(over budget: signed prefix)` when one of the two
legitimate overruns applies. That tells a user whether lowering the budget can do anything,
without a separate diagnostic command.

## 5. Routes that resend nothing, and routes without counts

- **Zero resend, such as Ollama Cloud DeepSeek.** Either the adapter does not send old
  reasoning, or the server's template drops it before tokenizing. Either way, removing it
  changes neither the provider's input tokens nor its prompt cache; the measured slope is
  0.004. Counting such a route by its text estimate can only remove reasoning sooner, which
  costs nothing there. So no capability table and no "no-op route" list is needed. A list would
  also contradict the report's warning that a zero result is about one adapter route, not a
  model brand: the same model on OpenRouter measured k=0.994. The cost is one log line and one
  frozen id per removed step.
- **No count, but text.** Estimate the step's own kept plaintext with frozen calibration. Where the true resend is about 1×
  (local Qwen measured 0.73–1.04), the estimate is about right. Where it is unknown (GLM), the
  estimate is the best available, and it errs toward removing reasoning that is actually resent.
- **No count and no text (opaque).** A fixed 1,000 tokens per step, so these steps still use up
  budget. Counting them as 0 would recreate the 2.99 MB GPT-6.1-sol subagent: 609 encrypted
  reasoning items survived because MC counted none of them
  (`reasoning-removal-all-providers-design.md`).
- **Gemini signature routes.** Removability is unchanged. OpenRouter Gemini details still make
  a message ineligible, and native Gemini signatures stay on the tool part. Such steps count
  toward the budget, so the budget can push removal onto other, removable steps sooner. That
  is correct: their cost is real.

## 6. TS, Pi and Rust parity

| Concern | TS (OpenCode 1 and 2) | Pi / OMP | Rust module |
|---|---|---|---|
| Cutoff function | New pure `reasoningBudgetCutoff` in core `hooks/magic-context/reasoning-budget.ts` | Imports the same core function | `reasoning_budget_cutoff` next to `tag_age_cutoff`, which it replaces (`transform.rs:13149`) |
| Step cost | `info.tokens.reasoning`, then the step's kept-plaintext estimate, then 1,000 | `usage.reasoning`, then thinking text tokenized on the pass, then 1,000 | OpenCode leg: `native_messages[].info.tokens.reasoning`, then thinking text via `mc_tokenizer::estimate_tokens`, then 1,000; CC leg: thinking-text estimate |
| Where the cutoff replaces age | `selectReasoningRemovals` (arg), `clearOldReasoning`, `stripInlineThinking`, the watermark write at `transform-postprocess-phase.ts:2670`, `compartment-trigger.ts:250` | `piReasoningClearCutoff`, `piPrefixBoundReasoningCutoff`, `clearOldReasoningPi`, `stripInlineThinkingPi`, `applyNativeReasoningReplayPi` (`:124`), historian trigger inputs (`context-handler.ts:5005`) | `opencode_reasoning_removal_mids`, `reasoning_clear_cutoff_with_tags`, CC `cc_reasoning_cutoff` |
| Config plumbing | `hook.ts:733`, `transform.ts:451`, `rust-mode-transform.ts:1632/3107/3326`, `v2/hooks/context.ts:1485` | `index.ts:1120/1550`, `context-handler.ts:537` constant removed | `TransformRequest.keep_reasoning_tokens_effective`, module config |
| Bust gate | `routineCleanupApplied` | execute pass | `is_bust_pass` |

Known asymmetries are kept, not widened. Rust still skips OpenRouter-shaped messages that TS
can strip. The Claude Code leg still removes no reasoning on prefix-bound models: today
`reasoning_clear_cutoff_with_tags` returns `None` for them, and no `reasoning_age` lane runs
there. Both stay as they are. The budget changes the cutoff only where a lane already runs.

The Rust processed-image lane previously reused the reasoning-age cutoff even though TS and
Pi use the highest dropped-tag watermark. Image retirement is now explicitly independent of
both reasoning settings and uses that shared rule: an answered large image at or below a
positive dropped-tag watermark is selected only on a rebuilding pass. Existing frozen image
decisions replay unchanged. Legacy Rust sessions, including non-default `clear_reasoning_age`
overrides, adopt the TS rule for new image decisions on their next rebuild; no migration runs.

The historian trigger's projection must call the same cutoff function with the same costs as
the transform on that pass. Otherwise the trigger predicts a reclaim the transform will not
perform. Where only the DB is available (Pi DB path, cold start), it uses the tag estimates;
that is a projection, so the mismatch is tolerable.

## 7. Tests that would prove it

**Shared golden** (`crates/mc-module/testdata/reasoning-budget-trim.json`, read by
`reasoning-removal.test.ts`, `reasoning-replay-pi.test.ts` and `reasoning_clear_tests.rs`). Each
case is `steps` with per-step `reported`/`text`/`opaque` costs, `untagged`, `already_removed`,
`prefix_bound`, `budget` and the expected `removed_after`. Cases:

1. Budget at least the total: nothing removed.
2. Budget 0: every eligible step except the newest and the exempt one.
3. The cut lands mid-step: that whole step goes (no partial step).
4. The newest step alone is larger than the budget: everything older goes, and the newest stays.
5. Prefix-bound, with an untagged step inside the over-budget range: removal stops there, with
   no gap.
6. Already-removed steps are skipped, count 0, and are never restored.
7. Cost precedence: a positive `reported` beats text; `reported` 0 with text uses text; opaque
   with neither uses 1,000.
8. Raising the budget after a removal: `removed_after` equals `already_removed`.
9. Equivalence anchor: an existing age-based case rewritten with costs that make the budget
   cutoff equal the old age cutoff gives the same `removed_after`. This keeps the lane rules
   pinned while only the cutoff source changes.

**Cache invariants** (TS `transform-cache-busting-signals.test.ts` style, a Pi
`context-handler` test, Rust `transform` tests):

- **Defer byte identity.** A session over budget runs pass A (defer), then B (bust), then C
  (defer), then D (defer). Assert that A serializes identically to its predecessor (no removal),
  that B removes the expected ids, and that C and D serialize byte-identical to B for every
  message B served. Non-vacuity proof: make selection run on defer passes; the A assertion must
  go red, and only that test.
- **No originated bust.** A session over budget below every bust trigger: N passes, zero priced
  busts, and no new ids persisted.
- **Persist-before-apply.** If the id write fails, the pass serves only the old set (existing
  test, re-pointed at the budget cutoff).

**Signed-thinking 400 class:**

- A property test over random prefix-bound sessions (random costs, untagged steps,
  binding-strip sets, budgets): after the pass, no assistant whose thinking is still on the wire
  comes before an assistant whose thinking was removed (`assertNoThinkingGap`). Non-vacuity
  proof: turn the prefix walk's `break` into `continue`, and the property must fail.
- On the serialized wire for canonical Anthropic and Bedrock/Vertex fixtures: no part with a
  `signature`, `redacted_thinking` data or `reasoningEncryptedContent` carries `[cleared]`, and
  no signed part has rewritten text (#22050).
- Live acceptance: switch the e2e live-provider Anthropic scenario
  (`packages/e2e-tests/src/live-providers/scenarios/anthropic.ts`, which uses
  `clear_reasoning_age` today) to a small `keep_reasoning_tokens` on Opus 5.5. Drive two busts
  that each cut a prefix, and assert HTTP 200 with `input_transformations: []`, as in
  `reasoning-removal-live-acceptance.md`.

**Trailing blanks (#16284):** an assistant with an established `strip` decision, and another
with `keep:2`, both have their reasoning removed by the budget on a bust. On that pass and on
every later defer pass, assert that the decisions are unchanged and the served bytes are
identical.

**Config and migration:** the schema accepts a number and a per-model object, and rejects
negatives. `clear_reasoning_age` is ignored with the warning on OpenCode and Pi. Doctor removes
the key, printing the low-value hint when the value was below 50. The Rust module parses an old
request carrying only `clear_reasoning_age` and derives the budget itself.

**Status:** `/ctx-status` renders `reported`, `estimated` and both overrun labels.

## Open questions, with recommendations

1. **One knob, or none?** With a token budget, a model's verbosity no longer needs a per-model
   override. *Recommendation:* keep exactly one
   optional knob with the per-model shape. It replaces `clear_reasoning_age` one for one, the
   issue asks for per-model control, the resolver already exists, and it gives an escape hatch
   (`0` for privacy or maximum savings, a large value to keep everything). The fallback is to
   ship with no knob and add one on demand.
2. **Default sizing.** Settled: fixed 10,000 tokens. Run the offline replay in §3 and report
   the comparison with age 50; changing the default requires a separate user decision.
3. **Count Gemini at 1.25×?** *Recommendation:* no. The resend report's 1.218 is for the
   replay bundle, and the signature sits on the tool part that stays, so 1.25× would remove more
   reasoning text without removing the signature cost. Revisit after a wire A/B on Gemini shows
   what removing the reasoning part actually saves.
4. **The opaque-step constant.** *Recommendation:* 1,000 tokens, which sits between the
   measured p50s of 73–1,067 on the GPT and Claude routes. A later refinement could use the
   session's median reported R for the same model. Do not size it from encrypted byte length.
5. **A low-water mark** (cut to, say, 75% of budget so that busts remove in larger, rarer
   chunks)? *Recommendation:* no. Removal only rides busts that are already paid for, so cutting
   exactly to the budget costs no extra busts and keeps more reasoning.
6. **The Claude Code leg.** It reports no reasoning split, summarised Claude thinking text
   undercounts by about 2×, and it removes no reasoning on prefix-bound models today.
   *Recommendation:* use the text estimate unscaled, label the status `(estimated)`, and leave
   prefix-bound removal on Claude Code out of scope. It is a new lane with its own binding
   risks.
7. **Protect the whole current Anthropic turn.** Settled: the budget never selects reasoning after the last real user request, in any session. This can exceed the budget during a long active turn. Only budget first-selection uses this boundary here; fresh merged/proactive stripping policy remains owned by the parallel active-turn change. Absorbing replay of already-frozen removals is never withheld.
8. **Let the force band remove below the budget?** *Recommendation:* not in v1. The emergency
   planner reclaims tool outputs by need, and reasoning reaches its budget on that same bust
   anyway.
9. **The schema range.** The brief describes `clear_reasoning_age` as 10–200, but the code has
   only `min(10)`. This does not matter once the key is deprecated; it is recorded here so the
   deprecation note does not repeat the wrong range.

## Draft reply for issue 620

> Thanks for this. You're right that a count of tags is the wrong unit. One reasoning block can
> be 50 tokens or 20,000, so "the last 50" can quietly fill most of the window on a model that
> thinks a lot.
>
> We measured how much old reasoning actually costs when it's sent back. On Anthropic,
> OpenAI/Codex, OpenRouter DeepSeek and Grok, each reasoning token the provider reports costs
> about one input token on every later request. Some routes send nothing back at all: DeepSeek
> V4.1 Flash on Ollama Cloud showed no cost, while the same model through OpenRouter cost the
> full amount. So it depends on the route, not just the model.
>
> The plan:
>
> - `clear_reasoning_age` is replaced by `keep_reasoning_tokens`, a token budget for the
>   reasoning Magic Context keeps in the prompt. Selection keeps whole steps newest first;
>   the first non-fitting step and everything older form the removed prefix.
> - It's measured with the provider's own reasoning count where one is reported. Otherwise
>   it's estimated from the reasoning text, and encrypted reasoning with no count is charged a
>   fixed amount so it can't pile up unseen.
> - When you don't set it, the default is 10,000 tokens on every model. Heavy thinkers keep
>   fewer recent blocks; a step is never partly trimmed.
> - Like your suggestion, it accepts a number or a per-model object, the same way `cache_ttl`
>   and `output_reserve` do, for example `{ "default": 20000, "your/flash-model": 6000 }`.
> - Removal still only happens when the cache is being rebuilt anyway, so it never costs an
>   extra cache miss. On Claude models it only ever trims from the oldest end, which the API
>   requires.
> - `clear_reasoning_age` will be ignored with a warning, and `doctor` removes it.
>
> We'll post here when it ships.
