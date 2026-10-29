import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";
import {
    readSessionChunk,
    withRawMessageProvider,
} from "../../src/hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../src/hooks/magic-context/read-session-raw";
import type { ReplayCase } from "../two-pass-live-replay/artifact-schema";
import { assertOrdinalCoverage, projectOrdinalCoverage } from "./ordinal-coverage";

export interface RawExport {
    case: number;
    messages: Array<{
        ordinal: number;
        messageId: string;
        sessionId: string;
        timeCreated: number;
        message: { role: string };
        parts: Array<{ id: string; timeCreated: number; data: unknown }>;
    }>;
}

/** Re-render from raw messages, never by splitting the lossy recorded block strings. */
export function withRawInput(c: ReplayCase, raw: RawExport): ReplayCase {
    if (
        raw.case !== c.id ||
        raw.messages.length !== c.lines.length ||
        raw.messages.some(
            (message, i) =>
                message.ordinal !== c.lines[i].ordinal ||
                message.messageId !== c.lines[i].messageId,
        )
    )
        throw new Error("raw_message_binding");
    const messages: RawMessage[] = raw.messages.map((message) => ({
        id: message.messageId,
        ordinal: message.ordinal,
        role: message.message.role,
        createdAt: message.timeCreated,
        parts: message.parts.map((part) => part.data),
    }));
    const start = messages[0]?.ordinal;
    const end = messages.at(-1)?.ordinal;
    if (start === undefined || end === undefined) throw new Error("raw_messages_empty");
    const chunk = withRawMessageProvider(
        `trial-input-${c.id}`,
        {
            readMessages: () => messages,
            getMessageCount: () => end,
        },
        () =>
            readSessionChunk(`trial-input-${c.id}`, Number.MAX_SAFE_INTEGER, start, end + 1, {
                singleMessageLines: true,
            }),
    );
    const newMessages = `<new_messages>\n\nMessages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunk.text}\n\n</new_messages>`;
    assertOrdinalCoverage(
        projectOrdinalCoverage(
            c.id,
            c.lines.map((line) => line.ordinal),
            newMessages,
        ),
    );
    return {
        ...c,
        userPrompt: c.userPrompt.replace(
            /<new_messages>[\s\S]*?<\/new_messages>/,
            () => newMessages,
        ),
        blocks: chunk.printedBlocks ?? [],
        lines: chunk.lines,
    };
}

export function readRawInput(root: string, c: ReplayCase): ReplayCase {
    const rawDir = resolve(root, "raw-messages");
    const text = readFileSync(resolve(rawDir, `${c.id}.json`), "utf8");
    const hashes = readFileSync(resolve(rawDir, "SHA256SUMS"), "utf8");
    const expected = hashes
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .find((parts) => parts[1] === `${c.id}.json`)?.[0];
    if (!expected || lifecycleTextHash(text) !== expected) throw new Error("raw_message_hash");
    return withRawInput(c, JSON.parse(text) as RawExport);
}
