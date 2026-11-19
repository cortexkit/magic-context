# `fleet.epoch_current` v1

These records come from the Entorhinal management handler and the `bus_changes`
publisher. The query is open to every local principal, takes `{}`, and serves
only local cached values. Missing fields are unknown, not zero.

- `current` is this computer's cached view of the committed epoch in the verified
  hub `epoch` record. It can briefly lag a rotation on another computer. Hold a
  message above `current` rather than dropping it.
- `highest_held` is the highest committed epoch this computer's vault reported
  holding. A pending mint counts for neither field. Going pending alone does
  not bump the marker.
- `marker-bump.json` gives the exact key and UTF-8 value put into the account-local
  `entorhinal.changes` bucket when a field changes. Watch `fleet_epoch`, then
  re-read `fleet.epoch_current`. A different `incarnation` means the publisher
  restarted; `generation` is comparable only within an incarnation.

The cases include a computer that hasn't switched to the hub yet, one unknown field at a time, a vault that is
current or behind, and an unknown request parameter. Reproduce the records with
`ENTO_WRITE_SERVED_VECTORS=1 cargo test --workspace --all-targets --locked -- fleet_epoch_current_served_records_and_marker`.
Verify the files with `shasum -a 256 -c SHA256SUMS` from this directory.
