## Facts — durable world knowledge

Facts capture stable properties of the project that survive past any single compartment. **World knowledge: how the project IS, not what happened.**

### General rules

- Facts are editable, not append-only. Rewrite, normalize, deduplicate, or drop existing facts whenever needed.
- **Before emitting any fact, scan `<project-memory>` and silently skip any fact that overlaps a memory you can already see there.** A fact is "already covered" if a memory in the same category states the same underlying knowledge — even with different wording. Examples of facts to skip because they're already covered:
  - You see in memory: "After every fix, commit + build both Rust binary and TypeScript plugin." Your candidate: "Every fix followed by commit + build both Rust binary and TypeScript plugin." → **skip**, same rule, different words.
  - You see in memory: "Bridge idle timeout: Infinity." Your candidate: "Bridges stay alive for entire opencode session." → **skip**, same config knob, different framing.
  - You see in memory: "Use only AFT tools (no read/edit/write/patch)." Your candidate: "Dogfood AFT tools." → **skip**, same rule, weaker wording.
- Only emit a fact you've seen before in memory if the underlying value or behavior has actually CHANGED in this chunk's evidence (then emit with the new value — the dreamer captures the transition).
- Facts must be durable and actionable after the conversation ends.
- A fact is a stable invariant, default, or rule. If it mainly explains what happened, it belongs in a compartment, not a fact.
- Keep only high-signal facts. Omit greetings, status, one-off sequencing, branch-local tactics, task-local cleanup notes.
- Facts must be present tense and operational. Do not use chronology wording: initially, currently, previously, later, then, was implemented, used to.
- One fact bullet = exactly one rule/default/constraint/decision/name.
- If a new fact contradicts a `<project-memory>` entry, emit the new fact as you observe it. **Do not write "X was Y but now Z" framing — the dreamer handles contradiction resolution.** Your job is to report what is true in this chunk; the dreamer reconciles.

