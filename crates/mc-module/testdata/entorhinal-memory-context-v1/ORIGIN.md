# Pinned Entorhinal vectors

These files were copied byte-for-byte from the Entorhinal repository, which owns
the `context.project` and `context.session` wire protocol.

The artifact handoff identifies the repository as `entorhinal` but supplies no
canonical remote URL. Source paths and commits below are upstream identifiers;
`SHA256SUMS` independently identifies the exact supplied bytes.

| File | Commit | Source path |
| --- | --- | --- |
| `context-project.json` | `19770194` | `test-vectors/memory-context-v1/context-project.json` |
| `context-session.json` | `2a296fd` | `test-vectors/memory-context-v1/context-session.json` |
| `README.md` | `2a296fd` | `test-vectors/memory-context-v1/README.md` |
| `context-session-populated.json` | `9e1eb8b` | `test-vectors/memory-context-v1/context-session-populated.json` |
| `README-9e1eb8b.md` | `9e1eb8b` | `test-vectors/memory-context-v1/README.md` |

`SHA256SUMS` pins all five upstream files. Both upstream READMEs are unchanged.
References in the upstream READMEs to other vectors describe the upstream
directory, not files vendored here. Tests read only these tracked copies, not
internal documents or files in another repository checkout.

The schema reference is Entorhinal `docs/memory-context.md` at `2a296fd`, SHA-256
`4b2ea5dd19044026837a68097259b4d35634629b3714ce35b7fdc731ccd137a4`.
The published wire types are documented in
[`cortexkit-agent-identity` 0.1.0](https://docs.rs/cortexkit-agent-identity/0.1.0/cortexkit_agent_identity/).
