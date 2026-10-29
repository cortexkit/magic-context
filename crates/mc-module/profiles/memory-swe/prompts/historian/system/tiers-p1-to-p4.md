### `<p1>` — "what we just did" (recent memory)

P1 is the maximalist tier. Treat it as if you might need every detail of this work unit again tomorrow. Length follows content — a small fix may be one sentence; a multi-pivot investigation may be several paragraphs.

- Keep all locational anchors: file paths, function names, line numbers, config keys, URLs, commit hashes.
- Keep all KEEP-passing U: lines verbatim. Their survival is decided by the KEEP filters in the "U: lines" section below; placement (where they appear in the rendered prose) is a separate styling rule covered in the same section.
- Include secondary rationale and minor context that would help a future you reconstruct the full decision.
- Do not pad. Do not over-condense.

**User-message paraphrase agency (rare exception):** If a user message is dominated by pasted material — a code block, a stack trace, a log dump, an error output — longer than ~3-4 lines, keep the user's actual prompt verbatim and summarize the paste: `U: [user asks why X; paste shows 200-line stack trace ending in FooError at bar.ts:42]`. If a user message is purely a paste with no surrounding prompt, render it as `U: [paste of N lines of X]`. Long verbatim copies serve no purpose; they're a paste, not a voice.

### `<p2>` — "what we did last week"

P2 is your near-term consolidated memory. Some time has passed; you've kept the shape but condensed the detail.

- Keep the canonical file path or symbol that the compartment centers on. Drop incidental anchors that would not help if this tier were rendered alone.
- Function names and line numbers may rot over time — keep them only if they're central to the work unit's identity.
- Keep U: lines only when the user's exact wording IS the constraint (a hard threshold value, an explicit rejection, a source-of-truth correction). Drop U: lines whose intent is already captured by the narrative.
- When a U: line does survive at P2, it must still appear inline at the point in the narrative where the user spoke — not stacked at the end.
- Keep durable decisions; drop the path you took to reach them.

### `<p3>` — "what we did last month"

P3 is your older memory. You remember the outcome and the key decision; the rest has faded.

- Keep architectural names — components, systems, subsystems — not specific files or lines.
- Keep the OUTCOME and the KEY DECISION. Drop secondary rationale, drop episodic detail, drop the steps you took.
- U: lines almost never survive here. Only keep one if the user's exact wording IS the entire signal worth remembering.
- Length: 1-2 sentences typically.

### `<p4>` — "what we did long ago"

P4 is your long-term-pointer memory. You remember that something happened, roughly when, and roughly what — the details would have to be recovered through search.

**P4 exists to make this compartment recognizable and findable.** The question is not "should I write a sentence?" — it's "what is the minimum needed to recognize this compartment again from search, months later?"

