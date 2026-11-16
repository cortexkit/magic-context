# mc-attribution-samples-v1

What Astrocyte sees of ck-mc's attribution facts: the `attribution.read` query
on ck-mc's management surface, and the `attribution_fact` v1 bus event. A fact
says what one child session ck-mc started on a runner is for, so the child's
model spend can be charged to the agent, task and project behind it. ck-mc
writes one fact per child, right before the send that creates the child, and
never changes it.

The files come from the module's own code on a fixture store holding two
facts. Regenerate them with `MC_REGENERATE_ATTRIBUTION_SAMPLES=1 cargo test
--locked -p mc-module --lib attribution::samples_tests::samples_v1 -- --exact`;
the test fails when a file here is stale. `SHA256SUMS` covers every sample, not
this file.

## The fact

```
{fact_id, supersedes, subject, alfonso, parent, workload, task, project_id,
 effective_from_ms, recorded_at_ms}
```

- `subject`: the child exactly as ck-mc bound it in `session.send`:
  `{kind: "session", runner, harness, session}`, with the runner module
  (`broca` or `thalamus-harness`), the child's harness and ck-mc's own child
  session id.
- `alfonso`: the agent id of the head session a summary serves, when its
  route's scope names one; otherwise null, and always null for a dreamer run.
- `parent`: the head session a summary serves, in the same shape as `subject`;
  null for a dreamer run.
- `workload`: `summary` (a summary's first turn, or a memory fact check of its
  second turn, each in a child of its own) or `dreamer`.
- `task`: `magic-context.summary`, or `magic-context.dream.<task kind>`, the
  routing consumer the child's model was chosen under.
- `project_id`: the project the run serves, when it serves one.
- `effective_from_ms` and `recorded_at_ms`: when the child was created; both
  the same today.
- `fact_id`: lowercase hex SHA-256 of `magic-context.attribution.v1` 0x00
  runner 0x00 harness 0x00 session 0x00 `1`, with the subject's three parts and
  the creation fact's revision `1`. A later correction would hash revision 2,
  3 and so on and name the fact it corrects in `supersedes`; none is written
  today, so `supersedes` is always null.

## `attribution.read {after?, limit?}`

Admitted only for `reserved:astrocyte`. The reply is `{"result": {facts, next,
through}}`, the facts in the order ck-mc recorded them.

- `read-page.json`: the first page from the start (`params` empty): a summary
  child with its head and agent, and a dreamer child with a project and no
  parent. `next` is null because the page reached the newest fact; `through`
  is the cursor of the newest fact stored when the read ran.
- `read-page-next-empty.json`: the page after `through`: no facts yet.

`after`, `next` and `through` are opaque cursor strings. `limit` is 100 unless
given and at most 500 (a larger one is cut to 500). A full page that stops
before the newest fact has `next` set; pass it as `after`. `through` is null
while no fact is stored. Unknown params, an `after` that isn't a cursor, or a
`limit` below 1 are refused `invalid_params`.

- `read-refused.json`: any other caller (here `reserved:occipital`) is refused
  `caller_not_admitted`, the refusal ck-mc gives an unadmitted user command,
  before the params are read.

## The event

`event.json`: subject `ck.{acct}.event.magic-context.attribution_fact.v1`,
the two headers the bus carries, and the body:

- `Nats-Msg-Id`: the fact id, so a fact sent again is the same message;
- `Ck-Content-Digest`: the SHA-256 of the body as bare lowercase hex.

The body is the fact as `attribution.read` serves it, in its canonical JSON
form (RFC 8785: sorted keys, no whitespace), always under 4 KiB, and the same
bytes every time it is sent. ck-mc publishes it right after the commit that
stores the fact, and again on its next minute tick until the bus acknowledges
it.
