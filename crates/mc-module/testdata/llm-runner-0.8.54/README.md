# llm-runner send vectors

`send.json` is copied byte for byte from
`crates/cortexkit-role-llm-runner/test-vectors/llm-runner-v1/send.json` in
commons commit `e61a15a68580025378af7f78deb53800a4676b1d`, published as
`cortexkit-role-llm-runner` 0.8.54. `SHA256SUMS` pins the copied bytes.

The summary send tests drive its pending and not-delivered replies through
the real send/wait path. This release has no file vectors for `not_delivered`
with `reason: "withdrawn"` (words handed over but provably never used), the
`handover_failed` run causes, or a queued send after cancellation;
those replies use the published crate's constructors, as its inline tests do.
