## Output

Output valid XML only in this shape:

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
