/**
 * Generate ctx_expand renderer fixtures from the TypeScript implementation.
 *
 * The committed fixture is consumed by Rust tests so facade behavior is checked
 * against the TypeScript authority rather than duplicated expectations.
 *
 *   bun crates/mc-module/gen/gen-ctx-facade-golden.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { setRawMessageProvider } from "../../../packages/plugin/src/hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../../packages/plugin/src/hooks/magic-context/read-session-raw";
import { encodeOpenCodeMessagesToCk } from "../../../packages/plugin/src/hooks/magic-context/module-wire";
import {
    renderMessageByOrdinal,
    renderVerboseRange,
} from "../../../packages/plugin/src/tools/ctx-expand/render";

const SESSION = "ctx-facade-golden";

const cases = [
    {
        name: "merged-completed-tool-and-structural-noise",
        native_messages: [
            {
                absolute_ordinal: 7,
                info: { id: "m7", role: "assistant" },
                parts: [
                    { type: "step-start" },
                    { type: "reasoning", text: "private scratchpad" },
                    { type: "text", text: "Reading it now." },
                    {
                        type: "tool",
                        tool: "read",
                        callID: "read:7",
                        state: {
                            status: "completed",
                            input: { filePath: "src/config.ts" },
                            output: "line one\nline two\nline three",
                            metadata: { title: "Read the runtime configuration" },
                        },
                    },
                    { type: "step-finish", tokens: { total: 1234 } },
                ],
            },
        ],
    },
    {
        name: "file-and-multi-message-range",
        native_messages: [
            {
                absolute_ordinal: 10,
                info: { id: "m10", role: "user" },
                parts: [
                    { type: "text", text: "Inspect this artifact." },
                    {
                        type: "file",
                        filename: "artifact.txt",
                        mime: "text/plain",
                        url: "data:text/plain;base64,YXJ0aWZhY3Q=",
                    },
                ],
            },
            {
                absolute_ordinal: 11,
                info: { id: "m11", role: "assistant" },
                parts: [{ type: "text", text: "Artifact inspected." }],
            },
        ],
    },
] as const;

const renderedCases = cases.map((fixture) => {
    const rawMessages: RawMessage[] = fixture.native_messages.map((message) => ({
        ordinal: message.absolute_ordinal,
        id: message.info.id,
        role: message.info.role,
        parts: [...message.parts],
    }));
    const cleanup = setRawMessageProvider(SESSION, {
        readMessages: () => rawMessages,
        readMessageById: (id) => rawMessages.find((message) => message.id === id) ?? null,
    });
    try {
        const start = rawMessages[0]!.ordinal;
        const end = rawMessages[rawMessages.length - 1]!.ordinal;
        return {
            ...fixture,
            ck_messages: encodeOpenCodeMessagesToCk([...fixture.native_messages]),
            expected: {
                full: rawMessages.map((message) => ({
                    ordinal: message.ordinal,
                    text: renderMessageByOrdinal(SESSION, message.ordinal),
                })),
                verbose: renderVerboseRange(SESSION, start, end, 15_000),
            },
        };
    } finally {
        cleanup();
    }
});

const output = join(import.meta.dir, "../testdata/ctx-facade-golden.json");
writeFileSync(
    output,
    `${JSON.stringify(
        {
            schema: 1,
            provenance: {
                generator: "crates/mc-module/gen/gen-ctx-facade-golden.ts",
                authority: "packages/plugin/src/tools/ctx-expand/render.ts",
                ck_encoder: "packages/plugin/src/hooks/magic-context/module-wire.ts",
            },
            cases: renderedCases,
        },
        null,
        2,
    )}\n`,
);
console.log(`wrote ${renderedCases.length} ctx facade cases → ${output}`);
