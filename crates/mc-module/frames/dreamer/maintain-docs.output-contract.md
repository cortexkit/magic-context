## Answer

Answer with ONE JSON array and nothing after it, without a code fence. Each entry changes one section:

[{"file": "ARCHITECTURE.md", "action": "replace", "heading": "## The section's heading line, exactly as the document has it", "text": "## The whole new section, its heading line first", "reason": "One line: what in the code makes this change necessary."}]

- `file` is `ARCHITECTURE.md` or `STRUCTURE.md`.
- A section is its heading and everything under it until the next heading of the same or a higher level, or the end of the file. Headings inside code fences do not count.
- `action` is `replace` (rewrite one section), `remove` (delete one section; `text` is empty) or `add` (a new section, appended at the end of the file; `heading` is its heading line).
- For `replace` or `add`, `text` starts with the exact heading line and contains just that section, including any subsections you want it to contain.
- List only the sections you change.
- `[]` means both documents are still right.
