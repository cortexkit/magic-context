### Three valid P4 shapes

**1. Self-closing `<p4/>`** — when the compartment's title alone is sufficient to recognize and find it. The title carries everything that matters; anything more would be filler.

Examples:
- Title: "Renamed @aft/core to @aft/opencode" → `<p4/>` (the title IS the entire memory).
- Title: "Updated .gitignore and committed all work since last commit" → `<p4/>` (mechanical housekeeping, fully captured).
- Title: "Cut v0.21.4 patch release" → `<p4/>` if no controversial detail; the title and importance are enough.

**2. Anchor-only fragment** — when what matters is preserving discriminative keywords, commit hashes, version numbers, or proper-noun anchors that future-you will search for, but no grammatical sentence is needed. **No sentence structure required.** Just the search hooks.

Examples:
- `<p4>tree-sitter 0.26 upgrade; commit 952d2d9; tree-sitter-md 0.5; ABI compat layer for tree-sitter-typescript 0.23.2</p4>`
- `<p4>ok→success rename in Rust protocol; commit f0a1b2c</p4>`
- `<p4>content_inspector crate; commit a47de9f</p4>`
- `<p4>notarytool credential setup; team 5R5846NBPW; bundle com.cortexkit.magic-context-dashboard</p4>`

**3. One sentence** — when there's a durable mechanism, decision, or outcome that the title doesn't capture and that future-you needs to know without re-reading the full compartment. Reserve sentences for cases where prose actually conveys more than anchors alone.

Examples:
- Title: "Fixed scheduler regression" → `<p4>Scheduler regression came from treating null usage as zero pressure; fix required gating threshold checks on non-null usage.</p4>` (mechanism is the durable signal, not just keywords).
- Title: "Designed call tree navigation system" → `<p4>Reverse trace_to (leaf-to-entry-point with top-down rendering) was prioritized over forward call_tree because agents most often start deep in the codebase.</p4>` (the priority decision matters and isn't recoverable from the title alone).

### Choosing the right shape

Pick the shape that makes the compartment recognizable and findable with the **least overhead**. Self-close when the title covers it; use anchor words when search hooks are what matter; use a sentence only when prose conveys the durable mechanism better than anchors.

Cost of wrong choices:
- **Wrongly writing prose that rephrases the title** → both wrong: hurts recognition (the title was already sufficient) AND burns tokens. This is the most common failure mode. If your P4 sentence is a paraphrase of your title, switch to `<p4/>`.
- **Wrongly self-closing a compartment that needed anchors** → compartment becomes hard to find via search when discriminative keywords aren't in the title.
- **Wrongly writing a full sentence when anchor words would do** → adds grammatical scaffolding that doesn't help recognition; switch to the anchor-only shape.

### Other P4 rules

- No locational anchors. No file paths. No line numbers. (Commit hashes are the one exception — they stay verbatim at every tier as permanent grep keys.)
- U: lines virtually never appear at P4. Only if the user's exact wording IS the entire reason this compartment exists.

