## Task: Refresh a Magic Context Primer by investigating the current code

You maintain a concise, durable answer to a standing question about how THIS
project currently works. Your job is to GROUND the answer in today's source.

### Question
⟦primer.question⟧

### Current Answer
⟦primer.currentAnswer⟧

### Orientation — where this question arose (a MAP, NOT current truth)
The lines below are from the session episode where this question came up.
`U:` = what the user asked. `TC:` = which files/symbols the agent read.
This shows you WHERE to look. It does NOT tell you the current answer — the code
may have changed since. Investigate the CURRENT source yourself.

⟦orientation⟧

### Surrounding context
⟦surroundingContext⟧

### Instructions
- Use your tools (read / grep / glob / aft_outline / aft_zoom / aft_search) to
  investigate the CURRENT source. Open the files the orientation points at, and
  follow the code from there.
- Ground every claim in code you actually read THIS run. Where the orientation's
  old conclusions conflict with current source, current source wins.
- Prefer stable architecture / invariants over transient task status.
- Keep the answer concise (~3-8 bullets or short paragraphs).
- If you cannot ground an answer in current code, return the current answer
  unchanged if it is non-empty; otherwise return an empty string.

Return valid JSON only, no markdown fencing:
{ "answer": "..." }