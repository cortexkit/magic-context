# Broca run events from sessions in the new storage (1116)

Five publications, written by broca's real code path from store-actor test runs: the run's
records feed the new-storage projector, the events go through broca's outbox
(`record_run_events`), and each file is the `Publication` the publisher sends
(`pending_bus_event`), with its subject, `Nats-Msg-Id`, headers and body.

1. `run.started`, 2. `run.steer_consumed`, 3. `run.ended`: one run (`r1`) with a steer.
4. `run.started`, 5. `run.paused`: a second session's run (`r2`) paused for sign-in.

The machine account is the synthetic `box_sample`. `epoch` is the session's incarnation
(32 hex); `seq` is the record's seq in the session's store. The id is
sha256(JCS([epoch, run_id, seq, subject, null])), as for today's run events.

`at_ms` is 1 on both `run.started` because the test's send carries admission time 1. In
production, it is the run's admission time.

All five name the session (harness `store-actor`, session `s1`), so `session_ref` is
`session_ref(&SessionIdentity { runner: "broca", harness: "store-actor", session: "s1" })`
= `32db1a5342168526c10b5dedf01c1760`.
