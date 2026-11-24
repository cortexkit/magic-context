# Say-mode transcript samples

These excerpts show what Magic Context gets back when an `alfonso-say` agent speaks to the person. The visible response is in the `say` call's input, not in the tool result or the final assistant text. The optional `reply_to` refers to a display tag; OpenCode 2 also supplies an example with `level: "info"`.

## Capture

Both samples came from the read-only operator path in `script/broca-transcript.ts` and `script/lib/runner-transcript.ts`. The call is `session.read`, routed with the source session identity and harness. The initial tail reads used `{ "limit": 80, "max_bytes": 2097152 }` with no `from_ordinal`. The excerpts came from subsequent forward reads, with the literal parameters below. The operator script ordinarily prints a projection; these fixtures retain the native replies before projection.

| Fixture | Runner / harness | `session.read` parameters | Inclusive ordinals retained |
| --- | --- | --- | --- |
| `broca-head.json` | Broca (`broca`) / `broca` | `{ "from_ordinal": 309258, "limit": 80, "max_bytes": 4194304 }` | 309261–309306 |
| `opencode2-head.json` | Agent Runner (`thalamus-harness`) / `opencode2` | `{ "from_ordinal": 161940, "limit": 80, "max_bytes": 4194304 }` | 162000–162019 |
| `opencode2-head.json` | Agent Runner (`thalamus-harness`) / `opencode2` | `{ "from_ordinal": 162020, "limit": 80, "max_bytes": 4194304 }` | 162020–162091 |

Each file wraps the native replies as `{ route: { runner, harness }, pages: [{ params, reply }] }`. Each page is a **slice**, not a complete `session.read` response: only the stated contiguous range of `reply.result.messages` is included. The cursor and head metadata still describe the original page and are not for paging these fixtures. The source session IDs are omitted from the wrapper.

## What to look for

- **Broca, three consecutive turns:** the middle turn includes a person's message at ordinal 309279 and the `say` reply with `reply_to` and `quote` at 309280. That assistant row also calls `bash_watch`. Broca spells the tool `say` in `tool_name` on a `tool_call` part; a later `tool_result` part with the same `tool_call_id` carries `output: { "kind": "text", "text": "sent" }`. The assistant closes that turn with `sent` at 309298. None of the Broca `say` calls in the captured pages set `level`; they use the default `chat` level.
- **OpenCode 2, four consecutive turns:** the first turn contains `say` at `level: "info"` (162015) and closes with `sent` (162016). The last turn includes a person's message at 162028 and the `say` reply with `reply_to` and `quote` at 162029, alongside `knowhow`. OpenCode 2 spells the tool `say` in `name` on a `tool` part, with `state.input` and `state.content: [{ "text": "sent", "type": "text" }]` in the same part. The final assistant text at 162091 was not `sent` in the source and is not `sent` here.

## Stand-ins

- Person messages, injected reminder bodies, assistant reasoning and assistant prose were replaced with neutral text of similar length. Reminder delimiters and literal closing `sent` text were kept. Provider reasoning signatures were replaced with same-length placeholders rather than carrying opaque source data into the fixtures.
- Every `say` `text` and `quote` was rewritten. Markdown structure, including inline code and the numbered list with bold lead-ins, was kept. No `say` text in the selected turns contained a display tag marker; no markers were added. The original `reply_to` values remain, and each substitute quote is an exact substring of the corresponding substitute person message.
- Ordinary tool input and output string payloads, including commands, paths, target names, identifiers in tool arguments, and result prose, were replaced with stand-ins of the same length. Structural fields and scalar types were kept, including tool enums and numeric and Boolean arguments. The original role and part types, runner tool names, call keys and call IDs, and native result containers were kept. The `say` success payloads were kept verbatim.

Verify the two JSON files with `shasum -a 256 -c SHA256SUMS` from this directory.
