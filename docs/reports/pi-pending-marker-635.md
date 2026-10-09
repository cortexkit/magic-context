# Pi pending compaction marker: issue 635

## Finding

There is no separate ordinal-staleness defect in the reported `9` versus `10`
state. The pending marker records the **last summarized** ordinal; historian
publication advances the protected-tail floor to the **next** ordinal. Thus a
marker at `9` and `prior_boundary_ordinal = 10` are the normal result of the same
publication, not evidence that another boundary overtook the marker.

The reported late deferrals in the same session (#634) explain why the pending
marker had not drained: publication is ride-only work, not a reason to originate
a cache bust (`ARCHITECTURE.md:82`). No marker-specific fix is warranted; fixing
the pressure/deferral problem belongs to #634.

## Code path and drain conditions

- `packages/pi-plugin/src/pi-historian-runner.ts:1482` records the publication
  floor as `lastNewEnd + 1`; lines 1490-1497 save the pending Pi marker with
  `ordinal: lastNewEnd` in the same transaction. The monotonic floor update is
  `packages/plugin/src/features/magic-context/storage-meta-persisted.ts:460-474`.
- After publication, `packages/pi-plugin/src/context-handler.ts:4645-4646`
  queues **deferred** history/materialization signals. It does not request a
  flush. Restart/session activation re-arms the same signals via
  `packages/pi-plugin/src/index.ts:353-356`.
- `packages/pi-plugin/src/context-handler.ts:5710-5713` admits deferred work on
  execute/force passes; the shared bust permission at lines 5912-5946 also
  accounts for a real hard fold or explicit flush. Pending-ops application must
  succeed (lines 6255-6259), and history injection must be consumed successfully
  (lines 7083-7089). The final marker drain predicate is at lines 7150-7155.
- `packages/pi-plugin/src/context-handler.ts:5327-5353` requires coverage from
  rendered m[0] or freshly rendered m[1], without contention fallback. It accepts
  an equal **or later** rendered ordinal; it never compares against the
  protected-tail floor. The drain also requires the session APIs and folding
  system state (lines 7185-7197).
- `packages/pi-plugin/src/compaction-marker-manager-pi.ts:36-131` validates the
  compartment/end anchor, whole-message coverage and kept entry. Lines 111-120
  write through Pi's `sessionManager.appendCompaction(summary, firstKeptEntryId,
  tokensBefore, {source: "magic-context", lastCompactedOrdinal}, true)`. The
  session-manager binding is `packages/pi-plugin/src/context-handler.ts:4688-4704`.
  Already-current markers and explicitly stale targets are handled too. System
  snapshot equivalence is checked before CAS-clearing the pending blob and
  consuming the history signal (lines 7206-7277).

## What the supplied evidence can establish

The pending publication timestamp is `2026-10-08T03:04:22.185Z`. #634 supplies
late `decision=defer` rows and some execute examples, but no complete,
timezone-aligned post-publication decision trace. There is **no demonstrated
bust after this publication** in the supplied evidence. No later historian runs
and `compartment_in_progress = 0` do not independently prove that no bust
occurred: a bust can drain previously published work without starting another
historian run. This investigation used the issue text and repository code only;
it did not inspect the reporter's or operator's stores.

## OpenCode TS and Rust

Both OpenCode lanes have analogous durable pending work, but not Pi's native
session-entry payload:

- TS: `pending_compaction_marker_state`, with `ordinal`, `endMessageId`,
  `publishedAt` and optional injection-failure diagnostics
  (`packages/plugin/src/features/magic-context/storage-meta-persisted.ts:2868-2881`).
  The consuming-pass drain/coverage check and successful CAS-clear are at
  `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:3270-3349`.
- Rust mode: the TS host uses the same pending marker and only drains on a
  HARD/SOFT rebuild, after served-response coverage and cut admission are proven
  (`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:777-918`).
  Rust's durable transition shape is `PendingCompactionMarkerState { ordinal,
  end_message_id, published_at }` (`crates/mc-store/src/lib.rs:4427-4435`). Neither
  shape contains Pi's `firstKeptEntryId`, `summary` or `tokensBefore`.

## Regression

`packages/pi-plugin/src/context-handler.test.ts:6038` adds
`drains the published Pi marker at ordinal 9 with floor 10 on the first bust after low-usage defers`.
It uses the reported pending payload, compartments spanning 5-7 and 7-9, a
previously rendered 1-4 baseline, and the publication floor of 10. Within an
unexpired cache TTL, 1%, 9.56% and 15% passes defer, preserve the payload and replay
identical bytes. The first 81% execute pass renders the new history, appends the
native compaction entry and clears both deferred signals without another
publication or explicit flush. The existing drain implementation already passes
this test; there is no production behavior change.

## Draft bot reply (not posted)

Thanks — we checked the publication and drain paths. The `9`/`10` pair is normal:
the marker names the last summarized message, while `prior_boundary_ordinal`
names the next protected-tail message. It does not make the marker stale or
undrainable. Markers wait for a pass that is already rebuilding the prompt, so
the late deferrals in #634 explain the pending state; we found no separate
marker defect. We added a regression using your payload and ranges: low-usage
turns preserve the marker, and the first execute/bust drains it through Pi's
session API without another historian run. The supplied trace does not show a
post-publication bust; if it still fails after pressure is corrected or an
explicit `/ctx-flush`, the next useful evidence is that pass's decision and
`Pi compaction-marker` drain/equivalence logs.
