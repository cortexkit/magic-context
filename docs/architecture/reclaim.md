# Tagging and reclaim

Every piece of content Magic Context can remove is first given a durable tag, and every removal is decided once, persisted, and replayed byte-identically on later passes. This page covers how tags are identified, the lanes that remove tagged content (agent drops, age reclaim, smart drops, emergency drops, strips and caveman compression), and the rule they all share: a removal never causes a prompt-cache bust of its own.

Paths are relative to `packages/plugin/`. Pi mirrors most of these files with a `-pi` suffix in `packages/pi-plugin/src/`; the Rust module mirrors them in `crates/mc-module/src/`.

## Where the code is

- `src/hooks/magic-context/tag-messages.ts`, `src/features/magic-context/storage-tags.ts`: tagging and the `tags` table.
- `src/tools/ctx-reduce/tools.ts`: the agent's drop tool.
- `src/hooks/magic-context/apply-operations.ts`: applying queued drops, placeholders and skeletons.
- `src/features/magic-context/protection-window.ts`, `reclaim-protection.ts`: what automatic reclaim may not touch.
- `src/hooks/magic-context/tool-reclaim.ts`: age reclaim.
- `src/hooks/magic-context/supersession-reclaim.ts`, `edit-marker.ts`: smart drops.
- `src/hooks/magic-context/heuristic-cleanup.ts`, `emergency-drop.ts`: heuristic cleanup and the emergency tiers.
- `src/hooks/magic-context/tool-drop-target.ts`, `dropped-input-guard.ts`: which tool parts can be dropped, and the guard against replaying dropped arguments.
- `src/hooks/magic-context/strip-content.ts`, `sentinel.ts`, `drop-stale-reduce-calls.ts`: strip-and-replay.
- `src/hooks/magic-context/caveman.ts`, `caveman-cleanup.ts`: caveman compression.
- `src/hooks/magic-context/transform-postprocess-phase.ts`: the mutation gates that decide when any of this may first apply.

## When removals may happen

`ARCHITECTURE.md` (the protected section on transform pass mechanics) defines the rule every lane on this page follows: automatic reclaim only rides a pass that is already busting the cached prefix (an execute pass, a HARD fold, `/ctx-flush`, or the force band), and every lane consults the same per-pass bust permission. A lane that could first-apply on a defer pass would change tail bytes and bust everything after them. Read that section first; this page assumes it.

## Tags and tag identity

Each row in `tags` is one taggable unit of source content, of type `message`, `file` or `tool`, with a per-session `tag_number` that the agent sees as `§N§`. The original content is kept in `source_contents`, which is what `ctx_expand` and every replay read.

- `message` and `file` tags key on `(session_id, message_id)`, where the message id is a synthetic content id for the part.
- `tool` tags key on `(session_id, callID, tool_owner_message_id)`. OpenCode reuses call ids across assistant turns, so the owning assistant message is part of the key. An invocation part owns itself; a result part takes the oldest unpaired invocation; a result whose invocation was compacted away falls back to the nearest earlier persisted owner. The drop queue and heuristic cleanup use the same composite key.

Token counts (`token_count`, `input_token_count`, `reasoning_token_count`) are computed once when a tag is inserted and summed later for the sidebar, boundary and nudge arithmetic, so those paths never re-tokenize.

A tag's `status` is `active`, `dropped` or `compacted` (content from before a compaction boundary). A dropped tag's `drop_mode` records how it was removed, and replay reproduces exactly that shape.

## The protected window

Automatic reclaim never touches the newest part of the conversation. `protection-window.ts` computes the protected set in tag-number space from `protected_tokens`, whose default is `clamp(round(0.05 × usableSoft), min(16,000, round(0.08 × usableSoft)), 64,000)` (`deriveDefaultProtectedTokens`). Separately, `reclaim-protection.ts` keeps the newest three `ctx_reduce` calls (`CTX_REDUCE_KEEP`) in every lane, so the agent always has recent examples of the tool.

## Agent drops (`ctx_reduce`)

`ctx_reduce` takes tag ids and ranges (`"3-5"`, `"1,2,9"`) and only queues them: each id becomes a `drop` row in `pending_ops`. Ids already dropped or queued are skipped; content from before compaction is refused. Ids inside the protected window are accepted but reported as held, and apply once newer work pushes them out. Queued drops are applied on the next pass that is busting anyway, never on their own.

`apply-operations.ts` applies them:

- A dropped message part becomes `[dropped §N§]`. This is the only drop placeholder, and it is a pure function of the tag number; nothing derives placeholder bytes from the current (possibly already mutated) content, because a placeholder that differed between passes would bust the cache.
- A dropped tool call's arguments are either **real or absent**: they are served exactly as the host gave them, or the whole call is removed. Nothing is ever written into the argument position. Among the newest 20 tool calls (`RECENT_TOOL_SKELETON_WINDOW`), a call with a small input keeps a skeleton (`drop_mode = skeleton_real`): the call stays with its real arguments and only its output becomes the placeholder. A call with a large input is removed with its result (`full`), exactly like an older drop. "Small" means the total UTF-8 byte length of every string value in the input, recursively through objects and arrays, is at most 1024 (`tool-input-size.ts`; keys, numbers, booleans and nulls do not count, so every lane computes the same number; the shared fixture is `tests/fixtures/tool-input-string-bytes.json`). The one exception: the tool result that ends the request is never removed (models without assistant prefill reject a request that ends on an assistant turn), so that call is kept, with its real arguments, even when its input is large. The same holds for a call beside signed reasoning and for a call the host adapter cannot remove. The mode is decided once at drop time and never re-decided: a skeleton is never demoted and a removed call is never restored.
- Why real or absent: every synthetic value placed in the argument position was copied back into new tool calls by models. Until September 8 string values were clamped to 5 characters plus `...[truncated]`, and copied clamps ran as real calls (a bash `whic...[truncated]`, a file written at `/tmp/...[truncated]`, 5-character memory writes). From September 8 the input became the marker `{"dropped": "[dropped §N§]"}`, and models copied the marker and looped on the guard's refusal (one worker made 68 refused calls in a row). Removing every recent call instead (June) made models write fake tool calls as plain text, which is why the newest-20 skeleton window exists.
- Sessions that already serve the old marker (`drop_mode = truncated`) keep replaying it byte-identically until a pass whose HARD fold executes **and** loses the provider's cached prefix anyway: the fold's trigger evicts it (a model or provider change, a changed system prompt, an idle TTL expiry; in Rust also a serializer profile switch or a moved coverage boundary), or the fold changes the m[0]/m[1] (and mural) bytes it serves. On that pass each such tag is re-decided under the rule above from its real input and the new mode is persisted with the fold (OpenCode: inside the fold's transaction; Pi: in its own transaction right after tagging on that pass; Rust: as part of the HARD rebuild of the frozen unit set). A HARD that re-renders the prefix byte-identically, such as a memory epoch bump with no content change, keeps the cache, so it does not convert: the conversion would otherwise be the only byte change and would bust the cache from the first converted call on. No bust is ever forced for the conversion.
- The conversion is per lane. Rust converts its own frozen reduction units but does not write the new mode back to the `context.db` tag rows, so a session that goes TS → Rust → TS serves the old marker again in TS until TS's own qualifying HARD fold converts it. This costs no extra bust, because switching lanes already changes the served bytes (Rust renders a dropped result as `[dropped]`, TS as `[dropped §N§]`). `full` tags that a host adapter could not remove structurally (Pi), and so replay a marker, convert the same way.
- Tool drops outside the window, heuristic dedup and smart drops keep their existing modes.
- Only completed tool arcs can be dropped (`partHasCompletedResult` in `tool-drop-target.ts`): a call whose result is still pending or running is never touched, while an errored call counts as closed.

If the model copies a dropped marker back into a new tool call, `dropped-input-guard.ts` stops the call before it runs and returns an error that lists the real parameters and suggests `ctx_expand` to recover the original arguments. The guard stays because old-marker skeletons remain on the wire until a HARD fold converts them, and older sessions may still carry clamped values. A copied real-argument call passes it.

## Age reclaim

Age reclaim drops old tool outputs without the agent asking, in two steps so it never surprises a pass (`tool-reclaim.ts`). On one application opportunity it records `tool_reclaim_watermark` as the current newest tag number. On a later opportunity it queues synthetic drops for active tool tags at or below that watermark that sit outside the protected window, are worth at least 250 tokens (`AGE_RECLAIM_MIN_TOKENS`), are not the newest `todowrite`, and are not already queued. The watermark only advances on a pass that could actually apply, so a long run of plain execute passes does not age everything at once.

## Smart drops

Supersession always adds content-aware reclaim on busting passes (`supersession-reclaim.ts`); the deprecated `smart_drops` key is ignored:

- **Spent control-plane outputs**: all but the newest `todowrite`, `ctx_reduce` calls beyond the protected three, zero-value meta calls (`bash_status`, `bash_kill`), and `ctx_note` read and dismiss calls.
- **Superseded edits**: an `edit` or `write` to a file that has been edited again later is compressed to `edit_marker` mode (`edit-marker.ts`), which keeps the file path verbatim and the first 40 characters of the change as a region hint and replaces the output with the placeholder. The newest edit per file stays whole, so the model still knows which files and regions it touched.

Supersession ignores tool calls owned by the newest 20 distinct messages (`SUPERSESSION_RECENT_MESSAGE_WINDOW`), derived from persisted tag order so the protection does not shift when the provider-visible array contracts and re-expands.

All automatic lanes also honour `protected_tools`, a user/project map merged over `{todowrite: 1, ctx_reduce: 3}`. A shared active-population snapshot protects each tool's newest N tag ordinals, with case-insensitive and leading-`mcp_` matching. This protection holds at 95%, unlike the token window and tier reserve, and applies to edit markers and dedup too. Queued drops from the agent or historian publication are held by that same set until newer calls displace the result and a rebuilding pass applies the drop. The historian's summary is unaffected and the raw result leaves at the next fold. Frozen strips remain independent. Map changes and rotation never originate a bust or restore dropped results.

## Heuristic cleanup and emergency drops

`heuristic-cleanup.ts` runs on busting passes: once per user turn for primary sessions, on every execute pass for subagents (a subagent run is effectively one long parent turn). It deduplicates repeated read-only tool results (keeping the newest in full), strips injected system content, and runs caveman compression when enabled.

At the force band (`max(85%, execute threshold + 2%)`, so 92% at the highest allowed threshold of 90%), heuristic cleanup also runs the emergency drop (`emergency-drop.ts`), which removes tool outputs by need instead of by position:

- The target is `fixedFloor + 0.30 × (ceiling − fixedFloor)`: reclaim down to about 30% of working space.
- Tools are dropped oldest first by tier: tier 3 (everything else, such as `bash`) before tier 2 (`edit`, `write`, `apply_patch`, `grep`, `glob`, `aft_search`) before tier 1 (`read`, `todowrite`, `task`, `aft_outline`, `aft_zoom`). The newest 20% of tier 1 and tier 2 are held back as continuation context.
- A computed reclaim of 2,000 tokens or less is not worth a bust and does nothing.
- Emergency drops use the same newest-20 real-or-absent rule as agent drops.
- One continuous stay in the force band gets one non-empty emergency batch. The latch (`last_emergency_input_sample`) re-arms when usage leaves the band, or when another provider-visible mutation is already busting the prefix, so accumulated candidates share one rewrite. Heuristic cleanup, dedup, caveman and reasoning clearing follow the same episode rule.
- At 95% or more (provider-proven or estimated), selection also gives up the protected window and the tier reserve, fully removing selected completed arcs while keeping open arcs and the three newest `ctx_reduce` calls. Tool arcs next to signed reasoning keep a paired skeleton (`requiresToolArcSkeleton`) so the provider does not merge signed assistant turns. Subagents, and primary sessions on models that cannot end on an assistant turn, keep skeletons where removing an arc would leave the request without a final tool result.

## Strip and replay

Some mutations are not drops but strips of content the provider does not need (`strip-content.ts`): reasoning beyond `keep_reasoning_tokens` (fixed default 10,000), structural noise, stale placeholders, processed images, merged-assistant reasoning, stale `ctx_reduce` calls (`drop-stale-reduce-calls.ts`) and injected system messages. Each strip is a stateless function plus persisted state. The pattern is **detect and freeze on a busting pass, replay on every pass**: the affected ids are recorded in `session_meta` (for example `stripped_placeholder_ids`, `stale_reduce_stripped_ids`, `processed_image_stripped_ids`, `merged_reasoning_stripped_ids`) and every later pass, defer passes included, re-applies exactly that set. Frozen sets are bounded and entries are removed when their message is removed.

Emptied content is provider-aware (`sentinel.ts`): providers that accept empty parts get an empty sentinel, others get a placeholder, because some providers break tool adjacency on empty parts. `variantChangeBustsProviderCache` decides whether a reasoning-effort change is itself a cache bust worth flushing queued work into.

## Caveman compression

`caveman_text_compression` (opt-in, primary sessions only, never subagents) compresses old long user and assistant text deterministically (`caveman.ts`: dropping filler, hedging, pleasantries, articles and auxiliaries, with `lite`, `full` and `ultra` levels, while preserving code, paths and similar regions). Eligible tags outside the protected window are bucketed by age: the oldest 20% go to `ultra`, the next 20% to `full`, the next 20% to `lite`, and the newest 40% stay untouched (`caveman-cleanup.ts`).

Only busting passes may increase a tag's `caveman_depth`; every pass replays the persisted depth. Compression is always computed from the pristine text in `source_contents`, never from an already-compressed intermediate, so any depth change converges to the same bytes as compressing directly.
