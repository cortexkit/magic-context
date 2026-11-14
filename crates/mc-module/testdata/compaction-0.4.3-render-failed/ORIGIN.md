# Pinned render_failed notice vectors

These three files were copied byte-for-byte from the crates.io package
`cortexkit-role-compaction` 0.4.3 (commit `671504a8` of
https://github.com/cortexkit/commons), directory `test-vectors/compaction-v2/`,
which owns the compaction wire contract. They are the worked examples of the
`render_failed` refusal in a `view_refused` notice (CONTRACT.md W6.5 and
W6.6a), sent only to providers declaring `compaction-render-failed/v1`. Each is
an independent notice about view version 7, not three reports for one version.

| File | What it states |
| --- | --- |
| `notice-render-failed-part-request.json` | Version 7 is served minus every replacement of `message-b`'s `part-b`; `field: attachments` only narrows the diagnosis |
| `notice-render-failed-message-request.json` | No view is served for version 7, and the runner knows the message (`message-b`) |
| `notice-render-failed-unlocated-request.json` | No view is served for version 7, and the runner cannot locate the failure |

The contract adds two rules these files do not show on their own. A runner
decides its fallback before reporting, so a one-part skip that still fails is
reported in a no-view shape, never with `part`. A version that reported a
one-part skip and later moves to no view sends exactly one more report, in a
no-view shape, and never a third. `render_failed_contract_tests.rs` drives
ck-mc's notice path with these events, including that escalation.

`SHA256SUMS` holds the package's own lines for these files, so a copy that
drifts from the published bytes fails `shasum -a 256 -c SHA256SUMS` and the
test that checks the same sums. Tests read only these tracked copies, never
the cargo registry.
