# `/ctx-rescore` s4 correctness review

Reviewed range: `cc8617ece9f2fa51c8fb34eb542b570e7400877c..42340c6014be6a794f73f64a68dd43ff6912b2f5` (the fourth slice: durable score jobs and hidden model-execution adapters for OpenCode and Pi), against `docs/designs/compartment-rescore.md`.

**Result: three findings, proved by four failing assertions.** No product fix is included. The review file is `packages/plugin/src/features/magic-context/rescore-s4-review.test.ts`. Its expected-to-fail assertions run only with `MC_RESCORE_S4_REVIEW=1`, so the ordinary suite remains independently runnable.

## Findings

### F1 — P1: cleanup deletes the paid completion before durable payload staging

**Location:** `packages/plugin/src/hooks/magic-context/rescore-driver.ts:105-126,207-219`; `packages/plugin/src/hooks/magic-context/compartment-runner-historian.ts:314-326`; `packages/plugin/src/shared/child-session-teardown.ts:46-51`.

**Failing test:** `rescore-s4-review findings > F1 OpenCode completion survives a crash before payload staging`.

`createOpenCodeRescoreCarrier.complete()` collects the result, then awaits `executor.close()` in its `finally` before returning the text to `driveRescore()`. The driver only persists that text afterwards. On OpenCode 1 with the default `keep_subagents=false`, close deletes the finished child immediately. There is consequently a crash window with an admitted spend record, no staged payload, and no recoverable child, even though the provider finished successfully.

The test uses the real V1 executor and teardown, with an in-memory mock host whose `session.delete` actually removes its durable message. It stops exactly between `complete()` and `persistPayload()`. After lease expiry, the service grants a new owner generation and recovers the job without another prompt. Expected: one revision and a settled attempt. Actual:

```text
{ attempt: "abandoned", revisions: 0 }
```

The already-paid answer is lost; explicit resume must buy another completion. The design requires recovery across the post-completion crash boundary. This is not a demand for an automatic paid recovery call: cleanup must not destroy the recovery source before durable handoff. The concrete reproducer is for OpenCode 1; OpenCode 2 uses the same close-before-persist ordering, but its asynchronous removal timing is not claimed as an independently reproduced failure here.

### F2 — P1: takeover/resume can overlap the original paid Pi call

**Location:** `packages/plugin/src/hooks/magic-context/rescore-driver.ts:151-170,253-261`; `packages/pi-plugin/src/rescore-carrier.ts:48-52`; `packages/plugin/src/features/magic-context/rescore-service.ts:957-979`.

**Failing test:** `rescore-s4-review findings > F2 takeover and resume do not overlap a still-running Pi paid call`.

The Pi carrier's `recover()` always returns null, including for an active run. Recovery treats null as unrecoverable, abandons the attempt, and releases its reservation. Resume then admits another paid attempt. Neither path interrupts the old carrier. Generation fencing rejects the old result when it eventually arrives, but does not prevent overlapping inference/spend.

The test holds the first mock provider completion open, advances the lease clock past expiry, takes over through a second SQLite connection to the same file, and explicitly resumes. The mock provider honors abort signals; no abort is delivered before the second call. Both driver promises are joined and both database handles closed. Actual:

```text
paid calls=2; concurrent calls=2
Expected maximum concurrent calls: 1
```

This models lease expiry while an old inference remains alive, not two accepted publications. Stale publication fencing itself works. Recovery must distinguish active from terminal/unrecoverable work, or establish termination before releasing that work for retry. The service-process CAS control below also demonstrates that the defect is not a missing SQLite transaction around takeover.

### F3 — P2: recovery bypasses frozen-model and length-cap validation

**Location:** `packages/plugin/src/hooks/magic-context/rescore-driver.ts:94-102,129-130,159-169`; `packages/plugin/src/hooks/magic-context/compartment-runner-historian.ts:267-279,282-309`; `packages/plugin/src/v2/hidden-completion.ts:792-813`.

**Failing tests:**

- `rescore-s4-review findings > F3 recovery rejects a length-capped score completion`
- `rescore-s4-review findings > F3 recovery rejects a completion from outside the frozen model`

The ordinary completion path checks the actual provider/model and rejects length-capped output. The recovery adapter reduces `HiddenCompletion` to `.text`, dropping those checks and the evidence needed to perform them. Recovery then validates only the score JSON and publishes it. V2 additionally omits actual provider/model from its recovered `HiddenCompletion`.

Each reproducer uses the real V1 durable-message reader, valid complete score JSON, and either `finish=length` or `modelID=other-model`. Recovering each saved completion makes **zero prompts**, yet inserts a score revision in both cases:

```text
Expected revision count: 0
Actual revision count:   1
```

Thus recovering the same completion accepts an answer the normal completion path refuses. For the different-model case, the revision is also attributed to the frozen requested model rather than the model recorded on the recovered answer. Preserve and validate completion provenance/termination across recovery before publishing. The two failing tests exercise V1; the shared recovery adapter and the V2 metadata omission are source observations, not a separate V2 failing-test claim.

## Containment and cache controls

The controls did not reproduce a rescore-specific way for background tool calls to bypass the restrictions.

- **Actual OpenCode 2.0.22 host:** the host control reads the registered `rescore` agent and proves user `edit: allow` appears after the agent's wildcard deny. `client.permission.create` then returns `allow` without child-session rules and `deny` with the rules from the real `childCreateInput`. This is a host decision, not a test-written permission evaluator. An unstarted rescore prompt reaches no mock-provider request. Test: `CONTROL real OpenCode2 user edit allow loses to rescore session deny and unstarted turn makes no model call` — **passed**.
- **In-process containment:** the control refuses foreign and owned-but-unstarted rescore turns before its simulated provider dispatch; denies read/edit/shell/memory and arbitrary extension tools for the empty allowlist; and verifies an owned shaped run has zero tools. The production `execute.before` hook is wired at `packages/plugin/src/v2/hooks/context.ts:773-785`. The existing foreign/checkpoint tests also passed.
- **Unshaped retry:** `CONTROL OpenCode2 unshaped rescore refuses without a second model or tool-enabled child` uses the real V2 executor and carrier. A host that skips shaping produces a typed terminal refusal, exactly one prompt/child, and deny-all session permissions — **passed**.
- **Directory isolation:** the unchanged dreamer trigger checks the instance's directory and workspace before opening storage or scheduling (`packages/plugin/src/v2/hooks/dream-trigger.ts:28-41,65-71`); foreign hidden-agent turns are refused by `HiddenChildHook.apply` (`hidden-child.ts:496-505`). The host-level test covered one directory; the full end-to-end test of dreamer scheduling across two directories was not rerun. No claim is made that missing host location read-back is independently defended by this review.
- **Cache neutrality:** `CONTROL publish and undo leave seeded cache bytes epochs and materialization unchanged` seeds actual m[0]/m[1] bytes, served boundary text, held-release state, materialization timestamp, project epoch 17, an existing mutation-log entry, history version 23/rewrite version 7, and migration-seeded history. It snapshots the base/cache tables across preview, confirmation, publication, undo and receipt redelivery. Effective scores become 42 and undo restores 73, while the entire frozen state stays unchanged — **passed**. S4 publication/undo write the sidecar and job tables, not base compartments or primary caches. Natural rebuild/TS/Pi/Rust projection was already in slices 2–3 and is not re-reviewed here.
- **Historian preservation:** the V1 transport tests, including the ordinary historian async/error/timeout cases, passed. The shared runner diff keeps the historian/historian-editor output-cap and error paths; sampling changes are rescore-specific and the extra completion fields are additive. This review did not repeat a full golden served-wire historian comparison against the pre-s4 executable.
- **Data integrity:** malformed numeric scores/extra keys/duplicate handles are rejected; a trigger aborting the second revision proves that the first revision, all selections, and settlement roll back together. Removing the trigger permits the same staged payload to publish — **passed**.
- **Cross-process coordination:** two independent Bun service processes, one OpenCode and one Pi, race overlapping confirmed jobs against a shared file with the context-store busy timeout/WAL policy. Exactly one admits. Two OpenCode processes racing takeover of one stale generation produce one winner; Pi cannot take over the OpenCode-origin job — **passed**. These are actual independent job-service processes, not full OpenCode/Pi application boots.

### Cache guard non-vacuity

After staging the live review file and the unmodified service, `git diff --stat` was empty. To prove that the cache guard detects forbidden base-table writes, a temporary mutation marked **NON-VACUITY BREAK** added `UPDATE compartments SET importance = ?` to publication:

```text
packages/plugin/src/features/magic-context/rescore-service.ts | 2 ++
1 file changed, 2 insertions(+)
```

Running the controls caused **only** `CONTROL publish and undo leave seeded cache bytes epochs and materialization unchanged` to fail: importance changed 73→42, history version 23→24, rewrite version 7→8. The other four runnable controls (foreign/unstarted/all-tools, malformed/atomicity, independent-process reservations/CAS, unshaped/no-fallback) passed; the native-host control was explicitly skipped on that Linux run. Restoring with `git checkout -- packages/plugin/src/features/magic-context/rescore-service.ts` and touching that path produced an empty unstaged diff. Those controls passed on the final unmutated run. No product mutation is delivered.

## Disclosed environment failures: both pre-existing

Reran the two exact test files on Linux at both the s4 head and the **pre-s4 range base** `cc8617ece9f2fa51c8fb34eb542b570e7400877c`. The pre-slice tests ran from a temporary source tree containing `git archive` copies of that commit's packages, scripts and manifests, with the installed dependencies unchanged. No parent checkout or live store was read. Both revisions produced **9 pass / 2 fail / 11 tests**, with the same failures:

| Test | Same failure on pre-s4 and s4 head | Classification |
|---|---|---|
| `Node WASM Transformers fixture > builds with real fs and persists a model for offline reuse` | `Cannot find module 'onnxruntime-web/webgpu'` from the temporary `transformers-node-wasm.js` bundle | Pre-existing temp-bundle resolution failure |
| `doctor repair-db > backs up and salvages readable rows from a genuinely corrupted SQLite page` | `.recover` replay rejects `sqlite_sequence`, `sqlite_master`, and `sqlite_stat1`; expected exit 0, received 2 | Pre-existing Linux SQLite salvage incompatibility |

The matching pre-slice failures establish that neither the temporary WASM bundle failure nor the SQLite salvage failure was introduced by the durable-job slice. Neither was repaired here.

## Reproduction and verification

Package-suite environment setup: leave `OPENCODE_DB` unset because it selects an OpenCode host database; the package tests manage their own database fixtures.

```sh
root="${TMPDIR:-/tmp}/magic-context/rescore-s4-review"
mkdir -p "$root"/{data,config,state,runtime,storage}
unset OPENCODE_DB
export XDG_DATA_HOME="$root/data" XDG_CONFIG_HOME="$root/config"
export XDG_STATE_HOME="$root/state" XDG_RUNTIME_DIR="$root/runtime"
export MAGIC_CONTEXT_STORAGE_DIR="$root/storage"
file=packages/plugin/src/features/magic-context/rescore-s4-review.test.ts
MC_RESCORE_S4_REVIEW=1 BUN_JSC_useOMGJIT=0 bun test --timeout 30000 "$file"
```

Bun **1.4.2**: **5 pass / 1 skip / 4 intentional failures**, 72 assertions, 10 tests in one file. The real OpenCode 2 permission-precedence/unstarted-turn test is separately enabled with `MC_RESCORE_S4_HOST=1`:

```sh
MC_RESCORE_S4_HOST=1 BUN_JSC_useOMGJIT=0 bun test --timeout 60000 "$file" -t 'CONTROL real OpenCode2'
```

Bun **1.4.2**, OpenCode **2.0.22**: **1 pass**, six assertions. It ran locally against the prepared native build. Every host HOME/XDG/config/state/runtime/storage path and its resolved OpenCode database was beneath the throwaway root. `lsof -p 9766 -Fn` listed only these `.db` files and their WAL/SHM handles:

```text
root=/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/rescore-s4-review/host-PRIUwk
<root>/XDG_DATA_HOME/opencode/opencode2.db
<root>/storage/context.db
```

The host was stopped and the fixtures removed. Only the local mock provider was configured. Live stores were never opened, migrated or read, including for baseline comparison.

Additional verification:

- `bun run --cwd packages/plugin typecheck`: **passed**, TypeScript **5.9.3**, all three commands (retina build-project check, plugin no-emit check, scripts-project check). This is the authoritative type diagnostic check; the optional editor inspection was partial because it had no current analyzed-file or callgraph view for this checkout.
- In `packages/plugin`: `node_modules/.bin/biome check src/features/magic-context/rescore-s4-review.test.ts`: **passed**, Biome **2.5.1**, one file checked, no fixes needed on the final run.
- Focused existing regressions, plus the review file with its flags unset: **230 pass / 10 deliberate review skips / 0 fail**, 931 assertions, 240 tests in nine files. Command: `BUN_JSC_useOMGJIT=0 bun test --timeout 30000` with `rescore-service.test.ts`, `rescore-s4-review.test.ts`, `rescore-driver.test.ts`, `v2/hidden-completion.test.ts`, `v2/hooks/hidden-child-foreign.test.ts`, `v2/hooks/hidden-child-checkpoint.test.ts`, `v1-hidden-executor-prompt-async.test.ts`, Pi `rescore-carrier.test.ts`, and Pi `subagent-runner.test.ts` at their repository paths.
- Heavy/focused Linux test jobs used `runon: linux,8c`. No package manifest, lockfile, architecture document, generated build artifact, or product source is changed by this delivery.
