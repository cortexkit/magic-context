# mc-app-read-samples-v12

Generated examples for the internal `mc-app-read/v1` service. Admission, role
versions and the `{"result": ...}` envelope have not changed. `context.head`
now returns an **outline**, not bulk text or image data; there is no v11 shape
compatibility mode. The seven unrelated v11 JSON examples are copied byte for
byte. The v11 folder, including its README and checksums, is frozen and tested.

## Opening the context window

1. Read `context.head` with `params: {session: {runner, harness, session}}`.
   Draw counts and sizes from the outline. Retain `as_of.view` for the window.
2. Opening a row reads each of that row's sections with `context.head_section`,
   following `next_offset` until absent. Concatenate the returned `text` values,
   then slice item ranges from that section's complete UTF-8 bytes.
3. The memories row also reads the mural's `part: "image"` chunks. Decode each
   chunk separately, concatenate decoded bytes, and verify their SHA-256 against
   the outline's `image.sha256` (and their size against `image.bytes`).
4. On `head_changed`, discard the window's partial reads, read the outline
   again, and start over. Never join chunks from different view versions.

## `context.head`: outline fields

- `as_of: {view, applied, step_ref?, at_ms?}`: `view` is a numeric version, or
  `null` before any view exists. `applied` means the runner confirmed that view;
  `false` describes the next request, not the previous one. Optional size-reading
  fields are from the same reading as the token breakdown, not window-open time.
- `managed`: whether Magic Context manages context for the session.
- `messages`: the two synthetic user-message slots, in order. A managed worker
  or reader has no head (`[]`). Suspended/tools-only sessions have `managed:
  false` and `messages: []`. A runner with no applied view also has no messages.
- Message: `{slot, tokens, bytes, sections, empty?, placeholder?, wrapper?}`.
  `slot` is `baseline` or `delta`. `bytes` counts the complete message's UTF-8
  text, including separators, wrappers, or the empty delta's short placeholder.
  Only delta carries `empty`. Empty delta has `empty: true`, `sections: []`,
  inline `placeholder`, and no `wrapper`. Nonempty delta has `empty: false`,
  `wrapper: {open, close}`, and no `placeholder`. Each wrapper member is one line.
- Section: `{index, kind, tokens, bytes, items?, image?, items_omitted?}`.
  `index` is zero-based within its message. `bytes` counts its exact UTF-8 text.
  **There is no section `text` field in the outline.**

Sections retain their rendering order. App rows map to them as follows:

| Row | Baseline | Delta |
| --- | --- | --- |
| Project docs | `project_docs` | none |
| User profile | `user_profile` | `user_profile` |
| Compartments | `history` | `history` |
| Memories | `memory`, `memory_mural` | `memory_updates` |

Ignore unknown kinds when choosing a row, but do not hide their content. `other`
is the final, unparsed remainder when a wrapper is unknown, reordered, or
incomplete. It has no `items` and uses the same section-read/rebuild rules.

### Items and image metadata

Items never copy text into the outline:

| Kind | Item fields |
| --- | --- |
| `project_docs` | `{name, tokens, start, len}` |
| `memory` | `{id, category, source?, tokens, start, len}` |
| `memory_updates` | `{form, start, len}`; form is `full`, `marker`, or `overflow` |
| `history` | `{compartment_id, tier, tokens}`; no range |

`start` and `len` count **UTF-8 bytes within the section text**, not characters
or offsets within the message. Both `start` and `start + len` are guaranteed to
be UTF-8 character boundaries and within the section. The byte slice
`text[start..start+len]` is exactly the item text v11 returned: docs include the
file wrapper; memories include the rendered `#id: fact` line and continuation
lines; updates include each rendered correction line. If any range cannot meet
the guarantee, the entire section omits `items`, without changing its text or
counts. `head-utf8.json` includes non-Latin doc content at its content edges and
a memory whose content starts and ends with emoji.

History attribution comes from the renderer, never from parsing summary text.
Tier 1 is full detail; tier 4 is shortest. An absent `items` means **unknown**,
not zero. Baseline history with summaries but no matching attribution omits the
list. For stored baselines with no attributed items:

| Stored baseline | History attribution |
| --- | --- |
| `through_sequence == -1` (renderer had no summaries) | Known empty: `items: []`. |
| Default `through_sequence == 0`, text is the renderer's empty history block | Known empty: `items: []`. |
| Default `through_sequence == 0`, text holds summaries | Unknown: omit `items`; serve the text and counts unchanged. |

Zero alone does not prove emptiness. Positive sequence values retain matching
attribution when available and otherwise omit the list.
Delta history exists only with newer summaries and omits `items` when none can
be attributed. Docs, memories, and corrections also omit empty/unknown lists
rather than reporting zero against content. Shared memories have `source`, the
unescaped rendered project label. Duplicate ids or unindented shared-memory
continuations make memory boundaries ambiguous, so the section omits `items`.

If an exceptionally large outline would exceed 512 KiB, the server removes
`items` from the largest sections until it fits. Each affected section carries
`items_omitted: "too_large"`; text, counts and section reads are unchanged.
Do not interpret this omission as an empty list.

A mural has `image: {media_type, sha256, bytes, tokens: null}`. `bytes` is the
decoded image size; `sha256` hashes decoded bytes. **There is no `data` in the
outline.** Image token cost is unknown. The section's own tokens count its
caption only. All text token counts use the session model's counter. Item and
section token counts need not sum to the message count: separators and outer
wrappers are not items, and tokenization crosses boundaries.

## `context.head_section`: one chunk

Request params:

```json
{"session":{"runner":"…","harness":"…","session":"…"},"view":7,"slot":"baseline","section":0,"part":"text","offset":0,"max_bytes":1024}
```

`view`, `slot`, and `section` are required and come from the outline. `part`
defaults to `text`; `offset` defaults to 0. `max_bytes` defaults to 262144 and
must be an integer from 1024 through 262144 (out-of-range requests are refused).

Text reply: `{view, slot, section, part: "text", offset, text, next_offset?}`.
Offsets count UTF-8 bytes in that section. A chunk holds at most `max_bytes`
text bytes and always ends on a UTF-8 character boundary, so it may be a few
bytes short. JSON escaping may require a shorter chunk to fit the frame too.
An offset past the end or inside a multi-byte character is `invalid_params`;
an offset exactly at the end returns empty text without `next_offset`.

Image reply: `{view, slot, section, part: "image", offset, data, next_offset?}`.
Only a section with image metadata accepts this part. Offsets and limits count
base64 characters. Offsets must be multiples of 4; chunk lengths are multiples
of 4 except possibly the final chunk, so every chunk decodes alone. The `data`
values concatenate to the complete base64 string. `next_offset`, when present,
is always the offset for the next request, not an extra amount to add.

## Rebuilding the original messages byte for byte

Fetch **every** section in outline order, including `other`. Text includes its
own XML-like wrappers, escaping, whitespace and neutralized tag notation
(`§42§` has already become `42`). Magic Context guidance is in the runner's
system prompt, not these messages.

- Baseline: join section texts with `"\n\n"` (one blank line).
- Nonempty delta: `wrapper.open + "\n" + section_texts.join("\n") + "\n" +
  wrapper.close`. The outer wrapper is not part of any section.
- Empty delta: use inline `placeholder` as the entire message.

The round-trip test uses exactly these rules for every v11 head case, reads
sections in 1024-byte chunks, compares each item byte slice to v11's text, and
verifies image bytes and hashes. The UTF-8 fixture additionally checks real
non-ASCII item content against exact expected strings.

## Idle sessions and refusals

After a restart, an idle session may not have set up yet. The module asks its
runner for the applied view, off the app-read thread, with a three-second limit.
It keeps that head in memory for 60 seconds after last use, for at most four
sessions (least recently used is evicted). It never creates a worker or writes
stores for this read. Once the session sets up with the module, its live
in-memory head wins immediately and drops the kept head; forgetting the head
drops it too. A section version absent from the
kept/live head asks the runner again. Another version (or no view) then means
`head_changed`. Stored summary and correction attribution is trusted only when
the stored baseline text matches the baseline inserted by the runner's view.

Errors are protocol refusals, not `result` values. This table includes service
refusals as well as the two new codes; admission and move gates apply equally
to outline and section reads.

| Code | Meaning / app action |
| --- | --- |
| `head_changed` | New: the requested view is no longer current, or there is no head view. Read the outline again and restart the window. |
| `reply_too_large` | New: encoded reply exceeded 512 KiB. The message names the method. Applies to every app read, not just heads. |
| `head_not_ready` | Runner route unavailable, timed out, or applies another provider's view. Message: "The session has not set up with its runner since the module started." Retry by reopening or after Setup. |
| `invalid_params` | Invalid/missing/unknown field (named in the message), invalid offset/boundary, invalid part/slot/section, limit outside the allowed range, malformed envelope, or request over 64 KiB. |
| `session_not_found` | No matching session. |
| `compartment_not_found` | No compartment matches the requested id. |
| `session_ambiguous` | More than one conversation matches. |
| `session_runner_mismatch` | The session belongs to another runner; detail names it. |
| `session_moving` | The move/rekey gate holds this session. Retry after the move. |
| `store_unavailable` | The projection, stored session, or head cannot be read safely. |
| `app_op_unavailable` | The read is not served. This no longer means an oversized reply. |
| `not_permitted` | App admission is not granted. |
| `unknown_method` | Method is not exposed on the management surface (heads use the internal app-read service). |
| `cursor_invalid` | Invalid search/watch cursor. |
| `watch_limit_exceeded` | Watch quota exhausted. |

## Samples and regeneration

`head*.json` retains every v11 outline case. `head-section-text.json` is one
chunk; `head-section-text-1.json` / `-2.json` stop just before a multi-byte
character at the requested boundary. `head-section-image-1.json` / `-2.json`
read one SVG mural in two independently decodable chunks. Their companion
outlines are `head-text-chunks.json` and `head-image-chunks.json`, respectively;
the latter supplies the SVG's size and SHA-256 for checking the image reads.
`head-changed.json`
shows a stale view. `head-invalid-1` through `-11` cover slot, section, part,
missing image, split-character offset, past-end offset, small/large limits,
null view, negative offset and null section, respectively. `reply-too-large`
shows the service-wide size refusal. The image example uses a larger mural
than the tiny PNG in the ordinary head fixture so it needs two chunks at the
minimum chunk size.

Regenerate deliberately from the workspace root:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib app_read::head::tests::samples_v12 -- --exact
```

Set the variable to an output directory instead of `1` for a read-only checkout.
Without it, the test verifies generated bytes, checksums and copied v11
examples. A separate checksum test pins every file in the frozen v11 folder.
