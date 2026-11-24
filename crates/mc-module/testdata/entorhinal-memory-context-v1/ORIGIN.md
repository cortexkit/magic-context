# Pinned Entorhinal vectors

These files were copied byte-for-byte from the Entorhinal repository, which owns
the `context.project` and `context.session` wire protocol.

The artifact handoff identifies the repository as `entorhinal` but supplies no
canonical remote URL. The tag and path below are upstream identifiers;
`SHA256SUMS` independently identifies the exact supplied bytes.

Every file is copied from Entorhinal tag `hub-only-samples-v1` (main `291c1ed`),
from `test-vectors/memory-context-v1/`. That tag changed only the legacy claim
fields of `context-session-populated.json`'s held-elsewhere record; the fields
Magic Context reads are unchanged. This copy also carries
`workspace-document.json`, which the upstream `SHA256SUMS` lists.

`SHA256SUMS` is the upstream one and pins every file listed in it.
References in the upstream READMEs to other vectors describe the upstream
directory, not files vendored here. Tests read only these tracked copies, not
internal documents or files in another repository checkout.

The schema reference is Entorhinal `docs/memory-context.md` at `2a296fd`, SHA-256
`4b2ea5dd19044026837a68097259b4d35634629b3714ce35b7fdc731ccd137a4`.
The published wire types are documented in
[`cortexkit-agent-identity` 0.1.0](https://docs.rs/cortexkit-agent-identity/0.1.0/cortexkit_agent_identity/).
