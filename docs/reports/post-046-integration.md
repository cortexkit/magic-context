# Post-0.46 integration train

## Ancestry and ownership

Base: `651c105a90934850bab21e8585e315e90aca7434` (0.46.0).
The task branch contains eight `--no-ff` merges, in the requested order:

| Change | Reviewed source tip | Merge commit |
| --- | --- | --- |
| 637: Pi completed-result retention | `5f2f2b402860` | `65260181c5` |
| 638: retrospective message-index fallback | `fefcae39a0` | `71030c0f8d` |
| 635: pending-marker regression only | `d2c21537361b` | `8f887e9ba6` |
| 634 + 636: window floor and aggregate usage | `ba0eca4d0a` | `a92f676ea1` |
| Pure-reader auto-search | `0916b637982a` | `fa20a5e398` |
| Rust tool-result attachments | `fdc266627e` | `237bb7004d` |
| 620: reasoning-token budget | `1da27807d5` | `6607689e82` |
| 630: active-turn thinking | `ef5687b9f2` | `385dd8904d` |

The parent owns local Rust gates, the local full plugin-suite confirmation, publication of `train/post-046`, and the full CI watcher. Mason cannot push from an isolated worker worktree. Master and the live checkout's distributions were not touched.

## Conflict ledger

### Budget merge onto the first six fixes

- **Pi status dialog:** keep both the proven window-source/denominator summary from 634/636 and the optional reasoning-budget line from 620.
- **E2E manifest and validator:** union the release's Pi historian and OpenCode 2 error-result scenarios, the two Rust attachment scenarios, and the reasoning-budget scenario. Intermediate pins: 180 files, 63 TS, 59 Rust; TS host counts OpenCode 43, Pi 29, OpenCode 2 36, OMP 21.

### Active-turn merge onto the budget

- **`transform.rs`:** retain scope visibility and budget-lane active-turn protection, together with the thinking-bearing protection used by all 630 first-selection lanes. Remove the duplicate `include!` of the byte-identical shared predicate. Adapt the new metadata-route test call to the additional budget scope parameter, without changing its assertion. Preserve absorbing frozen removals and exclude cleared mids from native newest-message raw keeps.
- **Rust budget route inference:** reuse 630's `active_turn_route_request` when computing the budget exemption, so custom routes carrying Anthropic signature metadata receive the same protection in budget selection. Add a control proving cutoff zero while active and historical eligibility after a real user request.
- **Pi `reasoning-replay-pi.ts`:** keep token-budget costing, calibration, reported-empty-summary charging and frozen cutoffs. Retain 630's defensive active-turn checks for fresh typed and inline clearing. Do not reintroduce age-based selection or active-turn exclusions into frozen replay.
- **Plugin `reasoning-removal.ts`:** protect first selection, but replay saved whole-message removals without newest/active exemptions. Recovery restores originals separately, only after an anchored provider rejection.
- **Plugin `strip-content.ts`:** replay exact frozen parts without active/newest exemptions; retain master's partial layout for bare legacy mids. First-selection protection and explicitly authorized recovery are distinct inputs.
- **`transform-index-staleness.test.ts`:** retain 620's real follow-up user boundary. Both conflicting versions closed the same turn; the assertions are unchanged.
- **`transform-postprocess-phase.ts`:** use token-budget cutoffs, additionally bounded by the first protected thinking tag, for clearing and the monotonic watermark. Retain selective pending-edit deferral, prefix-bound later-signed-block protection, and envelope restoration. No usage-only 95% refusal was introduced.
- **E2E manifest/validator:** add both 630 scenarios to the union. Final pins: **182 files, 65 TS, 59 Rust**; TS host counts **OpenCode 44, Pi 29, OpenCode 2 37, OMP 21**. Keep all scenario inclusion/exclusion assertions from the reviewed branches.
- The shared TypeScript and Rust active-turn predicate files are byte-identical to both reviewed branches and occur once per language. No compatibility shim was added.

## Explicit recovery versus frozen replay

A full remote plugin run exposed the conflict in `latest thinking turn survives frozen representation strips on anthropic`: protection alone withheld a legacy partial replay. The parent settled the rule: an already-served omission is absorbing unless the provider rejected that omission and recovery is bound to that turn's user anchor.

The old `thinkingBindingRecoveryMessageIds` name actually meant persisted binding-strip ids. The finalizer now separates:

- `frozenThinkingBindingMessageIds`: replay prior omissions on every pass;
- `restoreThinkingMessageIds`: explicit authorization, populated by the live caller only when `thinkingRecovery.restore` is true;
- `protectedThinkingMessages`: first-selection protection, never restoration authorization by itself.

Recovery must also identify the active protected message. The existing 630 fixture passes its ids under the explicit authorization key; the completed-history fixture uses the persisted-strip key. **Their expected provider bytes did not change.** All adversarial 620/630 review files remain unchanged. Added controls require byte-identical ordinary frozen replay, exact-part absorption without recovery, exact-part restoration with authorization, and a real ordinary-defer transform that never passes authorization.

Mutation control: staged live state, empty unstaged diff; grant `restoreThinkingMessageIds` unconditionally in `transform.ts` under `NON-VACUITY BREAK`; diff becomes one file, +2/-1. Only `ordinary defer does not authorize restoring persisted active thinking` fails; both historical-envelope and anchored-envelope recovery controls pass. Restore from the index and touch the file; unstaged diff returns empty. No mutant is committed.

## Safety and verification

Live-store rule: never open, read, write or migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`).

Package suites unset `OPENCODE_DB` and use throwaway HOME/XDG/application-storage roots. CLI additionally leaves `MAGIC_CONTEXT_LOG_PATH` unset because its injected OMP fixture pins the default path. The initial CLI attempt had that environment mismatch and a 5-second subprocess-probe timeout; its retry uses the repository runner with a 30-second test timeout and passes all five batches.

- Bun **1.4.2**; TypeScript **5.9.3**; Biome **2.5.1**.
- Pi full suite, `bun run test --parallel=1`: **1668 pass, 3 skip, 0 fail**, 84,766 assertions, 162 files. Frozen install checked 996 installs / 1,251 packages with no changes. Later impacted Pi review controls remain green after shared reconciliation.
- CLI full suite, `bun run test --timeout 30000`: **649 pass, 2 skip, 0 fail**, 2,106 assertions, 61 files across five serial batches.
- Root `bun run typecheck`: passed, seven compiler invocations across four packages. Additional narrow `tsc` config including the two integration test files also passed (the package config normally excludes tests).
- Root `bun run lint`: passed, **1,699 files** across four package invocations; 17 warnings and seven informational diagnostics are retained, not suppressed.
- Initial finalizer/review/absorption run: **130 pass, 0 fail**, 3,780 assertions across ten files.
- Final broader targeted run: **479 pass, 14 fail** across 15 files. The 14 failures were in two OpenCode files after Pi fixtures changed process-global host mode in the shared non-isolated VM (`OpenCode database is not writable from a Pi-compatible process`). Rerunning just those two files with the repository's file isolation (`bun test --parallel=1 --timeout 30000 .../transform.test.ts .../transform-postprocess-phase.test.ts`) passed **346 tests, 1,950 assertions**. All other files, including the six adversarial review files, new controls, staleness/recovery tests and six manifest assertions, passed in the broader run. No test expectation was changed to accommodate host-mode bleed.
- AFT inspection was partial: checkout graph and Biome diagnostics unavailable; TypeScript reported no errors and one unused-import hint. Authoritative compiler/lint gates supply verification.

### Parent-owned gates and infrastructure failures

The first remote cargo and plugin requests lost their transport outcomes while queued. The parent obtained runner confirmation that neither job started and no job remained running. The parent retained ownership of all three Rust gates. No second worker Rust build was launched.

The subsequently authorized remote plugin run reached **7351 pass, 8 skip, 68 fail**, 216,488 assertions across 727 files. The parent identified runner-environment failures (`lsof`/`/proc/mounts`, missing ONNX dependency, packed-worker Node capability). The one demonstrated semantic failure was the pure-finalizer frozen-replay case described above; it is repaired with the parent's explicit recovery ruling and covered by new controls. No unrelated environment accommodation or test weakening was made. The parent will run the full plugin suite locally on the final tip.

Store migrations, `storage-db.ts`, the Rust store crate, and `Cargo.lock` are unchanged from the release. The inherited doctor/config deprecation cleanup is not a store migration. The source fence remains `LATEST_SUPPORTED_VERSION = 95`.

Final targeted gates, isolated distribution-build evidence, and the final tip are recorded in the worker delivery declaration. Rust results and CI run id/result must be supplied by the parent before publication is considered complete.
