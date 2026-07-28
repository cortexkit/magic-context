---
title: Compatibility
description: Which plugins and settings conflict with Magic Context, why they conflict, and how to resolve each.
---

Magic Context owns context management end to end. Running a second context manager at the same time would double-compress your history and thrash the prompt cache. On startup, Magic Context checks for known conflicts and **disables itself** if any are active — it tells you why, and setup or `doctor` helps you resolve them.

This fail-safe behavior is intentional. Magic Context staying off is better than it competing with another plugin and producing corrupted context.

## Conflicts detected at startup

### OpenCode built-in compaction

**Keys:** `compaction.auto` and `compaction.prune` in `opencode.json`

**Why it conflicts:** Magic Context replaces OpenCode's built-in compaction. If compaction is still on, it will fire independently, compete with the historian's cache-aware deferred operations, and double-compress your history.

**Resolution:** The setup wizard turns both off automatically:

```jsonc
{
  "compaction": { "auto": false, "prune": false }
}
```

Run `doctor` or `doctor --force` if you ever re-enable these by accident; doctor will detect and offer to fix them.

### OMP native compaction

**Key:** `compaction.enabled` in OMP's `config.yml`

**Why it conflicts:** OMP's native compaction and Magic Context both own the same history boundary. Running both can create repeated cancellation attempts or competing summaries.

**Resolution:** `setup --harness omp` asks once, then sets the key to `false` transactionally. `doctor --harness omp` detects drift; `doctor --harness omp --force` repairs it.

### OMP automatic memory

**Key:** `memory.backend` in OMP's `config.yml`

**Why it conflicts:** OMP local/Mnemopi/Hindsight backends inject and retain memory independently. Enabling one alongside Magic Context duplicates recall context and background writes.

**Resolution:** OMP setup sets the backend to `off`. This disables future OMP memory injection/retention but does not delete existing OMP memory data.

### DCP (`opencode-dcp`)

**Plugin name:** `opencode-dcp`

**Why it conflicts:** DCP is a separate context-pruning plugin. Two context managers cannot run together — they operate on the same context window with incompatible assumptions about what has been removed and when.

**Resolution:** Remove `opencode-dcp` from your `plugin` list in `opencode.json`. Setup and doctor both detect and flag this. Other DCP functionality (if any) is not restored — DCP and Magic Context are mutually exclusive.

### oh-my-opencode (OMO) hooks

OMO is broadly compatible with Magic Context — most of its features work fine alongside it. Three specific hooks conflict:

| Hook | Why it conflicts |
|---|---|
| `preemptive-compaction` | Triggers compaction that conflicts with the historian |
| `context-window-monitor` | Injects usage warnings that overlap with Magic Context's nudges |
| `anthropic-context-window-limit-recovery` | Triggers emergency compaction that bypasses the historian |

**Resolution:** Setup offers to disable these three hooks. Doctor detects them and offers the same fix. All other OMO hooks and features are unaffected.

## What "Magic Context disabled itself" looks like

When a conflict is active:

- **OpenCode TUI/Desktop:** The sidebar shows "Magic Context disabled" with a brief reason. Run `/ctx-status` for the full conflict list.
- **Pi:** The footer shows a disabled state. Run `/ctx-status` for details.
- **OMP:** The Pi-compatible extension uses the same Magic Context footer and `/ctx-status` command.

All three surfaces tell you exactly which conflict was found. Once you resolve it and restart the harness, Magic Context re-enables itself automatically — no other action needed.

## Resolving conflicts

```bash
# Auto-detect and interactively fix conflicts
npx @cortexkit/magic-context@latest doctor

# Auto-fix without prompts (applies all safe fixes)
npx @cortexkit/magic-context@latest doctor --force
```

After fixing, restart your harness to confirm Magic Context has re-enabled itself.
