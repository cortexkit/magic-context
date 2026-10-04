import { describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
    accumulate,
    type CaptureSettings,
    captureDue,
    captureSettingsFromEnv,
    handleStop,
    readCaptureState,
    readTranscriptDelta,
    setCaptureScope,
} from "./capture";
import {
    assistantRecord,
    toJsonl,
    toolResultRecord,
    toolUseBlock,
    userRecord,
} from "./test-fixtures";

const SETTINGS: CaptureSettings = { enabled: true, afterActivity: 4, everyActivity: 20 };
const EMPTY = { offset: 0, activity: 0, edits: 0, verified: false };

const prompt = (text: string) => JSON.stringify(userRecord(text));
const call = (id: string, name: string) =>
    JSON.stringify(assistantRecord(`msg_${id}`, [toolUseBlock(id, name, {})]));
const result = (id: string, isError = false) =>
    JSON.stringify(toolResultRecord(id, "out", isError));

describe("capture window", () => {
    test("an edit followed by a successful command is verified work", () => {
        const state = accumulate(EMPTY, [
            prompt("fix the save button"),
            call("t1", "Edit"),
            result("t1"),
            call("t2", "Bash"),
            result("t2"),
        ]);
        expect(state).toMatchObject({ activity: 3, edits: 1, verified: true });
    });

    test("a failing command, or an edit after the check, is not verified", () => {
        expect(
            accumulate(EMPTY, [call("t1", "Edit"), call("t2", "Bash"), result("t2", true)])
                .verified,
        ).toBe(false);
        expect(
            accumulate(EMPTY, [
                call("t1", "Edit"),
                call("t2", "Bash"),
                result("t2"),
                call("t3", "Write"),
            ]).verified,
        ).toBe(false);
    });

    test("capturing on its own starts a new window", () => {
        const state = accumulate(EMPTY, [
            call("t1", "Edit"),
            call("t2", "Bash"),
            result("t2"),
            call("t3", "mcp__plugin_magic-context_magic-context__ctx_skill"),
        ]);
        expect(state).toMatchObject({ activity: 0, edits: 0, verified: false });
    });

    test("subagent and meta records do not count", () => {
        const side = JSON.stringify(
            assistantRecord("msg_s", [toolUseBlock("s1", "Edit", {})], { isSidechain: true }),
        );
        const meta = JSON.stringify(userRecord("caveat", { isMeta: true }));
        expect(accumulate(EMPTY, [side, meta])).toMatchObject({ activity: 0, edits: 0 });
    });

    test("asks after enough verified work, or after a long stretch of activity", () => {
        expect(captureDue({ ...EMPTY, activity: 4, edits: 1, verified: true }, SETTINGS)).toBe(
            "verified-work",
        );
        expect(
            captureDue({ ...EMPTY, activity: 3, edits: 1, verified: true }, SETTINGS),
        ).toBeNull();
        expect(captureDue({ ...EMPTY, activity: 25, edits: 1 }, SETTINGS)).toBe("activity");
        expect(
            captureDue({ ...EMPTY, activity: 25 }, { ...SETTINGS, everyActivity: 0 }),
        ).toBeNull();
        expect(captureDue({ ...EMPTY, activity: 25, disabled: true }, SETTINGS)).toBeNull();
        expect(captureDue({ ...EMPTY, activity: 25, memoryDisabled: true }, SETTINGS)).toBeNull();
        expect(captureDue({ ...EMPTY, activity: 25 }, { ...SETTINGS, enabled: false })).toBeNull();
    });

    test("settings come from the environment", () => {
        expect(captureSettingsFromEnv({})).toEqual({
            enabled: true,
            afterActivity: 10,
            everyActivity: 60,
        });
        expect(
            captureSettingsFromEnv({
                MAGIC_CONTEXT_AUTO_CAPTURE: "off",
                MAGIC_CONTEXT_CAPTURE_AFTER: "3",
                MAGIC_CONTEXT_CAPTURE_EVERY: "0",
            }),
        ).toEqual({ enabled: false, afterActivity: 3, everyActivity: 0 });
        expect(captureSettingsFromEnv({ MAGIC_CONTEXT_CAPTURE_AFTER: "-2" }).afterActivity).toBe(
            10,
        );
    });
});

describe("transcript delta", () => {
    test("reads only complete lines added since the last offset", () => {
        const { dir } = createTestTempDir("mc-claude-code-capture-delta-");
        const path = join(dir, "t.jsonl");
        writeFileSync(path, "a\nb\npartial");
        const first = readTranscriptDelta(path, 0);
        expect(first.lines).toEqual(["a", "b"]);
        appendFileSync(path, " line\nc\n");
        expect(readTranscriptDelta(path, first.offset).lines).toEqual(["partial line", "c"]);
        expect(readTranscriptDelta(join(dir, "missing.jsonl"), 7)).toEqual({
            lines: [],
            offset: 7,
        });
    });
});

describe("handleStop", () => {
    function transcript(records: object[]) {
        const { dir } = createTestTempDir("mc-claude-code-capture-stop-");
        const path = join(dir, "session.jsonl");
        writeFileSync(path, toJsonl(records as never[]));
        return path;
    }
    const verifiedWork = [
        userRecord("make the save button persist the note"),
        assistantRecord("m1", [toolUseBlock("e1", "Edit", { file_path: "src/a.ts" })]),
        toolResultRecord("e1", "ok"),
        assistantRecord("m2", [toolUseBlock("b1", "Bash", { command: "npm test" })]),
        toolResultRecord("b1", "1 passed"),
        assistantRecord("m3", [toolUseBlock("b2", "Bash", { command: "curl ..." })]),
        toolResultRecord("b2", "201"),
    ];

    test("asks the session's model once, then lets the capture turn stop", () => {
        const path = transcript(verifiedWork);
        const payload = { session_id: "capture-1", transcript_path: path, stop_hook_active: false };
        const instruction = handleStop(payload, SETTINGS);
        expect(instruction).toContain("ctx_skill");
        expect(instruction).toContain("ctx_memory");

        appendFileSync(
            path,
            toJsonl([assistantRecord("m4", [toolUseBlock("k1", "mcp__x__ctx_skill", {})])]),
        );
        expect(handleStop({ ...payload, stop_hook_active: true }, SETTINGS)).toBeNull();
        // The same work is not asked about twice.
        expect(handleStop(payload, SETTINGS)).toBeNull();
    });

    test("without memory it asks only for operation skills", () => {
        const path = transcript(verifiedWork);
        setCaptureScope("capture-4", { disabled: false, memoryDisabled: true });
        const instruction = handleStop(
            { session_id: "capture-4", transcript_path: path },
            SETTINGS,
        );
        expect(instruction).toContain("ctx_skill");
        expect(instruction).not.toContain("ctx_memory");
    });

    test("stays quiet for small talk and when Magic Context is off", () => {
        const chat = transcript([userRecord("hi"), assistantRecord("m1", [])]);
        expect(handleStop({ session_id: "capture-2", transcript_path: chat }, SETTINGS)).toBeNull();

        const work = transcript(verifiedWork);
        setCaptureScope("capture-3", { disabled: true, memoryDisabled: false });
        expect(handleStop({ session_id: "capture-3", transcript_path: work }, SETTINGS)).toBeNull();
        expect(readCaptureState("capture-3").disabled).toBe(true);
        expect(handleStop({ session_id: "../x", transcript_path: work }, SETTINGS)).toBeNull();
    });
});
