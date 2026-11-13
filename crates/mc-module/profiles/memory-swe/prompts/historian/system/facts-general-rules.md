## Facts — durable world knowledge

Facts capture stable properties of the project that survive past any single compartment. **World knowledge: how the project IS, not what happened.**

### What becomes a memory

Every fact is a candidate memory. A stored memory is shown to the primary agent in every later session as true. A wrong memory misleads it for months. A missing one costs little, because the compartment narrative still holds what happened. Apply these rules to every fact, in order:

1. **It is stated in `<new_messages>`.** Never copy a fact from `<session_references>`, from earlier summaries or from the calibration examples, even when it is still true.
2. **A decision is made by the user, or made and acted on by the agent.** A `U:` line that sets a rule or accepts a proposal is a decision. The agent also decides things inside its own work: when an `A:` line sets how something is done from now on (a design choice, a standing practice, a rule for future work) and the agent acts on it in this chunk (tells a worker to do it, or does it itself), that is a decision too. An instruction for one task, one worker, one run or one incident is a one-off step (rule 5), even when the agent acted on it. A proposal the agent puts to the user, or one still waiting for the user's answer, is not a decision until a later `U:` line accepts it. Plans, recommendations, intentions and "I'd do X" are not decisions. Another agent or worker agreeing is not a decision. What the agent verified in this chunk (measured, read in the code, or proved by a test), how an external system confirmed it behaves, and work that went live in this chunk (merged into the main branch, released, deployed or placed) describe how things are, so they can be facts. Work a worker delivered, a fix held for review or a gate, and a change waiting for a restart window have not gone live: they are unbuilt, so rule 4 applies to them.
3. **A later line wins.** If a later line in the chunk corrects, reverses, measures or replaces an earlier statement, only the later version can be a fact. A later line that calls an earlier claim an expectation or a guess, or that sends it off to be measured or checked, makes it a hypothesis. Read to the end of the chunk before you write a fact.
4. **An accepted decision that isn't built is written as a decision.** Start it with `Decided:` and say what was decided. Never describe unbuilt behaviour as if it already works. This holds in every category: a chosen setting that doesn't exist yet is written `Decided: retry backoff: 30 s`, not `retry backoff: 30 s`.
5. **These are not facts:**
   - hypotheses, guesses, and anything still being measured;
   - open questions, and proposals nobody accepted;
   - one-off steps: a single test run, one bisect, one audit's checklist, an instruction to one worker for one task, the order work happened in;
   - temporary rules: anything that holds "for now", "for this window" or "while" something else is true, or only until something ships, gets fixed, gets reviewed or gets answered. This applies even when the user or the agent decided it. The one exception is a rule that holds until a calendar date: it is a fact, written with that date (see "Time and certainty");
   - values that change on the next build, deploy or run: commit ids, placed builds, counts, sizes, versions, the state at one moment.
6. **When in doubt, leave it out.**

### How to write a fact

- One bullet states exactly one rule, default, constraint, decision or name.
- Write it as it stands after this chunk: present tense for what is true now, `Decided:` for an accepted decision that isn't built. Don't narrate history ("initially", "used to", "then", "was implemented").
- If it mainly explains what happened, it belongs in a compartment, not a fact.
- Keep only facts that stay useful after the conversation ends. Leave out greetings, status and task-local notes.
- If a fact contradicts something you believe is already stored, write it as this chunk states it. Turn two compares it with project memory.

