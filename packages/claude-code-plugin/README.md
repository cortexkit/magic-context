# Magic Context for Claude Code

A Claude Code plugin that gives Claude Code the Magic Context memory layer: project memories and notes that survive compaction and carry into new sessions, recall of what Claude Code compacted away, and operation skills that turn a project's verified flows (which button calls which API and writes what) into reusable skills. It uses the same database as the OpenCode and Pi plugins, so a memory recorded in one host shows up in the others.

Nothing needs a model of its own: everything is done by the model already running the Claude Code session.

Claude Code keeps managing its own context window. Magic Context's context management (`ctx_reduce`, the historian, compartments, the dreamer) needs a host that lets a plugin rewrite the conversation it sends, and Claude Code has no such hook. This plugin adds what can be added from outside: memory, notes and recall.

## What you get

| Piece | What it does |
|---|---|
| `SessionStart` hook | On startup, resume, `/clear` and after every compaction, adds the project's memories (`<project-memory>`), this session's notes and short tool guidance to the model's context. |
| `ctx_memory` | Records, updates and archives durable project facts. Shared with every session and host working on the project. |
| `ctx_note` | Per-session notes for work you intend to come back to. They survive compaction and `--resume`. |
| `ctx_search` | Searches memories, notes, indexed git commits and the part of the current conversation Claude Code has compacted away. |
| `ctx_expand` | Returns the original wording of compacted messages, by ordinal, including full tool inputs and outputs. |
| `ctx_skill` | Operation skills of the project: finds the recorded action for a request, saves and updates verified flows (see below). |
| `UserPromptSubmit` hook | When a prompt names a recorded operation (its button label or one of its phrases), adds the verified operation to the model's context so it is performed from the record. |
| `Stop` hook | When a turn ends after verified work, asks the session's own model once to save it as an operation skill and to record what it learned. |
| `/magic-context:capture-skill [scope]` | Traces the project's frontend (or the given scope) button by button, verifies each write, and saves operation skills. |
| `/magic-context:remember <fact>` | Saves a fact to project memory. |
| `/magic-context:recall <question>` | Answers a question from memory, notes and compacted history. |
| `magic-context:operation-skills` skill | The method the model follows to capture and reuse operation skills; Claude Code loads it when a request calls for it. |

In Claude Code the tools appear as `mcp__plugin_magic-context_magic-context__ctx_*`.

## Install

Requirements: Claude Code with plugin support, and Node.js 22.13 or newer on `PATH` (the plugin uses Node's built-in `node:sqlite`). Building from source needs Bun 1.4 or newer.

From a checkout of this repository:

```bash
bun install
bun run --cwd packages/claude-code-plugin build
claude plugin marketplace add "$PWD"
claude plugin install magic-context@cortexkit
```

Once a build of `packages/claude-code-plugin/dist/` is published on the default branch, the GitHub marketplace works without a checkout:

```bash
claude plugin marketplace add cortexkit/magic-context
claude plugin install magic-context@cortexkit
```

Restart Claude Code after installing. `/mcp` should list `plugin:magic-context:magic-context` as connected.

To try the plugin for one session without installing it: `claude --plugin-dir packages/claude-code-plugin`.

## Operation skills

An operation skill records how a part of the user's project works, operation by operation, so the next session can carry an operation out without analysing the code again:

```
project directory → skill (a page or feature) → trigger (button, form, event, route) → action → verified flow
```

Each operation records the trigger (label, location, selector, event), the phrases users say for it, the action, the APIs it calls (method, endpoint, request, response, server handler), the data it writes (table/collection/file and fields), the state it updates, how saving and linked updates complete, the files to modify when it has to change, the steps to perform it directly (runnable commands such as a `curl` request, not clicks), and how it was verified. A skill also records its setup: how to start the app and reach it (start command, port, base URL, test account).

- **Where.** `<project>/.claude/skills/<name>/flow.json` (structured record) and `SKILL.md` (rendered from it). Claude Code loads `SKILL.md` as a native project skill from the next session on and triggers it by its description; `ctx_skill` serves it immediately. Commit `.claude/skills/` to share skills with the team.
- **Capturing.** Run `/magic-context:capture-skill web/` (or ask "把前端做成 skill" / "which buttons write what"): the model lists the triggers, starting with those that write data, traces each one through the API to the data written and the state updated, verifies it (for example a `curl` request and a check of the stored row), and saves it. Unverified operations are not saved.
- **Reusing.** `<project-skills>` at session start lists the project's operations. When a prompt names one (its button label or one of its phrases, e.g. "用保存备注按钮存一条"), the `UserPromptSubmit` hook adds the operation with its setup and steps as `<operation-skill>`, so the model performs it from the record instead of working the flow out from the code. Other requests about the project's flows go through `ctx_skill find`.
- **Staying current.** Every file an operation references is hashed when it is verified. When one changes, `ctx_skill` and `<project-skills>` say which, so only those files are re-checked; `ctx_skill verify` records the re-check and `ctx_skill save` (same name and operation id) records a changed flow.

## Capture on the session's own model

In OpenCode and Pi the historian and dreamer run on a separately configured model. Under Claude Code nothing is configured: when a turn ends after verified work (files edited, then a command that succeeded) or after a long stretch of activity, the `Stop` hook asks the model already running the session, once, to save verified flows with `ctx_skill` and durable facts with `ctx_memory`, or to answer "Nothing to capture." The hook reads only what the transcript gained since its last run and never extends a stop it already extended.

Claude Code labels every Stop hook that continues a turn as "Stop hook error"; the hook adds a notice saying that it is a capture, not an error.

| Environment variable | Default | Meaning |
|---|---|---|
| `MAGIC_CONTEXT_AUTO_CAPTURE` | on | `off` disables the Stop hook capture. |
| `MAGIC_CONTEXT_CAPTURE_AFTER` | 10 | Tool calls and prompts of verified work before a capture is asked for. |
| `MAGIC_CONTEXT_CAPTURE_EVERY` | 60 | Activity between captures asked for without verified work (memories only); `0` disables. |

Set them in the `env` block of Claude Code's `settings.json`.

## Configuration

The plugin reads the same `magic-context.jsonc` as the other hosts (`~/.config/cortexkit/magic-context.jsonc` and `<project>/.cortexkit/magic-context.jsonc`). The settings that matter under Claude Code:

- `enabled`: `false` turns Magic Context off for a project: nothing is injected and the tools answer that it is disabled.
- `memory.enabled` and `memory.injection_budget_tokens`: whether memories are kept and how much of them is injected at session start.
- `embedding`: the plugin does not bundle the local embedding model, so with the default `local` provider search is lexical (full-text) only, and memories are saved without vectors. Another host with local embeddings embeds them later. For semantic search under Claude Code, set `embedding.provider` to `openai-compatible` with an `endpoint` and `model`.
- `historian.expand_tools`: the readable `ctx_expand` previews for chosen tools, as on the other hosts.

Model settings for the historian and dreamer do not apply: neither runs under Claude Code, and capturing uses the session's own model.

## How it works

- **Processes.** Claude Code starts one MCP server (`dist/mcp-server.js`) per session, runs `dist/hook.js` on `SessionStart`, `dist/prompt-hook.js` on each prompt and `dist/stop-hook.js` at the end of each turn. All are Node bundles with no dependencies outside Node; the prompt and Stop hooks load no database code (the prompt hook reads only the project's skill files, in about 50 ms). The MCP server and `hook.js` open the shared database as the `claude-code` harness, so session rows are attributed to it while memories stay project-scoped.
- **Sessions.** Claude Code passes the session id to the MCP server as `CLAUDE_CODE_SESSION_ID` and to hooks in their payload. `/clear` and `/resume` switch the session without restarting the MCP server, so the `SessionStart` hook records the current session for its Claude Code process (keyed by the PID Claude Code passes to hooks as `CLAUDE_PID`, which is the server's parent PID) and the server reads that record before each tool call. Notes therefore follow the session you are in. The project is `CLAUDE_PROJECT_DIR`; its identity (git root commit, or the path) is resolved the same way as on the other hosts, which is why memories are shared.
- **History.** Claude Code keeps each session as a JSONL transcript under `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`). `ctx_search` and `ctx_expand` read it: streamed records of one reply are merged, tool results are attached to their calls, sidechains, meta records and compaction summaries are skipped. The latest `compact_boundary` decides what is out of context; messages Claude Code kept verbatim through the compaction count as still visible. Only messages before that point are searchable and expandable as ranges, because the rest is already in front of the model.
- **Index upkeep.** The compacted part of a transcript is indexed for search when `ctx_search` runs. The `SessionStart` hook drops the index of sessions idle for a week whose transcript Claude Code has deleted. Memories and notes are never pruned.

## Limitations

- No `ctx_reduce`, historian, compartments, dreamer or smart notes (see above). Memories and operation skills are written by the session's own model, when it decides to or when the Stop hook asks it.
- A skill saved during a session is a native Claude Code skill only from the next session (Claude Code 2.1 does not reload project skills mid-session); `ctx_skill` serves it at once.
- Message search covers the current session's compacted history, not other sessions' transcripts.
- Token counts are approximate (the plugin does not ship the Claude tokenizer); this only affects the memory injection budget and the size cap of `ctx_expand` ranges.
- Session tracking relies on what Claude Code 2.1 provides (`CLAUDE_CODE_SESSION_ID` for MCP servers, `CLAUDE_PID` for hooks). Without `CLAUDE_PID`, notes written after `/clear` stay with the session the server started in; without `CLAUDE_CODE_SESSION_ID`, the server falls back to the project's newest transcript, which is wrong when two sessions run in the same project at once.

## Troubleshooting

- The diagnostic log is `$TMPDIR/claude-code/magic-context/magic-context.log` (`MAGIC_CONTEXT_LOG_PATH` overrides it).
- `claude --debug` shows the MCP server's start-up and the hook's output.
- If the shared database was created by a newer Magic Context, the hook prints a one-line notice and the tools answer with the reason instead of running without persistence. Update the plugin.

## Development

```bash
bun run build       # bundle dist/ (mcp-server.js, hook.js, workers, shared chunks)
bun run test        # unit tests, isolated from the real database and ~/.claude
bun run typecheck
bun run lint
bun run probe       # load the built server under Node and answer initialize
bun run smoke       # build + end-to-end checks against dist/, a marketplace install included
bun run smoke:live  # also drives real `claude -p` sessions on Haiku (needs login; a few cents)
```

The bundles share the core with the OpenCode and Pi plugins through `@magic-context/core/*` (`../plugin/src`). Because every host shares one database, a schema migration in the core means rebuilding this plugin too (`bun run build:dists` at the repository root does all of them).
