# App read samples (`mc-app-read`, role version `v1`)

Recorded exchanges for the Alfonso phone (CKIOS) and desktop (CKDESK)
decoders. Every file was produced by the real ck-mc handlers through the
real dispatch. Unary samples use a `Direct` bind with no scope admitted with
`app_read.allow_direct` on, then the request bytes go through
`app_read::handle`. Watch samples use the daemon/provider/consumer subscription
path through `McHandler`, including management wrapping. Nothing here is
hand-written.

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

The `mc-app-read-samples-v3` collection adds `token-breakdown-host-pass.json`.
The v1/v2 tags are unchanged, and this change preserves all existing JSON
exchanges in the checkout byte-for-byte. The tag version names a sample
collection, not a new role or envelope schema version.

- `session_data.read/meta.json`: the session row plus
  `compartment_count`, `newest_compartment_at_ms` and `queued_stamp_count`
  (one compartment, one listed queued stamp; a queued drop inside the
  summarized message is not a listed stamp, as on `context.states` pages).
- `session_data.read/token-breakdown-provider.json`: a pass with a
  provider-reported input total (`total.source: "provider"`).
- `session_data.read/token-breakdown-estimate.json`: no provider total, so
  the legacy estimate stands in (`estimation_source: "legacy_estimate"`).
- `session_data.read/token-breakdown-host-pass.json`: standalone pass counts
  maintained by the host plugin, with provider usage still supplying `total`.

### Token-breakdown response fields

`as_of.at_ms` remains the last provider-response completion time; it does not
date the plugin's measurements. A versioned, threshold-maintained host payload
adds `measured_at` (Unix milliseconds of the pass that saved the counts) and
`tolerance: {"ratio": 0.01, "tokens": 500}`. Every subsequent served pass compares
its counts to the saved values: a part moving by **more than 1% or 500 tokens**
causes one replacement of the compact latest value, never a per-pass row.
Unchanged counts do not refresh `measured_at`. Counts may therefore remain useful
long after that timestamp; they are approximate, not a claim of same-response
measurement. The stored `session_render_cache` value at cache key
`host_token_breakdown` must have `version: 1`; missing or unsupported stored
versions fall back to the legacy response. This stamp is internal storage
metadata, not an extra wire-schema version. Plugin-disabled sessions cannot
advance these saved estimates.

The row's `estimation_source: "host_pass"` means host attribution is available.
Each newly attributed part also has `estimation_source: "host_pass"`; an
unmeasured part stays null with `estimation_source: "legacy_estimate"`. Older
rows without a usable payload retain their previous shape exactly. All part
counts remain estimates, not provider-reported per-part usage. The host reuses
the existing conversation total, including the last user message:
`last_user_message_in_history_raw: true` explains why `last_user_message` is 0
and that message is included in `history_raw`, not counted twice. `unattributed`
is `max(0, total.tokens - sum(non-null part tokens))`.

Remaining session-data samples:
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

## `context.watch`

`context.watch` uses a held-open subc subscription. Each StreamData payload is a
cursor-only invalidation, not a unary read response: notices carry session
references, **no content** (no rows, messages, summaries or token counts). Read
the affected sessions with the app-read methods to refresh the UI. Management-surface consumers
unwrap `{"result": <notice>}` just as they do the other phone reads. The cursor's
fixture epoch is pinned to `abc`; production epochs change with the handler. The
fixture drives refreshes explicitly to avoid background observer timing races;
all requests and served notices/refusals still traverse real dispatch.

The first notice is always immediate: without `params.cursor` it is `resync`
listing all watched sessions. A still-replayable cursor instead produces one
`changes` notice listing the watched sessions changed since that cursor, possibly
an empty list if already current. Subsequent notices invalidate changed sessions;
an observer rescan can also send `resync`. A cursor identifies the hub epoch and
invalidation version, not a content snapshot or read version. Treat it as opaque
and retain the last received cursor. Replay requires the same epoch, retained
history, no intervening resync barrier, and continuous observation of every
requested session (another subscriber must keep it observed while disconnected).
An old, unknown or otherwise unresumable cursor is not a refusal: it yields
`resync`. On **every `resync`, re-read all listed sessions**; do not apply it as a
content delta. On **`lagged`, reconnect with the last received cursor** and follow
the new first notice, which can require a re-read.

### Normal end

Cancellation or closure of the hub's notice channel ends forwarding without an
additional application frame (`HandlerOutcome::Streamed`); an emit failure also
ends forwarding silently. There is no end-notice JSON sample. The transport can
signal subscription completion separately. A lagging subscriber instead ends
with the named `lagged` error frame, not a final notice.

### Recorded cases

- `context.watch/resync.json`: original first subscription, requiring a re-read.
- `context.watch/changes.json`: a committed historian-progress update invalidates
  the watched session, without embedding rows.
- `context.watch/refusal.json`: the caller already holds eight watches and receives
  `watch_limit_exceeded` before any notice.
- `context.watch/first-no-cursor.json`: first notice without a cursor is `resync`.
- `context.watch/first-valid-cursor.json`: first notice with a replayable older
  cursor is `changes`, coalescing the changes since that cursor.
- `context.watch/first-current-cursor.json`: first notice with the current cursor
  is `changes` with an empty `sessions` list, not silence.
- `context.watch/first-stale-cursor.json`: a cursor before a resync barrier gets
  `resync`, even with the current epoch and retained history.
- `context.watch/first-unknown-cursor.json`: an unknown epoch gets `resync`.
- `context.watch/management-first-no-cursor.json`: wrapped first `resync` notice.
- `context.watch/management-changes.json`: wrapped subsequent `changes` notice.
- `context.watch/refusal-lagged.json`: terminal `lagged`, with the exact message
  instructing the subscriber to reconnect with the last received cursor.
- `context.watch/refusal-watch-unavailable.json`: `watch_unavailable` when an open
  database's original path cannot be observed. The OS error text is recorded on
  Linux; other platforms may phrase the underlying error differently.
- `context.watch/refusal-store-unavailable.json`: `store_unavailable` before the
  serving store is open.
- `context.watch/refusal-unknown-session.json`: `session_not_found`.
- `context.watch/refusal-runner-mismatch.json`: `session_runner_mismatch`.
- `context.watch/refusal-ambiguous-session.json`: `session_ambiguous` when two
  conversations match the harness/session.
- `context.watch/refusal-invalid-params.json`: `invalid_params` for a non-array
  `sessions` value.
- `context.watch/refusal-empty-sessions.json`: `invalid_params` for no sessions.
- `context.watch/refusal-too-many-sessions.json`: `invalid_params` above 32 sessions.
- `context.watch/refusal-duplicate-session.json`: `invalid_params` for duplicates.
- `context.watch/refusal-unknown-param.json`: `invalid_params` for unknown fields.
- `context.watch/refusal-invalid-session.json`: `invalid_params` for a bad session
  reference field.
- `context.watch/refusal-cursor-type.json`: `cursor_invalid` for a non-string cursor
  (also used for empty or over-512-byte strings).
- `context.watch/refusal-cursor-syntax.json`: `cursor_invalid` for malformed
  `<epoch>:<version>` syntax, distinct from a well-formed but unknown cursor.

Refusals before streaming carry no initial notice. Admission policy and common
request-envelope limits still apply on both surfaces; management errors are not
wrapped in `result`.
