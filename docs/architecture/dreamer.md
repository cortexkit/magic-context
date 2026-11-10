# The dreamer

The dreamer runs scheduled background maintenance: mapping and verifying memories against the code, curating and classifying them, learning from user friction, proposing documentation updates, and a few smaller tasks. Each task runs in its own hidden session under a lease, and its writes never force a prompt-cache bust; they reach sessions on the next natural rebuild.

Paths are relative to `packages/plugin/`.

## Where the code is

- `src/plugin/dream-timer.ts`: the process-wide timer.
- `src/features/magic-context/dreamer/task-registry.ts`: task names, capabilities, lease domains.
- `src/features/magic-context/dreamer/task-scheduler.ts`, `cron.ts`, `storage-task-schedule.ts`: scheduling and retry.
- `src/features/magic-context/dreamer/task-gates.ts`: cheap per-task "is there work" checks and backlog counts.
- `src/features/magic-context/dreamer/lease.ts`: leases and guarded writes.
- `src/features/magic-context/dreamer/task-executor.ts`, `task-prompts.ts`, `manifest-parser.ts`: running a task.
- `src/features/magic-context/dreamer/storage-dream-runs.ts`, `provider-output-failure.ts`, `tick-failure.ts`: failure records.
- Per-task modules in the same directory (`map-memories.ts`, `verify.ts`, `classify.ts`, `retrospective-*.ts`, `promote-primers.ts`, `refresh-primers.ts`, `evaluate-smart-notes.ts`, `docs-proposals.ts`), plus `src/features/magic-context/mural/` and `src/features/magic-context/user-memory/`.
- `src/shared/child-session-teardown.ts`: retiring task sessions.

## Scheduling

A process-wide timer ticks every 15 minutes. Each tick reconciles `task_schedule_state` (one row per project and task, holding the cron schedule, the next due time and the last successful run) with config, then runs every due task whose gate passes. Gates are cheap counts in `task-gates.ts`, such as "unmapped active memories exist" for `map-memories` or "new compartments since the last run" for `maintain-docs`, so an idle project costs no model calls. Tick stages are isolated, so a failure in one project's maintenance does not stop the scheduler; a tick that fails before reaching any per-project work surfaces as `MC-D09` in `/ctx-status` and `doctor`.

Schedules are cron strings under `dreamer.tasks.<task>.schedule`; an empty string disables a task. By default most tasks run nightly, `verify-broad` and `curate` weekly, and `maintain-docs` is off.

`last_run_at` records the start of the last successful run. It is stamped from the start rather than the end so a compartment landing during a run is not skipped by the next one, and it never advances on failure. A failed run is hot-retried on following ticks up to three times (`MAX_TASK_RETRIES`), then waits for its next cron slot. A task that keeps failing is reported in `/ctx-status` as `MC-S05` with how long it has been stuck since its last success.

`/ctx-dream [task]` runs tasks manually through the same scheduler. A manual run waits up to 60 s, polling every 2 s, for a busy lease; a scheduled tick never waits. Backlog counts are shown before a manual run, and progress is reported at chunk boundaries over RPC.

## Leases

Tasks that read and rewrite the project's memories must not run concurrently, or one works from a stale view of the other's merges. Every task maps to a lease (`leaseKeyFor`):

- `memory:<project>`: `map-memories`, `verify`, `verify-broad`, `curate`, `compress-cues`, `classify-memories`, `retrospective`, `promote-primers`, `refresh-primers`. When several are due they run in that canonical order.
- `maintain-docs:<project>` and `evaluate-smart-notes:<project>`: independent per-project leases.
- `user-memories`: one global lease, because the user profile is shared across projects.

A lease lasts two minutes and is renewed by a 60-second heartbeat. Lease changes and read-then-write task steps go through `runLeaseGuardedWrite`, which uses `BEGIN IMMEDIATE`, so they are atomic across processes. A task that loses its lease mid-run stops without applying its result.

## Running a task

Each run creates a hidden child session (titled `magic-context-dream-<task>`), prompts it, validates the output and applies the result host-side. The model is resolved per task: the task's own override, then the dreamer model chain, with fallbacks on timeout or retryable provider errors. Child sessions are retired only after their prompt settles (`child-session-teardown.ts`): settled children are deleted unless `keep_subagents` is set, and unsettled ones (timeouts, errors) are archived at once and left to an age-gated sweep so the plugin never races a writer that is still running.

Every task has a transport class (`DREAM_TASK_CAPABILITIES`):

- **`tool-loop`**: the model must call tools between turns. `map-memories`, `verify`, `verify-broad`, `curate`, `retrospective`, `maintain-docs`, `refresh-primers`.
- **`single-shot`**: one or more tool-free completions. `compress-cues`, `classify-memories`, `evaluate-smart-notes`, `review-user-memories`.
- **`host-only`**: no model call. `promote-primers`.

OpenCode 2 runs tool-loop tasks in fresh hidden agent sessions, with deny-all permissions followed by explicit task-specific tool allows. The hook restores the calibrated user prompt on each model step while preserving the host's accumulated tool calls and results. Single-shot tasks still use reusable children.

Several tasks are **manifest tasks**: the host renders one prompt, a locked read-only or tool-free agent answers with a single XML manifest, and the host parses and applies it. Parsing fails closed: output without the expected root element is rejected, never applied as a truncated prefix.

## Tasks

- **`map-memories`** maps each memory to the files that back it, or marks it file-independent, so `verify` has something to check. The read-only `dreamer-memory-mapper` agent returns a `<map>` manifest. Process rules and memories whose proposed paths fail validation are recorded as file-independent with `mapping_origin = 'host_rejected_fallback'` so mapping converges. Mostly a one-time backfill, then a trickle for new memories.
- **`verify`** re-checks mapped memories whose backing files changed since that memory was last verified, and returns a `<verify>` manifest (verified, update, archive) applied through the cache-neutral mutation log. Progress is kept per memory, so a timed-out run keeps what it checked. Host-side safety checks (`memory-claim-safety.ts`) refuse update or archive verdicts on process rules and refuse updates that drop more than half the text without a consolidation flag; refusals are logged and do not fail the run. Completions that look like a provider outage (a stop with no reasoning and almost no output) are classified separately and end the run early so it is retried.
- **`verify-broad`** ignores the file-change gate and re-checks the whole mapped pool in resumable cycles.
- **`curate`** cleans one memory category per run, rotating through the five categories, with the `ctx_memory` tool scoped to that category: consolidating, tightening and archiving, plus archiving expired memories. Merges across categories are refused.
- **`compress-cues`** writes a short visual cue for each memory. The memory mural, an image of the memory pool rendered into `m[0]` for models that accept images, is a deterministic function of those cues and is re-rendered on demand when the cue pool changes; no model draws it.
- **`classify-memories`** scores importance, scope and shareability with a tool-free `<classify>` manifest, applied column-only so it never changes rendered bytes. It skips pools under 10, classifies the whole pool up to 100, and above that classifies new or changed memories plus a stratified sample. Shareability fails closed on sensitive-looking text.
- **`retrospective`** learns from user friction. A cheap model gate scans the project's new user messages across sessions (at most 20 sessions per run, within `recency_days`, default 30, excluding hidden sessions); if friction is found, a child limited to `ctx_search` returns `<learnings>` that the host validates and routes to project memory or user-observation candidates. The assembled prompt is checked against the child model's window first.
- **`maintain-docs`** proposes updates to the project's `ARCHITECTURE.md` and `STRUCTURE.md` (see below).
- **`evaluate-smart-notes`** compiles smart-note conditions into checks, runs them in a sandbox and surfaces notes whose condition holds. When the subc fleet offers a scheduled-wake capability, standalone evaluation stands down in its favour; it fails open if the daemon cannot be reached.
- **`review-user-memories`** promotes recurring user observations (seen at least three times by default) into the cross-project user profile. Observations are only collected when `dreamer.user_memories.enabled` is on.
- **`promote-primers`** clusters recurring standing questions into primers without a model call; **`refresh-primers`** re-answers primers whose answer is missing or older than their latest observation.

## Documentation proposals

`maintain-docs` never edits documentation. It runs only when `ARCHITECTURE.md` or `STRUCTURE.md` have relevant commits since the last anchor (lock files, tests, generated and build output are excluded) and there is no pending proposal for the current file contents. A locked read-only agent (`DREAMER_DOCS_AGENT`) reads the change set and the current docs and returns a JSON array of section changes (`replace`, `add` or `remove` a heading with its text and a reason), or `[]` for nothing to change.

The host validates the answer (`validateDocsProposal`): the docs must not have changed since the task started, every change must target an existing heading (or add a new one), the heading structure must come out as expected, the `<!-- mc:protected -->` regions must be byte-identical, and the result must fit the token budget (`docsMaxTokens`, default 12,000). A valid proposal is written to `.cortexkit/magic-context/docs-update-proposals/<timestamp>.md` with the base commit, the base file hashes, the proposed sections and a unified diff; older pending proposals move to `superseded/`. A person applies it.

Both proposal writes and historian dumps ensure `.cortexkit/magic-context/.gitignore` contains exactly `*` and a newline. This hides the artifacts and the ignore file, even when a proposal precedes the first historian run, without hiding `.cortexkit/magic-context.jsonc`. Once the nested rule is in place, the writer removes only Magic Context's complete fenced block from the old shared `.cortexkit/.gitignore`, preserving other bytes and deleting the shared file if only whitespace remains. Ignore-file failures are logged and do not prevent artifact writes. Setup no longer adds artifact rules to the repository-root `.gitignore`; existing rules stay unchanged.

## Failure records

Each dream run stores per-task results in `tasks_json`. A failed task carries a structured `DreamRunFailureDetail`: a `failure_class` (`provider_timeout`, `provider_error`, `empty_completion`, `no_models`, `child_aborted`, `parse_failed`, `unknown`), the model attempted and the models tried, a redacted provider error, the timeout and the child session id. The dashboard shows it in its detail column and `/ctx-dream` prints it inline.
