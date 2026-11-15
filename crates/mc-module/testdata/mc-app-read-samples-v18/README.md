# mc-app-read-samples-v18

Examples for the internal `mc-app-read/v1` service, which the CortexKit apps call
to show a session's context. v18 is v17 with three examples added; every v17 file
is copied byte for byte. The callers, the version and the `{"result": ...}`
envelope are as [the v15 notes](../mc-app-read-samples-v15/README.md) describe.

## What changed from v17

- **New request form, `context.cache_why {session, views}`.** Each step event
  of the runner now carries `view_version`, the version of the view the request
  was rendered with. When two consecutive steps of a session name different
  versions, the view changed; this read answers why ck-mc built each one.
  `views` is a list of 1 to 100 distinct view versions (non-negative integers).
  The reply is:
  - `state`: `"ready"`;
  - `decisions`: one record per requested version that ck-mc built and still
    keeps, in ascending version order, with `view_version`, `view_checksum`,
    `at_ms` (when ck-mc offered the view), `cause`, `status`, `dropped_count`,
    `dropped_tokens`, `emergency`, `materialized` (the view folded the history
    head again), `input_tokens`, `changes` and `identity_delta`;
  - `missing`: the requested versions with no record, in ascending order:
    ck-mc never built that version (another provider's view, or a version that
    never existed), or its record is older than the retention period;
  - `retention`: `days` (30), how long a record is kept after its view was
    offered, and `oldest_at_ms`, the `at_ms` of the oldest record ck-mc still
    keeps for the session (`null` when it keeps none).

  `cause` is one of `over_limit`, `cache_lost`, `history_changed`,
  `history_refresh`, `execute` and `explicit_flush`. The list can grow: read a
  value you don't know as "other". `status` is the view's latest known state:
  `offered`, `accepted`, `applied`, `refused` or `undelivered`.

  A request is refused `invalid_params` when `views` is empty, names more than
  100 versions, names one twice or names anything but a non-negative integer,
  and when it names both `views` and `producers`.
- **The `producers` form is unchanged.** `{session, producers}` is answered
  exactly as before (`cache-why.json`, copied from v17), until the apps have
  moved to the `views` form; it will then be removed.
- **Added samples.** `cache-why-views.json` (a record of every cause and every
  status, one with a cause the apps don't know yet, `some_future_cause`, and one
  version listed as missing), `cache-why-views-missing.json` (a version ck-mc
  never built) and `cache-why-views-too-many.json` (the refusal of 101
  versions). The records are made by a test session through the module's own
  paths and read at the fixed time every example's envelope names; regenerate
  them with `MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module
  --lib app_read::samples_v18_tests::samples_v18 -- --exact`.

For every other example, see [the v17 notes](../mc-app-read-samples-v17/README.md)
and the earlier sets they link to; those examples are unchanged.
