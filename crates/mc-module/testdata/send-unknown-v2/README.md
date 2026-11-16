# Send replies with an unknown delivery outcome, version 2

These are synthetic `llm-runner/v1` reply bodies for clients that display message
delivery. An unknown delivery means the runner cannot prove whether the host took
the message. It is a final receipt, not permission to submit the message again.
The run's state and the message's delivery outcome are separate facts: read both
`state` and `delivered.as`, rather than interpreting the run state alone as proof
that a message landed.

Version 1 remains unchanged beside this set. Version 2 changes only the first
head reply: it is pending with its stored run id before host hand-over, rather
than active after hand-over. The terminal unknown and joining-steer JSON bodies
are unchanged.

The original version 1 recording used runner commit
`a7feefc5ff50ac4bb2d7bd95ccde379aa71202ba`. The first reply now records durable
acceptance before host hand-over: `pending` with its recorded run id. The unit test
`send_unknown_reply_bodies_are_pinned` dispatches real runner operations through
an in-memory stand-in host. Each response is parsed only for assertions; its
returned text is saved exactly, without reformatting or an added newline.
The workspace declares `serde_json = "1"` without `preserve_order`, so parsing and
pretty-printing would not be a key-order-preserving recording. Parsing is used
only to check the replies, never to produce the files.

## Files and requests

Both fixtures use the synthetic OpenCode 2 binding with session name `s1`, owned
by `prefrontal-core`. Each fixture starts with an empty store and the same fixed
clock. The stand-in numbers its native sessions and messages deterministically;
the runner derives run IDs from the fixed session, lineage and send ID. No
member is normalized. `SHA256SUMS` covers the eight JSON bodies and this README,
but not itself.

| File | Operation | Purpose |
| --- | --- | --- |
| `01-head-send-reply.json` | `session.send` | Initial reply for a run-starting send whose handoff is unresolved. |
| `02-head-send-status-unknown.json` | `session.send_status` | Head send after its delivery becomes final unknown. |
| `03-head-send-resend-same-id.json` | `session.send` | Identical head request after unknown; the recorded result is returned without another handoff. |
| `04-steer-send-reply.json` | `session.send` | Initial reply for a steer into a running run whose handoff is unresolved. |
| `05-steer-send-status-unknown.json` | `session.send_status` | Steer after its delivery becomes final unknown. |
| `06-steer-send-resend-same-id.json` | `session.send` | Identical steer request after unknown; no second handoff. |
| `07-head-send-status-pending.json` | `session.send_status` | A run-starting send still waiting behind a running run. |
| `08-head-send-status-delivered.json` | `session.send_status` | A run-starting send with confirmed delivery. |

| Files | `state` | Delivery member | Other identifying member |
| --- | --- | --- | --- |
| 01 | `pending` | `delivered` absent: not yet handed over | `run_id` and `submission_id` |
| 02, 03 | `finished` | `delivered.as: "unknown"`; no `delivered.ref` | Same `run_id` as 01 |
| 04 | `active` | `delivered` absent: not yet confirmed | Running head's `run_id` |
| 05, 06 | `active` | `delivered.as: "unknown"`; no `delivered.ref` | Same `run_id` as 04 |
| 07 | `pending` | `delivered` absent: still waiting | `submission_id`; no `run_id` |
| 08 | `active` | `delivered.as: "turn"` | `delivered.ref` equals `run_id` |

The head run ends when its initial delivery cannot be confirmed; the steer does
not end the run it joined. Thus `active` is not proof of delivery, and `finished`
is not proof of non-delivery. The pending submission ID is the runner's opaque
sender-qualified string, not the caller's unqualified `send_id`.


All `session.send` requests include
`"model":{"provider":"anthropic","model":"claude-opus-5"}`. The head-unknown
request adds `"prompt":"Synthetic head prompt","send_id":"head-unknown"`.
The steer request adds `"prompt":"Synthetic steer prompt",`
`"send_id":"steer-unknown","delivery":"steer"`.
Each status request contains only the corresponding `send_id`.

The second fixture first sends
`"prompt":"Synthetic running prompt","send_id":"head-delivered"` and
observes its confirmed landing; file 08 is that send's status. It then submits
`"prompt":"Synthetic waiting prompt","send_id":"head-pending",`
`"delivery":["idle_start"]` for file 07, before submitting the steer. Replay requests in files 03 and 06 repeat the
original request parameters exactly.

For each unknown outcome the stand-in's `park_next_delivery` seam accepts the
message without storing or confirming it. File 01 is recorded before hand-over;
file 04 is a joining steer whose hand-over has returned. Neither proves delivery.
Observation starts reconciliation; the
test advances its synthetic clock past `DELIVERY_RECONCILE_WAIT_MS` and observes
again. Files 02 and 05 are then read through `session.send_status`. The replay
checks assert that the host's counter and parked messages do not change.

## Re-recording

Run the filtered unit test to compare newly dispatched bodies byte for byte with
these files:

```sh
cargo test --locked -p thalamus-harness-module --features test-support --lib send_unknown_reply_bodies_are_pinned
```

Set
`THALAMUS_RECORD_DIR=crates/thalamus-harness-module/test-vectors/send-unknown-v2`
to rewrite the JSON files and `SHA256SUMS` from the test. The destination is
relative to the repository root. To record on a read-only
checkout, select a new output directory and collect its files instead. Publish a
new version instead of replacing version 2 after
another module pins its checksums.

## Synthetic-data review

All requests, session references, send IDs and message text are synthetic. All
files were checked for personal names, email addresses, host names and
machine-local paths before publication. No real agent host, user account, login,
or live store is used.
