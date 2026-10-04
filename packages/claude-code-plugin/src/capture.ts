/**
 * Capture on the session's own model.
 *
 * In OpenCode and Pi, Magic Context's historian and dreamer run on a model
 * configured for them. Under Claude Code nothing extra is configured: the model
 * already running the session does the capturing. When a turn ends after verified
 * work (files edited, then a command that succeeded), or after a long stretch of
 * activity, the Stop hook asks that model, once, to save verified flows as
 * operation skills and durable facts as memories before it stops.
 *
 * The hook reads only what the transcript gained since its last run and keeps a
 * small per-session record in Magic Context's temp directory. It never blocks a
 * stop that a Stop hook already extended (`stop_hook_active`), so it cannot loop.
 */

import {
    closeSync,
    fstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getMagicContextTempDir } from "@magic-context/core/shared/data-path";
import { isValidSessionId } from "./session";

export interface CaptureSettings {
    enabled: boolean;
    /** Activity (tool calls + prompts) of verified work before a capture is asked for. */
    afterActivity: number;
    /** Activity between captures asked for without verified work; 0 = never. */
    everyActivity: number;
}

export interface CaptureState {
    /** Bytes of the transcript already read. */
    offset: number;
    activity: number;
    edits: number;
    /** A command succeeded after the last edit. */
    verified: boolean;
    /** Set by the SessionStart hook when Magic Context is off for the project. */
    disabled?: boolean;
    /** Set by the SessionStart hook when memory.enabled is false. */
    memoryDisabled?: boolean;
}

interface TranscriptRecord {
    type?: string;
    isSidechain?: boolean;
    isMeta?: boolean;
    isCompactSummary?: boolean;
    message?: { content?: unknown };
}

type Block = Record<string, unknown>;

function blocksOf(content: unknown): Block[] {
    return Array.isArray(content)
        ? content.filter((block): block is Block => block !== null && typeof block === "object")
        : [];
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CAPTURE_TOOL = /__ctx_(skill|memory)$/;

function positiveInteger(value: string | undefined, fallback: number): number {
    if (value === undefined || value.trim() === "") return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function captureSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): CaptureSettings {
    const mode = env.MAGIC_CONTEXT_AUTO_CAPTURE?.trim().toLowerCase();
    return {
        enabled: !["off", "0", "false", "no"].includes(mode ?? ""),
        afterActivity: Math.max(1, positiveInteger(env.MAGIC_CONTEXT_CAPTURE_AFTER, 10)),
        everyActivity: positiveInteger(env.MAGIC_CONTEXT_CAPTURE_EVERY, 60),
    };
}

function stateDirectory(): string {
    return join(getMagicContextTempDir("claude-code"), "capture");
}

function statePath(sessionId: string): string {
    return join(stateDirectory(), `${sessionId}.json`);
}

const EMPTY_STATE: CaptureState = { offset: 0, activity: 0, edits: 0, verified: false };

export function readCaptureState(sessionId: string): CaptureState {
    try {
        const parsed = JSON.parse(readFileSync(statePath(sessionId), "utf8"));
        return { ...EMPTY_STATE, ...parsed };
    } catch {
        return { ...EMPTY_STATE };
    }
}

export function writeCaptureState(sessionId: string, state: CaptureState): void {
    mkdirSync(stateDirectory(), { recursive: true, mode: 0o700 });
    const path = statePath(sessionId);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, path);
}

/** Remember what is on for a session's project (from the SessionStart hook). */
export function setCaptureScope(
    sessionId: string,
    scope: { disabled: boolean; memoryDisabled: boolean },
): void {
    if (!isValidSessionId(sessionId)) return;
    const state = readCaptureState(sessionId);
    if (
        (state.disabled ?? false) === scope.disabled &&
        (state.memoryDisabled ?? false) === scope.memoryDisabled
    ) {
        return;
    }
    writeCaptureState(sessionId, { ...state, ...scope });
}

/** Complete JSONL lines added since `offset`, and the offset after the last of them. */
export function readTranscriptDelta(
    path: string,
    offset: number,
): { lines: string[]; offset: number } {
    let descriptor: number;
    try {
        descriptor = openSync(path, "r");
    } catch {
        return { lines: [], offset };
    }
    try {
        const size = fstatSync(descriptor).size;
        // A transcript that shrank was rewritten; start over.
        const start = size < offset ? 0 : offset;
        if (size === start) return { lines: [], offset: start };
        const buffer = Buffer.alloc(size - start);
        readSync(descriptor, buffer, 0, buffer.length, start);
        const lastNewline = buffer.lastIndexOf(0x0a);
        if (lastNewline < 0) return { lines: [], offset: start };
        const text = buffer.subarray(0, lastNewline).toString("utf8");
        return {
            lines: text.split("\n").filter((line) => line.trim().length > 0),
            offset: start + lastNewline + 1,
        };
    } finally {
        closeSync(descriptor);
    }
}

/** Fold new transcript records into the session's capture window. */
export function accumulate(state: CaptureState, lines: readonly string[]): CaptureState {
    const next = { ...state };
    const bashCalls = new Set<string>();
    for (const line of lines) {
        let record: TranscriptRecord;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        if (!record || typeof record !== "object") continue;
        if (record.isSidechain === true || record.isMeta === true) continue;
        const content = record.message?.content;
        if (record.type === "assistant") {
            for (const block of blocksOf(content)) {
                if (block.type !== "tool_use") continue;
                next.activity++;
                const name = String(block.name ?? "");
                if (CAPTURE_TOOL.test(name)) {
                    // The model is already capturing; start a new window after this.
                    next.activity = 0;
                    next.edits = 0;
                    next.verified = false;
                } else if (EDIT_TOOLS.has(name)) {
                    next.edits++;
                    next.verified = false;
                } else if (name === "Bash" && typeof block.id === "string") {
                    bashCalls.add(block.id);
                }
            }
        } else if (record.type === "user") {
            if (typeof content === "string" && record.isCompactSummary !== true) {
                next.activity++;
            } else {
                for (const block of blocksOf(content)) {
                    if (block.type === "text" && record.isCompactSummary !== true) next.activity++;
                    if (
                        block.type === "tool_result" &&
                        typeof block.tool_use_id === "string" &&
                        bashCalls.has(block.tool_use_id) &&
                        block.is_error !== true &&
                        next.edits > 0
                    ) {
                        next.verified = true;
                    }
                }
            }
        }
    }
    return next;
}

export type CaptureReason = "verified-work" | "activity";

export function captureDue(state: CaptureState, settings: CaptureSettings): CaptureReason | null {
    if (!settings.enabled || state.disabled) return null;
    if (state.edits > 0 && state.verified && state.activity >= settings.afterActivity) {
        return "verified-work";
    }
    // Without memory, a long stretch with no verified work leaves nothing to save.
    if (
        !state.memoryDisabled &&
        settings.everyActivity > 0 &&
        state.activity >= settings.everyActivity
    ) {
        return "activity";
    }
    return null;
}

export function captureInstruction(reason: CaptureReason, memoryEnabled = true): string {
    const lines = [
        "Magic Context capture — do this yourself, briefly, then stop:",
        ...(reason === "verified-work"
            ? [
                  "- You changed code and verified it. If that completed a flow behind a user action (button, form, event, route → API → data written → state updated), save it with ctx_skill (action save): one operation per button/event with the trigger, action, APIs, data writes, state updates, save/linkage, files to modify, the steps to perform it, and how you verified it. Check ctx_skill list first and update an existing skill instead of duplicating it.",
              ]
            : []),
        ...(memoryEnabled
            ? [
                  "- Save durable project facts learned since the last capture (decisions, constraints, conventions, config values) with ctx_memory, one fact each, without duplicating what <project-memory> already says.",
              ]
            : []),
        'If nothing qualifies, reply "Nothing to capture." Do not repeat the work or summarize the session.',
    ];
    return lines.join("\n");
}

export interface StopPayload {
    session_id?: unknown;
    transcript_path?: unknown;
    stop_hook_active?: unknown;
}

/**
 * Handle one Stop event: returns the instruction to block the stop with, or null
 * to let Claude Code stop.
 */
export function handleStop(
    payload: StopPayload,
    settings: CaptureSettings = captureSettingsFromEnv(),
): string | null {
    const sessionId = payload.session_id;
    const transcriptPath = payload.transcript_path;
    if (!isValidSessionId(sessionId) || typeof transcriptPath !== "string") return null;

    const previous = readCaptureState(sessionId);
    const delta = readTranscriptDelta(transcriptPath, previous.offset);
    let state = accumulate({ ...previous, offset: delta.offset }, delta.lines);

    // The capture turn itself (or any turn a Stop hook extended) never asks again.
    const due = payload.stop_hook_active === true ? null : captureDue(state, settings);
    if (due) state = { ...state, activity: 0, edits: 0, verified: false };
    writeCaptureState(sessionId, state);
    return due ? captureInstruction(due, !state.memoryDisabled) : null;
}
