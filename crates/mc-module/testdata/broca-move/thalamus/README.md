# session-export-v2

The same sample as `session-export-v1`, recorded again with every page of the session's
`session.entries` beside its export, so a reader can compare its own numbering of an
imported session with the runner's on the same session. v1 stays as published; its
sessions came from throwaway test servers and can't be served again, so v2 is a new
recording of the same story (see v1's README for the story, the reply members and the side
file). Each host's export, side file, reply and entries come from one run of one session:

- `opencode2/`: module `thalamus-harness`, OpenCode 2.2.3, by
  `runner::export::tests_opencode2_real::real_opencode2_head_exports_for_broca`;
- `pi/`: module `thalamus-pi`, Pi 1.5.0, by
  `pi_head::open::tests::export::real_pi_head_exports_for_broca`.

Both tests record with `THALAMUS_RECORD_DIR` set to this folder (relative to the
repository root). Recorded on Linux at commit `204a6f27e`.

| File | What it is |
|---|---|
| `<host>/export.json`, `export.jsonl` | the export, as in v1 |
| `<host>/export.sends.json` | its side file, as in v1 |
| `<host>/reply.json` | the `session.export` answer, as in v1 |
| `<host>/entries-<n>.json` | page `n` of `session.entries`, read by the session's compaction provider (`magic-context` on its `compaction-runner/v1` route) in full detail from the first entry on (`{"select": {"by": "after"}, "detail": "full"}`), following `next_after`. Each file is the answer the runner served: the `result` member of the wire reply body `{"result": …}`. |

Each session's entries fit one page (`next_after` is absent).

## Rows with no entry

Every entry's `mid` is a row of its host's export, in the same order. Some export rows are
host bookkeeping the runner doesn't number, so they have no entry:

- OpenCode 2: the four `idle` rows (OpenCode's record of a turn's end). The export's 15
  rows hold 11 entries, ordinals 1 to 11.
- Pi: the `session` header and the `model_change` and `thinking_level_change` lines. The
  journal's 17 lines hold 13 entries, ordinals 1 to 13; the `custom_message` line (the
  plan sender's `NOTE 3`) is an entry.

## Scrubbing

As in v1, the test's scratch folder is written `/scratch` and the repository's folder
`/repo`, in the entries pages as in the export, so both name the same folders. Pi's system
entry names its documentation under `/repo/pi-extension/thalamus/node_modules/…`.
