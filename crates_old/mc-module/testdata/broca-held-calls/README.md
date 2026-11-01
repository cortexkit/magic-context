# Held-call durable status reader samples

These are unmodified `StreamData` JSON bodies returned through the real `ck-subc` → supervised `ck-broca` serve path, one body per line (only a terminating newline was added). They are not serializer snapshots or hand-built frames. Both rig binaries were the staged native macOS arm64 `.test-rigs/ck-subc` and `.test-rigs/fake-aft-stub`.

## Provenance and reproduction

- Before: production source at base `19bade3c77edbada3d4676ba40982970bb45d8e2`, with only the capture test/helper added. All ten `before/*.jsonl` files came from the successful baseline test run.
- After: the durable-status implementation in the first task commit (record its SHA in delivery). All ten `after/*.jsonl` files came from the successful enhanced regression/capture test.
- Shared role: `cortexkit-role-llm-runner = 0.7.14`; kit at capture time: `0.15.16`.
- Each side is a separate genuine run: randomly minted run/lineage IDs and real recorded timestamps intentionally differ. Do not expect cross-run byte equality from these samples.

From the worktree root, after creating `target/scratch/native`:

```sh
TMPDIR="$PWD/target/scratch/native" \
SUBC_CORE_BIN="$PWD/.test-rigs/ck-subc" \
FAKE_AFT_STUB_BIN="$PWD/.test-rigs/fake-aft-stub" \
BROCA_REQUIRE_SUBC=1 \
BROCA_HELD_STATUS_SAMPLES="$PWD/.cortexkit/internal-docs/investigations/held-calls-status-samples/after" \
CARGO_BUILD_JOBS=4 cargo test --locked -p broca-module-serve \
  --test llm_runner_conformance held_status_live_and_replay_samples -- --nocapture
```

The capture test opens `from: live` on a dedicated route before the send and waits for the initial display reset as an attach barrier. Each replay is a new `from: start` subscription against the same live session. Captures end on a durable event, never on a quiet-window timeout. Baseline listed captures ended at the legacy paused unit; after listed captures end at the first durable status unit. Settled captures end at `run_finished`. The test closes streams explicitly; a session subscription does not end when one run ends.

## Files and cases

Each directory contains:

- `status-late-listed-{live,replay}.jsonl`: call held/listed, before publishing an answer.
- `status-late-settled-{live,replay}.jsonl`: same session through an ordinary provider late result and the completing model turn.
- `status-expired-listed-{live,replay}.jsonl`: held/listed call before provider expiry.
- `status-expired-settled-{live,replay}.jsonl`: provider `expired` late entry, synthesized error tool result, then completing model turn. This is answer expiry, **not session-retention expiry**.
- `status-ordinary-settled-{live,replay}.jsonl`: ordinary synchronous call, never held.

`SHA256SUMS` hashes the exact twenty JSONL files above, relative to this directory.

## Reader contract to exercise

After the change, held/listed frames have `kind: control`, durable `cursor`, top-level `state: active`, `unit: {type: status, run_id}`, nonempty top-level `held_calls`, and `seq`. They have **no `event` member**: the shared `SubscribeEvent::live_event()` returns `None`. They are neither a `run_paused` lifecycle nor a display reset. At settlement, the ordinary `tool_result` is followed by a status frame with `held_calls` omitted; the shared `held_calls()` returns empty. Absence means none, not unknown. No new WAL record or field was introduced.

The enhanced real-serve test passed: the waiting list equals `run.status` (including the actual call key); clearing equals the empty status list; every captured frame advances `seq` by one across both lanes; status frames have no typed live event; ordinary sessions gain no status frames or held-call fields; live and replay control payloads and cursors agree after removing only per-attach `seq`. Display deltas are best-effort and are not replayed, so whole live and replay files necessarily have different `seq` values and bytes. Existing non-held borrowed control byte goldens also pass unchanged.

Before the change the internal `RunPaused {tool_held}` leaked as a public `paused`/`run_paused` frame and the held-record itself emitted nothing. That legacy pause disappears from the after frames; the durable held and terminal records now carry the status changes. At-most-once dispatch, sync-before-ack, cancellation withdrawal, and planned-shutdown preservation were not modified.

## External gates still required

Core, Thalamus, Magic Context, and terminal-reader approval of these frames is required before release capability declaration. The parent runs the native kill-conformance lane separately; these captures alone are not a kill-conformance verdict.
