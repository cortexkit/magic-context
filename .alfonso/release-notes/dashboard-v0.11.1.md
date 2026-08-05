## Dashboard v0.11.1

### Fixes
- **Project config discovery on OpenCode Desktop** (#248): the Config Editor's Project Configs tab enumerated projects from `opencode.db`, which OpenCode Desktop does not create — so the tab was always empty on Desktop while the Projects tab worked. Both tabs now read the same project authority (Magic Context's own database), enriched from `opencode.db` when present, with dead worktree roots skipped. Applies to both the Desktop app and `--serve` mode.
