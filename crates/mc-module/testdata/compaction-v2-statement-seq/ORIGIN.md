# Pinned statement-order vectors

These five files were copied byte-for-byte from the crates.io package
`cortexkit-role-compaction` 0.3.8 (commit `2a67ab5f` of
https://github.com/cortexkit/commons), directory `test-vectors/compaction-v2/`,
which owns the compaction wire contract. They carry the optional
`statement_epoch` and `statement_seq` that Setup and `Conditions` send to
providers declaring `compaction-statement-seq/v1` (CONTRACT.md W3.5,
"Statement order").

| File | What it states |
| --- | --- |
| `setup-statement-seq-request.json` | A Setup with an epoch and stamp 42, with a signed floor |
| `notice-statement-seq-request.json` | A notice under that epoch, stamped 42 |
| `ride-statement-seq-request.json` | A ride under that epoch, stamped 42 |
| `setup-statement-seq-restored-request.json` | A Setup after a restore: a new epoch, stamp 7, no floor |
| `notice-statement-seq-restored-request.json` | The first notice under the new epoch: stamp 8, notice number 1 |

`SHA256SUMS` holds the package's own lines for these files, so a copy that
drifts from the published bytes fails `shasum -a 256 -c SHA256SUMS`. Tests read
only these tracked copies, never the cargo registry.
