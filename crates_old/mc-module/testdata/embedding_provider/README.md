# HTTP embedding parity fixture

`RemoteEmbeddingProvider` implements `parity_contract::EmbeddingProvider`, matching
TypeScript's `OpenAICompatibleEmbeddingProvider` HTTP protocol. It is not installed
in `ctx_search` and does not replace `UNAVAILABLE_EMBEDDING` or `UNAVAILABLE_LANES`:
retrieval integration requires a production transport and vector-store wiring.

- `openai-compatible` sends POSTs through an injected `HttpTransport`. A production
  HTTPS transport (native TLS or a scoped service) must be supplied by integration;
  `mc-module` currently has no HTTP/TLS dependency. The fixture's plaintext
  TCP transport is **test-only** and only connects to `127.0.0.1`. With no transport,
  availability reports `transport_unavailable`. Production transports must refuse
  redirects, never log/retry requests, and abort IO on cancellation, timeout or
  when the returned future is dropped.
- `local` reports unavailable: inference belongs to the local-encoder slice.
- `synapse` preserves its supplied `EmbeddingIdentity` but reports unavailable:
  Synapse embeddings use subc RPC; scheduled for a separate slice.
- `off` reports disabled. No configuration is resolved from environment variables,
  keys are never hashed, and the Rust client performs no logging.

For HTTP, the caller supplies the expected vector dimensions (TypeScript learns
these from its responses). `identity.fingerprint` is byte-identical to TypeScript's
stored `model_id`; `identity.model` retains the trimmed remote model name.
Recipes explicitly record float32 conversion with **no L2 normalization**, matching
the HTTP provider. Query-only instruction/input-type overrides do not change the
stored passage model ID, but do change the query recipe, so requests still must
match the provider's complete identity. Dimensions, recipes and generation are checked before IO;
configuration generation is checked again after IO. A vector store must separately
check current source hashes and writer generations before publishing.

The HTTP provider has no batch-size cap and no automatic retries after a failure.
It sends each supplied batch in one POST. HTTP 429 is back-pressure, as in
TypeScript, and never counts toward the circuit: the endpoint enters a cooldown
from `Retry-After` (delta-seconds or an HTTP date, capped at sixty seconds), or
else an exponential backoff from one second, doubled per consecutive 429, capped
at thirty seconds, plus up to 25% jitter. Queries fail at once with
`rate_limited` and send nothing during the cooldown; passage batches wait it out
and resend until a real result, cancellation or the caller's deadline. Unlike
TypeScript, which shares the cooldown between providers on the same endpoint and
API key, the cooldown belongs to one provider instance: this client keeps no
process-wide state and derives nothing from the key. Three failed calls in sixty seconds open the circuit
for five minutes; one half-open probe is admitted. A thirty-second internal timeout
counts as a failure, while caller cancellation/deadline and reload do not. Responses
with missing slots, empty/nonfinite vectors or wrong dimensions are typed failures,
not partial or empty success (TypeScript can return partial null slots).

## Differential proof

Run on Linux with four CPUs:

```
cargo test --locked -j 4 -p mc-module --test parity_embedding_provider -- --test-threads=1
cargo test --locked -j 4 -p mc-module --lib retrieval::embedding_provider::tests
bun run --cwd packages/plugin typecheck
bun packages/plugin/node_modules/typescript/bin/tsc -p crates/mc-module/testdata/embedding_provider/tsconfig.json --noEmit
```

The request test launches `capture.ts`, which imports the real TypeScript provider
and starts one ephemeral loopback HTTP server. TypeScript runs first, then Rust
uses the same cases and server. The server captures method, path, provider-owned
headers (credential values redacted, authorization scheme preserved), and **raw
JSON body bytes**. Automatically generated Host, Content-Length, Connection,
User-Agent, Accept and Accept-Encoding headers are excluded: the protocol adapter
does not own them. Unknown headers are retained and compared, and the fixture
transport rejects any provider-added headers other than content-type/authorization.
The test compares float32
bits, stored model IDs, error classes and retryability independently against the
TypeScript results. Cases cover every built-in HTTP model-prefix family, explicit
empty/false overrides, whitespace, Unicode/surrogate-safe truncation, query safety
margin versus passage limit, optional fields, batches, shuffled/absent indices,
HTTP failures, a 429 rate limit (reported by `capture.ts` as `rateLimited`, since
TypeScript records no failure class for it), malformed envelopes and model
substitution. A separate typed-error
test covers partial missing slots. No real network or store is used.

Mutation control: change `HTTP_BATCH_SIZE` in `embedding_provider.rs` from
`usize::MAX` to `2`. Only `requests_and_vectors_match_typescript_over_fake_http`
should fail, because the server captures extra POSTs. Revert the batch size to
`usize::MAX` before committing, then rerun:

```
cargo test --locked -j 4 -p mc-module --test parity_embedding_provider -- --test-threads=1
```
