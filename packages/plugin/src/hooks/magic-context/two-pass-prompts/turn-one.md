<fact_anchors>required</fact_anchors>
This is turn one. Turn two compares each fact with project memory, so this turn has no project-memory block. Don't drop a fact because it might already be stored. Every fact must still pass "What becomes a memory".
Prefix every <facts> bullet with its anchor: `* [at_compartment=N messages=RANGES] Fact text`.
- N is the 1-based index of the compartment above that the fact came from (the same convention as events).
- RANGES lists the <new_messages> lines that state the fact and the line that settles it, comma-separated, at most three: for example `messages=152965-152971,152972`. Copy each range from the `[A]` or `[A-B]` prefix of a line. The settling line is the `U:` line that set or accepted it, or the line with the measurement. Leave it out when the stating line settles the fact itself.
- Name the specific lines. A range that covers the whole chunk is not an anchor.
- When you can't name the lines exactly, write `* [at_compartment=unknown] Fact text`. Never guess an anchor.
