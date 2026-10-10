# Issue 653: per-pass LKG projection and tail measurement on large sessions

Issue 653 reports two OpenCode 1 sessions in one process, each with about 56 MB
of message content, where every message froze the host for 72 to 110 s:
`lkg.entryProjection` 63 to 96 s, `compartmentTrigger` 9.4 s, and
`pp.tailMeasure` / `pp.tailBaseline` about 4.8 s each.

## Fixture and drivers

- `packages/plugin/scripts/perf-audit/issue-653-fixture.ts` builds two sessions
  of 606 messages each (53.5 MB and 51.7 MB of message JSON): user/assistant
  pairs, about one assistant in eight carrying a `read` tool output of 100 KB
  to 2 MB, short text elsewhere. Every pass parses the session again from JSON,
  as OpenCode 1 reloads it from its database, so no string or object is shared
  between passes. Each later pass appends one user/assistant turn.
- `issue-653-lkg-projection.ts --src <plugin src>` times `noteEntry` (which the
  messages handler runs first whenever a last-known-good slot exists) and the
  entry projection, alternating the two sessions.
- `issue-653-transform-stages.ts --root <dir> --src <plugin src>` runs whole
  transform passes through `createMessagesTransformHandler` with a temporary
  `context.db` and an OpenCode 1 `opencode.db` holding the same sessions, and
  reads the per-stage timings the transform logs. It points `XDG_*`, `HOME`,
  `OPENCODE_DB` and `MAGIC_CONTEXT_STORAGE_DIR` at `--root` before importing the
  plugin and prints the `.db` files `lsof` reports open at the end; every run
  listed only files under `$TMPDIR/magic-context/issue-653/`. No OpenCode host
  was started.

"Before" is `v0.47.0`, "master" is 2a40c58ef8, both extracted with
`git archive` and run by the same drivers. All runs: macOS arm64, Bun 1.4.2
(the runtime embedded in the local OpenCode build). Pass 0 is the cold pass of
each session; later passes are warm and alternate A, B, A, B.

## Results

Whole transform passes (`issue-653-transform-stages.ts`, ms):

| stage | v0.47.0 cold | v0.47.0 warm | master cold | master warm | fix cold | fix warm |
|---|---|---|---|---|---|---|
| `lkg.entryProjection` | 40–48 | 40–48 | 32–38 | 28–34 | 39–41 | 3.3–5.7 |
| `compartmentTrigger` | 0.7–2.3 | 2.4–3.3 (70–73 on pass 1) | 0.7–1.8 | 1.9–3.1 (75–78 on pass 1) | 1.3–3.1 | 2.5–4.7 (101–109 on pass 1) |
| `pp.tailMeasure` | 800–854 | 782–1084 | 843–904 | 827–1017 | 1202–1312 | 11–21 |
| `pp.tailBaseline` | 801–855 | 783–1085 | 844–906 | 828–1018 | 1203–1313 | 12–22 |
| whole handler | 1776–1981 | 875–1186 | 1840–2152 | 906–1177 | 2765–2896 | 82–103 (190–195 on pass 1) |

The fix's warm handler total was 54–70 ms in an earlier run on a quieter
machine; the run above shared the host with other builds. The three stages
this issue names take 17–31 ms together on every warm pass.

LKG entry digests alone (`issue-653-lkg-projection.ts`, ms per pass):

| | v0.47.0 | master | fix |
|---|---|---|---|
| `noteEntry`, cold | 66–85 | 57–90 | 38–49 |
| `noteEntry`, warm | 55–76 | 20–28 | 3.8–7.6 |
| projection, warm | 46–98 | 24–38 | 0.6–0.7 |
| reused / retained of 606–610 | 0 / 420–493 | 0 / 420–493 | all / all |

A token-dense variant (one 20 MB session whose 38 tool messages each carry
10,000 small structured objects in their metadata, about 5M tokens)
projected in 1.6–1.8 s warm on v0.47.0 and 130–160 ms with the fix (537 of 606 messages fit the per-session cap there; the rest are hashed
each pass).

## What was slow

Profiles (`bun --cpu-prof`, self time):

- **Tail measurement**: on master, 58% in `ai-tokenizer`'s `encodeOrdinary` and
  15% in its pre-tokenizer regex, plus `memoizedContent`'s character loop (4%)
  and `isDropSentinel` (2.5%). The content memo that keeps token counts across
  passes was capped at 64 MiB, counted at two bytes per character. One session
  of this size fits; two sessions served in turn evicted each other's entries,
  so every pass tokenized every tool output again (about 1 s per 50 MB). With
  one session the same stage takes 27–32 ms warm. `isDropSentinel` lowercased
  every whole tool output to look at its first ten characters.
- **LKG entry digests**: on v0.47.0, 45% of the driver's time is sha256
  `update`: the projector's 64 MiB budget was shared by all sessions, so each
  session's store evicted the other (`reused=0` on every pass, as in the
  report) and every message was flattened and hashed again, by both
  `noteEntry` and the projection. Master's `noteEntry` kept per-session
  comparison keys, but each key was a full copy of the message text, rebuilt
  and compared every pass, and the projection still ping-ponged.

Nothing on this fixture is superlinear. The reported 63–96 s projection is about
1,500 times what v0.47.0 takes here on 53 MB, so the report's sessions differ
from the fixture in a way this investigation could not pin down. Two signs in
the log: (1) `retained=228` with only 55 MB of the 64 MiB budget used means
about 378 of 606 messages were either over 9 MB each or produced no tokens
(a cyclic or otherwise unflattenable message), and (2) the measured cost per
token here (about 300 ns cold on v0.47.0, flatten plus hash) would need hundreds of
millions of tokens to reach 90 s. Both point at message shapes (very large
structured tool metadata, or a much bigger session than the 56 MB of retained
bytes suggests) or at host heap pressure, not at a quadratic step in this code.
The fix removes the per-pass flatten, copy and hash of unchanged messages,
which is the work that scales with whatever those shapes are.

`compartmentTrigger` did not reproduce: 2–5 ms on ordinary passes in every
version, and 70–110 ms once, on each session's second pass, when the
protected-tail token index is built for the first time. Its token estimates
reuse a per-message cache keyed by id and part sizes, and the uncached
`estimateUntaggedInMemoryTailUpperBound` only covers messages without tags.
The reported 9.4 s probably needs compartments and an eligible tail this
fixture does not create; it is unchanged here.

## The fix

- **Entry digest cache** (`LkgEntryDigestCache` in `lkg-slot.ts`). Each
  session retains, per message id, the exact typed tokens and the digest. A
  message reuses its digest only when its current content walks to exactly
  those tokens (`contentMatchesFields`); neither the id nor object identity is
  trusted. The walk builds nothing, compares strings natively, and writes the
  current pass's string objects back into the retained tokens, so a second walk
  in the same pass compares by identity and the previous pass's copies can be
  freed. Only new or changed messages are flattened and hashed. `noteEntry`
  and the transform's projection share one cache, and `noteEntry` digests the
  whole input so the projection later in the pass hashes nothing.
- **Retention**: a 256 MiB ceiling for all sessions, at most 128 MiB per session,
  and each session limited to the ceiling divided by the number of sessions
  retained. A session joining trims the others to the new share (keeping their
  leading entries) instead of evicting a whole session, so sessions served in
  turn no longer evict each other, and the total never passes the ceiling. The
  old 64 MiB projector budget, the 128 MiB comparison-key store and the projector's
  use of the 16 MiB digest memo are gone.
- **Tail measurement**: the content memo ceiling is 256 MiB, and
  `isDropSentinel` lowercases only the head it compares.

Remaining whole-content work on an ordinary pass, all at native speed: the
exact comparison in `contentMatchesFields` reads every string the host hands
over again (it cannot be skipped without trusting identity; 3–8 ms for both
`noteEntry` and the projection on this fixture), and the tail measurement looks
each rendered output up in its memo, which hashes the string (11–21 ms). Full
tokenization remains on each session's first pass (cold) and after a cache
bust. The whole-message replay memo in the tail measurement (128 MiB) still
holds only one of two sessions this size; the part-by-part path behind it is
now the 11–21 ms above.

## Tests

- `lkg-entry-cache-differential.test.ts`: the v0.47.0 projector (frozen in the
  test) against the new cache over eight seeded random histories of 60 passes:
  edits to earlier messages (text, same-length text, number to string, key
  added, removed or reordered, undefined values, `-0`), removals, reorders and
  appends, served as fresh copies or as the same objects edited in place. It
  checks identical per-message digests, `noteEntry` digests,
  `buildLkgPrefix` output (including the serialized prefix bytes) and
  `replayLkg` outcomes and bytes, and requires both successful and refused
  replays in every seed.
- `lkg-entry-cache-work.test.ts`: an ordinary pass flattens and hashes exactly
  the two appended messages (and their characters) at 40 and at 400 messages;
  the projection after `noteEntry` hashes nothing; a same-object, same-length
  in-place edit is hashed; two sessions of about 36 MB of estimated bytes each
  reuse every entry when alternating; three sessions share a small ceiling
  without exceeding it.
- `tail-hygiene-two-session-memo.test.ts`: two sessions of 20 MB of tool output
  served in turn tokenize nothing after their first pass; recognising a drop
  sentinel lowercases fewer than 10,000 characters for 20 MB of output.

Each fix was checked by breaking it and running these tests: trusting string
lengths instead of content, never reusing, removing the fair share, restoring
the 64 MiB ceilings (LKG and tail memo), lowercasing whole outputs again, and
noting only the prefix. Each turned at least one named test red.
