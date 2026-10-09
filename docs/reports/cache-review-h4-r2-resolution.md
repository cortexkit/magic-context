# H4 second-review resolution

## Integration and scope

H4 is the experimental OpenCode 1/2 adapter for Rust's append-only host-runner
pipeline. `rust_pipeline: "provider"` selects that pipeline; absent settings and
`rust_pipeline: "full_request"` keep the existing full-request path.

Revision work began at `ece4583339fa65defd5ea1196913e2df078af01b`. Imported the independent
second review with cherry-pick `cfe70791322473b94daa1ae5c2664693ad5a2861`, then merged
`origin/train/agent-move` at `fb8ad1dace952ef096392a65f0f6be4696277494`.
The merge completed automatically, without discarding changes from either the H4
branch or the train branch.
`ARCHITECTURE.md` and `STRUCTURE.md` are unchanged from the task base.

The labels below refer to findings in `docs/reports/cache-review-h4-r2.md`.
The implementation fixes have separate commits:

| Finding | Resolution | Commit |
| --- | --- | --- |
| R2.0: restored host rows gained IDs with provider mode disabled | Only `rust_pipeline: "provider"` on an active provider session may add a native message ID to a reconstructed v2 row. Absent `rust_pipeline` and explicit `rust_pipeline: "full_request"` retain pre-H4 bytes. | `b2caa5572e` |
| R2.1: native message aliases | Publish independent copies of the live served window, retaining the host's array identity. Keep private source identities for v2 cache reuse. | `cb9275bbf1` |
| R2.2: v2 restart metadata | Capture a lazy inverse-projection descriptor only during provider admission and store it in native ingest. Restore call/result provider metadata, carrier metadata, images and inline-result placement from those durable bytes. | `9e9623f721` |
| R2.4: missing pass barrier | When the final append had no completing hook, issue a completing sync after every admission is durable. This also handles passes with no subscribed hooks. | `abd99db4c0` |
| R2.3: v2 rendered-cache aliases | Snapshot bridge metadata and copy plain rendered content before handing it to the host. Keep required host `Media.Asset` instances intact. | `bfb4dcc953` |

An ownership follow-up, `5436769751`, also snapshots incoming host-media part
wrappers and cached rendered slices. A reserved header can still be retained from
before publication, so merely copying outgoing rows is insufficient. The additive
non-review test `v2: retained pre-existing synthetic heads cannot mutate the projection cache`
protects that boundary without changing any independent review assertion.

A follow-up publication fix, `cec2f3c69f`, ensures that an ordinary pass does not
serialize a previously served Setup head, as required by the R10 review test.
The in-process review transport deliberately returns a head with a counting
`toJSON` method. `structuredClone` rejects that method. Publication instead copies
JSON data recursively, without invoking or publishing a serializer method. Both
R10 tests remain unchanged and pass; copying does not serialize retained history.

The second review labels the missing historian completion signal (R2.4) as its
only non-blocking finding; it identifies no separate minor defect. That completion
signal is fixed, as are all four blocking findings, including the independent
v2 cache issue R2.3.

The imported review assertions and fixture inputs were not rewritten. The parent
explicitly approved one repository-policy exception: add `windowsHide: true` to
the two `spawnSync` option objects in `payload-review2.test.ts`. Before that change,
the repository's Windows subprocess check found exactly those two calls, at lines
42 and 79, because their options did not explicitly hide console windows. These
flags change no differential input, expected output, assertion, comment, or
subprocess command, and are committed separately in
`da6af71d9e` (`mason: enforce Windows spawn policy in imported review fixture`).

## Copy-cost measurement

`packages/plugin/src/hooks/magic-context/host-runner/publication.bench.ts` invokes
the real publication function and the v2 plain-object copy function. The fixture
has **50,000 known message IDs, 900 live served rows and 3,247,651 live JSON bytes**.
Covered history is represented by its retained IDs, as in the runner's pruned
record. No user transcript or store is sampled. After 20 warm-ups it measures 200
copies on Linux with Bun 1.4.2:

| Boundary | p50 | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Native publication, final JSON-data copier | 0.890 ms | 3.258 ms | 4.611 ms |
| v2 plain-object publication copy | 0.467 ms | 0.793 ms | Not reported |

These are synthetic size-matched copy costs, not a complete host latency or
end-to-end ALF-session benchmark. They exclude admission, SQL, provider calls and
rendering. They do not enumerate or serialize the 50,000-message history on an
ordinary publication. The two p95 values are independent quantiles, not a measured
combined p95.

## Authoritative verification

Linux tools: **Bun 1.4.2**, **TypeScript 5.9.3**, **Biome 2.5.1**, **Cargo 1.99.0**.

- `bun test --timeout 30000 src/hooks/magic-context/host-runner src/v2/hooks/payload.test.ts src/v2/hooks/payload-review2.test.ts src/features/magic-context/storage-host-runner.test.ts`:
  **409 pass, 0 fail, 101,292 assertions, 10 files**. This includes all 16
  comparisons against the historical implementation before H4: with `rust_pipeline`
  absent or `full_request`, outgoing host requests and store-write traces are equal.
- `bun run typecheck`: passed all three package compiler invocations.
- `bun run lint`: passed before the retained-header follow-up, **1,334 files
  checked**, no errors; 10 existing warnings and 6 informational findings were not
  treated as errors or edited. Final focused Biome checks passed both files changed
  by that follow-up; a later whole-package rerun was refused before starting.
- `tsc -p .h4-review2-typecheck.json`: passed an explicit temporary configuration
  checking both second-review files and the adapter test file containing the new
  retained-header regression, since the normal package config excludes
  tests. The config extends the package config, clears exclusions, sets
  `noEmit: true`, `emitDeclarationOnly: false`, and `rootDir: "../.."`. It was removed.
- After the approved fixture flags, the Windows source fence plus both review
  files: **45 pass, 0 fail, 170 assertions, 3 files**. Biome checked the changed
  review file, with no fixes required.
- `cargo test -p mc-module providers::`: **120 pass, 0 fail, 3 ignored**, 1,718
  filtered unit tests. Other Cargo targets were empty or filtered by this selector.
  This ran on Linux in the foreground, as required for a heavy build/test gate.
- Local `bun install --frozen-lockfile`: **996 installs across 1,251 packages**
  checked, no dependency changes. `bun run build` passed all three package builds.
  The final plugin build passed both host bundles and checked 9 unchanged TUI files.
- AFT inspection was partial because its call graph and Biome producer were not
  available. Its TypeScript producer reported no diagnostics in the three changed
  implementation/benchmark files. Compiler and repository lint gates are authoritative.

Throwaway Linux HOME/XDG/storage directories were used for the plugin suites,
with `OPENCODE_DB` unset. Git subprocesses in the differential require trusting
this runner's replicated repository path: the final isolated runs used a temporary
`GIT_CONFIG_GLOBAL` containing only that path's `safe.directory` entry. An earlier
fresh-HOME run failed all 16 differentials before execution on Git's dubious-owner
check; it is not counted as a behavior result. The final corpus passes them all.

## Local real-host probes and store isolation

The host matrix used **OpenCode 1.18.35** and an independently installed
**OpenCode 2.0.24**, with both `rust_pipeline: "provider"` and explicit
`"full_request"`. Each case sent three completed text turns to the local mock
provider, not a paid/external provider. Both off cases created no provider record;
both on cases created an active durable provider record, with no pipeline exit
and at least two admitted rows. Captured request counts were 3 for each v1 case
and 4 for each v2 case (including the host's auxiliary request).

The task reviewer authorized building separate dev binaries from pinned source
and launching them with private daemon/module state, as the CI hermetic tests do,
because no dev binaries were available. `mc-module` was built from the merged worktree; subconscious was cloned
under the throwaway task root at Cargo.lock's pinned
`1a14993c120725fa1dce7267b6e7d0823835930c` revision and built with
`cargo build --release -p subc-core --bins`. Both local builds used `nice -n 10`
and `CARGO_BUILD_JOBS=4`, sequentially. The outputs were **copied, not hard-linked**,
as `ckdev-mc` and `ckdev-subc`. No production binary or live daemon was used.

Every controller/host used task-root HOME, XDG data/config/state/runtime/cache,
OpenCode database and Magic Context storage paths. For v2 the harness requires
`OPENCODE_DB=opencode2.db`; its resolved location is beneath the private
`XDG_DATA_HOME/opencode/`, not the live data directory. `TMPDIR` was rooted under
the task directory too, including Bun's extraction cache. The parent Cargo/Rustup
cache variables were retained only so the prebuilt harness's `cargo --version`
prerequisite check could find the toolchain.

Explicit `lsof -p <host pid> -Fn` inventories were captured for every matrix case.
The probe required a nonempty database inventory and checked **every `.db`, WAL
and SHM path** after realpath resolution against the task root. All were private
OpenCode/context databases. No live store or user configuration was opened, read,
written or migrated; no live-store snapshots were taken.

OpenCode 1 and OpenCode 2 were each rerun with `rust_pipeline: "provider"` after
the final plugin build. A further actual v2
context probe inspected its own database before teardown: **all 4 admitted native
rows contained the durable host-replay descriptor**, holding the original host
message metadata and tool call/result reconstruction data. This checks that the real
context path preserves the lazy metadata capture, not just the direct adapter
fixture. The host probes do not claim a real-host tool/image restart or long-run
canary: those bytes are covered by the independent restart fixture and the Rust
provider codec tests, while the local host matrix exercises actual admission and
ordinary append serving.

Artifacts are outside regenerable build directories, in the task root's
`evidence/` directory (full path in the delivery declaration): per-case lsof
inventories, sanitized mock request bodies, plugin logs, the probe driver,
`final-plugin-build.log`, `final-host-probes.log` and `v2-durable-admission.log`.
The final log for Rust's append-only pipeline (`rust_pipeline: "provider"`) has
two successful per-host entries, one for each OpenCode generation, and includes
the v2 durable-descriptor assertion. Its footer derives the count from the selected
host/pipeline matrix.

## Mutation controls

Each control staged the live implementation first, confirmed an empty working
diff, applied a single marked change, captured its nonempty diff, ran the named
check, then restored from the index, touched the restored file and captured an
empty diff. No mutation was committed.

| Neutralized control | Exact red test | Tests in that run that did not fail |
| --- | --- | --- |
| Add message IDs to restored v2 rows with `rust_pipeline` absent, which should keep the legacy row shape | `setting-off differential v2 absent restored: outgoing request and all store writes equal pre-H4` | Other tests filtered out; one selected test failed |
| Publish the native record-owned message | `H4 second review v1 > R2.1: mutating the host-retained served object cannot rewrite recorded prefix bytes` | Other tests filtered out; one selected test failed |
| Omit durable inverse-projection metadata | `R2.2 v2: durable restart replays the first-served tool result and attachment bytes` | Both v1 and v2 R2.1 retained-object tests passed |
| Clear completing sync's pass flag | `H4 second review v1 > R2.4: an append with no matching subscriptions still completes the historian pass` | R2.2 restart test passed |
| Publish the cached v2 rendered graph | `R2.3 v2: mutating retained host content cannot poison the projection cache` | R2.2 restart test passed |
| Invoke the retained head's serializer during copying | `R10 v1: a zero-append pass never serializes the known Setup head` | v1 R2.1 retained-object test passed |
| Set the imported fixture's child-process `windowsHide` to false | `Windows child processes > every plugin, Pi and CLI subprocess hides its Windows console` | R2.2 restart test passed |
| Borrow the host-retained header while storing the cache entry | `v2: retained pre-existing synthetic heads cannot mutate the projection cache` | The original R2.3 review test passed |

The seven two-line replacements each showed **1 file changed, 1 insertion,
1 deletion** while applied; the serializer invocation showed **1 file changed,
1 insertion**. Every restore produced an empty `git diff --stat`.
Machine-readable mutation evidence, including captured named failures, is in the
delivery declaration.

## Full plugin-suite comparison

The last completed package suite, after `da6af71d9e` and before the retained-header
follow-up `5436769751`, used `bun run test` on Linux with `OPENCODE_DB` unset,
a throwaway HOME/XDG/storage tree and a temporary repository-specific Git trust
file. It ran **8,010 tests across 749 files: 7,990 pass, 9 skip, 11 fail,
320,987 assertions**. The suite itself exits 1; it is **not claimed green**.
The completed suite's failing test names were compared with the pre-fix integration
branch's failures. That comparison exits 0: **no test failed only in that completed suite**.

The comparison baseline is the requested `origin/train/agent-move` integration
branch, before the H4 fixes, at
`fb8ad1dace952ef096392a65f0f6be4696277494`. Its archived sources ran under the same
throwaway-store policy: **7,828 pass, 9 skip, 44 fail, 7,881 tests across 745 files**.
The archive did not have the prepared worktree's generated bundles or the final
Git-trust setup. This is a failure-name comparison, not a claim that H4 fixed the
other 33 baseline failures. No unrelated failing implementation was edited.
All 11 remaining failures below were observed in that train run:

1. `Node WASM Transformers fixture > builds with real fs and persists a model for offline reuse`
2. `review bundle: opencode worker under bun loads, restarts, reads only and shuts down`
3. `review bundle: opencode worker under node loads, restarts, reads only and shuts down`
4. `review bundle: opencode2 worker under node loads, restarts, reads only and shuts down`
5. `review bundle: pi worker under node loads, restarts, reads only and shuts down`
6. `review bundle: omp worker under node loads, restarts, reads only and shuts down`
7. `review bundle: packed opencode worker under bun loads, restarts, reads only and shuts down`
8. `review bundle: packed opencode2 worker under node loads, restarts, reads only and shuts down`
9. `review bundle: packed pi worker under node loads, restarts, reads only and shuts down`
10. `review bundle: packed omp worker under node loads, restarts, reads only and shuts down`
11. `source tests allocate temporary directories only through the registered helper`

The sole new failure in the preceding comparison was the imported fixture's
Windows console policy check. The parent-approved process flags repaired that
check without changing review assertions or inputs. Its selected mutation control
then failed only that policy check, while R2.2 remained green. That completed full
suite passes the Windows check and every H4 review test.

The attempted whole-suite/lint rerun after `5436769751` was refused by the Linux
executor **before start** with `runner_draining`; it ran no tests or lint checks.
There was no local substitute. Verification of the final ownership follow-up is
therefore the 409-test host-runner/payload/storage corpus, package typecheck,
explicit compiler check of all three relevant test files, focused lint of both
changed files, the retained-header mutation control, the final plugin build, and
both final-built real provider-host probes. The full-suite baseline comparison
above is transparently from the immediately preceding revision, not a claimed
full-suite pass on the last source commit.
