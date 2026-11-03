#### `PROJECT_RULES`

**Test**: "Should a new developer/agent follow this to avoid breaking things during normal recurring work?"

A durable behavioral expectation for the project — how the developer/agent should approach recurring activities like commits, releases, debugging, dogfooding, benchmarks.

**Positive examples**:
- "After every fix, commit + build both Rust binary and TypeScript plugin before continuing."
- "Use AFT tools for code investigation, not shell commands."
- "Disable explore and general agents for fair AFT benchmark comparison."
- "Run benchmark runners from a fresh terminal outside an active OpenCode session."
- "Use scripts/release.sh VERSION for releases."

**Negative examples (do NOT extract as PROJECT_RULES)**:
- "Run npm install" — one-time action, not a recurring rule.
- "Should we add ast-grep?" — question, not a committed rule.
- "I think we should add X" — speculation.
- "We renamed Y to Z" — naming fact (NAMING), not a behavior rule.
- "Latest version of tree-sitter" — one-time upgrade directive, captured in compartment narrative.

