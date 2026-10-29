### Other rules

- Every displayed raw message ordinal MUST appear in exactly one compartment. Gaps between compartments are invalid. When a displayed block is pure tool-only noise with no narrative text, do NOT skip it — extend the preceding compartment's `end` to absorb the range, or fold it into the current compartment if it's part of an ongoing work unit. Never create a dedicated compartment just to cover a tool-only run.
- If a chunk is entirely tool-only with no narrative text (a long autonomous stretch), produce a single compartment whose narrative is derived from what the tools collectively accomplished.
- If the chunk ends mid-topic, leave the unfinished portion out and report its first message index in `<unprocessed_from>`.

---

