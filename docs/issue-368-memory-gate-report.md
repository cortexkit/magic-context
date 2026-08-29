# Issue #368: `memory.enabled` user-profile leak report

## Scope and finding

Issue #368 is valid. `memory.enabled: false` already disables project-memory reads and most memory work, but before this fix it did not consistently disable every memory-derived prompt surface. In particular, the OpenCode TypeScript and Pi materializers loaded active global user memories without consulting the memory gate, so they could emit `<user-profile>` in m[0] and `<new-user-profile>` in m[1]. Mural rendering was similarly independent of the memory gate in all three materializers.

`<user-profile>` is not a system-prompt adjunct. `ARCHITECTURE.md` defines two synthetic head `user` messages: m[0] contains the baseline profile and m[1] contains profile deltas. OpenCode inserts those messages in `inject-compartments.ts` (`prependM0M1Messages`); Pi has the same m[0]/m[1] materializer; the Rust module composes the same layout. `system_prompt_injection.skip_signatures` only examines the existing system prompt in `system-prompt-hash.ts`, so it cannot select, remove, or filter content in those m[0]/m[1] message slots.

## Gate matrix before the fix

| Surface | OpenCode TypeScript | Pi | Rust module |
| --- | --- | --- | --- |
| `ctx_memory` tool | Registration omits the tool when `memory.enabled` is false (`plugin/tool-registry.ts`). | Pi registers once because `/cd` can change projects, but the per-call `ctx_memory` guard refuses in a memory-off project (`index.ts`, `tools/ctx-memory.ts`). | No host tool-registration surface; `McModuleConfig.memory_enabled` is supplied by the binding and gates module-backed memory work. |
| Memory guidance | `system-prompt-hash.ts` passes `memoryEnabled` to the guidance builder, removing `ctx_memory` guidance. | `system-prompt.ts` does the same. | The host-provided system prompt hash is part of the module render identity. |
| Project-memory m[0] | Gated indirectly: `transform.ts` passes no `projectPath`, making memory queries empty. | Gated by `memoryProjectPath`, which returns `undefined`. | Gated directly in `compose_m0_from_store`: no memory snapshot when `memory_enabled` is false. |
| Project-memory additions and `<memory-updates>` m[1] | Gated indirectly by absent `projectPath`. | Gated by absent `memoryProjectPath`. | Gated directly by `memory_enabled` in `compose_m1_from_store`. |
| Memory mural | **Not gated.** An explicit or resolved mural could still be folded into m[0]. | **Not gated.** `resolveMuralForM0Pi` only checked mural configuration and model capability. | **Not gated.** `resolved_mural` accepted the request mural independently of `memory_enabled`, including the additive-only path. |
| `<user-profile>` baseline m[0] | **Not gated.** `materializeM0` and its non-persisted fallback unconditionally called `safeGetActiveUserMemories`. | **Not gated.** `renderM0Pi` and `readFrozenM0InputsPi` unconditionally read active user memories. | Already gated in both normal m[0] composition paths. |
| `<new-user-profile>` delta m[1] | **Not gated.** `renderM1WithMetadata` only compared the global profile version. | **Not gated.** `renderM1PiWithMetadata` only compared the profile version. | Already gated in `compose_m1_from_store`. |
| User-observation collection and review | Independent generation gate: `userMemoryCollectionEnabled` is true only when `dreamer.tasks.review-user-memories.schedule` is non-empty. | Same shared task configuration is forwarded to the Pi historian/dreamer. | `user_memory_collection_enabled` is independently parsed and forwarded to historian validation. |

The current Dreamer-v2 name for the legacy `dreamer.user_memories.enabled` control is the `review-user-memories` task schedule. It controls collection/review (generation), not rendering. Therefore disabling that task prevents new candidates/promotions, but on v0.40.1 it does **not** stop already-active profile rows from being injected by the TypeScript or Pi materializers.

## Cache/materialization discipline

The fix must not rewrite m[0] during a defer pass. The established m[0]/m[1] contract keeps defer passes byte-identical and only materializes a new m[0] on an existing cache-busting pass. A `memory.enabled` flip changes the `ctx_memory` guidance text: OpenCode and Pi persist that text's system-prompt hash, and `mustMaterialize` / `mustMaterializePi` treat a changed system hash as a HARD materialization signal. The Rust module folds the request system-prompt hash into its effective `render_config`; a changed identity is classified as a HARD fold. Thus the configuration flip already has an authorized materialization path; the fix threads the existing boolean through that path and never changes cached m[0] bytes on a defer.

## Product decision implemented

`memory.enabled: false` suppresses all memory-derived prompt injection: project-memory baseline and deltas, memory-update deltas, the memory mural, user-profile baseline, and user-profile delta. It does not disable project docs, session history, notes, or Dreamer user-memory generation controls. `dreamer.tasks.review-user-memories` remains the independent privacy/generation gate.

## Public-reply draft

`system_prompt_injection.skip_signatures` could not suppress this because `<user-profile>` was being added as synthetic m[0]/m[1] user messages, not to the system prompt that the signature setting examines. The actual bug was that `memory.enabled: false` gated the project-memory path but not the user-profile (and mural) render path. The fix makes memory-off suppress every memory-derived injection surface while leaving the separate Dreamer user-memory schedule in charge of whether new profile memories are generated. On v0.40.1, disabling `dreamer.user_memories` / the `review-user-memories` schedule prevents future generation, but existing active profiles can still be injected; there is no configuration-only rendering workaround short of upgrading to the fix.

## Regression coverage and mutation proof

The focused OpenCode and Pi tests seed active project memory, active global profile rows, a profile-version advance, and an explicit image-capable mural. Their memory-off cases assert that neither m[0] nor m[1] contains the corresponding project-memory, profile, profile-delta, or mural bytes; their memory-on control compares the default and explicit `memoryEnabled: true` m[0]/m[1] shapes byte-for-byte. The TypeScript transition case keeps the previous guidance system hash while turning memory off and requires an immediate `render_config` HARD materialization; this prevents one replay of the memory-bearing cache before the later system hook publishes its changed hash. The next defer replays the frozen suppressed m[0] without another materialization. Pi retains its equivalent memory-off transition coverage.

The Rust `m0_compose` and `m1_compose` unit legs seed the module store with project memory, active profile data, a version gap, and a mural. They prove the memory-off compose path omits the profile baseline, profile delta, mural, project-memory bytes, and memory watermarks. The standard module differential/golden suite remains part of the module gate.

Mutation proof (issue #10588 discipline): temporarily inverted the new OpenCode baseline profile gate (`memoryEnabled === false` → `memoryEnabled !== false`, marked with the required temporary break token only during the run). `bun test src/hooks/magic-context/inject-compartments.test.ts --test-name-pattern 'suppresses every memory-derived surface'` failed as required: the synthetic m[0] contained `<user-profile>\n- profile baseline must not leak`. The correct predicate was restored, the break marker was removed, and the focused test passed.

## Verification

- `bun run test` in `packages/plugin` — passed: 4,108 tests.
- `bun run test` in `packages/pi-plugin` — passed: 814 tests.
- `bun run typecheck` in both plugin packages — passed.
- `bun run lint` in both plugin packages — passed (Pi reports one existing non-failing warning in `context-handler.ts`).
- `cargo test -p mc-module --lib` — passed: 985 tests, including the Rust differential/golden legs; `cargo fmt --all -- --check` passed.
- `cargo test -p mc-module` was also attempted. Its library tests passed, but its real-daemon integration assertion expects a bare m[1] placeholder while the daemon serves the placeholder inside `<session-history-since>`. The same failure reproduced on the isolated integration rerun; this remains an unresolved test expectation mismatch outside the issue-368 assertions.
