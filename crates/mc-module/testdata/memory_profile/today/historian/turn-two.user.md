Turn two: check each candidate fact, then compare it with project memory.
allowed_fact_ids: [⟦fact.id⟧,⟦fact2.id⟧]

1. Return exactly one decision for each id in allowed_fact_ids, and no others. The bullet numbers and compartment numbers in your turn-one reply are not fact ids.
2. Check the fact first, using "What becomes a memory" in the system prompt. The whole chunk is above, in turn one's <new_messages>. Read the lines the fact cites and every line after them:
   - Is it stated in this chunk's new messages?
   - What settles it: a `U:` decision, a ruling the agent acted on, the agent's own verification or work that went live, or only a proposal to the user, a plan or another agent's agreement? Delivered, held for review or waiting for a window is not live.
   - Does a later line correct, reverse, measure or replace it, or call it an expectation or send it off to be checked?
   - Is it a hypothesis, an open question, a one-off step, a temporary rule or a value that changes on the next build? A rule that holds "until", "for now" or "for this window" is temporary, even when decided.
   - Would it still apply to the next, different task? A ruling that only governed this task, this worker or this incident is a one-off step, even when acted on.
   If any check fails, the action is `abstain`.
   If it is an accepted decision that isn't built and its text doesn't start with `Decided:`, it still passes: use `new` with `"decided": true`, or an edit whose `final_text` starts with `Decided:`.
3. Only a fact that passes is compared with memory. Its neighbouring memories are listed under it:
   - `covered`: a neighbour already says the same thing.
   - `edit` or `replaces`: a neighbour says something this fact updates or overturns.
   - `merge`: two or more neighbours and this fact belong in one memory.
   - `conflict`: it contradicts a neighbour, and the chunk doesn't settle which is right.
   - `new`: no neighbour covers it.
4. Write `check` before `action`. Example: `"check": "A proposes it at [410-412]; U accepts at [415]. Not built in this chunk; the text starts with Decided:. Passes."`
5. In `removed`, `replaced` and `added`, `block` is the start ordinal printed on one of that fact's source blocks, and `excerpt` is exact text from that block. Only that fact's neighbours are eligible targets.

Neighbour retrieval was lexical-only for this request (no usable stored embeddings); a fact with no neighbour listed may still duplicate an existing memory.
Coverage: this request is partial. 2 pending fact(s) and 1 agent memory item(s) were left out to fit the request size. They remain eligible for a later run, but no later request is guaranteed; judge only what is listed here.

## Fact ⟦fact.id⟧ (backlog) [⟦fact.category⟧] from session ⟦fact.sourceSessionId⟧
⟦fact.content⟧
Source block refs: source:⟦source.ref⟧
Neighbour refs:
memory:⟦neighbour.id⟧@⟦neighbour.revision⟧

## Fact ⟦fact2.id⟧ [⟦fact2.category⟧] from session ⟦fact2.sourceSessionId⟧
⟦fact2.content⟧
Source blocks: unknown (this fact cannot evidence an edit).
Neighbour refs:
- none retrieved

## Shared source blocks

### source:⟦source.ref⟧ (session ⟦fact.sourceSessionId⟧)
[⟦block.start⟧-⟦block.end⟧] ⟦block.role⟧: ⟦block.part1⟧ / ⟦block.part2⟧

## Shared neighbouring memories

### memory:⟦neighbour.id⟧@⟦neighbour.revision⟧
- #⟦neighbour.id⟧ rev ⟦neighbour.revision⟧ [⟦neighbour.category⟧]
  c1: ⟦neighbour.content⟧

## Agent memories to score

### Item ⟦item.number⟧ (memory #⟦item.memoryId⟧)
⟦item.content⟧
Excerpt:
⟦item.excerpt⟧