---
title: Installation
description: How to install Magic Context on OpenCode, Pi, or Oh My Pi using the interactive setup wizard, and how to verify your install.
---

import { Tabs, TabItem } from '@astrojs/starlight/components';

The setup wizard detects which harnesses you have installed, configures the plugin, and handles compatibility conflicts automatically. Run it once to get started.

## Requirements

- **Node.js >= 24** for the CLI
- **OpenCode** (current version) — for OpenCode installs
- **Pi >= 0.74.0** — for Pi installs
- **OMP >= 17.1.7** — for Oh My Pi installs

## Run setup

```bash
npx @cortexkit/magic-context@latest setup
```

The wizard auto-detects OpenCode, Pi, and OMP. It then:

1. Registers the plugin using the harness's native package manager
2. Disables built-in compaction where Magic Context takes ownership
3. Disables OMP automatic memory to prevent duplicate recall/retention
4. Prompts you to pick models for the historian and dreamer agents
5. Resolves conflicts with other context-management plugins
6. Writes a shared `magic-context.jsonc` with sensible defaults

Target one harness explicitly with `--harness opencode`, `--harness pi`, or `--harness omp`.

:::note
**Why is compaction disabled?** Magic Context manages context itself. Host compaction would interfere with the historian and double-compress history. Setup turns it off automatically. OMP's automatic memory backend is also disabled because two memory injectors would duplicate context and writes. Existing OMP memory data is not deleted.
:::

## What gets configured

<Tabs>
<TabItem label="OpenCode">

Setup adds the plugin to your `opencode.jsonc` and turns off compaction:

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context@latest"],
  "compaction": { "auto": false, "prune": false }
}
```

It also creates a `magic-context.jsonc` config file in the shared CortexKit location (the same across all harnesses; project overrides user):

| Path | Scope |
|---|---|
| `<project>/.cortexkit/magic-context.jsonc` | Project |
| `~/.config/cortexkit/magic-context.jsonc` | User-wide defaults |

</TabItem>
<TabItem label="Pi">

Setup adds the extension to Pi's settings and creates a `magic-context.jsonc` config file in the shared CortexKit location (the same across all harnesses; project overrides user):

| Path | Scope |
|---|---|
| `<project>/.cortexkit/magic-context.jsonc` | Project |
| `~/.config/cortexkit/magic-context.jsonc` | User-wide defaults |

:::note
Pi setup prompts for `thinking_level` if you pick a `github-copilot/*` reasoning model — Copilot requires it and rejects the default value Pi would send otherwise. The wizard handles this for you.
:::

</TabItem>
<TabItem label="Oh My Pi (OMP)">

Setup installs `@cortexkit/pi-magic-context` through `omp plugin`, verifies it is effectively enabled for the current project, and writes the same shared CortexKit config used by OpenCode and Pi. It honors named OMP profiles, `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, and initialized XDG layouts.

OMP setup transactionally applies:

```bash
omp config set compaction.enabled false
omp config set memory.backend off
```

If plugin registration or config writing fails, the prior OMP settings are restored.

</TabItem>
</Tabs>

## Manual setup (OpenCode)

If you cannot run the wizard, add this to `opencode.jsonc`:

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context@latest"],
  "compaction": { "auto": false, "prune": false }
}
```

Then create `magic-context.jsonc` with the one setting the historian needs:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json",
  "historian": { "model": "provider/model-id" }
}
```

- **Required:** `historian.model` must be a real `provider/model-id`. Without it, the plugin loads but historian runs fail, older history is not summarized, and repeated failures show a `Magic Context — history comparting needs attention` notice.
- **Optional:** `dreamer` and `sidekick` model/disable blocks. Omit them to leave periodic memory consolidation and `/ctx-aug` off.
- **Optional:** `embedding`. Omit it to use the local `Xenova/all-MiniLM-L6-v2`; turning embeddings off removes semantic/embedding-backed search, but keyword search and context management continue.

User-level config is `~/.config/cortexkit/magic-context.jsonc` on macOS/Linux and `%USERPROFILE%\.config\cortexkit\magic-context.jsonc` on Windows (or `$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc` when set). OpenCode Desktop users can use the dashboard's config editor or hand-edit that file; Desktop does not include the CLI setup wizard.

## Verify the install

After setup, restart your harness (or run `/reload-plugins` in OMP) so the plugin loads.

<Tabs>
<TabItem label="OpenCode">

Run `/ctx-status` in the OpenCode TUI or Desktop. You should see a status view with context usage, tag counts, and historian state. A live sidebar in the TUI also shows a real-time context breakdown after every message.

</TabItem>
<TabItem label="Pi">

Run `/ctx-status` in Pi. You should see a status line with context usage and Magic Context state. Pi also shows a status line in the footer when the plugin is active.

</TabItem>
<TabItem label="Oh My Pi (OMP)">

Run `/ctx-status` in OMP. The Magic Context footer/status should be active, and `doctor --harness omp` should report native compaction and automatic memory as disabled.

</TabItem>
</Tabs>

## Check an existing install

If Magic Context is already installed and something isn't working, run the doctor:

```bash
npx @cortexkit/magic-context@latest doctor
```

Doctor auto-detects your harnesses and checks: plugin registration, config validity, conflicts, database integrity, and the embedding endpoint. It prints a `PASS X / WARN Y / FAIL Z` summary. If both OpenCode and Pi are installed, doctor asks which harnesses to diagnose; use `--harness opencode` or `--harness pi` to select one without prompting. When it finds multiple OpenCode installations, it prints a table with the active path, version, and source so a shadowed binary is visible.

Add `--force` to automatically fix what doctor can — it clears stale plugin caches and repairs common config issues. Add `--issue` to generate a sanitized bug report ready to file.

## Model configuration

The setup wizard helps you pick a model for the historian and dreamer agents — they don't need a top-tier model, and a model that bills per request (e.g. GitHub Copilot) keeps background-work cost flat. There's no hidden fallback to models you didn't configure; see the [configuration reference](/reference/configuration/) for `model` and optional `fallback_models`.

## Dashboard

Magic Context ships a companion desktop app for browsing memories, session history, cache diagnostics, and dreamer runs. See the [dashboard reference](/reference/dashboard/) or download it from the [GitHub releases page](https://github.com/cortexkit/magic-context/releases).
