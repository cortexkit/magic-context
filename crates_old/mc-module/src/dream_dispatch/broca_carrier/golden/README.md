# Vendored Broca wire goldens

These files are copied byte-for-byte from the Broca repository, so the fake Broca in
`../tests.rs` answers with the deployed runner's shapes. Do not edit them. To refresh
them, copy the new files from Broca and update the commit and checksums here and in
the `broca_goldens_match_their_pinned_checksums` test.

| File | Source path in Broca | sha256 |
|---|---|---|
| `role_describe.json` | `crates/broca-wire/tests/golden/role_describe.json` | `b02c1aeba85bfc1ad3a6dde615ba049c047e1f5f2ced66f90043c4fe34a5b0a2` |
| `run_status.budget_exhausted.json` | `crates/broca-wire/tests/golden/run_status.budget_exhausted.json` | `45452b91e62fa53be019c22c3bd5f1db3af487d73bf8645c5516b2f53648955f` |

Source: Broca commit `9772ee0` ("Bump workspace to 0.3.212"), the first release that
deploys the hard input-token cap (`input_token_cap`, llm-runner 0.2.4).

## Shared input-token cap cases

`llm-runner-conformance-0.4.0/input_token_cap.rs.txt` is `src/input_token_cap.rs` from the
crates.io package `cortexkit-role-llm-runner-conformance` 0.4.0 (crate checksum
`6487ed3ec61f2b72c6050cd4e2e8c93ed0be170c5a41dc02c3fc648d141e9032`, commons commit
`f82af7e8029237a9371d1a3b28214e48bd37bbff`, path in that repository
`crates/cortexkit-role-llm-runner-conformance/src/input_token_cap.rs`), sha256
`2b28df81080ec88199cb984f907e58ce1e0c0fe7dc1c02ba948cb55ef2f4084f`.

It holds the six cap cases BROCA runs (`input_token_cap_at_limit`, `_crossing_tools`,
`_usage_unreported`, `_raise_refused`, `_closed_members`, `_restart_between_episodes`).
The first five are matched by name in this file; the restart case is the file's
`restart` function, which the crate's `src/runner.rs` runs under that case name.
The crate itself is not a dependency: taking it would add a second commons provider
pin to Cargo.lock. It is kept as text (`.rs.txt`) so it is never compiled; the carrier
tests replay its numbers against the fake Broca.
