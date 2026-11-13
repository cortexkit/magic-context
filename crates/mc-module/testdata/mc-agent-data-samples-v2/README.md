# mc-agent-data-samples-v2

Same messages as v1, from a ck-mc whose `context.db` is at schema version
106 (memories with levels and profile categories). Only the source and
receiver bodies that name the schema version or digest the snapshot
changed; the wire format is the same.

These are JSON bodies accepted or produced by ck-mc's `agent-data/v1`
participant, using `cortexkit-role-agent-data` 0.3.0. Each JSON file is one
message, not a request/response wrapper. Requests contain `method` and
`params`. Successful reply bodies are bare objects; refusal bodies contain
`code`, `message`, and, where applicable, `detail`. Keys are sorted and the
only presentation changes are indentation and a final newline.

The `wire-` examples crossed two disposable daemons. Their source head has
three summaries, scores, events, a session note, session facts, a project
link, and a committed publication with waiting, applied, covered and
decided-pending facts. Another publication is still queued/uncommitted,
and a tagged message has a queued drop. The queued drop is local replay
state, not part of the exported session data.
An empty session travels alongside it to demonstrate absent optional fields.
All identities, timestamps and content are synthetic fixed inputs. The note
makes the snapshot larger than one MiB, so export admits several chunks to
the session door. Agent-data export itself is not paginated: the driver gets
one reply, not a reply for each chunk.

The `service-`, `source-` and `receiver-` examples come from the same service in process,
with disposable stores and controlled runner, catalog and session-door
answers. They cover circumstances the ordinary wire move does not reach.

## Files

Each situation listed below has a `-request.json` and `-reply.json` pair,
unless explicitly listed as a refusal. The operation is the part of the name
before its situation suffix, or is stated explicitly.

- `wire-describe-no-runner`: describe while the session runner does not
  participate; no session ref kind is declared.
- `service-describe-runner`: describe while the session runner participates.
- `wire-busy-idle`: busy for an idle session with waiting facts.
- `service-busy-historian`, `service-busy-view`, `service-busy-unknown`: busy
  while a historian runs, a view remains unconfirmed, or a worker cannot
  answer. Unknown is a successful busy result, not a refusal.
- `wire-prepare`: prepare a populated and an empty session, both frozen.
- `wire-export`: export the cut in multiple session-door chunks.
- `wire-diverged`: diverged on the destination before importing.
- `wire-import`, `wire-import-repeat`: the first import and the identical
  import again, with identical replies including dropped-row counts.
- `wire-release`: release on the source, naming the new holder.
- `wire-activate`: activate on the destination.
- `wire-prepare-to-abort`, `wire-abort`: prepare another cut of the moved
  sessions and then abort it.
- `wire-status-*`: status before prepare and after prepare, export, import
  (imported), release, activate (activated), and abort.
- `service-status-*`: status for every step the contract defines (`none`,
  `prepared`, `exported`, `imported`, `activated`, `released`, `aborted`).
  These read durable journal states;
  they do not manufacture an operation's success reply.
- `service-abort`: abort a cut not previously seen on this machine.
- `source-prepare`: prepare a head with two summaries, a note, pending
  facts, and a running worker that is parked between jobs for the cut.

Refusal file pairs have `-request.json` and `-refusal.json` instead. The
exception is `service-invalid-request-refusal.json`: its input deliberately
has an unknown envelope member and cannot be decoded as a contract request,
so that malformed input is not published as a request sample.

## Refusals and detail

The following names identify the sampled operation and its situation. A
missing detail means the `detail` member is absent, not an empty object.

- `service-caller-forbidden`: describe called by a runner instead of the
  driver returns `caller_forbidden`, without detail. Admission precedes
  decoding. The daemon also prevents that caller opening a service route.
- `service-moves-off-defensive`: describe returns `unavailable`, without
  detail, when the disabled service is called directly in process. This is
  never reachable over the wire from a build with moves off.
- `service-invalid-request`: describe with an extra envelope member returns
  `invalid_request`, without detail.
- `service-unknown-ref`: busy for an unregistered ref returns `unknown_ref`;
  detail names `ref_kind` and `ref`.
- `service-cut-unknown`: export before any step returns `cut_unknown`,
  without detail.
- `service-id-reused`: abort with the same cut and operation but different
  refs returns `id_reused`, without detail.
- `wire-invalid-state`: abort after activation returns `invalid_state`;
  detail carries `step`. A ref-set mismatch can additionally carry
  `refs` with the cut's original refs.
- `receiver-not-exportable`: prepare with two refs resolving to the same
  session returns `not_exportable`, without detail.
- `receiver-cut-not-ready`: import before the session door has a sealed cut
  returns `cut_not_ready`, without detail.
- `receiver-local-advanced`: import over local rows with no matching move
  baseline returns `local_advanced`, without detail.
- `receiver-participant-failed`: import into a write-guarded project returns
  `participant_failed`; detail carries `reason`.
- `receiver-incompatible-version`: import into a store at a newer schema
  version returns `incompatible_version`; detail carries `found` and
  `required` format/version strings.
- `receiver-digest-mismatch`: import when the sealed digest does not match
  the stream bytes returns `digest_mismatch`, without detail. Activate can
  additionally supply detail with `reason` when staged bytes changed.
- `receiver-busy`: import into a locally running session returns `busy`;
  detail carries `refs`, whose entries name `ref_kind`, `ref`, `reason`, and
  the optional `reason_code`.
- `source-export-record_too_large`, `source-export-response_too_large`:
  export after the session door refuses an oversized record or response
  returns `participant_failed`; detail carries `reason` naming the door
  code and the prepared step. The session-door answers are controlled inputs;
  ck-mc's actual export code maps them into these refusal bodies.

`session_moving` and `session_moved` are refusals of session/app/context
access during and after moves, not agent-data operation refusal codes.
An agent-data request for a session held by another cut uses the contract's
state/busy refusals instead. The session door's `record_too_large` and
`response_too_large` errors are not agent-data codes: unrecoverable door
faults map to `participant_failed` where allowed, otherwise `unavailable`.
Agent-data request decoding has no separate oversized-body refusal code.

## Optional members and repeats

Prepare items include their stream, format, offsets, digest and frozen
state. Import items include `dropped` only when rows were omitted; the empty
session demonstrates its absence. Busy entries omit `reason` and `reason_code`
when idle. Describe always omits its optional opaque `detail` in ck-mc and
sets `external` to false; prepare's external-item list is empty. Describe can
return an empty ref-kind list when the runner is not a
ready verified participant, including when the catalog cannot be read.
Refusal detail is present only for codes that supply it. A reason or other
optional detail member may be absent when that failure supplies no value.

Prepare, export, import, activate, release and abort are keyed by cut and
operation. An identical accepted request replays the first reply's bytes,
even after a restart or later steps. Ref order is ignored for that comparison.
Different content under an answered key returns `id_reused`. Every later
operation must name the cut's original ref set. Refusals are not recorded:
a repeated refused request is evaluated again. Describe, busy, status and
diverged are fresh reads rather than stored replies. Abort of an unseen cut
is allowed; abort cannot undo activation, release, or an install in progress.

## A build with moves off

The module does not declare the service, so the daemon refuses to open the
route and no agent-data body exists. The wire caller observes
`target_unavailable`. That is the daemon's answer, not ck-mc's; its exact
text may differ between daemon versions. The separately sampled defensive
`unavailable` body is produced only by calling the disabled service in
process, not by a wire request.

## Not sampled

- The absent-route outcome with moves off has no agent-data JSON body.
- The contract's `external_not_present` code is not produced by ck-mc:
  this participant declares no external data and imports no external items.
- `session_moving` and `session_moved` belong to other contracts and cannot
  be decoded as an agent-data refusal.
- Malformed request bodies are not contract-decodable and are not published.
- Activate's staging-digest refusal is not separately sampled because its
  message contains the transient staging-file path. Import covers the same
  `digest_mismatch` code without a machine-dependent path.
- Operating-system-specific filesystem failures, timeouts, corruption of
  every store table, every door fault, and every optional refusal-detail
  variant are not separately sampled.

## Verification and regeneration

The owning tests regenerate these bodies through the real service and
decode them with the pinned contract's request, reply and refusal types.
They compare decoded/serialized values to reject silently discarded unknown
members, as well as checking typed refusal detail. Each producer owns its
filename prefix and rejects stale or unowned files. SHA256SUMS covers every
file other than itself, including this README.

Set `MC_REGENERATE_AGENT_DATA_SAMPLES=1` to rewrite the committed location,
or set it to an output directory. Run the service, source and receiver producers
first, then the wire producer, so the final SHA256SUMS includes all bodies.
The wire producer needs the same disposable daemon and mock-runner setup as
the other wire checks. Regeneration does not change a body to make it decode:
a decode or round-trip mismatch must be investigated as a contract defect.
