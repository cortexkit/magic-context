import type { MessageLike } from "../tag-messages";
import { publishMessages } from "./opencode-adapter";
import { assemble, createRecord } from "./record";

// Synthetic history with 50,000 recorded rows and 900 live rows; no user data is read.
const record = createRecord<MessageLike, Record<string, never>>({
    lineage_id: "benchmark",
    first_ordinal: 1,
    plan: {},
    initial: {
        compaction_id: "benchmark-view",
        version: 1,
        range: { from: 0, to: 0 },
        replacement: [],
    },
});
for (let i = 1; i <= 50_000; i++) {
    record.ids.set(`message-${i}`, i);
    if (i <= 49_100) continue;
    const served: MessageLike = {
        info: { id: `message-${i}`, role: i % 2 ? "user" : "assistant" },
        parts: [
            { type: "text", text: "sanitized transcript line\n".repeat(40) },
            {
                id: `tool-${i}`,
                type: "tool",
                callID: `call-${i}`,
                tool: "read",
                state: {
                    input: { path: "fixture.txt" },
                    status: "completed",
                    output: "sanitized tool output\n".repeat(100),
                },
            },
        ],
    };
    record.entries.push({
        id: String(served.info.id),
        ordinal: i,
        ingest: "",
        served,
        op_version: 1,
        hook: { answers: [] },
        ingested: true,
        race: false,
    });
}
const live = assemble(record);
if (live.length !== 900) throw new Error(`Expected 900 live rows, got ${live.length}`);
const output = { messages: [] as unknown[] };
const samples: number[] = [];
for (let i = 0; i < 220; i++) {
    const start = performance.now();
    publishMessages(output, live);
    if (i >= 20) samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
console.log(
    JSON.stringify({
        history: record.ids.size,
        live: live.length,
        live_bytes: Buffer.byteLength(JSON.stringify(live)),
        samples: samples.length,
        copy_p50_ms: samples[Math.floor(samples.length * 0.5)],
        copy_p95_ms: samples[Math.floor(samples.length * 0.95)],
        copy_max_ms: samples.at(-1),
    }),
);
