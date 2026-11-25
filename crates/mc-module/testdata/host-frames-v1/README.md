# Agent Runner host frame lists

These entries were captured from Thalamus commit `bfdc7f42d18def6a8c77e7466762ea204bc676f3` on Linux, with real Claude Code binaries and a loopback stand-in model. Both cases came from the same test build with `test-support`, so the host frame list switch was on. Shipping builds leave the switch off.

- `two-frames-2.1.332/`: `MID_TURN_FIRST` and `MID_TURN_SECOND` arrived while one tool call was in flight. Claude Code stored both in the user message after the tool result. The read and display facts name stored parts 1 and 2; the compaction facts name the string part IDs `"1"` and `"2"`. The first tail includes the host's inter-part newline (233 bytes); the second does not (232 bytes).
- `one-frame-2.1.331/`: `please also check the logs` arrived during one tool call. Claude Code stored the wrapped text in a standalone system message. The read and display facts name stored part 0; the compaction fact names `"0"`.

Each case contains a `session.read` entry requested with `include_display_facts: true`, a `session.history` display entry (including the row and its stable `part_keys`), and the full `session.entries` entry returned to a stand-in Magic Context provider declaring `compaction-host-frame/v2`. The JSON objects are pretty-printed with no fields removed. The messages, tools and senders are synthetic and the captures were checked for personal data before publication.

To capture again, stage 2.1.331 and 2.1.332 with `probes/claude-code-linux/fetch.sh`. Set `THALAMUS_CC_HOST_FRAMES_SAMPLES` to an empty directory, leave `THALAMUS_STEER_SAMPLES` unset, and run the ignored `real_claude_code_records_steer_frame_samples` test with the 2.1.331 binary in `THALAMUS_CLAUDE_CODE_BIN`. Use the same build with the 2.1.332 binary for `real_claude_code_records_merged_mid_turn_reader_bodies`.
