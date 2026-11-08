# mc-app-read-samples-v8

The six `mc-app-read/v1` app operations, including watch StreamData, generated
from ck-mc's app-read handlers. Routes, role versions, refusals and envelopes
are unchanged. The v7 files remain frozen and independently checksum-pinned.

Every user-role text item in `context.states` now carries `origin`:

- `{ "kind": "person" }` for an entry with no runner notice mark.
- `{ "kind": "notice", "sender": "prefrontal" }` for a runner-marked notice.
  `sender` is the runner's notice sender, not a display name inferred from text.

The field stays on stamped, dropped and summarized text items. Other roles and
part kinds omit it; an archived row with no per-part metadata has no items.
The fixture's `m1` is a person's message; `m3` is a dropped notice from
`prefrontal`. Neither sender nor template changes the message's user role.

The token breakdown splits user text out of `history_raw` into `user_messages`
and `notices`, appended after the existing categories. `history_raw` retains
assistant text, files and other non-tool/non-reasoning content. The legacy
`last_user_message` category remains zero, and
`last_user_message_in_history_raw` is now false. Counts and estimate semantics
are unchanged; this is attribution, not a new token measurement. The breakdown's
`items` still describe only the system prompt, tool definitions, memory,
project docs, user profile and injected history summaries. Apps use
`context.states` for transcript part items and their origins.

Exact JSON changes from v7:

- `states.json` adds person origin to `m1/p` and notice origin to `m3/p`.
  Its content-derived version changes accordingly.
- `token-breakdown.json` adds the `user_messages` and `notices` categories and
  sets `last_user_message_in_history_raw` to false. The fixture's person text
  has a published summary but has not been cut from the served view, so its
  3 tokens move from `history_raw` to `user_messages`. The dropped notice adds
  zero tokens; `history_raw` becomes 3. Its content-derived version changes accordingly.
- All other sample JSON files are byte-identical to v7. `SHA256SUMS` updates
  only the two changed JSON files.

`app_read::tests::samples_v8` generates the complete served JSON, normalizes only
`as_of_ms` and the watch cursor, and compares sorted JSON-only `SHA256SUMS`.
Regenerate deliberately from the workspace root:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib app_read::tests::samples_v8 -- --exact
```

On a read-only checkout, set `MC_REGENERATE_APP_READ_SAMPLES` to an output
directory instead of `1`, then copy the generated JSON and checksums into this
folder. Run the test without the variable to verify the checked-in samples.
