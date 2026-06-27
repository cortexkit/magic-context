---
title: Dashboard
description: The Magic Context desktop app for memories, session history, cache diagnostics, dreamer, and config editing.
---

The **Magic Context Dashboard** is a Tauri desktop app that reads and writes the same SQLite store and config files as the plugin. Use it when you want to browse or fix memories, inspect compartment history, debug provider cache behavior, inspect dreamer schedules and runs, or edit `magic-context.jsonc` without hand-editing JSON in an editor.

## Download

Prebuilt installers for every release are on the [dashboard releases page](https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true). Each release ships builds for:

- **macOS**: Apple Silicon (`darwin-arm64`) and Intel (`darwin-x64`) `.dmg` (signed and notarized)
- **Windows**: x64 and ARM64 `.exe` (and an `.msi` for x64)
- **Linux**: x64 and ARM64 `.AppImage`, `.deb`, and `.rpm`

Grab the file for your platform from the newest `dashboard-vX.Y.Z` release. The dashboard reads the same SQLite store as the plugin, so it is safe to run alongside any plugin version (it degrades gracefully if your database predates the plugin features it surfaces).

You can also build from source: see the dashboard `README` in the [magic-context](https://github.com/cortexkit/magic-context) repo (`packages/dashboard`).

## Browser mode (`--serve`)

The dashboard normally runs as a desktop window (an embedded WebView). On some Linux distributions and under WSL2 that embedded WebView fails to start (a blank window, often with `Could not create default EGL display` in the terminal) because the bundled WebKitGTK does not match the host's graphics stack. For those cases the same binary can run as a **local web server** instead, which you then open in your normal browser. No WebView is created, so the graphics issue is bypassed entirely.

Run the installed binary with `--serve`:

```sh
# Linux (.deb / .rpm install puts it on PATH)
magic-context-dashboard --serve

# Linux AppImage
./Magic_Context_Dashboard.AppImage --serve

# macOS
"/Applications/Magic Context Dashboard.app/Contents/MacOS/magic-context-dashboard" --serve

# Windows
"%LOCALAPPDATA%\Programs\Magic Context Dashboard\Magic Context Dashboard.exe" --serve
```

It prints a URL with a one-time access token in the fragment and opens it in your default browser automatically when a desktop display is present:

```
Magic Context Dashboard serve mode listening on 127.0.0.1:9077
Open this URL: http://127.0.0.1:9077/#token=<token>
```

On a headless or WSL2 host (no display) it just prints the URL; open it in a browser yourself. Under WSL2, `localhost` is forwarded to the Windows host, so the URL works in your **Windows** browser.

**Options:**

- `--serve`: serve on `127.0.0.1:9077` (default).
- `--serve <port>`: use a different port, e.g. `--serve 8080`.
- `--host 0.0.0.0 --allow-remote`: bind all interfaces so another machine can reach it. This is **off by default and requires the explicit `--allow-remote` flag**, because the dashboard can read every session transcript, edit your config, and run model-discovery subprocesses, all over plain bearer-token HTTP. Prefer an SSH tunnel over binding to an open network.

**Security:** access is gated by a per-process random token delivered in the URL fragment (never sent to the server or logged) and sent as an `Authorization: Bearer` header on each request. By default the server only binds loopback (`127.0.0.1`) and only accepts requests whose `Host` is loopback, which blocks DNS-rebinding. The token is required for every data request; the page shell itself carries no data.

## Updates

Production builds use Tauri’s updater against the project release manifest (`latest.json` on the project GitHub Pages site). When an update is available, the app shows an **Update available** toast with **Install & Restart**. You can also use the tray **Check for Updates** action for an interactive download-and-install flow.

The plugin must have run at least once so `context.db` exists (see dashboard README for default paths on your OS).

The sidebar has six sections: **Projects**, **Workspaces**, **Cache**, **User Directives**, **Config**, and **Logs**. Memories, sessions, dreamer, and primers all live *inside* a project rather than as flat global tabs.

## Projects

The landing view is a grid of **project cards** sorted by last activity, each showing session count, memory count, workspace membership, active harness badges (OC / Pi), and the last-active time. Search by name or path. Click a card to open that project's detail view, which has four sub-tabs:

### Sessions

Browse the project's OpenCode and Pi sessions: compartments, facts, notes, smart notes, token breakdown, and subagent stats.

- Filter by harness and search; hide subagent sessions.
- Open a session and switch tabs: messages, **compartments**, facts, notes, historian runs, tokens.
- **Compartment viewer:** message ranges, v2 **tiers** (`p1`–`p4`) with the same fallback chain as runtime rendering, **importance** bands (critical/high/medium/low/minimal), and episode tags.
- Edit or dismiss **session notes** and manage **smart notes**; edit or delete **session facts**.

Use this when `/ctx-status` is not enough and you need to read what the historian actually stored.

### Memories

The project's **project memories**: search, filter by category/status, and open a detail panel.

- **Edit** content and change status (`active`, `permanent`, `archived`).
- **Archive** or **permanently delete** individual memories (delete is confirmed in the UI).
- **Bulk select** rows and **bulk archive** or **bulk delete** with confirmation.
- View metadata: category, source (`historian`, `agent`, `dreamer`, `user`), classify columns (importance / scope / shareable), merge lineage, embeddings flag.

Changes write to the shared database; **running sessions pick up memory updates automatically** on subsequent turns without restarting the harness.

### Dreamer

Per-task **schedules**, last-run status, and recent **runs** for this project.

- See each task's effective schedule (global config merged with any per-project override), next run / overdue state, last run time, and last failure.
- Toggle a task on/off (writes the task's `schedule` into the project's local `magic-context.jsonc`).
- Expand a run for per-task duration, token usage, smart-note surfacing counts, and memory change breakdown (written/archived/merged).
- Trigger runs from your session with `/ctx-dream` (the dashboard reflects schedule state read-only; it does not run the dreamer itself).

### Primers

The project's **primers**: recurring standing questions the historian noticed, promoted into durable answers the dreamer keeps fresh against current code. Browse the promoted questions and their synthesized answers.

<!-- screenshot: project-detail -->

## Workspaces

Group multiple project repos into a **workspace** so their project memories pool across member sessions (useful for multi-repo microservice setups). Create a workspace, add or remove member projects, and choose which memory categories are shared (CONSTRAINTS only, by default). Edits stage in the card and apply together on **Save** so an incremental change does not trigger several cache busts.

<!-- screenshot: workspaces -->

## Cache (diagnostics)

Live **provider cache** telemetry: per-turn cache read/write, input tokens, and severity.

**How to read the timeline.**

- The timeline is segmented by context-limit changes; each segment has its own y-axis scale. Bars show prompt size against the window with an inner fill for the cached portion, and drop markers where Magic Context initiated a reclaim.
- Severity per turn: `stable`, `info`, `warning`, `warming`, `bust`, `full_bust`. A **bust** means the cached prefix was largely invalidated, so expect higher fresh token use on the next call. Sessions whose provider does not report cache data show as `UNKNOWN`.
- Click a bar to scroll to the matching turn in the list; expand a turn for step-level events and the bust cause recorded by the plugin.
- A **recent sessions** strip (measurement-driven, equal-width cards) summarizes recent sessions; select one to focus the chart. The event-window size is selectable. Polling can be paused, and subagent sessions can be hidden.

<!-- screenshot: cache-timeline -->

## User Directives

**User-level** memories (separate from project memory): promoted entries that inject into every session as a `<user-profile>` block, plus **candidates** awaiting promotion.

- **Promote** a candidate into an active user memory.
- **Edit** content, **dismiss**, or **delete** promoted memories.
- **Delete** candidates you do not want promoted.

Collection is driven by the **`review-user-memories`** dreamer task: schedule it to collect, set its schedule to `""` to turn it off.

<!-- screenshot: user-memories -->

## Config

Visual editor for Magic Context JSONC. Because both harnesses now read one shared CortexKit config, this is a single **User Config** surface plus **per-project** overrides (no separate OpenCode/Pi tabs).

- Toggle and edit fields that mirror `magic-context.schema.json` (the editor links the schema URL and parses JSONC including comments and trailing commas; saves abort on a parse error so comments and sibling keys are preserved).
- **Save** writes real files on disk via the Tauri backend, not a preview buffer.
- Model pickers use cached provider model lists refreshed in the background.

Use [Configuration](/reference/configuration/) for the full generated key reference; use this section for day-to-day edits.

<!-- screenshot: config-editor -->

## Logs

Optional **log tail** for `MAGIC_CONTEXT_LOG_PATH` (fallback: `${TMPDIR}/opencode/magic-context/magic-context.log`, `pi/` for Pi) with filtering — useful alongside Cache when correlating busts with plugin log lines. Open from the sidebar **Logs** item.
