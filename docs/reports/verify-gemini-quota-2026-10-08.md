# Gemini verify failures: account-pool exhaustion, not XML truncation

## Evidence and diagnosis

The OpenCode plugin log for 2026-10-08 showed 21 primary
`google/antigravity-gemini-3.8-flash` verify validation failures, all reported as
`verify manifest missing complete root element`, and 18 successful
`deepseek/deepseek-flash` fallbacks. One exhausted chain ended with the host error
`SessionExecutionFence.Lost`.

The supplied read-only transcript extract, `verify-sessions.json`, contains 107
verify child sessions since 01:00Z. It is a part-level export: grouping its 11,824
rows by message id produces 3,600 messages. Counting rows rather than messages
would overcount completions and steps. Its later capture includes one additional
quota notice beyond the log window.

All 22 Gemini final messages without a closing verify root contain this exact
shape (the reset countdown changes):

```text
All 2 account(s) rate-limited for gemini. Quota resets in 1h 35m. Add more accounts with `opencode auth login` or wait and retry.
```

Each notice has `finish=stop`, `error=null`, input=0, output=33, reasoning=0, and
cache read/write=0. The auth adapter manufactured a successful assistant
completion for an exhausted account pool. It is not model-produced XML. The
local provider-outage detector required output <=32, so it missed every notice
and let the manifest parser report the misleading error. Reporting this synthetic
`stop` response as a provider error is also an upstream auth-plugin concern.

This is **none of the three proposed cap/format/prompt causes**:

- No message in the extract has a length/max-token finish. Failed sessions have
  1–43 Gemini assistant steps; most are immediate, one-step quota replies.
- All 37 unfinished Gemini messages have a later Gemini `stop` in the same
  session. They are intermediate/aborted turns, not final missing-root outputs.
- Another 85 Gemini final responses and all 18 completed DeepSeek responses
  contain valid, complete verify manifests. There is no alternative root or
  wrapper to admit in the failed outputs.

The real prompt remains `VERIFY_SYSTEM_PROMPT` plus `buildVerifyPrompt` in
`verify-prompt.ts`. It explicitly requires one `<verify>...</verify>` document.
The parser in `manifest-parser.ts` already accepts surrounding narration/code
fences while requiring the closing root. Neither is changed.

The child uses `dreamer-memory-mapper`: default step cap 60 in
`hidden-agent-registrations.ts`. With a token-budget guard, the async runner
requests finalization at cap minus two (58) in `prompt-async-transport.ts`.
`live-child-output-cap.ts` samples optional `dreamer.maxTokens` for each child;
when unset it preserves the host model's output cap. The actual live config was
not read, and neither step nor output cap was changed.

## Fix and model policy

Recognize the complete structured account-pool notice with a reset duration,
while retaining the existing stop/no-error/no-reasoning completion checks.
Length alone is no longer what decides whether this notice is a provider failure.
Quoted, partial, or reasoning-bearing notices do not acquire a cooldown.

The configured fallback order is preserved. After the primary reports this
quota exhaustion, a run-local, model-keyed cooldown skips further primary
dispatches until its computed UTC reset deadline. A scheduler lease-domain run
shares the state across its tasks; standalone verify calls get their own scope.
Concurrent runs do not share it, and a new run re-probes its primary. The first
exhaustion logs the deadline once. No model configuration is changed.

If the fallback also fails, diagnostics retain both the primary quota deadline
and the actual fallback failure. Provider-error telemetry and the scheduler's
error text no longer claim that the quota notice was malformed XML. Chat and
dialog `/ctx-status` expose the generated primary quota deadline from failed-task
records without exposing surrounding account/provider text.

## Recorded before/after and regression coverage

An offline Bun 1.4.2 replay used the exact provider detector from base commit
`41eedb38821dba886ce8ea1c65963eab54bf52f3` and the fixed detector, with the
unchanged real verify validator:

| Final recorded output | Before | After |
| --- | --- | --- |
| Gemini quota notice (22) | Missing complete root | Provider quota exhaustion with reset deadline |
| Gemini complete manifest (85) | Accepted | Accepted |
| DeepSeek complete manifest (18) | Accepted | Accepted |

The recorded notice and its token metadata are preserved in a small test fixture.
An integration test invokes the real verify prompt/validator over 45 memories:
three batches finish using one failed Gemini dispatch plus three configured
DeepSeek dispatches, rather than retrying Gemini on each batch. Tests also cover
reset expiry, new-run re-probing, concurrent isolation, unchanged fallback order,
failure-record persistence, and safe status rendering. Existing missing-root and
truncated-root rejection tests remain unchanged.

No authenticated host reproduction was run: no permitted independent auth copy
was available. A read-only `VACUUM INTO` attempt exceeded its 120-second cap before
committing a usable snapshot; it was not retried and its partial destination was
removed. Diagnosis/replay instead used the task-giver's transcript extract. No
live config, credential table, or context/store database was read or changed.
