---

## U: lines — placement, when they survive, and how they're worded

### Placement (a styling rule, not a survival rule)

**Placement is styling; the KEEP filters decide survival.** A U: line that passes the KEEP filters survives into P1 regardless of how naturally it weaves into the narrative. Placement decides WHERE the U: line sits in the rendered prose; it never decides WHETHER it survives. If you cannot place a surviving U: line gracefully, place it where it fits best rather than dropping it.

The visual shape: P1 is a sequence of narrative paragraphs with U: lines on their own lines between paragraphs, sitting at roughly the point in the work arc where the user spoke. Each U: line is followed by 1-3 sentences of outcome/effect describing what happened because of it.

```
<p1>
[Narrative paragraph describing what triggered this work and what was attempted first.]
U: User's exact wording at the pivot point
[Narrative paragraph describing what was done in response, and the outcome.]
U: Another user wording, if the user spoke again later in the arc
[Closing narrative paragraph with the resolution and any commit hashes or key file paths.]
</p1>
```

Placement guidance:
- If the user kicked off the work, the U: line appears near the start of P1.
- If the user spoke mid-investigation (a course correction, a clarification), the U: line appears in the middle of the narrative at that pivot.
- If the user's final word closed the work unit (e.g. "commit it"), the U: line appears at the end.
- If two surviving U: lines are tightly adjacent in the original conversation, it is fine to place them next to each other; the "never stack U: lines without intervening outcome text" rule applies across the whole compartment, not within a tightly-coupled pair.

**The count emerges from the work. Do not aim for a count.**

The purpose of U: lines is to preserve user wording that narrative paraphrase loses. For every substantive user message in the compartment's range, ask:

1. **Did this message produce a durable directive, decision, rejection, constraint, threshold, or source-of-truth correction?** If no — drop (the narrative covers what was done). If yes — continue.
2. **Does the narrative already convey the full signal, including any emphasis, framing, or specific phrasing the user chose?** If yes — drop (redundant). If the narrative covers the topic but loses the user's specific wording, the wording IS the signal — keep.
3. **Has another U: line in this response already captured the same intent?** If yes — drop (cross-compartment dedup). If no — keep, verbatim, placed inline at the conversation point where the user spoke.

A compartment with three substantive user pivots produces three U: lines if all three pass. A compartment with one user message that just opened the work and an agent that worked autonomously after produces zero or one. A compartment of pure autonomous tool execution produces zero. **Aim to preserve every irreplaceable user wording and drop everything else** — never aim for a numeric target.

**Calibration check** (replaces any quota-style intuition): if you produced a P1 with multiple substantive user messages and zero or near-zero U: lines, **that is a signal your filters may be too aggressive**. Re-read the messages and verify each one truly failed step 1 or step 2 above. If any of them carried wording you would want to recall verbatim months later, restore it.

The same placement rule applies at P2 when a U: line survives there.

### DROP rules — never survives into any tier

A U: line that fails any DROP rule is gone from all tiers; it never enters the compartment.

- Questions in any form: "should I X?", "what about Y?", "do you think Z?". The resolved answer belongs in narrative only.
- Agreements, acknowledgments, gratitude: "yes", "okay", "sure", "thanks", "go ahead", "looks good", "perfect", "I agree", "great", "sounds good".
- Pure pacing or sequencing: "let's start", "continue", "now we can X", "let's commit", "first do A then B".
- Tactical observations: "I just noticed X", "we recently did Y", "this seems wrong right now".
- Debugging status: "context is at 78%", "I'm restarting", "the last build failed".
- Dogfooding/restart loops: "I restarted, can you check?", "let me try again".
- Pasted error output or logs presented as a U: line.
- Examples and illustrations meant to clarify, not to direct.
- Hype with embedded directive: ALL-CAPS pleas, repeated "please". Extract the underlying directive into narrative; drop the hype.
- Social signals, banter, emoji-only enthusiasm.
- Deferred ideas: "for later", "we can do X someday", "another idea for the future".
- Mid-process status: "running Y", "checking Z".
- Superseded drafts once a later message gives the final decision.
- Standing workflow rules ("always run lint before push"): these belong in facts, not U: lines.

### KEEP rules — a U: line survives only if ALL pass

1. **Durable** — the signal matters after the immediate turn.
2. **Specific** — concrete goal, hard constraint, design decision, rejection, rationale, threshold, source-of-truth correction, or future-work directive.
3. **Outcome-backed** — the compartment narrative clearly states what was done, decided, or changed because of this message.
4. **Non-redundant** — not captured by another U: line in this response, by a fact, or by the narrative. Note: "captured by narrative" means the narrative carries the FULL signal the user's wording carries — including any emphasis, negotiation context, rejection framing, or specific phrasing the user chose. If the narrative covers the topic but loses the user's specific framing (e.g. narrative says "decided on threshold of 60%" but the user actually said "60% — and absolutely no higher"), the U: line is NOT redundant; the wording itself carries signal narrative paraphrase dropped.
5. **Irreplaceable** — the user's wording adds signal that narrative paraphrase cannot preserve.

Categories of KEEP:
- Hard gates, thresholds, percentages, byte sizes, config defaults with concrete values.
- Accepted designs and explicit decisions.
- Rejections and negative constraints: "X is wrong because Y", "we should NOT do Z".
- Source-of-truth corrections: "follow the code, not the README".
- Implementation pivots in future tense: "instead of X let's do Y", "switch to Z".
- Durable rationale that explains WHY an approach was chosen.

### Wording — default verbatim

- Default: U: lines use the user's actual wording.
- **Strip agreement prefixes**: "Yes X" → keep just X, in the user's wording.
- **Split compound directives**: one message with two distinct durable directives becomes two U: lines, placed at their respective points in the narrative.
- **Drop conversational wrapping**: if a message wraps a directive in exploration ("so I was thinking... actually..."), drop the exploration, keep the core in the user's remaining words.

Never:
- Rewrite a clear user directive into a formal constraint statement. ("We need tool count at ~8" stays as-is; do NOT convert to "Tool count must be capped at 8.")
- Synthesize a directive from multiple messages into one canonical statement. If synthesis is needed, the signal belongs in narrative.
- Add technical specificity (file paths, function names, constants) the user did not state.

### Cross-compartment dedup (forward-looking)

Before writing any U: line in the current compartment:
1. Scan U: lines you have already written in previous compartments in this response.
2. If any prior U: line expresses the same intent, decision, constraint, or rationale — even in different words — do NOT write the new U: line.
3. Let the narrative in the current compartment carry the signal instead.

This is a forward operation: only check what you already wrote.

### Tier survival summary

- **P1**: all KEEP-passing U: lines verbatim, placed inline at the conversation point where the user spoke.
- **P2**: only U: lines whose exact wording IS the constraint — hard thresholds, explicit rejections, source-of-truth corrections. Drop U: lines whose intent is already in the P2 narrative. Survivors still appear inline at the point they were said.
- **P3**: U: lines virtually never appear. Only keep one if the user's exact wording IS the entire signal worth remembering.
- **P4**: U: lines essentially never appear.

