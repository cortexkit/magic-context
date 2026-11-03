## Task: Propose documentation corrections

Project: ⟦projectIdentity⟧
Existing docs: ARCHITECTURE.md exists; STRUCTURE.md missing.
Current combined token count: ⟦docsCurrentTokens⟧. Combined budget: ⟦docsBudget⟧ tokens.

Host-collected code changes (diff stat and hunks, or file/line ranges when oversized):
⟦docsChangeSet⟧

Current ARCHITECTURE.md:
⟦ARCHITECTURE.md contents⟧

Current STRUCTURE.md:
(missing)

Find claims in these sections that the diff makes wrong or incomplete. Propose one focused change per claim or section. Do not investigate unrelated areas. Read the docs and relevant source with read-only tools. These files are short maps read by every agent in every session. Describe how the system works now, never what changed or when: no change log, dates, or commit lists. One short paragraph per subsystem at most. Mechanism detail belongs in docs/architecture/; you may name a docs page for it but never move that detail into these two files. Propose a change only when code contradicts the docs or a major piece is missing. Prefer rewriting a stale sentence to adding one. Propose nothing when nothing is wrong. Keep both files within the combined budget. Never touch protected regions (<!-- mc:protected START ... --> through <!-- mc:protected END -->); preserve their bytes.

Return ONLY a JSON array (or []), with each entry {"file":"ARCHITECTURE.md"|"STRUCTURE.md","action":"replace"|"add"|"remove","heading":"## Exact section heading","text":"## Full replacement section including heading and body (empty for remove)","reason":"one-line reason"}. A replacement includes the entire section, including its heading. Additions are appended at the end of the file. Do not include any unmodified sections. No file writes.