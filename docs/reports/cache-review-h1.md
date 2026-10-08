# Independent cache review: H1 runner record

Reviewed commit: `57b970919fc856d1ca3126710d1e0ffcb86ae5f8`.

Scope: `packages/plugin/src/hooks/magic-context/host-runner/record.ts`, its original tests, the folded campaign spec's D2.1–D2.9 and A1/A2/A4/A5/A9, and the protected cache-stability section of `ARCHITECTURE.md`. The new reproductions and passing controls are in `record-review.test.ts`. **No implementation fix is included.**

## Verdict

I did not reproduce an undeclared change to previously served message bytes under the core's documented ownership and persist-before-commit preconditions. The append, race, raw-tail revert, covered-range invalidation, pinned-version hydration and fence mechanisms passed the exercised record-level cases.

I did find two boundary failures in the admission-to-status sizing contract. R2 is blocking: two individually admitted messages can leave a durable record for which the pager cannot produce a legal continuation request. R1 is a should-fix API/integration hazard: admission and paging do not agree on which control fields the caller must supply. Neither reproduction demonstrates a silently changed prefix; they demonstrate accepted input for which the rebuild cannot produce the promised capped requests or the declared admission-time exit.

These are pure-core findings, not an end-to-end differential against the full-request Rust handler. Provider rendering, storage transactions and host routing do not exist in H1. The passing replacement fixtures below prove assembly/fence behavior, not the engine's actual execute/fold bytes.

## Findings

### R1 — Admission can omit the mandatory paging cursor from its cap check

**Severity: should-fix.** The adapter can avoid this by supplying a complete admission-only status control object, but that is not enforced or documented by the core API. H1's original admission examples omit the cursor too.

**Locations:** `admit` (`record.ts:343–357`) and `statusPages` (`record.ts:469–499`).

**Input sequence:**

1. Create a fresh record with ordinal 1 and an empty Setup view.
2. Scan terminal message A. Use the ordinary pager control object: session, harness, lineage, request id, served watermark, model and time; no `after_ordinal`.
3. Choose A's ASCII text so the independently encoded single-entry status with that control is exactly **3,145,728 bytes**.
4. Call `admit(record, candidate, control)`. H1 accepts it.
5. A paged status for the same record necessarily adds `after_ordinal: 0`. `statusPages` owns this field and explicitly rejects a caller-provided `after_ordinal` in its control input.

**Expected versus actual bytes:**

The measured single-entry status must be the status that can actually be sent. Here the admission envelope is

```text
{"method":"compaction.step","params":{<control>,"messages":[{"ordinal":1,"mid":"A","message":{"id":"A","text":"x" repeated L}}]}}
```

at 3,145,728 bytes. The pager's envelope adds `,"after_ordinal":0` (18 bytes), yielding **3,145,746 bytes** for the same ingest. Expected: reject this message as `provider_message_too_large` before hooks/admission become durable, or explicitly require and validate the complete status-sizing control at the admission API. Actual: `admit` returns an accepted snapshot. Its size check did not include the mandatory cursor.

The test uses `Buffer.byteLength(JSON.stringify(independentEnvelope))` to choose L, then checks the actual encoder's two byte counts. It does not derive the expected admission decision from the implementation's predicate. The failing assertion is the expected admission exit, not a serialization or parse error.

**Spec:** D2.3 step 4; D2.5 “Size checks” (complete encoded envelope and params, single-entry oversize exits at admission); D2.9 `provider_message_too_large`.

**Failing test:** `H1 review: status admission and paging boundary defects > R1 admission counts the paging-owned after_ordinal in the single-entry cap`.

**Caveat:** this is an API composition problem, not proof that a future H4 adapter passes incomplete control. The review's other admission helpers supply the cursor explicitly. R2 still fails with that correction, so it is independent of R1.

### R2 — Individually fitting messages may not fit any continuation page

**Severity: blocking.** This affects a record produced using the complete single-entry admission control. There is no legal nonempty continuation page for the reproduced pair, in either ordering.

**Locations:** `admit` (`record.ts:350–354`) and the `more`-aware fit loop in `statusPages` (`record.ts:484–499`).

**Input sequence:**

1. Create a fresh record and scan terminal A and B, each with ASCII text sized independently so its single-entry status **including `after_ordinal: 0`** is exactly 3 MiB.
2. Admit both with that complete status control. Both are accepted.
3. Make each hook unavailable; `finishEntry` freezes both raw, with `ingested = false`. Commit the entries. The two raw messages are now part of the record's served array.
4. On the rebuild, request status pages for both missing ingests.

**Expected versus actual bytes:**

For either message, the final-page single-entry request is **3,145,728 bytes**. A continuation request adds `,"more":true` (12 bytes), making it **3,145,740 bytes**. The two messages cannot share one page. Therefore at least one must occur on a continuation page, and neither can fit there. Reordering cannot rescue this pair.

Expected: admission must leave a sendable record, with enough envelope headroom for continuation fields (or take the durable `provider_message_too_large` exit before admitting an unsendable record). Every emitted page must stay at or below 3 MiB; an incomplete lineage requires `more: true` for a valid `wait`.

Actual: the fit loop admits zero fragments to the first page, then throws **`Single-entry status exceeds request cap`**. No status request is returned and no pipeline exit is recorded by this operation. The ordinary served bytes are still the frozen raw A/B bytes; the requested rebuild has no assembled replacement/request bytes. I have not assumed how a future adapter handles the exception, but the core's promised admission-to-paging invariant already fails.

Sending the first message without `more` is not a valid workaround: D1.6 requires `history_unreadable`, not `wait`, for an incomplete lineage on a final page. Retrying the unchanged pager inputs repeats the same exception.

The reproduction allows an admission-time oversize exit as a safe outcome, so it does not force a future fix to retain today's acceptance of the boundary messages.

**Spec:** D2.5 “Size checks” (any admitted non-oversize message fits a single status entry; capped status pages; no unavailable/resync loop); D2.4 frozen-raw status recovery; D2.7 bootstrap paging; D1.6's gated `wait`; D2.9 admission-time oversize exit. The associated encoded-size acceptance is A10, in addition to H1's status/size obligations.

**Failing test:** `H1 review: status admission and paging boundary defects > R2 a cap-sized message either exits at admission or has sendable status pages`.

## What passed

All 27 original H1 tests passed, including the 8,000-pass randomized append/revert/race oracle. Nine additional review controls passed:

| Pass/input class | Checked behavior and result |
| --- | --- |
| Defer / repeated known window | Known content and classification accessors throw if touched; known served objects throw on serialization inside the runner. Reconciliation and assembly touch none of them. First-serve byte prefix and object references survive repeat passes. This complements the original A2 1k/8k counter test. |
| Unserved id sorted into the middle | `[A,B,C]` → `[A,X,B,C]` → repeat serves `[A,B,C,X]`, unchanged prefix, one X, one divergence increment, no descent or rebuild. This is A4's declared difference from the old full-request ordering. |
| One-turn / multi-turn raw revert | Revert six entries through ordinal 5 or 2. The exact surviving served prefix remains, the watermark clamps to the target, a descendant starts once, and a subsequent new message uses target + 1. |
| Missing suffix versus interior gap | `[A,B,C,D]` → `[A,X,C,D,E]` → append F retains B and counts its hole once. `[A,B,C]` → `[A,X,B,C]` → `[A,X,B]` exits as ambiguous; assembly cannot replay C from that record. |
| Execute / fold / next defer | Applying one replacement retains the frozen raw tail by reference. A next defer cannot change the replacement. A fold replacement can prune the entire tail; another answer on its already consumed fence cannot apply a second view. The next append retains the folded bytes. |
| Restart after full pruning, then covered revert | Serialize and restore the record's ids/state/view with no raw entries, revert to A/B, and observe exactly one descent and invalidation. A fenced `noop` does not clear invalidation. Assembly fails closed until a newer accepted revert view applies. |
| Hook answer before durability / module ahead | A staged X answer changes neither assembly, the id map nor the committed watermark. Descent through the last committed ordinal retains those bytes and permits reordered Z/X/Y retry admissions at contiguous ordinals. No staged X ops enter the record. |
| Partial multi-subject failure / restart / resend | An assistant subject and two distinct tool part subjects with one unavailable result freeze the entire message raw. All three subjects enter the burn list; acknowledging only one does not erase the others. Hydration preserves raw bytes, including after a durable status acknowledgement changes `ingested` to true. |
| Normal-size status pages | Three large non-ASCII frozen-raw messages page into two capped envelopes. Only the continuation has `more`, cursors advance 0 → 2, and the ingest text is unchanged. The failures are at the cap boundary, not generic UTF-8 or paging failures. |
| Exit / restart / deliberate switch-back boundary | Exit is sticky, assembly refuses it, and the old record's stored bytes remain unchanged. The reseed flag distinguishes zero from positive divergence. A deliberately new record can admit messages, but does not revive the exited record. Actual full-request namespace re-seeding is outside H1. |

The original tests additionally checked moved-marker elision with no ordinals/hooks/status/divergence, shipped versus unknown op versions, late/superseded non-view answers, structural rejection without changing served bytes, request-newest bounds, history-gap retry termination, and rebuild opportunities that exclude a plain historian publication or queued reduction.

## Explicit integration boundaries

- **`pass_complete`:** H1 neither selects the last hook nor invokes state sync/historian scheduling. The core stages admissions and exposes the previous committed watermark correctly; actual barrier timing and complete-pass ingestion remain M3/M5/H3/H4 obligations. No claim of a successful end-to-end barrier test is made here.
- **Gated `wait`:** `statusPages` sets `more` for normal continuation pages and omits it on the last. `commitNonViewAnswer` validates the request fence, not whether the request carried `more`. H3 must treat a final-page `wait` as unavailable and never reissue it; that is explicit H3 acceptance, not a newly reported H1 defect.
- **Per-page request ids:** the string-array pager copies the supplied control object into every page. A consumer must issue a fresh, durable fence for each actual call (for example, recompute the remaining pages with new control after acknowledgement), not blindly transmit every pre-encoded string under the same id. Fresh-id generation/bootstrap resumption belong to the provider client and storage slices; this review did not pretend that the pager implements them.
- **Durability and tag promotion:** the staged-admission test verifies the record cannot assemble uncommitted messages and that hooks can carry the old watermark. H1 has no database or module: it cannot prove the adapter really persisted before calling commit helpers, or that the module never promotes an answer early. Those require H2/M3 kill-point tests.
- **Full-request equality:** actual OpenCode schema ops, signed-thinking/role/tool-pair validation, full-request rendering and exit/switch re-seeding are outside this generic core. Test replacements here are explicit fixtures. The real-host differential and module tests remain necessary before cutover.

## Reproduction and verification

Run from `packages/plugin`:

```sh
bun test src/hooks/magic-context/host-runner/record.test.ts src/hooks/magic-context/host-runner/record-review.test.ts
```

Bun 1.4.2: **38 tests, 36 pass, 2 fail, exit 1**. All original tests and all nine passing review controls are green. Only R1 and R2 fail, respectively:

```text
R1 admission counts the paging-owned after_ordinal in the single-entry cap
Expected: true
Received: false

R2 a cap-sized message either exits at admission or has sendable status pages
expect(received).not.toThrow()
Error message: "Single-entry status exceeds request cap"
```

The review-only command is `bun test src/hooks/magic-context/host-runner/record-review.test.ts`: **11 tests, 9 pass, 2 intentional failures**. These are deliberately committed regression tests against the reviewed H1, not tests rewritten to accept defective behavior.

TypeScript 5.9.3: `bun run typecheck` passed. Because the package tsconfig excludes test files, the new review test and its imported core also passed an explicit strict `tsc --noEmit --emitDeclarationOnly false --target ESNext --module ESNext --moduleResolution bundler --strict --skipLibCheck --types node,bun-types src/hooks/magic-context/host-runner/record-review.test.ts` check. Biome 2.5.1 checked the single new TypeScript file after import ordering was corrected. AFT inspection was partial (no checkout call-graph view and its Biome producer unavailable); the local compiler/linter commands are the authoritative checks.

No live OpenCode or Magic Context stores/configuration were opened, read, written or migrated. No provider process was started. Tests import only `bun:test` and the pure `record.ts`; all fixtures are in memory. The implementation and its original tests are unchanged.
