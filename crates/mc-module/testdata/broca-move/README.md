# Runner-to-Broca move coordinates

These synthetic, scrubbed OpenCode 2 and Pi export/import recordings were copied
from `shared-broca-readers/head-import-entries-1107`, a shared comparison bundle
of THALAMUS exports and Broca imports of those same sessions. `SHA256SUMS` records the copied
files unchanged. Only the entries and import coordinates needed by the tests
are included, not the full exports.

- `thalamus/<host>/entries-1.json` is THALAMUS's served session.entries page.
- `broca/<host>/import-reply.json` contains Broca's original message-id move list.
- `broca/<host>/entries-unadmitted-1.json` and `comparison.md` also identify the
  entries Broca adds. The pages were produced by Broca's page builder before
  the session's plan named its compaction provider. They are not admitted route
  replies: the route refused access until the plan granted it. See the copied READMEs.

The integration fixture joins the source entries and imported moves by message
id, then includes Broca-only entries as `added: true` with `source_entry: null`.
The recorded OpenCode 2 import reply omits those added rows (ordinals 3 and 12);
the test reconstructs the complete list from the recorded destination entries.
A move request that omits an entry is refused rather than guessing a cut.

The Pi system row is source ordinal 1 and has no Broca entry. This sample adds
no Pi-only closing result. A small synthetic unit test also covers a summary
ending on a system row between two surviving entries: its end moves back to
the previous surviving entry rather than retaining the dropped system row.
