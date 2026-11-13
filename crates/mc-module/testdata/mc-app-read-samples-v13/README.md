# mc-app-read-samples-v13

Generated examples for the internal `mc-app-read/v1` service. Admission, role
versions and the `{"result": ...}` envelope have not changed. v13 adds the owner
reads the apps show in place of the 0.49 dashboard's memory, dreamer, session
and note pages, and three watch notice kinds. Every v12 example is copied byte
for byte; its reads are described under "Carried from v12" below, unchanged.

## Shared rules for the owner reads

- **Envelope.** Every reply carries `schema: 1`, `op` (the method) and
  `as_of_ms`. The samples fix `as_of_ms` at `1700000000000`.
- **Owners.** Memory reads name `{level, owner?}`. `level` is `project` (owner:
  the project's id, `pj-…`), `workspace` (owner: the workspace id) or
  `global` (owner: `self`, which may be left out). A project counts as known
  once a session of it has been set up with Magic Context; any other project
  id answers `project_unknown`. The project reads (`facts.page`,
  `dreamer.*`, `sessions.page`, `notes.page`) take `project` and answer the
  same refusal.
- **Paging.** A page read takes an optional `limit` from 1 to its maximum,
  which is also the default: `memories.page` 200, `observations.page` 200,
  `facts.page` 200, `dreamer.runs` 50, `sessions.page` 50, `notes.page` 100.
  A reply has `next` when there is more: pass it back as `cursor` with the
  same filters. A cursor continues after the last row the previous page
  returned, in the read's order, so rows added between pages never shift the
  rows after them. A cursor from another read, from the same read with other
  filters, or one that doesn't decode answers `bad_cursor`.
- **Size.** A page also stops early, with `next`, before its reply would pass
  the 512 KiB frame budget. A single row too large for the frame answers
  `reply_too_large`.
- **Fields.** Times are Unix milliseconds; counts are integers. A field Magic
  Context doesn't know is absent, never `null` or `0`.

## `memories.stats {level, owner?}`

Counts over the whole owner: `by_category {<category id>: {active, permanent,
archived}}`, `total` (every row of the owner), `level`, `owner`, and for
`global` only, `pending_observations` (observations no review has taken yet).

Samples: `memories-stats` (a project), `memories-stats-global`,
`memories-stats-empty` (a known project with no memories),
`memories-stats-unknown` (`project_unknown`).

## `memories.page {level, owner?, status?, category?, text?, cursor?, limit?}`

- `status`: `live` (default: active and permanent), `all`, `active`,
  `permanent` or `archived`. `category` is a category id (`swe:naming`).
- `text`: every word must appear. Project and workspace memories are searched
  through the full-text index, word by word (query syntax is searched as
  words). Global memories are not in that index: their search is a plain,
  ASCII-case-insensitive substring match.
- Order: category id, then importance (highest first; none last), then newest
  update, then id (highest first).
- Reply: `memories`, `level`, `owner`, `next?`. Each row: `id`, `content` (in
  full), `category`, `level`, `owner`, `status`, `importance?`, `shareable`,
  `safety_critical?` (absent when never assessed), `sensitive`, `source {type?,
  session?, project?}` (`project` only for a memory that is not a project's
  own: where it came from), `seen_count`, `retrieval_count`, `first_seen_at`,
  `last_seen_at`, `created_at`, `updated_at`, `expires_at?`, `embedded?`,
  `revision`, `cue?` (the mural's short form).
- `embedded` is present for a project's memories when the module knows the
  project's folder in this process and its settings embed memories: true when
  the memory has a vector for that model. Global and workspace memories don't
  carry it.
- `sensitive` memories are returned with the flag; the apps hide their text.
  `retrieval_count` and `embedded` may lag until the next memory notice.

Samples: `memories-page` (`limit: 3`, with `next`), `memories-page-2` (its
second page), `memories-page-empty`, `memories-page-global`,
`memories-page-search`, `memories-page-bad-cursor` (the first page's cursor
with another `status`).

## `memories.get {id}`

`{memory}`: one row as in `memories.page`, plus `merged_from` (ids, `[]` when
none), `superseded_by?` and `history`, newest first. A history entry has `at`,
`reason`, `revision?` (the revision the change produced), `before?` and
`after?` (the memory's text on either side), and `writer?`:

| `writer` | Made by | Extra fields |
| --- | --- | --- |
| `summary` | the summarizer's second turn | |
| `agent` | the agent, through its memory tool (`ctx_memory`) | |
| `dreamer` | a dreamer task run | `run_id` (link to `dreamer.run`), `task` (profile task id) |
| `person` | the person (the 0.49 dashboard's edit or restore) | |

History the 0.49 dreamer wrote names its 0.49 task (`curate`, `verify`,
`expire`) in `task` and has no `run_id`. An entry whose writer the store doesn't
record has no `writer`. Unknown ids answer `memory_not_found`.

Samples: `memories-get-agent`, `memories-get-summary`, `memories-get-dreamer`,
`memories-get-person` (one history entry from each writer),
`memories-get-merged` (`merged_from`), `memories-get-no-history`,
`memories-get-not-found`.

## `observations.page {cursor?, limit?}`

The person's (global) pending observations, newest first: `observations`, each
`{id, content, proposed_category?, session, project?, created_at}`.

Samples: `observations-page`, `observations-page-2`,
`observations-page-invalid-limit` (`invalid_params`).

## `facts.page {project, cursor?, limit?}`

The project's candidate facts waiting for the summarizer's second turn, in
queue order: `facts`, each `{id, content, category, state, attempts, reason?}`.
`state` is `retryable`, `in_flight` or `decided_pending`; facts that were
applied or found already covered have left the queue and are not listed.

Samples: `facts-page`, `facts-page-2`, `facts-page-empty`, `facts-page-unknown`.

## `dreamer.status {project}`

- `project`, `config_source` (`user`: the dreamer's settings come only from the
  person's file), `enabled` (false when the person switched the dreamer off),
  `health` (`failing` when a task has failed three runs in a row, else
  `waiting` while an account limit holds a task, else `ok`).
- `lock? {task, since, run_id?}`: the writer holding the project's memories. A
  lapsed lock is not shown. `run_id` is the run still open for that task.
- `tasks[]`, by task id: `task` (the profile's id), `kind?`, `enabled`,
  `schedule?`, `next_due_at?`, `overdue`, `last?`, `failures_in_a_row`,
  `waiting_until?`. There is no `name` or `description`; the apps word a task
  from its id.
- `schedule` is `{every: "hour", minute}`, `{every: "day", at: "HH:MM"}`,
  `{every: "week", days, at}` (days non-empty, Monday first) or `{cron}` when the
  stored expression is not exactly one of those forms. Each carries
  `time_zone`, the IANA name of the machine's zone, which the schedule runs in.
  A switched-off task has no `schedule` and no `next_due_at`.
- `last {status, at?, failure_class?, error?}`: `status` is the schedule's last
  outcome (`applied`, `nothing_to_do`, `budget_stopped`, `failed`, `waiting`,
  `skipped`). Every `failed` has `failure_class`: the run's (`model`, `input`,
  `apply`), `lock_lost`, or `store` when the store refused the run before it was
  recorded. `error` is Magic Context's raw text.

Samples: `dreamer-status` (a lock, a day schedule, a cron-only schedule, a
failed last run), `dreamer-status-forms` (hour and week schedules),
`dreamer-status-empty`, `dreamer-status-unknown`.

## `dreamer.runs {project, task?, cursor?, limit?}`

Newest first: `runs`, `project`, `next?`. Each run: `id`, `task`, `kind`,
`started_at`, `ended_at?`, `duration_ms?`, `outcome` (`running` while it has no
end), `failure_class?` (every failed, `lock_lost` and `interrupted` run has
one), `error?`, `tokens {input, output}`, `proposed`, `applied`, `changes
{written, merged, archived}` (from its history), `models[]`.

Samples: `dreamer-runs`, `dreamer-runs-2`, `dreamer-runs-empty`,
`dreamer-runs-bad-cursor` (a cursor used with another `task`).

## `dreamer.run {id}`

`{run}`: the run as in `dreamer.runs`, plus `project`, `batches[] {model,
runner?, child_session?, tokens {input, output}}`, `dropped[] {reason,
memory_id?}` (each proposal the task refused, with its reason) and
`changed_memory_ids`. The memory rows come from `memories.get`. Unknown ids
answer `run_not_found`.

Samples: `dreamer-run` (two batches and two dropped proposals),
`dreamer-run-running`, `dreamer-run-not-found`.

## `sessions.page {project, harness?, preset?, cursor?, limit?}`

The project's sessions Magic Context compacts, newest activity first:
`sessions`, each `{session {runner, harness, session}, preset, last_activity_at?}`.
`preset` is `head`, `worker` or `reader`; a session other than `head` is a
subagent. `last_activity_at` is the newest message's time, absent before the
first. A `preset` filter Magic Context doesn't know answers `invalid_params`.

Samples: `sessions-page`, `sessions-page-2`, `sessions-page-empty` (no session
with the preset), `sessions-page-unknown`.

## `notes.page {project, session?, type?, status?, cursor?, limit?}`

The project's notes, most recently updated first: `notes`, each `{id, type,
status, content, created_at, updated_at, session?, condition?, ready_reason?}`.
`type` is `session` or `smart`; `condition` and `ready_reason` belong to smart
notes. `session` names the note's session; notes are kept without the runner,
so `runner` appears only when Magic Context knows one session with that harness
and id. A `session` filter takes `{runner, harness, session}` and matches by
harness and id. `status` is the stored status.

Samples: `notes-page`, `notes-page-2`, `notes-page-empty`,
`notes-page-invalid-type`.

## `context.watch` with owners

`context.watch` takes `projects: [id]`, `workspaces: [id]` (at most 32 each) and
`global: true` beside `sessions`; a watch must name at least one. Its first
notice is `resync` as before; it lists the owners it follows (`projects`,
`workspaces`, `global`) when it has any, and a session-only watch's notice is
unchanged. New notice kinds, each a reload hint (reread this; nothing else
changed):

- `memories {level, owner}`: a memory of that owner was added, changed,
  archived, restored or re-ranked; for `global`, also its pending observations;
  for a project, also its candidate facts.
- `dreamer {project}`: a schedule, the lock or a run of the project changed.
- `notes {project, session?}`: a note of the project changed.

Resuming with a cursor replays each owner change since it once, after the
`changes` notice; when more have happened than the watch's queue holds, the
first notice is `resync` and the app rereads everything it shows.

Samples: `watch-owners` (the first notice), `watch-memories`, `watch-dreamer`,
`watch-notes` (cursors fixed as `abc:0` and `abc:1`).

## Refusals added in v13

| Code | Meaning / app action |
| --- | --- |
| `project_unknown` | No session of the project has been set up with Magic Context. |
| `bad_cursor` | The cursor isn't one this read made with these filters. Start from the first page. |
| `memory_not_found` | No memory has that id. |
| `run_not_found` | No dreamer run has that id. |
| `store_unavailable` | The memory store could not be read. |

## Regeneration

Regenerate deliberately from the workspace root:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib app_read::samples_v13_tests::samples_v13 -- --exact
```

Set the variable to an output directory instead of `1` for a read-only
checkout. Without it, the test verifies generated bytes, checksums and the
copied v12 examples.

## Carried from v12

The v12 README, unchanged except that its headings sit one level lower. Its
samples are copied into this folder byte for byte; its regeneration command
regenerates the v12 folder.

Generated examples for the internal `mc-app-read/v1` service. Admission, role
versions and the `{"result": ...}` envelope have not changed. `context.head`
now returns an **outline**, not bulk text or image data; there is no v11 shape
compatibility mode. The seven unrelated v11 JSON examples are copied byte for
byte. The v11 folder, including its README and checksums, is frozen and tested.

### Opening the context window

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

### `context.head`: outline fields

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

#### Items and image metadata

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

### `context.head_section`: one chunk

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

### Rebuilding the original messages byte for byte

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

### Idle sessions and refusals

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

### Samples and regeneration

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
