# Account-move run errors

Copied without modification from the parent checkout's staged sample set
`corpus-readonly/account-move-1112-r2/`, whose `SHA256SUMS` hashes to
`36eb5c65ef7154ac4ef3dc23cbfe3f281400599f019b87df41b736b8211b1a5d`. Only the
four `run.result` answers are copied; `SHA256SUMS` here lists them, and each
hash matches the source list.

Each is the `run.result` answer of a run that ended `error` at an account's
usage wall (`provider_code: "account_limit_exhausted"`, `resets_at_ms`
1900000000000, `limit_window: "seven_day"`):

- `before.run.result.json`: as a runner reported it before account moves.
- `after-refusal.run.result.json`: with the diagnostic `account_continue`
  (`routing_code: "account_pinned"`).
- `after-hold-without-until.run.result.json`: `account_continue` with
  `routing_code: "no_compatible_account"` and no time.
- `after-hold-with-until.run.result.json`: routing named when another account
  should have room, so the error also carries `retry_after_secs` 3600.0, and
  `account_continue` carries that time as `until_ms`.
