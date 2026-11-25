# Claude Code mid-turn host-frame lists

These examples use invented messages and tool output. They model the Claude
Code 2.1.332 carrier: one `user` message holds a tool result and a separate
text block for each message the person sent during the tool call. The first
of two framed parts ends in the 232-byte tail plus one LF; the last ends in
the 232-byte tail alone. The LF belongs to the host tail, not to the person's
words.

| Case | Files | Expected result |
| --- | --- | --- |
| Two sends during one tool call | `two-frames-read.json`, `two-frames-display.json` | Apply both frames in part order, leave the tool result unchanged, and join only the verified words without a separator for the row's `text`. Each framed part is a separate message from the person. |
| One send during one tool call | `one-frame-read.json`, `one-frame-display.json` | Read one list item and split the part exactly as for the legacy single fact. |
| One wrong tail byte | `bad-tail-candidates.json`, `bad-tail-read.json`, `bad-tail-display.json` | The runner starts with the candidates and serves only the first fact; a reader given both candidates likewise applies only the first. The second part still shows its whole text. |
| Refused list | `refused-read.json` | Refuse two items naming the same stored part. |
| Compaction provider declaration | `compaction-entry.json`, `compaction-gates.json` | Serve the list only to providers declaring `compaction-host-frame/v2`. The frame ids follow stored part order, not lexical order. |
