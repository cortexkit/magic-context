# Config loader differential fixtures

This directory is owned by the opt-in Rust `TrustedConfigResolver`. Existing
`ConfigCache` callers still use the legacy loader, and the default `CoreConfigResolver`
adapter still refuses resolution rather than calling `TrustedConfigResolver`.
`CoreConfig.settings` is the complete validated engine namespace;
`CoreConfig.effective` is its compatibility projection to `McModuleConfig`.
`resolve_namespaces` retains native presentation/transport fields in typed
`BridgeSettings`; `CoreConfigResolver::resolve` returns only the core projection.

## Reference and regeneration

```sh
bun crates/mc-module/testdata/config_parity/generate.ts
bun crates/mc-module/testdata/config_parity/generate.ts --check
bun packages/plugin/node_modules/typescript/bin/tsc -p crates/mc-module/testdata/config_parity/tsconfig.json
cargo test -p mc-module --test config_parity
```

Run verification on Linux. The generator starts each fixture in a fresh Bun
process with a private HOME, XDG config/data/cache directories, environment
variables and fake substitution files. Bun caches `os.homedir` at process
startup, so changing HOME in an already-running process is insufficient.
No fixture needs a real credential, live store or network access.

The generator runs the integrated TypeScript loader unchanged, including its
`MAGIC_CONTEXT_CONFIG_PATH` discovery and refusal rules. It no longer inserts
path-override logic into a copied source file. The override replaces the user
source, must be absolute and nonblank, and warns without falling back when missing.

`golden.json` records inputs, effective JSON, original TypeScript warnings,
normalized warning-code sets and source/load trust flags for 111 cases. Detailed runtime parse/warning objects and their platform-specific locations are
excluded from effective JSON; warning codes and source/load trust flags are
compared separately. `schema.json` exports the real Zod input schema,
defaults, strict-versus-stripping object rules, scalar checks, language catalog
and reserved command names. Rust uses the exported rules to validate values,
filter keys and insert defaults; transformations
and custom refinements remain explicit Rust implementations. Regenerate both
files together when the reference loader changes.

Warnings compare **deduplicated code sets**, not platform-specific messages or
counts. The TypeScript loader has no complete warning-code enum, so the generator
classifies its messages into stable categories (unknown categories are errors).
Rust warnings never include substituted values. The categories distinguish
project policy/substitution refusals, missing env/file inputs, sensitive files,
unsafe keys, syntax/schema recovery, profiles, legacy/flat migration, commands
and transform-mode refusal.

## Isolation and security coverage

The golden covers user/project precedence, JSONC versus JSON discovery, and
absolute and relative XDG config paths. It also covers fallback to the same host's
legacy config path; refusal to migrate legacy settings from another host; profile
overlays in OpenCode/Pi/OMP blocks and Broca's historian block; schema-marked
deprecated keys; retained legacy migrations; user substitution origins and escaping;
invalid leaves and recovering JSONC; how strict and stripping schemas handle unknown keys; model
threshold floors; malformed project block restoration; and command admission.
Project substitution detection includes comments; it never reads env/file
inputs. Hidden-agent executable payloads and all TypeScript user-only fields
are removed before merge. Project profile definitions are stripped while named
user profile selection is allowed. `signed_thinking_hold` defaults off, accepts
user opt-in, and is removed from project configuration before merging.

The separate bridge projection owns `auto_update`, `toast_duration_ms`, `pi`,
`todowrite`, `disabled_hooks`, `command`, `keep_subagents`, `subc`, and
`rust_pipeline`. No bridge setting is exposed by `CoreConfig.settings`.

Two mutation controls are independently named and partitioned from the general
matrix: `project_substitutions_are_never_expanded` and
`project_cannot_set_user_only_keys`. Allowing project substitutions or allowing
project `debug_rpc` must fail only `project_cannot_set_user_only_keys`; permitting
project substitutions must fail only `project_substitutions_are_never_expanded`.
All four tests other than the named mutation target must remain green.

This resolver does not rewrite user files/backups during flat-model migration
or watch mtimes. Migration is in-memory; the supplied generation belongs to the
caller. Existing `ConfigCache` discovery and reload behavior is unchanged. Wiring
this resolver into ck-mc remains a serial integration decision, not part of these
fixtures.
