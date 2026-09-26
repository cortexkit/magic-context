# Anthropic open-tool-round thinking probe

Date: 2026-09-26. Live OAuth probe; short and incomplete. Requests used the §2 method in `anthropic-thinking-binding.md`: `ClaustrumScopedRuntime.authorize('main')`, anthropic-auth Claude Code headers/metadata/billing/signing, non-streaming `POST https://api.anthropic.com/v1/messages?beta=true`. Bearer was never printed or stored. Each request used a trivial `get_number` tool and ended with its `tool_result`. Input tokens are reported where the API supplied them; rejected responses had no usage. Request IDs are included to distinguish runs.

## Results

| Model | Variant | HTTP | request-id | input tokens | Error / transformation / limitation |
|---|---|---:|---|---:|---|
| Fable 5.1 | A unchanged, thinking intact | 200 | `req_011CfSmz5WHuYknxPekepfyR` | 541 | `input_transformations: []`; accepted. Initial assistant included thinking + tool_use. |
| Fable 5.1 | B thinking removed from open assistant | 200 | `req_011CfSmzATwXrC5kAV1MqpBJ` | 489 | Accepted; no error, no transformations. |
| Fable 5.1 | C m0 edit, thinking kept, `error` + beta | 400 | `req_011CfSmzNSmmFMAwKmepvQMr` | — | `messages.1.content.0: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation. Remove the block, or set \`thinking.block_binding.prefix_mismatch_behavior\` to "drop_block". Content before this block differs from when it was created, first at \`messages.0.content.0\`.` |
| Fable 5.1 | D m0 edit + thinking removed, field unset | 200 | `req_011CfSmzEMMbBwyuiutR2Avg` | 488 | Accepted; no error. |
| Fable 5.1 | E m0 edit, `drop_block` + beta | 200 | `req_011CfSmzPqrxLJHbfBB7yumS` | 488 | `input_transformations: [{"type":"thinking_dropped","path":"messages.1.content.0","reason":"prefix_binding_mismatch"}]` |
| Fable 5.1 | F older thinking removed, newer open round intact | 200 | `req_011CfSnV6C2UewqMU7E5v5cP` | 749 | Accepted; `input_transformations: []`. **Not probative for keeping newest thinking**: the second assistant had no thinking block. |
| Fable 5.1 | F2 m0 edit, older thinking removed, field unset + beta | 200 | `req_011CfSnVAsZfHXZ7AEBQstwM` | 748 | `input_transformations: []`; **not probative** because the newer assistant also had no thinking. |
| Opus 5.5 | A unchanged, thinking intact | 200 | `req_011CfSnGyapSuYJq8aWJZZVx` | 623 | `input_transformations: []`; valid control. Initial assistant had thinking + tool_use. |
| Opus 5.5 | B thinking removed from open assistant | 200 | `req_011CfSnHBkosh2UFKvjj54ze` | 530 | Accepted; no error, no transformations. |
| Opus 5.5 | C m0 edit, `error` + beta (no thinking) | 200 | `req_011CfSn1Zv7q6juFp3VJxHNb` | 455 | Earlier attempt had no thinking in the initial assistant; not probative. |
| Opus 5.5 | D m0 edit + thinking removed, field unset | 200 | `req_011CfSnHNRFh25gTz1ccVCiZ` | 529 | Accepted; no error. |
| Opus 5.5 | E m0 edit, `drop_block` + beta | 200 | `req_011CfSnHa4zAe1TeA6sNUVvh` | 529 | `input_transformations: [{"type":"thinking_dropped","path":"messages.1.content.0","reason":"prefix_binding_mismatch"}]` |
| Opus 5.5 | F older thinking removed, newer open round thinking kept; prefix unchanged | 200 | `req_011CfSnTdPwQ9LmsnaKk9E8f` | 808 | Accepted; `input_transformations: []`. Newest block was retained and thinking-bearing. |
| Opus 5.5 | F2 m0 edit, older thinking removed, field unset + beta | 200 | `req_011CfSnTjTKnv6XdxVq1fXkf` | 788 | Accepted after transform: `[ {"type":"thinking_dropped","path":"messages.4.content.0","reason":"prefix_binding_mismatch"} ]`; the newest thinking was not retained by the API. |

For the Opus A/B/D/E run, turn 1 was `req_011CfSnGhG4EfpYXMwDEd2kj` (200, 447 input tokens; thinking + text + tool_use; 93 thinking tokens). It reasoned that 401 was prime among 391, 401 and 437, and called `get_number(n=401)`. The tool result supplied was 401 in that run; the follow-up variants test replay behavior, not tool correctness.

For the two-round probes, the tool was `get_number(n)` returning `n+1`; the first tool result was 402 and the second call used 161741 (402² + 137), whose result was 161742. Opus F used turn 1 `req_011CfSnTBMGuRQpQRkxkR8bi` (453 input tokens, thinking + tool_use) and second open round `req_011CfSnTSZKbF21Vurccg8k2` (805 input tokens, thinking + tool_use). F2 changed m0, sent the beta with `block_binding` unset, and the service dropped the newest thinking block as shown above.

Fable's two-round runs created both tool calls, but the second open-round assistant contained no thinking. F and F2 both returned 200, but neither establishes behavior when the newest open round carries thinking. The initial Fable two-round request was `req_011CfSnUJVg4kU7Tu5KENNiQ` (453 input tokens, thinking + tool_use); second tool call `req_011CfSnUwZcNnFsrrNGXtVwq` (774 input tokens, text + tool_use). Opus also had earlier no-thinking attempts; the successful reasoning-bearing Opus turn above is the later retry.

## Conclusion

For both Fable 5.1 and Opus 5.5, B and D were accepted in a thinking-bearing open tool round: a client may remove the final assistant's thinking, with or without the m0 edit in these samples. Opus F was also accepted with the older thinking removed and the newest open round's thinking intact, supporting that pattern for the tested sequence—but a single observation does not prove it is always valid. In F2, the m0 edit plus unset field and beta header was accepted, but the API dropped the newest thinking (`prefix_binding_mismatch`); it did not preserve that block. Fable's F/F2 attempts did not have thinking in the newer open round, so they are not evidence for that case.
