/**
 * Builders for Claude Code transcript records, shaped like the JSONL Claude Code
 * 2.1 writes (see transcript.ts). Test-only.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeProjectDirectory } from "./transcript";

type Record = { [key: string]: unknown };

let sequence = 0;
function nextUuid(): string {
    sequence++;
    return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

function timestamp(offsetSeconds: number): string {
    return new Date(Date.UTC(2026, 9, 1, 12, 0, offsetSeconds)).toISOString();
}

export function userRecord(content: unknown, extra: Record = {}): Record {
    return {
        type: "user",
        uuid: nextUuid(),
        isSidechain: false,
        timestamp: timestamp(sequence),
        message: { role: "user", content },
        ...extra,
    };
}

export function assistantRecord(messageId: string, content: unknown[], extra: Record = {}): Record {
    return {
        type: "assistant",
        uuid: nextUuid(),
        isSidechain: false,
        timestamp: timestamp(sequence),
        message: { id: messageId, role: "assistant", content },
        ...extra,
    };
}

export function textBlock(text: string): Record {
    return { type: "text", text };
}

export function toolUseBlock(id: string, name: string, input: Record): Record {
    return { type: "tool_use", id, name, input };
}

export function toolResultRecord(toolUseId: string, output: string, isError = false): Record {
    return userRecord([
        { type: "tool_result", tool_use_id: toolUseId, content: output, is_error: isError },
    ]);
}

export function compactBoundaryRecord(preservedHeadUuid?: string): Record {
    return {
        type: "system",
        subtype: "compact_boundary",
        uuid: nextUuid(),
        content: "Conversation compacted",
        compactMetadata: {
            trigger: "manual",
            ...(preservedHeadUuid ? { preservedSegment: { headUuid: preservedHeadUuid } } : {}),
        },
    };
}

export function compactSummaryRecord(text: string): Record {
    return userRecord(text, { isCompactSummary: true });
}

export function toJsonl(records: Record[]): string {
    return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/** Write a transcript where Claude Code would keep it and return its path. */
export function writeTranscript(
    configDir: string,
    projectDirectory: string,
    sessionId: string,
    records: Record[],
): string {
    const directory = join(configDir, "projects", encodeProjectDirectory(projectDirectory));
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${sessionId}.jsonl`);
    writeFileSync(path, toJsonl(records));
    return path;
}
