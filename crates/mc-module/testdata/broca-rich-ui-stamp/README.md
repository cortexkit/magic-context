# Broca rich-UI stamp samples

The five session/event JSON files are byte-identical copies of the original
captures (including the trailing newline). They were captured with Broca's
`broca-module-serve` integration test target `head_read_additions`, filtered to
`rich_ui_stamp`, through the real Linux management serve path over a synthetic
session with a seeded frozen manifest and completed run, not a production
conversation. `SHA256SUMS` includes the supplied SHA-256 hashes.

The supplied set has no describe response. `role.describe.json` is derived from
`../broca-0.7/role.describe.after.json` by adding only `"rich_ui_stamp"` to its
`result.capabilities` array. Its checksum is generated locally; it is not a new
Broca capture.

Stamp locations matter: history uses `messages[].row.rich_ui`, the live frame
uses `event.rich_ui`, head uses `last_run_rich_ui`, and the opted-in read uses
`messages[].rich_ui`, outside the strict native `message` body. Default read has
no stamp.

The history capture is **display form**. ck-mc's `ctx_expand` requests raw form,
which uses `message` rather than `row`; the exact display capture is checked
separately from a raw-form equivalent using native message bodies from the
paired read capture. No display-to-native conversion is added to production.

Both read captures are **inline mode**. Tests first decode these exact replies,
then exercise descriptor-only consumers by adding the runner descriptor helper's
`digest` and `part_digests` fields, leaving captured metadata intact. An inline
page's existing missing-digest refusal is not a rich-UI incompatibility. Offline
exports additionally omit the unary `result` envelope by contract.
