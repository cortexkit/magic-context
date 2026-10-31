# Broca compaction-provider 0.7.10 / 0.7.11 decode captures

Source: Broca's five conformance-kit cases, supplied read-only at
`/Users/ufukaltinok/Work/Projects/CortexKit-scratch/shared-mc-broca/compaction-0710-samples-1031/`.
The 31 JSON files and `SHA256SUMS` are byte-for-byte copies. Every checksum was
verified before inspecting the samples. The manifest's own SHA-256 is
`c679754e05680772890502cced3e0f1902bad79cce8d2f9569457e991a84c3ed` (not a Git ref).

The tests in `src/providers/async_provider/tests/broca_compaction_0710.rs` use
ck-mc's production dispatch, `providers::decode`, `AdvanceNotice::from_headers`,
and the actual notice and view-get handlers. There is one test per named case,
plus fixture-integrity and independent ck-mc publication witnesses. The crate
pins `cortexkit-role-compaction-provider = 0.7.10` at the deployed ck-mc build's source commit
`a2ba9a341f52318f48489a7c8ef66196f88b7e3a`. No compatibility shim or production
behavior change accompanies these fixtures.

## Outcomes and boundaries

- **Setup decoding passes:** `view_due_max_ms = 30000` is understood;
  `view_features = ["truncate", "tag_bytes_edits"]` is ignored. There is **no
  strict unknown-field decoding error**. The pinned crate's `CONTRACT.md` §14
  says: “**Lenient** (unknown fields ignored): `role.describe`, the Setup
  request, the fields of every answer, the fields of `view.get` and
  `compaction.ride` requests and of their `overflow`, of a view, its cut and
  its part edits, and of `ceiling`. Unknown notice and view-ready headers are
  ignored.” `src/setup.rs` calls `SetupRequest` “Decoded leniently.”
- **Literal Setup handling fails for a different reason:** all five requests
  select the kit's `preset: "scripted"`. ck-mc returns
  `invalid_params: unknown provider preset`, with and without `view_features`.
  The captures also omit `context_window`, which ck-mc needs for a fresh
  supported Setup. Tests do not silently change these requests into successful
  enrollments. These are scripted-provider kit runs, not successful ck-mc runs.
- All 14 notices decode with every captured header preserved. Production notice
  handling acknowledges their unknown conversations after checking claim IDs
  and digests. This is **not** proof of a successful enrolled session replay:
  Setup failed and these captures contain no `session.read` pages. No new
  unrecognized notice header is present in this sample set.
- All six `view.get` requests decode and traverse the real handler. With no
  enrolled conversation, ck-mc produces `refuse / unknown_session`, which also
  decodes. Captured answers are from the **scripted provider**, not ck-mc.
  Five captured answers also pass the pinned view validator. The truncate
  answer decodes leniently (the unknown field is ignored), then fails
  `CompactionView::check()` with `ViewProblem::EditAction`: 0.7.10 requires a
  `bytes` or `drop` action. This is not an inbound ck-mc view or a ck-mc output.
- No view is published for these literal failed Setups, hence none contains
  `truncate`. A separate supported `owned-broca` session witness uses
  a synthetic text transcript, queues a real reduction, fetches its
  published view, requires nonempty edits, and checks that Setup and view
  answers contain no `truncate`. ck-mc's range builder emits only `drop` and
  `bytes` part edits. This witness is not presented as one of the supplied runs.
- Six `model-*.json` files are Broca-to-model message arrays, **not** ck-mc
  requests or answers. They are retained and checksummed, but cannot honestly
  be run through a ck-mc protocol decoder. The supplied 31 files contain no
  ride requests or Setup answers.

## Per-file results

“PASS / preset FAIL” means decoding passes, but literal handling returns the
exact unsupported-preset error above. “PASS / unknown” means decoding and actual
unknown-conversation handling pass. “PASS / view FAIL” distinguishes decoding
from validation of the scripted answer. These expected failures are asserted;
a green test suite is not a claim that these runs can enroll with ck-mc.

| File | Decode / handling result |
| --- | --- |
| `view_due_first_model_uses_view-setup-0.json` | PASS / preset FAIL |
| `view_due_first_model_uses_view-fetch-0.json` | Request PASS / unknown; scripted answer PASS |
| `view_due_first_model_uses_view-notice-0.json` | PASS / unknown |
| `view_due_first_model_uses_view-notice-1.json` | PASS / unknown |
| `view_due_first_model_uses_view-model-0.json` | N/A: model-only |
| `view_due_later_step_retries-setup-0.json` | PASS / preset FAIL |
| `view_due_later_step_retries-fetch-0.json` | Request PASS / unknown; scripted answer PASS |
| `view_due_later_step_retries-fetch-1.json` | Request PASS / unknown; scripted answer PASS |
| `view_due_later_step_retries-notice-0.json` | PASS / unknown |
| `view_due_later_step_retries-notice-1.json` | PASS / unknown |
| `view_due_later_step_retries-notice-2.json` | PASS / unknown |
| `view_due_later_step_retries-model-0.json` | N/A: model-only |
| `view_due_refused_fetch_blocks_model-setup-0.json` | PASS / preset FAIL |
| `view_due_refused_fetch_blocks_model-fetch-0.json` | Request PASS / unknown; scripted refusal PASS |
| `view_due_refused_fetch_blocks_model-notice-0.json` | PASS / unknown |
| `part_edits_truncate_renders_with_own_tag-setup-0.json` | PASS / preset FAIL |
| `part_edits_truncate_renders_with_own_tag-fetch-0.json` | Request PASS / unknown; scripted answer PASS / view FAIL (`EditAction`) |
| `part_edits_truncate_renders_with_own_tag-notice-0.json` | PASS / unknown |
| `part_edits_truncate_renders_with_own_tag-notice-1.json` | PASS / unknown |
| `part_edits_truncate_renders_with_own_tag-notice-2.json` | PASS / unknown |
| `part_edits_truncate_renders_with_own_tag-notice-3.json` | PASS / unknown |
| `part_edits_truncate_renders_with_own_tag-model-0.json` | N/A: model-only |
| `part_edits_truncate_renders_with_own_tag-model-1.json` | N/A: model-only |
| `part_edits_bytes_render_with_own_tag-setup-0.json` | PASS / preset FAIL |
| `part_edits_bytes_render_with_own_tag-fetch-0.json` | Request PASS / unknown; scripted answer PASS |
| `part_edits_bytes_render_with_own_tag-notice-0.json` | PASS / unknown |
| `part_edits_bytes_render_with_own_tag-notice-1.json` | PASS / unknown |
| `part_edits_bytes_render_with_own_tag-notice-2.json` | PASS / unknown |
| `part_edits_bytes_render_with_own_tag-notice-3.json` | PASS / unknown |
| `part_edits_bytes_render_with_own_tag-model-0.json` | N/A: model-only |
| `part_edits_bytes_render_with_own_tag-model-1.json` | N/A: model-only |

## Reproduce on Linux

Use a throwaway `HOME`, retain the existing `CARGO_HOME` / `RUSTUP_HOME` values
so Rust can still find its installed toolchain and dependency cache,
and run `git config --global --add safe.directory '*'` in that HOME first.

```sh
cargo fmt --all -- --check
cargo test --locked -p mc-module --lib broca_compaction_0710 -- --nocapture
cargo clippy --locked -p mc-module --all-targets -- -D warnings
```

The repository delivery gate remains `bash scripts/gate.sh full`.
