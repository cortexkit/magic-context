# OpenCode 1 compaction boundary: bounded index walk

## Fixture and provenance

No live store or user configuration was opened, copied, or migrated. The fixture
is generated from scratch in a temporary directory and deleted after the test.

OpenCode **v1.18.30** resolves to commit
`3104c1428ec91f809e5ab86631300de41eb6952e`. The message/part DDL (including
nullability and cascading foreign-key declarations) and all three indexes are
copied from its [generated SQL source][generated], lines 128–146 and 245–248.
The corresponding [Drizzle definitions][tables] and [timestamp definitions][timestamps]
agree. Foreign-key enforcement is left off in the fixture, so unrelated
project/session tables are unnecessary; the message and part declarations are
otherwise unchanged. No additional index is installed.

[generated]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/database/schema.gen.ts
[tables]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/session/sql.ts
[timestamps]: https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/database/schema.sql.ts

The large fixture has one 157,000-message session and 1,000,000 parts, plus one
foreign-session message and part to check session isolation. Assistant messages
carry reasoning/tool parts, with long runs between user messages. User shapes
include real input, synthetic wakes, todo wakes, wakes already carrying a
compaction marker, empty messages, compaction-only messages, mixed real/synthetic
parts, numeric/string synthetic flags, completed summaries (boolean and numeric
summary flags), and unfinished summaries. Four messages share each timestamp;
IDs run backwards within each timestamp group to exercise the canonical tie-break.
The SQLite file was 675,872,768 bytes (not a replica of the 39 GB host).

## Diagnosis

The old predicate is logically correct but is not a single index cursor bound:

```sql
time_created < ? OR (time_created = ? AND id <= ?)
```

On Bun 1.4.2 / SQLite 3.53.2 on the Linux runner, its plan changes with statistics:

* **No statistics:** an ordered reverse index walk bounded only by `session_id`.
  For an early target it walks the irrelevant suffix of the session before
  reaching the target. There is no temp sort in this plan.
* **After ANALYZE:** `MULTI-INDEX OR`, followed by `USE TEMP B-TREE FOR ORDER BY`.
  The two arms read the prefix up to the target, evaluate JSON filters and the
  part probes, and sort qualifying rows. `LIMIT 1` cannot stop at the nearest
  qualifying user. For a late target, nearly the whole session is examined.

The baseline part probes already use the message index on this fixture: the
existing unary `+p.session_id` prevents choosing the session-only part index.
JSON role/summary filtering has no host index, so its cost is paid on every
candidate visited. The avoidable problem is visiting/sorting the wrong range,
not missing an index that Magic Context should add to the host.

These warmed synthetic measurements do **not** reproduce or promise an exact
fix for the observed 6.1 seconds. They reproduce the pathological access plans;
host size, page-cache state, JSON size, statistics and storage latency affect
absolute time.

## Rewrite and observed plans

The boundary query now uses `(time_created, id) <= (?, ?)`, keeping the existing
`ORDER BY time_created DESC, id DESC LIMIT 1`. OpenCode's stock index can seek to
the inclusive target and walk backwards, stopping at the first qualifying user.
The two part probes retain session checks and use message-ID selectivity hints
to avoid a full part scan even with adverse/stale statistics.

Representative **old boundary plan after ANALYZE**, late target:

```text
MULTI-INDEX OR
  INDEX 1
    SEARCH message USING INDEX message_session_time_created_id_idx (session_id=? AND time_created<?)
  INDEX 2
    SEARCH message USING INDEX message_session_time_created_id_idx (session_id=? AND time_created=? AND id<?)
CORRELATED SCALAR SUBQUERY 1
  SEARCH p USING INDEX part_message_id_id_idx (message_id=?)
CORRELATED SCALAR SUBQUERY 2
  SEARCH p USING INDEX part_message_id_id_idx (message_id=?)
USE TEMP B-TREE FOR ORDER BY
```

**New boundary plan**, with or without statistics:

```text
SEARCH message USING INDEX message_session_time_created_id_idx (session_id=? AND (time_created,id)<(?,?))
CORRELATED SCALAR SUBQUERY 1
  SEARCH p USING INDEX part_message_id_id_idx (message_id=?)
CORRELATED SCALAR SUBQUERY 2
  SEARCH p USING INDEX part_message_id_id_idx (message_id=?)
```

SQLite displays `<` in the plan even for the inclusive row-value SQL bound.
The target-user and same-timestamp tests verify that inclusion is preserved.

`isOpenCodeGapHistorianAbsent` had the same expanded-OR pattern at both
endpoints. It now uses exclusive row-value bounds. Its old plan uses multiple
OR index walks; the new plan starts with:

```text
SEARCH m USING INDEX message_session_time_created_id_idx (session_id=? AND (time_created,id)>(?,?) AND (time_created,id)<(?,?))
```

It has the same two message-indexed part probes as the boundary plan. There is
no sort. Summary and synthetic predicates were intentionally **not unified**:
the boundary's `json_extract(...)=1` semantics and the gap's `json_type(...)=true`
semantics remain different exactly as before.

## Timings

Medians of five warmed query executions after one warmup, milliseconds. These
measure the lookup SQL only, not connection acquisition or endpoint validation.

| Statistics | Target index | Boundary old | Boundary new | Gap old | Gap new |
|---|---:|---:|---:|---:|---:|
| absent | 1,000 | 5.871 | 0.021 | 0.037 | 0.024 |
| absent | 78,500 | 2.937 | 0.120 | 0.039 | 0.026 |
| absent | 156,999 | 0.059 | 0.057 | 0.030 | 0.019 |
| analyzed | 1,000 | 0.275 | 0.021 | 0.033 | 0.022 |
| analyzed | 78,500 | 31.301 | 0.124 | 0.034 | 0.022 |
| analyzed | 156,999 | 61.381 | 0.062 | 0.030 | 0.021 |

The middle target has a longer span back to a qualifying user than the early
target. That unavoidable span, rather than total session size, controls the
new query's work. Gap timings use close endpoints; the benefit there is a single
correctly bounded plan rather than a large wall-clock improvement on this case.

## Differential and plan guards

Frozen old SQL is independent of the new SQL. Tests call the production boundary
and gap functions; benchmark plans/timings capture their actual prepared SQL,
not a second handwritten optimized query.

* Routine fixture: 4,096 messages / 27,000 parts; 256 deterministic random targets
  plus 21 edge targets, and three gap pairs per target.
* Large fixture: 128 deterministic random targets plus 21 edge targets; all
  **149 boundary results and 447 gap results** match. Seed: `0x12345678`.
* Missing and foreign-session targets return null/false.
* The production plan guard checks absent, analyzed and adversarial part
  statistics. It rejects scans, temp B-trees, missing tuple bounds and any probe
  not using `part_message_id_id_idx (message_id=?)`.

The guard was mutation-tested with three semantics-preserving changes to the
production boundary query: expanded OR instead of the tuple bound; unary plus
on the order keys to force a temp sort; and removal of the part-index protection
to allow session-only probes. Each made only
`findBoundaryUserMessage > uses bounded message walks without sorting and message-indexed part probes on OpenCode 1.18.30`
fail, while
`matches pre-keyset boundary and gap results across randomized targets and JSON edge cases`
remained green. Each mutation was staged-state-restored before the next run.

## Other queries audited

* Target validation and message-existence checks are primary-key lookups, not
  ordinal/session walks.
* Summary discovery in `listSessionCompactionMarkers` needs to discover all
  completed MC summaries; its canonical ordering matches the message index.
  Its part queries are bounded by the discovered message IDs. Their local sort
  is over that bounded result, not the session's million parts.
* Legacy lineage queries correlate parts by message ID and already disqualify
  the session-only part index. Deletions are message-ID or primary-key targeted.
* Flip-off cleanup deliberately discovers all session compaction parts and
  message-level tail references for its ownership/survivor preflight. A time
  bound would change that safety contract; no bounded-walk rewrite applies.

## Reproduce and gates

From `packages/plugin`, with no database override and a home outside the checkout:

```sh
root="$(mktemp -d)"
mkdir -p "$root/data" "$root/config" "$root/state" "$root/cache"
env -u OPENCODE_DB HOME="$root" XDG_DATA_HOME="$root/data" \
  XDG_CONFIG_HOME="$root/config" XDG_STATE_HOME="$root/state" \
  XDG_CACHE_HOME="$root/cache" MC_BOUNDARY_BENCH=1 \
  bun test src/features/magic-context/compaction-marker-keyset.test.ts --timeout 180000
```

The opt-in benchmark prints before/after plans and timings for each case. It is
skipped by the ordinary suite to avoid adding a 0.6 GB fixture to every run.
The small differential and plan guard run normally.

Plugin `bun run typecheck` passed (TypeScript 5.9.3); `bun run lint` passed
(Biome 2.5.1, 1,271 files; six unrelated warnings and two informational findings).
The final restored marker, marker-manager, marker-consistency and
transaction-mode run passed all 50 tests, including the enabled million-part
benchmark and independent SQL row-count assertions. That run requested Linux
but the tool fell back to macOS after a remote snapshot failure; Bun 1.4.2 /
SQLite 3.54.0 produced the same plans and differential results. Its analyzed
late-target boundary median was 225.907 ms before and 0.112 ms after. Typecheck
and lint also passed again on that final run.
The requested `bun run test` was run on the Linux runner with a throwaway HOME
and no exported OPENCODE_DB. Its final run had 7,301 passes, seven skips and
17 environment failures: 16 tests require `lsof`, which fails because the runner
does not expose `/proc/mounts`, and the Node WASM fixture cannot resolve
`onnxruntime-web/webgpu` from its temporary build directory. These failures are
outside the marker change. The initial run also exposed a fixture transaction
mode guard failure (fixed by using `.immediate()`) and home/git ownership issues
(avoided by putting the throwaway HOME outside the repository and admitting this
worktree via process-local `safe.directory`). No repository/global configuration
was changed to work around them.
