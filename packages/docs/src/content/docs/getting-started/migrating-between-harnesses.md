---
title: Migrating between harnesses
description: How to move an existing OpenCode session to Pi or OMP, carrying messages and Magic Context state with it.
---

If you have an active OpenCode session and want to continue it in Pi or OMP, the `doctor migrate` command converts it into a Pi-compatible session file — including the session's messages, compartments, and session facts.

:::note
Migration currently supports **OpenCode → Pi/OMP** only. Reverse migration is not yet supported.
:::

## When you'd want this

- You want to switch primary coding environments mid-project without losing session context
- You want to try Pi or OMP on a session that has built up significant history in OpenCode
- You're migrating your workflow from OpenCode to a Pi-compatible host and want to bring existing sessions along

## What carries over

| Item | Carried over? |
|---|---|
| Message content (text, tool calls, reasoning) | ✅ Yes |
| Token counts (input/output/cache) | ✅ Yes (needed for Pi's context usage display) |
| Compartments | ✅ Yes (remapped to Pi entry IDs) |
| Session facts | ✅ Yes |
| Project memories | ✅ Always shared (same database, no migration needed) |
| File attachments | ⚠️ Replaced with `<file omitted: name>` markers |
| Reasoning signatures | ❌ Stripped |

Project memories are **always shared** among OpenCode, Pi, and OMP sessions for the same project — they live in the shared database and do not need migration. Migration only copies session-level state (messages and compartments).

## Run the migration

First, find the session ID of the OpenCode session you want to migrate. You can see session IDs in OpenCode's session picker or via the dashboard.

Then run:

```bash
npx @cortexkit/magic-context@latest doctor migrate \
  --from opencode --to pi --session <session-id>
```

Use `--to omp` instead to write into OMP's active profile/XDG session directory:

```bash
npx @cortexkit/magic-context@latest doctor migrate \
  --from opencode --to omp --session <session-id>
```

To preview what the migration would do without writing any files:

```bash
npx @cortexkit/magic-context@latest doctor migrate \
  --from opencode --to pi --session <session-id> --dry-run
```

To migrate only the most recent N messages (useful for very long sessions where you only need recent context):

```bash
npx @cortexkit/magic-context@latest doctor migrate \
  --from opencode --to pi --session <session-id> --max-messages 500
```

## What happens

1. The migrator reads the OpenCode session from `~/.local/share/opencode/opencode.db`
2. It converts the messages into Pi's JSONL format and writes the file to `~/.pi/agent/sessions/`
3. Compartments and session facts are copied into the shared Magic Context database (`~/.local/share/cortexkit/magic-context/context.db`) under the new Pi session ID
4. A compaction marker is inserted so Pi recognizes the boundary between migrated and new messages

After migration, restart Pi. The new session will appear in Pi's session picker.

:::caution
Compartment boundary IDs are remapped from OpenCode message IDs to Pi entry IDs. Where an exact match isn't found, the nearest boundary at-or-before is used. The migrated session will load and compress correctly, but if you run `/ctx-recomp` it will rebuild from the migrated messages.
:::

## After migration

Once Pi has loaded the session, you can continue working normally. The historian will treat the migrated compartments as compressed history and the full session context is available via `ctx_expand`.
