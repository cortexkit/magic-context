# mc-app-read-samples-v19

The Alfonso desktop can read Magic Context on a paired computer through
Callosum. Callosum relays only management operations, so the existing app reads
are also declared as queries on the unscoped `ManagementSurface` target
`{module_id: "magic-context"}`. The caller is stamped by the daemon as
`reserved:callosum`; the bind harness starts with `fed-app:` for the desktop
or `fed-phone:` for the phone. The harness still keys the watch quota.

The phone still gets `session_data.read`, `context.cache_why`, `context.search`
and `context.watch`. The remote desktop also gets:

| Family | Additional reads |
| --- | --- |
| Session context | `context.states`, `context.head`, `context.head_section`, `context.compartment` |
| Memories | `memories.stats`, `memories.page`, `memories.get` |
| Observations | `observations.page` |
| Candidate facts | `facts.page` |
| Dreamer | `dreamer.status`, `dreamer.runs`, `dreamer.run` |
| Sessions | `sessions.page` |
| Notes | `notes.page` |

Callosum callers get the same allowlist even if bound to the internal service.
An operation outside a caller's list is refused with `unknown_method`.
`dreamer.docs_proposal` stays internal only: reading it can refresh the stored
proposal status. Direct access remains development-only and unchanged.

The role version and request and reply shapes are unchanged. Every v18 JSON
sample is copied byte for byte. Each new `fed-app-*.json` example shows the
bound `route` separately from the wire `request` and `response`, with one
successful exchange per added operation. The samples go through app admission
and dispatch against a temporary fixture store. The generator fixes the reply's
`as_of_ms` where present; it adds no fields to the wire reply. The status
example uses a project with no schedules so it does not depend on the host time
zone.

Regenerate from the workspace root:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib transport::app_relay_tests::samples_v19 -- --exact
```

Use an output directory instead of `1` for a read-only checkout. Without the
variable, the test checks every sample and the sorted JSON-only `SHA256SUMS`.
See the [v18 notes](../mc-app-read-samples-v18/README.md) for the previous
examples and their wire contracts.
