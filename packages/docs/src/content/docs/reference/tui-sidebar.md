---
title: TUI Sidebar
description: Persist the OpenCode sidebar's collapsed state, reorder it, rename the header, and show or hide sections.
---

In OpenCode's TUI, Magic Context renders a live sidebar panel in the same style as the other CortexKit plugins:

```text
 ▼ MAGIC CONTEXT                  v0.49.35

Context
ctx ██████░░░░ 45% left          483K/872K
Next summary at                 61% · +49K

History
Historian                             idle
Last run                    1h55m ago · ok
Model                     Gemini 3.8 Flash

Prompt cache
Cache built                        29h ago

Knowledge
Memories                       225 · 7 new
```

- **Context** — how much of the session's usable window is in use (the bar fills with use; the figure is what is left), and the usage at which the next summary starts with the tokens until then. The bar turns to the warning colour at your execute threshold and to the error colour in the force band above it. With `compaction.enabled: false` this section shows the window usage under native compaction, notes and archived compartments instead.
- **History** — whether the historian is idle, running or failing, when it last ran and how that run ended, and the model it used.
- **Prompt cache** — how long ago the session's history head was last rebuilt.
- **Knowledge** — the project's active memories, and how many arrived since that rebuild.

While `/ctx-recomp`, an upgrade, `/ctx-embed` or `/ctx-wrapup` runs, a section with its progress appears as well. Click the header to collapse the panel to one row (`ctx  45% left ●`), or expand it again. The token breakdown, dreamer state and queue are in `/ctx-status`.

The sidebar is enabled by the setup wizard, which adds the TUI plugin entry to `~/.config/opencode/tui.jsonc`. If you removed it (or skipped setup), run `npx @cortexkit/magic-context@latest doctor` to add it back. Removing the entry from `tui.jsonc` disables the sidebar permanently — Magic Context never re-adds it on its own.

By default the sidebar reopens expanded every time you restart. To make the collapsed state (and a few other preferences) stick, add a `magic-context` entry to a **shared** TUI preferences file.

:::note
This file is **only** for TUI sidebar appearance. It is separate from `magic-context.jsonc` (which configures the engine). It does nothing in Pi, which uses a footer status line instead of a sidebar.
:::

## The file

```text
~/.config/opencode/tui-preferences.jsonc
```

Override the path with `OPENCODE_TUI_PREFERENCES_FILE=/path/to/tui-preferences.jsonc`.

The file is **shared** across CortexKit OpenCode plugins — one top-level key per plugin. Magic Context reads the `magic-context` key and never touches another plugin's keys (your comments and their settings are preserved when either side updates the file). It is optional and safe to hand-edit; if it's missing or malformed, defaults apply and the sidebar keeps working.

```jsonc
{
  "magic-context": {
    "forceToTop": false,
    "order": 170,

    "startCollapsed": false,
    "rememberCollapsed": true,
    "collapsed": false,

    "header": {
      "label": "MAGIC CONTEXT"
    },

    "sections": {
      "context": true,
      "history": true,
      "cache": true,
      "knowledge": true
    }
  }
}
```

## What each key does

| Key | Default | Effect |
|---|---|---|
| `forceToTop` | `false` | Pin the sidebar above other TUI plugins, ignoring `order`. |
| `order` | `170` | Sort position among TUI plugins (lower = higher up). OpenCode's built-ins occupy 100–500. |
| `startCollapsed` | `false` | Whether the sidebar starts collapsed when there's no remembered state. |
| `rememberCollapsed` | `true` | Persist collapse/expand across restarts. When `true`, clicking the header writes `collapsed` back to this file. |
| `collapsed` | — | The remembered collapse state. Managed automatically when `rememberCollapsed` is on; you can also set it by hand. |
| `header.label` | `"MAGIC CONTEXT"` | Rename the sidebar header. |
| `sections.*` | all `true` | Show or hide each expanded-view section: **context** (usage bar, next summary), **history** (historian state, last run, model), **cache** (prompt cache rebuild time), **knowledge** (memories). Keys from earlier releases (`historian`, `memory`, `status`, `dreamer`, `stats`) are ignored. |

The header always renders, and the progress section appears whenever a rebuild runs — only the listed sections can be hidden.

## Live reload

Edits to `header`, `sections`, and the collapse defaults apply **live** while the TUI is running. Changes to `order` and `forceToTop` (layout position) take effect on the next restart.

## Coordinating with other CortexKit plugins

`order` defaults are spaced so the CortexKit plugins stack predictably out of the box: `anthropic-auth` at 160, `magic-context` at 170, `aft` at 180 (top to bottom). Set your own `order` on any of them to rearrange, or `forceToTop` to pin one above the rest.
