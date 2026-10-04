# Changelog

Magic Context ships three npm packages from this repo (`@cortexkit/magic-context`, `@cortexkit/opencode-magic-context`, `@cortexkit/pi-magic-context`) and a Tauri dashboard. All three plugin packages share a single version line and ship together. The dashboard tracks its own `dashboard-vX.Y.Z` tag line.

## Source of truth

Full per-release notes live in GitHub Releases — that's the canonical, user-facing changelog:

- **Plugin/CLI releases:** https://github.com/cortexkit/magic-context/releases (filtered to `v0.*` tags)
- **Dashboard releases:** same page, filtered to `dashboard-v0.*` tags

This file exists as a quick navigation map. Working drafts that became those release notes are kept under `.alfonso/release-notes/` for reference.

## Versioning

This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the public surface is pre-1.0:

- `MINOR` bumps (`0.21.0` → `0.22.0`) carry user-visible feature additions or breaking config migrations.
- `PATCH` bumps (`0.21.6` → `0.21.7`) carry bug fixes and small enhancements that don't change config shape or break existing setups.
- Migrations that change config shape always ship with an in-memory shim so existing configs keep working until you run `doctor` to rewrite them on disk.

## Unreleased

Claude Code is a new host: `packages/claude-code-plugin` is a Claude Code plugin (installable from this repository's `.claude-plugin/marketplace.json` as `magic-context@cortexkit`) with an MCP server for `ctx_memory`, `ctx_note`, `ctx_search` and `ctx_expand`, a `SessionStart` hook that injects project memory and session notes on startup, resume, `/clear` and after compaction, and `/magic-context:remember` and `/magic-context:recall` commands. It shares the database with the other hosts as the `claude-code` harness. Claude Code keeps its own compaction; `ctx_search` and `ctx_expand` read its transcripts to recover compacted messages. There is no `ctx_reduce`, historian or dreamer under Claude Code, and local embeddings are not bundled (search is lexical unless an OpenAI-compatible embedding endpoint is configured). Operation skills (`ctx_skill`, `/magic-context:capture-skill`) record a project's verified flows (trigger → action → APIs → data written → state updated → steps, with how each was verified) in the project's `.claude/skills/`, where Claude Code loads them as native skills; files are hashed so changed code is flagged, and each skill records how to start the app so its steps run as recorded. A `UserPromptSubmit` hook puts the recorded operation in front of the model when a prompt names its button or one of its phrases. Capturing needs no model of its own: a `Stop` hook asks the session's model to save verified work.

The prompt surface is now split cleanly between desk-oriented system guidance and tool/parameter contracts: agents get a shorter orientation with explicit filing, search, pinboard, tray, and stamping triggers, while each tool owns its operational details. Dreamer bulk memory enumeration moved from `ctx_memory(action="list")` to the dreamer-only `ctx_memory_list` tool, which never appears in a primary provider tool list. Because the system prompt and tool schemas change, every existing session pays one prompt-cache rewrite on its first turn after upgrading.

## Highlights by release line

### 0.21.x (current)

The most recent release line. Notable themes:

- **0.21.7** — Compressor cross-process safety (fixes GH #91), unified agent disable semantics, startup release announcements, auto-search ignores plugin-internal messages.
- **0.21.6** — Hidden subagent permission lock-down, TUI execute-threshold display, `doctor --issue` 64KB cap.
- **0.21.5** — Pi audit fixes wave 1.
- **0.21.4** — Issue #85 emergency-recovery loop fix, compaction markers graduated from experimental.
- **0.21.2** — Pi reference-identity boundary resolution, Pi subagent spawning.
- **0.21.1** — Pi parity sweep (44 audit findings), Pi multi-turn RPC harness, key-files plan v6 implementation.
- **0.21.0** — Sticky-injection multi-anchor persistence, per-project embedding resolution, project-local historian artifacts.

### 0.20.x

- Boundary-execution v8 (defer execute decisions out of mid-turn passes), short-context overflow recovery, Pi audit fixes batch.

### 0.19.x

- Deferred compaction-marker movement, JSONC parser resilience, doctor migration framework.

### 0.18.x

- OpenCode fallback-chain support, dreamer circuit breaker, structured failure reporting.

### 0.17.x

- Tag-owner composite identity overhaul (fixed cross-turn callID collisions corrupting conversation tags), schema migration v10, runtime-detected SQLite backend selector.

### 0.16.x

- Unified `@cortexkit/magic-context` CLI replacing per-plugin bins, harness adapters for OpenCode and Pi, doctor/setup/migrate flows, Electron `nativeBinding` for OpenCode Desktop.

### 0.15.x and earlier

See GitHub Releases. Older lines are kept for archival reference but should not be used — upgrade with `npx @cortexkit/magic-context@latest doctor --force` to refresh OpenCode's cached plugin.
