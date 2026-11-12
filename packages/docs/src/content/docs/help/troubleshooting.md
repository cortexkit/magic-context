---
title: Troubleshooting
description: Common failure modes and how to fix them, organized by symptom.
---

Start with the doctor command — it covers most common issues automatically:

```bash
npx @cortexkit/magic-context@latest doctor
```

Add `--force` to auto-fix what it can. Add `--issue` to generate a sanitized bug report.

---

## Plugin not loading

**Symptom:** The TUI sidebar doesn't appear in OpenCode, `/ctx-status` returns an unknown command, or the Pi/OMP footer shows no Magic Context status.

**Fix — try in order:**

1. **Restart the harness.** After installation, restart OpenCode or Pi; in OMP, restart or run `/reload-plugins`.

2. **Run doctor.** Doctor verifies the plugin entry in your config, checks for version mismatches, and confirms the plugin package is present:
   ```bash
   npx @cortexkit/magic-context@latest doctor --force
   ```
   `--force` clears stale npm plugin caches that sometimes prevent the latest version from loading. On OpenCode 2, update the plugin as described in [Updating Magic Context on OpenCode 2](/getting-started/opencode-2/#updating-magic-context-on-opencode-2).

3. **Check for version pin conflicts.** If your `opencode.json` or npm config pins the plugin to an older version, the new package may not load. Remove explicit version pins and let `@latest` resolve.

4. **`.npmrc` `min-release-age` setting.** Some `.npmrc` configurations set a minimum release age before packages are treated as stable. If you have `prefer-stable` or `min-release-age` set, the latest Magic Context release may not be available to `npx`. Try running `npx --yes @cortexkit/magic-context@latest setup` to bypass the cache, or clear npm's download cache with `npm cache clean --force`.

---

## Doctor finds more than one installation

The doctor reports every detected OpenCode installation in a table with an `[active]` marker, path, version, and source. The first entry is the active path (PATH is checked first). If both harnesses are installed, use `--harness opencode` or `--harness pi` to select which doctor to run without a prompt.

```bash
npx @cortexkit/magic-context@latest doctor --harness opencode
```

---

## Merge split project identities

Use this when a single project directory has memories or sessions split between a `dir:` identity and a `git:` identity, or two historical Git roots. Nothing merges automatically, including `doctor --fix`.

```bash
# List observed splits and suggested source → target pairs
npx @cortexkit/magic-context@latest doctor merge-identities

# Read-only preview: review the identities and counts before confirming
npx @cortexkit/magic-context@latest doctor merge-identities \
  --from <source-id> --to <target-id>

# Close OpenCode, Pi, OpenCode 2 and ck-mc first, then confirm
npx @cortexkit/magic-context@latest doctor merge-identities \
  --from <source-id> --to <target-id> --apply
```

Prefer merging `dir:` into `git:`. For two Git roots, the suggestion uses the current resolver's lexicographically smallest root. The command refuses unknown or identical identities, different directories for two Git identities, and different workspace memberships (naming both workspaces). A target must resolve for an observed directory on this machine unless you explicitly use `--force`; that flag does not bypass the other safety checks.

The preview lists rows per table, duplicate memory IDs to collapse and potential conflicts to retain for review. Memories with the same category and normalized hash collapse into the target, retaining a superseded source audit row and file references. If a colliding hash contains different normalized text, both memories survive: the source gets a disambiguated hash and retains its original hash in metadata. Distinct memories in an overlapping category stay intact and receive `metadata_json.identity_merge_review`; this conservative marker is not a claim that the contents contradict each other. Notes keep their delivery state. Workspace aliases collapse or transfer. Dreamer retains run history, unions processed windows, deduplicates queued reasons, keeps successful progress and uses the target schedule to recompute the next due time. The earliest open broad-verification cycle remains open so completed checks are not repeated.

Before writing, the command checks host liveness and uses `lsof` to check database holders; an unavailable check refuses rather than assuming safety. It also checks that the backup volume has enough free space for the database bundle and identity sidecars, with a 10% safety margin. Keep all hosts closed throughout the operation. By default it prints a private backup directory beside `context.db`; use `--backup-root <absolute-dir>` to put the backup under another directory or volume (created with owner-only permissions when missing). It copies the database and any WAL/SHM files, and saves identity sidecars. **Save and run both printed restore commands with hosts closed** to restore the database/WAL and the sidecars together. Never copy a database backup over an open database.

After a successful merge, the command prints the backup path and total size. Keep it until you have confirmed the merge; it is safe to delete afterward. The command never deletes backups automatically.

The merge uses one immediate transaction, bumps the target memory epoch and updates sidecars only after commit. Repeating a successful merge has no further database mutations. Git indexes move with their existing embeddings; sweep leases reset so the next host can rebuild derived state. Existing memory embeddings remain valid because content does not change; FTS indexes follow the normal update triggers. On colliding generated caches/configuration, the target wins.

This repairs **context.db only**, without schema migrations. A project managed by the Rust module is refused by name: its data lives in the module store, and merging it will be possible once the single-store migration lands. The older `merge-identity --dry-run` / `--yes` spellings remain aliases for preview / apply.

---

## Storage unavailable / schema fence error

**Symptom:** After downgrading the plugin, you see a message like "schema fence: database was written by a newer version" or "Magic Context disabled itself — storage unavailable." Magic Context refuses to start.

**Why it happens:** The shared database has been migrated to a newer schema by a higher version of the plugin. Older plugin versions cannot safely open a database created by a newer one, so they fail closed (fail-safe).

**Fix:** Upgrade the plugin back to the version that last wrote the database (or a newer one):
```bash
npx @cortexkit/magic-context@latest setup
```

If you need to downgrade intentionally, run `doctor --force` afterward — it will report whether the schema is compatible. If not, the only option is to delete the database (`~/.local/share/cortexkit/magic-context/context.db`) and start fresh. **This deletes all memories and compartments** — back up first if you want to preserve anything.

### Running OpenCode 1 and OpenCode 2 side by side

Both hosts open the same `context.db`, but each keeps its own cached copy of the plugin: OpenCode 1 under `~/.cache/opencode/packages/`, OpenCode 2 under `~/.cache/opencode/npm/`. Neither host replaces a cached `@latest` install on its own. When the two copies differ, the newer one migrates the database on its first start and the older host then fails closed on every prompt.

`doctor` reads the version and schema fence of each cached copy, compares them with the newest migration in `context.db`, and names any cache directory that is behind. To bring that host up to date:

- **OpenCode 2:** follow [Updating Magic Context on OpenCode 2](/getting-started/opencode-2/#updating-magic-context-on-opencode-2).
- **OpenCode 1:** quit OpenCode 1 and delete the cache directory doctor names (for example `~/.cache/opencode/packages/@cortexkit/opencode-magic-context@latest`). OpenCode 1 installs the current release on its next start.

After each Magic Context release, update both hosts before using either one, so neither is left behind the database.

### Claude rejects a turn: conversation must end with a user message (OpenCode 1)

**The error:** On OpenCode 1, Anthropic sometimes refuses a turn with: “This model does not support assistant message prefill. The conversation must end with a user message.” It happens more often when background subagents or other tools post notices into a session.

**The cause:** OpenCode 1 has a race in its own step loop. Each step reads the history before it creates its reply. A message saved between those events, such as a background-task notice, sorts before the reply. The next request can then end on the model's own reply instead of a user message. This also happens with no plugins installed; Magic Context doesn't cause it and doesn't change the order.

**The fix:** Use OpenCode 2. It holds messages posted mid-step until the step ends and orders history by sequence, so this can't happen there. On OpenCode 1, send the next message to continue.

---

## Historian failures

**Symptom:** You see a recurring warning about the historian failing, or the historian progress in `/ctx-status` shows repeated retries.

**Why it happens:** The historian runs as a background agent with model selection separate from the main coding model. Transient provider failures can retry, but an unavailable primary model and unavailable configured fallbacks prevent new compartments.

**Fix:**

1. Check the harness-specific model in `magic-context.jsonc`: `historian.opencode.model` for OpenCode or `historian.pi.model` for Pi.
2. Run `doctor` to inspect the active configuration and reported provider errors.
3. Add ordered alternatives under the matching harness block's `fallback_models`. A configured historian uses only its primary and that list. Exhaustion reports failure; the active session model is never appended. Without a historian model, OpenCode inherits the session model, while Pi and Oh My Pi do not summarize.
4. If runs succeed but compartments are confusing, choose a stronger historian model. Summary quality comes from the historian model, not the main model. See [Historian → Choose the historian model](/concepts/historian/#choose-the-historian-model).

---

## Context stuck high

**Symptom:** Context usage stays near or above the execution threshold even after several turns. Historian seems to be running but the percentage doesn't drop.

**Fix — try in order:**

1. **Check `/ctx-status`.** Separate compartment history, protected recent work, queued drops, and reclaimable tool output. A historian run only shrinks settled conversation; its compartments remain in the prompt.

2. **Let eligible reclaim land.** Queued `ctx_reduce` work and automatic age-based reclaim apply on a pass that is already rebuilding the cache. Automatic reclaim never starts that rewrite by itself.

3. **Force a flush only when needed.** `/ctx-flush` explicitly applies queued operations. It invalidates the current cached prefix, so use it when immediate space matters more than preserving that cache.

4. **Rebuild compartments only if state is wrong.** `/ctx-recomp` rebuilds compartments from raw history. A long session can require several historian calls.

5. **Check the relevant budget.** `history_budget_percentage` controls retained compartment history, while `protected_tokens` controls recent token mass protected from normal reclaim. Use the [generated configuration reference](/reference/configuration/#context-management) for exact defaults and ranges.

The [worked percentage example](/concepts/context-reduction/#where-a-pass-lands) explains why crossing a threshold does not imply a target landing size.

---

## Desktop app: first-launch network request

**Symptom:** On first launch, the Magic Context Desktop app makes a network request or seems slow to start.

**Why it happens:** The local embedding model (`Xenova/all-MiniLM-L6-v2`, ~90 MB) is downloaded on first use when `embedding.provider` is `"local"` (the default). This is a one-time download; subsequent launches use the cached model at `~/.local/share/cortexkit/magic-context/models/`.

**Fix:** If you want to avoid this download, set `embedding.provider: "off"` in your config (full-text search still works) or point it at a remote endpoint. See the [configuration reference](/reference/configuration/) for embedding options.

---

## Desktop app: blank window on Linux / WSL2

**Symptom:** The Magic Context Desktop app opens to a blank window (only the top menu, no content), often with `Could not create default EGL display: EGL_BAD_PARAMETER` in the terminal. Most common on non-Ubuntu Linux distributions and under WSL2.

**Why it happens:** The app's embedded WebView (WebKitGTK) cannot create a graphics surface against your host's driver stack. The bundled WebKitGTK is built for one environment and does not always match another distribution's Mesa/driver versions. Environment-variable workarounds (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, etc.) usually do not help for this class.

**Fix:** Run the dashboard in **browser mode** instead of as a desktop window. The same binary, started with `--serve`, runs a local web server you open in your normal browser, so no embedded WebView is created:

```sh
magic-context-dashboard --serve
```

It prints a URL with a one-time token; open it in your browser (under WSL2, open it in your Windows browser via `localhost`). See [Browser mode (`--serve`)](/reference/dashboard/#browser-mode---serve) for per-OS invocations and options.

A native package using your system's own WebKitGTK (the `.deb` or `.rpm` rather than the `.AppImage`) can also resolve it on some distributions.

---

## Filing a bug report

Run:
```bash
npx @cortexkit/magic-context@latest doctor --issue
```

This auto-bundles redacted logs, config (with secrets stripped), and diagnostic output into a ready-to-file report. Paste the output into a GitHub issue at [github.com/cortexkit/magic-context](https://github.com/cortexkit/magic-context/issues).
