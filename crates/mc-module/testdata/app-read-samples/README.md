# App read samples (`mc-app-read`, role version `v1`)

Recorded exchanges for the Alfonso phone (CKIOS) and desktop (CKDESK)
decoders. Every file was produced by the real ck-mc handlers through the
real dispatch: a `Direct` bind with no scope is admitted with
`app_read.allow_direct` on, then the request bytes go through
`app_read::handle`. Nothing here is hand-written.

Each sample is one JSON object with sorted keys:

- successes: `{"name", "request": {"method", "params"}, "response": {...}}`
  where `response` is the served reply body;
- refusals: `{"name", "request": {...}, "refusal": {"code", "message",
  "detail"}}` where `detail` is `null` for plain `Error` refusals (error
  frames carry no bytes, so the code, message and detail are recorded).

Sample setup pins three volatile values before comparison: `as_of_ms` is pinned to
the fixture clock (`1700000000000`), because the context, search and
cache_why lanes stamp wall-clock time instead of the serving context's
fixed clock; `store.health` database `path` values are replaced with
`<context_db>`/`<store_db>` because they name the throwaway directory. The
`compartment_history_versions.generation` seed is pinned to
`0123456789abcdef0123456789abcdef` in the fixtures that version over it:
production defaults it to `randomblob(16)`, so unpinned versions could never
be byte-stable, while the handlers still digest the stored row exactly as
served. Everything else is byte-exact.

Regenerate: `MC_REGENERATE_APP_READ_SAMPLES=1 cargo test -p mc-module
app_read::samples_tests`. The ordinary run fails if any served bytes
differ, so the samples cannot drift from the handlers. `SHA256SUMS` is
`sha256sum` format, sorted by path; check it before vendoring.

## `context.states`

- `context.states/matrix-standalone.json`: every state (`raw`, `dropped`,
  `summarized`, `outside`), both managed outside reasons
  (`before_first_compartment`, `not_indexed`), and both part lists
  (`stamped_parts` queued, `dropped_parts` with tool, text and file refs).
- `context.states/part-refs-pi.json`: legacy Pi addresses (`text_ordinal`
  for positional text, `content_key` for identity-drift tags, `part_index`
  for a file part) reported as raw drops.
- `context.states/part-refs-mode3.json`: mode-3 runner part keys
  (`part_key`), with a frozen whole-part drop and a queued agent stamp.
- `context.states/split-sides.json`: one partly summarized message per
  split side (`end`, `start`, `middle`); the parts the compartment covers
  are hidden and the rest stay raw.
- `context.states/unchanged.json`: an `if_version` read that matches the
  served version answers `unchanged` without rows.
- `context.states/never-managed.json`: a session the locator never saw,
  with the runner naming its own harness, reports `outside` /
  `never_managed` instead of refusing.
- `context.states/refusal-unknown-session.json`: `session_not_found`
  (a runner that is not the harness cannot take the unmanaged page).
- `context.states/refusal-too-many-ids.json`: 101 ids refused with
  `invalid_params` (`range`, limit 100).
- `context.states/refusal-bad-if-version.json`: a non-string `if_version`
  refused with `invalid_params` (`type`).
- `context.states/refusal-resyncing.json`: a mode-3 conversation in resync
  answers `session_resyncing`.

## `context.compartment`

- `context.compartment/ready.json`: a normal summary range with tiers,
  ordinal/message-id bounds, message times and historian fact counts.
- `context.compartment/missing.json`: an unknown id answers
  `compartment_not_found`.

## `context.search`

- `context.search/refusal-session-not-found.json`: a session Magic Context
  does not manage is refused by the locator with `session_not_found`.
- `context.search/hits.json`: message hits with snippets, match ranges,
  compartment joins and per-source status.
- `context.search/no-hits.json`: a query that matches nothing answers an
  empty, complete page.
- `context.search/project-lanes-unavailable.json`: a session with no
  recorded project leaves the project lanes `unavailable` in
  `diagnostics.project_resolution`.

## `context.cache_why`

- `context.cache_why/standalone-producers.json`: standalone decisions
  joined by host assistant message id, with retention floors, limits, error
  state and `missing` reasons (`no_decision`, `not_retained`).
- `context.cache_why/mode3-window.json`: a mode-3 scheduler window with
  `join: "unavailable"` and `join_reason:
  "runner_step_identity_not_recorded"`.

## `session_data.read`

- `session_data.read/meta.json`: the session row plus
  `compartment_count`, `newest_compartment_at_ms` and `queued_stamp_count`
  (one compartment, one listed queued stamp; a queued drop inside the
  summarized message is not a listed stamp, as on `context.states` pages).
- `session_data.read/token-breakdown-provider.json`: a pass with a
  provider-reported input total (`total.source: "provider"`).
- `session_data.read/token-breakdown-estimate.json`: no provider total, so
  the legacy estimate stands in (`estimation_source: "legacy_estimate"`).
- `session_data.read/token-breakdown-unmanaged.json`: an unmanaged session
  answers `managed: {value: false}` with null totals and no parts.
- `session_data.read/token-breakdown-mode3-unavailable.json`: a mode-3
  session's breakdown is behind the unserved async index
  (`app_op_unavailable`).

## `project_memory.read`, `dreamer.read`, `store.health`, `config.read`

- `project_memory.read/memories.json`: one ordinary memories page.
- `dreamer.read/schedule.json`: one ordinary schedule page.
- `store.health/healthy.json`: one ordinary health row (paths normalized).
- `config.read/effective.json`: the effective config with secrets redacted.
- `config.embedding_probe/disabled.json`: no embedding is configured, so
  the probe refuses with `embedding_disabled`.

## Live context subscription

`context.watch` uses a held-open subc subscription. Each StreamData payload is a
cursor-only invalidation, not a unary read response. Management-surface consumers
unwrap `{"result": <notice>}` just as they do the other phone reads. The cursor's
fixture epoch is pinned to `abc`; production epochs change with the handler.

- `context.watch/resync.json`: first subscription (or an unresumable cursor),
  requiring the app to read its watched sessions.
- `context.watch/changes.json`: a committed historian-progress update invalidates
  the watched session, without embedding rows.
- `context.watch/refusal.json`: the caller already holds eight watches and receives
  `watch_limit_exceeded` before any notice.
