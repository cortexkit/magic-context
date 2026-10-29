#### `DEV_ENVIRONMENT`

**Test**: "Is this about the user's own development setup, shared by every coding project of theirs?"

The user's own development environment across projects: preferred languages, runtimes and frameworks, package managers, editor, shell, terminal and operating system. Only coding agents see these. A tool or version one project pins is a `CONFIG_VALUES` or `PROJECT_RULES` fact of that project.

**Positive examples**:
- "Prefers Bun over Node for TypeScript tooling."
- "Uses zsh on macOS."
- "Prefers Rust for performance-critical components."

**Negative examples (do NOT extract as DEV_ENVIRONMENT)**:
- "This repo uses pnpm workspaces" — one project's configuration.
- "Dislikes dark mode in every app, editors included" — holds everywhere (`PREFERENCES`).

