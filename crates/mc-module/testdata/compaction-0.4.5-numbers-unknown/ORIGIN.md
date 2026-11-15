# Pinned numbers_unknown vectors

These six files were copied byte-for-byte from the crates.io package
`cortexkit-role-compaction` 0.4.5 (commit `9267d1e6` of
https://github.com/cortexkit/commons), directory `test-vectors/compaction-v2/`,
which owns the compaction wire contract. They are the worked examples of
entries the runner serves without part numbers (CONTRACT.md T9 to T11, W1.3,
W1.4, W6.5 and W7), sent only to providers declaring
`compaction-numbers-unknown/v1`.

| File | What it states |
| --- | --- |
| `entries-numbers-unknown.json` | A `session.entries` page holding one entry marked `numbers_unknown: true`, its text part without `tag` |
| `notice-numbers-unknown-request.json` | The same entry in a `compaction.notice` |
| `numbers-unknown-transition.json` | One stored entry before and after the runner fixed its stretch as unknown-number: same role, notice and part digests, a different entry digest because the tag is gone |
| `checksum-numbers-unknown-marker.json` | The marker is outside the entry checksum: the entry hashes the same with and without it |
| `refusal-numbers-unknown.json` | A tag read refused as a whole, naming the requested numbers it covers |
| `view-cut-before-numbers.json` | A view refused because its cut is before the last unknown-number entry |

`numbers_unknown_contract_tests.rs` drives ck-mc's read, notice, tool and view
paths with them. `SHA256SUMS` holds the package's own lines for these files,
so a copy that drifts from the published bytes fails `shasum -a 256 -c
SHA256SUMS` and the test that checks the same sums. Tests read only these
tracked copies, never the cargo registry.
