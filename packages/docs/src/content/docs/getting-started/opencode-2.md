---
title: OpenCode 2
description: Install Magic Context on OpenCode 2, move an existing OpenCode 1 install safely, and know what differs on a 2.x host.
---

Magic Context supports OpenCode 2 from version 0.43.0. A 2.x session gets the same context management, memory, session history, search, notes, and `/ctx-*` commands as on OpenCode 1. Read this page if you are installing on OpenCode 2, or upgrading an existing OpenCode 1 install to 2.x.

:::caution
Earlier releases do not work on OpenCode 2: 0.42.5 never answers on a 2.x host, and 0.42.6 refuses every turn on a data directory that ever held OpenCode 1 sessions. Use 0.43.0 or newer.
:::

## Install on OpenCode 2

Run the same setup wizard as on OpenCode 1:

```bash
npx @cortexkit/magic-context@latest setup
```

The wizard runs `opencode --version` to tell which OpenCode it is configuring. On OpenCode 2 it registers the plugin under the plural `plugins` key in `opencode.jsonc` and turns off built-in compaction:

```jsonc
{
  "plugins": ["@cortexkit/opencode-magic-context@latest"],
  "compaction": { "auto": false, "prune": false }
}
```

OpenCode 2 reads both the older `plugin` array and its own `plugins` array, and loads every entry in both. Setup and `doctor` check both keys, so a registration under either one is recognized and never added a second time. If you already have an entry, setup updates it under the key where it found it. Both plain strings and the `{ "package": ..., "options": ... }` object form OpenCode 2 uses are recognized. An OpenCode Desktop install with no `opencode` command on your PATH cannot be version-checked, so setup keeps the OpenCode 1 `plugin` key there.

Setup does **not** write `tui.json` on OpenCode 2. That file is read only by OpenCode 1. On 2.x the [terminal sidebar](/reference/tui-sidebar/) loads from the plugin entry itself.

The shared `magic-context.jsonc` is the same file on every harness; see [Installation](/getting-started/installation/) for its locations and the historian model setting.

If you add the entry by hand, use `plugins` on 2.x. Do not list Magic Context under both keys: OpenCode loads the first entry and fails the second with "Duplicate plugin ID", so the plugins list shows two rows, one of them failed. `opencode plugin add` can create exactly this when an entry already sits under `plugin`. `npx @cortexkit/magic-context@latest doctor --fix` keeps one entry and removes the rest.

## Updating Magic Context on OpenCode 2

:::caution[Back up before upgrading OpenCode to 2.1]
Once an OpenCode 2.1 host has compacted a store, OpenCode 2.0.x cannot reopen that store's compacted sessions. Stop OpenCode and back up its data directory before upgrading. To return to 2.0.x, restore the pre-upgrade backup; downgrading Magic Context does not convert the host's compaction format back.
:::

OpenCode 2 does not update an installed plugin on its own, even when the entry says `@latest`. It installs the plugin once and keeps loading that copy. When a new release is published, OpenCode only marks the plugin "update available" in `/plugins`; pressing ctrl+r there refreshes that mark, but installs nothing.

To install the new release, do one of these:

- Open `/plugins`, select Magic Context and press ctrl+u.
- Run `opencode plugin update`.
- Quit OpenCode (including `opencode service stop`) and run `npx @cortexkit/magic-context@latest doctor --fix`. Doctor removes the outdated cached copy, and OpenCode installs the current release on its next start. Doctor won't remove it while OpenCode is running.

After ctrl+u or `opencode plugin update`, restart OpenCode.

On Windows, `doctor --fix` can't tell whether OpenCode is using the cached copy, so it leaves it in place: update from OpenCode as above, or quit OpenCode and delete the folder `doctor` names; the next start installs the current release.

An entry pinned to a version, such as `@cortexkit/opencode-magic-context@0.42.6`, never moves. Change it to `@latest`, or run `doctor --force` to do that for you.

## Move an existing OpenCode 1 install

The first time OpenCode 2 opens an OpenCode 1 data directory, it converts `opencode.db` in place. Do one step **before** you upgrade OpenCode:

1. Stop every OpenCode process.
2. Run the doctor with `--fix`:

   ```bash
   npx @cortexkit/magic-context@latest doctor --fix
   ```

3. Upgrade OpenCode to 2.x and start it.

### Why this step matters

OpenCode 2 drops an OpenCode 1 compaction record whose summary has no completion time. Magic Context's compaction markers from earlier releases did not carry that time. If such a marker is dropped during conversion, a long session loads its entire history instead of the summarized part. That can use extreme memory and CPU, and the session may never reach Magic Context at all.

`doctor --fix` adds the missing completion time to Magic Context's own markers. It never touches summaries OpenCode wrote itself. Markers written by current versions already carry the time.

### If OpenCode 2 already converted the store

If `doctor` reports that some Magic Context markers did not carry over, no action is needed. Magic Context on OpenCode 2 does not use OpenCode's compaction records: it keeps its own boundary and re-derives compartment positions from the messages that survived. A converted session without the marker is in the same state as a session started on OpenCode 2.

Do not clear `kv.migration.v1-v2` to make OpenCode 2 convert again. An earlier version of this page recommended that, and it was wrong. The conversion rebuilds each OpenCode 1 session from its OpenCode 1 rows and deletes that session's OpenCode 2 messages first, so every message added on OpenCode 2 after the first conversion is lost.

If you already did it, restore `opencode.db` (with its `-wal` and `-shm` files) from a backup taken before the reconversion.

Do not edit the `session_v2` or `session_message` tables directly.

## What converts, and what converts back

OpenCode 2 keeps the OpenCode 1 tables next to its own. That is what lets you downgrade OpenCode later.

The conversion renumbers messages. It splits some content into rows of its own and merges completed compaction pairs into one record. Magic Context saves positions in that message list: where each [compartment](/concepts/historian/) starts and ends, note anchors, the search index, and the protected tail. On the first turn of each session after a conversion, Magic Context re-derives all of those positions from the ids of messages that still exist, in one step.

A downgrade to OpenCode 1 does the same thing in reverse. Each session pays **one prompt-cache rebuild per direction**: one after the upgrade, one after a downgrade.

A few things can come out of the conversion slightly different:

- **A compartment whose first or last message no longer exists is marked unresolved.** It still appears in the agent's session history and is still readable by id. `ctx_expand` refuses to expand its message range, because that range can no longer be trusted. The next conversion in either direction checks it again.
- **A queued `ctx_reduce` drop that would now cover more than it originally did is discarded** and reported, not applied.
- `doctor` lists sessions still waiting for this step and the number of unresolved compartments in each session.

Fresh OpenCode 2 sessions, Pi sessions, and project memory are not affected.

If you downgrade OpenCode, keep Magic Context on the current version. Older Magic Context releases refuse the upgraded database; see [Storage unavailable / schema fence error](/help/troubleshooting/#storage-unavailable--schema-fence-error).

## Idle checkpoints for long sessions

Magic Context automatically asks OpenCode to checkpoint a long session after it has been idle past the configured cache lifetime. This is on by default when Magic Context compaction is enabled; there is no extra setting to turn on. It also works with the built-in `compaction.auto: false` configuration written by setup.

OpenCode otherwise loads the history since its last host checkpoint on every step, even when Magic Context sends only a small prompt to the model. After at least 1,000 stored history rows, an idle checkpoint moves that starting point forward. It runs between turns, not while the model is answering, and waits until the configured idle lifetime has elapsed. With `cache_ttl: "never"`, no automatic idle checkpoint is scheduled.

The checkpoint uses Magic Context's own summary, without another model summarization call. OpenCode retains the source history; the next turn still receives the Magic Context summary and unsummarized tail, including after a restart. If the optional replay cache has been evicted, Magic Context restores the needed rows from the host store instead of dropping messages.

## Known limits on OpenCode 2

These come from what the OpenCode 2 host lets a plugin do.

### Echoed tags can show in the transcript

Magic Context marks each item the agent sees with a `§N§` tag. Models sometimes echo a tag at the start of a reply. OpenCode 1 lets Magic Context strip that echo once the reply finishes, before it is saved. OpenCode 2 has no hook after a reply finishes, so the echo is saved and shown as the model wrote it. Weaker models do this more often.

What the model receives is unchanged: the next request strips and re-tags the echo exactly as on OpenCode 1. Only the transcript view differs.

### A first start can be killed mid-conversion

Converting a large store can take several minutes. `opencode service start` may decide the server is unresponsive during that time and kill it. For the first start after upgrading a large install, run the server by hand and leave it until conversion finishes:

```bash
opencode serve --port 4096
```

Conversion is finished when `SELECT value FROM kv WHERE key = 'migration.v1-v2';` returns `{"phase":"completed"}`. After that, start OpenCode the usual way.

### The historian runs single-shot

On OpenCode 2 each [historian](/concepts/historian/) run is one request with no tool calls. It runs on the historian's configured model, in a hidden session.

The [dreamer](/concepts/dreamer/) also runs tool-loop tasks on OpenCode 2: `map-memories`, `verify`, `verify-broad`, `curate`, `retrospective`, `maintain-docs`, and `refresh-primers`. Each uses a task-scoped hidden agent with only its permitted tools. Single-shot and host-only tasks continue to run as before.

### Hidden runs use native child sessions

Magic Context requires OpenCode 2.0.22 or newer. Startup checks the session API's capabilities, not the host's version string. Older hosts show one upgrade notice and refuse turns before a provider is called.

Every hidden run gets a fresh session, titled `Magic Context historian` or `Magic Context dreamer`. When started from a user session it is parented to that session and inherits its location. The native session API removes it when the run ends, without requiring `serve --service`.

With [`keep_subagents: true`](/reference/configuration/), settled children and historian children are kept for inspection. Unsettled dreamer children are removed. Kept sessions accumulate until manually cleared.

On upgrade, Magic Context removes children recorded by older hosts through the native API. Cleanup is bounded per boot and resumes on later boots until complete. It never rewrites the OpenCode store directly.

### Other differences

- **Command output** from the `/ctx-*` commands appears only in a connected terminal UI. The commands themselves run from any client.
- **The sidebar is hidden by default.** Toggle it with `ctrl+x b`.
- **`transform_mode: "rust"` runs the Rust module here too.** OpenCode 2 has no compaction row for Magic Context to write, so the module's fold boundary is recorded in Magic Context's own store and the host's compaction request is answered from the module's history.

## Where logs live

On OpenCode 2, Magic Context writes its log to a separate directory from OpenCode 1, under your system temp directory:

```text
$TMPDIR/opencode2/magic-context/magic-context.log
```

OpenCode 1 writes to `$TMPDIR/opencode/magic-context/magic-context.log`. On Linux, `$TMPDIR` is usually `/tmp`. Set `MAGIC_CONTEXT_LOG_PATH` to write the log somewhere else.

When Magic Context refuses a turn before it reaches the provider, the reason and session are written to this log. Include the log when you [file a bug report](/help/troubleshooting/#filing-a-bug-report).

Sessions created with an older experimental host-fold version keep their served request layout when reopened before the cache lifetime expires. Magic Context validates the old receipt without rebuilding the prefix. It records the new replay boundary only when expiry or another normal condition already permits a rebuild. An interrupted or deferred upgrade is retried without accepting a partial checkpoint.
