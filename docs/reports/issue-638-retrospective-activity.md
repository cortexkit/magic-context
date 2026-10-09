# Issue 638: retrospective activity without host events

Thanks to @salacoste for the SDK/stdio bridge reproduction and workaround.
Investigation used source and throwaway test stores only; no live stores or user
configuration were opened, read, written or migrated.

## Findings

The reported lock is reproducible. At base `30f43e7`,
`packages/plugin/src/features/magic-context/dreamer/task-gates.ts:105-126`
counts all project sessions with a null watermark, but requires an inner join to
`retrospective_activity:<session>` once the watermark exists. Both the gate
(now `task-gates.ts:602-608`) and backlog (`task-gates.ts:440-446`) call that helper.
The executor returns the scanned content frontier, not completion time
(`dreamer/task-executor.ts:1411-1430,1743`); schedule storage preserves it
(`dreamer/storage-task-schedule.ts:246-258`). An empty ledger therefore explained
both permanent skips and the false zero backlog after a partial scan.

The ledger is **not Pi-only in this checkout**:

* Pi/OMP: `packages/pi-plugin/src/index.ts:2761,2804` observes `message_end`;
  `src/dreamer/session-activity-pi.ts:8-14,26-40` delegates to the shared observer
  and backfills timestamps from session entries. The shared observer writes the
  first event immediately and coalesces subsequent events over 15 seconds
  (`packages/plugin/src/features/magic-context/session-activity.ts:48-80`).
* OpenCode 1: `packages/plugin/src/hooks/magic-context/event-handler.ts:494-507`
  observes user and assistant `message.updated`; `packages/plugin/src/index.ts:505-512`
  backfills from native `message.time_created`.
* OpenCode 2: `packages/plugin/src/v2/hooks/dream-trigger.ts:39-58` writes native
  root-session activity on each successful execution before scheduling.
  `src/v2/hooks/context.ts:930-943` also boot-backfills native message times.
  Its raw provider reads native user activity independently of the ledger
  (`src/v2/retrospective-raw-provider.ts:33-45`). It does not depend on Pi events.
* Rust: no `retrospective_activity` writer exists under `crates/`. The module's
  `dreamer.run_task` route currently accepts classification, not retrospective
  (`crates/mc-module/src/lib.rs:11979-11994`). Rust-mode hosts retain the above
  host activity wiring; OC1 schedules indexing before the Rust dispatch
  (`packages/plugin/src/hooks/magic-context/transform.ts:825-829,1014`). A custom
  bridge without that wiring must not be assumed to have the ledger.

## Rule and coverage

Use the ledger when present, otherwise `message_history_index.updated_at`, **per
session**, for both the gate and backlog (`task-gates.ts:105-132`). Do not use
`session_projects.updated_at`: it records binding creation/change, not turns;
same-project observations deliberately leave it unchanged
(`session-project-storage.ts:37-42`). The index has one primary-key row per session
(`storage-db.ts:1711-1717`), so the fallback needs no message scan or migration.

OC1 queues indexing for each terminal user/assistant message
(`hooks/magic-context/hook-handlers.ts:342-356`). Pi/OMP queues each user turn
(`packages/pi-plugin/src/context-handler.ts:2768-2780`) and ended assistant reply
(`src/index.ts:2805-2812`, `src/message-end-index-pi.ts:46-70`). The shared writer
updates index progress time for new/revised messages and reconciliation pages
(`packages/plugin/src/features/magic-context/message-index.ts:109-118,466-480,643-677,814`).
OC2 does not run that OC1 index lane on each turn: it maintains the native activity
ledger described above instead. The headless bridge's fresh index, supplied in
the report, is sufficient without any host event or boot-backfill requirement.

Index time is conservative activity evidence, not the exact newest user-message
timestamp. Reindexing can cause an extra empty scan in ledger-free deployments;
the raw provider still owns the content watermark. Existing ledger deployments
retain their precision even if index maintenance occurs much later. Recent-input
seeding/pruning uses the same fallback (`task-gates.ts:261-283`) so an old binding
does not age an actively indexed bridge out of scheduling.

Both SDK regressions failed against the original helper (gate false, backlog
zero), then passed. Tests cover two real indexed turns without ledger writes,
persisted watermarks, equality boundaries, partial backlog, other projects,
binding-only changes, mixed hosts and Pi ledger precedence. Mutation controls
individually reddened the SDK gate, backlog, scheduling-retention and Pi-precision
tests. Native `bun run test` passed: plugin 7,318 tests (6 skipped), Pi 1,625 tests
(3 skipped). Plugin/Pi typechecks and lint passed. Remote suite attempts had
environment failures (Git dubious ownership and missing `/proc/mounts` for `lsof`);
native reruns passed without source changes. All suite runs unset `OPENCODE_DB`
and set `HOME` to a throwaway directory.

## Draft bot reply (not posted)

Thanks @salacoste — your SDK/bridge reproduction exposed a real lock after the
first watermark. The fix keeps precise host activity timestamps when available
and falls back per session to the message index when the ledger is absent, for
both scheduled gating and backlog counts. No Pi host events or new config knob
are required. Regression tests reproduce the empty-ledger state and now pass;
Pi behavior is preserved. OpenCode 1 and 2 already write activity through their
own hooks. This is fixed on the task branch, not yet released.
