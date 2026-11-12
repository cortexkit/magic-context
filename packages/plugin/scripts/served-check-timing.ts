/**
 * Wall time of the served check (served-check.ts) at 1,000 and 10,000
 * messages: the appending pass every ordinary turn runs, and a pass whose
 * first message changed, which runs the full content check.
 *
 *   bun packages/plugin/scripts/served-check-timing.ts [--rounds N]
 *
 * The message shape follows a long coding session: user text of 400
 * characters, assistant text of 600 characters with one tool part carrying 2 KB
 * of output and 4 KB of diagnostics metadata the provider never receives, every
 * fourth assistant with signed reasoning, and a history head of about 60 KB
 * (m[0]) and 8 KB (m[1]). Every pass gets fresh message objects parsed from
 * JSON, as the hosts rebuild them from their stores; the copy is made outside
 * the timed region. The first rounds only warm the JIT up.
 *
 * No store is opened and no host is started.
 */
import {
    commitServedRequest,
    getServedCheckWorkForTest,
    resetServedCheckForTest,
} from "../src/hooks/magic-context/served-check";

const args = process.argv.slice(2);
const roundsAt = args.indexOf("--rounds");
const rounds = roundsAt >= 0 ? Number(args[roundsAt + 1]) : 30;
// The first rounds warm the JIT up, as the first passes of a session do.
const warmup = 10;

function text(length: number, seed: number): string {
    let out = "";
    while (out.length < length) out += `word${seed}-${out.length} `;
    return out.slice(0, length);
}

function head(id: string, length: number): unknown {
    return {
        info: { id, role: "user", sessionID: "timing" },
        parts: [{ id: `${id}-p`, type: "text", text: text(length, 7), synthetic: true }],
    };
}

function message(index: number): unknown {
    const id = `msg_${String(index).padStart(8, "0")}`;
    if (index % 2 === 0)
        return {
            info: { id, role: "user", sessionID: "timing", time: { created: index } },
            parts: [{ id: `${id}-t`, type: "text", text: text(400, index) }],
        };
    return {
        info: {
            id,
            role: "assistant",
            sessionID: "timing",
            time: { created: index, completed: index + 1 },
            finish: "tool-calls",
            providerID: "anthropic",
            modelID: "claude-opus-5-5",
        },
        parts: [
            ...(index % 8 === 1
                ? [
                      {
                          id: `${id}-r`,
                          type: "reasoning",
                          text: text(300, index),
                          metadata: { anthropic: { signature: `sig-${index}` } },
                      },
                  ]
                : []),
            { id: `${id}-a`, type: "text", text: text(600, index) },
            {
                id: `${id}-b`,
                type: "tool",
                tool: "read",
                callID: `call-${index}`,
                state: {
                    status: "completed",
                    input: { filePath: `/repo/src/file-${index}.ts` },
                    output: text(2_000, index),
                    title: `file-${index}.ts`,
                    metadata: { diagnostics: text(4_000, index) },
                    time: { start: index, end: index + 1 },
                },
            },
        ],
    };
}

function build(count: number): unknown[] {
    const messages: unknown[] = [head("m0", 60_000), head("m1", 8_000)];
    for (let index = 0; messages.length < count; index += 1) messages.push(message(index));
    return messages;
}

/** New message objects with the same content, as a host builds them from its store. */
function fresh<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Collect the copies' garbage first, so a collection does not land inside a timed check. */
const collect = (): void => (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);

const MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };

for (const count of [1_000, 10_000]) {
    const base = build(count);
    const append: number[] = [];
    const appendShape: number[] = [];
    const early: number[] = [];
    let appendWork = getServedCheckWorkForTest();
    let earlyWork = appendWork;
    for (let round = 0; round < rounds; round += 1) {
        resetServedCheckForTest();
        const sessionId = `timing-${count}`;
        // The first pass of the session in this process starts the record.
        commitServedRequest({
            sessionId,
            host: "opencode",
            messages: fresh(base),
            ...MODEL,
        });
        // An ordinary turn: two more messages appended to the same request.
        const appended = fresh([...base, message(count), message(count + 1)]);
        collect();
        commitServedRequest({ sessionId, host: "opencode", messages: appended, ...MODEL });
        appendWork = getServedCheckWorkForTest();
        if (round >= warmup) {
            append.push(appendWork.ms);
            appendShape.push(appendWork.shapeMs);
        }
        // A pass that re-renders m[1]: the full check runs.
        const changed = fresh(appended) as Array<{ parts: Array<{ text: string }> }>;
        (changed[1] as { parts: Array<{ text: string }> }).parts[0]!.text += " refreshed";
        collect();
        commitServedRequest({ sessionId, host: "opencode", messages: changed, ...MODEL });
        earlyWork = getServedCheckWorkForTest();
        if (round >= warmup) early.push(earlyWork.ms);
    }
    console.log(
        `${count} messages: appending pass median ${median(append).toFixed(3)} ms, of which tier 1 ${median(appendShape).toFixed(3)} ms (fingerprinted=${appendWork.fingerprinted} digested=${appendWork.digested} full=${appendWork.full}); early-change pass median ${median(early).toFixed(3)} ms (fingerprinted=${earlyWork.fingerprinted} digested=${earlyWork.digested} full=${earlyWork.full})`,
    );
}
