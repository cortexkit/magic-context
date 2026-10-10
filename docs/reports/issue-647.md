# Issue 647: hidden completion refusal and the Pi/OMP transport boundary

## Investigation status

Investigated from master `e5b5bc670c679fad3a6b92a81295dac29719408a`.
The reported error is an **OpenCode 2 hidden-executor diagnostic**, not a
Pi/OMP subprocess-runner diagnostic. A real OMP 18.8.6 child-route probe
succeeds for retrospective, curate, map-memories, verify and classify-memories.
Promote-primers is host-only: it does not dispatch a model or a child hook.
This does not establish which process wrote the reporter's rows; no live
stores or user configuration were inspected.

Because the refusal is OpenCode 2-specific, the investigation also tested
OpenCode 2.0.24. Same-directory carrier probes and all six full production
manual task commands succeed. A two-directory real timer scenario also
executes retrospective search and curate memory updates without this refusal;
a location without an OpenCode user session skips child-requiring tasks
instead of borrowing another location's parent. No setup-path defect has
been established. This change therefore improves the diagnostic and adds
coverage, without a speculative ownership or OMP compatibility repair.
The quoted error means that the OpenCode 2 context hook never supplied the
child's task prompt. It does not establish an OMP bug. Keep issue 639's
before-provider refusal, child-location check and tool/permission fences;
removing those protections could give an unprepared background turn the
user's file-editing permissions.

## Exact raising and calling paths at the investigation base

- The exact text `Host did not dispatch the hidden child context hook` occurs
  at `packages/plugin/src/v2/hidden-completion.ts:687-692`. After prompting,
  waiting, and obtaining a new assistant row, the v2 executor refuses an
  attempt whose `shaped` flag was never set. The flag is set only by
  `HiddenChildHook.apply`, at
  `packages/plugin/src/v2/hooks/hidden-child.ts:607-609`.
- The ordinary v2 context pipeline invokes that hook first at
  `packages/plugin/src/v2/hooks/context.ts:1337`; the per-instance executor
  is constructed with that same hook and instance directory at lines
  759-795. The v2 server locks its harness to `opencode2`
  (`packages/plugin/src/v2/server.ts:26-52`).
- The Pi dreamer instead creates process-local ids
  `magic-context-pi-dream-N`, extracts the complete system/user prompt, and
  calls `PiSubagentRunner.run`
  (`packages/pi-plugin/src/dreamer/index.ts:538-611`). Its shared timer
  registration supplies this facade, not a v2 hidden executor (294-322).
  The runner writes a system-prompt file (1298-1323), passes
  `--system-prompt` (2610-2620), and spawns in the requested cwd
  (`packages/pi-plugin/src/subagent-runner.ts:1450-1492`). There is no v2
  hidden-child context-hook handshake in that path.
- The reported `ses_edff...` child id is consistent with OpenCode's ids,
  not the Pi facade's synthetic ids. The issue's project being used in OMP
  does not establish that OMP owned a particular background run. A second
  OpenCode process using the project is a possibility, not a verified fact.

## Task differences and placement

| Task | Child role / behavior |
| --- | --- |
| retrospective | `dreamer-retrospective`; cheap friction gate and, on a hit, a second deepen turn; `ctx_search` |
| curate | `dreamer`; applies memory operations through `ctx_memory` |
| map-memories | `dreamer-memory-mapper`; read-only source investigation |
| verify | `dreamer-memory-mapper`; read-only source investigation |
| classify-memories | `dreamer-classifier`; zero-tool classification |
| promote-primers | host-only storage work, no child completion |

Pi tool profiles are at `packages/pi-plugin/src/subagent-runner.ts:637-712`;
OMP built-in filtering is at 724-784. Retrospective and curate load the lean
ctx-tool extension, but both still receive the runner's authored system and
user prompts, not a hidden marker.

On v2, retrospective opens with `directory: deps.sessionDirectory`
(`packages/plugin/src/features/magic-context/dreamer/task-executor.ts:1479-1494`)
and supplies the system again on each turn (1520-1532). Curate's `docsDir`
is just `deps.sessionDirectory` (1838-1843); it passes that to the single-shot
helper (1998-2016), which forwards it to `executor.open`
(`packages/plugin/src/features/magic-context/dreamer/hidden-single-shot.ts:62-95`).
There is no source evidence of these two tasks selecting a different root.

The issue 639 event guard checks directory and workspace before passing a
parent to a dream task (`packages/plugin/src/v2/hooks/dream-trigger.ts:28-41,
107-118`). A parented native child inherits its parent's location;
`createNativeHiddenChildren` reads it back and removes/refuses a child in
another instance directory before prompting
(`packages/plugin/src/v2/hidden-child-native.ts:112-140,148-183`). These guards
must remain intact. A refused, unshaped turn must never reach the provider
with tools. The post-completion `!shaped` check is additional detection, not
a substitute for the before-provider or tool-call guards.

## Fallbacks

The hidden refusal is deliberately terminal, not a provider error:
`packages/plugin/src/shared/model-suggestion-retry.ts:367-374,409-417`.
Dream failure telemetry classifies it as `local_refusal` and records the
reason (`packages/plugin/src/features/magic-context/dreamer/task-executor.ts:235-255`).
For a deterministic missing setup/ownership stage, another model follows
the same path and cannot repair it. Keep this failure terminal; a one-model
`models_tried` list is the expected safety behavior, not dead fallback
configuration. Provider/model failures should still use their existing chain.

## Real-host captures and isolation

All host installs and runs used `$TMPDIR/magic-context/issue-647/`, with
private HOME, XDG data/config/state/runtime/cache, host database and Magic
Context storage. Hosts used loopback mock providers and fake keys. No live
stores were opened, including for snapshots. Captured `lsof -Fn -p <pid>`
output shows only throwaway `.db`, `-wal` and `-shm` paths.

Evidence root on this machine:
`/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-647/evidence/`.
These files are outside build/cache directories.

- `omp-routes.log`: OMP **18.8.6**, Bun **1.4.2**, five production
  `PiSubagentRunner` child profiles, each one successful mock completion.
  The provider receives the exact `ISOLATED <task> SYSTEM` and
  `ISOLATED <task> USER` text. This is a prompt-route test, not a test of
  each task's output parser or scheduling gate. `omp-<pid>-lsof.txt` records
  each child (31877, 32110, 32193, 32214, 32274).
- `v2-routes-split.log`: OpenCode **2.0.24**, pid **62014**, single-directory
  real-host probe using the production hidden executor/hook. Retrospective,
  mapper, verifier and classifier carrier attempts complete; the probe's
  full curate task executor completes on one seeded memory. The hook sees
  the carrier markers, then the provider sees authored task prompts and
  scoped tools. `v2-lsof.txt` records only the fixture's OpenCode and
  Magic Context databases.
- A first single-file probe bundle could not load because Bun 1.4.2 emitted
  an undefined `__promiseAll` helper. ESM splitting, as used by shipped
  bundles, fixed the probe packaging. This was not a dream-task refusal.

All OpenCode launches also use the harness's pre-return `lsof` process-group
inventory and database-inode check
(`packages/e2e-tests/src/opencode2-runner/spawn.ts:498,577-622`), including
unsuccessful probe-loading attempts. Operational scenarios retain the raw
inventories named below; a failed probe load never selected a live root.

- `production-v2-manifests.log`: full shipped-plugin `/ctx-dream` commands on
  OpenCode **2.0.24**, pid **89261**. Five real user sessions; ten seeded
  memories. All six tasks complete: retrospective banks five sessions,
  map-memories banks ten mappings, verify banks ten verifications, classify
  banks ten classifications. Curate makes a no-op pass; promote-primers has
  no candidates in this first scenario. This is not a tool-work proof for
  retrospective/curate; the subsequent scenario supplies that.
- `scheduled-v2.log`: real startup timer, OpenCode **2.0.24**, pid **12036**,
  two locations. Retrospective invokes production `ctx_search` and curate
  applies one production `ctx_memory update`. The second location has ten
  OMP-attributed memories but no OpenCode user session: mapper, verify,
  curate and classifier record `skipped`, `parent_session_id=null`, with
  `no session in this directory to hold the run's child session`.
  Retrospective has no eligible raw sessions there. This exploratory
  fixture returned empty mapping/classification manifests because its ID
  selector assumed XML attributes, whereas the prompt uses `[ID]` lines;
  those two outcomes were unrelated `incomplete` failures, not hidden-hook
  refusals. The checked-in regression uses the known seeded IDs instead.
- `native-final.log` and the fixture's `issue-647-proof.json`,
  `issue-647-lsof.txt`, `issue-647-plugin.log`: the checked-in production
  regression covers all six manual task commands, then the real startup
  timer in two locations. Its mock gate names the actual user ordinals,
  including fresh post-watermark lines; it does not mistake old overlap
  friction for new work. It requires actual `ctx_search` tool-result
  continuation and a completed `ctx_memory update` on both manual and
  scheduled retrospective/curate turns. OMP-attributed primer candidates in
  the second location exercise host-only promotion without a parent.

## What remains un-reproduced; precise follow-up

The reporter's **repeated, task-selective** refusal was not reproduced on
OMP 18.8.6 or OpenCode 2.0.24 in the tested routes. The same-directory,
manual, scheduled, two-location, tool-work and no-parent cases did not
produce the quoted failure. Specifically:

- The OMP probe uses a mock Anthropic-messages provider, not the reporter's
  `opencode-go/muse-spark-1.3-contributor` or provider extension chain.
  It proves child prompt delivery, not the reporter's entire OMP task data
  or all possible discovered extensions.
- The OpenCode scenario uses mock OpenAI responses with no provider auth
  extensions. The reporter's model/provider configuration is unknown.
- The second location's OMP attribution is a fixture: seeded memories and
  primer candidates, not copied live OMP JSONL history. OpenCode's raw
  retrospective provider deliberately selects only `opencode2` root
  sessions (`packages/plugin/src/v2/retrospective-raw-provider.ts:33-46`).
  An OMP-only project therefore cannot reproduce an OpenCode retrospective
  child merely by having memories. The backlog count is broader than the
  raw-provider filter; that is not evidence of a missing context hook.
- OpenCode's process-wide timer iterates **registered locations**, not
  arbitrary project rows in the shared store
  (`packages/plugin/src/plugin/dream-timer.ts:400-409,658-690`). The test
  explicitly activates the second location but creates no user session
  there. No cross-directory parent is selected. The timer's parent lookup
  and task gate skip child work with no root session
  (`packages/plugin/src/v2/hooks/dream-timer.ts:12-40`;
  `packages/plugin/src/features/magic-context/dreamer/task-executor.ts:739-756`).
- No restart/reload of an in-flight run, workspace-specific routing, stale
  released bundle, or the reporter's exact project config was replicated.
  Their runtime logs and executable provenance remain necessary.

Suggested follow-up to the reporter on issue 647 (draft only; not posted):

> Please share the OMP version and the OpenCode 2 version (if another host
> also has this project open), and the Magic Context lines around one
> failed retrospective/curate run, including the runtime harness label and
> plugin version from that same process. Which host pid launched the child,
> and was the run manual or timer-driven? The quoted refusal is emitted by
> the OpenCode 2 hidden executor, whereas OMP uses a subprocess system prompt.
> With the improved diagnostic, please include task, child, directory and
> stage. A sanitized project configuration and the child's reported
> location/parent would distinguish a routing mismatch from a stale or
> missing plugin hook. Do not send database contents or provider credentials.

There is no established OMP host defect to report upstream, so no upstream
bug note or compatibility shim is included.

## Delivered change and regression/mutation coverage

The existing terminal refusal now includes `task`, `agent`, `child`,
`directory`, and `stage=context/HiddenChildHook.apply`. The stage names the
OpenCode context callback and Magic Context's task-prompt substitution
method. Each directory has its own plugin instance, so a child's owning
location must load the instance that registered its attempt; the message
points users there instead of suggesting a model change. No guard,
permission rule, retry policy, trigger scope or child-placement rule changed.

`packages/plugin/src/v2/hidden-completion.test.ts` simulates a host that
settles without dispatching its context hook. Before the diagnostic change,
`names retrospective and curate at the missed context-shaping stage without
model fallback` fails because the message has no task. After the change it
requires both tasks' stage/identity, typed terminal refusal, `local_refusal`,
exactly one model tried and exactly one child/attempt. This is a regression
for the diagnostic and terminal refusal, not a claim that the reporter's
missing-dispatch cause has been reproduced or fixed.

`packages/e2e-tests/tests/opencode2/dreamer-task-context.test.ts` is the
six-task production-host and timer/location control described above.
The original issue 639 guards remain covered by their existing tests.

Safe mutations staged the live implementation first, confirmed an empty
unstaged diff, temporarily disabled one refusal condition to check that its
named test would fail, restored from
the index with `git checkout -- <path> && touch <path>`, and confirmed the
unstaged diff was empty again:

1. Let a curate attempt whose context hook never supplied its task prompt
   escape the executor's final, non-retryable refusal:
   **29 pass, 1 fail**. Only the new named diagnostic/terminal-refusal
   regression failed.
2. Pass an unowned hidden-agent turn into the ordinary context pipeline:
   **8 pass, 1 fail**. Only `is refused before the provider with
   hidden_prompt_unrecognized, for every hidden agent id` failed; compaction,
   ordinary sessions, tool-call allowlists and permission-rule controls
   stayed green. This checks issue 639's independent before-provider fence.

## Baseline gates

Linux, Bun **1.4.2**, fresh throwaway HOME/XDG/storage, `OPENCODE_DB` unset,
package test scripts (including frozen install), before changes:

- Plugin: **7428 pass, 9 skip, 42 fail**, 7479 tests / 733 files.
- Pi: **1540 pass, 3 skip, 144 fail**, 1687 tests / 166 files.

A repeated exact-master source control returned the complete normalized
failure sets (rather than relying on remote job-local temp files):
**7427 pass, 9 skip, 43 fail** for plugin and **1539 pass, 3 skip, 145 fail**
for Pi. The variation from the first run is baseline nondeterminism, not an
implementation change. The captured master sets are retained locally as
`evidence/baseline-failures.json` under the evidence root above. Final suites
are compared by test name against that control, not declared green simply
because the roughly 144 Pi failures were expected.

## Final verification

- Linux `bun run build`: passed, Bun **1.4.2**; plugin, Pi and CLI bundles,
  generated TUI output and declaration emit completed. No generated tracked
  output drift or manifest/lockfile change.
- Linux `bun run typecheck`: passed, TypeScript **5.9.3**, all four package
  scripts. Narrow E2E typecheck of the new scenario and its imports also
  passed with the repository's E2E tsconfig and explicit workspace
  `typeRoots` (the first temporary config outside the workspace could not
  resolve `bun-types`; this was a check-setup error, not a source error).
- Linux `bun run lint`: passed, Biome **2.5.1**; **1711 files** checked across
  the four packages. Existing warnings/infos remain. The first lint run
  identified one formatting error in the new unit test; it was corrected.
- Linux focused hidden-completion, native-child and foreign-child suites:
  **57 pass, 0 fail**, Bun **1.4.2**. This includes the diagnostic regression
  and unchanged child-placement, pre-provider, permission and tool guards.
- Native macOS real-host gate, because it uses `lsof` and the locally
  installed OpenCode **2.0.24** binary: `bun run --cwd packages/e2e-tests test
  tests/opencode2/dreamer-task-context.test.ts
  tests/opencode2/hidden-child-foreign-location.test.ts`: **4 pass, 0 fail**,
  **100 assertions**, Bun **1.4.2**. The three original issue 639 host
  scenarios remain green, including foreign-location suppression, allowed
  read-only mapping and live dreamer-disable behavior. The new scenario's
  artifact root is `mc-opencode2-n421Oz` under the evidence root's parent.
  Host pids 10712, 22152, 22764 and 23021 each have isolated `lsof` captures.
- Final Linux plugin suite: **7429 pass, 9 skip, 42 fail**, 7480 tests / 733
  files. **No new failure names** against the 43-failure exact-master
  control. Only the baseline's timing-sensitive `slow embedding aborts at
  the deadline, freezes skip bytes, and cannot land late` is no longer
  failing. Final name-set SHA-256:
  `756abcdd78e3ccd4becaa34bc316ca1f220ce8b595ea7880e2b44ce9acf76391`;
  baseline: `95a1d31bd3dacb1f19c9e517eec77e3875767e3865d8f48ff6679f5b73d2361e`.
- Final Linux Pi suite: **1540 pass, 3 skip, 144 fail**, 1687 tests / 166
  files. **No new failure names** against the 145-failure exact-master
  control. Only `Pi aborts slow embeddings at the deadline and replays
  byte-identical skip on retry` is no longer failing. Final name-set SHA-256:
  `b2673b38eba026dcc97c71f609c3bec337f36486825131597c3ae096fd2166d3`;
  baseline: `6c6c4e08ef33aef5e450f8bfa45ea989e02f81cdf52ec27f32191c5f6bf5f16c`.

Complete normalized master/final name sets and comparison summaries are in
`evidence/{baseline-failures,final-failures,failure-comparisons}.json`.
These are independent captures from master and delivery-source runs, not a
comparison of a file with itself.

The final gate chain was interrupted by a worker-run cancellation after the
plugin summary; completed lint/typecheck/plugin results were retained.
Only the unfinished Pi suite was resumed, not the already-completed gates.
