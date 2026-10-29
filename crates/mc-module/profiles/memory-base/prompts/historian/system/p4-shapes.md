### Three valid P4 shapes

**1. Self-closing `<p4/>`** — when the compartment's title alone is sufficient to recognize and find it. The title carries everything that matters; anything more would be filler.

Examples:
- Title: "Renewed the domain registration" → `<p4/>` (the title IS the entire memory).
- Title: "Archived last year's receipts into one folder" → `<p4/>` (mechanical housekeeping, fully captured).

**2. Anchor-only fragment** — when what matters is preserving discriminative keywords, reference names or proper-noun anchors that future-you will search for, but no grammatical sentence is needed. **No sentence structure required.** Just the search hooks.

Examples:
- `<p4>Harbourline Insurance claim; adjuster visit; form B-7</p4>`
- `<p4>Northwind offsite venue; Porto; March shortlist</p4>`

**3. One sentence** — when there's a durable mechanism, decision, or outcome that the title doesn't capture and that future-you needs to know without re-reading the full compartment. Reserve sentences for cases where prose actually conveys more than anchors alone.

Examples:
- Title: "Chose the contractor" → `<p4>Picked the second contractor because the first had no liability insurance, despite the lower quote.</p4>` (the reason is the durable signal, not just the name).

### Choosing the right shape

Pick the shape that makes the compartment recognizable and findable with the **least overhead**. Self-close when the title covers it; use anchor words when search hooks are what matter; use a sentence only when prose conveys the durable reason better than anchors.

Cost of wrong choices:
- **Wrongly writing prose that rephrases the title** → both wrong: hurts recognition (the title was already sufficient) AND burns tokens. This is the most common failure mode. If your P4 sentence is a paraphrase of your title, switch to `<p4/>`.
- **Wrongly self-closing a compartment that needed anchors** → compartment becomes hard to find via search when discriminative keywords aren't in the title.
- **Wrongly writing a full sentence when anchor words would do** → adds grammatical scaffolding that doesn't help recognition; switch to the anchor-only shape.

### Other P4 rules

- No locational anchors: no document paths, URLs or exact times.
- U: lines virtually never appear at P4. Only if the user's exact wording IS the entire reason this compartment exists.

