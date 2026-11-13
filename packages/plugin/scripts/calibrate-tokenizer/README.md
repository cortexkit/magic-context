# Tokenizer calibration

Run from the plugin directory:

```sh
bun run scripts/calibrate-tokenizer/index.ts --only claude-opus-4-7,claude-sonnet-4-6,claude-fable-5-1,claude-opus-5
```

Credentials come only from explicit environment variables on the machine. The harness never reads loose key files or a host's auth/config file. A missing variable skips that provider with one line naming the variable. A 401 or 403 stops the entire run immediately, naming only the provider, model and HTTP status; there is no retry or alternate credential. A 404 records "model not found for this credential" for that model and continues. Other failures keep their existing per-model handling. Provider error bodies and headers are not printed.

Anthropic accepts either `ANTHROPIC_API_KEY` (sent as `x-api-key`) or `ANTHROPIC_OAUTH_TOKEN` (sent as a bearer); setting both refuses startup. Both use `POST /v1/messages/count_tokens?beta=true` with `anthropic-beta: oauth-2025-04-20`. Subscription OAuth was verified on 12 Nov 2026: `claude-opus-5-5`, `claude-fable-5-2` and `claude-fable-5-1` returned 200; `claude-mythos-5-2` returned 404 `not_found_error` for that login. Anthropic never generates: there is no paid fallback, including when counting fails or `--allow-generation` is supplied.

For a vault credential, run this wrapper from the repository root (the enrolled `mc-e2e` consumer must have a read grant):

```sh
bun packages/e2e-tests/src/live-providers/calibrate.ts <credential id> <env var name> -- <calibration args...>
bun packages/e2e-tests/src/live-providers/calibrate.ts oauth:anthropic ANTHROPIC_OAUTH_TOKEN -- --only claude-fable-5-2,claude-mythos-5-2
```

The wrapper fetches one credential, extracts the access token from a subscription JSON object or uses bare string material unchanged, and holds it in memory only. It clears inherited provider credential variables and supplies only the selected variable to the child, never argv, disk or printed output. Child output passes through and the wrapper exits with its status. The calibration script itself does not import the vault client.

Generation-only routes are skipped by default. `--allow-generation` deliberately enables the compatible adapter's 1-token requests for GitHub Copilot, Cerebras, OpenRouter, Fireworks, OpenCode Go, Inception and MiniMax (including its regional route); these can spend API credit or draw on a subscription's limit. Their variables are `GITHUB_COPILOT_TOKEN`, `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, `FIREWORKS_API_KEY`, `OPENCODE_API_KEY`, `INCEPTION_API_KEY`, `MINIMAX_API_KEY` and `MINIMAX_CN_API_KEY`, respectively. The `openai-codex/*` route uses `OPENAI_OAUTH_TOKEN` with the same flag: it sends a real generation request whose reply is **not capped** and is read whole, drawing on the ChatGPT sign-in's limit. The flag never changes a count adapter into generation or enables fallback after a count failure.

SYSTEM is the repository system fixture; TOOLS is the repository's 39-tool fixture. PROSE joins public ARCHITECTURE.md and STRUCTURE.md inside project-docs, 52 synthetic tiered compartments through the real decay renderer inside session-history, and 60 synthetic `#id: fact` memories. Prose is measured as first-user-message text, appended to the baseline `x`. Each probe subtracts the same model's one-token-user-message baseline. Local tools counts use JSON.stringify of the tool array, not SDK-expanded tool counts. Results retain earlier, unselected model rows.

## Anthropic measurements — 2026-09-21

All four models accepted the free endpoint. Ratios are provider count / raw local count.

| Model | Method | SYSTEM | TOOLS | PROSE | Docs | History | Memory |
|---|---|---:|---:|---:|---:|---:|---:|
| claude-fable-5-1 | count_tokens | 1.511497 | 1.551639 | 1.571778 | 1.540424 | 1.597525 | 1.792429 |
| claude-opus-5 | count_tokens | 1.511497 | 1.551639 | 1.571778 | 1.540424 | 1.597525 | 1.792429 |
| claude-opus-4-7 | count_tokens | 1.511497 | 1.569801 | 1.571778 | 1.540424 | 1.597525 | 1.792429 |
| claude-sonnet-4-6 | count_tokens | 1.019447 | 1.143337 | 1.057976 | 1.055501 | 1.054887 | 1.128031 |

Cross-check against shipped SYSTEM/TOOLS: Opus 4.7 +0.099143% / -0.012669%; Sonnet 4.6 -0.054200% / +0.292753%. Both pass the 5% stop threshold. Existing system/tools table values are retained for these controls. Prose defaults to 1.0 for unmeasured entries. Fable 5.2 stays neutral; Fable 5.1 snapshots match the measured prefix. OpenRouter and Copilot aliases mirror upstream 5.x ratios following the existing 4.7/4.8 convention, not independent route measurements.

Synthetic memory drifts more than documentation/history, so these are content-dependent approximations, not exact tokenizers. The real-session regression uses rounded local sidebar readouts with a parent-approved 5% band around exact count_tokens references (a 3% band would imply false precision). Its exact before/after split is:

| Bucket | Before (neutral) | After (measured Fable) |
|---|---:|---:|
| System | 9,000 | 13,603 |
| Tool definitions | 19,000 | 29,481 |
| Compartments | 98,000 | 154,034 |
| Facts | 0 | 0 |
| Docs | 36,000 | 56,584 |
| Memories | 15,000 | 23,577 |
| Profile | 4,000 | 6,287 |
| Conversation | 126,909 | 89,612 |
| Tool calls | 222,091 | 156,822 |
| Total | 530,000 | 530,000 |

Residual tool calls still exceed the raw local 70K: calibration removes misattributed m0 drift but cannot identify the remaining unmeasured conversation/tool drift. No budget, hygiene, historian, or transform decision changes. Plugin replay identity tests passed, including the full suite's pre-optimization served-wire digest, byte-identical hot passes, and four pure defer passes preserving served bytes.

## OpenAI API-key measurements

Reference: https://developers.openai.com/api/docs/guides/token-counting?lang=python (read 2026-09-21). The current guidance documents a server-side `POST /v1/responses/input_tokens`, including gpt-6-astra; this is not a tiktoken approximation. Uses only `OPENAI_API_KEY`. SYSTEM goes in `instructions`; TOOLS maps the same fixture to Responses function definitions; PROSE is user input. All subtract a minimal-user baseline. The four extra system tokens and one extra prose token are envelope/separator differences retained in the reported ratios.

| Model | Method | SYSTEM | TOOLS | PROSE | Docs | History | Memory |
|---|---|---:|---:|---:|---:|---:|---:|
| openai/gpt-5.5 | responses/input_tokens | 1.000278 | 0.850953 | 1.000017 | 1.000032 | 1.000043 | 1.000426 |
| openai/gpt-6-astra | responses/input_tokens | 1.000278 | 0.850953 | 1.000017 | 1.000032 | 1.000043 | 1.000426 |

Both accepted. Existing openai-codex/* result rows and OAuth routing remain separate and unchanged. The GPT-5 fallback test excludes 5.5 now because its more-specific measured entry deliberately supersedes the family default. No unmeasured provider aliases added.

### Sol inherited seeds — 2026-09-30

The `openai/gpt-6-sol` and `openai/gpt-6.1-sol` seeds mirror Astra, not independent measurements. Their seed `provenance` metadata marks prose as inherited-unmeasured. Reported ChatGPT OAuth fixture counts are 14,400 SYSTEM and 17,362 TOOLS for both Sol models, matching GPT-5.5; prose was not measured on that route.

Attempted `bun run scripts/calibrate-tokenizer/index.ts --only gpt-6-sol,gpt-6.1-sol,gpt-6-astra` with an isolated HOME to avoid live credentials/stores. All three returned `SKIP: no API key for openai`; no OPENAI_API_KEY was available to the harness. The free Responses route includes the prose fixture, but could not measure any class without an API key. OAuth usage does not measure prose. No existing measured result rows were overwritten in the delivered changes. Retry the same command with an endpoint-authorized OPENAI_API_KEY to replace the inherited approximation.

## Kimi / Moonshot

Reference: https://platform.kimi.ai/docs/api/estimate. Adapter sends SYSTEM as a system message, TOOLS as chat function schemas, and PROSE as a user message to `POST https://api.moonshot.ai/v1/tokenizers/estimate-token-count`; reads `data.total_tokens`, baseline-subtracted. Credentials: only `MOONSHOT_API_KEY`. The docs list kimi-k2.6 but do not explicitly list a tools field in the estimate schema; the tools cross-check will stop the harness if a server silently ignores it.

2026-09-21: both moonshot/kimi-k2.6 and moonshot/kimi-for-coding returned HTTP 429 on the minimal baseline. Method `tokenizers/estimate-token-count`; SYSTEM/TOOLS/PROSE and section ratios unavailable, cross-check not reached. No paid fallback was used and no Kimi table entries were added or changed. Retry with an endpoint-authorized key/quota before calibrating. The existing opencode-go/kimi-k2.6 0.87/0.86 remains the 5% cross-check reference, not a substituted measurement.

## Z.ai GLM

Reference: https://docs.z.ai/api-reference/tools/tokenizer. Uses only `ZAI_API_KEY` and `POST https://api.z.ai/api/paas/v4/tokenizer`, reading usage.prompt_tokens. SYSTEM is a system message, TOOLS chat function definitions, PROSE user text; each subtracts a minimal-user baseline. Although the documentation's model enum is older, glm-5, glm-5.1 and glm-4.7 are attempted explicitly rather than substituted with another generation.

2026-09-21: all three models returned HTTP 429 on the minimal baseline. Method `paas/v4/tokenizer`; all probe and section ratios unavailable, cross-check not reached. No GLM entries changed or guessed. Configured references are opencode-go/glm-5.1 (1.0/1.06) for 5/5.1 and cerebras/zai-glm-4.7 (1.0/1.09) for 4.7; retry when this key has endpoint access/quota.

## xAI Grok

Reference: https://docs.x.ai/developers/rest-api-reference/inference/other#tokenize-text. Uses only `XAI_API_KEY`. `POST https://api.x.ai/v1/tokenize-text` counts the returned token_ids array. SYSTEM sends the unchanged text content of the chat system message; TOOLS sends JSON.stringify of the chat `[{type:"function",function:{name,description,parameters}}]` array mapped from the canonical fixture. PROSE and sections send exact text bytes. There is no wrapper to subtract. The local tools denominator remains JSON.stringify of the canonical fixture, matching historical calibration.

| Measured native id | Method | SYSTEM | TOOLS | PROSE | Docs | History | Memory |
|---|---|---:|---:|---:|---:|---:|---:|
| grok-4-latest | tokenize-text | 0.817751 | 0.880494 | 0.880137 | 0.800661 | 1.001109 | 0.950223 |
| grok-code-fast-1 | tokenize-text | 0.817751 | 0.880494 | 0.880137 | 0.800661 | 1.001109 | 0.950223 |

2026-09-21 cross-check deltas: Grok 4 SYSTEM -0.274303%, TOOLS +0.056132%; Code Fast SYSTEM -0.274303%, TOOLS -1.068095%. Both pass 5%; ratios below one preserve the over-count correction sign. Only measured native-id prefixes gain entries; broader existing fallback entries remain unchanged. Raw tokenization does not measure the provider's hidden chat/tool prompt template; its residual method error versus billed chat tokens is unmeasured, not zero. Passing the historical cross-check bounds fixture disagreement, not arbitrary chat overhead.

## Gemini

References: https://ai.google.dev/gemini-api/docs/generate-content/tokens and https://ai.google.dev/api/tokens. Uses only `GEMINI_API_KEY` in x-goog-api-key; never antigravity OAuth. Calls `/v1beta/models/<id>:countTokens` with generateContentRequest containing systemInstruction, contents, and functionDeclarations with parametersJsonSchema. Baseline-subtracted. Local estimates use the harness's Claude encoding fallback (tokenizerKey null). Missing keys produce a skip rather than trying OAuth.

| Model | Method | SYSTEM | TOOLS | PROSE | Docs | History | Memory |
|---|---|---:|---:|---:|---:|---:|---:|
| google/gemini-3.8-flash | countTokens | 0.961167 | 0.967504 | 1.006909 | 0.976732 | 1.044089 | 1.094853 |
| google/gemini-3.7-flash | countTokens | 0.961167 | 0.967504 | 1.006909 | 0.976732 | 1.044089 | 1.094853 |
| google/gemini-3.1-pro-preview | countTokens | 0.961167 | 0.967504 | 1.006909 | 0.976732 | 1.044089 | 1.094853 |
| google/gemini-2.5-pro | countTokens | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |

2026-09-21: 2.5-pro returned HTTP 404 on the baseline; no entry added. The existing table had no google/antigravity pairing convention, so no antigravity aliases were inferred. No prior Gemini table values exist to cross-check.

## Meta Muse

Reference: https://dev.meta.ai/docs/token-counting. Base URL https://api.meta.ai, Bearer auth only from `META_API_KEY`. Uses Responses-shaped `POST /v1/responses/input_tokens`, method `input_tokens`; Anthropic-compatible count_tokens is also documented but was not used. SYSTEM= instructions, TOOLS=Responses function definitions, PROSE=user input, all baseline-subtracted. Preflight counts include rendered prompt scaffolding; generation usage is cumulative across hosted-tool iterations with injected-token accounting adjustments, so it is not final-context occupancy or directly comparable billing. This caveat is also stored on every Meta result row.

2026-09-21 GET /v1/models returned: sam-3.1, muse-spark-1.3-contributor, muse-voice-transcribe-1.0, muse-spark-1.3, muse-image-1.0, muse-spark-1.2-contributor, muse-spark-1.2, muse-spark-1.1. All five Spark models were selected; no separate code model was listed. Each returned HTTP 402 on the minimal counting baseline. All SYSTEM/TOOLS/PROSE and section ratios are unavailable; no Meta or Zen alias table entries were invented. An account authorized for the free counting endpoint is required to finish these measurements; no payment or completion was attempted.

## DeepSeek V4 offline Hugging Face tokenizer

Run `--providers deepseek`. Uses offline tokenizer files on the machine (set `DEEPSEEK_TOKENIZER_DIR` to an explicit path such as `./tokenizer-data`), copying only tokenizer.json and tokenizer_config.json into gitignored packages/plugin/node_modules/.cache/calibrate-tokenizer scratch. A python3 subprocess (override DEEPSEEK_TOKENIZER_PYTHON) loads AutoTokenizer.from_pretrained with trust_remote_code=True and local_files_only=True; HF_HUB_OFFLINE and TRANSFORMERS_OFFLINE prohibit remote downloads. SYSTEM is raw text, TOOLS serialized chat function definitions, and PROSE/sections exact text, encoded with add_special_tokens=False. No chat-template or billed-usage equivalence is claimed. Successful rows include tokenizer-file SHA-256 provenance. Local denominator uses the unknown-model Claude encoding fallback, not a fabricated ai-tokenizer V4 model definition.

2026-09-21: python3 has no transformers module. Both deepseek/deepseek-v4-flash and deepseek/deepseek-v4-pro print a clear skip with an isolated-venv pip command; method `offline_hf_tokenizer`, all ratios unavailable. No global installation was attempted. The tokenizer files are staged only in ignored scratch, not committed. No V4 calibration entries were invented. Existing Fireworks V3.2 and Cerebras Qwen rows are unchanged; V3.2 is a different generation and is not a V4 cross-check reference. The Python protocol test uses an explicitly fake tokenizer module to verify plumbing and flags, not to claim a real HF measurement.

## Unavailable-provider disposition

The task owner independently confirmed the billing classes after the initial probes: Kimi `exceeded_current_quota_error`; Z.ai code `1113` (insufficient balance/account suspension); Meta `billing_not_configured`. These are not transient rate-limit claims. Each affected result row records that class and its owner-confirmed provenance; Gemini 2.5 Pro records 404. The owner authorized delivery of the tested adapters with unavailable rows and no retries, payments, or dependency installations. DeepSeek remains a documented optional-dependency skip. No unavailable provider contributes guessed table values.

## Verification

Final plugin gates: `bun run typecheck` and `bun run lint` passed; `bun test src/hooks/magic-context/tokenizer-calibration.test.ts src/tui` passed 51 tests; all calibration provider tests passed 20 tests. Final `bun run test` passed 5,227 tests with one existing skip, zero failures (476 files). The independently shippable Claude core had also passed the full suite before provider additions (5,211 pass, one skip). Replay identity passed in the dedicated LKG replay tests and both full suites, including the served-wire digest and four pure defer passes. The Python helper passes syntax checking and a fake-module subprocess contract test; actual HF measurements remain explicitly skipped. AFT diagnostics were incomplete due unavailable language-server producers; the repository's tsc and Biome gates are the authoritative checks.

Non-vacuity controls: removing the Anthropic paid-PROSE guard failed only `never sends prose to the paid usage fallback` while the free-count test stayed green. Neutralizing the 5% cross-check predicate failed only `rejects a cross-check drift above five percent in either direction` while the Moonshot request-shape test stayed green. Both mutations were staged safely, observed in a non-empty working diff, restored to an empty working diff, and never committed.
