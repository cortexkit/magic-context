# mc-app-read-samples-v20

The phone now reads `context.states`. Through Callosum it gets the reads it
had before (`session_data.read`, `context.cache_why`, `context.search` and
`context.watch`) and `context.states`, on the unscoped `ManagementSurface`
target `{module_id: "magic-context"}` or on the internal service. The caller
is stamped by the daemon as `reserved:callosum`, and its bind harness starts
with `fed-phone:`. The phone gets the per-part token counts and stamp states
of the messages it names, never their text. Every other read the remote
desktop gets (a `fed-app:` harness) is still refused to the phone with
`unknown_method`. The desktop reads `context.states` exactly as before.

| Family | Phone | Remote desktop also gets |
| --- | --- | --- |
| Session context | `session_data.read`, `context.states`, `context.cache_why`, `context.search`, `context.watch` | `context.head`, `context.head_section`, `context.compartment` |
| Memories | | `memories.stats`, `memories.page`, `memories.get` |
| Observations | | `observations.page` |
| Candidate facts | | `facts.page` |
| Dreamer | | `dreamer.status`, `dreamer.runs`, `dreamer.run` |
| Sessions | | `sessions.page` |
| Notes | | `notes.page` |

The role version and the request and reply shapes are unchanged. Every v19
JSON sample is copied byte for byte. v20 adds two phone exchanges, each
showing the bound `route` separately from the wire `request` and `response`:

- `fed-phone-context-states.json` asks for one assistant message with two
  tool calls. The agent stamped the `read` call with `ctx_reduce`, which
  queues it to be dropped, and kept the `grep` call. In `items`, each call
  has its `tokens` and its `state` (`stamped` and `live`); `stamped_parts`
  adds the stamped call's size and the time it was stamped.
- `fed-phone-context-states-unchanged.json` sends the first reply's `version`
  back as `if_version` and gets `state: "unchanged"` with no rows.

Ask by message id: `message_ids` takes at most 100 ids per read, and the
reply has one row per id in the order asked, with an `outside` row for a
message the ck-mc module holds no row of. Match each item to the part on
screen by `part_ref.part_key`.

The message comes from a sample session of its own (`s-tools`), because the
shared sample session has no stamped tool call and changing it would change
v19's samples. The samples go through app admission and dispatch against a
temporary fixture store. The generator fixes the reply's `as_of_ms`; it adds
no fields to the wire reply.

Regenerate from the workspace root:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib transport::app_relay_tests::samples_v20 -- --exact
```

Use an output directory instead of `1` for a read-only checkout. Without the
variable, the test checks every sample and the sorted JSON-only `SHA256SUMS`.
See the [v19 notes](../mc-app-read-samples-v19/README.md) for the previous
examples and their wire contracts.
