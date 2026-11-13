# ck-mc user-command samples, version 2

These wire bodies come from ck-mc's real command handlers (`commands.describe`,
`commands.preview` and `commands.run` through the module's command entry point,
as Occipital calls it) on a synthetic `context.db` and `mode3.db`, not live
stores. They add the person's commands on memories, observations, the dreamer
and notes (user-commands 0.1.2 subjects). Version 1 keeps the session commands
(`flush`, `status`, `wrapup`) and their samples. Regenerate both with:

```sh
MC_UPDATE_USER_COMMAND_SAMPLES=1 cargo test -p mc-module --lib --locked user_commands_tests
```

When the checkout is read-only, also set `MC_USER_COMMAND_SAMPLES_V2_DIR` to a
writable output folder, then copy the generated JSON files and `SHA256SUMS`
back here. `SHA256SUMS` covers the generated JSON files.

## Command ids

A command declares one subject kind, so each memory verb has one id per level:

| Subject kind | Commands |
|---|---|
| `computer` (global memories, owner `self`) | `global_memory_edit`, `global_memory_archive`, `global_memory_restore`, `global_memory_delete`, `global_memory_undo`, `observation_promote`, `observation_dismiss` |
| `workspace {workspace_id}` | `workspace_memory_edit`, `workspace_memory_archive`, `workspace_memory_restore`, `workspace_memory_delete`, `workspace_memory_undo` |
| `project {project_id}` | `project_memory_edit`, `project_memory_archive`, `project_memory_restore`, `project_memory_delete`, `project_memory_undo`, `dreamer_run_now`, `dreamer_undo_run`, `note_edit`, `note_dismiss`, `note_delete` |
| `agent {agent_id}` | `agent_memory_edit`, `agent_memory_archive`, `agent_memory_restore`, `agent_memory_delete`, `agent_memory_undo` |

`*_memory_delete` and `note_delete` have the effect `destroys`; every other
one is `reversible`. Dotted names such as `memory.edit` are not valid command
ids, which allow only `[a-z0-9_]`.

## Arguments

- `ids` is a text argument: 1 to 200 distinct positive decimal ids separated
  by commas (spaces around them are ignored), for example `"12,14, 15"`.
  Anything else is `invalid_params` with `detail.field = "args.ids"`.
- `id`, `revision` and `run_id` are numbers: positive integers.
- `<level>_memory_edit` takes `id` and three optional arguments whose declared
  defaults mean "keep":
  - `content`, default `""`: the empty text keeps the memory's text. Any other
    text (trimmed) replaces it; text equal to the current text keeps it too.
  - `category`, default `keep`: the choice `keep` ("Keep current") keeps the
    category. The other choices are the bundled memory profile's categories
    that the level may hold, in profile order, labelled from their tag
    (`swe:project-rules` is "Project rules").
  - `importance`, default `-1`: `-1` keeps the importance. Any other value
    must be an integer from 0 to 100. A safety-critical memory never goes
    below 80.
- `observation_promote` takes `category` with the global level's choices and
  no `keep`.
- `dreamer_run_now` takes `task`, a choice of the dreamer task kinds this
  build runs (`classify-memories`, `compress-cues`), labelled from the kind.
  Its project is the subject.

## What the samples cover

`describe.json` is the full description. Each `<command>-preview.json` and
`<command>-run.json` pair is an available preview and its run, for every
project memory verb, a global edit, a workspace archive, an agent delete,
both observation commands, both dreamer commands and the three note
commands. `dreamer-run-now-preview-locked.json` is the run-now preview while
another writer holds the project's lock. `preview-stale.json` is a run whose
preview no longer matches its rows. `unknown-subject.json` names a project
ck-mc has no session of; `not-in-subject.json` names a memory that isn't the
subject's, and its `detail.ids` lists every such id.

## Previews

Facts count what the command touches (`Memories`, `Notes`, `Observations`)
and what it skips (`Already archived`, `Not archived`, `Already reviewed`,
`Already dismissed`, `Would repeat a live memory`, `History can't record`).
`effect` says the level and what happens. An edit or undo adds a `Now` /
`After` table of `Text length` (characters), `Importance` (state `off` when
the memory has none) and `Revision`. A delete counts the `History entries` it
removes. `dreamer_undo_run` adds an `Undo` table: one row per memory, `ready`
for one it restores, and for one it leaves alone a label naming the memory
and why, with state `stale` (changed after the run), `unavailable` (deleted,
or its row before the run would repeat a live memory) or `off` (it belongs to
another owner now).

A preview's `version` hashes the command, its subject and arguments, and the
current state of the rows it targets (revision, status, category and text
hash for memories; update time, status and text for notes; the project's lock,
newest run and schedules for run-now). Other rows changing, counters such as
search hits, and time passing never make it stale.

Unavailable previews answer one of these reasons: `store_unavailable`,
`not_live` (an edit of an archived or merged memory), `no_change`,
`nothing_to_change`, `duplicate_content`, `history_unavailable`,
`history_not_found` (no history entry produced that revision),
`already_reviewed`, `dreamer_off`, `project_not_seen` (no session of the
project was set up since ck-mc started), `task_not_declared`,
`task_disabled`, `not_scheduled`, `locked`, `evidence_missing`,
`run_running` and `nothing_to_undo`.

## Runs

A run answers `applied` with counts of what changed (an edit and an undo
also name the new `Revision`; a promote names the new `Memory id`), or
`started` for `dreamer_run_now` with the `Dreamer run` id. A run answers
`preview_stale` when its rows moved since the preview, the unavailable reason
when the preview is unavailable, and `request_conflict` when its request id
was used on the same subject with another body. Answers are kept in
`mode3.db` for 24 hours per subject and request id, so a retry after a
restart replays the answer instead of acting twice.

`dreamer_undo_run`'s answer counts `Memories restored` and `Left alone`, then
names each memory it left alone in a state fact labelled with the memory and
the reason, as in its preview's table (at most 16 facts; a last `More left
alone` count stands for any it had no room to name).

Every memory change records a history entry with the writer `person`, which
`memories.get` shows; `<level>_memory_undo` can take it back. A delete keeps
no history: it removes the memory with its history, embeddings, search entry
and the text in journal entries, and leaves dreamer runs only its id.
