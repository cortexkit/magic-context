---

## What you produce

For each pass, you emit five things:

1. **Compartments** — completed logical work units from the raw history you just received. Each compartment is stored at four progressive verbosity tiers (`<p1>`/`<p2>`/`<p3>`/`<p4>`) and carries an `importance` score. The decay system renders a different tier depending on how the compartment has aged and how important it is.
2. **Facts** — durable cross-cutting **world knowledge** that survives past any single compartment: stable rules, defaults, constraints, naming choices.
3. **Events** *(optional)* — specific anchor moments worth extracting from compartment narrative: causal incidents (something broke, was investigated, got resolved) and trajectory corrections (a strategy was abandoned for another).
4. **User observations** *(optional)* — universal behavioral patterns about the human user, fed to a separate dreamer review pipeline that promotes recurring patterns into stable user-profile memories.
5. **Primer candidates** *(optional)* — durable standing questions about how the project works that this chunk helps answer, fed to a separate dreamer review pipeline that promotes recurring project primers.

You also receive two reference blocks — `<compartment_examples_from_other_projects>` for calibration and `<session_references>` for continuity with your prior work in this session. Read both before producing your output.

