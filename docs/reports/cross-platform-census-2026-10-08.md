# Magic Context cross-platform runtime census — 2026-10-08

## Scope, evidence and counting

Ufuk's ruling is the requirement: **every CortexKit module supports macOS, Linux and Windows**. A successful build is not evidence of equivalent runtime behaviour. This census reads the source at `00d9856c4210ca90c01ec14f70330ae6a6248e4c` (plugin/CLI 0.46.1, dashboard 0.19.0). It covers OpenCode 1 and 2, Pi/OMP, setup/doctor/migrate, the dashboard's browser/Tauri frontend and Rust backend, all four Rust crates, and installation, placement, maintenance and release/probe scripts.

**40 findings** below are independently actionable platform contracts or platform-sensitive failure modes, not 40 unconditional failures of a fresh install. Repeated callers of one deficient primitive are grouped; working adaptations are listed separately and not counted. Some conditional hazards also exist on macOS (old runtimes, network disks, missing tools); they are explicitly identified rather than misrepresented as Linux/Windows-only bugs. `works` means the cited implementation supports the stated case, not that a full native install was exercised. `degraded` includes weaker security guarantees, even when the operation returns success. `no-op` means the requested capability is skipped; `refuses` means the operation stops or returns an error. There is no basis here for claiming that every Linux or Windows plugin launch crashes.

Evidence labels:

- **C**: code read, including the selected OS branch and its error path. Windows conclusions are code/OS-contract analysis, **not a Windows run**.
- **L1**: real Linux `runon: linux`, Bun 1.4.2, four fixture-only runtime checks: 0700/0600 creation passed; own-PID liveness/command passed but start time was `null`; local SQLite WAL write/read passed; the pinned JS subc reader accepted a TCP-shaped connection record. A supplemental three-assertion WAL check confirmed the returned `journal_mode` was actually `wal`, the WAL sidecar existed, and the committed fixture row was readable (not just that a write worked after requesting WAL). The connection-record check did not connect to a daemon.
- **L2**: real Linux capability observations: `getconf DARWIN_USER_TEMP_DIR` exited 2; `cp -c` exited 1; `stat -f %z <fixture>` exited 1; `codesign` was absent (`ENOENT`); `lsof -v` exited 0; `ps -p <own PID> -o lstart=` exited 1, “Unable to get system boot time”. `/proc/<own PID>/stat` and `cmdline` were readable, `/proc/uptime` was `ENOENT`. These are observations of the remote sandbox, **not all Linux installations**.
- **L3**: Linux Node v22.22.1 could not run the repository's source SQLite smoke: the documented bare command returned `ERR_UNKNOWN_FILE_EXTENSION`; adding `--experimental-strip-types` returned `ERR_NO_TYPESCRIPT` (“Node.js is not compiled with TypeScript support”). No tests ran. This does not demonstrate failure of the published JavaScript CLI.

All runtime probes used newly created `.census-*` directories inside the worktree, removed afterwards. HOME/profile, XDG, temp, storage and log variables were redirected before importing application helpers. No setup, doctor, migrate, placement, backup or live diagnostic command was run against operator data. The live-store rule was observed verbatim:

> never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`).

Severity is for a real installation: **High** = privacy/trust boundary, data integrity, or blocked essential install/upgrade; **Medium** = a significant feature or maintenance operation fails; **Low** = presentation, optional tooling or diagnosability. An upstream implementation not present in this repository is named as a dependency boundary, not certified from a cross-compile.

## Findings: private storage and trust boundaries

### F01 — JS owner-only storage enforcement silently disappears on Windows

- **Location:** `packages/plugin/src/shared/storage-permissions.ts:45`, `:58`, `:175`; consumers include RPC token publication at `packages/plugin/src/shared/rpc-server.ts:173`, Pi's ledger at `packages/pi-plugin/src/served-array-ledger.ts:151`, and CLI owner-only config writes at `packages/cli/src/lib/atomic-write.ts:46`.
- **Linux:** **works** on a local POSIX filesystem: create modes 0700/0600 and startup chmod tightening. **Degraded** on a filesystem that cannot enforce those modes; tightening failures are counted/logged, not a privacy refusal.
- **Windows:** **no-op** tightening (`{tightened:0, failures:0}`); passing POSIX modes to Node file creation does not install an owner-only DACL. Storage, dumps, backups and RPC bearer tokens inherit the containing ACL. A normal private profile may protect them, but that is not equivalent to enforcing the configured policy, especially with a custom/shared storage root.
- **Evidence / severity / fix:** **C + L1; High.** Introduce one OS-aware private-file/directory API: protected owner DACLs on Windows, mode verification on Unix, and report an unfulfilled privacy policy rather than clean zero failures. Apply it to every writer, including logs (`packages/plugin/src/shared/logger.ts:81`, `:112`, `:169`).

### F02 — Rust store/module privacy helpers have the same successful no-op

- **Location:** `crates/mc-store/src/private_permissions.rs:15`, `:43`, `:118`, `:157`; callers `crates/mc-store/src/lib.rs:7887`, `crates/mc-module/src/host_store.rs:886`, `crates/mc-module/src/main.rs:31`.
- **Linux:** **works**: Unix directory/file modes, process umask 077, and tree tightening. Mode changes can fail and are logged without aborting the store open.
- **Windows:** **degraded/no-op**: non-Unix creation uses ordinary `create_dir_all`/`OpenOptions`; both tightening functions return a default zero report; there is no Windows equivalent of the entrypoint umask. `ck-mc` can serve while not enforcing owner-only storage/log permissions.
- **Evidence / severity / fix:** **C; High.** Implement protected DACL creation/tightening in the shared Rust primitive and verify SQLite/logger-created sidecars. Do not equate `cfg(not(unix))` with “privacy accomplished”.

### F03 — Dashboard user config writes are not private on Windows

- **Location:** `packages/dashboard/src-tauri/src/config.rs:207`, `:231`, `:284`, `:320`.
- **Linux:** **works** for newly created directories/files: 0700/0600, sync then replace. Existing directories are not explicitly tightened here.
- **Windows:** **degraded**: `mode=0600` is a local value, but only the Unix block applies it; the directory branch is ordinary `create_dir_all`. Saving an API-key-bearing config preserves no owner-only ACL guarantee.
- **Evidence / severity / fix:** **C; High.** Use the same private config/storage policy as the plugins and CLI, with Windows DACLs and handling of existing directory inheritance.

### F04 — Pinned subc JS dependency skips transport-key permissions on Windows

- **Location:** pin at `packages/plugin/package.json:59`, `packages/pi-plugin/package.json:46`, `packages/cli/package.json:46`; installed 0.11.1 source `packages/plugin/node_modules/@cortexkit/subc-client/src/connection-file.ts:72`.
- **Linux:** **works/refuses**: rejects group/world permission bits before reading the key. It uses `stat` then a separate read, not a no-follow handle/owner-UID check.
- **Windows:** **no-op** permission verification, explicitly relying on profile inheritance; custom connection-file paths have no ACL verification in this JS reader.
- **Evidence / severity / fix:** **C + L1 (valid fixture parsing only); High.** Fix the pinned SDK's reader/writer together: owner/ACL validation on one handle and a supported private runtime root. The dependency comment says the Rust reader also no-ops; that comment is not an independent audit of the published Rust dependency.

### F05 — Dashboard no-follow validation is compiled out on Windows

- **Location:** `packages/dashboard/src-tauri/src/config.rs:160`, `:190`, `:202`, `:322`.
- **Linux:** **works**: rejects observed symlinks, checks canonical containment and uses `O_NOFOLLOW` for the validation open and temporary-file creation. This is not an end-to-end directory-handle race-proof transaction.
- **Windows:** **degraded/no-op**: observed symlinks and containment are still checked, but `validate_existing_file_no_follow` returns `Ok(())` without opening anything. Reparse points/junctions and swaps are not protected by a handle-based Windows equivalent.
- **Evidence / severity / fix:** **C; High** for untrusted project config targets. Use Windows reparse-point-aware opens and verify the final opened object's identity/containment; keep deliberate user dotfile symlink support separate from untrusted project writes.

### F06 — Smart-note file reads lose the final no-follow barrier on Windows

- **Location:** `packages/plugin/src/features/magic-context/smart-notes/capabilities.ts:140`, `:162`, `:169`, `:181` (also bundled into Pi).
- **Linux:** **works** for the final-component symlink check: canonical parent, lexical fence, `lstat`, `O_NOFOLLOW`, regular-file/size checks. Concurrent parent-directory replacement remains a broader handle-fencing concern.
- **Windows:** **degraded**: unavailable `O_NOFOLLOW`/`O_NONBLOCK` become 0; after the non-following stat, the open follows the current path, and the opened stat is checked for type/size but not equality to the earlier object. A swapped link to a regular file can pass the last check.
- **Evidence / severity / fix:** **C; High.** Add reparse-point refusal and opened file-ID comparison, ideally relative to a trusted directory handle; test the swap, not just a symlink already present before the call.

### F07 — Rust project-doc identity check is weaker without Unix inodes

- **Location:** `crates/mc-module/src/project_docs.rs:69`, `:98`, `:106`.
- **Linux:** **works**: non-following stat, bounded read and device/inode equality on the opened file.
- **Windows:** **degraded**: equality is only file type, length and modification time. A different same-size/same-mtime file can satisfy it; the open itself follows links. The ordinary pre-existing symlink refusal is still present.
- **Evidence / severity / fix:** **C; High** because these bytes enter trusted project-doc prompt material. Compare Windows volume serial/file IDs and refuse reparse-point traversal; do not substitute mtime for identity.

### F08 — GitHub smart-note token requires a POSIX mode Windows cannot express

- **Location:** `packages/plugin/src/features/magic-context/smart-notes/github-token.ts:16-31`.
- **Linux:** **works** for a regular exact-0600 token; **refuses** other modes, intentionally falling back to public-only access.
- **Windows:** **degraded/refuses** authenticated access: the unconditional `(stat.mode & 0777) === 0600` requirement is not an owner-DACL check. Node's Windows synthetic mode/read-only semantics do not encode Unix owner-only rw; an ACL-private token can still be rejected. Open flags also lose no-follow protection where absent.
- **Evidence / severity / fix:** **C; Medium** feature loss, **High** if “fixing” this by simply dropping the security check. Validate owner-only ACLs on Windows and return a distinct unsupported/insecure credential status.

## Findings: OpenCode, Pi and CLI paths/processes

### F09 — OpenCode 1 updater still uses the obsolete Windows AppData roots

- **Location:** `packages/plugin/src/hooks/auto-update-checker/constants.ts:8-29`; winning-global-config lookup `packages/plugin/src/hooks/auto-update-checker/checker.ts:84`, `:394`; compare `packages/plugin/src/shared/opencode-config-dir.ts:43` and `packages/plugin/src/shared/data-path.ts:305`.
- **Linux:** **works** for the default config; **degraded** cache lookup when `XDG_CACHE_HOME` is set, since updater cache constants hardcode `~/.cache`.
- **Windows:** **degraded/no-op** auto-update discovery/preparation: updater looks under `%APPDATA%/opencode` and `%LOCALAPPDATA%/opencode`, while the maintained plugin/CLI helpers use home `.config`/`.cache`. It can miss the active config/cache or address an unrelated one.
- **Evidence / severity / fix:** **C; Medium.** Delete duplicated root policy and use host-generation-aware shared config/cache resolution. OpenCode 2's update-check hook is separate; do not infer this exact defect for all v2 update notifications.

### F10 — Windows OpenCode config lookup ignores XDG while MC config honours it

- **Location:** `packages/plugin/src/shared/opencode-config-dir.ts:43-48`, `packages/cli/src/lib/paths.ts:34-41`; MC user config `packages/plugin/src/config/migrate-config-location.ts:67-77`.
- **Linux:** **works**, XDG honoured in both layers.
- **Windows:** **degraded** for an explicitly XDG-relocated OpenCode host: setup/conflict scanning uses `home/.config/opencode` regardless of `XDG_CONFIG_HOME`, while MC uses absolute XDG paths. Default-home installations work; `OPENCODE_CONFIG_DIR` is an available explicit override, not a repair of global-layer scanning.
- **Evidence / severity / fix:** **C; Medium.** Reconcile this branch with the actual supported host's global loader and add native Windows tests with non-default XDG roots. The prose claiming “every platform XDG” must match the implementation.

### F11 — Backslashes make OMO unified-config repair write the wrong layer

- **Location:** `packages/plugin/src/shared/conflict-fixer.ts:135-137`, `:259-276`; invoked by setup at `packages/cli/src/commands/setup-opencode.ts:632` and doctor at `packages/cli/src/commands/doctor-opencode.ts:1697`.
- **Linux:** **works**: `/.../omo.jsonc` is recognized as unified and repairs `[opencode].disabled_hooks`.
- **Windows:** **degraded** with normal `path.join` backslash output: splitting only on `/` returns the entire path, so it is misclassified as legacy and writes root `disabled_hooks`. The fixer can report success while the conflicting unified harness hooks remain enabled.
- **Evidence / severity / fix:** **C; High** when conflicting context managers keep MC disabled. Use `path.basename` and exercise actual Windows-formatted paths through the full repair.

### F12 — Remaining UI/diagnostic basename decoding assumes POSIX paths

- **Location:** `packages/dashboard/src/components/DreamerPanel/DreamerPanel.tsx:120-124`; `packages/cli/src/lib/diagnostics-pi.ts:215-219`, `:245-274`.
- **Linux:** **works** for normal paths; reverse-slug diagnostics are already lossy for literal hyphens.
- **Windows:** **degraded**: fallback Dreamer label displays a whole backslash path; Pi recent-session reconstruction turns `--C-Users-me-repo--` into `/C/Users/me/repo`, not `C:\Users\me\repo`. Reports/dump lookups can misattribute or omit project artifacts. This is distinct from the correctly platform-aware forward migration slug.
- **Evidence / severity / fix:** **C; Low** UI, **Medium** diagnostics. Normalize separators for presentation; get `cwd` from the session header instead of reversing a lossy filename encoding.

### F13 — Linux PID identity depends on unrestricted procfs/boot-time metadata

- **Location:** `packages/plugin/src/shared/rpc-utils.ts:153`, `:189-226`, `:243-250`, `:376`; process-list path `:784`; storage policy `packages/plugin/src/features/magic-context/storage-db.ts:816-848`.
- **Linux:** **works** on conventional procfs with `USER_HZ=100`; **degraded** in restricted namespaces/hidepid/proc mounts. Failure of either stat or uptime returns `null` with no `ps` fallback for start time. L2's own-PID stat worked but uptime was absent and `ps` also failed. Migration uncertainty is logged and can proceed when no live host is confirmed; destructive CLI maintenance separately fails closed.
- **Windows:** **works/degraded** through different tasklist/CIM paths, not procfs (F14).
- **Evidence / severity / fix:** **C + L1 + L2; Medium**, potentially **High** during mixed-version migration. Obtain clock ticks/boot time through an OS abstraction, retain bounded independent fallback probes and make uncertainty policy explicit. Do not treat missing `/proc` as a dead PID.

### F14 — Windows process identity degrades from CIM to image-name-only tasklist

- **Location:** `packages/plugin/src/shared/rpc-utils.ts:164`, `:747-801`, `:919-954`, `:1045-1146`; doctor discovery `packages/cli/src/commands/doctor-prune-discovery.ts:27`.
- **Linux:** **works** with procfs and `ps`; **degraded** when those are missing/denied (F13).
- **Windows:** **works** with readable Windows PowerShell CIM; **degraded** if PowerShell/CIM is disabled, slow or command lines are inaccessible. Tasklist provides no start time/parent/command line, so node/bun-host identities remain inconclusive. If both tools fail the state is unreadable, not proof of no holders.
- **Evidence / severity / fix:** **C; Medium.** Keep conservative classification, add a native process-query fallback with start time and parent information, and test locked-down Windows/PowerShell 5.1 and 7. Existing ISO-date conversion, 8 MiB buffer and bounded async probes are useful adaptations, not missing support.

### F15 — Offline Linux doctor/migration needs lsof, not just SQLite

- **Location:** `packages/cli/src/commands/doctor-opencode2-cache.ts:62-75`, `:101-117`; callers `packages/cli/src/commands/doctor-single-store.ts:145-156`, `packages/cli/src/commands/doctor-repair-db.ts:128-158`.
- **Linux:** **refuses** cache clearing/offline migration/repair if a required lsof query cannot start or fails; minimal distributions commonly do not install lsof. The tool existed in L2, which does not prove visibility of other namespaces/users' descriptors.
- **Windows:** **works/refuses** through a different process/SQLite probe (F16/F17); it does not accidentally call Unix lsof here.
- **Evidence / severity / fix:** **C + L2 (tool presence only); Medium/High** for an upgrade blocked before migration. Package/document the dependency or implement a bounded `/proc/*/fd`-based inventory with explicit visibility uncertainty. Preserve fail-closed behaviour for destructive work.

### F16 — Existing OpenCode 2 cache slots cannot be cleared on Windows

- **Location:** `packages/cli/src/commands/doctor-opencode2-cache.ts:82-99`.
- **Linux:** **works** when lsof proves the slot/databases unused.
- **Windows:** **refuses** by construction whenever any target cache directory exists: after the store checks it returns `unknown`, “Windows cannot rule out open files in plugin cache directories”. This includes the very stale slot `doctor --fix`/`--force` is meant to remove.
- **Evidence / severity / fix:** **C; Medium**, **High** if a cached schema-incompatible plugin blocks use. Add a supported native open-file/exclusive-directory check or host-managed cache-update operation; do not simply bypass the safety guard.

### F17 — Windows offline-holder safety is coarser and more restrictive

- **Location:** `packages/cli/src/commands/doctor-windows-holders.ts:6-59`; target-path metadata `packages/cli/src/commands/doctor-storage-holders.ts:32-65`.
- **Linux:** **works** with target-specific lsof and `/proc/<pid>/environ`; unreadable metadata cannot prove a non-default path belongs to a process.
- **Windows:** **refuses** without a full CIM snapshot, with unknown generic-runtime command lines, or with *any* recognized OpenCode/Pi/OMP/ck-mc process, even one using another store. It then probes `BEGIN EXCLUSIVE` with zero busy timeout. Command-line CIM cannot recover environment-only storage selection as Linux environ can. SQLite writer exclusion alone is not a complete open-reader inventory in WAL mode.
- **Evidence / severity / fix:** **C; Medium.** Track authenticated host/store identity and use native holder evidence. Do not turn process-list failure into “safe”, nor silently relax the guard to a write-lock-only test.

### F18 — Single-store doctor's independent engine-path check assumes HOME

- **Location:** `packages/cli/src/commands/doctor-single-store.ts:44-52`, `:158-165`; real Rust resolver `crates/mc-module/src/host_store.rs:1937-1975`, `crates/mc-module/src/config.rs:505-515`.
- **Linux:** **works** with HOME; **refuses** or compares the wrong location when HOME/XDG/storage overrides are absent in a service.
- **Windows:** **refuses** a normal existing-store migration with HOME unset, a working directory other than the profile directory, and no explicit XDG/storage override: this helper guesses `./.local/share/...`, while the CLI/plugin and Rust engine resolve the user profile. It fails with `single_store_path_mismatch` before invoking the engine. An explicit absolute `MAGIC_CONTEXT_STORAGE_DIR` avoids this particular mismatch.
- **Evidence / severity / fix:** **C; High** for upgrading into Rust single-store mode. Reuse the shared resolver/homedir policy rather than duplicating it. Windows should prefer USERPROFILE consistently with the Rust engine.

### F19 — Migration rollback instructions are POSIX-only

- **Location:** `packages/cli/src/commands/doctor-single-store.ts:61-70`.
- **Linux:** **works** in a POSIX shell.
- **Windows:** **degraded** recovery: prints `rm -f`, multi-source `cp` and POSIX single-quote escaping. These are not portable native cmd/PowerShell instructions; the backup itself is not necessarily invalid.
- **Evidence / severity / fix:** **C; Medium** in an urgent rollback. Emit OS-specific commands or an explicit cross-platform restore command that preserves paired-store/fence checks.

### F20 — Both installers accept Node versions below the current CLI floor

- **Location:** `scripts/install.sh:8-9`, `:44-48`; `scripts/install.ps1:24-42`; `packages/cli/package.json:56-58`; backend requirement `packages/plugin/src/shared/sqlite.ts:5-19`.
- **Linux:** **refuses/crashes** on a permitted Node 20.12/older-22 installation when npm enforces engines or the CLI needs `node:sqlite`. The Bash wrapper also **refuses** with no controlling `/dev/tty`.
- **Windows:** same **refuses/crashes** version mismatch via PowerShell; npx script execution may additionally be blocked by local execution policy. The separate `.ps1` installer is genuine native Windows support, not a requirement to install Bash.
- **Evidence / severity / fix:** **C; High**, a **shared** macOS/Linux/Windows prerequisite mismatch, not an OS-specific crash claim. Align installer validation with `^22.16.0 || >=24.0.0`, check required built-ins, and document interactive versus unattended setup.

### F21 — Pi subagent termination does not have Windows graceful/tree semantics

- **Location:** `packages/pi-plugin/src/subagent-runner.ts:426-460`, `:1990`, `:2816-2833`.
- **Linux:** **works** for a direct child: SIGTERM permits a flush, then SIGKILL after two seconds. It does not establish process-group cleanup of arbitrary grandchildren.
- **Windows:** **degraded**: Node kill signals terminate rather than deliver a Unix graceful SIGTERM. For fallback `cmd.exe`/PowerShell launchers, killing the shim does not guarantee termination/drain of the actual child tree. The runner's post-exit bounds prevent indefinite waiting but do not constitute tree ownership.
- **Evidence / severity / fix:** **C; Medium/High** for timed-out background work continuing to consume tokens. Prefer the resolved runtime+CLI script, implement protocol shutdown and a Windows Job Object/tree kill backstop; verify native child/grandchild cleanup.

## Findings: native runtimes, filesystem behaviour and dashboard

### F22 — Embedding availability/performance depends on OS, ABI and runtime

- **Location:** `packages/plugin/src/features/magic-context/memory/embedding-local.ts:89-108`, `:468-476`, `:528-614`, `:669-700`; worker override `packages/plugin/src/features/magic-context/memory/embedding-worker.ts:14-21`; package native optionals `packages/plugin/package.json:70-73`, `packages/pi-plugin/package.json:54-57`; actual doctor load probe `packages/cli/src/lib/embedding-runtime.ts:97`.
- **Linux:** **works** with matching glibc/architecture native ONNX/Sharp; **degraded** to slower single-thread WASM on recognized native load errors, including likely-musl systems. **No-op** local embeddings after native and WASM both fail. Model download/cache filesystem access is also required.
- **Windows:** **works** with compatible binaries/runtime DLLs; **degraded** to WASM for recognized missing bindings/VC runtime/Sharp failures, or **no-op** if both fail. Not every native pipeline/inference error matches the import-time fallback classifier.
- **Evidence / severity / fix:** **C; Medium**, not verified inference. Preserve the existing fallback and doctor diagnostics, test native and filesystem-capable WASM on x64/ARM64 and Linux musl, ship/check the necessary DLL/ABI assets, and surface active backend/disabled state. Old Bun (<1.4) deliberately selects WASM to avoid a native teardown panic; Electron selects WASM regardless of OS. These are handled runtime differences, not unconditional Windows failures. Current ONNX pin is 1.30.0; historical Intel-mac absence messages do not prove current Linux/Windows bindings absent.

### F23 — Embedding lock's Windows EPERM handling can evade its timeout

- **Location:** `packages/plugin/src/features/magic-context/memory/embedding-local.ts:140-203`.
- **Linux:** **works** for a readable exclusive-create lock with heartbeat/stale takeover; ordinary non-EEXIST/non-EPERM failures throw.
- **Windows:** **degraded** and potentially nonterminating initialization if `wx` repeatedly yields EPERM and stat fails: the catch at `:182` immediately `continue`s, before the elapsed-time check and sleep. EPERM from an ACL denial is treated like “lock exists”, not distinguished from contention. This is a code-reachable risk, not an observed Windows hang.
- **Evidence / severity / fix:** **C; Medium.** Enforce deadline/backoff on every loop path, distinguish missing/denied paths from real contention, and test inaccessible lock locations. Keep the existing rule that a real five-minute contention timeout must not load unsynchronized.

### F24 — WAL/leases assume a local, correctly locking filesystem

- **Location:** `crates/mc-module/src/host_store.rs:909-928`, `crates/mc-store/src/lib.rs:7919`; `packages/dashboard/src-tauri/src/db.rs:697-705`, `:754-763`; JS writer acquisition `packages/plugin/src/shared/sqlite.ts:244-265`.
- **Linux:** **works** on the local filesystem in L1; **degraded/refuses**, with possible integrity risk, on NFS/SMB or mounts lacking WAL shared-memory/locking semantics.
- **Windows:** **works** on appropriate local filesystems; **degraded/refuses** on network/redirected/cloud-synced roots, conflicting readers/scanners or unsupported locking. Shared `MAGIC_CONTEXT_STORAGE_DIR` accepts an absolute path without a local-filesystem suitability check. Bundled SQLite does not repair an unsuitable VFS/filesystem.
- **Evidence / severity / fix:** **C + L1 (one local Bun WAL transaction, not network or Rust lease proof); High.** Detect/document unsupported storage placements and run two-process locking/WAL/lease tests on local NTFS and target Linux filesystems. A lease/CAS protects logical writers only if the underlying database locking works. Do not select DELETE journal mode independently in one participant to hide a failure.

### F25 — Windows sharing violations change atomic publish and cleanup outcomes

- **Location:** `packages/plugin/src/shared/storage-permissions.ts:72-84`, `packages/plugin/src/config/raw-loader.ts:438-488`, `packages/cli/src/lib/atomic-write.ts:51-64`, `crates/mc-store/src/private_permissions.rs:97-108`; dashboard replace `packages/dashboard/src-tauri/src/config.rs:255`.
- **Linux:** **works** for ordinary same-filesystem rename even while another reader holds the old file.
- **Windows:** **degraded/refuses** when readers/scanners deny delete sharing: same-directory rename/replacement or removal can fail. Helpers generally propagate/clean up once, not retry bounded sharing violations. Raw config migration explicitly warns and leaves flat fields unapplied on publication failure. This is conditional, not a claim that Windows rename always fails.
- **Evidence / severity / fix:** **C; Medium**, **High** for maintenance blocked with a stale configuration. Close owned handles before replacement, use the appropriate atomic replace primitive with bounded sharing-violation retries, and test a second process holding the target. Preserve symlinked dotfile semantics.

### F26 — Legacy model-cache copying recreates symlinks without a Windows fallback

- **Location:** `packages/plugin/src/shared/storage-permissions.ts:117-135`; best-effort caller `packages/plugin/src/features/magic-context/storage-db.ts:314-321`.
- **Linux:** **works** for normal symlinks.
- **Windows:** **degraded** without the symlink privilege/Developer Mode or where link type must be specified: `symlinkSync(target, destination)` can fail. The caller logs and continues, leaving a partial model-cache copy and requiring redownload. This is not failure of every legacy database copy.
- **Evidence / severity / fix:** **C; Low/Medium.** Preserve link type where supported; otherwise copy only policy-approved regular contents or report an explicit resumable migration result. Never follow an untrusted link merely to make copying succeed.

### F27 — Dashboard GUI startup has Linux-specific display/WebKit/tray prerequisites

- **Location:** `packages/dashboard/src-tauri/Cargo.toml:18`, `:31-39`; `packages/dashboard/src-tauri/src/main.rs:36-40`, `:124-206`; Linux dependency packaging `.github/workflows/dashboard-release.yml:130-136`.
- **Linux:** **works** with a display, WebKitGTK 4.1 and the required desktop libraries; **refuses/crashes at startup** if native prerequisites are unavailable. Tray interaction is desktop-environment dependent; an absent tray can degrade access to tray actions. The native setup propagates menu/tray build errors to the final `expect`.
- **Windows:** **works** with WebView2 and a desktop session; **refuses/crashes at startup** if the native webview environment cannot initialize. Release packaging is delegated to Tauri; no native GUI run was performed here.
- **Evidence / severity / fix:** **C; High** for the dashboard, not the plugins. Document/check Linux runtime packages and Windows WebView2, do not make an optional tray indispensable, and exercise installed binaries under X11/Wayland and native Windows. `--serve` is a real alternative but not equivalent to every desktop feature (F29).

### F28 — Dashboard model discovery depends on each GUI launch environment

- **Location:** `packages/dashboard/src-tauri/src/commands.rs:679-740`, `:845-929`, `:1067-1117`, `:1221-1357`.
- **Linux:** **works** with direct candidates/PATH or `$SHELL -l -c`; **degraded** if GUI/service PATH omits version-manager binaries and SHELL is unset. HOME-only candidate generation also produces root-relative guesses when HOME is unset. Pi/OMP return an empty list; OpenCode supplies an explicit catalog error.
- **Windows:** **works** with known profile/npm/pnpm/WinGet/Scoop candidates and `where.exe`; **no-op** login-shell fallback (`None`). A custom version-manager/GUI PATH arrangement outside the candidate set can produce empty model lists despite a working terminal CLI.
- **Evidence / severity / fix:** **C; Medium.** Add configurable host executables and consistent profile/home fallback; expose per-harness discovery failure rather than empty-list ambiguity. Rust's direct `.cmd` execution is intentional in this file; it is not the same Node spawn contract as F34.

### F29 — Dashboard updates can silently fail; serve mode intentionally cannot update

- **Location:** `packages/dashboard/src/lib/updater.ts:9-20`, `:27-44`, `:52-106`; `packages/dashboard/src/lib/platform.ts:59-74`; updater config `packages/dashboard/src-tauri/tauri.conf.json:46-51`.
- **Linux:** **works** only for an applicable signed Tauri update and writable/supported install layout; **degraded/no-op** for unavailable platform manifests, permissions or package-managed layouts. Toast install exceptions are swallowed. **No-op** updater/relaunch/event subscription in browser serve mode, with explicit guidance for interactive update requests.
- **Windows:** same **works/degraded/no-op** distinctions, with installer/elevation/locked-file constraints rather than AppImage/package-manager constraints. These are conditional risks; the code does not hardcode a macOS-only manifest.
- **Evidence / severity / fix:** **C; Medium.** Report toast-install errors and supported install/update channels, exercise signed installs/relaunch on each OS and retain a package-manager/manual path. The six-target release matrix and one merged manifest are already present (`.github/workflows/dashboard-release.yml:86-115`, `:180-203`, `:221-279`). No public endpoint/release assets were fetched in this census.

### F30 — Opening browsers has real Linux/Windows runtime prerequisites

- **Location:** `packages/dashboard/src/lib/open-external.ts:20-26`, `packages/dashboard/src-tauri/capabilities/default.json:11-14`, `packages/dashboard/src-tauri/src/serve/mod.rs:184-185`, `:580-588`; CLI `packages/cli/src/commands/doctor-opencode.ts:586-599`.
- **Linux:** **works** via the opener/xdg-open with a browser association; **no-op** automatic serve browser opening without DISPLAY/WAYLAND_DISPLAY; **degraded** on headless/minimal desktops without xdg-utils/handlers. The release workflow installs xdg-utils, including for ARM64.
- **Windows:** **works** through native opener or CLI `cmd /c start`; **degraded** in a session without an interactive desktop/default browser. Serve's `has_gui_display` always returns true on Windows, so it attempts opening even in a noninteractive service.
- **Evidence / severity / fix:** **C; Low.** Keep the strict docs-only URL allowlist; expose failures with a copyable link and detect headless Windows appropriately. Browser-mode `window.open` is also subject to popup policy. Do not grant general shell/open-path permission to solve a help-link problem.

### F31 — Dashboard file-replacement detection is reduced on Windows

- **Location:** `packages/dashboard/src-tauri/src/broca_wal.rs:662-675`; consumers `packages/dashboard/src-tauri/src/db/opencode_list_cache.rs:281`, `:296`, `packages/dashboard/src-tauri/src/db.rs:2944`, `:6789`.
- **Linux:** **works** with device/inode identity in cache invalidation.
- **Windows:** **degraded**: `file_identity` returns `None`, so callers lose identity-based detection when a file is replaced at the same path. Length/mtime and other consumer-specific signals remain, but equal-metadata replacement can leave stale cache/session diagnostics.
- **Evidence / severity / fix:** **C; Medium.** Supply Windows volume/file IDs and test same-path, same-size replacement of WAL/index/database inputs. Do not claim every Windows refresh is stale.

### F32 — Dashboard sensitive-file expansion block omits Windows credential locations

- **Location:** `packages/dashboard/src-tauri/src/embedding_probe.rs:169-208`, `:244-257`.
- **Linux:** **works** for the explicitly blocked `~/.ssh`, `.aws`, `.gnupg`, `~/.config/gh` roots, including lexical traversal/canonical symlinks; other credential directories are outside that list.
- **Windows:** **degraded** security: canonicalization exists, but the directory list remains Unix-oriented (not `%APPDATA%/GitHub CLI` or host-specific auth stores) and `Path::starts_with` comparisons are lexical/case-sensitive, not NTFS identity comparisons. `{file:~\...}` also does not get the `~/` expansion. A probe can read a credential file not caught by the list into a configured field; this is not automatic exfiltration on startup.
- **Evidence / severity / fix:** **C; High.** Define platform-aware sensitive roots using the programs' actual resolvers, compare canonical identities with filesystem case rules, support both home separators, and test case/junction aliases.

### F33 — A few subprocesses still lack Windows console suppression

- **Location:** `crates/mc-module/src/project_identity.rs:153-162`; JS alias `packages/plugin/src/features/magic-context/dreamer/verify-diff.ts:19`; bundled local-fs provider git probes `packages/retina-local-fs/src/provider.ts:289`, `:313`; optional setup star `packages/cli/src/commands/setup-opencode.ts:686-690`.
- **Linux:** **works**, no Windows console window contract needed.
- **Windows:** **degraded** UX: Rust git has no `CREATE_NO_WINDOW`; the promisified JS git calls (including the local-fs provider) and dynamically imported execSync star action have no `windowsHide`. These can flash consoles when invoked from GUI-hosted work. Most other production TS spawns do set the flag, and dashboard commands use their `NoWindowExt` helper.
- **Evidence / severity / fix:** **C; Low.** Apply the common suppression primitive and extend the source fence to resolved aliases/dynamic imports. The existing fence at `packages/plugin/src/shared/windows-hidden-spawns.test.ts:23-115` cannot certify every alias simply from its test name.

### F34 — Some Node shell-outs bypass the existing Windows shim renderer

- **Location:** updater `packages/plugin/src/hooks/auto-update-checker/checker.ts:357-366`; Pi registry check `packages/cli/src/commands/doctor-pi.ts:223-233`; variant-catalog probe `packages/cli/src/commands/doctor-opencode.ts:215`.
- **Linux:** **works** with the respective executable on PATH; missing programs degrade these optional probes/update attempts.
- **Windows:** **degraded/refuses** when only npm `.cmd` shims exist: bare Node `spawn`/`execFileSync` is not the supported way to run batch files. Registry/version/catalog checks return null/error, or the updater's host install fails. Bun may have different shim support; do not generalize a Node failure to every Bun host.
- **Evidence / severity / fix:** **C; Medium.** Reuse the explicit ComSpec/argv renderer (already used in `packages/cli/src/lib/opencode-helpers.ts:14-34` and Pi/OMP helpers), or use HTTP registry queries and a resolved runtime+script. Test `%`, spaces, `&` and long command paths, not just a mocked successful executable.

## Findings: scripts users/operators depend on

### F35 — ck-mc placement requires Apple code signing even for a foreign binary

- **Location:** `scripts/place-ck-mc.sh:29-55`, `:63-66`, `:243-252`; signing workflow `.github/workflows/sign-notarize-dispatch.yml:29-30`, `:70-77`.
- **Linux:** **refuses** at unconditional `codesign --verify --strict`; L2 found no codesign. Even removing that check leaves Mach-O/STABS assumptions and BSD `stat -f %i` in running-inode verification.
- **Windows:** **refuses** in native Windows without Bash and **refuses** in a compatibility shell without Apple's codesign. Atomic overwrite of a running `.exe` has an additional Windows lifecycle constraint.
- **Evidence / severity / fix:** **C + L2; High** for this supported placement/upgrade path. Move common digest/fence/provenance checks to a cross-platform placement operation; apply platform-specific authentication and debugger-hardening policy (not Apple tools) and Windows stop/replace/restart. Keep full-SHA/digest verification; deleting the signing gate is not the fix.

### F36 — Coordinated restart/migration window is macOS-specific and masks missing probes

- **Location:** `scripts/restart-window.sh:52`, `:61`, `:69`, `:97-98`, `:122-132`, `:159`, `:168`.
- **Linux:** **refuses** at codesign preflight; later `cp -c` backup/restore would fail. `launchctl` bootout/bootstrap failures are swallowed, so a Linux service equivalent is never stopped/restarted. More seriously, `holders()` pipes lsof errors away and can yield empty output for unavailable/failed inventory.
- **Windows:** **refuses** without a compatibility shell/Apple tools; Bash process substitution, rsync, lsof, launchctl and clone flags have no native replacement here. Service/sentinel steps can **no-op** if execution gets that far.
- **Evidence / severity / fix:** **C + L2 (clone/signing capability, not live execution); High.** Implement explicit OS service-manager adapters, capability preflight and fallible holder inventory; use consistent SQLite snapshots or supported copy fallback, with paired-store rollback. Never interpret a failed probe as “all stores closed”.

### F37 — Backup script requires a macOS mount path and BSD stat

- **Location:** `scripts/backup-live-stores.sh:19`, `:23-24`, `:32-44`, `:58`, `:74-76`.
- **Linux:** **refuses** at the default `/Volumes/UGREEN/mc-backups` unless deliberately supplied an existing destination; then GNU `stat -f %z` fails rather than reporting byte size. Hardcoded OpenCode HOME path ignores XDG relocation.
- **Windows:** **refuses** as a native command (Bash/utilities/path syntax); compatibility-shell paths and BSD stat assumptions still do not make it portable. No native backup wrapper is supplied.
- **Evidence / severity / fix:** **C + L2; High** for recoverability, not first plugin startup. Use portable metadata/directory resolution and explicit destination selection, keep VACUUM INTO consistency/integrity checks, and restore both stores only with matching fences. This script was read, never executed.

### F38 — Other maintenance/release/replay tools have POSIX and scratch-path contracts

- **Location:** `scripts/heap-snapshot-live.sh:8`, `:19-24`, `:41-49`; `scripts/run-rust-hermetic-e2e.sh:18-19`, `:32-48`; `scripts/release-dashboard.sh:57`, `:263`; `scripts/merge-pr.sh:147`; `scripts/ckmc-write-probe/prep.sh:10`; `packages/plugin/scripts/replay-execute-pass.ts:77`, `packages/plugin/scripts/profile-cloned-ts-transform.ts:22`; `scripts/b2-drill/repair-history-host-probe.ts:53`; `packages/plugin/scripts/perf-audit/migration-v95-integration-rehearsal.ts:14`.
- **Linux:** **works** for general Bash/git/gh/Python/sqlite3/curl/jq/rsync tooling when installed; **refuses/crashes** for BSD `cp -c`, unset required TMPDIR, missing TTY, timeout/lsof/probe tools or unavailable host binaries. Python/Bun tools using `/tmp` defaults are normally usable but require explicit isolation. `getconf DARWIN_USER_TEMP_DIR` snippets in historical reports are not portable runtime resolvers.
- **Windows:** **refuses** native execution of `.sh` tools; **degraded/refuses** in Git Bash/WSL where POSIX paths/PIDs/sockets address the compatibility environment rather than the native host. Symlink-based replay scaffolds may need privileges. Some require Bun-specific APIs or `python3` rather than Windows' `py`/`python`; no common native launcher covers the collection.
- **Evidence / severity / fix:** **C + L2; Medium**, **High** when relied on for deployment/backup. Separate product-supported operator tools from research probes, provide native equivalents for supported operations, resolve OS temp via APIs, capability-check commands, and keep fixture/live modes unmistakable. Docker drive/release scripts deliberately run Linux containers; they are useful Linux evidence, not native Windows evidence.

### F39 — PATH/desktop detection covers common installs, not every platform install

- **Location:** `packages/cli/src/lib/find-on-path.ts:20-23`, `:36-49`; `packages/cli/src/lib/opencode-detect.ts:89-128`, `:175-192`; dashboard equivalents `packages/dashboard/src-tauri/src/commands.rs:767-801`.
- **Linux:** **works** for PATH/home/version-manager candidates and user XDG desktop markers; **degraded** for never-launched system-only Desktop/Flatpak/custom wrapper installs outside those markers. `/usr/share/applications` is not in the cited Desktop candidate set.
- **Windows:** **works** for common `.exe/.cmd/.bat/.com` and known package-manager installs; **degraded** when configured PATHEXT uses another extension (CLI walker does not read PATHEXT), or a custom never-launched Desktop installation is outside the candidate path. OpenChamber bundled CLI discovery is explicitly macOS-only; no equivalent foreign-OS wrapper discovery is provided here.
- **Evidence / severity / fix:** **C; Medium**, conditional on install channel. Allow a user-selected executable/host and add actual supported installer layouts; don't replace native detection with a blanket assumption that a `.desktop`/`.exe` pathname proves a runnable installation. Pi's *subagent* Windows resolver separately does understand PATHEXT (see handled inventory).

### F40 — Source-only Node tooling requires TypeScript-enabled Node, not merely the version

- **Location:** `packages/plugin/scripts/smoke-node-sqlite.ts:5-15`; CI uses Node 24 at `.github/workflows/ci.yml:65-68`, `:124`.
- **Linux:** **refuses** on the remote custom Node v22.22.1: L3 showed absence of TypeScript support even with the stripping flag. The smoke validates zero cases in that environment.
- **Windows:** **works** with an appropriate TS-stripping Node build; **refuses** on a runtime lacking that capability or requiring flags. This is shared with macOS custom/older Node builds, not a plugin OS gate.
- **Evidence / severity / fix:** **C + L3; Low** developer verification, **Medium** if used as install-health evidence. Run the documented Node-24 gate with a compatible build, or compile the smoke to JavaScript first; never count a source-loader failure as a SQLite pass. Published plugin/CLI builds ship JS, so this finding does not itself block their installation.

## Platform-feature inventory: equivalents and current handling

| Feature relied on | Linux equivalent / handling | Windows equivalent / handling | Source / conclusion |
| --- | --- | --- | --- |
| Owner-only 0700 directories, 0600 files, umask | POSIX modes/umask; implemented, L1 creation verified; unsupported mounts need an explicit policy | Owner SID + protected DACL, not chmod/read-only; missing enforcement in JS/Rust/dashboard | F01–F04; `crates/mc-module/src/main.rs:32` |
| Symlinks, junctions, no-follow and bounded reads | lstat/symlink_metadata, O_NOFOLLOW, dev/ino; partly handled | Reparse-point-aware CreateFile opens and volume/file IDs; lstat/canonicalization exists, no-follow/identity gaps remain | F05–F07, F26; intended user config symlinks preserved at `packages/cli/src/lib/atomic-write.ts:25` |
| Path joining/separators/absolute storage | `path.join`, Rust PathBuf, `/` paths; mostly handled | drive/UNC/long-path prefixes, `\\`, semicolon PATH; mostly handled, remaining split/path-policy defects | F10–F12; `packages/plugin/src/shared/project-directory-key.ts:12-46` handles drive/UNC prefixes, junction/8.3 realpath and lowercase RPC keys |
| Case sensitivity and project identity | POSIX directory key preserves case; actual filesystem may differ | RPC/remembered-git directory keys lowercase Windows-shaped paths; NTFS opt-in case-sensitive directories can be collapsed | `packages/plugin/src/shared/project-directory-key.ts:18`, `crates/mc-module/src/project_identity.rs:217-247`; filesystem-aware identity needs testing; not safe to lowercase all POSIX paths. Non-git `dir:` hashes at `packages/plugin/src/features/magic-context/memory/project-identity.ts:176` and dashboard `project_identity.rs:52` still use path bytes, so spelling/cross-OS relocation is not a portable identity |
| Pi session folder encoding, filename-invalid colons | POSIX slug and colon-safe timestamp naming | drive-colon/backslash slug and safe backup timestamps implemented | `packages/cli/src/lib/migration-paths.ts:8-15`, `commands/migrate.ts:263`, `:270`; single-store backup `doctor-single-store.ts:246`, move-session backup `migrate-session.ts:719`; reverse diagnostics remain F12 |
| Home, XDG config/data/cache, custom roots | XDG and home defaults; env overrides supported | profile/homedir plus intentionally home `.local/share` and `.config`, **not blindly AppData** | `packages/plugin/src/shared/data-path.ts:214-249`, `:305`; `crates/mc-module/src/config.rs:505-515`, `host_store.rs:1937`; dashboard `db.rs:30-65`. F09/F10/F18 are policy drift. Cross-process env disagreement can split stores on any OS |
| Pi/OMP profile/settings/session layouts | `PI_CODING_AGENT_DIR`, OMP profile/custom roots and existing XDG data layout handled | home/profile roots; OMP deliberately does not use Unix XDG data relocation | `packages/cli/src/lib/paths.ts:118-151`, `:166-207`; dashboard `pi_sessions.rs:167-180` mirrors platform gating |
| Temp directories / `$TMPDIR` / Darwin getconf | Node `os.tmpdir()` / Rust `temp_dir()`; `/tmp` when not overridden | TEMP/TMP/profile temp through OS APIs; no Darwin getconf | `packages/plugin/src/shared/data-path.ts:37-56`, dashboard `log_parser.rs:58`; product does **not** shell out to Darwin getconf. F38 covers scripts/snippets that assume TMPDIR. GUI and shell temp/env roots must agree to find diagnostic logs |
| PID liveness, process command/start/parents | kill(0), procfs, procps ps; restricted mounts degrade | tasklist + PowerShell Win32_Process CIM; bounded/cached async query exists | F13/F14; `rpc-utils.ts:141`, `:747`, `:1045`; `doctor-storage-holders.ts:34` reads Linux environ but Windows only command line |
| Open-file holder probes | lsof, potentially `/proc/*/fd`; current doctor requires lsof | native handle inventory/host identity + SQLite lock probe; current process-based substitute is coarser | F15–F17; scripts F36 can mask lsof failure; these are not interchangeable with PID name checks |
| Service control / launchctl | systemd user units (or another explicit supervisor) | SCM/user startup/task scheduler or fleet supervisor API | F36: no equivalent for LaunchAgent sentinel bootstrap/bootout. `ck module start/stop/restart` already exists in scripts but does not manage those LaunchAgents |
| Signing, notarization, hardened runtime/debugger resistance | package/signature verification, suitable ptrace restrictions; not Mach-O codesign | Authenticode/package trust plus appropriate debugger/process security policy | F35; Apple workflow is intentionally macOS-only. Dashboard Apple entitlements are scoped under `bundle.macOS` in `tauri.conf.json:42`; updater signature verification is separate from OS signing |
| CoW clone / BSD metadata utilities | `cp --reflink=auto`/FICLONE or ordinary verified copy; GNU `stat -c`/API metadata | appropriate clone/copy API or verified ordinary copy; Windows file IDs | F35–F38; `cp -c` and `stat -f %z/%i` are not portable. Rust profile's macOS-only clone already has non-macOS `fs::copy` at `crates/mc-module/src/tests/per_pass_cost.rs:129-138` (test-only) |
| Exclusive-create locks, file replacement and deletion | O_EXCL/rename/unlink semantics; model lock heartbeat/reclaim exists | CREATE_NEW/exclusive-create, delete-sharing and ReplaceFile semantics; partial adaptation only | F23/F25; no claim that a cross-compile tests scanner/reader sharing violations |
| SQLite built-ins and native modules | Bun builtin sqlite, Node builtin node:sqlite, bundled Rust SQLite | Same runtime APIs with Windows SQLite VFS; no better-sqlite3 ABI download required for product | `packages/plugin/src/shared/sqlite.ts:94-129`, `:153`; `Cargo.toml:37`, dashboard `Cargo.toml:21`. L1 exercised Bun only; Node runtime availability and snapshot-backup API must be checked separately (`packages/cli/src/lib/database-access.ts:184-205`) |
| WAL, shared memory, busy timeout, leases/CAS | supported local SQLite VFS and locks | local NTFS/VFS locks; network shares/redirected profiles are not automatically safe | F24; MC cache store delegates `open_sqlite` to pinned cortexkit-store; lease implementation is an upstream boundary (`Cargo.toml:14-16`), not audited by reading only MC |
| `windowsHide` / no console windows | unnecessary/no-op | Node windowsHide, Rust CREATE_NO_WINDOW | mostly handled: dashboard `process_ext.rs:16-43`, Pi `subagent-runner.ts:1451`; remaining sites F33 |
| Executable/PATHEXT/shim invocation | execute bit and shebang, Node filesystem PATH walker avoids `which` dependency | exe vs cmd/bat/ps1 and ComSpec/PowerShell; shebang alone does not launch JS | CLI `find-on-path.ts:32`, Pi helper `pi-helpers.ts:18-28`, OMP `.js` via Bun `omp-helpers.ts:34-59`; subagent `subagent-runner.ts:374-478` resolves running package/script first, PATHEXT fallback including PS1. F34/F39 are exceptions |
| Argv size, stdin and prompt files | Linux per-argument 128 KiB limit; large prompts delivered on stdin | CreateProcess total 32,767-char limit; all print-mode Windows prompts delivered on stdin | **Handled:** `packages/pi-plugin/src/subagent-runner.ts:1278-1357`, `:1487`; system prompt in temp file, RPC-budget lane delivers protocol data rather than positional message. Remaining huge paths/flags still need native testing |
| Child shutdown / signal semantics | SIGTERM then SIGKILL | protocol close/Job Object/tree termination, not Unix signal delivery | F21; dashboard bounded child probes use `kill_on_drop` (`commands.rs:829-867`); not a guarantee about arbitrary child trees |
| Shell-outs to sh/bash/git/python3/npm/gh/sqlite3 | optional packages on minimal distros; git failure pauses repository memory features instead of inventing a new identity | native git.exe/gh.exe/sqlite3.exe, explicit cmd/PowerShell renderers, Python launcher; not bash by default | `crates/mc-module/src/project_identity.rs:17-22`, `:153`; `doctor-repair-db.ts:164`, `:277-322` detects missing `.recover`/DBPAGE capability and must not call that data loss. F34/F38 cover raw npm/sh/script assumptions. Most occurrences of tool name `bash` in transforms are transcript data, not shell execution |
| Git environment isolation and null-device spelling | local-fs provider disables global/system config with `/dev/null` and a minimal child env | Git for Windows has POSIX path compatibility, but native Windows uses `NUL`; provider's explicit env omits SystemRoot/home and needs native validation | `packages/retina-local-fs/src/provider.ts:289-324`; imported/bundled through `packages/plugin/src/features/magic-context/smart-notes/condition-compiler.ts:3-5`. No blanket Windows git failure is proven; F33 covers its missing console suppression. Use an explicit portable config-isolation strategy and preserve necessary OS child environment |
| ONNX/Sharp, Bun/Node worker threads, Electron | glibc/musl/arch bindings or filesystem-capable WASM; worker deadlines/disposal | matching DLL/arch bindings or WASM; Windows runtime dependencies | F22/F23. Worker constructed from URL (not raw URL pathname) at `embedding-worker-client.ts:31-43`; migration worker uses the same URL pattern. No assumption that Node can import bun:sqlite |
| QuickJS sandbox and WASM/tokenizer assets | WebAssembly runtime; singlefile asyncify QuickJS avoids a platform `.node` binary | same WebAssembly runtime; no Unix process sandbox dependency for this VM | **Handled by design:** `packages/plugin/src/features/magic-context/smart-notes/sandbox-runner.ts:76-110`; load/timeout failure is explicit. `packages/plugin/package.json:60-67`, Pi `package.json:47-51`; current census did not execute QuickJS/native embedding inference |
| subc socket transport, including alleged Windows UDS blocker | authenticated TCP endpoints in selected JS SDK | authenticated TCP endpoints, not a Unix-domain socket requirement in this client | **Important correction:** 0.11.1 `connection-file.ts:15-18`, `socket.ts:115-131` use host/port + `net.connect`. MC Rust historian uses subc-transport (`crates/mc-module/src/historian_producer.rs:21`) and provider uses SDK serve (`main.rs:82`); Rust transport/launch nonce are upstream dependencies (`Cargo.toml:23-25`). The UnixListener occurrence in MC `lib.rs:33009` is test code, not proof of production Windows refusal. AF_UNIX on modern Windows or named pipes would need explicit handling if an upstream channel requires them; no such product refusal was established here |
| Dashboard menu/tray/webview/opener/updater | WebKitGTK, appindicator/desktop integration, xdg-open, signed supported update channel | WebView2, Windows tray/browser associations, signed NSIS/MSI update/install policy | F27–F30; `dashboard-release.yml:86-115` builds both architectures per OS, ARM64 Windows NSIS-only. Frontend `platform.ts:32-74` explicitly adapts browser serve mode, which lacks Tauri event/update/relaunch capabilities |
| File watching and cache freshness | inode/mtime/file-size polling; notify crate can use platform backend | file IDs/mtime/polling; ReadDirectoryChangesW if watcher used | notify dependency has macos_fsevent feature (`dashboard/Cargo.toml:22`) but that alone is **not** an OS runtime gate; reviewed dashboard readers use metadata caches/polling. F31 is the real identity fallback |
| CRLF, Unicode, embedded tokenizer/core determinism | explicit CRLF normalization/UTF-8 and embedded vocab | same; avoids dependency on local line-ending conventions for rendered project docs | **No OS-specific gate found:** `crates/mc-core/src/lib.rs:3-7` is pure/no I/O; `crates/mc-tokenizer/src/lib.rs:33-37` embeds vocab at build time; `crates/mc-module/src/project_docs.rs:34-44` normalizes BOM/CRLF. Neither core nor tokenizer needs a shell, home dir, database or socket at runtime |

## Coverage and verification limits

- The OpenCode v1 entry, v2 server/hooks, shared config/storage/RPC/update/dreamer/embedding primitives and Pi entry/subagent execution were searched for platform branches, native/process/file primitives and path parsing. Pi imports the shared storage, embedding, identity, sandbox and transport implementation: F01, F04, F06–F08, F13–F14 and F22–F26 therefore apply to both hosts, not just the package where the source lives.
- CLI setup's config writes, binary/model detection and conflict fixes are covered above. Doctor's caches, holders, recovery executable and offline migration gates are covered. `migrate`/`migrate-session` use platform-aware forward slugs, safe timestamp filenames, shared SQLite/snapshot/path APIs and staged rename, so their remaining platform exposure is F01/F18/F19/F24/F25 and runtime availability, not an additional unconditional OS ban.
- Rust mc-core/mc-tokenizer have no OS-dependent runtime I/O in their own implementation. mc-store owns SQLite/domain migration and private-file helpers; mc-module owns provider boot, config/home resolution, git/docs and host-domain access. Published commons/subc/log/lease crates are dependency boundaries. No sibling checkout, user Cargo cache source, live daemon or operator config was inspected to turn those boundaries into unsupported certainty.
- macOS-specific scripts were **not executed**, including `--dry-run`: several dry-runs still read live schema/config data. Only scratch-file capability observations were used. The user-supplied worktree preparation says install/build passed; that is not a Linux/Windows runtime proof. No product code, manifest, lockfile or generated output was changed.
- Linux evidence is small and concrete, not a full install test: four runtime checks passed and six shell capabilities were observed. Initial start-time expectation failed; investigation found the sandbox's missing `/proc/uptime`, and the final probe verified the actual degraded state. Initial capability collection stopped on missing codesign; the completed collection recorded absence explicitly. L3 remains a failed, zero-check Node source smoke, not a green gate. No Windows machine, installed dashboard GUI, signed updater transaction, native model inference, network filesystem or real fleet restart was exercised.

## What blocks a Linux install first?

**For the complete Rust/fleet placement route, the first definite OS-specific blocker is F35: `scripts/place-ck-mc.sh:36` unconditionally requires Apple codesign; the coordinated window stops for the same reason at `scripts/restart-window.sh:97`.** This happens before a correctly built Linux ck-mc can be placed through that route. A current-Node, local-filesystem **npm plugin-only install has no unconditional Linux OS refusal established by this census**; do not tell users it cannot run. Its earliest conditional failures are the installer accepting too-old Node (F20), missing native/runtime dependencies (F22), and restricted process metadata/missing lsof during upgrade (F13/F15). A headless dashboard needs `--serve` or a GUI environment; WebKit/display prerequisites are the first dashboard-specific gate (F27).

## What blocks a Windows install first?

**A privacy-compliant native Windows install is blocked from its first private config/store creation by F01–F04: owner-only enforcement is replaced by inherited ACLs or a successful no-op, not an implementation of the required 0700/0600-equivalent policy.** The process may nevertheless start; this is a support/security blocker, not a universal startup crash. For the existing-store Rust upgrade, the first Windows-specific CLI blocker after holder checks is F18's HOME-only `single_store_path_mismatch` under the normal HOME-unset environment. Fleet placement itself is additionally blocked by F35's Bash/Apple-signing contract. For a default-home plugin-only setup with a suitable Node/Bun host there is no proven blanket Windows refusal; first operational gaps include wrong-layer conflict repair (F11), POSIX-only token mode checks (F08), and inability to clear an existing OpenCode 2 cache slot (F16).

## Headline

**Magic Context has 40 platform-sensitive findings, not 40 proven startup crashes: Linux's first definite full-fleet installation blocker is the unconditional Apple codesign gate in ck-mc placement, while Windows's first support blocker is missing owner-only ACL enforcement at private-file creation (and its existing-store Rust upgrade has a concrete HOME-only path-mismatch refusal).** Ordinary current-runtime plugin-only installs are not shown to be categorically unsupported on either OS. The largest gaps are cross-platform security primitives, safe maintenance/placement and locked-down process/filesystem behaviour; many everyday adaptations already exist, including Windows executable shims, large-prompt stdin delivery, XDG/shared-store paths, native-to-WASM embeddings, multi-platform dashboard release builds and a TCP-based subc JS transport rather than the presumed Unix-socket blocker.
