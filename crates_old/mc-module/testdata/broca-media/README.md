# Synthetic shipping-build media reader samples

Captured by `crates/broca-module-serve/tests/media_runtime.rs`, using the real `serve_connection`, registry, actor, file WAL, run loop, media publication, prepared family renderers and read serializers over an in-memory duplex connection. This is not a live provider run or a native daemon acceptance run. The scripted tool invokes the production `ToolMediaCapture` sink; the off-mode tool uses the production negotiated `content/v1` mapping. Subc dispatch-envelope coverage is checked separately by the existing shipping-byte tests and the maintainer's native lanes.

All content is synthetic, from the checked-in media-live fixtures. No live sessions, credentials or production stores were read. Files are raw reply/frame body bytes, one body per JSONL line; no reply content has been normalized. The directory is intentionally uncommitted. Per the parent decision, copy this directory to `~/Work/Projects/CortexKit-scratch/broca-media-samples-1030/` for distribution.

## Family labels

The primary `on-*` and `off-*` files (except the family matrices) use **Anthropic Messages** (`WireFamilyId::AnthropicMessages`, Anthropic media profile). In `on-session-read.jsonl`, the person image and tool-result image/PDF references were prepared for that family. The corresponding `session.history` display rows and `session.subscribe` live/replay frames refer to the same captures. The sample session first admits a text-only turn, then a person image plus a tool turn. Off mode refuses the person-image send before the WAL changes, then executes the same synthetic tool reply without capture; that is why the off sample has no person image. `off-media-read-success.jsonl` is intentionally a refusal: the operation is not declared or served when off.

`on-family-matrix.jsonl` and `off-family-matrix.jsonl` label every row with the rendering family and person MIME, and list the tool image/PDF kinds. Each row preserves the exact send reply and the actual synthetic provider request bodies. They cover Anthropic Messages, Bedrock Converse, OpenAI Chat, OpenAI Responses, ChatGPT Responses, Gemini and Code Assist. The Code Assist project id is synthetic. These rows exercise the existing family profiles, not newly promoted carrier gates.

As the parent requested, existing refusals are preserved: Code Assist person media is refused; OpenAI Chat tool follow-up media remains a not-shown marker; ChatGPT PDFs and audio are refused. No `LIVE_CHECKED_GATES` or family carrier tables were changed. The family matrices include these exact send replies and marker-bearing rendered bodies.

## Artifact map

- `*-describe.jsonl`: attachments group and operations present only in on mode.
- `*-session-read.jsonl`: `session.read` with `media: "blocks"`.
- `*-session-history.jsonl`: `session.history` with `form: "display"`.
- `*-subscribe-live.jsonl`: attached before the held scripted provider is released.
- `*-subscribe-replay.jsonl`: replay from start after completion.
- `*-media-read-success.jsonl`: full tool-image read (on) or unknown-operation refusal (off).
- `*-media-read-refusal.jsonl`: unknown digest refusal (on) or unknown-operation refusal (off).
- `*-family-matrix.jsonl`: family-labelled send replies and prepared request bodies.

The same on-mode test also checks metadata probes, EOF, short reads, named length/offset refusals, unreferenced committed uploads, cross-session digest isolation, and recovery using a durable media seed after stopping/reopening the serve rig. The native process-kill and media conformance lanes remain the maintainer's merge gates.

`SHA256SUMS` covers the JSONL payload files.
