#!/usr/bin/env node
/**
 * aimock fixture for the OpenCode session smoke test.
 *
 * One turn: respond with a short text reply. We're not exercising tools
 * or historian here — those have full coverage in the in-process e2e
 * tests under packages/e2e-tests/. The docker layer just verifies that
 * the plugin loads on real OpenCode + Bun and tags at least one
 * message in the shared SQLite database.
 */
const { LLMock } = require("@copilotkit/aimock");

const port = parseInt(process.env.AIMOCK_PORT || "4010", 10);

async function main() {
    const mock = new LLMock({ port });

    // Catch-all fixture: respond to any chat-completion request with a
    // short text reply. Predicate returns true unconditionally so we
    // don't depend on sequenceIndex bookkeeping (OpenCode may issue
    // multiple requests per session: model-list probe, chat completion,
    // possibly a follow-up).
    mock.on(
        { predicate: () => true },
        {
            content: "hello",
        },
    );

    await mock.start();
    console.log(`aimock-opencode listening on http://127.0.0.1:${port}`);
}

main().catch((err) => {
    console.error("aimock-opencode failed to start:", err);
    process.exit(1);
});
