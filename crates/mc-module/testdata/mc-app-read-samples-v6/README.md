# mc-app-read-samples-v6

The six `mc-app-read/v1` app operations, including watch StreamData, generated
from ck-mc's app-read handlers. Routes, role versions, refusals, envelopes and
existing response fields are unchanged from `mc-app-read-samples-v5`. The v5
files remain frozen and pinned independently; there is no v6 git tag yet.

Additions:

- `context.states.messages[].items` lists parts in transcript order. Each item
  has `part_ref.part_key`, `kind`, `tokens`, `source` (`runner`, `counted`, or
  `estimate`) and `state` (`live`, `stamped`, or `dropped`). Only tool items have
  `tool`. Tool tokens describe the result, not the input. Removed parts have
  zero tokens; replacements count their visible placeholder. Unknown archived
  messages and older stored rows without part attribution have empty lists.
- `session_data.read` with `section: "token_breakdown"` adds `row.items`.
  System prompt and tool definitions use the runner's counts of those fixed
  prompt sections, or null when absent. Memory, project docs and user profile
  use cached counts of their blocks in the synthetic messages at the start of
  the model's context (the history head). Each rendered summary adds an item
  with `compartment_id`, numeric `tier` and its count in the session model's
  tokenizer. A summary's count covers only its own rendered text, not the
  `<session-history>` tags that enclose all summaries, so the items can sum to
  a little less than the head's history total. A summary archived by the
  renderer has no item.
  Unmanaged sessions have an empty list.

The examples include counted text, a runner-counted tool result, stamped and
wholly dropped parts, unknown archived messages, and a rendered summary. Opaque
versions change when the additive response body changes. All existing aggregate
breakdown parts retain their previous semantics, including `estimate` flags.

`app_read::tests::samples_v6` generates the complete served JSON, normalizes only
`as_of_ms` and the watch cursor, and compares sorted JSON-only `SHA256SUMS`.
Regenerate deliberately (from the workspace root):

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib app_read::tests::samples_v6 -- --exact
```

App snapshots in `mode3.db` are saved at checkpoints and, when message rows have
changed, on the first update at least 60 seconds after the last successful save.
Ordinary notices still append message identities incrementally. The stored head
baseline adds a default-empty `summary_items` field; older baselines and app
snapshots load without a migration. Older baselines gain summary attribution on
the next head rebuild rather than reconstructing tiers during an app read.
