# `owned-broca` tool-outage error outputs

Vectors for the tool-outage members of an `owned-broca` error output
(CONTRACT §4.4) and for the runner-neutral rendered text (CONTRACT §11.4).
`serializer_profile::error_output::tests` reads every file here, and
`SHA256SUMS` pins every file's bytes.

## Producer captures

Copied byte for byte from a real `owned-broca` producer. A tool call was
refused at route open because the `aft` module was not registered, so the
error output carries all five members, `nothing_sent` included.

| File | What it holds | Checked |
|---|---|---|
| `session_history.row.json` | the raw `session.history` row; the error output at `/message/content/0/output` | decodes with every member |
| `session_read.reply.json` | a `session.read` reply; the error output at `/result/messages/2/message/content/0/output` | decodes, equal to the history row's |
| `tool_finished.frame.json` | a control frame carrying the tool result; the error output at `/unit/result/output` | decodes, and re-encodes to the frame's exact bytes |
| `tool_result.record.json` | the stored tool-result record; the error output at `/record/result/output` | decodes, and re-encodes to the record's exact bytes |
| `tool_finished.event.json` | the live `tool_finished` event | carries no error output |
| `session_history.display.row.json` | the display row of the same result | its `content` equals the rendered block exactly |
| `session_history.display.plain-error.row.json` | the display row of a plain error, `plain failure` | its `content` equals a plain error's rendered block, the message alone |

## Hand-written samples

`valid-error-outputs.json` has outputs a reader accepts, each with its
rendered block: a plain error, which re-encodes as exactly
`{"kind":"error","message":"plain failure"}`; every member at its byte
limit, with multi-byte UTF-8 and the members in another JSON order, which
still render in the fixed order; a lost reply, which carries no
`nothing_sent`, with a compact-JSON `detail`; modules with a space,
non-ASCII text, or 129 bytes; and a module of exactly 255 bytes spelled
with multi-byte characters, so the limit is exercised in bytes.

`invalid-error-outputs.json` has outputs that break one rule each. Every
case's expected outcome is `reader_refuses`, naming the member and the
rule (`ErrorOutputRule::as_str`): `nothing_sent` false, a string or `null`;
an unknown member; a `null` member; `\n` or `\r` in `detail` or `retry`,
one of them forging a `nothing was sent` line; `detail` over 1 KiB and
`retry` over 256 bytes; an empty `module`, `code`, `detail` or `retry`;
`module` with a tab, a newline, a C1 control character or over 255 bytes; `code` in
upper case, with a leading digit, with a hyphen or over 64 bytes; a
non-string `detail`; a `kind` other than `error`; and a missing `message`.
