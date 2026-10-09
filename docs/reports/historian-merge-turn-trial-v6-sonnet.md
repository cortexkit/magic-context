# Historian merge-turn v6 on Claude Sonnet 5.5: the stale gap is not fixed

## Answer

**No: moving the frozen v6 turn-2 trial to `claude-sonnet-5-5` did not repair memory #17639, the Rust historian/Broca routing memory.** Of three case-2 repetitions, two accepted the same wrong append-only merge as DeepSeek Flash; the third chose a safe separate `new` fact and left the stale memory untouched. **0/3 removed c4 or rewrote it as a closed gap.** The valid c1–c3 survived verbatim in all three simulations.

Here `#17639` is a candidate memory ID; c1–c4 are its numbered clauses. `12:10`, for example, means fact 10 in frozen input case 12, not a turn number. `new` stores the supplied fact separately without changing old memories; `skip` stores nothing because the fact is already covered; a rewrite changes one selected memory; `conflict` preserves both texts and links the disagreement.

**The controls also regress:** case 12:10 replaces DeepSeek's correct conflict link with an accepted merge that blends termination and detachment. Case 12:9 changes a correct skip into a debatable, mostly redundant append. Case 27:13 safely inserts a separate fact instead of performing DeepSeek's correct narrow update, so its stale target is no longer repaired. Case 35:3 repeats the unsupported raw removal of the 64 KiB bound, but the unchanged narrow-check procedure vetoes it; the effective decision remains correct `new`.

The six planned runs have **65 effective decisions: 60 correct / 3 wrong / 2 debatable**. Their **five accepted rewrites contain three wrong, one debatable and one correct decision (wrong/accepted = 3/5, 60%)**. Repetitions are not independent new corpus cases. Comparing only the first case-2 run plus the three controls gives **35 correct / 2 wrong / 2 debatable out of 39**, versus DeepSeek v6's **34 / 1 / 4**. A higher overall correct count does not offset the additional wrong accepted rewrite. This small, concern-selected experiment does not justify automatic memory writes or expansion to v6's predeclared eight-case follow-on (Stage B), which did not run here.

All model calls finished by **2026-10-08 18:32:06 UTC**, well before the approximately 21:20 UTC credential expiry. There were no product changes or memory writes.

## Frozen material and API mapping

The v6 runner is absent at base commit `989a1d27562c8b8cb1e9ec8231543e4daef02639`. To reuse its exact evaluator without changing product files, it was recovered **from this worktree's local Git objects**, commit **`0f2356acef9be2948ee7a1880f6e725c32287542`** (`run-v6.ts`, `v6.ts`, their unchanged v3/v4 patch gates and the v6 report). No other checkout was read or changed. The frozen file artifacts are under:

`$TMPDIR/magic-context/merge-turn-trial-v6-bgf303/`

For each case, the saved `results/<case>-second.json` provides the exact four-message request: historian system prompt, transcript user turn with its memory block removed, recorded DeepSeek first reply in the assistant role, and v6 reconciliation user prompt. **All four content strings are byte-identical in the Sonnet request.** The original first replies, selected facts, three explicitly labelled reconstructed controls, complete candidate bodies, candidate order and v4 clause splitting are reused. The generated `mergePromptV6` is checked against the captured v6 prompt; hashes of the frozen inputs, first replies, candidate files, supporting evidence, judgments and applied results are retained privately. No first-turn inference, embedding, reranking or fresh retrieval ran, and no database was opened, including the sealed trial snapshot.

- Endpoint: direct **`https://api.anthropic.com/v1/messages`**, not Broca or a proxy; `anthropic-version: 2023-06-01`. `/v1/models/claude-sonnet-5-5` confirmed the exact active model, adaptive thinking and structured-output support.
- **Default thinking/effort**: both settings are omitted, as Sonnet 5.5 enables adaptive thinking by default ([official thinking documentation](https://docs.anthropic.com/en/docs/about-claude/models/extended-thinking-models), consulted 2026-10-08). Temperature is omitted. The provider reports zero thinking tokens for five planned primary runs and 1,149 for case 27; no reasoning budget was forced. This is not a comparison at matched reasoning effort against DeepSeek's explicit enabled/high setting.
- Output ceiling stays **32,000 tokens** for second turns and **16,000** for the independent narrow checker. The system content is moved to Anthropic's top-level `system` field; the other three roles/content strings remain unchanged.
- DeepSeek's `response_format: {type: "json_object"}` is mapped to Anthropic's **`output_config.format: {type: "json_schema", schema: ...}`**, enforcing the v6 decisions/claims/edits JSON shape. The schema constrains JSON field types and append/edit/remove object shapes, **not** candidate membership, evidence truth, action selection, clause validity or semantic consistency. The original strict v6 evaluator remains authoritative. This provider-native structured-output mapping is necessarily different from generic JSON-object mode; it is not a byte-identical wire request or a pure model-size causal ablation.
- The **unchanged `evaluateV6`** simulates every decision. Only proposed edited/removed clauses receive independent narrow calls, now also on Sonnet. Accepted appends receive no additional consistency call. There are no repair turns or semantic corrections to model output.

### Disclosed setup pilot

Before the planned runs, one case-2 call used an envelope-only JSON Schema (`decisions` array without item schemas). It returned valid JSON but made every `claims` and `edits` field an empty **string**, not an array, so all 13 decisions were rejected to `new` by the original v6 validator. That capture is retained as **`pilot-case-2-*`**, not overwritten or counted as one of the three comparable repetitions. The API schema was then expanded to describe v6's field types without changing any prompt, transcript, fact or candidate bytes. The six planned calls all use that same expanded schema and have zero parse, target-ID or per-fact schema failures. The pilot is included in total financial spend; there are **seven actual primary calls plus one narrow call**, not six primary calls in total. The pilot's safe fallbacks also leave #17639's stale c4 unchanged.

### Credential and store boundary

The key was read only from **`~/.config/anthropic-trial.key`**, in process, after checking it is an owner-only regular file. It was never included in command arguments, printed, or committed. Saved request headers contain `"x-api-key": "[REDACTED]"`; responses are scrubbed against the literal key before saving.

Live-store rule, verbatim: **never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`).** None were accessed. No runtime store, enrollment config, descriptor, provider vault or DeepSeek credential was read.

## #17639 stability and complete resulting text

The decisive transcript passage is unchanged:

> ck-mc's historian talks to Broca directly with its own messages, and only when a user sets the historian to run on Broca; the default runs it in the host.

This closes the **host-runner-default gap**; continued direct Broca communication **when configured** does not preserve the conclusion that a host default is still missing.

| Case 2 run | Fact 4 decision | Grade | c4 removed / rewritten closed? | c1–c3 verbatim? | Inline c4 judgment |
| --- | --- | --- | --- | --- | --- |
| DeepSeek v6 | merge #17639 | wrong | No | Yes | yes: direct routing still described |
| Sonnet 1 | merge #17639 | wrong | No | Yes | yes: “The transcript does not settle whether the gap is closed; omitted details are not a contradiction, so it is left unchanged.” |
| Sonnet 2 | merge #17639 | wrong | No | Yes | yes: “Transcript does not prove this gap has been closed; remains as written.” |
| Sonnet 3 | new, no target | correct storage abstention; **not a repair** | No; old memory unchanged | Yes; old memory unchanged | No inventory; the rationale says no single target covers every qualifier |

The first two runs explicitly recognize the host default in c2 while asserting the obsolete gap in c4 remains true. Because c4 is kept rather than edited, neither run reaches a narrow contradiction check for this fact. The third avoids a destructive mistake but does not cure it. The following exact texts are simulated results, **not live-store contents**. Spaces and clauses are taken from the original byte-preserving evaluator.

### Case 2 run 1 — resulting #17639

```text
Rust transform mode must not require Broca (or any other CK module) to be running: every module under CK/subc stays decoupled unless coupling is necessary. Historian and dreamer completions in rust mode run by default in the same harness as the parent session (the host runs the prompt, e.g. OpenCode/Pi child session or the v2 child carrier), and route to the Broca runner only when the user configures it (Ufuk ruling, 2026-09-17). Today `crates/mc-module/src/historian_producer.rs` opens a route straight to `broca` (DEFAULT_RUNNER_MODULE_ID) — that is the gap to close with a host-runner default. ck-mc's historian producer talks to Broca's model runner with hand-built JSON (path:line usage documented in docs/reports/llm-runner-mc-usage.md) rather than through the cortexkit-role-llm-runner contract crate, which Magic Context does not link.
```

### Case 2 run 2 — resulting #17639

```text
Rust transform mode must not require Broca (or any other CK module) to be running: every module under CK/subc stays decoupled unless coupling is necessary. Historian and dreamer completions in rust mode run by default in the same harness as the parent session (the host runs the prompt, e.g. OpenCode/Pi child session or the v2 child carrier), and route to the Broca runner only when the user configures it (Ufuk ruling, 2026-09-17). Today `crates/mc-module/src/historian_producer.rs` opens a route straight to `broca` (DEFAULT_RUNNER_MODULE_ID) — that is the gap to close with a host-runner default. The historian producer talks to Broca's model runner with hand-built JSON rather than the `cortexkit-role-llm-runner` contract crate, so MC is a consumer of the real wire messages, not of the written contract.
```

### Case 2 run 3 — unchanged #17639 and separate fact

```text
Rust transform mode must not require Broca (or any other CK module) to be running: every module under CK/subc stays decoupled unless coupling is necessary. Historian and dreamer completions in rust mode run by default in the same harness as the parent session (the host runs the prompt, e.g. OpenCode/Pi child session or the v2 child carrier), and route to the Broca runner only when the user configures it (Ufuk ruling, 2026-09-17). Today `crates/mc-module/src/historian_producer.rs` opens a route straight to `broca` (DEFAULT_RUNNER_MODULE_ID) — that is the gap to close with a host-runner default.
```

Separate fact inserted by case 2 run 3, without changing #17639:

```text
ck-mc's historian producer talks to Broca's model runner with hand-built JSON rather than the `cortexkit-role-llm-runner` contract crate, and only when the historian is configured to run on Broca (the default runs it in the host).
```

## Grades and side-by-side decision ledger

The **same v6 rubric** is used: supported same-scope coverage/change with still-valid knowledge retained is **correct**; lost knowledge, unsupported change/coverage, incoherent graft or known-fact duplicate is **wrong**; genuine scope, precision or action-choice ambiguity is **debatable**. Safe separate `new` can be correct without repairing a stale target. Unresolved termination versus detachment requires `conflict`, not blending or unlinked insertion. Grades are transcript/candidate judgments, not the model's inline labels or explanations.

**C/W/D** abbreviate correct/wrong/debatable. Decisions below are **effective** unless a proposal → fallback is shown; the DeepSeek column is the frozen v6 decision and grade, not a rerun. Case 2 has three repetitions; all other cases have one. The three reconstructed controls are case 12:10, 27:13 and 35:3: facts reconstructed from the earlier published v2 report, not extracted by these recorded DeepSeek first replies. They test unresolved-conflict linking, correction of a stale permission consequence, and preservation of a transport bound, respectively. Decision application is per fact against its original candidate, not a sequential in-batch rewrite of a live memory.

| Case:fact | DeepSeek v6 decision / grade | Sonnet run 1 / grade | Sonnet run 2 / grade | Sonnet run 3 / grade | Independent reason for Sonnet grade |
| --- | --- | --- | --- | --- | --- |
| 2:1 | update #18611 → new / C | new / C | new / C | new / C | Supported sourcing rule stored separately; no workspace or runner constraints erased. |
| 2:2 | new / C | new / C | new / C | new / C | Resolved-metadata CI gate and planted-violation self-test are new. |
| 2:3 | new / C | new / C | new / C | new / C | Contract publication hold and pinned-git policy are new. |
| 2:4 | merge #17639 / W | merge #17639 / W | merge #17639 / W | new / C | Runs 1–2 retain the explicitly closed host-default gap; run 3 is safe separate storage, not a target repair. |
| 2:5 | merge #20899 / C | new / C | new / C | new / C | Per-message/rebuild-only marker rule adds supported detail not already fully covered by Pi LKG replay. Separate storage is safe. |
| 2:6 | merge #24508 / C | new / C | new / C | new / C | New recovery-command encoding detail is supported; separate storage leaves the crash fence intact. |
| 2:7 | skip #24490 / C | skip #24490 / C | skip #24490 / C | skip #24490 / C | Target alone covers drop sources, all runtimes, drain time and displacement. |
| 2:8 | merge #23823 / D | skip #23823 / C | skip #23823 / C | skip #23823 / C | Target already gives the 384 MiB total limit; avoids redundant consolidation. |
| 2:9 | skip #23823 / C | skip #23823 / C | skip #23823 / C | skip #23823 / C | Target alone gives the 288 MiB per-session limit. |
| 2:10 | merge #5159 / D | new / C | new / C | new / C | Supported marker format stored separately without inventing whose last reply the timestamp measures. |
| 2:11 | skip #24239 / C | skip #24239 / C | skip #24239 / C | skip #24239 / C | Identical protected_tools default map is already present. |
| 2:12 | new / C | new / C | new / C | new / C | Specific offline git-FTS repair command is new. |
| 2:13 | new / C | new / C | new / C | new / C | Config editor naming is distinct from old protected_tags and JSONC rules. |
| 12:1 | new / C | new / C | — | — | Answered-ask/finished-notice liveness rule is new. |
| 12:2 | merge #4981 / C | new / C | — | — | Supported compile/test background rule stored separately from harness/no-nohup guidance; no old constraint lost. |
| 12:3 | new / C | new / C | — | — | Request-path byte-identity constraint is new. |
| 12:4 | merge #23997 / C | new / C | — | — | Supported Bun/Node runtime explanation stored separately; no existing NORMAL/WAL setting changed. |
| 12:5 | merge #23697 / D | new / C | — | — | Separate second-cache value avoids asserting identity with the older shared projection cache. |
| 12:6 | new / C | new / C | — | — | Specific debug-assertion environment gate is new. |
| 12:7 | skip #23179 / C | skip #23179 / C | — | — | Target covers the known 30-minute ceiling; this value alone does not choose termination versus detachment. |
| 12:8 | new / C | new / C | — | — | Shared staging declaration path is new. |
| 12:9 | skip #16288 / C | merge #16288 / D | — | — | Target already covers one-week retention and stale-host failures; supported incident/chunk details add some specificity, but mostly duplicate it. Same redundancy-versus-clarification ambiguity as v6 2:8, not a definite destructive error. |
| 12:10 | conflict #23179 / C | merge #23179 / W | — | — | “Cut off” is appended to an unchanged detachment claim; unresolved outcomes are blended rather than linked as conflicting. |
| 27:1 | skip #16288 / C | skip #16288 / C | — | — | Merge-only deploy and age-pruning rule already covered. |
| 27:2 | skip #23505 / C | skip #23505 / C | — | — | Upstream tracker, open local issue and reporter guidance already covered. |
| 27:3 | new / C | new / C | — | — | Lossy TC rendering and expansion mechanism are new. |
| 27:4 | new / C | new / C | — | — | Shared template source and byte-parity fixtures are new. |
| 27:5 | new / C | new / C | — | — | Provider-owned historian/UI metadata is a supported intended end state. |
| 27:6 | merge #23505 / C | merge #23505 / C | — | — | Supported fenced-code-only hook detail added; tracker, reporter and no-stream-rewrite clauses remain exact. |
| 27:7 | new / C | new / C | — | — | Expansion map and false-disabling rule are new. |
| 27:8 | new / C | new / C | — | — | Placeholder and expansion-line caps are new. |
| 27:9 | new / C | new / C | — | — | Shipped template list differs from old tool registration. |
| 27:10 | new / C | new / C | — | — | List cap, remainder marker and compact-JSON fallback are new. |
| 27:11 | new / C | new / C | — | — | Verbose-only expansions preserve default output bytes. |
| 27:12 | new / C | new / C | — | — | Field paths, missing-field and truncation rules are new. |
| 27:13 | update #19889 / C | new / C | — | — | Safe separate insertion retains knowledge, but leaves the old OC1-only consequence unrepaired; less useful reconciliation than DeepSeek, not a destructive rewrite. |
| 35:1 | new / C | new / C | — | — | Supported hotfix inheritance/scope rule is new. |
| 35:2 | new / D | new / D | — | — | Generalizes the observed BASAL incident to a broader root-commit migration rule; same inherited scope uncertainty. |
| 35:3 | update #23094 → new / C | update #23094 → new / C | — | — | Both raw proposals are W: escaped-wire sizing does not abolish 64 KiB. Narrow veto leaves target unchanged and stores the original supported fact separately. |

### Per-run side-by-side summary

| Case/run | DeepSeek v6 C/W/D | Sonnet C/W/D | DeepSeek accepted rewrites W/total | Sonnet accepted rewrites W/total | Sonnet narrow checks | Changed behavior |
| --- | --- | --- | --- | --- | ---: | --- |
| 2/1 | 10/1/2 | 12/1/0 | 1/5 | 1/1 | 0 | Stale #17639 merge persists; other consolidations become separate facts/skips. |
| 2/2 | Same single frozen baseline | 12/1/0 | Same baseline | 1/1 | 0 | Same effective action/target sequence as run 1; append wording differs. |
| 2/3 | Same single frozen baseline | 13/0/0 | Same baseline | 0/0 | 0 | Safe new rather than stale merge; #17639 still not repaired. |
| 12/1 | 9/0/1 | 8/1/1 | 0/3 | 1/2 | 0 | Correct conflict becomes wrong merge; covered retention becomes debatable merge. |
| 27/1 | 13/0/0 | 13/0/0 | 0/2 | 0/1 | 0 | Correct tag/hook merge retained; permission update becomes safe new. |
| 35/1 | 2/0/1 | 2/0/1 | 0/0 | 0/0 | 1 (no) | Same unsafe raw proposal, safely vetoed. |
| First repetitions + controls | 34/1/4 (39 decisions) | 35/2/2 (39 decisions) | 1/10 | 2/4 | 1 | More correct abstentions, but two wrong accepted rewrites. |
| All six planned runs | Not a six-run baseline | 60/3/2 (65 decisions) | — | 3/5 | 1 | No successful #17639 repair. |

## Control resulting memory texts

### Case 12 run 1, fact 9 — merge #16288, debatable

All six original clauses remain verbatim. The supported incident details do not make a previously unknown one-week retention value new; this is a debatable consolidation, not a clear improvement over `skip`.

```text
`bun run build:dists` deletes the plugin dists' entry files (index.js, v2/server.js, workers) before rebuilding; `scripts/clean-dist-chunks.mjs` keeps split chunks younger than a week, because long-running OpenCode, Pi and worker processes load the plugin from the dev checkout and lazily import old `index-<hash>.js` chunks (deleting them causes 'Cannot find module' in a running Pi; since 2026-10-03 the plugin reports that once with "/reload" or "restart the host" guidance). Every dist deploy must MERGE, never replace: no `rsync --delete`, no `rm -rf dist`, no directory mv. `scripts/restart-window.sh` and both packages' `clean` scripts were fixed to age-prune with clean-dist-chunks then copy without --delete. If a build then fails (e.g. a merge-conflict marker in source), the checkout has no entry files and every new seat fails to load Magic Context until a rebuild succeeds (bit 2026-09-04). Never chain `git merge && build:dists`: run typecheck (or at least `git diff --check`) between them, and treat a failed build:dists as a live incident: rebuild from the last good commit immediately. Plugin build chunk retention: 1 week, so a stale host process (e.g. a Pi head started before 2026-10-03) can still reference an old chunk such as index-72g30tgz.js that the current dist no longer references; a /reload or host restart loads the current dist.
```

### Case 12 run 1, fact 10 — merge #23179, wrong

This reconstructed control requires `conflict`. The transcript's “stops”/“cut off” wording does not settle whether the command process dies or merely detaches. Sonnet keeps detachment as true and appends cutoff without retaining an explicit conflict link.

```text
In AFT worker sessions, blocking foreground commands enforce a 30-minute maximum execution ceiling before detaching to the background. A foreground command is cut off at 30 minutes regardless of a longer command timeout, so long compiles and test runs must be started in the background (bash background:true) with a long timeout.
```

### Case 27 run 1, fact 6 — merge #23505, correct

All five original clauses survive verbatim; the fenced-code-only distinction is supported complementary information.

```text
On OpenCode 2, model-written §N§ tags stay visible in the saved transcript because no OC2 plugin hook runs between the parsed reply and persistence (OC1 strips them via experimental.text.complete). Tracked upstream as anomalyco/opencode#53019 (display hook preferred, text.complete equivalent as fallback), filed 2026-10-03; our issue #613 stays open for it. When users report tags in the OC2 transcript, point them to #613 / ask for a 👍 on #53019; don't strip via http.response stream rewriting (provider-specific, fragile). OpenCode 2 only exposes render hooks for fenced code blocks, so plugins cannot transform assistant text for display or on completion.
```

### Case 27 run 1, fact 13 — new, correct storage but not a repair

The separate inserted fact appears as New 27:13 below. Unlike DeepSeek's accepted edit of clause c3 (the OC1-only enforcement consequence), Sonnet leaves this complete old #19889 text unchanged, including the obsolete OC1-only consequence:

```text
OpenCode 2 provides no client in plugin hooks to read agent permissions, and Pi lacks per-agent permission models, restricting agent permission-denial enforcement (such as ctx_reduce suppression) to OpenCode 1.
```

### Case 35 run 1, fact 3 — raw update #23094 wrong; effective new correct

Raw proposed text (rejected because it removes the unsupported 64 KiB bound; shown to distinguish proposal from effective storage):

```text
ck-mc reply paging (>512 KiB payload, split into pages sized by escaped JSON wire bytes rather than raw string length) is opt-in per consumer, preserving unpaged single-frame replies for legacy callers like Broca and the Claude Code gateway that do not support paged reassembly.
```

The narrow check used the unchanged v6 question and the exact supplied evidence, “Pages are now cut by their escaped size, so the same reply fits in a handful.” Its answer was:

> No. The passage only says pages are now cut by their escaped size, which changes how pages are sized and says nothing about whether paging is opt-in per consumer or whether legacy callers still get unpaged single-frame replies.

Resulting #23094 is unchanged, including **64 KiB**, the >512 KiB threshold, opt-in and legacy exceptions:

```text
ck-mc reply paging (>512 KiB payload split into 64 KiB frames) is opt-in per consumer, preserving unpaged single-frame replies for legacy callers like Broca and the Claude Code gateway that do not support paged reassembly.
```

The separately inserted text is the exact original fact 35:3 in the catalogue below. No caller/transport bound was inferred to have changed.

## Exact simulated new texts

These are the **complete texts** inserted by every effective `new` in the side-by-side ledger, not rewritten model rationales. Repeated case-2 decisions use the same text for all listed runs. Existing candidates remain unchanged when `new` is chosen. `skip` changes no memory and inserts nothing.

### New 2:1 — runs 1, 2, 3

```text
Published CortexKit sibling crates are consumed from crates.io; the unpublished `subc-core` is pinned to a fixed git revision, never a sibling checkout path.
```

### New 2:2 — runs 1, 2, 3

```text
CI must fail if any Rust dependency (including transitive) resolves to a path outside the repo root; the check reads `cargo metadata --locked` resolution, uses a distinct "violation found" exit code, and self-tests against planted violations.
```

### New 2:3 — runs 1, 2, 3

```text
Keep `cortexkit-role-llm-runner` unpublished and consumed via a pinned git commit until its contract matches the wire Prefrontal actually sends.
```

### New 2:4 — run 3 only

```text
ck-mc's historian producer talks to Broca's model runner with hand-built JSON rather than the `cortexkit-role-llm-runner` contract crate, and only when the historian is configured to run on Broca (the default runs it in the host).
```

### New 2:5 — runs 1, 2, 3

```text
Idle-gap markers are stored per message and materialize only on a cache-rebuilding pass; non-rebuilding passes replay the stored markers byte-identically.
```

### New 2:6 — runs 1, 2, 3

```text
The compaction-marker fence's fault-recovery rebuild request must carry its command name inside the JSON body the daemon reads, with the client deriving it from the call.
```

### New 2:10 — runs 1, 2, 3

```text
Idle-gap marker format: `<!-- +5m -->` (time since the last reply).
```

### New 2:12 — runs 1, 2, 3

```text
Offline repair command for a damaged git FTS map: `doctor git-fts-map --repair`.
```

### New 2:13 — runs 1, 2, 3

```text
The dashboard Config page's tool-protection editor is named `protected_tools`, replacing the earlier Smart Drops toggle.
```

### New 12:1 — run 1

```text
When a worker's "finished" notice arrives immediately after I answer that worker's question, send a work prompt to check liveness instead of settling the item.
```

### New 12:2 — run 1

```text
Run long compiles and test runs in the background (bash background:true with a long timeout) rather than in the foreground.
```

### New 12:3 — run 1

```text
Rust-mode request-path fixes must preserve the exact bytes sent to ck-mc; fixes that would change those bytes are out of scope.
```

### New 12:4 — run 1

```text
Bun already runs SQLite in WAL mode with `PRAGMA synchronous=NORMAL`, so setting `synchronous=NORMAL` only affects Node hosts (Pi on Node, Desktop).
```

### New 12:5 — run 1

```text
`ck-mc` second (smaller) in-memory cache size: 256 MiB.
```

### New 12:6 — run 1

```text
Debug-only assertions in the Pi pass path are gated behind the `MAGIC_CONTEXT_DEBUG_ASSERTIONS` environment variable.
```

### New 12:8 — run 1

```text
Shared running-ck-mc declaration path: `~/.local/share/cortexkit/staging/magic-context.current`.
```

### New 27:3 — run 1

```text
The historian chunk renderer prints each tool call as a single line (`TC: …`, one key argument cut at 60 chars) and drops tool calls entirely when the assistant message also has text; `historian.expand_tools` adds template-rendered lines for tools that declare an expansion, leaving unexpanded read/grep noise unchanged.
```

### New 27:4 — run 1

```text
Historian expansion templates ship as a single set of default templates read by both the TypeScript and Rust engines, which must render byte-identically and are held together by shared golden fixtures.
```

### New 27:5 — run 1

```text
The intended end state is for each tool provider to declare its own historian summary template (and, later, how its tools render in UIs) in its tool catalog, with user config only overriding — so no one hand-maintains templates for other modules' tools.
```

### New 27:7 — run 1

```text
historian.expand_tools: map keyed by tool name; a tool set to `false` disables its expansion.
```

### New 27:8 — run 1

```text
Historian expansion character caps: 300 characters per placeholder value, 1,000 characters per expansion line.
```

### New 27:9 — run 1

```text
Tools with shipped historian expansion defaults: ask, peer_send, board, room, work, knowhow, question, task, todowrite, ctx_note, ctx_memory.
```

### New 27:10 — run 1

```text
Historian expansion list rendering: at most 10 elements then "… +N more"; an array used without [N]/[*].field/.each/.join/.count falls back to compact JSON under the cap.
```

### New 27:11 — run 1

```text
ctx_expand shows historian tool expansions only in its verbose listing; default output is byte-identical to before.
```

### New 27:12 — run 1

```text
Historian expansion template language: `${input.x}` / `${output.x}` field paths only (no expressions, missing fields render empty), plus `.truncate(N)`.
```

### New 27:13 — run 1

```text
OpenCode 2 determines whether an agent can use ctx_reduce from the tool set the host has already filtered for that agent, so a denied ctx_reduce is no longer advertised to the model.
```

### New 35:1 — run 1

```text
Hotfix ck-mc builds are cut from the last placed build plus only the specific fix commits, leaving all other pending work out of the hotfix.
```

### New 35:2 — run 1

```text
OpenCode's project-ID migration fails with `no such column: project_id` when a project's git root commit changes (e.g., after a history rewrite), so OpenCode cannot load that project until it is recovered.
```

### New 35:3 — run 1

```text
ck-mc reply pages are now sized by escaped JSON wire bytes rather than raw string length, avoiding excessive fragmentation and sequential page-fetch round trips.
```

## Provider tokens and USD cost

Sonnet counters are returned by the Messages API, not estimated: `input_tokens`, `output_tokens`, and `output_tokens_details.thinking_tokens`. Thinking is **included in output**, not added again. All eight actual completions report **zero cache reads and zero cache writes**, standard service tier and global inference. No first-turn spend is included.

Cost is a **list-price calculation, not an invoice**: Sonnet 5.5's current official base rates are **$2/MTok input and $10/MTok output** ([Anthropic pricing](https://docs.anthropic.com/en/docs/about-claude/pricing), consulted 2026-10-08). Thus `USD = (2 × input + 10 × output) / 1,000,000`. There are no tools, paid server searches or cache charges. DeepSeek's frozen v6 report records tokens but **no monetary amount or frozen price schedule**; its cost is therefore not retroactively invented here. Cross-provider token counts use different tokenizers and are not normalized work units.

| Call | Input | Output (includes thinking) | Thinking subset | Total tokens | Cost USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Case 2 run 1 second | 90461 | 1621 | 0 | 92082 | 0.197132 |
| Case 2 run 2 second | 90461 | 1520 | 0 | 91981 | 0.196122 |
| Case 2 run 3 second | 90461 | 966 | 0 | 91427 | 0.190582 |
| Case 12 run 1 second | 92408 | 1885 | 0 | 94293 | 0.203666 |
| Case 27 run 1 second | 85667 | 2573 | 1149 | 88240 | 0.197064 |
| Case 35 run 1 second | 64802 | 675 | 0 | 65477 | 0.136354 |
| Case 35 run 1 narrow 3/c1 | 225 | 71 | 0 | 296 | 0.001160 |
| **Planned six runs, including narrow check** | **514485** | **9311** | **1149** | **523796** | **1.122080** |
| Setup pilot case 2 second | 89564 | 882 | 0 | 90446 | 0.187948 |
| **Actual total, including setup pilot** | **604049** | **10193** | **1149** | **614242** | **1.310028** |

### Per-case cost and token comparison with DeepSeek Flash v6

The DeepSeek baseline has one case-2 run, not three. Rows include each case's actual narrow-check spend, with its primary counts displayed separately.

| Case/run | DeepSeek primary input/output | DeepSeek all calls: total tokens | DeepSeek cost USD | Sonnet primary input/output | Sonnet all calls: total tokens | Sonnet cost USD |
| --- | --- | ---: | --- | --- | ---: | ---: |
| 2/1 | 57589 / 16004 | 75002 | Not recorded | 90461 / 1621 | 92082 | 0.197132 |
| 2/2 | Same single frozen baseline | — | — | 90461 / 1520 | 91981 | 0.196122 |
| 2/3 | Same single frozen baseline | — | — | 90461 / 966 | 91427 | 0.190582 |
| 12/1 | 59287 / 8183 | 67470 | Not recorded | 92408 / 1885 | 94293 | 0.203666 |
| 27/1 | 54552 / 8837 | 63927 | Not recorded | 85667 / 2573 | 88240 | 0.197064 |
| 35/1 | 41534 / 8568 | 50545 | Not recorded | 64802 / 675 | 65773 | 0.137514 |
| **One run per case** | **212962 / 41592** | **256944** | **Not recorded** | **333338 / 6754** | **340388** | **0.735376** |

Sonnet chose fewer rewrites and more separate `new` facts, requiring fewer clause inventories and narrow calls. Shorter outputs do not demonstrate better memory reconciliation, and output-length differences cannot be attributed solely to action choice. Native schema overhead is also billed as input: the setup pilot has 897 fewer input tokens than the final case-2 request. Default adaptive thinking is not forced to use any minimum deliberation.

## Retained artifacts and reproducibility

Raw redacted requests, full responses, exact usage, source hashes, captured model metadata, simulated patch results and independent grades are saved outside Git alongside the DeepSeek specimens:

`~/.local/share/cortexkit/magic-context/specimens/merge-turn-v6-sonnet/`

- `model.json`: direct API model capabilities and identity.
- `case-{2,12,27,35}-frozen.json`: frozen-file hashes, message-content hashes, complete selected facts/candidates and transcript.
- `case-2-run-{1,2,3}-second.json`, `case-{12,27,35}-run-1-second.json`: full request bodies with redacted headers, complete responses and usage.
- Matching `*-applied.json` and `*-judgments.json`: original v6 evaluator output and independent grades/reasons. `new` uses the frozen fact, never the model's rationale.
- `case-35-run-1-contradiction-3-1.json`: the only planned narrow check, including its exact prompt, response and usage.
- `pilot-case-2-*`: the pilot with string-valued claims/edits instead of arrays; validation retained every candidate unchanged and fell back to separate original facts.
- `harness/`: archived v6 evaluator sources and the direct-API runner; no product source is modified or installed. Replays use saved responses and make no network calls.
- `usage-ledger.json`, `verification.json` and `verification.log`: per-call cost calculation and report/capture verification evidence, outside any regenerable build directory.

Directories are owner-only (0700); artifact files are owner-only (0600). No raw capture, candidate corpus, credential, database, temporary runner or product code is committed. The report includes complete resulting memory texts so each simulated change can be reviewed; the complete transcript/candidate corpus stays private.

## Verification and limits

Report/capture comparisons and evaluator verification (Bun **1.4.2**, Python **3.9.6**):

- Remote Linux `timeout 180s bun test ./.sonnet-trial-source/packages/plugin/scripts/historian-merge-turn-trial/v6.test.ts`: **11 tests / 79 assertions**, passed. These are the unchanged v6 tests recovered from Git; no tests were rewritten. An initial command without the leading `./` matched no files and failed; the explicit-path invocation above ran all 11 tests.
- Captured-only `sonnet-trial.ts replay <case> <run>` for all **six runs / 65 decisions / one narrow check**: passed. It recomputes application through the original v6 evaluator and requires equality with each saved applied result; no API request or credential read occurs during replay.
- Private `verify-sonnet.py`: **four checks**, passed: **65 Sonnet decisions plus 39 unique DeepSeek table rows**; **29 exact new-text blocks and five accepted rewrite texts**, plus unchanged/rejected target texts; **eight actual calls' tokens and costs**; owner-only artifact permissions, header redaction, no literal credential, and completion before expiry. The comparison checks actual report cells and text against saved captures, not generated proxies against themselves.
- An intentional false-grade mutation (**NON-VACUITY BREAK**) changes the case 2:4 run-1 report grade from W to C to prove the comparison detects disagreement with saved evidence. `Sonnet report decision table agrees with captures` failed as expected; the memory-text, token-cost and redaction checks all remained green (3 passed / 1 failed). Restoring the staged report returned the unstaged diff to empty and all four checks to green; mutation details and outputs are retained with the private evidence.
- Scoped AFT inspection is **partial**, because Markdown has no registered diagnostic producer; no clean LSP diagnostic claim is made. Product typecheck/build/lint are not rerun: the only committed change is this report, and the supplied frozen install/build already passed. Report/capture comparisons and evaluator tests are the relevant gates.

Only the report is committed. The scratch harness is removed from this task worktree after its sources and verification evidence are retained in the owner-only `merge-turn-v6-sonnet/` specimen directory above.

Other limits remain those of v6: the frozen active-status/creation-cut candidate set cannot reconstruct missing historical revisions; controls include reconstructed rather than model-extracted facts; grades are a single-reviewer interpretation, not an inter-rater study. The schema mapping and provider-default thinking differ from DeepSeek JSON/high-effort settings. The rejected setup pilot is disclosed, not evidence of a successful stable run. **The observed answer is nonetheless unambiguous for the requested target: zero repairs in three planned repetitions, two accepted stale merges, and an additional wrong control merge. Keep automatic destructive memory writes off.**
