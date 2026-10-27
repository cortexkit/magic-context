# Prefrontal ask-answer notices v1 — vendored test fixtures

These files are byte-for-byte copies of Prefrontal's
`test-vectors/ask-answer-notice-v1/` directory (the seven JSON files, not its
`README.md` or `SHA256SUMS`), taken from Prefrontal main at commit

    843ba9d2d

Prefrontal renders the ask notices that reach a host as a `<system-reminder>`
inside a user message. Magic Context's historian readers
(`cleanUserText` in `packages/plugin/src/hooks/magic-context/read-session-chunk.ts`
and its Rust twin `clean_user_text` in `crates/mc-module/src/historian_chunk.rs`)
strip every reminder block except the one where the user answers a parked ask.
They identify that notice by matching its text, so they are tested against the
exact rendered text instead of a re-typed approximation. The fixtures are
vendored so the test suites do not need a Prefrontal checkout.

Each JSON file holds one JSON string. Decoding it yields the exact UTF-8 text
Prefrontal delivers to the head agent. The file-cut newline is not part of the
decoded notice. `batch.json` carries two notices in one delivery, each in its
own envelope, separated by a blank line.

**Upstream warns that changing these vectors changes a cross-component text
contract** and must be announced to Magic Context before it ships. When
Prefrontal ships a new notice shape, re-copy the directory and update this file
instead of editing the JSON by hand.

## SHA-256 of each vendored file

    944b5d8c49cd24f0b36e0cba8b34368b28a9667d6cc1f296af4bfb87973d4a14  batch.json
    01d92841d3853735340a729f6e66e2b2882488c8567851c152d3eea104aa0859  clarification.json
    47ea4668e65afc802d4117f09d2c8832163a4d2e514d11836407d5104e46edbd  dismissal.json
    db134f0a901066825f884173465a46ccb71b049b59817545ed21379d322b086a  form.json
    292bee31e987d83c463892d6778ce93d34b09b26a4bea93f2cc0ecb2aaee6f14  single-option.json
    71460d7237631256cc4a5b0408819e09a2a753bf4de3f668da4f89e5bde07d60  two-round-follow-up.json
    9b9ac6236264ea0941516f0d9414e4dbde33de61f7c7fa30e73864e4287dac7e  typed.json
