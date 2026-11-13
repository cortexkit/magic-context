# Broca normalized provider-code reader bodies

These bodies and their `SHA256SUMS` lines are copied byte-for-byte from
`CortexKit-scratch/shared-broca-readers/run-provider-code-1113/`. Broca's real
actor fixtures emitted them using synthetic providers and accounts. `store`
denotes new storage; `legacy` denotes its older storage implementation.

The bodies pin `provider_error` for a codeless permanent error, `transient`
for a codeless transient error, and `auth_required` for a codeless sign-in
pause. New storage supplies the corresponding typed `awaits`; legacy storage
omits it and must retain the caller's previous classification. The original
`provider_subcode` and `provider_details` fields remain untouched. Tests decode
every copied body against llm-runner 0.8.47 and verify the published hashes.
