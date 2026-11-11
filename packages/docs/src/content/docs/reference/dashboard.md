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

**Stable token (optional):** to keep the same URL across restarts, for example a bookmark or an always-on service behind a private network, create a `dashboard-token` file in the Magic Context storage directory, readable only by you. That is `$MAGIC_CONTEXT_STORAGE_DIR/dashboard-token` when you set that override, otherwise `${XDG_DATA_HOME:-~/.local/share}/cortexkit/magic-context/dashboard-token`. On macOS and Linux:

```sh
dir="${MAGIC_CONTEXT_STORAGE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cortexkit/magic-context}"
mkdir -p "$dir"
(umask 077 && openssl rand -hex 32 > "$dir/dashboard-token")
```

On Windows (PowerShell), the file lives under `%USERPROFILE%\.local\share` unless one of those variables is set:

```powershell
$data = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { "$env:USERPROFILE\.local\share" }
$dir = if ($env:MAGIC_CONTEXT_STORAGE_DIR) { $env:MAGIC_CONTEXT_STORAGE_DIR } else { "$data\cortexkit\magic-context" }
$file = "$dir\dashboard-token"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
-join ($bytes | ForEach-Object { $_.ToString('x2') }) | Set-Content -NoNewline -Encoding ascii $file
```

A file created under your profile already inherits access for only you, SYSTEM and Administrators. If it is somewhere else, or the dashboard warns that other users can access it, replace its access list with one entry for you: `icacls $file /reset` followed by `icacls $file /inheritance:r /grant:r "*$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value):F"`. `/reset` drops entries someone granted on the file directly, and `/inheritance:r` drops the ones it inherited. On macOS, "only you can read" is checked against the file's access-control list as well as its mode, because an entry added with `chmod +a` grants access without changing the mode. If the dashboard warns that other users can reach the file, see what it carries with `ls -le` and drop the entry with `chmod -a`, e.g. `chmod -a "user:nobody allow read" $file`. Keep the file on an APFS or HFS+ volume: on FAT and exFAT every file reports mode `0700` whatever `chmod` sets, so a token file there is always refused.

`--serve` then uses that token instead of a random one. Because the token outlives the process, the dashboard never prints it or hands it to the browser launcher: it prints `Using the stable token from <path>` and the URL with a `<token>` placeholder, and does not open a browser. Open `http://127.0.0.1:9077/#token=` followed by the file's contents yourself, or bookmark it. The file is used only when it is a regular file (not a symlink) that only you can read: on macOS, owned by you with mode exactly `0600` and no access-control entry granting anyone else; on Linux, owned by you with mode exactly `0600`; on Windows, owned by you (or by SYSTEM or Administrators, as an elevated shell creates it) and with an access list that grants access to no one but you, SYSTEM and Administrators. Its contents, after trimming whitespace, must be 32 to 512 characters from `A–Z a–z 0–9 - . _ ~`. Otherwise the dashboard prints a warning naming the failed check and falls back to a random token. A stable token does not change the binding rules: reaching the dashboard from another machine still needs `--host` and `--allow-remote`. Anyone with the token has the same access you do, so treat the file like a password. The file is read once at startup, so deleting or replacing it does not affect a `--serve` process that is already running: stop that process and start it again to revoke the old token, and expect the new one to be picked up only on the next start.

## Updates

Production builds use Tauri’s updater against the project release manifest (`latest.json` on the project GitHub Pages site). When an update is available, the app shows an **Update available** toast with **Install & Restart**. You can also use the tray **Check for Updates** action for an interactive download-and-install flow.

The plugin must have run at least once so `context.db` exists (see dashboard README for default paths on your OS).

The sidebar has six sections: **Projects**, **Workspaces**, **Cache**, **User Directives**, **Config**, and **Logs**. Memories, sessions, dreamer, and primers all live *inside* a project rather than as flat global tabs.

## Projects

The landing view is a grid of **project cards** sorted by last activity, each showing session count, memory count, workspace membership, active harness badges (OC / Pi), and the last-active time. Search by name or path. Click a card to open that project's detail view, which has four sub-tabs:

### Sessions

Browse the project's OpenCode and Pi-compatible sessions (including OMP): compartments, facts, notes, smart notes, token breakdown, and subagent stats.

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

**How to read the timeline.** Start with [Where a pass lands](/concepts/context-reduction/#where-a-pass-lands): the execute percentage is a trigger, not a target, so a post-pass bar can land at any retained size.

- The timeline is segmented by context-limit changes; each segment has its own y-axis scale. Bars show prompt size against the window with an inner fill for the cached portion, and drop markers where Magic Context initiated a reclaim.
- Severity per turn: `stable`, `info`, `warning`, `warming`, `bust`, `full_bust`. A **bust** means the cached prefix was largely invalidated, so expect higher fresh token use on the next call. Sessions whose provider does not report cache data show as `UNKNOWN`.
- Click a bar to scroll to the matching turn in the list; expand a turn for step-level events and the bust cause recorded by the plugin.
- A **recent sessions** strip (measurement-driven, equal-width cards) summarizes recent sessions; select one to focus the chart. The event-window size is selectable. Polling can be paused, and subagent sessions can be hidden.
- **Claude Code and Codex sessions** appear in Cache Diagnostics with full cache hit/write timelines. Sessions managed by Magic Context are shown by default with a "Managed" badge; a toggle reveals unmanaged ones.

<!-- screenshot: cache-timeline -->

## User Directives

**User-level** memories (separate from project memory): promoted entries that inject into every session as a `<user-profile>` block, plus **candidates** awaiting promotion.

- **Promote** a candidate into an active user memory.
- **Edit** content, **dismiss**, or **delete** promoted memories.
- **Delete** candidates you do not want promoted.
- Dismiss is reversible: dismissed memories stay listed (filter by **Dismissed**), and **Restore** returns one to the active set where it is injected into `<user-profile>` again.

Collection is driven by the **`review-user-memories`** dreamer task: schedule it to collect, set its schedule to `""` to turn it off.

<!-- screenshot: user-memories -->

## Config

Visual editor for Magic Context JSONC. Because every harness reads one shared CortexKit config, this is a single **User Config** surface plus **per-project** overrides (no separate harness tabs).

- Toggle and edit fields that mirror `magic-context.schema.json` (the editor links the schema URL and parses JSONC including comments and trailing commas; saves abort on a parse error so comments and sibling keys are preserved).
- **Save** writes real files on disk via the Tauri backend, not a preview buffer.
- Model pickers merge OpenCode and available Pi/OMP model lists (with provider prefixes normalized), and you can always type a model id directly when a discovered list is present — discovery is never exhaustive.

Use [Configuration](/reference/configuration/) for the full generated key reference; use this section for day-to-day edits.

<!-- screenshot: config-editor -->

## Logs

Optional **log tail** for `magic-context.log` with filtering, useful alongside Cache when correlating busts with plugin log lines. The log path defaults to `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi); set the `MAGIC_CONTEXT_LOG_PATH` environment variable to redirect it.
