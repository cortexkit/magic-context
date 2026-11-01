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
- `on-session-read-default.jsonl`: `session.read` with `{}` (no `media` parameter).
- `on-session-read-descriptors.jsonl` and `off-session-read-descriptors.jsonl`: the exact `session.read {"media":"descriptors"}` shape used by Magic Context, captured in both boot modes.
- `on-session-history-default.jsonl`: `session.history` with `{}` (default raw form).
- `on-run-status.jsonl` and `on-run-result.jsonl`: existing `run.status` / `run.result` operations keyed to the completed media-bearing run.
- `*-subscribe-live.jsonl`: attached before the held scripted provider is released.
- `*-subscribe-replay.jsonl`: replay from start after completion.
- `*-media-read-success.jsonl`: full tool-image read (on) or unknown-operation refusal (off).
- `*-media-read-refusal.jsonl`: unknown digest refusal (on) or unknown-operation refusal (off).
- `*-family-matrix.jsonl`: family-labelled send replies and prepared request bodies.

The same on-mode test also checks metadata probes, EOF, short reads, named length/offset refusals, unreferenced committed uploads, cross-session digest isolation, and recovery using a durable media seed after stopping/reopening the serve rig. The native process-kill and media conformance lanes remain the maintainer's merge gates.

## What ordinary readers see

The four new on-mode default samples come from the same completed Anthropic-profile run as the on-mode blocks/display samples. `run.status` and `run.result` are existing wire operations, not filesystem paths or compatibility shims.

| Surface | Person image | Tool image and PDF |
|---|---|---|
| `session.read {}` | A `type: "text"` content block containing `[media not shown: kind=image mime=image/png bytes=3592 sha256=2d317c5c185e reason=not_requested]`, after the prompt's text block. No `media`/`media_ref` part or bytes. | The `type: "tool_result"` block retains the existing `output: {kind: "text", text: ...}` shape. `before-media`, the image placeholder, the PDF placeholder, and `after-media` are joined with single newlines. Both placeholders have `reason=not_requested`; no media part or bytes is exposed. |
| `session.history {}` (raw/default form) | The same text placeholder and `type: "text"` part as default `session.read`. | The same `tool_result` / `kind: "text"` output and newline-joined placeholders. It is not a display file part; display refs are in the separate display-form sample. |
| `run.status` for the completed run | Omitted: this reply contains completion state, finish reason, undelivered-steer status, usage and retry count, not the run's input/history. No placeholder or media part. | Omitted for the same reason. |
| `run.result` for the completed run | Omitted: the reply contains the final assistant message's text (`seen`), ordinal and mid, plus run/state/usage metadata. No input/history placeholder or media part. | Omitted; prior tool outputs are not part of the final assistant text. |

The default-read placeholders use the stored decoded-byte size and the first 12 hex digits of SHA-256, not an upload id. Captured payload bytes remain available only through `session.media_read` after session-scoped capture authorization.

## Magic Context descriptors, on and off

These captures use `session.read {"media":"descriptors"}`, not blocks mode. They are beside the default-read samples and are intended for MC's compatibility verdict.

- **On (`on-session-read-descriptors.jsonl`):** the person image is a top-level `type: "media_ref"` block with `kind: "image"`, MIME, decoded `byte_size`, full SHA-256, width/height and `part: "m2#1"`. The tool result retains `output.kind: "parts"`; its image and PDF remain `kind: "media"` parts, each with a nested `media` object whose `type` is `"media_ref"` and whose metadata includes the full object SHA-256. The nested refs have no separate `part` field; their enclosing tool-result block is `m4#0`. These refs contain neither media bytes nor default-read `not_requested` placeholders. Each message also has `digest` and `part_digests` identifying its stored original content, not the descriptor rendering.
- **Off (`off-session-read-descriptors.jsonl`):** the person-image send was refused, so its image is absent and the user message contains only the prompt text. No `media_ref` appears anywhere. The tool result retains the legacy `output.kind: "parts"` with only `kind: "text"` parts: `before-media`, the exact image "not shown to the model" notice, the legacy unsupported-resource JSON text for the PDF, and `after-media`. That unsupported-resource text includes the synthetic PDF's existing inline base64 blob; it is ordinary stored text, not a media object/ref or a newly introduced descriptor payload. Message/part content digests remain present. The off-mode `session.media_read` operation remains undeclared and refused.

The on/off descriptor captures were regenerated with the corresponding blocks, display, subscribe and media-read samples so their run IDs/mids are internally consistent within each mode.

`SHA256SUMS` covers all 22 JSONL payload files.
