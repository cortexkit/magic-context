# Broca provider conformance v1

This target runs the real `CARGO_BIN_EXE_ck-mc`, an embedded **real subc
daemon/router/transport**, and a scripted SDK module registered as **`broca`**.
It never injects a `McHandler` or substitutes an in-process provider. Each rig
owns temporary config, runtime, cache and context databases. The context database
is provisioned with the repository's public test-schema initializer. Historian
publication uses `HostStore`'s fenced write bracket; completions need no network.
All tests are Linux-only, including the process kill. No live stores are opened.

## Rulings and caller scope

The original design draft assumed routes bound as `broca`. Broca's later
ruling requires provider/tool routes to bind as **`runner`**, with
`harness: "broca"` beside `session` in hook and compaction bodies. The suite
checks the `(project_root, session)` tool join and its negative cases. A route
bound as `broca` must not join; the suite does **not** require a Thalamus call.
The scripted runner's observed requests prove that ck-mc actually uses the
default target `broca`, not merely that its manifest names it.

Hook subjects contain only `blocks: [text]`, in message order. Operations require
a text-block index, and appends concatenate to an existing block. The suite's
caller applies only checked answers to the new subject; prior durable content
is not an editing target. Disallowed answers are unavailable. MC declares these
optimizations advisory (`on_unavailable: pass`), so unavailable leaves the subject
unchanged. These caller-policy controls exercise pinned commons validation;
they do not claim to execute Broca's own caller implementation.

Refusal answers have `answer`, `request_id`, `code`, `reason`, and optional
`provider_code`, never `retryable`. Code-specific retry policy belongs to the
role. When Broca reports a provider refusal as a runner-operation error, the
refusal answer's `code` becomes the error's `provider_code`; the
provider's finer diagnostic must remain separate. An unknown code decodes and
is not retryable. `compaction_unavailable` is a Setup-only runner error; a failed
step keeps the previously applied view rather than re-running Setup.

## Gates and reproducible fixture generation

Run every command below on Linux through the remote runner (with the guard).
`drive-fault` enables markers printed after SQLite commits; the executable then
parks until the harness kills it. These markers make the crash timing deterministic.
The kill test is compiled only with that feature. The deploy binary remains untouched.

```sh
test "$(uname -s)" = Linux || exit 90
cargo --version
cargo test -p mc-module --test broca_conformance --features drive-fault
cargo test -p mc-module --lib --features drive-fault
```

Generate the shared transcript/exchange JSON fixture and then verify **without** the write flag:

```sh
test "$(uname -s)" = Linux || exit 90
MC_WRITE_JOINT_FIXTURE=1 cargo test -p mc-module --test broca_conformance --features drive-fault fixture::joint_fixture_committed_bytes_match_real_encoder -- --exact
cargo test -p mc-module --test broca_conformance --features drive-fault fixture::joint_fixture_committed_bytes_match_real_encoder -- --exact
```

Fixture: `fixtures/compaction-provider-v1/joint/{transcript.json,exchanges.json,README.md}`.
Every answer except the explicitly named unknown-refusal caller control comes
from the executable's real encoder. The unknown control uses the same pinned
serde role type MC uses for refusals; MC has no branch emitting an unknown code.
`/joint/project` is the portable fixture root, remapped to the rig's real
throwaway project on replay. MC requires that root to exist and hashes it into
its opaque compaction ID. Generation therefore normalizes **only** that ID to
`mc-joint-v1`; replay remaps it to the real ID, then compares the answer after
that same normalization. No message/range/operation rewriting, newline
normalization after generation, or snapshot auto-accept occurs in a normal run.
The byte comparison includes the case README and final LF.

Each exchange has `name`, `call` (`setup` or `step`), a **method/params envelope**,
`answer`, and `expected_view`. Step exchanges can be compaction steps or
write-time transform steps; the envelope identifies the role. The view is a
rendered message list for compaction and the newly edited message for a hook.
The known refusal uses a separate disabled-compaction rig. Its unknown companion
is a forward-compatible decoder/retry-policy control, not a provider emission.
The oversized text is larger than a 256-byte paging control cap, not the 4 MiB
default; the fake runner returns a single oversized record alone. It remains a
small, portable fixture rather than committing megabytes of repeated padding.

## Acceptance map

| Acceptance | Test |
| --- | --- |
| Fresh Setup and repeatable initial view | `compaction::fresh_setup_ready_with_initial_view` |
| Deferred history while below threshold | `compaction::pending_history_below_threshold_preserves_last_view` |
| Failed step retains last view | `compaction::failed_step_keeps_last_view_and_is_not_setup_compaction_unavailable` |
| Below threshold; one crossing; history head, drops, full range; subsequent stable noops | `compaction::below_threshold_noops_crossing_once_history_drops_and_stable_prompts` |
| Route join, isolation and real default-runner callback | `compaction::runner_join_is_project_and_session_bound_not_broca_bound` and the threshold test |
| Kill at durable `AnswerRecorded`, retry same ID, skipped version, contiguous cursor, stale fencing | `compaction::kill_mid_request_retry_skips_reserved_version_preserves_cursor_and_fences_stale` |
| Per-block tag strip, untouched signatures/reasoning/images/tool calls | `hooks::post_assistant_strips_only_addressed_text_preserves_signed_and_nontext_bytes` |
| Appends on newest content only; disallowed answer unavailable | `hooks::pre_user_post_tool_append_only_new_content_and_disallowed_answer_is_unavailable` |
| Three roles, versions, runner groups, existing tool surface | `role_describe_and_existing_tool_provider_surface` |
| Reproducibility and shared-byte replay | `fixture::joint_fixture_committed_bytes_match_real_encoder`, `fixture::joint_fixture_replays_real_routes_and_unknown_refusal_decodes_without_retry` |
| Claude Code legacy regression | Existing `mc-module --lib` tests, unchanged |

The kill harness reads the persisted answer at the marker **before killing**,
so the skipped version is an observed allocation, not an inferred one. After
restart it retries the same request and compares the logical replacement, not
the version. The suite checks delayed real answers with the pinned commons
compaction role's `fence::dispose` (commit `85c105df`), then verifies that rejected
answers leave the prompt bytes unchanged.
