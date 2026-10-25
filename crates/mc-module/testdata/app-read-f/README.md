# Cache reasons and the future async usage join

`context.cache_why` reports decisions and reasons, not ASTRO usage measurements.
The standalone lookup uses the host assistant-message id stored in
`transform_decisions.message_id`, scoped by session and harness. A missing row
means `no_decision` unless the supplied step time predates the oldest retained
row, in which case it means `not_retained`. `no_decision` cannot distinguish a
pass that changed no cache bytes from a lost best-effort decision-log write.

## Async decisions are not runner-step decisions

The current provider contract retired `compaction.step`. It prepares views from
transcript notices and serves them through `view.get` and `compaction.ride`.
There is no step request id to attach to the transform's scheduler observation.
The setup request id and the lineage id do **not** identify a producing assistant
message and must never be used as ASTRO join keys.

For mode-3 sessions the response therefore carries:

```json
{"producer_ref_kind":null,"join":"unavailable","join_reason":"runner_step_identity_not_recorded"}
```

Window reads return scheduler reasons with `producer_ref: null`. Producer reads
return no matched decisions and classify the requested missing references against
the retention floor as usual. A producer request's timestamp is never used to
infer a matching step. Standalone replies say `join: "available"` and have a null
`join_reason`; unmanaged replies have both fields null.

A future per-step join requires the runner to identify the step that actually
applied a prepared view, for example by including the host assistant-message id
in its `applied_view_version` acknowledgement. ASTRO and the runner must agree on
that identity before ck-mc persists it. This is a runner-contract change, not a
reason to add an unpopulated observation field now. No transform, provider, store
schema, or scheduler-observation code changes accompany this operation.

## Cursor positions

Standalone paging still orders by `(ts_ms, message_id)` descending. To keep an
opaque base64url cursor below 512 bytes even for a 512-byte message id, it carries
the rowid and timestamp plus the first 16 bytes of SHA-256(message_id). On resume,
an indexed INTEGER PRIMARY KEY read resolves the message id; session, harness,
timestamp and hash must all match. A missing or reused rowid is `cursor_invalid`,
not a nearby position. Filters, session and resolved store namespace are bound to
the cursor. Mode-3 uses numeric scheduler sequence positions, not rowids.

The existing retention index provides the standalone timestamp range. SQLite may
use a temporary sort for equal-time message ids; it still searches the named
index and never scans the table. Scheduler history searches the primary-key
session/kind prefix and sorts at most 256 rows.

## Regression checks

Tests live beside the handler in `src/app_read/cache_why.rs`, using the shared
throwaway `TestStores` helper. They cover the host-assistant join, retention and
missing rows, canonical causes and frozen-release detail, nested unknown keys,
request bounds, inclusive paging, maximum-size ids, deleted/reused rowids,
query-only snapshots, mode-3 window-only answers, and indexed query plans.
