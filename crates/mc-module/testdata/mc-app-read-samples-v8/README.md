# mc-app-read-samples-v8

The six `mc-app-read/v1` app operations and watch StreamData, generated from
ck-mc's app-read handlers. Routes, role versions, refusals and envelopes are
unchanged. The v5 through v7 sample folders remain frozen and checksum-pinned.

## User text origins

Every user-role text item in `context.states` carries `origin`:

- `{ "kind": "person" }` for an entry with no runner notice mark.
- `{ "kind": "notice", "sender": "prefrontal" }` for a runner-marked notice.
  `sender` is the runner's notice sender, not a display name inferred from text.

The field stays on stamped, dropped and summarized text items. Other roles and
part kinds omit it; an archived row with no per-part metadata has no items.
The fixture's `m1` is a person's message; `m3` is a dropped notice from
`prefrontal`. Neither sender nor template changes the entry's user role.
A notice's `keep` mark prevents automatic age reclaim; it does not turn that
notice into a person's message or change its origin label.

## User text categories and token sources

The token breakdown splits user text out of `history_raw` into `user_messages`
and `notices`, appended after the existing categories. `history_raw` retains
assistant text, files and other non-tool/non-reasoning content. The legacy
`last_user_message` category remains zero, and
`last_user_message_in_history_raw` is false. This split changes attribution,
not the total or how tokens are measured.

Each category's `estimate` label reflects the provenance of its tokens: it is
false when all contributing tokens are `runner` or `counted`. Categories with
`reported` or `estimate` contributions remain estimates. Missing surface counts
remain null and estimated; runner surface counts retain the runner's explicit
exactness flag. Empty categories have no estimated tokens. The same rules apply
to the new `user_messages` and `notices` categories.

The header's `estimation_source` is the source contributing the most tokens,
using `runner`, `counted`, `reported` and `estimate`. Ties favor the less exact
source in that order. The provider-reported prompt total remains independent:
unattributed tokens do not invent a source. Provenance is updated alongside
cached message counts, including removals and late runner measurements, without
walking the entire transcript per notice.

The breakdown's `items` still describe only the system prompt, tool definitions,
memory, project docs, user profile and injected history summaries. Apps use
`context.states` for transcript part items and their origins.

## Changes from v7

- `states.json` adds person origin to `m1/p` and notice origin to `m3/p`.
- `token-breakdown.json` adds `user_messages` and `notices`, and sets
  `last_user_message_in_history_raw` to false. The fixture's person text has a
  published summary but has not been cut from the served view, so its 3 tokens
  move from `history_raw` to `user_messages`. The dropped notice contributes
  zero tokens; `history_raw` becomes 3.
- Category `estimate` values and the dominant-source label now reflect token
  provenance. The fixture's dominant source is `runner`.
- Content-derived versions and `SHA256SUMS` change with those two JSON files.
  All other operation samples remain byte-identical to v7.

`app_read::tests::samples_v8` generates the complete served JSON, normalizes only
`as_of_ms` and the watch cursor, and compares sorted JSON-only `SHA256SUMS`.
Regenerate deliberately from the workspace root:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib app_read::tests::samples_v8 -- --exact
```

On a read-only checkout, set `MC_REGENERATE_APP_READ_SAMPLES` to an output
directory instead of `1`, then copy the generated JSON and checksums into this
folder. Run the test without the variable to verify the checked-in samples.
