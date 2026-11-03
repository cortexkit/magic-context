### `trajectory_correction`

A **direction-change moment with discarded prior investment**: a strategy that had real work behind it was abandoned, an approach that had been pursued was reversed, a design decision that had shipped was undone.

The decisive test:
> Did this represent a meaningful change in direction, with discarded work or fundamentally re-shaped strategy? Would a reader of the compartment narrative alone miss the significance of the pivot?

**Yes → emit a `trajectory_correction`.** Examples:
- "Spent two days hand-rolling a positional line diff for the benchmark; user pointed out the `similar` crate already does this; replaced the implementation" — real discarded investment
- "Built the historian to use a single batched call; benchmarks showed two-pass produces better quality on weaker models; rebuilt as two-pass" — strategy change with new direction
- "Released v0.20 with `auto_promote` config flag; on user feedback the flag turned out to be coherence-breaking; removed in v0.21 with migration" — shipped decision reversed

**No → it's mid-discussion refinement.** Do NOT emit an event. The compartment narrative captures it. Examples that should NOT produce events:
- "Considered dropping aft_lsp_diagnostics, then decided to keep and hoist instead" — single-discussion refinement, no shipped work was undone
- "Initially planned to use threshold=0.85, then settled on 0.82 after reviewing more cases" — refining a parameter inside one decision, not pivoting away from one
- "User asked 'what if we keep it alive permanently?' and we changed the timeout from 5min to Infinity" — single-utterance redirection, no abandoned prior approach
- "Started designing X, realized Y is a better framing partway through, finished as Y" — converged design, not abandoned strategy

Required fields:
- `summary` — one-line description
- `before_strategy` — what was being done (must reference concrete prior work, not just "we were thinking about X")
- `correction_source` — enum: `⟦profile:trajectory_correction.correction_source⟧`
- `correction_signal` — quote or tight paraphrase of the trigger
- `after_strategy` — new direction
- `evidence` — short quote or paraphrase from the raw chunk
- `at_compartment` — index of the compartment

Optional:
- `reason_for_change` — when the correction language is implicit
- `ord_span` — start-end ordinal range if narrower than the compartment

