# The Rust module (ck-mc)

`ck-mc` is Magic Context for sessions that live in an llm-runner instead of a host with the plugin (mode 3 in [ARCHITECTURE.md](../../ARCHITECTURE.md)). It is a module of the subconscious daemon (subc), built from `crates/mc-module`. The runner holds the conversation and renders every request. ck-mc decides how the history is shortened and says so as a **view**: a list of edits (the history head, drops, placeholders, the cut) that the runner applies to every request until a newer view replaces it.

The TypeScript transform is the specification. ck-mc must make the same decisions, lane for lane; the differences it is allowed are listed, with their reasons, in `crates/mc-module/src/pass_decision_tests.rs`, which checks ck-mc against a decision table generated from the TypeScript gates.

## What it talks to

ck-mc reaches a runner only through published contracts, and no Magic Context policy runs in the runner:

- **Compaction provider** (`cortexkit-role-compaction`): Setup when a session attaches, a notice after each step, a ride when the runner is about to rewrite the provider cache anyway or the next request would not fit, and the views ck-mc publishes in reply.
- **Step-transform provider**: the `pre_user` hook, which adds a time marker and a memory hint to a person's message before the runner stores it (`pre_user.rs`).
- **Tool provider**: `tool.catalog` and `role.describe` declare the five tools (`ctx_reduce`, `ctx_expand`, `ctx_note`, `ctx_memory`, `ctx_search`) and the guidance text; the runner forwards the tool calls (`catalog.rs`).
- **llm-runner** (`cortexkit-role-llm-runner`), called by ck-mc: `session.entries` to read messages it has not seen, `session.applied_view` and `session.apply_view` to learn and set the view outside a step, and `session.send` to run its summarizer in a child session on the same runner.
- **Routing** (`routing/v1`): ck-mc never picks a model. It states what a run needs, and the routing provider answers a model (`routing.rs`).

Two read-only services answer other modules without touching a session's work: app reads for the desktop and phone apps (`app_read/`: the context map, summaries, search, the reason for the last cache rewrite) and context reads for the speech module (`context_read/`).

## Where the code is

Paths are under `crates/mc-module/src/`.

| File | Role |
|---|---|
| `lib.rs`, `main.rs` | Crate overview and the binary: serve under subc, or run an offline command (`move-in`, `rekey-runner`). |
| `transport.rs`, `module.rs` | The subc handler and the router. Every session has one worker that runs its jobs in order, so session state needs no lock. Notices are acknowledged before their work runs; rides and tool calls wait for their answer. |
| `session.rs` | One session's state and everything that happens to it: Setup, notices, rides, refusals, summaries arriving. |
| `pass.rs` | The pass decision: when a session may build a new view. |
| `lanes.rs` | The kinds of reduction a view carries: queued drops, the age sweep (old tool output and old notices), duplicate and superseded output, reasoning clearing, text compression of old messages, the emergency drop. |
| `view_builder.rs` | Builds the next view from the previous one and checks it with the functions the runner uses (`cortexkit-compaction-view`), so ck-mc never publishes a view the runner would refuse. |
| `index.rs` | A compact index of the transcript from the last cut on. It grows from notices and reads; ck-mc never walks the whole conversation per step. |
| `summary/` | The summarizer: trigger, chunking, prompt, validation, the history head (`head.rs`), and the two-pass run that reconciles new facts with the project's memories (`two_pass/`). |
| `reduce.rs`, `expand.rs`, `notes.rs`, `memory_tool.rs`, `search/` | The five tools. Argument rules and reply text are the TypeScript tools', so an agent reads the same in both. |
| `nudges.rs` | Reminders to call `ctx_reduce`. |
| `store.rs`, `store_text.rs` | ck-mc's own store, `mode3.db`. |
| `context_db.rs` | Access to `context.db`, the store shared with the plugin. |
| `memory_context/`, `memory_profile/`, `memory_sync/`, `workspace.rs` | A session's project, workspace and memory profile; sync of new memories to the backup service. |
| `upkeep.rs`, `embedding.rs`, `chunk_embedding.rs` | Background project work: memory and commit vectors, commit indexing. |
| `signed_floor.rs`, `move_floor.rs` | Two entries a view must respect. The signed floor: some models sign their reasoning against the bytes before it, so the runner strips that reasoning up to a recorded entry whenever the request's tool list changes, and ck-mc must not count or edit what is already gone. The move floor: the entry a moved session's first view cut through. |
| `move_in.rs`, `move_renumber.rs`, `rekey.rs` | Offline tools: move a session from a standalone host or another runner, and rename a runner in the store. |
| `agent_data/` | The `agent-data/v1` participant: moving a runner session's data to another machine (below). |
| `calibration.rs`, `count.rs`, `tokens.rs`, `prompt_notes.rs` | Token estimates and window geometry, including the notes a runner sends outside the transcript. |

`crates/mc-tokenizer` is the token estimator. `crates/mc-mock-runner` is a runner used only by tests. `crates_old/` holds the 0.49.x module (the retired Rust transform mode and its store); nothing builds it into a release.

## How a pass runs

A pass runs on a Setup, a notice or a ride, never on every step. A step that gets no new view is a cache hit by construction, because the runner re-applies the same view.

1. The notice or ride brings the newest usage reading and names the entries that changed. ck-mc reads only what it has not seen and updates its index.
2. `pass.rs` decides whether this pass may rebuild: usage at the execute threshold with no summary on its way, a ride that says the request's bytes change anyway or the request would not fit, or usage in the force band (at or above `max(85%, execute threshold + 2)`), where a pass stops waiting for a summary. A ride that only says the provider lost its cache permits nothing. A reading taken under an older view than the one the runner now applies is treated as stale.
3. On a permitted pass every lane with work contributes its edits, and `view_builder.rs` publishes them as one view. A summary that finished earlier lands in the same view: the history head is re-rendered and the cut moves.
4. The runner accepts or refuses the view. A refusal names its reason; ck-mc sets aside only what the refusal names and keeps everything else queued.

The summarizer runs beside the session's worker, since a run can take minutes. Its result comes back as a job of its own.

## Stores

- **`context.db`** is shared with every standalone plugin: summaries, memories, notes and the search index. ck-mc never migrates it. The TypeScript plugin owns the schema, and ck-mc opens it only at exactly the version the build was compiled against; any other version is refused by name. Writes are short `BEGIN IMMEDIATE` transactions.
- **`mode3.db`** is ck-mc's own (`store.rs`, schema version in `SCHEMA_VERSION`): per session, the decisions that are not in the runner's transcript or view and must survive a restart, such as held drops and the state of the last view. Views themselves are not kept: after a restart ck-mc takes the runner's current view from the runner. A `mode3.db` newer than the build is refused without being changed. A running module holds a shared lock on `mode3.db.lock`, so an offline tool refuses to run while the module does.

Back up and restore the two together. If `mode3.db` names summaries that `context.db` no longer has, ck-mc trusts `context.db`: it moves the cut back to the summaries that exist, rebuilds the head, and lets the summarizer cover those messages again.

## Moving a session to another machine

`agent_data/` lets ck-mc take part when Entorhinal moves an agent to another machine (the `agent-data/v1` contract). Per runner session it carries, through Engram's session door, the session's `context.db` rows: summaries with their events, scores and facts, session notes, the project link, and the committed publications that still hold facts waiting for the summarizer's second turn. `mode3.db` state, search indexes and project memories stay behind; the runner carries its applied view, and ck-mc adopts it at the first Setup on the destination.

- **The flag.** Serving moves is off unless the build says otherwise. The `agent-data` Cargo feature (off by default) turns it on. A build with debug assertions or with the feature also reads `MAGIC_CONTEXT_AGENT_DATA` (`1` or `0`). A release build without the feature ignores the variable and never serves a move. With the flag off, the manifest declares no `agent-data` service and its requests are refused.
- **The gate.** Every move is recorded in `agent-data/journal.json` beside `context.db`, and the journal is enforced in every build, flag on or off. A session frozen at the source, or staged or being installed at the destination, is refused `session_moving`. A session released to another machine is refused `session_moved`, and the refusal names the new holder. Both refusals apply to Setup, notices, rides, tool calls, app and context reads, `ck-mc move-in` and `ck-mc rekey-runner`. A journal that cannot be read refuses every session. At startup an install the journal records as started is finished, and the files of ended moves are deleted. Jobs a frozen session's worker holds live only in memory, so a crash loses them: after the move is aborted, the runner's next notice is answered `setup_required`.
- **Accepted losses.** Note numbers change on the destination, since a note's number is its row id there. A publication travels only while it holds a waiting fact. If the destination decides all of a moved publication's waiting facts, a later move back leaves that publication out, and the original machine's install deletes its hidden copy, decided facts included. The destination keeps the decided rows, and the memories they made sync through Engram on their own.

## Testing and placing

- `cargo test -p mc-module` runs the unit tests and the scenario suite (`tests/scenarios/`), which drives whole sessions against the mock runner.
- `scripts/wire-gate.sh` runs `tests/wire.rs` against a real subc daemon and the mock runner.
- Pinned bytes: `testdata/` holds goldens generated from the TypeScript plugin (the summarizer prompt, the history head, decay, the tool catalog) and the sample replies the apps decode. A change that moves one of them is a change to what models or apps receive.
- `scripts/place-ck-mc.sh` places a signed build: it keeps the previous binary as rollback, checks both store versions, restarts the module and verifies what is running.
