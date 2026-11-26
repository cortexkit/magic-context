# mc-app-read-samples-v22

`session_data.read` with `section: "meta"` adds two fields. The app-read role,
request, and other replies are unchanged. Every v21 JSON sample except `meta.json`
is copied byte for byte.

- `meta.json`: no failure recorded; `historian_last_error_at_ms` is `null` and
  `historian_failures_since_success` is `0`.
- `meta-historian-recovered.json`: a summary published after the last failure.
  The streak is `0`; the lifetime count, last error text, and last error time
  are still available.
- `meta-historian-failing.json`: failures have occurred since the last
  published summary; the streak is above `0`.

The last error time is in epoch milliseconds. An error recorded by an older
build has an unknown time (`null`) and does not start a streak. A reply from an
older build omits `historian_last_error_at_ms` and
`historian_failures_since_success`: read that as "not reported", not as `0`, and
fall back to `historian_failure_count`. Reading it as `0` would make a failing
summarizer on an older build look idle.

Regenerate from the workspace root:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib app_read::tests::samples_v22 -- --exact
```

Use an output directory instead of `1` for a read-only checkout. This test
regenerates v22 only; without the variable it checks every v22 sample and the
sorted, JSON-only `SHA256SUMS`. See the [v21 notes](../mc-app-read-samples-v21/README.md)
for the previous contract.
