# Independent correctness review: fast-Rust H3

## Scope and evidence

Reviewed delivery: `b3f735824a5b5aeb70071dc1144bb9fe5eb6f356`.
Production files, including `provider-client.ts`, are unchanged. The only additions
are this report and `provider-client-review.test.ts` next to the delivered tests.
Tests use an in-memory recording implementation of the existing module transport;
they do not connect to OpenCode, SUBC, a running module, or any database.

Authorities:

- The folded spec in
  `.cortexkit/alfonso/task-outputs/consult-ct_00000000-0000-41b8-98dc-36ef49802db8/owner-loop-round-0.md`:
  D1, D2.3–D2.7, D3, A1/A2/A5/A9/A10 and H3. In particular, folded lines
  667–682 specify request sizing and staged bootstrap.
- The ruled ledger and field descriptions in
  `.cortexkit/alfonso/drafts/host-runner-contract-extensions.md`, read with
  `git show origin/train/agent-move:<path>`; that ref resolved to
  `ba26158315b9314a5ba93363351df34a8a8e6985`. The accepted-with-conditions ledger
  governs over the document's retained historical “pending” prose.
- The copied commons `c1591d4a` JSON fixtures and the delivered provider tests.

**Verdict:** one blocking bootstrap answer-sequence hole, three should-fix
outbound-contract discrepancies, and one numeric-decoder conformance note.
Nine new assertions fail for these five findings. No fix is included.

## Findings

### R1 — blocking: a view from a continuation page is exposed for application

**Test:** `R1: a continuation-page view cannot reach durable application`.

**Input sequence:** hold two raw messages at ordinals 1 and 2, each with 1.6 MB
of ASCII text. They require two status pages. Call `bootstrap` with `newest = 2`.
The first request contains only ordinal 1 and `more: true`. Answer that request
with a correctly echoed request id and `compaction_message` version 1, range
`[0,3)`, containing a structurally valid summary.

**Expected:** no view candidate from this non-final page reaches the adapter's
application callback as an accepted answer. Bootstrap must not complete with an
applied view before its final page. Rejecting the unexpected answer as unavailable
would satisfy this safety requirement; blindly retrying it would not.

**Actual:** `page` accepts it, `bootstrap` calls `onPage` with an answered view,
and then returns it, abandoning the second page. Calling the existing H1
`applyCompaction` from that callback returns `{ applied: true }`: the first
request's fence already covers the *entire* record's newest ordinal, not only
the page's last entry. Fence, version and range checks alone therefore do not
defend this sequence. The red assertion is expected `[]`, received
`[{ "applied": true }]`.

**Spec:** D2.7 bootstrap steps 2–3 and “Nothing the bootstrap produces is served
until step 3's view is durable”; D3.5 says bootstrap's **final** page runs the
engine. A1/A5 require prefix changes to be the intended accepted rebuild, not
an accidentally accepted intermediate result. H3 is required to survive
adversarial answer sequences, not just a cooperative provider.

**Boundary:** H3 does not itself write served bytes. This reproduction shows an
invalid bootstrap-stage candidate passing all the available H3/H1 gates; its
`onPage` callback stands in for the adapter's durable-answer/application phase,
without doing disk I/O. H4 could add a final-page guard, but none is promised by
the current `PageResult` acceptance path. Host enablement needs an explicit
guard in the composed path, or a justified alternative contract.

### R2 — should-fix: every bootstrap page carries `pipeline_switch`

**Test:** `R2: pipeline_switch is reserved for the final bootstrap page`.

**Input sequence:** the same two-page record, with
`prefix_rebuilding: { reason: "pipeline_switch" }` in the bootstrap inputs.
Return `wait` to the first page and `noop` to the last; acknowledge each page
before the next fence is issued.

**Expected:** prefix rebuilding flags are `[absent, pipeline_switch]`.

**Actual:** they are `[pipeline_switch, pipeline_switch]`. `controls` copies the
inputs once and paging carries them unchanged. The first page asks for the very
engine action that D2.7 reserves for the page reaching newest. A cooperative
incomplete-lineage provider may mask this by answering `wait`, but it is still
the wrong request sequence and compounds R1 for an already-held conversation.
The test fails on the first flag, not on paging or acknowledgement.

**Spec:** D2.7.3: “The page that reaches `newest` carries
`prefix_rebuilding {reason: "pipeline_switch"}`”; D3.5 final-page engine run.

### R3 — should-fix: empty burn lists are emitted instead of omitted

**Tests:**

- `R3: hook omits an empty unserved_subjects list`
- `R3: step omits an empty unserved_subjects list`

**Input sequence:** a fresh record with `unserved_subjects = []`, followed by one
ordinary user hook or empty status step.

**Expected:** the encoded params have no `unserved_subjects` property.

**Actual:** both requests carry `"unserved_subjects":[]`. The failing assertions
inspect the actual bytes captured at the transport boundary: `Object.hasOwn`
is true, expected false. The list is emitted by hook control construction and
by the step control snapshot, including on every ordinary pass.

**Spec:** ruled extension P2, “Absent meaning / lenient decode”: “absent or an
empty list names no burns; **omit the empty list**”; H3 wire-shape acceptance.
This is a byte/omission discrepancy, not evidence of incorrect burning: absence
and empty have the same semantic meaning. It is not a cache-safety blocker by
itself.

### R4 — should-fix: part identities are not checked against the ruled limits

**Tests:** the four `R4:` tests for hooks and status burn-list entries, with
`subject_part` either `empty` or `258 UTF-8 bytes`.

**Input sequence:** send a valid `post_tool` hook except for a present part id
of `""` or `"漢".repeat(86)` (258 UTF-8 bytes, only 86 JavaScript characters).
Separately send a status with the same invalid id in an unserved tool subject.

**Expected:** do not dispatch the invalid host identity. A local exception or
an unavailable result is acceptable to these tests; they do not dictate a new
error API.

**Actual:** each case dispatches one request, expected zero. The hook schema
accepts any string for top-level and nested part ids; the step extensions are
passthrough fields and are not validated before encoding. A positive control
confirms a 256-byte part id is sent unchanged, so the issue is the actual byte
limit/empty-value rule, not blanket rejection of non-ASCII identities.

**Spec:** ruled P3: present identities are opaque, **non-empty**, at most
**256 bytes**, compared byte for byte. The same member is used in P2 entries.
D1.4/A9 depend on stable, unambiguous subject identities. These tests audit
outbound client conformance; a module-side named refusal is still required and
has not been tested here. Trusted host ids reduce exploitability, but do not
make the public client's unbounded strings conform to the accepted contract.

### R5 — note: the wire `u64` decoder includes one impossible endpoint

**Test:** `R5: the exactly representable value 2^64 is not a wire u64`.

**Input:** decode a user hook with `subject_ordinal = 2 ** 64`.

**Expected:** decoding fails: a `u64` ends at `2^64 - 1`.

**Actual:** it decodes. The common refinement uses `n <= 2 ** 64`, rather than
an exclusive upper bound. Bun prints the number as `18446744073709552000`;
the underlying IEEE-754 value is exactly `2^64`, outside the Rust type.
The failure is “Received function did not throw”. The refinement is shared
with other ordinal, time, version and budget fields.

**Spec:** the commons request/answer shapes use `u64`; H3's decode/vector
conformance criterion. Existing vectors do not exercise this endpoint.
This is not a demonstrated served-byte exploit: H1 separately requires safe
integers for applied views, and normal record ordinals cannot reach it. Nor
does it demand a BigInt redesign to support all legal wire integers; this
particular out-of-range endpoint is exactly representable and rejectable.

## Questions checked and properties found correct

| Question / pass class | Evidence and result |
| --- | --- |
| Late, stale, superseded, duplicate answers | Delivered deadline-at-arrival, timeout, wrong-id and supersession tests pass. The new late-bootstrap control proves the callback is not called again when a transport ignores cancellation and later resolves. The new application control accepts one valid view and rejects a duplicate as `superseded_request`. H1 rejects stale versions and out-of-fence ranges; H3 deliberately returns candidates rather than performing structural application. R1 is an independent bootstrap-stage hole, not a bypass of those checks. |
| Two views in one step | A bootstrap call returns on its first non-`wait`; a transport promise resolves only once, and a consumed H1 fence rejects another application. No two-view sequence within a single H3 call was found. The same-pass restriction across two *separate* `step` invocations still belongs to H4 orchestration; H3's busy bit is not a pass identity. |
| Defer / wait loops | Waits on continuation pages advance through a finite planned list with fresh ids, without consulting `bound_ms`. A final wait becomes `unexpected_wait`, is delivered as unavailable, and is never resent. The new control uses a provider that answers wait to every page: two requests, then unavailable, not a loop. Ordinary `step` sends one page and does not internally retry; completing a multi-page ordinary recovery is an adapter responsibility. |
| Fully encoded 3 MiB cap | No oversize request was sent in the checked sequences. Delivered tests cover exact-cap versus cap-plus-one hook bytes, duplicate blocks, oversize status, declare and Setup. The new multi-page test measures the actual `Uint8Array`-equivalent UTF-8 bytes, including escaped/non-ASCII ids and text, burn lists, cursor and `more`. Planning reserves encoded id width; the final status encoder and send path check again. Oversize single status entries produce `provider_message_too_large`, not truncation or retry. |
| Commons shapes / bytes | All 139 delivered tests pass, including copied request/answer decode vectors for all four operations and landed host fields. A new control independently compares all 19 ordinary request fixture payloads, in compact form and fixture key order, against encoded envelopes; all pass. This is not a claim of byte equality to whitespace in pretty-printed fixture files or to a separate Rust serializer's canonical key ordering. The old test comparing encoding to `JSON.stringify(decoded)` alone was not an independent byte oracle. Copied c1591d4a host fixtures do **not** cover ruled P1–P4, sparse-status semantics or authenticated-principal admission. R3/R4 are precisely discrepancies outside those old vectors. |
| Durable served watermark / revert | The client only copies the record watermark; it never advances it because a hook answered. Two hooks above durable ordinal 2 both carry 2. An H1 descent through 1 changes the lineage and clamps the next hook to 1 with explicit ancestry. No client-produced backwards movement on one lineage, or advance past the supplied durable record, was found. Module-side “never past held newest” and named refusal of a decrease require M3/M4 tests; arbitrary corruption of the caller's record is not ruled out by H3. |
| Request ids and fences / restart | Continuation pages use distinct ids and install a durable fence before dispatch; acknowledgement completes before the next page. Delivered timeout/resume test uses `r1,r2,r3` with cursors `0,0,1`. Default UUID generation is fresh across processes. The injectable generator explicitly promises global freshness; only immediate reuse is guarded, so an invalid custom alternating-id generator would break its own API precondition, not establish a default-generator defect. |
| A2 known-message work | New control installs throwing accessors on a known ingested entry's `ingest` and `served.toJSON`. An ordinary status sends an empty message list with the cursor at newest, assembles by reference, and triggers neither accessor. Hooks splice pre-serialized ingest verbatim; pages splice only missing ingest. No served-array stringify or host ordinal/store read exists in this client. This is a narrow H3 control, not A2's full two-session timing/counter oracle. |
| Execute / fold | The delivered execute/fold test proves returning a view leaves served references unchanged until H1 application. Application consumes the fence and prunes the tail. Generation sensitivity is enabled on every module call. |
| Transport errors / module restart mid-request | Thrown errors map to unavailable with their original object retained; generation-change sentinels fail decoding and map to unavailable `invalid_answer`. No internal reconnect resend is authorized (`generationSensitive: true`). No stale response is applied. The real transport already returns a generation sentinel for interrupted generation-sensitive requests; a module restart itself was not performed in this isolated suite. |
| Store-ahead / conflict refusals | Errors are retained for adapter classification, not lost. New control confirms the exact `StoreAheadOfBinaryError` object survives. However its outer result is `unavailable/transport`, and hooks include `on_unavailable: pass`. D2.7 explicitly requires MC-C13 turn refusal, never raw fallback, for this error. H4 must recognize it **before** applying the generic unavailable policy; likewise ordinal conflicts must descend rather than freeze raw. This is a required integration gate, not proof that an absent adapter currently does it wrong. |
| D2 runner-principal prohibition | The client has no authenticated-principal input and cannot enforce module admission from a body `harness` string. It sends the frozen host opts via the bound route and preserves injected `invalid_params` errors naming either forbidden host-plan field without retrying. That control checks **refusal handling only**. Actual runner-principal rejection of `observation: answer` / `serializer_profile: opencode-aisdk` on declare and Setup needs an authenticated M3/module test; a fake that manufactures the refusal cannot prove authorization. |
| Exit / failed persistence | Delivered tests show exited records cannot dispatch, fence persistence errors propagate before sending, and page acknowledgement errors propagate without sending the next page. H3 does not choose exits, refusal recovery or raw fallback itself. A5 invalidated-view recovery and actual host/module kill points remain H1/H2/H4/M3/M4 integration gates. |

## Verification and reproducibility

Run from `packages/plugin` (Bun **1.4.2**, revision `744846f84`):

```sh
bun test src/hooks/magic-context/host-runner/provider-client-review.test.ts \
  src/hooks/magic-context/host-runner/provider-client.test.ts
```

Result: **158 tests, 149 pass, 9 fail, 547 assertions, exit 1**. All nine failures
are the R1–R5 tests listed above; all 139 delivered tests and all 10 new controls
pass. The review file intentionally uses ordinary failing `test` assertions,
not `test.failing`, skips or modified production code. It is expected to keep
the relevant suite red until the findings are fixed or adjudicated.

Additional gates:

- `bun run typecheck` in `packages/plugin`, TypeScript **5.9.3**: passed all three
  compiler invocations (retina build config, plugin no-emit, script config).
- The plugin config excludes tests, so a separate strict no-emit invocation of
  that pinned TypeScript compiler checks the review entry and its import graph:
  passed (`--strict --skipLibCheck --target ESNext --module ESNext
  --moduleResolution bundler --types node,bun-types --esModuleInterop`).
- A scoped check with the pinned Biome **2.5.1** checks the one added TypeScript
  file: passed, one file checked, no fixes applied. No production build is needed
  for a tests-and-report-only change; the
  supplied worktree preparation already built the unchanged delivery.
- AFT inspection is partial in this isolated checkout (checkout call graph
  unavailable and its Biome producer unavailable); it is not claimed as a clean
  diagnostic result. The explicit compiler and scoped Biome gates are used instead.

No live stores were opened, read, written or migrated. No live config was read.
No campaign mutation was applied to production code, and no changes were made
outside the two requested review deliverables.
