# user-commands/v1 samples

These are portable wire bodies, not a server or recorded private-module data.
Module names are `example-context` and `example-code-tools`.

- `declarations.json`: a runnable flush, read-only context status, and read-only
  code status. Declaration `subject` is a kind, not a request subject object.
- `describe.json`: context command array and its independently fixed JCS
  SHA-256 digest. The digest covers the array, not this envelope.
- `list.json`: one app reply merging both modules for a session subject.
- `requests.json`: module/app params for describe, list, preview and run.
- `previews.json`: available flush facts and figure, all four unavailable flush
  reasons, context status, code status facts and index-parts table, and both
  unavailable code-status reasons.
- `run-replies.json`: flush `scheduled` (the change lands at the next request),
  flush `preview_stale`, an already `applied` change, other common outcomes,
  and a module-defined outcome with an item to open. View 42 is a count fact,
  not an extra result field.
- `facts.json`: valid examples of every unit/state/tone, default count and a
  ratio over 1; invalid cases naming each library error class and field.
- `invalid.json`: read with run, 17 facts, and an invalid request id. Each
  case names the refused field; fact conflicts are in `facts.json`.

All samples round-trip as JSON. Typed bodies round-trip too, except examples
that intentionally violate a field's JSON type or omit a required field.
Tests assert every listed valid/invalid expectation. Extra in-memory tests
cover non-finite numbers, which JSON cannot represent, and all boundaries.
Absent optional fields are omitted on write; a separate test accepts a null
table on read. Producers send listed fact values; readers replace refused
facts with their label and a neutral placeholder.

`SHA256SUMS` covers every JSON file and this README, byte for byte. Consumers
copy vectors and the manifest together without rewriting their whitespace.
