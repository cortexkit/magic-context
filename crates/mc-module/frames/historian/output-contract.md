## Output

Reply with exactly one JSON object under a `result` wrapper. Its `step` must match the current turn. Don't emit bare XML or an unwrapped decisions object.

- Turn one: `{"result":{"step":"turn_one","xml":"..."}}`. The `xml` string contains the complete XML document below, with JSON string escaping.
- Turn two: `{"result":{"step":"turn_two","decisions":[...],"scores":[...]}}`. Check each candidate fact, then compare it with project memory. Don't write compartments on turn two. On turn two only "What becomes a memory", the ⟦profile:fact-category-count⟧ categories and the fields below apply. The rules for compartments, tiers, U: lines, events, observations and primers are for turn one.

### Turn-two fields

One decision per `fact_id`. Actions: `new`, `covered`, `conflict`, `edit`, `merge`, `replaces`, `abstain`. Do not retire memories or promote rules.

- Every decision requires integer `fact_id`, string `check` and string `action`. Write `check` first: one or two short sentences naming the line that states the fact and the line that settles it, by ordinal, and why it passes or fails "What becomes a memory".
- `new`, `edit`, `replaces` and `merge` take an optional string `expires`: the calendar date (`YYYY-MM-DD`) the memory stops holding, only when its text states that date as its end. Never give one for a rule that ends on an event or holds "for now".
- `new` and `abstain` need no other fields. `new` takes an optional boolean `decided`: set it to `true` when the fact is an accepted decision that isn't built and its text doesn't start with `Decided:`, and the stored memory gets that prefix. Never use it for anything else.
- `conflict` requires integer `target_id`.
- `covered` requires integer `target_id`, integer `revision` and a nonempty `clauses` array of integer clause indices; string `excerpt` is optional.
- `edit` and `replaces` require integer `target_id`, integer `revision`, arrays `kept` and string `final_text`; arrays `removed`, `replaced` and `added` are optional (absent means empty).
- `merge` requires `sources` (at least two objects with integer `id` and `revision`), integer `survivor_id`, arrays `kept` and string `final_text`; arrays `removed`, `replaced` and `added` are optional (absent means empty).
- Each `kept` entry is an object with integer `memory_id` and integer `clause`, for example `{"memory_id": 812, "clause": 1}`. Each `removed` or `replaced` entry adds integer `block` and string `excerpt` to those two. Each `added` entry has string `text`, integer `block` and string `excerpt`.
- `memory_id` and `clause` name a neighbour memory and its clause number (`c1` is clause 1). `block` is the start ordinal printed at the beginning of one of this fact's source blocks (the `N` in `[N]` or `[N-M]`), never a memory's number. `excerpt` is exact text from that source block that justifies the change.
- `scores` is optional; absent means empty. Each score requires integer `item`, integer `importance` from 1 to 100, and `class`, a free nonempty string of at most 64 characters proposing a decay class. There is no decay-class taxonomy.

### Turn-one XML document

The following XML shape and rules apply to the `xml` string on turn one only:

Closing tags must match their opening tier tag (e.g. `<p1>...</p1>`, never `<p1>...</p2>`).

```xml
<output>
<compartments>
<compartment start="FIRST" end="LAST" title="short title" episode_type="..." importance="N">
<p1>
[Most verbose paraphrase. Includes U: lines verbatim, inline at their conversation point, full anchors, full narrative.]
</p1>
<p2>
[Condensed. Canonical anchors only. U: lines only when wording IS the constraint, still inline.]
</p2>
<p3>
[Outcome + key decision. Architectural names. U: lines virtually never.]
</p3>
<p4>Self-close, anchor-only fragment (discriminative keywords / commit hashes / version numbers), or one sentence — pick the shape that makes this compartment recognizable with least overhead. See P4 section.</p4>
</compartment>
</compartments>
⟦if fact_categories⟧<facts>
⟦profile:fact-shape-blocks⟧
⟦if fact_categories⟧</facts>
⟦if event_kinds⟧<events>
⟦profile:event-shape-blocks⟧
⟦if event_kinds⟧</events>
⟦if user_categories⟧<user_observations>
⟦profile:user-observation-shape-blocks⟧
⟦if user_categories⟧</user_observations>
⟦if primer_candidates⟧<primer_candidates>
⟦if primer_candidates⟧<primer at_compartment="1">How does subsystem X work?</primer>
⟦if primer_candidates⟧</primer_candidates>
<meta>
<messages_processed>FIRST-LAST</messages_processed>
<unprocessed_from>INDEX</unprocessed_from>
</meta>
</output>
```

Rules:
⟦if fact_categories⟧- Omit empty fact categories.
⟦if event_kinds⟧- Omit `<events>` section entirely if no events were extracted (this is the normal case for most compartments).
⟦if user_categories⟧- Omit `<user_observations>` section entirely if no observations were extracted.
⟦if primer_candidates⟧- Omit `<primer_candidates>` section entirely if no primer candidates were extracted.
- Compartments must be ordered, contiguous for the ranges they cover, and non-overlapping.
- All four `<p1>`/`<p2>`/`<p3>`/`<p4>` elements must appear in every compartment, in that order. P4 may be self-closed, an anchor-only fragment, or one sentence depending on what makes the compartment recognizable (see P4 section).
- `episode_type` may be a single activity or a comma-separated list of activities the compartment spans (e.g. `episode_type="design,feature,release"`). Multiple activities do not split a compartment — they describe one arc that touched multiple activity types.
- `importance` attribute is required on every compartment.
