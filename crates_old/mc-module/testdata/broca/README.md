# Session-send wire fixtures

Historian and dreamer serialize `session.send` directly instead of linking the llm-runner
(Broca) Rust crates. These fixtures record exact queued-send bytes so tests can verify
the request shape.

The `retention` field sets how long a runner keeps a session transcript. For a runner that
declares the group, the first accepted send fixes the session-wide policy: omission keeps
the session indefinitely, and later sends may repeat or shorten a set policy but cannot
opt in after omission or extend it.

| Fixture | Notes |
|---|---|
| `send_request.model_variant_queue.json` | Copied from Broca `crates/broca-wire/tests/golden/send_request.model_variant_queue.json` at commit `f06a487a93d6b6a22a0008bea8d3fb4a036158ac` |
| `send_request.model_variant_steer.json` | Copied from Broca `crates/broca-wire/tests/golden/send_request.model_variant_steer.json` at commit `f06a487a93d6b6a22a0008bea8d3fb4a036158ac` |
| `send_request.model_variant_retention.json` | For a runner declaring retention, the first accepted send freezes the session policy; values are positive integer seconds capped at `max_seconds`. Omission means no expiry, and later sends cannot opt in or extend the policy. This example sets `retention: 86400` seconds (one day). |

The two Broca fixtures are byte-identical copies of the source files listed above and have
no trailing newline. Do not reformat them: the test compares bytes. The retention fixture
orders `prompt`, `send_id`, nested `model`, and top-level `retention: 86400` (an integer
seconds value) like the runner's request. Values are positive and capped at `max_seconds`;
a runner must declare retention before this field is sent, and the first accepted send
fixes the policy.
To refresh the Broca fixtures, copy them unchanged from the Broca repository and update
their source revision.
