# Independent cache review: signed-thinking hold, TS/Pi step 2b

Candidate: `4bcc18c37591add288f458428437514cfdb46754` (implementation
`836bf94548ee5cb30c20912fff5d7713914399e0`). Comparison baseline:
`325b5769edcaf9a4638ce6c4ef1715af19e65ee8`.
The candidate's last commit changes four Rust review fixtures for golden capture,
not the Rust engine. This delivery changes only this report and review tests.

## Recommendation: **no merge as described**

The process-local parking mechanism passes the exercised standing-permission,
combined-release, cancellation and pressure-wall checks. I found **no new wire or
bust-decision regression in the non-prefix-bound corpus**. However, the requested
claim that a pending signal with no held work drains normally is false for an
OpenCode subagent with kept thinking. Two added tests fail on both the baseline
and candidate. This is an existing defect exposed by this review, not a regression
introduced by the helper. Either address it separately or explicitly narrow that
claim before approving this slice.

The full Held contract also remains false, as the rollout explicitly anticipates:
30 strict TS/Pi audit failures have exactly the same names at the baseline and
pristine candidate. Restart-persistent release belongs to step 4. These facts do
not discredit the successful step-2b parking tests, but a green default audit is
not a claim that every held prefix is safe. The full five-host differential and
live OpenCode pure-replay gate were attempted but could not complete; the narrower
TS/Pi differential results below are not a substitute for those missing gates.

## Contract and review method

I read `docs/designs/signed-thinking-hold.md`, particularly the parked-trigger
rules at 514–550, release/durability at 612–653, §10 at 1302–1381, and the rollout
at 1697–1738. I also read the protected `ARCHITECTURE.md:48–108`, including the
Held pass type and the provider-validity exceptions to HARD and ride-only work.
The independent Rust review at `7f1c252f:docs/reports/signed-thinking-step2-review.md`
sets the useful bar: distinguish newly introduced regressions from existing
strict failures; compare decisions as well as wire bytes; test release exactly
once; and do not confuse a database reopen with a host restart.

All executable test/type/lint gates in this review ran on Linux with
`OPENCODE_DB` unset and throwaway `HOME`. Background jobs were joined with
`bash_watch`. The archive comparisons use the complete baseline and candidate
sources with the already-installed dependency directories linked into each.
The manifests and lockfile are identical; this is dependency reuse, not an engine
compatibility shim. An initial fresh baseline install failed DNS resolution and
was not counted as a baseline test execution.

## Finding: an empty OpenCode subagent flush retains standing permission

Reproducer in `packages/plugin/src/hooks/magic-context/signed-thinking-prefix-audit.test.ts`:

- `step2b review: v1 empty subagent flush leaves no standing signal under thinking`
- `step2b review: v2 empty subagent flush leaves no standing signal under thinking`

The subagent has no history render, four signed loop steps, **zero queued
operations**, no force pressure and no new cleanup request other than the empty
materialization signal. Its current request remains provider-valid. After running
that signal, `pendingMaterialization.has(sessionId)` is still `true`; the test
requires `false`. The failure is a retained flag, **not** a provider rejection or a
hung LLM request.

The reason is the unconditional `!freezeM0M1` requirement on the signal clear in
`transform-postprocess-phase.ts:2888–2893`, even when the subagent has no m0/m1 fold
to withhold. The new parking condition at 2319–2326 does not park this empty request
because neither a primary prefix fold nor a protected queued drop exists. Thus the
signal remains an unparked explicit-flush permission on later passes of the same
signed turn. The baseline already has the same clear guard. The review adds the
same essential reproducer to its baseline fixture without importing the new
parking accessor: **both baseline tests fail with Expected false / Received true**.
No baseline safety assertion was deleted or reversed.

A different case must not be conflated with this one: a primary flush with no
queued drops still requests prefix work and legitimately waits under a boundary.
Likewise, the existing Pi audit fixture supplies injection even when marked as a
subagent. Retaining that fixture's prefix request is not proof of an empty-request
bug. The new Pi empty-subagent probe explicitly disables injection; it drains
normally. Boundary-free primary empty signals also drain normally in all three
engines exercised here.

## Verdict by requested area

### 1. Non-prefix-bound and no-thinking compatibility — **observed compatibility passes; live-host gate incomplete**

For `claude-opus-4-6`, I captured the existing TS v1/v2 and Pi audits at both
revisions in default and strict golden modes. Every one of the **4,398 common
serialized audit message wires** is byte-identical, with **zero `bustedThisPass` differences**.
This corpus includes defer, SOFT/flush, HARD/first render, 85% force, 95% wall,
primary and marked-subagent scenarios. The candidate's 386 extra files per model
class are new parking fixtures, not evidence of baseline equivalence.

For sessions that never think, I separately held the audit driver constant with
`withThinking=false` on both source exports, retaining the prefix-bound model.
All **2,199 common default-mode message wires** and all bust flags match, with
no missing baseline passes and **zero observed thinking boundaries** in either
capture. This includes the same defer, flush, HARD and pressure scenarios, rather
than just treating the release of a thinking session as a no-thinking session.
Capture mode bypasses assertions so the full inventory can be recorded; the byte
and flag comparisons, not a green capture runner alone, are the evidence.

The TS/Pi subset of the existing differential comparator passes: **4,794 common
eligible wire files** compared. There are two thinking-only exceptions in Pi's
recomp/first-render release case; these are explicitly allowed by the comparator.
Considering *all* common prefix-bound files instead of only identity-eligible
ones gives six changed wires and four changed bust flags, at the first-render
release. These are release semantics, not rejected-class regressions. Some of
those release passes have no *current-turn* thinking but follow a held request:
“a session that never thinks” and “the boundary-free release of a thinking
session” are different compatibility domains.

The Pi pure-replay child was run against both complete source exports with one
fixed empty cwd and clock. Its six-pass serialized result, including the clear/
restart pass and prompt/tools captures, is identical: SHA-256
`c1f93d6529d367dd988e0eaa0b5681372f77b1139ab679e863ffb075f0c0ad27`.
This is a fresh comparison against `325b5769`, not just a comparison with the older
issue-485 fixture.

The live TS command
`bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only 325b5769 4bcc18c3`
could not boot the baseline: `Executable not found in $PATH: "opencode"`. No
four-pass live-host result is claimed. The five-host script
`scripts/signed-thinking-differential.sh 325b5769` likewise did not yield an
independent 7,006-wire result. After addressing throwaway-HOME Git trust and
using a clean, standalone clone inside the review scratch tree, the exact script
printed the correct BASE/HEAD SHAs, then failed its baseline
`bun install --frozen-lockfile`: **1,002 packages, `DNSResolveFailed`**. It never
reached audit capture or comparison. Cargo's version was 1.99.0
(5f94df478 2026-08-27); no Rust test pass is claimed from that attempt.

### 2. Held passes and the first safe release — **step-2b lanes pass; complete Held contract fails as before**

The existing standing-permission cases pass for held flush/force, held execute,
first render and TS drift. The combined-request cases keep the old queued drop,
retain a newly appended placeholder on a later boundary pass, release the queued
work and signal together at the next user, and assert that the immediate repeat
**does not bust again**. A fresh mutation that prevented boundary-free rearming
made each combined-release case fail specifically at release, not at setup.

This proves coexisting flush/force requests drain in one release pass. It is not a
stress test of simultaneously running transform invocations in separate hosts;
“concurrent requests” here means overlapping trigger obligations in the owning
process.

The stronger statement that nothing before the last kept thinking block changes
is still disproved by the strict audit. Its 30 baseline failures are listed below.
They include recomp/first-render replay, todo, processed image/stale-reduce lanes,
sentinel first application, cut/marker handling, restart release and the TS mixed
95% case. Their implementation steps remain later in the design. The first-render
parking case's green mutation-gate assertion does not prove the served head/cut
record is correct; that record is step 6, and golden `validatingRecord` remains a
constant `true`.

The TS restart fixture now also clears `resetDegradedCacheCount`, including its
new module-level parking map and pressure episode, and clears its heuristics map.
Previously it recreated the transform and emptied the signal sets but accidentally
left the new parking map alive. This is a correction to the restart simulation,
not a change to its restart-release expectations.

### 3. Process-local lifetime — **honest limitation, not durable release**

A process restart loses the two parking booleans, flush/held-execute signal sets,
first-render release signals, local pressure/heuristic bookkeeping and other
in-memory caches. It does **not** erase `pending_ops`, cached m0/m1, compartments,
m0 mutation-log rows, frozen drop/strip decisions, or persisted emergency samples.
The new `held_release` storage exists passively but step 2b does not use it.
Sharing means a common helper class, not a cross-host registry: OpenCode and Pi
each maintain their own session-keyed map.

Consequences:

- A pure held `/ctx-flush` or held-execute release permission can be **lost**.
  A queued drop survives but does not independently authorize a low-pressure defer
  pass, so it can wait for another genuine bust. The strict restart-flush failure
  exists on both revisions.
- A missing cached pair or durable m0 mutation is rediscovered on a safe pass;
  a surviving live force episode can reauthorize work because its local parking
  mask was lost. That can cause an **extra bust/cleanup opportunity** compared with
  an uninterrupted process. It does not make a fresh signed boundary safe.
- The parking loss alone is not proof of an edit before kept thinking: admission
  still protects tagged reductions and the prefix freeze still operates. However,
  not-yet-admitted lanes and the missing served-prefix record already permit such
  edits in the strict audit. Step 2b is not restart safety for the full wire.

**OpenCode serve + TUI:** the TUI is not a second transform owner. It calls
`requestFlush`, which forwards `"flush"` over RPC; the server-side handler adds the
three signals to the same live sets used by the context hook
(`v2/tui/index.ts:388–396`, `tui/data/context-db.ts:436–454`,
`plugin/rpc-handlers.ts:1734–1768`, `v2/hooks/context.ts:907–909,1986–2020`).
Restarting only the TUI therefore does not lose the serve process's parking;
restarting serve does. Two independent servers transforming one session would
have separate maps, not shared process-local parking. No live two-server race
experiment was performed.

**Pi `/reload`:** `session_shutdown` clears the current session with
`clearContextHandlerSession`; `/reload` also recreates extension/module state
(`pi-plugin/src/index.ts:2902–2908,2968–2993`,
`context-handler.ts:8319–8356`). It loses both the signal sets and parking map,
while durable database state is intentionally preserved. This is the same
flush-loss/rearm distinction as a host restart. It is a source/lifecycle trace,
not an interactive `/reload` capture.

### 4. Liveness — **no session hang observed; empty-subagent drain claim fails**

The new model probes perform three repeated held passes before switching models,
then prove eventual drain and a no-bust repeat for both primary and subagent
fixtures. Pi's effective `ctx.model` switch to Opus 4.6 releases immediately without
a new user. TS initially protects the model that issued the last assistant's
kept signatures (`transform.ts:1194–1215`), even when the live route changes;
it releases on the next real user. This conservative difference is existing
behavior, not a new parking regression. A switch between two prefix-bound models
is not a new safe boundary. A one-turn subagent can keep its work for its entire
lifetime; no timeout can make a signature-invalid edit valid.

The new pressure probes enter 85%, remain held at 90%, cross 95%, then release and
return to 20%. In TS the 95% wall executes the cleanup gate even if all edits are
held: the probe observes the heuristics map's `set`, rather than incorrectly
requiring `bustedThisPass=true` for a no-op pass. Pi can land tail work while the
old drop stays queued. A coexisting flush remains pending through that wall and
drains on release. A force parking bit may clear after qualifying reclaim spends
its episode; that is not consumption of the earlier queued drop. Existing tests
also prove force cancellation when pressure ends: no invented low-pressure bust,
and the opportunistic queued operation still waits.

The boundary-free primary empty-signal probes pass in TS v1/v2 and Pi. The
no-injection Pi subagent empty-signal probe passes. The two OpenCode empty-subagent
probes fail as described above. Their request returns promptly, but its unfinished
signal can remain standing forever within the single subagent turn. Thus the
specific drain/liveness claim needs narrowing or a fix.

### 5. The two non-red controls — **weak initial fixtures, subsequently repaired**

The task-giver supplied the untracked delivery record after repository research
could not locate it. Controls 7–8 removed the TS drift boundary guard but used
`appendCompartments` alone: no m0 mutation-log row existed, so neither v1 nor v2
reached the distinguishing drift condition. Those were **weak setups**, not
unreachable production mutations. The final fixture adds `queueM0Mutation` and
checks that its id exceeds the cached m0 id. Controls 9–10 then reddened.

I independently removed `!freezeM0M1` at the drift-watcher call and ran each
hardened fixture separately. Each run had exactly its named drift test fail
(Expected false / Received true for the pending signal), with all other tests
filtered out. The product file was restored from the staged live state and the
working diff returned to empty before any commit.

Pi has **no late TS-style m0 drift watcher** that sets a materialization/history
signal after injection. Its m0 mutation id is a `mustMaterializePi` input to the
prefix path; the shared TS helper is not called there. Therefore no Pi control
for that nonexistent watcher is missing. This does not prove every Pi HARD
admission path: those remain covered by the existing strict/HARD scenarios.

The original 13 controls exercised standing permission, first render, the repaired
TS drift guard and held execute. They did not independently target the *release*
half of concurrent drainage or empty-request drainage. This review adds a release
mutation: disabling rearming made v1, v2 and Pi's combined-request cases fail at
the release gate. The new empty-signal probes supply the missing behavioral check,
including the two genuine OpenCode failures.

### 6. Claude Code isolation — **passes for the step-2b delta**

Claude Code uses `claude-code-anthropic` in the Rust module, not these TS/Pi live
engines (`signed-thinking-hold.md:1705–1709`). There is **no Rust product-source
difference** between `325b5769` and this candidate. The only Rust difference is
four review fixtures becoming golden-aware. The two earlier Rust profile leaks
were **already corrected before this baseline**: `trigger_holds_enabled` excludes
Claude Code at `transform.rs:5354–5369`, guidance-date adoption allows that
excluded profile at 6283–6294, and pending tag/hint retention is conditioned on
the hold-enabled profile at 6110–6117 and 6183–6186. The baseline's two Claude Code
review fixtures at `signed_thinking_prefix_audit.rs:1153–1220` pin date adoption and
empty pending lists. Step 2b changes none of those product paths. Anthropic
provider selection in OpenCode/Pi is not the same as the Claude Code harness
profile. No new Claude Code wire or metadata behavior is claimed from the TS/Pi
subset capture.

## Gates and evidence

Tools: Bun **1.4.2 (744846f84)**, TypeScript **5.9.3**, Biome **2.5.1**.
Full suites were run through the repository's package `test` scripts. Failure
names were normalized only by removing runtime-duration suffixes, then compared
as sets; none of the existing failure assertions was rewritten.

| Gate | Baseline | Pristine candidate / reviewed tree |
|---|---|---|
| Plugin suite | 8,070 pass, 9 skip, 42 fail; 8,121 tests/760 files | 8,083 pass, 9 skip, the same 42 fail; 8,134 tests/761 files |
| Pi suite | 1,588 pass, 3 skip, 144 fail; 1,735 tests/166 files | 1,592 pass, 3 skip, the same 144 fail; 1,739 tests/166 files |
| TS/Pi default signed-thinking audit | 142 pass, 0 fail | Pristine: 156 pass, 0 fail; reviewed: 169 pass, 2 intentional failures (171 tests, 27,848 expectations) |
| TS/Pi strict signed-thinking audit | 112 pass, 30 fail | Pristine: 126 pass, the same 30 fail; reviewed: 139 pass, 32 fail (same 30 plus the 2 review tests; 27,597 expectations) |
| Review probes | Empty-subagent reproducer: 0 pass, 2 fail | 13 positive probes pass; the same 2 empty-subagent tests fail |
| `bun run --cwd packages/plugin typecheck` and Pi equivalent | Not rerun: no new product delta beyond the reviewed files | Both pass; TypeScript 5.9.3, five compiler invocations across the two package scripts |
| Package-local `biome check` on each changed test file | Not applicable | Both pass, 1 file each, Biome 2.5.1; TS comment indentation was fixed after its initial formatting failure |
| TS/Pi capture, two model classes × two modes | 142 tests per capture, all successful in capture mode | 156 tests per capture; comparator 4,794 common eligible wires, PASS |
| Pi pure-replay child | 1 test; six captures | 1 test; six byte-identical captures |
| Hardened TS drift mutation | Not applicable | v1 and v2 each 0 pass, exactly 1 intended failure |
| Combined release mutation | Not applicable | v1, v2 and Pi each 0 pass, exactly 1 intended failure |

The normalized full-suite failure-set digests are identical between revisions:

- Plugin, 42 names: `02af4739b580d8efa4bbb732ce1af79e02c98c11e9a838f312169fc507802899`.
- Pi, 145 distinct failure/error diagnostic names including a nested-run diagnostic outside the
  top-level 144-failure tally:
  `146cd4840c07efd3aead630a554cb003af5956082e976e73807dce0a37f3c56d`.
- Strict audit, 30 names: `b10ba382cac26ed565946c0abb49083d1ada9b9b667baa078f124ea729f28eb6`.

These are actual red suite results, not healthy baseline claims. Examples include
LKG/sidebar/status assertions, a WASM build's missing `onnxruntime-web/webgpu`, and
Pi historian/tool/dialog tests. New and resolved failure-name sets are both empty
for each pristine comparison. Package dependencies were reused only after the
fresh baseline install failed; no manifest/lockfile was changed.

The compilers and scoped lint checks are authoritative for the changed test
files. AFT inspection was partial: its checkout call graph was unavailable and
its analyzer could not find Biome, so no clean AFT diagnostic result is claimed.
The Sidekick comment review flagged the empty-subagent explanation; it was
rewritten to name the absent synthetic history head and queued message drops.

### Existing strict failure names

Each suffix below is under `signed prefix audit:`. OpenCode rows apply separately
to `OpenCode 1 TS mode` and `OpenCode 2`.

| Scope | Failing suffixes |
|---|---|
| OpenCode primary (10 each) | `m[0]/m[1] re-render after a recomp clears the cached pair`; `synthetic todo`; `processed image strip`; `stale ctx_reduce strip`; `frozen-sentinel first application`; `release survives a restart: /ctx-flush`; `mixed pass: a 95% tail reduction on a parallel tool arc lands while an older drop stays held`; `prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop`; `prefix cut moved by a compartment rewrite that keeps the cached pair: defer pass at a new user turn`; `compaction-marker summary retired by a bust: mid tool loop` |
| OpenCode subagent (2 each) | `stale ctx_reduce strip`; `frozen-sentinel first application` |
| Pi primary (6) | `m[0]/m[1] re-render after a recomp clears the cached pair`; `synthetic todo`; `frozen-sentinel first application`; `release survives a restart: /ctx-flush`; `prefix cut moved by a compartment rewrite that keeps the cached pair: mid tool loop`; `prefix cut moved by a compartment rewrite that keeps the cached pair: defer pass at a new user turn` |

The review-only failing tests intentionally remain red. They pin the empty
OpenCode subagent request rather than weakening the default audit's contract.
The positive model/pressure/empty-signal probes remain ordinary assertions, not
new `EXPOSED` allowances. The report does not propose product changes outside the
requested review fence.
