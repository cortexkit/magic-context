import { expect, test } from "bun:test";
import {
    CHECKPOINT_NOTE,
    CHECKPOINT_NOTES,
    hasFoldSummary,
    isCheckpointNote,
    isHistoryHead,
    RAW_HISTORY_ACCOUNT,
    withRecordedHead,
} from "./summary";

test("the checkpoint note is the fixed text the user sees, with no per-session values", () => {
    expect(CHECKPOINT_NOTE).toBe(
        "Magic Context added a compaction marker here to keep this OpenCode session fast. Your history is unchanged: Magic Context still keeps it and sends it to the model.",
    );
});

test("every note text ever stored stays recognised, and the current one is written", () => {
    // Host rows keep the note they were written with. A rewording appends to the
    // list, so the first shipped text must stay its first entry.
    expect(CHECKPOINT_NOTES[0]).toBe(
        "Magic Context added a compaction marker here to keep this OpenCode session fast. Your history is unchanged: Magic Context still keeps it and sends it to the model.",
    );
    expect(CHECKPOINT_NOTES.at(-1)).toBe(CHECKPOINT_NOTE);
    for (const note of CHECKPOINT_NOTES) {
        expect(isCheckpointNote(note)).toBe(true);
        expect(isHistoryHead(note)).toBe(false);
        expect(JSON.stringify(withRecordedHead(checkpoint(note), note, "recorded head"))).toBe(
            JSON.stringify(checkpoint("recorded head")),
        );
    }
    expect(isCheckpointNote(`${CHECKPOINT_NOTE} `)).toBe(false);
    expect(isCheckpointNote(RAW_HISTORY_ACCOUNT)).toBe(false);
});

test("neither the stored note nor the raw-history account counts as a history head", () => {
    // Both are usable host summaries, but neither is history Magic Context can
    // fold with or answer a later checkpoint with.
    expect(hasFoldSummary(CHECKPOINT_NOTE)).toBe(true);
    expect(isHistoryHead(CHECKPOINT_NOTE)).toBe(false);
    expect(isHistoryHead(RAW_HISTORY_ACCOUNT)).toBe(false);
    expect(isHistoryHead("<session-history> \n</session-history>")).toBe(false);
    expect(isHistoryHead(null)).toBe(false);
    expect(isHistoryHead("<session-history>Earlier work.</session-history>")).toBe(true);
});

const checkpoint = (stored: string) => ({
    id: "cut",
    role: "user",
    content: [
        {
            type: "text",
            text: `<conversation-checkpoint>\n<summary>\n${stored}\n</summary>\n<recent-context>host</recent-context>\n</conversation-checkpoint>`,
        },
        { type: "media", text: undefined },
    ],
});

test("a checkpoint storing the note gets its recorded head back, byte for byte", () => {
    // `$&` and `$1` must stay literal: the head is history text, not a pattern.
    const head = "<session-history>cost $& and $1 stay literal</session-history>";
    const noted = checkpoint(CHECKPOINT_NOTE);
    const restored = withRecordedHead(noted, CHECKPOINT_NOTE, head);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(checkpoint(head)));
    // The host's own message is never edited in place.
    expect(JSON.stringify(noted)).toBe(JSON.stringify(checkpoint(CHECKPOINT_NOTE)));
});

test("other checkpoints and checkpoints without a recorded head stay as stored", () => {
    const old = checkpoint("<session-history>stored head</session-history>");
    expect(withRecordedHead(old, "<session-history>stored head</session-history>", "other")).toBe(
        old,
    );
    const noted = checkpoint(CHECKPOINT_NOTE);
    expect(withRecordedHead(noted, CHECKPOINT_NOTE, undefined)).toBe(noted);
});
