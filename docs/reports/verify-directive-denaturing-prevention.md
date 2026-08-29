# Verify directive-denaturing prevention report

Date: 2026-08-28

## Outcome

The map/verify pipeline now has prompt-level and host-enforced barriers against treating process directives as code facts. The host gates execute before either the local write path or a MODULE authority call is built, so authority routing cannot bypass them.

The protection has three independent parts:

1. The mapper classifies behavioral process claims as file-independent even when the memory names a real path.
2. Verify permits destructive verdicts only for file-falsifiable code facts, while the host refuses directive-shaped `PROJECT_RULES` updates and archives.
3. Verify refuses rewrites that remove more than half of the original text unless the verdict explicitly declares consolidation.

A refusal is a non-failing skip: it performs no memory, mapping, mutation-log, or module write. The run continues and counts the refusal so model noncompliance remains visible.

## Conservative directive heuristic

`memory-claim-safety.ts` applies the structural gate only when the category is exactly `PROJECT_RULES`. It recognizes explicit behavioral shapes:

- policy modals at a sentence/list-item boundary, including `must`, `never`, `always`, and `do not`;
- policy modals attached to human/work actors such as `you`, `we`, agents, workers, operators, users, or maintainers;
- behavioral `when` clauses such as `when told`, `when asked`, `when checking`, or `when investigating`;
- sentence/list-item imperatives using a bounded workflow verb set such as `run`, `use`, `check`, `ask`, `inspect`, `review`, or `delegate`;
- decision-authority statements such as “the user decides” or “the owner has final say.”

The heuristic intentionally does not exempt the whole category and does not treat every occurrence of `when` as behavioral. The declarative code fact “binds use spread args when invoking registered callbacks” remains verifiable because it has no actor policy, behavioral trigger, or imperative sentence shape. Directive wording in other categories is also not host-exempted; this keeps the gate conservative and avoids disabling legitimate code-fact verification fleet-wide.

## Mapper barrier

The mapper system and user prompts now state that when-to-do, how-to-work, who-decides, and tool-discipline claims are file-independent. A path inside such a claim is an action target or example, not backing evidence.

For a directive-shaped `PROJECT_RULES` input, the host replaces a model-produced file mapping with the independent sentinel before path normalization or authority routing. The resulting mapping uses `mapping_origin='host_rejected_fallback'`, and the override is audit-logged with the memory id and disposition.

### Mapping-origin and schema statement

**Fence/schema movement: NONE.** The existing `MemoryMappingOrigin` vocabulary remains `mapper | host_rejected_fallback`; no value, column, table, migration, Rust/module fence, or fenced applier changed. Reusing `host_rejected_fallback` is unambiguous here because the host rejected the mapper’s file disposition and persisted the safe no-file fallback. It also preserves the existing cross-authority module contract, which already accepts and mirrors this origin. This is neither a schema migration nor a data-vocabulary addition.

## Verify barrier

The verify prompt now defines four outcomes: `verified`, `update`, `archive`, and `skip`. `update` and `archive` are restricted to claims a repository file can falsify, such as a removed API, moved path, or changed constant. Behavioral directives may only be verified or skipped; a file’s failure to mention or corroborate a behavioral rule is explicitly out of scope.

The host independently examines every update/archive verdict before constructing local or MODULE writes:

- directive-shaped `PROJECT_RULES` update/archive verdicts are refused;
- accepted code-fact verdicts retain the existing authority-specific application path;
- explicit model skips perform no write and count as `skipped`;
- host refusals perform no write and count separately as `refused`.

### Refusal audit and progress surfaces

Each refusal emits a structured log line containing at least `memory_id`, `verdict`, and `reason`. Directive refusals use `reason=directive-shaped-project-rule`; rewrite refusals use `reason=content-loss` and include original/replacement character counts.

Visibility is cumulative across the run:

- `VerifyVerdictCounts.refused` and `VerifyResult.refused` expose the count to callers;
- `DreamTaskProgress.refused` exposes it on the live task/sidebar progress object;
- the terminal verify log includes `skipped` and `refused` totals;
- persisted dream-run task progress records verified, updated, archived, skipped, and refused counts.

Refused/skipped verdicts count as processed for the current model batch, so they do not turn an otherwise healthy run into a failure. The underlying memory remains unchanged.

## Content-loss belt

For a non-directive update, the host trims both texts and refuses the rewrite when:

```text
replacement_length * 2 < original_length
```

The strict inequality means exactly half is allowed; dropping more than half is refused. This deliberately conservative threshold catches the observed long-directive-to-short-description denaturing shape without requiring semantic similarity heuristics.

The only bypass is an explicit `consolidation="true"` attribute on the update verdict. The parser defaults the attribute to false, and a test proves the marked consolidation path still works.

## Regression and mutation evidence

The tests exercise both local and MODULE authority planning, audit logging, progress counting, unchanged-memory behavior, and the legitimate-verification negative arm.

Executed mutations used the exact `NON-VACUITY BREAK` marker and were restored immediately after each red run:

| Deliberate mutation | Command | Observed red evidence |
| --- | --- | --- |
| Disabled the mapper directive override | `bun test src/features/magic-context/dreamer/map-memories.test.ts -t "overrides a directive-shaped PROJECT_RULES file mapping to independent"` | `map-memories.test.ts:924` failed: received `mapped=1, independent=0` instead of the independent fallback. |
| Disabled the verify directive archive refusal | `bun test src/features/magic-context/dreamer/verify.test.ts -t "refuses a directive archive, logs it, and completes the run as a skip"` | `verify.test.ts:405` failed: the memory archived (`archived=1`) and `refused` fell to zero. |
| Disabled the greater-than-half content-loss predicate | `bun test src/features/magic-context/dreamer/verify.test.ts -t "refuses and audits a rewrite that drops more than half the original content"` | `verify.test.ts:1025` failed: the short rewrite applied (`updated=1`) and `refused` fell to zero. |
| Changed archive gating to refuse every archive | `bun test src/features/magic-context/dreamer/verify.test.ts -t "still archives changed-file code facts, including the PROJECT_RULES boundary"` | `verify.test.ts:464` failed: both changed-file facts stayed active (`archived=0, refused=2`). This is the negative arm proving legitimate `CONSTRAINTS` verification remains enabled. |
| Forced the declarative `PROJECT_RULES` boundary example to classify as a directive | `bun test src/features/magic-context/dreamer/memory-claim-safety.test.ts -t "leaves declarative code facts and other categories verifiable"` | `memory-claim-safety.test.ts:26` failed: “binds use spread args” classified true instead of false. |

No `NON-VACUITY BREAK` mutation remains in source or tests.

## Verification

- Post-restore targeted mapper/verify/executor suite: `bun test` on the six changed test files — **106 passed, 0 failed**.
- Plugin TypeScript gate: `bun run typecheck` — **passed**.
- Full plugin suite: `bun run test` — **4,164 passed, 0 failed** across 379 files.
- Changed-file lint: `bunx biome check` on all 13 changed TypeScript files — **passed**.
- The repository-wide plugin lint command also inspected untouched files and reported pre-existing formatting errors in `classify.test.ts`, `classify.ts`, `storage-db.test.ts`, `execute-status.ts`, and `rust-mode-transform.test.ts`. No task file remains in that diagnostic set.
