# @cortexkit/opencode-magic-context-e2e

End-to-end test harness for the magic-context plugin. Spawns a real `opencode serve`
subprocess pointed at a local mock Anthropic server and drives sessions through the
OpenCode SDK client.

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

- **`tests/*.test.ts`** — Test suites. Each test creates a session, sends prompts
  through the SDK, and asserts against SQLite state, log output, and captured mock
  requests.

## Requirements

- `opencode` CLI available on PATH (`which opencode` should succeed).
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
