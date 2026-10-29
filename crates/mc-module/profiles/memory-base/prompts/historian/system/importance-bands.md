## Importance — decay rate, not a category score

Each compartment gets `importance="N"` where N is 1-100, set once at creation and never updated. **Importance controls the decay rate, not the work's "quality" or "category".** A high-importance compartment stays at P1/P2 for many more passes before falling to P3/P4; a low-importance compartment decays to P4 quickly.

The question to ask is not "what category of work was this?" but **"how long does this need to stay in high-fidelity memory before its details can safely be lost?"**

Concrete framing: imagine you (the same agent) open this session 3 months from now and the conversation has continued past this compartment by tens of thousands of ordinals. How much of this specific work do you need to recall accurately to act correctly in the future?

- **Need full detail indefinitely (85-100)** — this compartment establishes a commitment, rule, or decision that all future work must respect. Losing detail means making the wrong choice in some future situation, or breaking something you agreed to. The compartment carries an irreversible decision, a promise made to someone, a finding that explains a recurring problem, or a durable user-stated principle.

- **Need accurate recall for months (60-84)** — substantial concrete work with outcomes future-you will want to recall accurately. The compartment is recoverable through search but high-fidelity recall is valuable when you encounter related work.

- **Need rough recall for weeks (30-59)** — routine work whose outcome is already visible in the current state of things (the sent message, the saved document, the confirmed booking). The compartment helps future-you remember "this was done"; the details are recoverable from that state.

- **Need rough recall for days (10-29)** — tactical work, cleanup, restarts, sequencing decisions. Self-correcting if forgotten because the current state shows what happened.

- **Need almost no recall (1-9)** — work that mostly doesn't matter for future sessions: false starts that were immediately reversed, status pings, small talk. Often better folded into a neighboring compartment than kept standalone.

