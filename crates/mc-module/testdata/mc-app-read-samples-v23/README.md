# mc-app-read-samples-v23

`context.states` and the `producers` form of `context.cache_why` no longer
return `session_kind`. The desktop and phone examples omit it for both ready
and unchanged replies. No request, version token, or other response member
changes. Every other JSON sample is copied byte for byte from v22.

Regenerate from the workspace root:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib app_read::tests::samples_v23 -- --exact
```

Use an output directory instead of `1` for a read-only checkout. Without the
variable the test checks every v23 sample and the sorted, JSON-only
`SHA256SUMS`. See [v22](../mc-app-read-samples-v22/README.md) for the prior set.
