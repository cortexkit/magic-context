# mc-docs-proposal-samples-v1

What a Basal flow sees of a docs-upkeep proposal: the bus notice ck-mc
publishes when its dreamer's `maintain-docs` task makes a proposal, and the two
read-only management queries a flow-scoped route may call, `events_get` and
`docs_proposals.state`. Every other operation on a flow-scoped route is refused
`flow_route_not_admitted`.

The files come from the module's own code on fixture stores and checkouts, one
for each state, all holding the same proposal (id 1 of project `pj-docs`).
Regenerate them with `MC_REGENERATE_DOCS_PROPOSAL_SAMPLES=1 cargo test --locked
-p mc-module --lib docs_proposals::samples_tests::samples_v1 -- --exact`; the
test fails when a file here is stale. `SHA256SUMS` covers every sample, not this
file.

## The notice

`notice.json`: subject `ck.<account>.event.magic-context.docs_proposal.v1`
(`box_test` stands for the account), an empty body, and every header the bus
carries:

- `Nats-Msg-Id`: the event key, so a notice sent again is the same message;
- `Ck-Content-Digest`: the SHA-256 of the body `events_get` serves, as bare
  lowercase hex (the bus's codec writes this header itself);
- `event_key` (`<project>:<proposal id>`) and `project_id`: the headers the
  module's HELLO manifest declares for `docs_proposal` version 1.

A notice is published once, while the proposal is pending; `published_at` in
`events_get` says when.

## `events_get {event_key, event_name, version}`

`events-get-<state>.json` for `pending`, `stale`, `applied` and `dismissed`. The
reply is `{body, digest, event_key, event_name, published_at}`. `body` is a
string: the proposal exactly as stored when it was made (its id, project,
creation time, `status: "pending"` as of then, `file`, the path of its markdown
copy in the project's main checkout, the changed documents with their diffs and
kept changes, and the dropped changes), the same bytes in every state.
`digest` is the bare lowercase SHA-256 hex of those bytes. `events_get` serves
the body whatever the proposal's state is now.

`events-get-unknown-key.json`: a key ck-mc never published is refused
`event_not_visible`; so is a wrong `event_name` or `version`.

## `docs_proposals.state {proposal_id}`

`state-<state>.json`: `{"state": ...}`, the proposal's state checked against the
documents when read. `pending`: the documents are as the proposal read them.
`applied`: both now match its result. `stale`: they changed some other way.
`dismissed`: the person dismissed it. A flow calls it first and does nothing
unless the proposal is still `pending`.
