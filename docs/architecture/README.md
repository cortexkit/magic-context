# Architecture: subsystem pages

`ARCHITECTURE.md` at the repository root is the map: what Magic Context does, the transform pass, the cache rules and the `m[0]`/`m[1]` layout. `STRUCTURE.md` says where code lives. The pages here go one level deeper into each subsystem, for a contributor about to change it.

Where a page and the code disagree, the code is right; fix the page.

| Page | Covers |
|---|---|
| [rust-module.md](rust-module.md) | The `ck-mc` subc module, Rust transform mode, state sync, ordinal mapping, last-known-good fallback, the module store and authority handoff, tool facades, the module historian. |
| [opencode-2.md](opencode-2.md) | The OpenCode 2 adapter: hooks, store reader, fold ownership, hidden completions, TUI seam, refusals, host limitations, store-generation rebase. |
| [pi.md](pi.md) | Pi and OMP: detection, LKG, pressure, system entries, clone inheritance, the subagent runner, the refusal guard. `packages/pi-plugin/PARITY.md` lists every deliberate divergence. |
| [reclaim.md](reclaim.md) | Tags and tag identity, `ctx_reduce` drops, placeholders and skeletons, age reclaim, smart drops, emergency tiers, strip-and-replay, caveman compression. |
| [nudges.md](nudges.md) | The `{U, T}` tail measurement, Channel 1 and Channel 2 bands, grace and cadence, delivery on each host. |
| [historian.md](historian.md) | Trigger, protected-tail boundary, producer, validation, publish, decay rendering, recomp and wrapup. |
| [memory-and-search.md](memory-and-search.md) | Memories, workspaces, embeddings and providers, unified search, the message and git-commit indexes. |
| [dreamer.md](dreamer.md) | Scheduling and leases, every task, failure records, documentation proposals. |
| [calibration.md](calibration.md) | Tokenizer calibration seeds, family fallback, the per-session snapshot and where decisions read it. |
| [storage.md](storage.md) | The schema fence and migration rules, the shared database, session-scoped tables, clones, timestamps, backups. |
| [single-store-b0-rollback.md](single-store-b0-rollback.md) | Rolling back the context.db v92 + v93 release: older plugin fences, the manual file downgrade, keeping `ck-mc` and the plugin on one release. |
| [diagnostics.md](diagnostics.md) | Logging, redaction, decision records, `doctor`, cache-bust analysis scripts. |

Paths in each page are relative to `packages/plugin/` unless the page says otherwise.
