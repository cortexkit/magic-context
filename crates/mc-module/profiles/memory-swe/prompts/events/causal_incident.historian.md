### `causal_incident`

A **constraint of an external system** that was discovered through cost in this session, and that future sessions in this project will benefit from knowing about because the same constraint will still apply.

The decisive test:
> If this discovery were forgotten, would a future session in this project hit the same surprise again? Is the surprise about something we don't control (an external SDK, host platform, model behavior, undocumented protocol)?

**Yes → emit a `causal_incident`.** Examples:
- "OpenCode's `fromPlugin` wrapper hardcodes `title: ""` and overwrites plugin metadata" — durable SDK constraint, future plugin work will encounter it
- "Anthropic SDK merges consecutive assistant messages, breaking reasoning preservation" — durable provider quirk
- "GPT-5.5 returns empty `content` when reasoning tokens hit, even with valid output" — durable model behavior
- "OpenCode caches plugin install via `node_modules/.bin` but won't refresh without a clean tarball install" — durable host behavior

**No → it's a routine bug fix.** Do NOT emit an event. The compartment narrative is sufficient. Examples that should NOT produce events:
- "Found a relative-path-vs-absolute-path bug in our own undo command, fixed it" — once fixed, the bug is gone; nobody will hit it again
- "TypeScript build failed because of a typo, corrected it" — routine
- "Test count changed from 589 to 603 after adding tests" — that's a measurement update, not a discovered constraint
- "Adjusted a default timeout from 5 minutes to Infinity" — that's a design refinement, not a discovered external constraint

Required fields:
- `summary` — one-line description
- `affected_surface` — enum: `⟦profile:causal_incident.affected_surface⟧`
- `symptom` — observed failure or surprise
- `cause_summary` — causal mechanism, or "unknown_but_bounded"
- `disposition` — enum: `⟦profile:causal_incident.disposition⟧`
- `evidence` — short quote or paraphrase proving the signal from the raw chunk
- `at_compartment` — index of the compartment in this output (1-based)

Optional:
- `fix_summary` — what was changed (when disposition is fixed or workaround)
- `model_or_provider_involved` — if relevant
- `ord_span` — start-end ordinal range if narrower than the compartment
- `produced_fact` — when this incident also produced a `CONSTRAINTS` fact in this output, that fact's exact text, so the constraint keeps this incident as its evidence

