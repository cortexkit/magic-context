# Send replies for a send that never reached its host, version 2

These are synthetic `llm-runner/v1` bodies for readers of the `not_delivered` send
state (llm-runner 0.8.54, section 9). `not_delivered` means the runner proved the
send's words never ran and can no longer run: its sender may send the same words
again, as a new send with a new `send_id`. It is final for its `send_id`, carries a
required `reason` (an open string: readers keep a value they don't know rather than
refuse the reply), and has no `delivered` member. It differs from
`delivered.as: "unknown"`, whose outcome is unknown and which is never sent again.

A send that starts its own run ends that run too: the run took no model step and
reads `error` with `class: "handover_failed"`, `provider_code: "provider_error"`
and a `cause` naming the failure (here `nothing_written`).

The unit test `send_not_delivered_bodies_are_pinned` dispatches real runner
operations through an in-memory stand-in host and checks each body against these
files byte for byte. Each body is decoded with the reader's own type
(`SendReply`, `RunStatus`, `RunResult`, `SubscribeEvent`) only for that check;
the files hold the text exactly as answered, without an added newline.

Version 1 remains unchanged beside this set. Version 2 changes only the first
reply: it now names the run committed with the send and is answered before the
first hand-over. All terminal send, run and event JSON bodies are unchanged.

## Files and requests

One fixture, the synthetic OpenCode 2 binding with session name `s1`, owned by
`prefrontal-core`, on an empty store and a fixed clock. Run ids derive from the
fixed session, the session's history lineage (the id of its current transcript) and
the send id. No member is normalized. `SHA256SUMS` covers
the seven JSON bodies and this README, but not itself.

The stand-in refuses every hand-over before its ledger records it, as an adapter
does that can't take the prompt: nothing left the module. The runner hands the
send over once more itself, under a new delivery id; that is refused the same way,
and the send ends `not_delivered`.

| File | Operation | What it is |
| --- | --- | --- |
| `01-send-reply-pending.json` | `session.send` | The first reply, before hand-over: `pending` with a `submission_id` and the run id committed with the send. |
| `02-send-status-not-delivered-handover-failed.json` | `session.send_status` | After the second refused hand-over: `state: "not_delivered"`, `reason: "handover_failed"`, the `run_id` the send was given. |
| `03-send-resend-same-id-not-delivered.json` | `session.send` | The identical request again: the same answer, and no hand-over. |
| `04-run-status-handover-failed.json` | `run.status` | The send's run: `error`. |
| `05-run-result-handover-failed.json` | `run.result` | The send's run: `error` with `class: "handover_failed"`, `cause: "nothing_written"`, `provider_code: "provider_error"`, no model step. |
| `06-run-ended-event-handover-failed.json` | `session.subscribe` | The session event announcing that run's end (`run_finished`, `reason: "error"`), as served from the start of the stream. |
| `07-send-status-not-delivered-withdrawn.json` | `session.send_status` | The same send with `reason: "withdrawn"`. No code path ends a send `withdrawn` yet: the test sets that reason in the send's stored mark, so readers can check the reason before any runner emits it. |

The `session.send` requests are
`{"prompt":"Synthetic prompt never handed over","send_id":"never-handed","model":{"provider":"anthropic","model":"claude-opus-5"}}`.
The status requests contain only `"send_id":"never-handed"`; the run requests only
the `run_id` of file 02.

File 01 is the first send of the session, so every send reply carries the
session's `baseline` (llm-runner's `baseline` member, which every reply to a
session's first send carries; it is not part of the `not_delivered` change).

## Re-recording

```sh
cargo test --locked -p thalamus-harness-module --features test-support --lib send_not_delivered_bodies_are_pinned
```

Set `THALAMUS_RECORD_DIR` to a directory (relative to the repository root, or
absolute) to write the JSON files and `SHA256SUMS` there instead of comparing.
Publish a new version instead of replacing version 2 once another module pins
its checksums.

## Synthetic-data review

All requests, session references, send ids and message text are synthetic. No
real agent host, user account, login or live store is used.
