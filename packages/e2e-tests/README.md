# @cortexkit/opencode-magic-context-e2e

End-to-end test harness for the Magic Context plugins (OpenCode and Pi). Spawns
a real `opencode serve` subprocess (or a Pi child process) pointed at a local
mock Anthropic server and drives sessions through the appropriate harness.

> Note: the package name retains its original `-e2e` suffix from when this only
> covered OpenCode; Pi e2e coverage was added alongside under `tests/pi-*.test.ts`.

## Running

```bash
# From repo root
bun run test:e2e

# Or directly in this package
cd packages/e2e-tests && bun test
```

## Architecture

- **`src/mock-provider/server.ts`** — Anthropic-compatible mock HTTP server. Accepts
  POST `/messages`, supports both SSE streaming (default for OpenCode) and single-shot
  JSON, lets tests script responses with precise control over
  `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`.
  Captures every request body for assertions.

- **`src/opencode-runner/spawn.ts`** — Subprocess runner that launches `opencode serve`
  with an isolated config/data/cache directory, a custom `mock-anthropic` provider
  pointed at the mock, and the magic-context plugin loaded from local source via
  `file://` spec. No npm install required; the plugin is loaded directly from
  `packages/plugin/src/index.ts`.

- **`src/pi-runner/`** + **`src/pi-harness.ts`** — Pi-flavored counterpart to the
  OpenCode runner. Spawns a real Pi child process pointed at the same mock
  Anthropic server and loads the Pi plugin from local source.

### Pi RPC harness

Pi e2e tests run through `pi --mode rpc`, not `pi --print --mode json`. Each
`PiTestHarness` owns one persistent Pi subprocess for its lifetime and talks to
it over strict JSONL on stdio: commands are newline-delimited JSON objects on
stdin, while stdout interleaves `type: "response"` command replies with async
agent events such as `agent_start`, `message_end`, and `agent_end`.

`harness.sendPrompt()` sends a `prompt` RPC command, collects the event slice
from `agent_start` through `agent_end`, and returns the historical
`PiRunResult` shape. Because the Pi process remains alive after each turn,
`exitCode` and `signalCode` are `null` until `harness.dispose()` shuts the
worker down. Multi-turn tests do not need `--continue`; the existing
`continueSession` option is accepted as a compatibility no-op.

The harness also exposes thin RPC helpers for tests that need persistent-process
state directly: `getState()`, `getMessages()`, `getSessionStats()`,
`compactNow()`, and `newSession()`.

RPC mode is available in the installed Pi peer range. The current peer is
`@earendil-works/pi-coding-agent@^0.71.0`; the lockfile resolves `0.71.1`, whose
packaged docs specify the JSONL RPC protocol, and the changelog shows the
current JSON protocol was introduced in `0.16.0`.

- **`tests/*.test.ts`** — Test suites. OpenCode-flavored suites use `harness.ts` /
  `opencode-runner`; Pi-flavored suites (`tests/pi-*.test.ts`) use `pi-harness.ts` /
  `pi-runner`. Each test creates a session, sends prompts, and asserts against
  SQLite state, log output, and captured mock requests.

## Requirements

- `opencode` CLI available on PATH for OpenCode suites (`which opencode`).
- Pi CLI installed for Pi suites (see `packages/pi-plugin/README.md`).
- Bun.
- No `OPENCODE_SERVER_PASSWORD` required — the spawner explicitly strips it so the
  test server runs unsecured on a random localhost port.

## Writing a test

```ts
import { MockProvider } from "../src/mock-provider/server";
import { spawnOpencode } from "../src/opencode-runner/spawn";

const mock = new MockProvider();
const { baseURL } = await mock.start();
const opencode = await spawnOpencode({ mockProviderURL: baseURL });

// Script exactly what the main agent should return on each turn.
mock.script([
    { text: "response 1", usage: { input_tokens: 10_000, output_tokens: 50 } },
    { text: "response 2", usage: { input_tokens: 50_000, output_tokens: 50, cache_read_input_tokens: 10_000 } },
]);

// Drive the session via the SDK.
const { createOpencodeClient } = await import("@opencode-ai/sdk");
const client = createOpencodeClient({ baseUrl: opencode.url });
const { data: session } = await client.session.create({ query: { directory: opencode.env.workdir } });
await client.session.prompt({
    path: { id: session!.id },
    body: {
        model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
        parts: [{ type: "text", text: "turn 1" }],
    },
});

// Assert against captured requests and plugin state.
expect(mock.requests().length).toBe(1);

await opencode.kill();
await mock.stop();
```
