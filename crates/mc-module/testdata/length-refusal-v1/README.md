# length-refusal-v1

What Thalamus's Agent Runner (module `thalamus-harness`) tells readers after a model
provider refused a request as too long. Recorded from committed code by
`runner::tests_length_refusal::a_length_refusal_ends_context_overflow_and_rides_once_with_the_providers_count`,
on the runner's stand-in OpenCode 2 host with a scripted compaction provider. To record
again, run that test with `THALAMUS_RECORD_DIR` naming a folder relative to the
repository root; without it the test checks these files and `SHA256SUMS`.

The rules they follow: compaction contract 0.4.6 RD4 / W3.4 (a runner never rides
`over_limit` on its own size estimate, only on the model provider's count after a length
refusal) and llm-runner 0.8.56 §6 / §12.2 (a provider's length refusal ends the run
`error` with `provider_code: context_overflow`; `context_ceiling` is only a stop the
runner decides before sending, which Agent Runner never does).

## Files

| File | What it is |
|---|---|
| `01-ride-after-refusal-with-count.json` | The `compaction.ride` params sent to the session's compaction provider right after the provider refused with `prompt is too long: 213456 tokens > 200000 maximum`: `causes: ["over_limit"]`, `request_tokens` the provider's count, deadline 30 s. |
| `02-ride-after-refusal-without-count.json` | The same ride after a refusal that states no count (Claude Code keeps only `Prompt is too long`): `request_tokens` is absent, never an estimate. |
| `03-context-overflow-run-status.json` | `run.status` of the refused run: `state: error`, `error.class: permanent`, `error.provider_code: context_overflow`, the provider's message as it is, the host's own code (`provider.invalid-request`) in `provider_detail_code`, HTTP status 400. No `reason`, no `context_ceiling`. |

## What a reader can rely on

- The ride is sent once, at once, after the run ended; nothing waits on it.
- When it brings no view, the session's next request (the next run's first, since no
  host retries a length refusal) rides `over_limit` once more with the same count.
- A view it brings is checked and applied as one handed over with `session.apply_view`,
  at the session's next step boundary.
