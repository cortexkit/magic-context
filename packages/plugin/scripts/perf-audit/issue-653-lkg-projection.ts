/**
 * Time the LKG entry projection (`lkg.entryProjection`) for two large sessions
 * served alternately by one process, as in issue 653.
 *
 *   bun scripts/perf-audit/issue-653-lkg-projection.ts [--src <plugin src dir>] [--passes N]
 *
 * `--src` points at a `packages/plugin/src` tree (for example a `git archive` of
 * an older tag) so the same driver measures before and after. Each pass parses
 * the session again from JSON, as OpenCode 1 does, and every second pass of a
 * session appends one user/assistant turn first.
 */
import { resolve } from "node:path";
import { appendTurn, buildSession, loadMessages, rng } from "./issue-653-fixture";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
    const at = args.indexOf(name);
    return at >= 0 && args[at + 1] ? (args[at + 1] as string) : fallback;
};
const src = resolve(flag("--src", resolve(import.meta.dir, "../../src")));
const passes = Number(flag("--passes", "6"));
const messageCount = Number(flag("--messages", "606"));
const megabytes = Number(flag("--mb", "56"));

const { createLkgEntryProjector } = (await import(
    `${src}/hooks/magic-context/lkg-replay.ts`
)) as typeof import("../../src/hooks/magic-context/lkg-replay");
const { captureSlot, noteEntry } = (await import(
    `${src}/hooks/magic-context/lkg-slot.ts`
)) as typeof import("../../src/hooks/magic-context/lkg-slot");

const sessions = [
    buildSession("A", 1, messageCount, megabytes * 1024 * 1024),
    buildSession("B", 2, messageCount, megabytes * 1024 * 1024),
];
for (const session of sessions) {
    console.log(
        `${session.sessionId}: ${session.json.length} messages, ${(session.totalChars / 1024 / 1024).toFixed(1)} MB JSON`,
    );
}

const last: { stats?: { reused: number; retained: number; retainedBytes: number } } = {};
const project = createLkgEntryProjector({
    onReuse: (value) => {
        last.stats = value;
    },
});
const random = rng(99);
console.log(`src=${src}`);
console.log("pass\tsession\tmessages\tnoteEntry_ms\tprojection_ms\treused\tretained\tretainedBytes");
for (let pass = 0; pass < passes; pass += 1) {
    for (const session of sessions) {
        if (pass > 0 && pass % 2 === 0) appendTurn(session, random);
        const messages = loadMessages(session);
        // In production a captured slot makes the messages handler note the
        // entry (digesting the prefix up to the slot's anchor) before the
        // transform projects it. The served prefix after compaction is small,
        // so a stand-in slot anchored at the newest user message is enough.
        const anchor = [...messages].reverse().find((message) => message.info.role === "user");
        captureSlot(session.sessionId, {
            jsonPrefix: "[]",
            inputIdSeq: [],
            inputContentDigests: [],
            lastInputMessageId: anchor?.info.id as string,
            modelKey: null,
            providerKey: null,
            capturedAt: 1,
        });
        const noteStarted = performance.now();
        noteEntry(session.sessionId, messages as never);
        const noteElapsed = performance.now() - noteStarted;
        const started = performance.now();
        project(session.sessionId, messages as never);
        const elapsed = performance.now() - started;
        console.log(
            `${pass}\t${session.sessionId}\t${messages.length}\t${noteElapsed.toFixed(1)}\t${elapsed.toFixed(1)}\t${last.stats?.reused ?? "-"}\t${last.stats?.retained ?? "-"}\t${last.stats?.retainedBytes ?? "-"}`,
        );
    }
}
