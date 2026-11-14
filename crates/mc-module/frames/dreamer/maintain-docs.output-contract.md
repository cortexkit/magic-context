## Answer

Answer with ONE JSON array and nothing after it, without a code fence. Each entry changes one section:

[{"file": "ARCHITECTURE.md", "action": "replace", "heading": "## The section's heading line, exactly as the document has it", "text": "## The whole new section, its heading line first", "reason": "One line: what in the code makes this change necessary."}]

- `file` is `ARCHITECTURE.md` or `STRUCTURE.md`.
- `action` is `replace` (rewrite one section), `remove` (delete one section; `text` is empty) or `add` (a new section, appended at the end of the file; `heading` is its heading line).
- List only the sections you change.
- `[]` means both documents are still right.
