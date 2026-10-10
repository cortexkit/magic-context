# Issue 653: per-pass work on large OpenCode sessions

Issue 653 reports two OpenCode 1 sessions in one process where every message
froze the host for 72-110 s: `lkg.entryProjection` 63-96 s, `compartmentTrigger`
9.4 s, `pp.tailMeasure` / `pp.tailBaseline` about 4.8 s. The reporter's stall
profiler (issue comment 3) found the cause: about 873 MiB of input per pass,
about 99% of it `state.metadata` on `edit`/`write` tool parts (workspace-wide
LSP diagnostics, up to 5.4 MiB and about 850,000 flattened fields per part).
In that 73.9 s window, 72.7% of the time was `lkgContentDigestFromFields`.

This change makes an ordinary pass cost about 15 ms on that shape (from about
55 s on v0.47.0). It also fixes the slow paths that other content shapes hit.

## The reported shape, reproduced

`packages/plugin/scripts/perf-audit/issue-653-fixture.ts --shape lsp-metadata`
builds sessions of 606 messages in which about 175 `edit`/`write` parts carry
4.5-5.4 MiB of nested diagnostics each (about 890,000 fields per 4.8 MB part;
the reporter measured 848,000 for 5.4 MiB), 873 MiB per session.
`issue-653-transform-stages.ts` runs whole transform passes through the
messages handler with throwaway stores (every `.db` that `lsof` showed open was
under `$TMPDIR/magic-context/issue-653/`; no OpenCode host was started). The
two sessions alternate. Pass 0 is each session's cold pass, and every later
pass appends a turn. macOS arm64, Bun 1.4.2.

| per pass (ms) | v0.47.0 | after the first two rounds | now |
|---|---|---|---|
| `lkg.entryProjection`, cold | 45,419-48,759 | 6,922-7,255 | 4.7-8.5 |
| `lkg.entryProjection`, warm | 49,558-55,559 | 6,617-6,958 | 0.6-1.3 |
| `compartmentTrigger`, warm | 7 (1,967-4,087 on pass 1) | 4 (1,790-1,971 on pass 1) | 4-5 (3,010-3,066 on pass 1) |
| `pp.tailMeasure`, warm | 588-1,393 | 624-689 | 2.4-3.7 |
| `postTransformPhase`, warm | 1,285-2,210 | 1,376-1,596 | 5.4-6.9 |
| whole handler, cold | 46,871-50,283 | 8,455-8,854 | 153-310 |
| whole handler, warm | 53,759-57,782 | 8,001-10,375 | 16-17 (3,051-3,097 on pass 1) |
| LKG slot stored | none (over the 24 MB cap) | none | 846-853 KB per session |
| serializing the LKG prefix | 353-458 ms (835-848 M chars) | same | 0.9-1.2 ms (0.92 M chars) |
| peak RSS of the run | 35.0 GB | 25.3 GB | 11.9 GB (19.7 GB with the serialization measurement) |

The one slow pass that remains is the trigger on each session's second pass
(about 3 s at this size, about 2-4 s on v0.47.0). That pass reads the raw
history from OpenCode's database for the first time, so the cost is
SQLite parsing the part JSON once. Later passes use the cached history. It
runs once per session per process, on the main thread.

## What the provider sees

`state.metadata` is not provider-visible.

- **OpenCode 1.18.35.** After the `experimental.chat.messages.transform` hook,
  the transformed array is used only by `MessageV2.toModelMessagesEffect(msgs, model)`
  (`packages/opencode/src/session/prompt.ts`, the hook call at line 1255 and
  the conversion right after it). That function's tool branch
  (`packages/opencode/src/session/message-v2.ts`, `toModelMessagesEffect`,
  `part.type === "tool"`) reads `state.status`, `state.input`, `state.output`,
  `state.error`, `state.attachments` and `state.time.compacted`. Of
  `state.metadata` it reads only `interrupted` and `output`, and only on an
  `error` part (the output of an interrupted call). Part-level `metadata`
  (provider call metadata, reasoning signatures) is read and is kept.
- **OpenCode 2.0.24.** The lowering
  (`packages/core/src/session/runner/to-llm-message.ts`, `toolCall` /
  `toolResult`) reads tool `input`, `content` and `error`, with no tool
  metadata. Magic Context's v2 commit (`src/v2/hooks/payload.ts`) reads
  `state.input`, `status`, `output`, `error` and `content` back from the
  transformed parts.

`provider-visible-parts.ts` reduces a tool state to an explicit allowlist of
those fields: `status`, `input`, `output`, `error`, `attachments`, `content`,
`time` reduced to `{compacted}` (or `{}`, because OpenCode 1 dereferences
`state.time.compacted`), and on an `error` state `metadata.interrupted` and
`metadata.output`. Everything else in a tool state is dropped: the rest of the
metadata, `title`, start/end times, raw streamed input. Every other part and
the message info are kept whole. A state field a future host version starts
sending has to be added to the allowlist.

## Fixes, in the order they landed

1. **Per-message digest reuse and retention.** The LKG entry digests are
   reused from the previous pass for each message, by message id plus an exact
   comparison against the retained tokens that allocates nothing. Identity
   alone is never trusted. `noteEntry` and the entry projection share one
   cache. Retention gives each session a fair share of a 256 MiB ceiling
   (128 MiB at most per session). The old shared 64 MiB budget made two large
   sessions evict each other on every pass (`reused=0`).
2. **Tail measurement.** The tail-hygiene token memo rises from 64 MiB to
   256 MiB, so two large sessions do not evict each other. The drop-sentinel
   check reads only the head of each output.
3. **Superlinear paths found by varying the content shape** (base64, long
   unbroken lines, deep JSON, very wide JSON, tiny parts, unicode, reasoning
   metadata, tool metadata):
   - `ai-tokenizer`'s merge is quadratic in the piece length (40,000 letters
     took 0.75 s, and a 2 MB unbroken line did not finish in 15 minutes). Its
     merge cache also evicts with a `Map` walk that passes every earlier
     deletion: 4 MB of base64 took 17 s, and the base64 fixture's first tail
     measurement took 416 s. `token-count-exact.ts` replays the library's
     encoder with a heap merge for long pieces and a two-generation cache. The
     tokens are identical, checked against the library on randomized text.
   - `buildToolArcs` (protected-tail boundary, every trigger pass) serialized
     every tool input it only needed call ids from. `stableStringify` joined
     at every nesting level, so N levels copied a value N times. A deep-JSON
     fixture paid 3.8-6.3 s per trigger pass on v0.47.0.
4. **Provider-invisible tool state** (this round):
   - LKG digests and the entry cache cover only the provider view
     (`contentSnapshotValue` applies it, so the TypeScript and Rust-mode
     digests of the same message stay equal). The diagnostics are never
     flattened or hashed, and a metadata-only change neither re-digests nor
     invalidates a replay.
   - The digest is sha256 over a binary, length-prefixed encoding: a one-byte
     tag per token; strings as a uint32 length plus UTF-16 code units, so lone
     surrogates stay distinct; numbers as float64. Tokens are packed in 64 KiB
     chunks, which replaces a text per token and three hash updates per token.
     Current digests carry a `2.` format marker. A durable slot written before
     the marker existed holds unmarked digests over the whole message, in the
     old text encoding. Such a slot is verified with that legacy computation,
     which is kept only for reading old slots, so an upgrade does not turn a
     replayable turn into a refusal. (An independent review found that a
     SQLITE_BUSY first pass after the upgrade refused where 0.47.0 replayed.)
     A legacy slot that genuinely mismatches is still refused, and the next
     healthy capture writes the current format.
   - The stored LKG prefix holds the provider view of the served messages.
     These sessions' snapshots shrink from about 840 MB, which was refused, to
     about 850 KB, which is stored. A healthy pass no longer serializes the
     diagnostics.
   - Other per-pass walkers skip the metadata too:
     - tail-hygiene replay snapshots, comparisons and structural signatures;
     - served-message keys (`stableStringify`);
     - true-raw token cache fingerprints;
     - the raw session readers (`readRawSessionTailFromDb`, the full reader and
       the page reader). These reduce large non-error tool metadata inside
       SQLite to the keys Magic Context reads (description, title, user-answer
       keys), so JavaScript never parses it.

### What a replay serves now

A replay serves the stored prefix: the provider view of the messages that were
served, followed by the current pristine tail. Compared with the array the
transform returned, the replayed JSON lacks only the dropped tool-state fields.
The provider messages are the same. `provider-visible-replay.test.ts` runs whole
and reduced messages through OpenCode 1.18.35's `MessageV2.toModelMessages`,
executed from a verbatim copy of its source (`media.ts`, `iife.ts` and the
conversion's lines of `message-v2.ts`, pinned by sha256 and compared with
upstream at the tag when an OpenCode checkout is available), including the AI
SDK `convertToModelMessages` step (`ai` 6.0.168, the version that tag pins). It
also runs them through Magic Context's OpenCode 2 commit. These are copies and
local runs of the host code, not the hosts themselves; no provider transport
serializer runs. The OpenCode 1 cases cover Anthropic, Gemini 3, Bedrock,
Vertex Anthropic and an OpenAI-compatible model (media extracted into a
synthetic user message), the `stripMedia` and `toolOutputMaxChars` options, an
aborted assistant, and tool parts that are completed, compacted, errored,
interrupted, pending and running, plus reasoning with a signature, text with
provider metadata, image file parts, and compaction and subtask parts. The
replay fit check (`estimateFinalWireInputTokens`) reads only fields the
provider view keeps, so it measures the reduced snapshot as the same request.
A test asserts the equal estimate.

## Other content shapes, v0.47.0 and after the third fix

Same drivers, about 56 MB per session, the two sessions alternating, per-pass
warm handler time unless noted.

| shape | v0.47.0 | after fix 3 |
|---|---|---|
| text tool outputs | 875-1,186 | 82-103 |
| base64 in tool output | first pass 880 s (tail 416 s); not finished in 900 s | cold tail about 19.5 s, warm 30-37 |
| one 100 KB-2 MB unbroken line | first pass not finished in 900 s | cold tail about 35 s, warm 29-34 |
| 2,000-deep JSON tool input | 8,623-14,643, growing (trigger 3.8-6.3 s) | 114-118 |
| very wide JSON input | 2,444-3,081 (cold tail 142-182 s) | 337-365 |
| unicode / emoji | 1,242-1,624 | 109-110 |
| large edit arguments | 1,102-1,173 | 84-89 |
| tens of thousands of tiny parts | first pass not finished in 900 s | first pass not finished in 900 s |

The tiny-parts shape is held up by first-pass tagging: 110-165 s for about
36,000 text parts at 2-4 MB, in `tag.loop` / `tag.assignTag`. Later passes take
under 1 s. This change does not address it.

## Tests

- `lkg-entry-cache-differential.test.ts`: the v0.47.0 projector against the
  new cache over eight randomized histories of 60 passes each. It checks
  identical digests, `noteEntry` digests, LKG prefixes and replay outcomes and
  bytes. The edits cover content, value types, keys, removals, reorders,
  appends, tool metadata, titles and times, and interrupted-call output. Each
  history is served either as fresh copies or as the same objects edited in
  place.
- `lkg-entry-cache-work.test.ts`: covers six bounds.
  - An ordinary pass flattens and hashes only the appended messages, at 40 and
    at 400 messages.
  - The projection after `noteEntry` hashes nothing.
  - A tool-metadata-only change hashes nothing and keeps replay valid, while
    an interrupted-output change is hashed and refuses replay.
  - A same-object in-place edit is hashed.
  - Two sessions of about 36 MB each stay resident when they alternate.
  - Three sessions share a ceiling without exceeding it.
- `provider-visible-replay.test.ts` (above), `provider-invisible-walkers.test.ts`
  (no per-pass walker reads tool metadata, and a metadata-only change reads as
  no change), and `read-session-raw-tool-metadata.test.ts` (the raw readers keep
  the used metadata keys and everything else whole).
- `lkg-entry-digest-reuse.test.ts`: the digest encoding gives distinct digests
  to token lists that differ only in type, split, surrogate encoding or the
  sign of zero.
- `token-count-exact.test.ts`, `stable-json-linear.test.ts`,
  `build-tool-arcs-structure.test.ts` and `tail-hygiene-two-session-memo.test.ts`
  cover the fixes in item 3 and the earlier rounds.

Each fix was broken on purpose (the heap tie-break, the reduction, the error
metadata allowlist, the `time` object, the SQL reduction, the stored prefix,
the walkers, the digest encoding, retention, reuse, the memo ceilings), and at
least one named test turned red. One mutation was not caught by a test:
comparing tail-hygiene replay snapshots without the provider view. It costs a
replay miss but reads no metadata, because the key counts already differ.
