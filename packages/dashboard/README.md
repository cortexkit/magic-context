# Magic Context Dashboard

A lightweight Tauri desktop app that provides visibility into Magic Context's internal state, configuration, and diagnostics.

## Features

- **Memory Browser** — Browse, search, edit, and manage cross-session memories
- **Session History Viewer** — Inspect compartments, facts, notes, and session metadata
- **Cache Diagnostics** — Real-time cache hit timeline with bust cause analysis
- **Dreamer Management** — Monitor and trigger dream tasks
- **Configuration Editor** — Visual editor for `magic-context.jsonc`
- **Log Viewer** — Real-time log tail with filtering and cache hit indicators

## Prerequisites

- [Rust](https://rustup.rs/) (1.77+)
- [Bun](https://bun.sh/) or Node.js
- The [Magic Context plugin](https://github.com/cortexkit/opencode-magic-context) must be installed and have been run at least once (to create the SQLite database)

## Development

```bash
cd packages/dashboard

# Install frontend dependencies
bun install

# Run in development mode (hot-reload frontend + Rust backend)
cargo tauri dev

# Build for production
cargo tauri build
```

## Architecture

```
packages/dashboard/
├── src/                    # SolidJS frontend
│   ├── components/         # UI components per feature
│   │   ├── MemoryBrowser/  # Memory CRUD + search
│   │   ├── SessionViewer/  # Compartments, facts, notes
│   │   ├── CacheDiagnostics/ # Cache hit timeline + bust analysis
│   │   ├── DreamerPanel/   # Dream queue + state
│   │   ├── ConfigEditor/   # JSONC config editor
│   │   ├── LogViewer/      # Real-time log tail
│   │   └── Layout/         # App shell, nav, status bar
│   ├── lib/
│   │   ├── api.ts          # Tauri invoke wrappers
│   │   └── types.ts        # TypeScript types matching Rust structs
│   ├── App.tsx             # Root component with navigation
│   ├── index.tsx           # Entry point
│   └── styles.css          # Global styles + design tokens
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── main.rs         # Tauri app setup + command registration
│   │   ├── lib.rs          # Shared state
│   │   ├── commands.rs     # All Tauri command handlers
│   │   ├── db.rs           # SQLite reader + writer
│   │   ├── config.rs       # Config file reader + writer
│   │   └── log_parser.rs   # Log file parser + cache event extraction
│   ├── Cargo.toml
│   └── tauri.conf.json
├── index.html
├── vite.config.ts
└── package.json
```

## Data Sources

The dashboard reads from the same SQLite database the plugin writes to:
- **Database**: `~/.local/share/opencode/storage/plugin/magic-context/context.db`
- **Config**: `~/.config/opencode/magic-context.jsonc`
- **Logs**: `/tmp/magic-context.log`

Database access uses WAL mode for safe concurrent reads while the plugin writes. Write operations (memory edits, dream queue entries) use `busy_timeout` to handle contention.

## Design

Dark-first developer tool following the wireframe spec in `.sisyphus/plans/magic-context-dashboard-wireframes.md`. Key design tokens:

| Token | Hex | Usage |
|-------|-----|-------|
| `bg-base` | `#0a0a0f` | App background |
| `bg-panel` | `#13131a` | Panel background |
| `bg-card` | `#1c1c27` | Card background |
| `accent` | `#3b82f6` | Primary actions |
| `green` | `#22c55e` | Healthy/success |
| `amber` | `#f59e0b` | Warning |
| `red` | `#ef4444` | Error/bust |
