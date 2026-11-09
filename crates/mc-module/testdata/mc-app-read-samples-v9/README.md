# mc-app-read-samples-v9

The six `mc-app-read/v1` app operations and watch StreamData, generated from
ck-mc's app-read handlers. Routes, role versions, refusals and envelopes are
unchanged. The v5 through v8 sample folders remain frozen and checksum-pinned.

## User text origins

Every user-role text item in `context.states` carries `origin`. There are now
three forms:

- `{ "kind": "person" }` for an entry with no runner notice mark and no
  `speaks_for` mark. This is the person's own message.
- `{ "kind": "notice", "sender": "prefrontal" }` for a runner-marked notice.
  When the runner also marks whose words the notice relays, the origin carries
  `"speaks_for": { "agent_id": "...", "name": "..." }`. `name` is optional.
- `{ "kind": "agent", "agent_id": "...", "name": "..." }` for an entry that
  carries another agent's words with no notice mark, such as a head's brief to
  its worker. `name` is optional.

`sender` is the runner's notice sender. `agent_id` and `name` come from the
runner's `speaks_for` mark (compaction 0.3.3, capability
`compaction-entry-speaks-for/v1`), never from the text. An app that does not
know the `agent` kind should show the item with its notices, never as the
person's words.

The fixture's `m1` is a person's message and `m3` is a dropped notice from
`prefrontal`. `m4` is an agent brief (`BROCA`, no notice mark). `m5` is a
notice from `prefrontal` that relays one agent's post (`SUBC`).

## User text categories

The token breakdown's `user_messages` category counts only `person` text.
`notices` counts notice text and `agent` text, so another agent's words never
count as the person's. Category order, estimate labels and the dominant-source
rule are unchanged from v8.

## Changes from v8

- `states.json` requests `m4` and `m5` too, and shows the `agent` origin and a
  notice origin with `speaks_for`.
- `token-breakdown.json`: `notices` rises from 0 to 9 tokens for `m4` and
  `m5`. `user_messages` stays 3. The content-derived version changes.
- `search.json`: only the content-derived cursor version changes, because the
  session's messages changed.
- `SHA256SUMS` changes with those three files. `cache-why.json`,
  `compartment.json`, `meta.json` and `watch.json` are byte-identical to v8.

`app_read::tests::samples_v9` generates the complete served JSON, normalizes
only `as_of_ms` and the watch cursor, and compares sorted JSON-only
`SHA256SUMS`. Regenerate deliberately from the workspace root:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib app_read::tests::samples_v9 -- --exact
```

On a read-only checkout, set `MC_REGENERATE_APP_READ_SAMPLES` to an output
directory instead of `1`, then copy the generated JSON and checksums into this
folder. Run the test without the variable to verify the checked-in samples.
