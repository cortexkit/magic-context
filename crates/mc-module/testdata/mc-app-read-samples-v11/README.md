# mc-app-read-samples-v11

The seven `mc-app-read/v1` app operations and watch StreamData, generated from
ck-mc's app-read handlers. The seven JSON files from v10 are copied unchanged,
byte for byte. Routes, role versions, admission and existing envelopes do not
change. The v5 through v10 sample folders remain frozen.

## Pending runner notes (from v10)

The token breakdown adds the `notes` category and a matching `notes` item.
These are runner-rendered plan and tool notes outside transcript entries, not
the user-role `notices` category. Counts come from compaction 0.3.5's optional
`Conditions.notes_tokens`, enabled by `compaction-notes-tokens/v1`.

The category reports the **measured request's** notes: the pending count from
the previous runner compaction notice, not the newest runner notice's
next-request count. These protocol notices are distinct from user-role
`notices` messages in the transcript. The sample has 11
measured note tokens and 29 pending. `notes` therefore reports 11, with
`estimate: false`. Inexact counts have `estimate: true`; an absent measured
count is unknown (`tokens: null`), not zero. Runners sending separate note
counts exclude them from `system_tokens`. Provider totals are unchanged;
attribution moves known notes out of the residual shown as Other by apps.
When neither the pending nor measured note count is known, the category and
item are omitted, preserving the breakdown from runners without this metadata.

The new category is appended to preserve existing category indices. Its item
follows `tool_definitions`, before the composed head items. Content-derived
versions and cursors change with the breakdown.

## `context.head`: the context exactly as the model reads it

Send `{"method":"context.head","params":{"session":{"runner":"…","harness":"…","session":"…"}}}`
on the internal app-read service. Like `context.states`, this is a one-shot
read, admitted only for app callers. An unknown session is refused with
`session_not_found`. The response is wrapped in `result`.

`result.messages` describes the two user messages Magic Context inserts ahead
of the conversation: `baseline` is the frozen snapshot, and `delta` is what
changed since. Section text includes its own XML-like wrappers and is verbatim
from the view the runner applies, including escaping and whitespace. Quoted
tag notation (for example, `§42§`) has already been reduced to a bare number
(`42`). Magic Context's
guidance is in the runner's system prompt, not in either of these messages.

Sections are in rendering order. Ignore unknown `kind` values. The desktop's
rows map to sections as follows:

| Row | Baseline sections | Delta sections |
| --- | --- | --- |
| Project docs | `project_docs` | none |
| User profile | `user_profile` | `user_profile` |
| Compartments | `history` | `history` |
| Memories | `memory`, `memory_mural` | `memory_updates` |

`other` is a lossless fallback for text whose section wrapper is newer than
this reader, reordered, or incomplete. It carries the unparsed remainder of
the message as one final section, without `items`. Show its text even when no
desktop row recognizes it. The same reconstruction rules below still apply;
an unfamiliar section must not hide the rest of the head.

`items` on `project_docs` gives each file's `name`, `text` (file wrapper
included), and `tokens`. `history` items give `compartment_id`, `tier`, and
`tokens`, using the same ids and tiers as the token breakdown: tier 1 is full
detail and tier 4 the shortest. Summaries left out of the rendered head have
no item. `memory` items give `id`, `category`, `text` (the rendered `#id: fact`
line, including continuation lines), and `tokens`. `memory_updates` items give
each rendered correction line's `form` (`full`, `marker`, or `overflow`) and
`text`. A section without item-level attribution omits `items`: absence means
unknown, not an empty section. For example, a runner restored to an older
baseline snapshot can still supply exact text even when that snapshot's
summary/correction metadata is no
longer available. Docs and memory items can be read from their text directly.

A shared-workspace memory item also has `source`, the project label from its
rendered `#id [source]: fact` line; an absent `source` means the project's own
memory. Own-project continuation lines are indented and remain in the item's
text. If any shared memory has an unindented continuation line, or two parsed
items have the same id, the entire memory section omits `items`: its boundaries
cannot be attributed safely. Its section text remains unchanged.

The `memory_mural` section has `image: {media_type, sha256, data, tokens}`.
`data` is base64; `sha256` hashes the decoded image bytes. `image.tokens` is
`null` when the module has no image counter for the serving model. The
section's own `tokens` counts only its caption. Message and section text counts
use the session model's counter, in the same units as the context breakdown.
Message `tokens` counts its whole text, including wrappers or the empty
placeholder. Section/item counts need not add up to the message count because
separators and outer wrappers are not items and tokenization crosses boundaries.

To reconstruct either complete message byte for byte:

- Baseline: join section texts with `"\n\n"` (one blank line).
- Nonempty delta (`empty: false`): `wrapper.open + "\n" +` section texts joined
  with `"\n"` `+ "\n" + wrapper.close`. Each wrapper member is one line with no
  newline. The outer wrapper is not part of any section.
- Empty delta (`empty: true`): use `placeholder` as the entire text. `sections`
  is empty and `wrapper` is absent. A nonempty delta omits `placeholder`.

`as_of.view` is the numeric view version, or `null` before any view exists.
`as_of.applied` says whether the runner confirmed that view. A pending view
(`false`) describes the next request rather than the previous one. `step_ref`
and `at_ms`, when known, come from the same size reading as the breakdown;
they are not the time the window opened. They are omitted when unknown.

A worker or reader has `managed: true` and `messages: []`: it has no head.
A suspended or tools-only session has `managed: false` and `messages: []`.
After a module restart, an idle session may not have set up with the module
yet. Opening the window then asks the runner for its applied view, with a
three-second deadline. This read creates no session worker and does not cache
the answer. A Magic Context view is served with `applied: true`; no applied
view produces `view: null` and `messages: []`. Stored metadata is used only
when its baseline matches the returned text. The size-reading fields can be
absent for sessions with no saved breakdown.

An unavailable runner route, a timeout, or another provider's applied view is
refused with `head_not_ready`, message "The session has not set up with its
runner since the module started." This is retryable by reopening the window
or after Setup; stored baselines alone cannot prove what the runner applies.

The new samples cover every section and the mural (`head.json`); all three
delta blocks; an empty delta; an unconfirmed view; worker and suspended
sessions; no mural; unavailable per-item attribution (`head-no-items.json`);
the retryable refusal (`head-not-ready.json`); and a future baseline block
preserved as `other` (`head-other.json`). The image is a tiny PNG.
`head-shared.json` includes an own-project memory and a single-line shared
memory whose item names its source project.

Regenerate deliberately from the workspace root:

```sh
MC_REGENERATE_APP_READ_SAMPLES=1 cargo test --locked -p mc-module --lib app_read::head::tests::samples_v11 -- --exact
```

On a read-only checkout, set `MC_REGENERATE_APP_READ_SAMPLES` to an output
directory instead of `1`, then copy the generated JSON and checksums into this
folder. Run without the variable to verify the checked-in bytes and decode
each sample. The test also requires every copied v10 sample to stay unchanged.
