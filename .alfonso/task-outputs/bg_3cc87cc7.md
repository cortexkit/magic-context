---
task_id: bg_3cc87cc7
agent: oracle
session_id: ses_21304ca21ffevtYIlqv16KcJ22
parent_session_id: ses_331acff95fferWZOYF1pG0cjOn
status: running
completed_at: unknown
---

[user] 2026-05-03T08:36:19.553Z
You are reviewing the `packages/pi-plugin/` directory in `/Users/ufukaltinok/Work/OSS/opencode-magic-context` for its first public npm release as `@cortexkit/pi-magic-context`.

Context:
- The OpenCode plugin (`@cortexkit/opencode-magic-context`) is at v0.15.7 and will release v0.15.8 simultaneously
- Pi plugin will match the same version number (v0.15.8)
- The GitHub repo will be renamed from `opencode-magic-context` to `magic-context` before release
- The Pi plugin is a Pi coding agent extension that shares a SQLite database with the OpenCode plugin

Please read and audit:
1. `packages/pi-plugin/package.json` — packaging correctness, peerDependencies, files field, bin entries, repository URL
2. `packages/pi-plugin/src/index.ts` — main entry point, registered hooks, cleanup paths
3. `packages/pi-plugin/src/cli/index.ts` and `setup.ts` — CLI correctness under Node runtime
4. `packages/pi-plugin/src/cli/doctor.ts` — doctor command correctness
5. `packages/pi-plugin/src/shared/harness.ts` and `packages/plugin/src/shared/sqlite.ts` — runtime detection
6. `packages/pi-plugin/README.md` if it exists

Key questions to answer:
1. Are there any hardcoded `opencode-magic-context` repo URLs that need updating for the rename to `magic-context`?
2. Does `packages/pi-plugin/package.json` reference the correct repository URL? Will it need updating?
3. Is the `files` array in package.json correct — does it include everything needed at runtime?
4. Are there any `peerDependencies` issues — will Pi users be able to install this cleanly?
5. Are there any paths, scripts, or references that assume the old repo name?
6. What is missing before this can be `npm publish`-ed for the first time?

Return a focused, evidence-backed report. Distinguish hard blockers from cleanup items.
<!-- ALFONSO_INTERNAL_INITIATOR -->
