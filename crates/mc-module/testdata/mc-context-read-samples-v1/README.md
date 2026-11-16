# mc-context-read-samples-v1

What Colliculus reads of ck-mc's `mc-context-read/v1` service for its voice
front, which speaks for an agent during a live call: the session's newest
summaries in full, and its newest messages in the line form the summarizer
reads. Each file holds one request as Colliculus sends it on its context
route (`reserved:colliculus`), and the reply as the route carries it:
`{"result": ...}`, or `{"error": ...}` with the refusal's body.

The files come from the module's own code on synthetic sessions: a worker
session `opencode2/ses_live` on `anthropic/claude-opus-5-5`, with ten
messages and three summaries (messages 1-2, 3-4 and 5-6). Regenerate them
with `MC_REGENERATE_CONTEXT_READ_SAMPLES=1 cargo test --locked -p mc-module
--lib context_read::samples_tests::samples_v1 -- --exact`; the test fails
when a file here is stale. `SHA256SUMS` covers every sample, not this file.

## Files

- `describe.json`: `role.describe`, listing the three ops. Its
  `implementation_version` names the build that answered; the sample shows
  `{implementation_version}` in its place.
- `summaries-newest.json`: `context.summaries` with `newest: 2`.
- `recent.json`: `context.recent` with a budget every line fits in.
- `recent-cut.json`: `context.recent` with a budget of 256, which the
  newest line alone is over, so it is cut.
- `recent-unknown-session.json`: `context.recent` of a session ck-mc has
  neither a live worker nor saved state of.
- `recent-transient.json`: `context.recent` of a session whose transcript
  ck-mc has not read yet (here its Setup's read from the runner failed).

## `context.summaries` with `newest`

```
{session: {harness, session}, budget_tokens: 1..=32768, newest?: 1..=16}
-> {token_family, exact, summaries: [{id, start, end, title, text, tokens}]}
```

Without `newest`, the summaries are folded as the session's history head
folds them. With `newest: N`, they are the session's newest N summaries that
have content, each at tier 1, the text the history head shows for a newly
published summary. Either way they come newest first, and the list stops
before a summary that would take the total past `budget_tokens`. `id` is the
summary's sequence number; `start` and `end` are the first and last message
it covers. Any other `newest` is refused as `invalid_params` with
`{"field": "newest"}`.

## `context.recent`

```
{session: {harness, session}, budget_tokens: 256..=32768}
-> {token_family, exact, text, from_message, through_message, tokens,
    summarized_through, cut?}
```

- `text`: the session's newest messages as the summarizer's chunk lines,
  oldest first, one line per stretch of messages of one role:
  `[N-M] U: ...` for the person, `[N-M] A: ...` for the model (with
  `commits: ...` after `A:` when the messages made commits, and `TC: ...`
  for a tool call when the messages hold no text), and `[N] ...` for a
  relayed message. Hidden messages, such as notices, stay inside a line's
  range. Lines are counted back from the newest message, and a line that
  would take `text` past `budget_tokens` is left out with every older one:
  older lines are whole or absent.
- `cut`: present, and `true`, only when the newest line alone is over the
  budget. `text` is then that line's header, `… `, and the last part of its
  text that fits; when the full header and `… ` alone don't fit, the header
  drops its commit list. A reply never goes over `budget_tokens`.
- `from_message` and `through_message`: the first and last message the
  lines cover; for a cut line, that line's own range. Both are null, and
  `text` is empty, when the session has no message the summarizer would
  print.
- `tokens`: `text` counted with the session model's tokenizer, named by
  `token_family`; `exact` is false when the count is an estimate.
- `summarized_through`: the last message the session's newest summary
  covers, or null. The lines may overlap the summaries.

Refusals:

- `unknown_session`: ck-mc has neither a live worker nor saved state of the
  session. A session with saved state but no worker is restored by the read,
  which reads its transcript from the runner once.
- `transient`, with `{"class": "transient", "retry_after_ms": 2000}`: ck-mc
  is still reading the session's transcript, after a Setup or a restore, or
  that read failed. Ask again after the wait.
- `invalid_params` with `{"field": "budget_tokens"}` for a budget outside
  256..=32768, and the move refusals every context read can answer.
