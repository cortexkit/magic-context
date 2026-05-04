#!/usr/bin/env node
/**
 * aimock fixture for the Pi session smoke test.
 *
 * One turn: respond with a short text reply. We're not exercising tools
 * or historian here — those have full coverage in the in-process e2e
 * tests under packages/e2e-tests/. The docker layer just verifies that
 * the Pi extension loads on real Pi + Node and tags at least one
 * message in the shared SQLite database with harness='pi'.
 */
const { LLMock } = require("@copilotkit/aimock");

const port = parseInt(process.env.AIMOCK_PORT || "4010", 10);

async function main() {
    const mock = new LLMock({ port });

    mock.on(
        { sequenceIndex: 0 },
        {
            text: "hello",
        },
    );

    await mock.start();
    console.log(`aimock-pi listening on http://127.0.0.1:${port}`);
}

main().catch((err) => {
    console.error("aimock-pi failed to start:", err);
    process.exit(1);
});
