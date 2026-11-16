# Compaction after an undo behind a view's cut, version 1

Provider-facing bodies the runner sends once a view stops fitting the session's
history, recorded for Magic Context to drive through its own provider module (ck-mc)
before the runner stops reading whole sessions. From this version on, the runner never reads a session from
its start once a cut exists. A view that no longer fits is dropped and refused by
name. Reads then page through the runner's index from just before the newest message
the change kept.

The unit tests in `crates/thalamus-harness-module/src/runner/compaction/gone_tests.rs`
produce each body with real runner operations over a stand-in OpenCode 2 host. They
check each body byte for byte, after pretty-printing it with a final newline.
`THALAMUS_WRITE_COMPACTION_UNDO_V1=1` writes the files instead. The stand-in host
counts every read that lists the session from its start. Each test asserts that none
happened, apart from the one render the case allows. `SHA256SUMS` covers the three
JSON bodies and this README, but not itself.

## The session

A synthetic OpenCode 2 session of 12 turns, indexed by the runner, set up with the
scripted provider. Its provider hands over a view (version 2): a summary at the
start and a cut through `msg_00000017`. A step applies it, so the session has a
window after that cut. For cases (a) and (b) the host has also written its
compaction marker at the cut. Nothing in the bodies is normalized.

| File | Case | What it is |
| --- | --- | --- |
| `a-undo-notice.json` | (a) An undo behind the cut | The `compaction.notice` params after a person undid the turns from `msg_00000016` on, which removed the cut's own message. |
| `b-stale-window-notice.json` | (b) A step finds its window stale | The `compaction.notice` params after a step-boundary refusal. |
| `c-apply-view-edit-before-cut.json` | (c) An edit at or before the view's own cut | The `session.apply_view` answer for that view. |

### (a) The notice after an undo behind the cut

The runner finds the cut gone with one read of the window after it, which the host
no longer has. It doesn't read the session. Instead it:

- drops the applied view and its window;
- tells the provider `view_refused`, with `unknown_message` naming the cut;
- reports `transcript_changed` from the ordinal of the newest message the undo kept
  (`from_ordinal: 16`, at or before the cut's 17). The notice carries that message
  as its only entry and as `newest`.

A session past its host marker, or moved here from another host, ends its steps
`compaction_unavailable`
until a view applies. A session that never had either renders unreduced. The same
notice carries both events, so a provider rebuilds and offers a new view on it.

### (b) A stale window, with no `transcript_changed`

The applied view and its window went earlier, and reads start at that window's old
cut. A pending view (version 3) cuts through `msg_00000018` and drops part `99` of
`msg_00000019`, which doesn't exist. At the step boundary the runner refuses it, and
the step finds its window stale. The session is past its marker and has no view, so
the step ends `compaction_unavailable` without a read. The next notice carries
`view_refused` with `unknown_part` and no `transcript_changed`: the history didn't
change.

### (c) An edit at or before the view's own cut

A view (version 3) with a summary at the start, a cut through `msg_00000019`, and a
drop of `msg_00000017`, which lies before the cut. The runner refuses it without
reading history before its window:

```json
{"answer": "refused", "refusal": {"code": "edit_before_cut", "index": 2, "mid": "msg_00000017"}}
```

`edit_before_cut` is the code `cortexkit-role-compaction` 0.4.7 gives this case, in the
refusal table of its CONTRACT.md (W6.5). `index` is
the zero-based position in `edits` of the first such edit, and `mid` the entry it
names. The rule refuses a drop or replace of an entry at or before the cut's
`through`, and an insert at `Before(mid)` with `mid` at or before `through`. It never
refuses an insert at `Start`, the summary every cut view carries, or an insert before
the first entry after `through`; the tests check that both are accepted. The cut
hides every entry it names, and checking such an edit would mean reading history
before the window.

The runner pins compaction 0.4.5, whose `ViewRefusal` has no such code, so the body
is built as that 0.4.7 table row gives it. A 0.4.5 decoder keeps it as an unrecognised
code. Magic Context never builds this shape.
