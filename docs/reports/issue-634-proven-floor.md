# Issue 634: measured input floors

## Findings (source audit, not a read of the reporter's databases)

The issue's `session_meta` values establish a poisoned denominator: 834,492 / 8,732,692 = 9.55595%. They do **not** establish which provider usage event wrote that floor. A transform's `usage=...` line can include a live forward estimate and is not itself an accepted provider measurement.

### How could 757,872 become 8,732,692?

There is **no calibration multiplier on the measured-input-to-floor path**, in either v0.45.0 or this checkout. The pre-fix Pi pressure, geometry and model-keyed floor files are unchanged from the v0.45.0 tag.

- `packages/pi-plugin/src/pi-pressure.ts:89-120` sums input and cache input, optionally takes the smaller `totalTokens - output` reading, and excludes output. It does not calibrate the result.
- `packages/pi-plugin/src/index.ts:919-951` takes the maximum of the previous floor and that provider usage reading. No tokenizer or decision calibration is involved.
- `packages/plugin/src/shared/window-geometry.ts:657-697` raises the usable denominator to the supplied floor **exactly**, not a multiple of it. Configured provider/overlay/detected walls remain authoritative.
- Historian payload calibration (`packages/pi-plugin/src/historian-calibration-extension.ts:23-74`) sets generation temperature/output caps, not input usage or the session floor.

Two actual defects were reproducible before the fix:

1. In v0.45.0, `pi-context-limit.ts:58-71,105-121` reconstructed a denominator from persisted input / percentage and fed the **denominator** to `applyProvenInputFloor`. A 9.55595% percentage on 834,492 input reproduces 8,732,692, even if the measured accepted maximum is only 757,872. That is estimate/inference-as-proof on the geometry/display path; this branch does **not** write `observed_safe_input_tokens` itself.
2. Both usage writers treated “no overflow error” as success. Other failed/aborted replies could carry usage and inflate the persisted maximum. A successful 757,872 reading followed by a failed 8,732,692 usage payload reproduced the persisted latch. New acceptance checks are at `packages/pi-plugin/src/index.ts:783` and `packages/plugin/src/hooks/magic-context/event-handler.ts:852`.

An already-inflated model-keyed record was also accepted without checking a measured basis. It stayed inflated on every subsequent smaller successful input. Thus the supplied metadata is sufficient to reproduce the persistent failure, but not to attribute the **original** 8.7M write to calibration, a particular failed reply, or an OMP-produced usage payload. The corresponding assistant `message_end` usage/error/stop-reason record would be needed to distinguish those origins. No such original record was supplied or read from a live store.

### OpenCode TS and Rust

- TS and Pi share `applyProvenInputFloor`. OpenCode's writer uses the unscaled disjoint input/cache components (`packages/plugin/src/hooks/magic-context/event-handler.ts:814-817,890-903`), and had the same non-overflow-failure acceptance defect. OpenCode does **not** have Pi's persisted-percentage-to-proven-denominator branch.
- Their sanity bounds differ: OpenCode accepts context limits up to 3,000,000 (`packages/plugin/src/shared/models-dev-cache.ts:56-63`); Pi accepts up to 10,000,000 (`packages/pi-plugin/src/pi-context-limit.ts:13-14`). Consequently the precise 8.7M resolver latch is not identical on TS.
- Rust has no separate `observed_safe_input_tokens` updater or floor derivation. Its OpenCode host resolves TS geometry (`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:2556-2571`) and transports soft/hard/absolute values unchanged (`:1185-1205`). Rust consumes the provided soft denominator (`crates/mc-module/src/transform.rs:7825-7826`). The host repair therefore protects both engines; the adapter regression pins both reported accepted inputs without scaling. No Rust source change was needed.

### Token threshold contract

The schema (`packages/plugin/src/config/schema/magic-context.ts:1236-1243`) and docs (`CONFIGURATION.md:449-468`, `packages/docs/src/content/docs/reference/configuration.md:72`) explicitly describe an **alternative/override**, not an independent OR trigger:

- A matching `execute_threshold_tokens` value **wins over** percentage mode.
- It is capped at 90% of the usable context limit: 200,000 becomes 172,800 with a 192,000 denominator.
- The effective tokens are converted to a percentage (`packages/plugin/src/hooks/magic-context/event-resolvers.ts:347-388`); the scheduler compares against that resolved percentage (`packages/plugin/src/features/magic-context/scheduler.ts:71-94`). Historian trigger budgets use the same resolved threshold (`packages/pi-plugin/src/context-handler.ts:4324-4355`).

With the reporter's inflated denominator, token mode is ~2.29%, **not 80%**. 834,492 input at 9.56% still exceeds that effective token threshold. A regression proves this even without repairing the denominator. An OR trigger would change the documented contract: on a 192k window, 160k exceeds 80% but should still defer when the token override is clamped to 172,800 and the cache is warm.

The floor drift alone therefore cannot explain all the reported defers **if the 200k token setting was effective on those passes**. Also `times_execute_threshold_reached` is a legacy persisted/display field: there are no runtime increments in the TS/Pi paths, so its zero value does not prove that the threshold never fired. Historian admission additionally requires eligible history and observes its own concurrency/recovery gates. This change deliberately does not invent counter semantics or an OR trigger.

## Fix and upgrade recovery

- Provider usage stays unscaled; failed assistant replies cannot prove capacity or invalidate a learned overflow cap.
- New floor records mark a provider-usage basis. Before applying a legacy model-keyed Pi/OMP floor, the runtime reads the session branch and re-derives its largest non-failed, same-model assistant input usage. Upgrade recovery is wired into message-end, transform, historian, footer, and `/ctx-status` consumers. It never uses `last_input_tokens` as proof because that field can hold a live estimate.
- OpenCode legacy floors are clamped once against accepted same-model assistant usage in the host's session history (`packages/plugin/src/hooks/magic-context/opencode-proven-floor.ts`). Only the small floor/model/state columns are read on the normal geometry hot path, not cached prompt BLOBs.
- Missing/unreadable history discards unverified capacity (0), rather than keeping an unsafe latch. Later accepted measurements rebuild it. No schema migration or manual DB edit is required; unrelated JSON calibration state is preserved.
- Percentage back-derivation may still recover a **smaller reserved display denominator** when a command context omits output metadata. It can no longer raise capacity or seed an unknown window. A measured accepted floor is the only fallback that may do so.
- `/ctx-status` now includes an exact token denominator and its window source, distinguishing `provider-measured floor (catalog)` from catalog/provider/overlay/detected sources. The Pi headless summary includes these too.

## Verification notes

The reporter fixture (legacy 8,732,692 floor, accepted 757,872 then 1,328,370) and the estimate/failure/status regressions all failed before the fix. With the fix, floors and denominators are exactly the accepted counts, pressure is 100% on those maximum inputs, and percentage scheduling executes. Controlled mutations of Pi legacy repair, denominator admission and TS/Rust-host legacy repair each reddened their named regression and were restored from the staged live implementation.

Package tests ran with throwaway `HOME`, inherited `OPENCODE_DB` unset, and test-preload XDG isolation. No live stores/configs were opened, read, modified or migrated. No real Pi/OMP/OpenCode host run was performed, so no live host or credential access was needed.

Full plugin suite: 7,315 pass, 6 skip, 1 unrelated Node WASM fixture timeout; that fixture passed alone (1/1). The first plugin attempt was capped too narrowly at 10 minutes and also exposed the intentional new status-row snapshot change; the snapshot was updated to include the requested rows before the complete run. Final full Pi suite: 1,631 pass, 3 skip, 0 fail. An earlier Pi run had one unrelated subprocess writer failure; its whole LKG file passed alone (16/16) and the final package-script run passed. Final focused TS/Rust-host regressions passed (3/3), workspace typecheck passed (TypeScript 5.9.3), plugin/Pi lint passed (Biome 2.5.1, pre-existing warnings only), and the workspace build passed (Bun 1.4.2, including 4/4 v2 loader tests). Package scripts' frozen installs changed no manifests or lockfiles.

## Draft bot reply (not posted)

Thanks @Zireael — we reproduced the bad 8.7M latch and added a regression using your 757,872 and 1,328,370 inputs. The fix only accepts unscaled, non-failed provider input usage as capacity proof, rebuilds old Pi/OMP floors from accepted assistant usage on upgrade, and shows the window source and exact denominator in `/ctx-status`. No manual DB edits are needed. One correction from the code audit: calibration does not multiply the provider input count, and `execute_threshold_tokens` is documented to **override** the percentage, not OR with it. With a live 200k token override, 834k should already exceed the effective trigger even on an 8.7M denominator; the old counter staying zero is not a reliable trigger trace. We have not changed that threshold contract. The supplied metadata proves the poisoned denominator but not which original assistant usage event produced it; the matching usage/error/stop-reason record would settle that last part.
