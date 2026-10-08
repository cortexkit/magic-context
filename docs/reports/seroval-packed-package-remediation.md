# Packed-package seroval advisory remediation

## Decision and loader evidence

Solid and OpenTUI belong to the **host**, not to Magic Context's consumer dependency graph. Move `solid-js`, `@opentui/core`, and `@opentui/solid` to optional peers, retaining the existing versions as development dependencies for compilation and tests. Optional peers matter: a standalone server/plugin install has no TUI host, and npm must not auto-install a private renderer. The Solid peer range accepts both 1.9.12 and fixed 1.9.17; it does not force an incompatible upgrade against OpenTUI's exact 1.9.12 peer.

Evidence read from upstream, pinned to releases:

- [OpenCode 1.18.31 `plugin/shared.ts`](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/plugin/shared.ts): `resolvePackageEntrypoint` selects `exports["./tui"]`; `readV1Plugin` validates `id`/`tui`. [`plugin/loader.ts`](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/plugin/loader.ts) dynamically imports that resolved entry.
- [OpenCode 1.18.31 `plugin/tui/runtime.ts`](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/plugin/tui/runtime.ts) imports and installs `ensureRuntimePluginSupport` from `@opentui/solid/runtime-plugin-support/configure`.
- OpenTUI's `runtime-plugin-support-configure.js` registers the host's actual `@opentui/core`, `@opentui/solid`, `solid-js`, and `solid-js/store` module exports as process-wide `opentui:runtime-module:*` modules. `core/runtime-plugin.js` rewrites runtime imports in external ESM, including packages under `node_modules`; it does not blanket-rewrite unrelated dependencies.
- Our existing `src/tui/entry.mjs` probes that registry and selects `src/tui-compiled/index.tsx`. Its generated imports already name the virtual modules. This avoids a second Solid owner/signal graph even when the package is installed in a separate npm cache. Bare-Bun development falls back to raw TSX and uses the development dependencies.
- [OpenCode 2.0.22 Bun runtime support](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/tui/src/plugin/runtime-plugin-support.bun.ts) installs the same registry (plus `@opencode/plugin/tui`). The v2 fallback previously imported `@opentui/solid/jsx-runtime`, which is **not** registered. It now creates its one text fallback element through the registered `createElement`/`spread` renderer helpers. The real sidebar/dialog still use the existing compiled v1 components.

This is not an assertion that an old host's own serializer dependency is patched. Hosts must remediate their own vulnerable seroval use. Shipping another Solid copy neither fixes the host nor is correct for its renderer. Forcing Solid 1.9.17 alongside OpenTUI's exact peer would introduce a consumer ERESOLVE conflict for dependencies the plugin does not need to own.

The Node variant of OpenCode 2.0.22 [does not install the Bun registry](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/tui/src/plugin/runtime-plugin-support.node.ts). Our existing TSX/source TUI entry was designed for Bun; Node-host compatibility is not claimed or newly implemented here. OpenCode 2 was source-reviewed, not live-render-tested in this verification.

## Consumer and audit evidence

Tools: Bun 1.4.2, Node 24.16.0, npm 11.13.0, pnpm 10.33.1, TypeScript 5.9.3, Biome 2.5.1.

`npm pack --json --ignore-scripts` produced `cortexkit-opencode-magic-context-0.45.0.tgz`. The version remains the checkout's existing version; this change does not perform the release bump. Each of three independent projects depended on **that same tarball**:

- `npm install --prefix <npm-consumer> --no-fund`: 82 packages installed, no peer bypass, 0 vulnerabilities.
- `bun install --cwd <bun-consumer>`: 82 packages installed.
- `node <tools>/node_modules/pnpm/bin/pnpm.cjs --dir <pnpm-consumer> install --strict-peer-dependencies`: 82 packages installed.

All three completed without ERESOLVE. Filesystem assertions confirmed that **none** installed `solid-js`, `@opentui/core`, or `@opentui/solid`. Bun/pnpm reported their normal blocked lifecycle-script warnings; no runtime peers were added to make these installs pass.

`bun scripts/audit-packed-packages.ts` passed for OpenCode, Pi, **and CLI**: each reported low=0, moderate=0, high=0, critical=0. The existing audit policy and flags are unchanged; no allowlist was added. CLI is now part of every audit invocation, and `release.sh` runs the gate after all three builds.

`bun packages/plugin/scripts/smoke-tui-pack-install.ts` passed 9 checks, including all 76 TUI-reachable shipped files and absence of the three runtimes in a standalone consumer. Only after that assertion does this development smoke explicitly install its test runtimes and exercise registry/raw-source imports.

Non-vacuity controls, staged before mutation and restored from the index afterwards:

- Reintroducing `solid-js: 1.9.12` as a production dependency made exactly `standalone consumer does not install solid-js` fail. The other 8 smoke checks remained green. During mutation: `packages/plugin/package.json | 2 ++`; after restore: empty `git diff --stat`.
- Adding `seroval: 1.6.0` to the CLI made only its packed audit fail: `@cortexkit/magic-context: packed consumer graph has 0 high and 1 critical vulnerabilities: seroval (critical)`. OpenCode/Pi stayed clean. During mutation: `packages/cli/package.json | 2 ++`; after restore: empty `git diff --stat`.

Both controls were marked `NON-VACUITY BREAK`; neither remains in the delivered tree. The restored audit passed again.

## Real OpenCode 1.18.31 rendering and isolation

The host executable was installed separately as `opencode-ai@1.18.31`. It loaded the **npm-installed packed candidate**, whose installation had no Solid/OpenTUI packages. A real `serve --hostname 127.0.0.1 --port 47963` created session `ses_ee6bd7cf8ffekz64RhK84jAm5Y`; a real 130×50 PTY `attach --session ... --dir <project>` rendered it. No model turn or external provider was needed. The provider picker was dismissed, and the status dialog was opened through the host command palette's **Magic Context: Status** action.

Raw PTY output was decoded with `@xterm/headless@5.5.0`, not a stub renderer. Seven sidebar assertions passed (`Packed runtime proof`, `Magic Context`, `Historian`, `Compartments`, `Memories`, `Total tokens`, `OpenCode 1.18.31`). Eight status-dialog assertions passed (`Magic Context Status`, `Tags`, `Reductions`, `Pending Queue`, `Context Details`, `Cache TTL`, `History Compression`, `Generation`). The fresh session showed Historian idle, 0 compartments/memories/tokens, healthy marker, and config generation 1. The dialog is taller than this terminal, so this verifies its visible frame rather than all offscreen rows.

Evidence remains under the canonical throwaway root:

```text
/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/bg_36bf6651e628dfd9/
  pack/plugin.json
  host/sidebar.ansi, host/sidebar-frame.txt
  host/status.ansi, host/status-frame.txt
  host/server-lsof.txt, host/tui-lsof.txt
  tools/assert-frame.cjs
```

Host children received a constructed `env -i` environment: `HOME`, `TMPDIR`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR`, and `MAGIC_CONTEXT_LOG_PATH` all pointed below `host/` in that root. Default external plugins/updates were disabled; no providers enabled, embeddings off, historian/dreamer disabled, and native compaction disabled. `lsof -nP -p 6087 -Fn` found 11 DB/WAL/SHM handles, all under `host/data/` (fresh `opencode.db` and `context.db`). `lsof` for TUI PID 19956 found no DB handles, only the isolated log/cache and local server/RPC connections. Both hosts were stopped after the frames were captured. No live stores/configuration were opened, copied, or migrated.

## Repository gates and remaining suite caveat

- `bun install`, then `bun install --frozen-lockfile`: passed, 996 installs checked. Regeneration also synchronizes pre-existing 0.44.4 workspace lock metadata to the already-0.45.0 package manifests; no resolved dependency versions changed.
- `bun run build:dists`: passed, generated 9 TUI files, 4 v2 export-contract tests passed, both distribution imports printed `dists LOAD OK`.
- `bun run typecheck`: passed all 4 packages; plugin typecheck passed again after smoke edits. A separate `tsc --noEmit --target esnext --module esnext --moduleResolution bundler --types bun --typeRoots packages/plugin/node_modules/@types --skipLibCheck scripts/audit-packed-packages.ts` passed.
- `bun run lint`: passed (1267 plugin, 247 Pi, 135 CLI, 6 retina files); existing warnings/informational diagnostics remain. Plugin lint passed again after smoke edits.
- `bash -n scripts/release.sh`: passed, 1 syntax check. CLI build and the three-package packed audit passed after moving the gate.
- CLI `bun run --cwd packages/cli test`: passed all runner buckets, 648 passed / 2 skipped / 0 failed (650 tests).
- Pi `bun run --cwd packages/pi-plugin test:serial`: **1625 passed / 3 skipped / 0 failed**, 155 files.
- Focused TUI tests: **27 passed / 0 failed**, 7 files (`src/v2/tui` and compiled runtime imports).

All package suites used a throwaway `HOME` and no exported `OPENCODE_DB`. The **full plugin suite is not clean on this machine**: its last parallel run had 7303 passed / 6 skipped / 1 failed, solely the 30-second `incremental verify evidence > derives a base for old verified rows, but never-verified rows require full checks` timeout; that file then passed all 5 tests alone. A serial control had 7299 passed / 6 skipped / 5 failed in unrelated startup lock/timing, pagination responsiveness, hygiene calibration, and Git fixture tests. All five failing files then passed together (77 tests). Initial runs additionally exposed a double-slash HOME spelling mismatch (corrected to canonical `pwd -P`) and transient Git/Node-WASM child timeouts; those files passed on isolated reruns. Pi's parallel nested-child timeout also disappeared in its complete serial run. No unrelated production code or test expectation was changed to turn these failures green. This delivery proves the dependency/TUI change with narrow behavioral tests and real host frames, but does **not** claim a fully green monolithic plugin suite.
