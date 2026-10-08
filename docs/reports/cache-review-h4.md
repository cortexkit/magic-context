# Independent correctness review: fast-Rust H4

## Scope and verdict

Reviewed commit: `b604dfe92cc888f1f615a5ee6fcb888ad888fefd` (11 files).
Only this report and
`packages/plugin/src/hooks/magic-context/host-runner/opencode-adapter-review.test.ts`
are added. No implementation or delivered test is changed.

**Verdict: seven blocking findings and four should-fix findings.** The independent
suite has **23 intentionally failing tests and six passing controls**. The delivered
H4 suite has **47 passing tests**. Its green adapter-level tests do not establish
that the managed array is the array the host actually sends.

Authorities: the folded campaign document at
`.cortexkit/alfonso/task-outputs/consult-ct_00000000-0000-41b8-98dc-36ef49802db8/owner-loop-round-0.md`,
D1, D2.1–D2.9, D3.8, A1–A10 (also A11), H4, and the supplied owner rulings.
`ARCHITECTURE.md`'s protected cache invariants govern SOFT+ replay, natural HARD
triggers, and the rule that deferred work cannot originate a bust.

### Evidence boundary

The tests run the actual adapter, H1/H2 record persistence, H3 client, wrapper,
and, where relevant, the actual OpenCode 2 payload/trim functions. The module is
a recording fake. State lives in SQLite `:memory:`. Package test preload redirects
implicit storage opens and both XDG homes to a throwaway tree. The live stores
and live configuration were **never opened, read, written or migrated**.

The fake records encoded transport requests, applies hook operations to retained
messages on rebuilds, and injects named answer/error sequences. The ordinary
bootstrap control retains a raw tail, rather than hiding every message in a view.
The full-request seam represents the existing handoff, not the real Rust engine.
R8 composes the actual trim and adapter with the same runner-id assignment used
at `v2/hooks/context.ts:1763–1769`; R11 composes the real project security guard
and schema used by configuration loaders. Neither claims a complete
`registerContext` or config-file-loader end-to-end run. R9 compares the same
injected BUSY exception at the legacy handoff and the adapter handoff through
the real wrapper; it does not manufacture a real SQLite lock.

**No real ck-mc corpus, running module, SUBC service, provider, OpenCode process,
performance gate, or 24-hour canary was exercised.** Those remain integration
gates. Byte examples below describe the fake's native/message text, not a claim
about actual model tokenization or real ck-mc rendering.

## Findings

### R1 — blocking: managed output replaces the array instead of publishing in place

Tests:

- `R1 v1: provider publication updates the array retained by the host`
- `R1 v2: payload commit sends provider bytes, not the pre-transform projection`

Sequence: bootstrap A; present known A with changed host text `host edit`, and
append B. The hook answers prepend `§2§ ` to B. On OpenCode 1 keep the original
host messages array, and call the real wrapper. On OpenCode 2 call the real
`adaptPayload`, run the adapter on that object, and call its `commit()`.

Expected host text bytes: `["A", "§2§ B"]`. Actual host/committed bytes:
`["host edit", "B"]`. The `output.messages` property correctly contains the
managed bytes; the host-retained array does not. The v1 assertion compares the
entire JSON arrays, not just the tag string. Both controls checking the managed
property pass before the host publication assertions go red.

Cause: `run` assigns `output.messages = assemble(...)` at adapter lines 1008 and
1169; `recoverOutput` does the same at 1226. The old Rust adapter explicitly
splices into the host-retained array (`rust-mode-transform.ts:544–552`). The v2
payload's `commit()` closes over its original `messages` array, not the replaced
property. Thus the problem is deterministic even without a real v1 host.

Violations: owner ruling 3 (never send unmanaged provider history), D2.2.1,
D2.2.5, D2.3.9, A1/A3, and ARCHITECTURE's SOFT+ byte replay invariant. A changed
known host message can reach the wire outside any declared rebuild. Frozen-raw
unavailability does not repair this publication boundary.

### R2 — blocking: OpenCode 2's projected tools have no part identity

Test: `R2 v2: a completed projected tool has a usable subject_part and reaches post_tool`.

Sequence: bootstrap A; append an actual v2-shaped assistant tool-call and its
tool-result carrier (`call`, `read`, output `result`); project with `adaptPayload`.
The resulting native tool is terminal, but has `callID` and no `id`.

Expected: successful post_assistant/post_tool calls with a stable subject_part,
and a served tool result (the fake's expected tagged output is `§2§ result`).
Actual: **no request is served**. `providerSubjects` throws `Terminal tool has no
part id` at line 121; `run` wraps it in `EmergencyFailClosedError`. The failure
occurs before any tool hook, not at a fake-provider assertion.

The existing multipart H4 tests construct OpenCode 1-shaped `id` fields even for
their v2 fixture. The real `payload.ts` `nativeTool`/`convertedTool` functions do
not provide those fields.

Violations: D1.4, D2.3.6, A9, H4's subject_part derivation, and A3's streaming-free
tool-loop corpus. This blocks an ordinary v2 tool loop after provider admission.

### R3 — blocking: an invalidated covered revert is not retried

Tests, for both `H4 review v1` and `H4 review v2`:

- `R3: invalidated covered revert retries on the next pass after noop`
- `R3: invalidated covered revert retries on the next pass after transport error`

Sequence: apply a view covering A,B,C; restart the host adapter; revert to A,B.
The revert step either answers noop or has a transport error. The first turn
correctly refuses, and the durable view is invalidated. Make the module healthy
and repeat A,B.

Expected: a new step with `prefix_rebuilding: {reason: "revert"}` on the descended
lineage, then A,B bytes with no C. Actual: **no retry step and no served bytes**;
assembly refuses the still-invalidated view. The red count is expected 3 total
steps, received 2 (bootstrap plus the failed revert). This is not unsafe replay;
it is a persistent availability failure until some unrelated opportunity occurs.

Cause: `reason` requires `reverted` on the current scan at line 1113. The previous
pass already truncated the record, so the repeat no longer detects a revert.
View invalidation itself is not a rebuild opportunity in lines 1137–1147.

Violations: D2.6's explicit “next pass retries the rebuild,” D2.7 refusal recovery,
A5. The delivered test only verifies that the second offline pass also refuses;
it never checks that a recovered module receives another revert request.

### R4 — blocking: every applied SOFT view consumes the TTL HARD trigger

Test for both hosts: `R4: a SOFT flush must not consume a later live-TTL cold decision`.

Sequence (milliseconds): hard baseline at 1000; last response at 2000; TTL is an
explicit 5m override. At 4000 apply a SOFT flush view, leaving
`cachedM0MaterializedAt = 1000`. Edit the live user override to 1m using the real
issue-624 resolver; at 64001 repeat the same input.

Expected: idle is 62001 ms, strictly over 1m, and `2000 > 1000`; a cold step must
be sent. Actual: no step (`[]` instead of `["cold"]`). Outgoing bytes remain the
old view, rather than the replacement requested at this natural HARD opportunity.
The test independently verifies the full-path cache-expiry predicate is true.

Cause: line 643 sets adapter `metadata.materializedAt = now()` for **every**
applied view, including SOFT ones. Lines 1126–1129 take the maximum of that value
and the real HARD materialization clock. The adapter consequently evaluates
`2000 > 4000`, suppressing cold. The supplied `providerCold` helper alone is
correct; its unit corpus never exercises this second, incorrect clock.

Violations: owner ruling 2, D2.5, and ARCHITECTURE lines 100/104 plus the
full-path self-consuming check in `inject-compartments.ts:1871–1880`. A SOFT view
is not proof that m0 was materialized. The four passing cold/bootstrap controls
include correct strict-boundary and repeated-cold self-consumption cases.

### R5 — should-fix: failed-message burns arrive too late for the next hook in the pass

Test for both hosts: `R5: burn a partially failed message before the next message's cadence decision`.

Sequence: bootstrap A; append B (assistant text plus two tools) and C (assistant
with another tool) in one pass. Text hooks pass; B's first post_tool succeeds and
its second post_tool is unavailable. The fake tracks unburned pending tool
answers and uses a two-tool cadence to expose the next tool's decision on C.

Expected bytes: B freezes entirely raw, C's output stays `C-result` because B's
discarded tool answer does not count. Actual: B is raw, but C's tool output is
`C-result [cadence]`.
`[cadence]` is the fake's visible sentinel, not the production reminder wording.
C's request carries no B subjects to burn before cadence. B's burn list only
enters `record.unserved_subjects` in `commitEntries`, after **all** hooks.

The operations for C are then durable first-serve bytes. Burning B on the next
pass cannot remove that erroneous C reminder without another prefix change.

Violations: D2.4's later-call burn semantics, D3.2's burn-before-cadence order,
A9's partial-failure cadence guarantee, and H4/A3 hook parity. This is a composed
host-ordering proof using the ruled cadence inputs, not a real-module cadence run.

### R6 — should-fix: an explicit switch-back never re-enters the provider pipeline

Test for both hosts: `R6: deliberate full_request to provider switch-back bootstraps again`.

Sequence: provider bootstrap A; deliberately set full_request, restart, and
serve A. Confirm durable `rollback`. Deliberately set provider and restart again.

Expected: staged bootstrap again; after a durable final view, provider serving
resumes. With this zero-divergence fixture the A text bytes can remain identical.
Actual: Setup count stays 1 instead of 2; A continues through full_request
forever. Line 984 routes every durable exit to fallback without recognizing a
deliberate switch. There is no reset/switch-generation path in H4.

Violation: D2.9's “Re-entry happens only by a deliberate switch, which bootstraps
again,” coexistence, A11 rollback tested both ways. This is **not** a request for
automatic re-entry after a safety exit, nor for bypassing the explicit module
drop required after record/foreign/history loss. The case is an intentional
configuration switch after a normal rollback.

### R7 — should-fix: the v2 front projection reads all known content every pass

Test: `R7 v2: ordinary projection does not read the content of a known message`.

Sequence: bootstrap projected A; present known A and new B in the next ordinary
pass. Count getter reads of A's actual v2 `content`; call `adaptPayload` as the
context hook does unconditionally, then run the adapter.

Expected: zero known-content reads, one appended-message hook. Actual: the one
hook control passes, but A's content getter is read **3 times**, expected 0.
Outgoing text need not differ in this case; the prohibited work is the defect.
`adaptPayload` scans all content for tool/result/media bridges and clones each
part before the adapter can perform its id-only scan. `rememberHostMedia` is
another unconditional host-side walk; the counter deliberately measures only
the payload projection, so it is a lower bound.

Violations: A2's host counter, D2.2.1, D2.3.2/650 cost model, H4 id-only admission
integration. The core adapter's throwing-parts test passes because it bypasses
this v2 host stage. No retained-tail timing or 1k/8k scaling claim is made.

### R8 — blocking: v2 front trim can drop an unseen race message before the id scan

Test: `R8 v2: front trim cannot discard an unknown race using canonical store ordinals`.

Sequence: bootstrap and cover A,B,C at runner ordinals 1,2,3; record a compartment
covering 1–3 and a boundary at C. Present `[A,X,B,C]`, where X is a newly persisted
message sorted into the middle. The recording raw source's canonical ordinals
are A=1, X=2, B=3, C=4. Assign available runner ordinals as the v2 hook does,
then call the actual trim, projection, and adapter.

Expected native output ids/text: `[A,B,C,X]`, with X appended once at runner
ordinal 4; no canonical-store ordinal read. Actual: `[A,B,C]`; **X disappears**
before the adapter can see it. The trim falls back to canonical store ordinals
because X has no runner ordinal. It judges A,X,B covered by 1–3 and removes them.

Violations: A4 race soundness, D2.2.2, D2.3 id scan/admission order, D2.1's single
runner ordinal space and explicit v2 no-store-read rule, A2. The delivered trim
test gives every prefix row a known runner ordinal, masking this case. This
composition test does not require access to an actual OpenCode store.

### R9 — blocking: setting-off sessions inherit provider error reclassification

Tests for both hosts and both absent/full_request settings:
`R9 <host>: <setting> setting preserves legacy BUSY replay for a never-provider session`.

Sequence: a different session has a durable provider row, so H4 allocates its
adapter even when provider is off. The target `full-only` session has **never**
used provider. Seed its valid legacy slot with `MANAGED Q`; present Q and inject
the same `StorageBusyRefusalError` at the full-request handoff in both lanes.

Expected native JSON bytes: the valid managed LKG prefix. The legacy control
actually returns that prefix through the real wrapper. Actual via H4's adapter:
**no outgoing request**, `EmergencyFailClosedError: Provider record cannot safely
serve this turn`, caused by the same BUSY exception. Both settings reproduce it.

Cause: `transform.ts:696–702` allocates an adapter if **any session** has a row,
and lines 1048–1049 send setting-off Rust calls through it. The fallback awaits
the legacy handoff inside `run`'s provider catch. Lines 1193–1205 wrap a legacy
BUSY exception as an explicit provider refusal, so the wrapper cannot execute
its old LKG replay. The real full-request adapter has explicit
`StorageBusyRefusalError` throw sites; this is not an impossible seam result.

Violation: owner ruling 1 and coexistence's default/full_request preservation,
including `messages-transform.ts`. Healthy empty-store setting-off tests pass;
they miss this cross-session/error case. Full equality of **all** database writes
against the pre-H4 implementation was not measured; the changed served-versus-
refused result already disproves unchanged behavior.

### R10 — should-fix: ordinary state saves serialize the retained Setup head twice

Test for both hosts: `R10 <host>: a zero-append pass never serializes the known Setup head`.

Sequence: Setup supplies its valid empty-range initial head with a 10k-character
m0 body; the final bootstrap view retains that head and A. Instrument only the
head's JSON serialization. Reset the counter and repeat A with zero appends.

Expected: same served bytes by reference, zero known-head serialization.
Actual: same bytes, **2 serializations**, and no module call (control passes).
`stateFor` serializes `metadata.setup.initial.replacement` and
`metadata.initial.replacement` on every ordinary `save` at line 276. This also
rewrites those large duplicate bodies in `host_runner_state.setup_json`.

Violations: A2 zero serialization of known content, D2.3 cost model, D2.8 small
ordinary state write and P3's appended ingest/ops + 1 KiB logical-payload limit.
This is not a bootstrap/restart cold-path exemption or a state-sync background
delta. Empty initial replacements in the delivered fake conceal the work.

### R11 — blocking: untrusted project config can enable the user-only pipeline

Test for both hosts:
`R11 <host>: project config cannot opt a user-default full_request session into provider`.

Sequence: the user has rust mode enabled but has **not** opted into provider;
project raw config supplies `rust_pipeline: "provider"`. Run the actual
`stripUnsafeProjectConfigFields` guard and schema merge, then the recording
adapter with the resulting pipeline choice.

Expected: full_request remains selected; zero Setup calls and current full-path
bytes. Actual: the project key survives, the effective choice is provider, and
Setup is called once. The first assertion fails on expected 0 versus received 1.
The fake can happen to return the same A text at bootstrap, but the new pipeline,
provider writes and rebuild are not a user-authorized setting-off pass.

Violation: folded spec's Standing constraints “user-level only” pipeline choice,
D2.9's deliberate switching boundary, H4's opt-in scope. `transform_mode` is
intentionally project-allowed in existing policy, but that does not override the
new field's explicit **user-only** specification. H4 adds a schema/default and a
developer-doc exclusion, not project-tier protection for `rust_pipeline`.

## Checks that found correct behavior (within the stated boundary)

| Question / pass class | Evidence and result |
| --- | --- |
| Healthy setting-off / compaction off | Delivered absent/full_request cases use the legacy full adapter through the wrapper and pass; default is full_request and DEV_ONLY_KEYS excludes rust_pipeline. Rust/provider plus compaction disabled routes to TS and does not Setup. This does not excuse R9/R11. |
| Core ordinary replay, race, hole, multi-turn raw revert | New controls for both harnesses keep A,B,C,D, append X/E despite interior insertion and a B hole, preserve the prefix on another pass, then revert several turns to A,B,Y. Descended hook watermark is 2. No duplicate X or spurious exit. After restart a throwing known-content accessor is not read and no provider call occurs. These are core adapter properties, not host-output identity after R1. |
| Ambiguous suffix, foreign history, sticky safety exit | Delivered tests distinguish race-only ambiguity and interior holes; exits are durable and a later ordinary pass does not re-Setup. Foreign history is not spliced. R6 concerns a separate deliberate switch, not the safety-exit control. |
| Bootstrap stage and wait termination | New controls inject an early continuation-page view and a final-page wait. Both hosts remain inactive, use the current path, and stop after 1 and 2 requests respectively. No incomplete view is served from the record; no wait polling loop occurs. Delivered timeout/restart tests resume a durable cursor with a fresh fence; continuation-base, m[0]/m[1] omission and unresolved-message decline controls pass. |
| State sync / hooks / historian | Delivered tests verify id classification before sync, shared ingest bytes for assistant text and two distinct tool parts, final-hook pass_complete, and host historian claim/complete on both harnesses. The v2 tool inputs in those adapter tests are native-shaped, not actual projected tools (R2). Real off-path trigger parity/barrier interleavings remain M3/M5 and corpus gates. |
| TTL resolution helper | Real issue-624 resolution and delivered frozen-default/live-edit corpus pass. Strict > at 60,000 ms and self-consumption after a newer response pass in the new controls. R4 is specifically the adapter's extra materialization clock, not parsing or user-edit resolution itself. |
| Refusal / unavailable / store-ahead | Delivered unavailable hooks freeze raw and steps preserve a non-invalidated view; wrapper skips old-slot reads/capture/replay for active records. Hook/step store-ahead errors refuse with MC-C13 without park/exit. Gap resend is bounded and repeated identical gaps exit. These checks pass on the managed property; R1 still prevents claiming the host sends it. Covered invalidation refuses rather than leaking reverted bytes, but does not recover (R3). |
| Module-ahead conflict | Delivered hook and status invalid_params cases descend once through the previously committed frontier and re-hook. Fresh-lineage ids differ and watermarks are clamped. No resync loop was seen with the recording fake. Actual tag burns and Rust message-log ingest-once need the later real-module gate. |
| Encoded caps / view fencing / marker | Delivered oversize status exits before hooks; H3 measures encoded requests. Intermediate bootstrap views and final waits are rejected in the new controls. Markers are elided without ordinals/divergence; marker movement only follows applied coverage. Known-prefix v2 trim control passes; an unknown interior row breaks that guarantee (R8). |
| Divergent rollback namespace | Delivered tests select a non-empty fresh full-request namespace only after divergence, reuse it on later passes, and persist/log the exit. Source inspection confirms the namespace wrapper changes module session identity without changing host session storage. The full engine's one-rebuild byte stability and resolver compatibility were not established by that callback-based test. |

## Reproduction and verification

From `packages/plugin`, Bun **1.4.2** (`744846f84`):

```sh
bun test src/hooks/magic-context/host-runner/opencode-adapter-review.test.ts
# Observed against H4: 6 pass, 23 fail, 94 expect() calls, 29 tests.
# Exit 1 is intentional; every red test names a finding above.

bun test src/hooks/magic-context/host-runner/opencode-adapter.test.ts
# 47 pass, 0 fail, 384 expect() calls.

bun run typecheck
# TypeScript 5.9.3; package, referenced package and script checks pass.
```

The package tsconfig excludes `*.test.ts`; an additional TypeScript 5.9.3 program
uses the package compiler options with the review test as its explicit root and
`noEmit: true`, checking its imported source graph. This verifies the review test
itself, not merely Bun transpilation: **1297 source files, zero diagnostics** on
the final run. Reproduce that check with:

```sh
bun -e 'import ts from "typescript";
const raw = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
const config = ts.parseJsonConfigFileContent(raw.config, ts.sys, ".", {noEmit: true, emitDeclarationOnly: false});
const program = ts.createProgram(["src/hooks/magic-context/host-runner/opencode-adapter-review.test.ts"], config.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
console.log(`TypeScript ${ts.version}: ${program.getSourceFiles().length} source files; ${diagnostics.length} diagnostics`);
if (diagnostics.length) { console.log(diagnostics); process.exit(1); }'
```

`bun run format -- --staged` and `bun run lint -- --staged` (Biome **2.5.1**)
both checked the one staged TypeScript file successfully; no unrelated files
were edited. AFT inspection was partial because its checkout call-graph view and
Biome analyzer were unavailable; the explicit repository lint and TypeScript
checks above are the authoritative diagnostics. No production build is required
for these two test/report additions; the prepared baseline build already passed.

The red names above and their reported counts/errors are intentional regression
evidence. Existing tests were neither inverted nor renamed, and no implementation
mutation or real-module corpus result is claimed. Fixes and integration acceptance
belong to the slice owner.
