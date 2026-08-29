# GitHub issue #381 — TS/Rust parity adjudication

Date: 2026-08-28

## Scope and constraints

This pass read the complete issue, including the checked-and-rejected section and the A3/B2 caveats, and traced every claim at source. TypeScript remains the lane specification except where the nudge redesign specification explicitly chose the Rust behavior. The collision fence was respected: no change touches `strip-content.ts`, `transform-postprocess-phase.ts`, or `ctx-memory/tools.ts` lines 400–480.

## Verdicts

| Item | Verdict | Resolution |
|---|---|---|
| A1 legacy truncation | Real wire divergence | Rust now slices legacy bodies by UTF-16 code unit. A split astral scalar is held as an internal noncharacter marker and emitted as the same lone-surrogate JSON escape as JavaScript. The 420- and 1200-unit boundaries are in the generated render golden. |
| A2 reasoning sentinel | Real, cache-relevant wire divergence | Rust now emits `type: "text"`, `text: ""`, and copies `cache_control`/`cacheControl`. This preserves the provider cache breakpoint. The TS-generated merged-reasoning fixture now carries the expected sentinel. |
| A3 edit-marker key order | Real and wire-reaching | `edit_marker_payload` becomes a reduction payload and is rendered into the served tool input; it is not re-rendered from the source object. The host now captures top-level tool-input key order in transform-request metadata, Rust consumes it only while building an edit marker, and the generated fixture asserts the exact JSON string rather than merely object equality. Provider tool arguments remain unchanged. |
| B1 completed-arc fence | Real decision divergence | Both lanes now move backward to the invocation when the invocation is at/above the publication floor. They move forward past the result only when moving backward would cross already-published history. The exact inv=2/result=4/candidate=3 case resolves to 2. |
| B2 running call rewrite | Real live correctness bug | `group_arcs` does produce result-less arcs, and supersession could expand one into a call-input reduction. Running arcs are now excluded both from the candidate pool and from final emitted decisions. The generated selector fixture contains an in-flight `bash_status` call with no result/tag row. |
| B3 caveman eligibility | Reporter case rejected; guards retained as hardening | Caveman eligibility is evaluated per flat text block, not per whole message. A mixed assistant message containing text plus a tool call still compresses its text block. Synthetic, covered, non-user/assistant, frozen-reduction, and non-text exclusions prevent mutation of transport or unavailable targets and do not reject the reported live mixed-message case. The existing caveman selection regression was strengthened to use that exact mixed shape. |
| B4 reminder-span surface | Real divergence; Rust/spec direction wins | S1 requires reminder spans to be excluded from both U and T. TS now strips trailing Channel-1 reminder spans from ordinary text as well as tool output; Rust retains its all-text behavior. A generated ordinary-user-text fixture covers the former gap. Removing attributed reminder mass can lower U/T; removing untagged reminder mass can raise U/T, so either neighboring nudge band can change depending on attribution. |
| B5 context fallback | Real geometry divergence | The plugin fallback is now 200,000, matching module-side `usage_numbers` and current usable-soft geometry. The obsolete 128K constant and test helper are gone. The generated boundary golden exports the TS fallback and the Rust fallback test consumes it. |
| C1 mural cue staleness | Real persisted-state bug | Both memory-content update paths clear `mural_cue`, `mural_cue_hash`, `mural_cue_at`, and reset `mural_cue_rejection_count`. This uses existing columns and is not a migration. |
| C2 note update semantics | Real facade contract divergence, with one intentional internal difference | Facade updates now preserve content verbatim, accept empty content, and only invalidate compilation when the normalized surface condition actually changes, matching TS behavior. Rust keeps its monotonic `status_version` and CAS internally because evaluator writes require lost-update protection; that field is an authority implementation detail rather than a facade content contract. This retained internal-schema difference is intentionally ledgered here. |
| C3 compiled note metadata | Real functional gap | The hook now sends `compiled_provider`, `compiled_config`, `compiled_at`, and `compile_status`; `NoteWriteInput`, `StoredNote`, reads, writes, and note changefeed snapshots carry them. Store migration 52 adds the four nullable columns and rebuilds note insert/update feed triggers. This is additive serde/request behavior and additive storage schema. |
| C4 merge canonical row | Real persisted-state divergence | The facade now resolves the canonical row by normalized content hash. It reuses a matching source row or inserts a new canonical row when merged content is new, then supersedes every other source and preserves TS source-only lineage/counters for a newly inserted canonical row. A duplicate canonical outside the merge set fails closed. |

## Differential and regression coverage

Before this change, the passing differential suites contained none of the issue's adversarial inputs. Afterward they contain issue-specific generated cases for A1, A2, A3, B1, B2, B4, and B5. B3 is exercised by a mixed assistant text/tool caveman regression. C1–C4 are exercised by transactional store/facade regressions, including changefeed state. Thus issue-specific automated coverage moves from 0/12 to 12/12; 7 cases are TS-generated differential goldens, one is a source-shape non-divergence regression, and four are authoritative persisted-state regressions.

## Executed mutation evidence

Every mutation used the exact `NON-VACUITY BREAK` token and was restored immediately after the red run.

| Item | Deliberate break | Observed failing assertion |
|---|---|---|
| A1 | Restored scalar-value truncation | `decay_render.rs:666`, UTF-16 golden case 5 |
| A2 | Dropped cache metadata from the sentinel | `lib.rs:19234` |
| A3 | Ignored the host-captured tool-input key order | `selection.rs:1938` |
| B1 | Forced every completed arc to close forward | `boundary.rs:2205` |
| B2 | Admitted running arcs to candidates and final decisions | `selection.rs:1866`; fixture showed the illegal `running#0` drop |
| B4 | Counted ordinary-text reminder spans again | `tail_hygiene.rs:1279` |
| B5 | Restored the 128K plugin fallback | `event-handler.test.ts:511` |
| C1 | Retained mural cue columns during content update | `mc-store/src/lib.rs:26015` |
| C2 | Restored trim-and-empty-reject behavior | `mc-store/src/lib.rs:26103` |
| C3 | Discarded compiled provider metadata | `mc-store/src/lib.rs:26067` |
| C4 | Reused the first source instead of content-hash canonicalization | `mc-store/src/lib.rs:26184` |

No mutation marker remains in changed source or tests.

## Draft reply for issue #381

Thanks, iceteaSA — this was a strong report, especially the explicit caveats and the checked-and-rejected section. We reproduced and fixed A1, A2, A3, B1, B2, B4, B5, and C1–C4. A3 does reach served bytes through the reduction payload, so insertion order is now preserved. B2 is live: a result-less arc could reach supersession and rewrite a running call; it now has completion guards at selection and emission, with a concrete in-flight fixture and an executed red mutation.

B3's reported mixed assistant text/tool shape is not divergent after flattening: eligibility is per text block, and that text remains compressible. We retained Rust's synthetic/coverage/role/text guards as safety hardening and strengthened the regression to exercise the mixed shape. For B4, the redesign's S1 requirement decides the direction: reminder spans are excluded from both U and T on all text surfaces, so TS was aligned to Rust. C2 now matches TS content semantics while Rust's internal monotonic status version remains an intentional evaluator-concurrency fence.

The most important meta-finding was also correct: all prior goldens passed while these adversarial cells were absent. Issue-specific coverage is now 12/12 (7 generated TS→Rust cases, the B3 non-divergence shape, and 4 persisted-state transaction regressions), and every shipped behavioral fix was mutation-checked. No GitHub action was taken from this worktree.
