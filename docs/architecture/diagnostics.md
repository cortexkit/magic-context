# Diagnostics

Most Magic Context failures are silent by nature: a cache bust costs money without an error, and a refused turn only says "try again". This page covers the tools for finding out what happened: the plugin log and its redaction, the per-pass decision records, `doctor`, and the scripts that attribute cache busts.

Paths are relative to `packages/plugin/` unless they name another package.

## Where the code is

- `src/shared/logger.ts`, `src/shared/data-path.ts`: the log file.
- `src/shared/redaction.ts`: redaction of secrets and paths.
- `src/features/magic-context/transform-decision-log.ts`: per-pass decision records.
- `src/shared/user-facing-codes.ts`: the `MC-*` codes shown to users.
- `packages/cli/src/commands/doctor*.ts`, `packages/cli/src/lib/log-lines.ts`, `packages/cli/src/lib/github-issue.ts`: `doctor`.
- `packages/dashboard/src-tauri/src/log_parser.rs`: the dashboard's log reader.
- `scripts/analyze-cache-busts.ts`, `scripts/cache-bust-sentinel.ts` (with helpers `cache-bust-*.ts`), `scripts/tail-view.ts`, and `scripts/context-dump.ts` at the repository root.

## The log

Each host writes its own log: `${tmpdir}/opencode/magic-context/magic-context.log`, `${tmpdir}/pi/magic-context/magic-context.log` or `${tmpdir}/omp/magic-context/magic-context.log`. `MAGIC_CONTEXT_LOG_PATH` overrides the path, for example to keep logs on persistent storage in a container. Historian validation dumps go to a sibling directory in the same per-host subtree, so `doctor --issue` for one host never picks up another host's artifacts. OpenCode Desktop allow-lists its own temp subtree, which is why the log lives there rather than under the data directory.

`logger.ts` buffers writes and flushes them in batches. The file is created with mode `0600`. Every 64 flushes it checks the file size, and past 32 MiB it rotates to a single `.1` predecessor, so the log is bounded to roughly twice that. `sessionLog(sessionId, ...)` prefixes lines with the session so one session's history can be filtered out of a busy log.

Useful lines to know:

- Per-pass scheduler decisions (`execute` or `defer`) and why, and when queued work applies (`pending ops WILL APPLY`, with the reason the pass may mutate).
- The materialisation reason for every `m[0]` fold.
- `compartment trigger:` lines for every historian decision, including skips with their reason.
- Channel 1 and Channel 2 evaluations with their band, `U`, `T` and verdict.
- Refusals and fallbacks (`raw_fallback_...`, LKG replay).

## Redaction

`redaction.ts` sanitises anything that may leave the machine or reach a shared log: secrets in config values and free text, and home-directory paths. Key matching is by whole segment (a key must be `token`, not merely contain it), so benign settings such as `injection_budget_tokens` stay readable. Numbers and booleans are kept, so token counts and flags stay useful, while high-entropy strings are masked. The logger, `doctor`, issue bundles and RPC diagnostics all use the same functions. `hasShareabilitySensitiveText` applies the same idea to memory classification: anything that looks sensitive is not shareable across a workspace.

## Decision records

`transform_decisions` in `context.db` stores the cache-affecting decision of each pass (scheduler decision, materialisation reason and related fields), keeping the newest 2,000 rows per session and host. The dashboard reads it to attribute each cache bust to a cause. `/ctx-status diagnostics` prints the extended status view in a session. The Rust module, ck-mc, keeps its own pass audit in `mc_pass_trace` in `store.db` (see [rust-module.md](rust-module.md)).

User-facing problems carry stable `MC-*` codes (`user-facing-codes.ts`), each with one sentence and one action. The same text appears in `/ctx-status`, the sidebar and `doctor`, so a code in a bug report identifies the problem without the log.

## `doctor`

`npx @cortexkit/magic-context doctor` checks every installed host, or one with `doctor opencode`, `doctor pi` or `doctor omp`. It checks plugin installation and configuration, that the pinned plugin build's schema fence matches the live database, the local embedding runtime (the native `onnxruntime-node` binding and the WASM fallback), recent errors from the right host's log, compaction markers and their completion, store-generation rebases, and compartment boundaries whose messages no longer exist.

Flags and subcommands:

- `--fix` applies safe repairs; `--issue` (or `--report`) builds a redacted diagnostic bundle and opens a GitHub issue, falling back to a file you can attach when submission fails.
- `store init` provisions `context.db` at the current schema fence without a host, and reports its path and version. Existing stores are inspected without changes; a newer schema is refused. It honours `XDG_DATA_HOME` and `MAGIC_CONTEXT_STORAGE_DIR`. Non-dry-run `setup` also runs this provisioning step.
- `repair-db` repairs a corrupt `context.db` after copying it to a backup bundle.
- `merge-identity` merges two project identities that are the same project.
- `single-store migrate` runs the one-time offline migration that moves ck-mc's project data from `store.db` into `context.db` (`MC-C14`). It refuses while any process holds either database.
- `list-hidden-sessions` lists Magic Context's hidden child sessions.
- `migrate` moves OpenCode sessions to Pi or OMP; `migrate-session` re-homes an OpenCode session to another directory or project. Both journal their progress so a crash can resume.

`log-lines.ts` reads both log grammars the fleet produces (the structured prefix format and the older bracketed format), pinned to a shared golden fixture; the dashboard's `log_parser.rs` reads the same formats.

## Attributing cache busts

A cache bust shows up only as a provider bill. Two scripts attribute them from outside the plugin, both read-only:

- **`scripts/analyze-cache-busts.ts <sessionIdPrefix>`** walks request dumps written by the authentication plugins (Anthropic and OpenAI request bodies), normalises both shapes to role and part summaries, and uses each response's reported cache usage to find where the cached prefix diverged. It lines those points up with the plugin log (scheduler decisions and `HARD` reasons) to name the pass responsible. Per-request rotating header values are masked so they are not reported as divergences.
- **`scripts/cache-bust-sentinel.ts`** runs in the background and wakes the maintainer. It keeps its two older lanes (OpenCode 1 request dumps, and Pi and Oh My Pi session files) and adds a lane for runner heads: primary sessions hosted by a runner (OpenCode 2, Pi, Claude Code, Broca) on Anthropic models. That lane has no request bytes. It reads each step's cache usage from Astrocyte's read-only usage feed and the causes from the Rust module's (`ck-mc`) log.

  A step that reads less from cache than the previous step left there gets the first class that applies:

  | Class | Evidence |
  |---|---|
  | `scope_changed` | the model changed, so the step used another cache |
  | `view` | `ck-mc` accepted a newer view (its own rebuild) before the step |
  | `plan_changed` | the log shows the runner reported a changed tool list, system prompt or model, or `ck-mc` moved the session's signed floor (the message up to which the runner removes Anthropic's signed thinking blocks after a tool-list change) |
  | `provider_forgot` | the log shows the runner reported a cache expiry, a connection reset, or a tier or account change |
  | `expired` | more than the cache lifetime (one hour unless known) passed since the previous step started |
  | `unexplained` | none of the above; a runner restart alone explains nothing |

  It wakes for an unexplained rewrite of at least 20,000 tokens, for plan changes on three different sessions within ten minutes, and when warm reads after an idle hour drop below 50% over three hours while the preceding day was at least 80% (eight samples in each window). A wake older than 30 minutes is recorded, not sent. An unreachable feed gets one quiet notice after five runs. Active heads the feed has no steps for are listed in each run's summary without a wake.

  `analyze-cache-busts.ts --source astrocyte --session <id>` prints the same classes for one session over the feed's last 24 hours; its store modes read deeper OpenCode 2 and Pi history.

For looking at a session directly: `scripts/tail-view.ts <session_id>` prints messages since the last compartment and marks dropped ones, and the root `scripts/context-dump.ts <session_id>` dumps what Magic Context holds for a session.
