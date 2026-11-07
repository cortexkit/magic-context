# mc-app-read-samples-v7

The six `mc-app-read/v1` app operations, including watch StreamData, generated
from ck-mc's app-read handlers. Routes, role versions, refusals and envelopes
are unchanged. The v6 files remain frozen and independently checksum-pinned.

Reasoning attribution now uses the same per-assistant-entry replay cost as
reasoning clearing: the runner's count (including zero), then a nonzero provider
step count, then the visible-size estimate, or 1,000 tokens for sealed reasoning
with no visible text. Live reasoning items use `source: "runner"`, `"reported"`
or `"estimate"` respectively. Each entry's cost is split in proportion to visible
bytes; opaque-only entries split evenly. The last part receives any rounding
remainder. Removing a part zeros its share without redistributing it. Cleared
reasoning placeholders also count zero. A published summary does not remove
reasoning until the served view cuts it, just like the rest of the transcript.

The breakdown adds `reasoning` immediately after `tool_calls_results` and excludes
reasoning from `history_raw`. Its aggregate `estimate` flag remains conservative,
as the session can mix measured counts and estimates. Message rows reuse cached
shares until content or counts change; late runner reasoning counts update only
the affected entry.

Exact JSON changes from v6:

- `states.json`: `response.result.messages[1].items` appends two live reasoning
  items, `reasoning-a` and `reasoning-b`, with runner-attributed weights 333 and
  668. `response.result.version` changes accordingly.
- `token-breakdown.json`: `response.result.row.parts[8]` is the new
  `{ "part": "reasoning", "tokens": 1001, "estimate": true }` entry.
  The unchanged `last_user_message` entry moves from index 8 to 9.
  `response.result.version` changes accordingly. The fixture adds reasoning only
  in v7, so its `history_raw` stays at 6; regression tests separately verify that
  reasoning visible-size estimates no longer inflate that part.
- `cache-why.json`, `compartment.json`, `meta.json`, `search.json` and `watch.json`
  are byte-identical to v6. All other JSON fields are unchanged. `SHA256SUMS`
  updates only the two changed JSON files.

`app_read::tests::samples_v7` generates the complete served JSON, normalizes only
`as_of_ms` and the watch cursor, and compares sorted JSON-only `SHA256SUMS`.
Regenerate deliberately from the workspace root:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib app_read::tests::samples_v7 -- --exact
```
