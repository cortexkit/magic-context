# Broca step liveness reader samples

The six JSON bodies and `SHA256SUMS` are byte-for-byte copies from
`CortexKit-scratch/shared-broca-readers/step-liveness-1126/`. The SHA-256 of
`SHA256SUMS` is `3b02e11678afa0b68e3232f6a067df315e62a16569bbde019fd06bdfe801cc67`.
All six entries were verified against it before and after copying.

Broca's `step_liveness_reader_samples` test captured these `run.status`
replies from a real serve connection with a loopback HTTP endpoint and a
held tool. The Unix millisecond timestamps belong to that capture. The
set does not contain a `role.describe` reply.
