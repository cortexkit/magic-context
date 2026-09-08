---
duration: 84
width: 1920
height: 1080
fps: 30
music: none
---

# The life of a Magic Context session

A silent, caption-led explainer. All times below are seconds. The context-window bar remains in the same place for the whole film. Read each beat's headline, supporting copy, cards, status, and bottom caption together. Copy below is verbatim; code formatting denotes monospace on screen, not additional spoken words.

## Video direction

Dark ground, neutral system instructions, amber project memory, violet history, cyan live work. Tool output uses cyan stripes; settled conversation uses a darker cyan. No camera cuts or stock footage. Large type, 120 px safe margins, a consistent bottom caption band. New blocks enter gently; reductions compress; rewrites flash a single outline. A thin bottom progress rule indicates elapsed video time, not context usage.

Sizes are illustrative rather than measured telemetry. The first threshold landing reproduces the docs' 200k example: fixed + memory 6%, history 6%, settled conversation 24%, recent work 14%, tool output 20% before; fixed + memory 6%, history 9.5%, recent work 14%, tool output 15.5% after = 45%. Splitting fixed + memory evenly is a visual convention, not a product budget. The later ~60% landing is the supplied brief's illustrative continuation, not another default.

## Persistent text · 0–84

- Magic Context
- One session, from first turn to hours later
- System instructions
- Project memory
- History
- Live conversation + tool output
- execute threshold (default 65%)
- Context window · illustrative sizes

The execute line sits at 65% of the usable bar. The bracket below the left side tracks the materialized prefix. There are no other numeric axis labels or continuously changing percentage counters.

## 1. Fresh session · 0–10

**Motion:** System and memory begin small. At 2, 5, and 8, the live tail grows and corresponding tagged cards enter. The same bar is used throughout, not replaced with a new chart.

**Headline:** Your session starts small.

**Supporting copy:** System instructions and project memory are already here. Your conversation grows turn by turn.

**Status:** Stable prefix → new turns append on the right

**Cards:**

- From 2: `§3§ Tool output` / Project files and search results / The agent reads and moves on.
- From 5: `§5§ Tool output` / Build log and test results / The agent finishes using them.
- From 8: `§8§ Tool output` / Current working detail / Recent work stays available.

**Bottom caption:** Tool outputs arrive as tagged blocks. The tags let your agent refer to them later.

## 2. The agent tidies · 10–20

**Motion:** The same tagged cards remain. The queue is announced first. At 16 an eligible cache-rebuilding pass flashes the bar outline; the first two cards compress to small placeholders and the cyan bar shrinks a little. The third card remains intact. This explicitly avoids depicting `ctx_reduce` as immediate deletion.

**Headline:** Your agent marks spent output.

**Supporting copy:** `ctx_reduce` queues drops. The blocks shrink when a cache-rebuilding pass applies them.

**Status, 10–16:** `ctx_reduce(drop="3,5")` · queued, not immediate

**Status, 16–20:** Cache-rebuilding pass · priced rewrite → stable again

**Cards:** The three cards from beat 1 persist until the pass. The first two raw cards fade at 16 and are replaced from 16.5 by `[dropped §3§]` and `[dropped §5§]`. The third card's text is unchanged.

**Bottom caption:** The raw transcript stays in the local database. Nothing is lost.

## 3. History accumulates · 20–34

**Motion:** At 21 an older span is marked with darker cyan as settled. The background historian card enters at 22, then ready compartments at 25. At 28 a labeled history rebuild removes the raw settled span from the bar and inserts violet history. Tier lines shorten between 29.5 and 31.9 to visualize decay on rebuild, not continuous changes to a cached prefix.

**Headline, 20–28:** Older conversation becomes settled.

**Supporting copy, 20–28:** The historian works in the background. It folds settled work into compartments: structured summaries.

**Status, 20–28:** Settled conversation → historian working → history ready

**Cards, 20–28:**

- Settled conversation / Earlier decisions and outcomes / No longer the current task
- Historian · background / Preserve the meaning. / Prepare structured summaries.
- Compartments ready / Keep the session’s story. / Replace the covered raw span.

**Headline, 28–34:** History stays in the prompt.

**Supporting copy, 28–34:** At a history rebuild, older compartments can render at shorter tiers.

**Status, 28–34:** History rebuild · priced rewrite → summaries replace the raw settled span

**Cards, 28–34:**

- Compartment tiers / Full → compressed → concise / → anchor-only title
- Older history, less detail / Age, importance, budget
- History budget · default 15% / Of context at the execute threshold, not the full window.

**Bottom caption, 20–34:** Compartments are history in the prompt, not dropped placeholders.

## 4. The execute threshold · 34–52

**Motion:** At 34.5 the same bar grows across the line. One simultaneous pass begins at 38: the settled span disappears, history grows, eligible output shrinks, and the total lands at 45%. The outline flashes once, not once per cleanup operation. Starting at 44.5 more recent work pushes the same session across the line again. At 49 the next single pass lands at ~60%; the outcome number only appears at that pass.

**Headline, 34–44:** The threshold triggers one execute pass.

**Supporting copy, 34–44:** Queued drops, eligible old tool output, and ready history are applied together.

**Status, 34–38:** Usage crosses the line · one execute pass is due

**Cards, 34–38:**

- `ctx_reduce` / Apply queued drops.
- Automatic reclaim / Remove eligible old tool output on this rebuilding pass.
- Ready history / Install compartments. / Keep recent work.

**Status, 38–44:** One execute pass · priced rewrite → stable at 45%

**Cards, 38–44:**

- After this pass / 45%
- More settled conversation can become history. / The retained pieces happen to total 45% of the window. / That is an outcome, not a setting.

**Headline, 44–52:** Later, the same session lands higher.

**Supporting copy, 44–52:** Recent work stays protected. Less of the window is ready to reclaim.

**Status, 44–49:** More turns arrive · the prefix stays frozen

**Status, 49–52:** One execute pass · priced rewrite → stable at ~60%

**Cards, 44–52:**

- After the next pass / ~60% (number appears at 49)
- More recent work must stay. / Less old output is eligible. This pass frees less room. / Same session. Same trigger. Different landing.

**Bottom caption, 34–52:** The threshold is a trigger, not a target. Where it lands depends on what was in the window.

## 5. Cache stability · 52–62

**Motion:** At 54 and 58, only the cyan tail grows. System, memory, and materialized history retain their positions and sizes. The previous passes' outline flashes are the priced rewrites; this beat does not add a gratuitous rewrite for effect.

**Headline:** Between passes, only the tail grows.

**Supporting copy:** The prefix — system instructions and materialized history — stays frozen / cached.

**Status:** Frozen / cached prefix → growing live tail

**Cards:**

- Frozen / cached / System + materialized history / The prefix stays byte-identical.
- Append / New messages and tool results / Only the live tail grows.
- Priced rewrite / A pass changes the prefix. / Due folds are batched together.

**Bottom caption:** Folds are batched so the cache is rebuilt once, not many times.

## 6. Recall · 62–75

**Motion:** The agent's question appears first. Search enters at 63, expansion at 66, and the illustrative raw exchange at 68. The tail grows for that one look. At 73 the raw exchange fades and its temporary tail addition recedes, without touching the prefix. The exchange is invented teaching copy, not a real user's transcript.

**Headline:** You can still retrieve the details.

**Supporting copy:** Your agent asks: “Why did we choose this approach earlier?”

**Status:** Recall adds detail to the live tail, not a rewrite of the prefix

**Cards:**

- `ctx_search` / Find the earlier decision in memories or compacted history.
- `ctx_expand` / Bring back the raw exchange for one look.
- Earlier exchange · raw / You: “Why this approach?” / Agent: “It keeps retries safe.”

**Bottom caption:** Compacted, not deleted. The raw transcript is still in the local database.

## 7. Close · 75–84

**Motion:** Time advances within this same session. Another labeled batched fold flashes at 76 and the tail settles; a final turn grows it slightly at 80. History, memory, and the live tail remain under the threshold through the final frame. Hold the closing message without a fade to black.

**Headline:** Hours later, you keep working.

**Supporting copy:** The same window holds history, memory, and the live tail.

**Status, 75–78:** Time passes · another batched fold · priced rewrite

**Status, 78–84:** History + memory + live tail · still under the line

**Cards:**

- History / Earlier work stays readable.
- Project memory / Durable knowledge stays useful.
- Live tail / Room for the next turn.

**Bottom caption:** Long sessions without a context wall. Cache-stable prompts. Nothing lost.

## Source and interpretation notes

- `execute_threshold_percentage`: default 65 in `packages/plugin/src/config/schema/magic-context.ts`.
- `history_budget_percentage`: default 0.15, with the threshold-relative denominator explained in `historian.mdx`. The violet segment never represents 15% of the entire window.
- `how-it-works.mdx`: session ordering, frozen prefix, batching, and the 45% worked example.
- `context-reduction.mdx`: queued rather than immediate drops; automatic reclaim is eligible on an already cache-rebuilding pass; recent work remains protected.
- `historian.mdx`: background historian; prompt-resident compartments; full, compressed, concise, anchor-only tiers; stored raw transcript.
- The 65% line is the default trigger, not a post-pass target or a hard maximum. Illustrative passes below it also have explicitly labeled cache-rebuild reasons.
- Timeline seconds, graphical segment splits, tag examples, and the invented recall exchange are authoring choices, not configuration claims.
