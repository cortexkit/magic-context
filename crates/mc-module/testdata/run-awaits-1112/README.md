# Broca run-await reader bodies

These bodies and their `SHA256SUMS` lines are copied byte-for-byte from
`CortexKit-scratch/shared-broca-readers/run-awaits-1112/`. Broca's real actor
fixtures and serving serializers emitted them using synthetic providers and
accounts, not live stores. `after` denotes Broca's new storage implementation.

`run_awaits_tests.rs` decodes the bodies through llm-runner's types. Tests use
the original party and lifecycle where possible; typed variants change state,
party or timing explicitly to exercise reader fallbacks and retry precedence.
Broca omits `awaits` on nonterminal results, so the status tests deliberately
leave that result field absent. A runner-owned terminal error is a defensive
reader case, not a body permitted for a runner that declares the `run_awaits`
contract capability.

The included terminal account, transient, final and sign-in bodies exercise
the contract's caller, nobody and person mappings. The held-tool and account
pause statuses exercise runner-owned waits. The auth status and result show
why readers must consult status before treating an authentication pause as a
timeout.
