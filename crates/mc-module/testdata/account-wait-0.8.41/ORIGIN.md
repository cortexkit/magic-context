# llm-runner 0.8.41 account-selection samples

Copied without modification from samples of Broca's real serve path
(`broca_module_serve`, a real `serve_connection`, registry and session actor)
under llm-runner 0.8.41. A routing stand-in answered `route.account_for` with
a refusal, and Broca's executor refused the send's admission with its own
conversion of it (`account_routing::classify_account_for_reply`). The
account labels (`acct1`, `acct2`) are synthetic. `SHA256SUMS` lists every
file; each hash matches the capture's own checksum list.

Every file comes from Broca's new session storage; its older WAL storage
answered the same bytes, apart from case 2's wall-clock reset time. Direct sends carried `session_class: "consult"`,
`send_id: "turn-1"` and a fetch plan (`new.plan`), as sends from the
CortexKit core do.

Outer codes: `account_limit_exhausted` and `account_selection_refused` are
account waits; `account_selection_final` is a final refusal, never a wait.

1. `1_account_limit_exhausted_retry_and_reset.new.plan.json`: the
   `session.send` error body `account_limit_exhausted` with `retry_after_s`
   120, `retry_after_secs` 120.0 and `resets_at_ms` (routing replied
   `account_pool_exhausted` with a wait and a reset).
2. `2_account_limit_exhausted_reset_only.new.plan.json`: routing gave only a
   reset 90 s after the request. Broca derives `retry_after_s` and
   `retry_after_secs` from it, so the body carries both. `resets_at_ms` is
   wall-clock time at capture.
3. `3_account_selection_refused_retry.new.plan.json`: `account_selection_refused`,
   class `transient`, with `retry_after_s` 30.
4. `4_account_selection_final_no_hint.new.plan.json`: routing's permanent
   `account_not_authorized`, mapped to `account_selection_final`, no timing.
5. `5_queued_<code>.new.*`: a second send (`send_id: "turn-2"`, with a fetch
   plan) queued behind a running run and refused at its own admission, for
   each of the three codes. `session_send.json` is its `pending` reply,
   `session_send_status.json` its `finished`/`error` status, and
   `run_status.json` the `run.status` of the run it would have started:
   state `error`, whose `error` carries the code as `provider_code`, its
   `class`, and the timing routing gave (`retry_after_secs`, `resets_at_ms`).
7. `7_unknown_code_final.new.plan.json`: a routing code Broca does not know
   (`route_state_unavailable`, with `retry_after_s` 60) is
   `account_selection_final`. The hint stays in `detail` but does not make it
   a wait.
