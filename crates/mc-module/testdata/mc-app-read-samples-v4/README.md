# mc-app-read-samples-v4

The six mode-3 app reads served by rebuilt ck-mc, role `mc-app-read/v1`.
Requests use the unscoped `InternalService` target `{module_id:
"magic-context", service_id: "mc-app-read"}`. Successes, including watch
StreamData, are inside `{"result": ...}`. Refusals remain protocol errors.
The role declaration may be omitted on this exact target; any declared role
must be `mc-app-read:v1`.

This set replaces `crates_old/mc-module/testdata/app-read-samples/`
(`mc-app-read-samples-v3`) for these six methods only; the role version and
field spellings are unchanged.
Changes from that collection:

- `session_data.read` supports only `meta` and `token_breakdown`. Both now
  return `state` and a content-derived, opaque `version`, and support
  `if_version` (`unchanged` omits `row`). Counts are projections of ck-mc's
  work, not reads of standalone plugin render caches.
- Token parts keep `part`, `tokens`, `estimate`, and memory `count`. Every
  local count is estimated; missing system/tool-definition counts are null.
  The runner's reported prompt total is marked `source: "provider"`.
  The window is the runner-declared context window. No model/tool/system
  identity is invented. `last_user_message_in_history_raw` means `history_raw`
  already counts the last user message, so the separate `last_user_message`
  bucket is zero.
- States retain mode-3 `part_ref.part_key`, nullable drop timestamps, and
  queued stamped parts. Publication alone is not proof a runner applied a
  view: a queued stamp remains until the runner confirms applying it.
  Summaries cover whole entries, so `split` is null. Unknown archived ids
  are `outside` with `outside_reason: "not_indexed"`.
- Compartments retain summary text and four nullable tiers, from `p1` (most
  detailed) through `p4` (briefest). Unavailable
  facts' per-category counts are empty because the rebuilt summary records do
  not retain the older handler's per-compartment fact counts. Dates are null when neither the live
  projection nor the raw-message index retains their timestamps.
- `context.cache_why` reports `join: "unavailable"` and
  `join_reason: "runner_step_identity_not_recorded"`. Compaction 0.2.3
  entries expose `mid` and `generated_under` (view version/checksum), not
  llm-runner 0.8.1's run/step/attempt identity. The stored accepted-view
  decisions cannot safely be joined to an app producer reference. Requested
  producers therefore produce no decisions or missing rows; apps stop
  requesting this lane on the unavailable join. No `cause_detail` is served.
- Search serves only indexed message text, with session-qualified hits,
  UTF-8 byte ranges, and opaque query-bound pagination. It does not search
  tool outputs or reasoning absent from the existing text index.
- Watch retains `resync`/`changes` notices and opaque epoch/version cursors.
  It is driven by session work, not filesystem notifications or polling.
  A stale cursor resyncs, and overflow ends with `lagged`. Limits remain
  eight subscriptions per caller, 32 total, 32 sessions per subscription,
  256 distinct watched sessions, and a 16-notice queue. Direct routes share
  the `direct` quota; phone routes stamped with the same `fed-phone:<device>`
  harness string share one caller quota.

`app_read::tests::samples_v4` generates these exchanges from the app-read
handlers, pins only `as_of_ms` and the watch epoch/cursor, and compares the
complete served JSON and the sorted JSON-only `SHA256SUMS`. Search includes
its first 50 hits and a real continuation cursor. Regenerate deliberately:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test -p mc-module --lib app_read::tests::samples_v4 -- --exact
```

Mode-3 schema version 2 adds `app_read_snapshots` (one live projection per
session) and `app_read_message_index` (runner-qualified message ordinals and
timestamps, retained after a cut and removed on revert). Session work writes
both; the app replica uses independent read-only connections. Accepted-view
decisions are also kept in the session's durable `app.decisions`, bounded at
256 records, with offered/accepted/applied/refused status kept distinct.

Other app methods refuse `app_op_unavailable`; this collection does not
promise compatibility for methods the Alfonso iOS and desktop apps do not call.
