# Served role lease v1

These samples capture the real Entorhinal management handler through the
`subc-client-rs` SDK's in-process `ModuleHarness`. The lease updates and the monotonic
clock are simulated; the request admission, watch, acknowledgement and response
paths are not. Each record names an `op`, the `request` params, the bound
`principal` and observed `frames`. Send `{"method":op,"params":request}` on
the management route. Frame bodies are the exact JSON bytes served by the
handler; an empty `StreamEnd` body is shown as `null`.

- `holding.json`: Plexus may act for `connector_home` at the notice's `gen`
  while the acting window is live.
- `not-holding.json`: Magic Context cannot act for the project role; the watch
  is open and it remains a candidate.
- `lapsed.json`: Magic Context initially holds the workspace role. Nothing
  extends its acting window, so it stops acting at the deadline even though the
  stream is still open. The final `StreamEnd` is the test closing the watch,
  not an expiry signal to wait for.
- `handback.json`: `handback: true` on a holder's notice means another computer
  has asked to take the role; finish in-flight work and close the watch. Ack the
  notice as usual.
- `ack.json`: acknowledge every notice, even `holding: false`, within 5 seconds
  using `role.lease.ack {role, seq}` on the same bound route as the watch. A
  second route with the same principal cannot ack, as marked by the fixture's
  `differentRoute` annotation. Explicit release also requires the original route.
- `refusals.json`: an empty name part, a role assigned to a different module,
  a Direct caller and a flow-scoped caller (marked `flowScoped`) are refused.
- `sharing-disabled.json`: both admitted consumers get generation 1 locally,
  including a fresh notice at the 20-second renewal.
- `engram-sharing.json`: Plexus follows the Engram claim's epoch and stops
  holding when the claim becomes stale. Magic Context holds locally even with
  Engram sharing enabled.

## Names and admission

A name has at most 128 ASCII bytes. Nonempty parts separated by `.` may contain
only lowercase letters, digits, `_` and `-`. Entorhinal prepends `role.` to form
the hub KV key. The closed admission table is `connector_home` for
`reserved:plexus` and `dreamer.<rest>` for `reserved:magic-context`; these
include `dreamer.<project id>` (including `pj-` ids), `dreamer.<workspace id>`
and `dreamer.global`. Other principals or roles fail with `caller_forbidden`;
Direct and flow-scoped routes are never candidates.

## Acting window

For `holding: true`, use the absolute deadline `issued_at_ms + valid_for_ms`,
not receipt time plus the duration. Entorhinal uses **`CLOCK_MONOTONIC`** on
Linux and macOS and **`GetTickCount64()`** on Windows, in milliseconds. The
consumer must use the same OS clock, never wall time or Rust's `Instant`.
Before each irreversible act, check the deadline and record `gen` (the role's
ownership generation) in the module's journal. Refuse a generation older than
the highest one the journal has seen for that role.

The notice shape is the same in all sharing modes:

1. **Sharing disabled:** An admitted role is granted locally as generation 1,
   renewed every 20 seconds, and stops when its watch closes. No writes occur.
2. **Engram sharing (not on the hub):** `connector_home` holds at the claim's
   epoch only while the cached `role.read` is `held_here` and not `stale`.
   `dreamer.*` is still local generation 1.
3. **Hub mode:** The hub's role record arbitrates ownership. A candidate has
   no acting window before its first confirmed renewal. If the hub becomes
   unreachable, no renewal extends the window and the holder must stop by the
   last notice's deadline.

## Reproduce and verify

From the repository root:

```sh
ENTO_WRITE_SERVED_VECTORS=1 cargo test --workspace --all-targets --locked served_role_lease_v1_records_match_published_files -- --nocapture
ENTO_WRITE_SERVED_VECTORS=1 cargo test --workspace --all-targets --locked served_role_lease_v1_non_hub_records_match_published_files -- --nocapture
```

Without `ENTO_WRITE_SERVED_VECTORS` the drift test byte-compares the served
records with the published ones. Refresh `SHA256SUMS` in this folder after a
reviewed fixture change (`shasum -a 256 *.json > SHA256SUMS`).
