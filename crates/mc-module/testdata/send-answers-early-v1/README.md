# Early run-starting send replies, version 1

These are the **first `session.send` result bodies**, recorded from committed
source while driving real pinned hosts against loopback stand-in model services.
Each file is the exact string returned by `Runner::dispatch`, without
re-serialization, normalization, an added newline, or the wire's `{result: ...}`
envelope. Every recorded send answered `pending` with its committed `run_id` and
no confirmed `delivered` receipt; the same run subsequently completed.

## Files and provenance

| File | Host | Send exercised | Recorded source commit |
| --- | --- | --- | --- |
| `01-opencode2-send-reply.json` | OpenCode 2.2.3 | First send to a new runner session; `Say hello.`, `send_id: send-early`, fixture loopback model. | `454a202a866ea11fa2d279e6d409b47daa848126` |
| `02-pi-send-reply.json` | Pi 1.5.0, hosted | First runner send after adoption and initial intake; idle legacy `delivery: steer`, `HOSTED_SEND_EARLY`, `send_id: send-early`, model `probe/probe`. | `9a23e95312b6a486c3aa5490cabc6d45c9636fa6` |
| `03-claude-code-send-reply.json` | Claude Code 2.1.318 | First send to a new runner session; `Say hello.`, `send_id: send-early`, fixture loopback model and plan. | `9caa4829d9b440e8c21c9c571cb42113d0e9323e` |

The commits are on the delivered branch. Later production changes after the
OpenCode and Claude recordings only fix Pi's own-run delivery classification;
their delivery behavior and recorded reply construction are unchanged.

`SHA256SUMS` covers the three JSON bodies and this README, not itself. The fixtures
use synthetic sessions, prompts, plans and credentials in private temporary
stores. No live store, installed login or real model account was used. Pi's
fixture first seeds a native journal with `FIRST_CONTACT`; the file here is its
first **runner** send, after that native turn and initial intake have ended.

## What readers should distinguish

- `pending` plus `run_id` records durable acceptance, not host delivery. A stored
  own run can already be named before the host is asked.
- The send gate remains held through asynchronous hand-over and observation, so
  a later new send still waits for that ordering boundary. A same-id replay reads
  the stored receipt and never hands another prompt over.
- Original-call routing selection remains before the first answer. A stored-only
  replay can report acceptance while that original call is checking routing.
- Joining steers, interrupts and ordered sends retain their existing hand-over
  timing. Pi's default/legacy queue is internally ordered, even while idle, so
  the Pi proof deliberately uses an idle non-ordered steer. An idle default Pi
  send in this rig still took 467.192 ms, including 457.167 ms of observation;
  this change does not make that ordered path answer early.
- New Pi own-run steers use a native prompt, including when reconstructed from
  stored records after restart. Pi steers joining a running turn and ordered
  steers are not reclassified.

## Measurements from the successful recordings

Times cover `Runner::dispatch`, not network transport or fixture construction.
Admission checks, including host/version/model validation, still run before durable
acceptance and are included in reply time. These are single loopback examples,
not performance thresholds or baseline subtractions.

| Host | First reply | Dispatch through completed turn |
| --- | ---: | ---: |
| OpenCode 2 | 182 ms | 540 ms |
| Pi, idle legacy steer | 7 ms | 472 ms |
| Claude Code | 493 ms | 1351 ms |

Claude's test held delivery before creating the managed session process and
verified that the reply had returned while that session's process-start count was
zero. After releasing that gate,
process/handover readiness took 8 ms and the first model request took 846 ms.
The latter includes CLI cold readiness, prompt processing and normal run-start
admission; it must not be confused with the 8 ms process-spawn interval.

## Proofs and reproduction

The ignored tests are registered in `probes/ignored_unit_tests.py`:

- `runner::tests_opencode2_real::send_answers_early::real_opencode2_first_send_answers_pending_then_runs_the_turn`
- `pi_hosted::tests::real::send_answers_early::real_hosted_pi_first_send_answers_pending_then_runs_the_turn`
- `runner::tests_claude_code_real::send_answers_early::real_claude_code_first_send_answers_pending_before_cold_start_then_runs_the_turn`

They run on the networked Linux builder with `--features test-support`, the
repository's pinned fetch/install commands, and a holder image built with
`cargo build --locked -p thalamus-harness-module --bin ck-thalamus-harness --features test-support`.
The recording environment variable is `THALAMUS_SEND_EARLY_RECORD_DIR`; select a
new writable output directory when using a read-only build snapshot. The test
filter is `test(first_send_answers_pending)`, with `--run-ignored only`; each test
is named slow after 90 seconds and terminated after 180 seconds.

The complete commands, pass/fail counts, base-red regressions, intermediate
fixture investigations and timing evidence are in
`../../investigations/send-answers-early-worker.md` and its cited logs.
