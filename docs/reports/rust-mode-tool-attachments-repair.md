# Rust-mode tool attachments: review repair and acceptance

This supersedes the defer-restoration policy in `rust-mode-tool-attachments.md`,
not the historical evidence in `rust-mode-tool-attachments-review.md`.
All five findings now pass their original final assertions. Two approved fixture
corrections are retained: remove the length-1 image assertion that witnessed the
old defect immediately before the contrary final byte-equality assertion, and
reload the frozen-identity fixture before its manual CAS. The pinned
`attachment_repair_old_adapter_control_refreshes_hygiene_on_second_pass` proves
that the old adapter already refreshes the hygiene baseline on its second pass;
that existing write is not introduced by attachment discovery.

## Repairs

1. **Permission:** recognize the old OpenCode Text/ErrorText projection only when
   the complete message/part identity vector matches after removing attachments.
   Serve those old provider bytes on unpermitted passes. Discovery does not grant
   shared prefix-bust permission or persist a pending-upgrade marker.
2. **Frozen identities:** adopt the repaired identities atomically with an
   independently permitted bust. Unrelated call-input/text/sibling drift still
   passes through the existing rejection fence. Restoration is explicitly excluded
   from `reasoning_trim_only`, so the host applies its prefix-edit thinking policy.
3. **Media-only tags:** retain a separate empty text child for an address tag;
   never put tags into media payloads.
4. **Retention:** store derivable `url`/`data` bytes only in the media source and
   record which native carrier fields to reconstruct. Preserve all other carrier
   metadata, opaque children and completed/error polarity. No cap is increased.
5. **Loss notice:** reject an empty synthesized URL as unshown and emit the same
   deterministic notice. The lossless exemption for unchanged malformed native
   carriers remains intact.

The real-host gate found two additional seams that codec-created fixtures missed:

* Parsed TS blocks omit `provider_executed=false`. Rebuilding their typed shell
  adds that field and changes the old byte fingerprint. Historical replay now
  changes only the retained raw output shell, preserving omitted defaults and
  unknown fields; typed codec ingress keeps its existing serialization order.
* The facade reconstructs tail deltas from its ingress projection cache. Caching
  the old served Text projection erased pending media after the first defer, so
  later flushes could not discover the upgrade. The returned cache projection now
  retains actual attachment-bearing ingress while the response replays old bytes.

Both seams have separate Rust witnesses and isolated red mutation controls.
No serializer epoch, migration, general identity bypass, Pi product change or
LKG hold/release change is part of these repairs.

## Measurements and gates

Tools: Cargo/rustc 1.99.0, rustfmt 1.10.0-stable, Bun 1.4.2,
TypeScript 5.9.3. Rust checks ran on the Linux runner with
`CARGO_TARGET_DIR=target/attachment-repair`:

* `cargo test --locked -p mc-module --lib attachment_review -- --nocapture`:
  **6 passed**, including all five findings and the existing replay control.
* `cargo test --locked -p mc-module --lib attachment_repair -- --nocapture`:
  **5 passed**: write-free wait/restart/bust, unrelated drift fence, pinned old
  hygiene control, parsed-TS identity, and delta-cache retention/restoration.
* OpenCode codec tests: **28 passed**; Pi codec tests: **15 passed**.
* Native cache/explicit frozen-drop and attachment-free byte controls:
  **1 + 1 passed**.
* `cargo clippy --locked -p mc-module --all-targets -- -D warnings` and
  `cargo fmt --check`: passed. Included review tests also pass explicit rustfmt.
* Plugin typecheck: all **3 configured tsc commands passed**.
  Project Biome **2.5.1** checked all **3 adapter/review files**, with no fixes.
* Adapter review/projection tests: **29 passed, 150 assertions**. Pi's text/image
  tagging control: **1 passed, 3 assertions**.
* Mode manifest/prerequisite tests: **7 passed, 63 assertions**. The manifest now
  contains **179 files, 59 Rust invocations** and explicitly includes the new
  upgrade gate. Only the new file's manifest counts were advanced.

For the unchanged 64 x 768 KiB base64 screenshot fixture:

| Measure | Reviewed implementation | Repaired implementation |
| --- | ---: | ---: |
| Parsed request bytes | 151,079,250 | 100,747,858 |
| Attachment-blind projection charge | 313,190 | 313,190 |
| Screenshot projection charge | 302,595,944 | 151,605,608 |
| Projection entry cap | 301,989,888 | 301,989,888 |

This measures retained-size admission, not allocator RSS, throughput or image
validity. Paging controls independently reassemble media and bound every page.
Repeated identical upgrade defers preserve the durable row version after the
existing hygiene baseline settles. Growing real-host tails still perform their
ordinary tag/state writes; no zero-total-writes claim is made for those appends.

## Fresh real-host acceptance

Final product source is `faf5b7fb59a6fea0160fe2955f5fe49c22315d4c`.
The module was built locally for the macOS host with the environment prefixed on
the build command itself:

```sh
MC_BUILD_SHA=$(git rev-parse HEAD) CARGO_TARGET_DIR=target/attachment-host \
  cargo build --locked --release -p mc-module --bin ck-mc
CK_BUILD_REV=1a14993c120725fa1dce7267b6e7d0823835930c \
  CARGO_TARGET_DIR="$PWD/target/attachment-host" \
  cargo build --locked --release \
  --manifest-path target/attachment-host/subconscious-src/Cargo.toml \
  -p subc-core --bin ck-subc
```

The daemon source is a detached clone of Cargo.lock's exact revision, staged
inside this worktree. The daemon reports its package version (its executable does
not expose the revision environment variable in `--version`). The actual pair:

* `ck-mc 0.1.0 (faf5b7fb59a6fea0160fe2955f5fe49c22315d4c)`;
  SHA-256 `547f79faffe837cfc1acec5b88ab1fea66413daa1b6b68e62ba258759dd7e7f1`.
* `ck-subc 0.20.55`;
  SHA-256 `f204aae313364a8c8bad60d25a32e689bd4d4bbc82a0f850f239a72ab5f9a98e`.
* OpenCode **1.18.30**, Bun **1.4.2**. The harness copies both to `ckdev-*`
  executable names and uses the freshly built plugin bundle.

With `MC_E2E_CK_MC_PREBUILT_BIN` and `MC_E2E_CK_SUBC_BIN` selecting that pair,
`MC_E2E_MODE=rust NODE_ENV= bun test --timeout 600000 --max-concurrency=1` on
`rust-tool-attachment-upgrade.test.ts` and `rust-tool-attachments.test.ts` passed:
**2 tests, 60 assertions, 0 failures**.

The upgrade test builds the historical host adapter by replacing only its output
projection expression. It serves an actual tool screenshot as tagged scalar text,
restarts with the current adapter and unchanged tool schema, preserves those exact
provider bytes on three unpermitted defers, then restores exactly one image after
an acknowledged public `session.flush` arm. Three later tail-delta passes retain
the restored logical result bytes (excluding only SDK cache-breakpoint metadata).
It checks permission diagnostics, not just scheduler=execute, and reaches normal
serving rather than an error/parked fallback. The first-sight host control covers
mock screenshot plus real read image/PDF attachments. lsof containment checks
cover three host PIDs; all observed DB/WAL/SHM paths are under the throwaway roots.
No live store was opened, inspected or migrated.

## Negative controls and limits

Safe staged-index mutations were restored with an empty unstaged diff each time:

* Ignore the parsed shell: only
  `attachment_repair_ts_omitted_defaults_preserve_old_identity_on_defer` failed;
  the other three then-present repair tests stayed green.
* Write an adoption counter merely on discovery: only
  `attachment_repair_waits_write_free_then_restores_on_one_bust_after_restart`
  failed (row version 3 vs 2); the unrelated-drift and old-hygiene controls stayed
  green. The parsed-TS test was filtered only for this isolated mutation run.
  An earlier identical-state commit mutant stayed green because the store elides
  unchanged commits; it did not introduce the intended durable write.
* Cache the served legacy projection: only
  `attachment_repair_projection_cache_retains_ingress_during_legacy_replay`
  failed; all four other repair tests stayed green.

Remote Bun dependencies could not be downloaded (DNSResolveFailed), so TS/build
and real-host gates ran locally; Rust package tests/clippy ran remotely. An
attempt to select the git dependency's daemon binary from the module workspace
hit a Cargo resolver panic; building the detached pinned daemon workspace fixed
that tooling limitation. One mutation command lost its transport result; the
mutant was restored, remote liveness checked, and the completed controls above
were rerun without relying on the missing result.

Whole e2e tsc remains red with **22 baseline diagnostics**. A TypeScript compiler
program over **313 root files**, comparing the three changed TS files against
`b737d0b703`, reports the same 22 errors and **zero new diagnostics**. The baseline
includes the harness's pre-existing missing SDK `session.get` type and unrelated
SQLite/OpenCode 2 tests; they are not repaired in this task. AFT inspection was
partial because Rust analysis was still indexing; Cargo and tsc are authoritative.
Full package suites, full native-attach shard, live Anthropic rejection, real CC/Pi
hosts, allocator/RSS and throughput were not rerun or claimed for this repair.
