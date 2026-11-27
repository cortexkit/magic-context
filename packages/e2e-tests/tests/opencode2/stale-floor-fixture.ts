import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { estimateTokens } from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { Database } from "../../../plugin/src/shared/sqlite";
import { V2StoreReader } from "../../../plugin/src/v2/store-reader";
import type { spawnOpencode2 } from "../../src/opencode2-runner/spawn";
import { providerSystemText } from "../../src/provider-system-text";

export type Host = Awaited<ReturnType<typeof spawnOpencode2>>;
export const HISTORIAN_SYSTEM = "the hippocampus of a long-running coding agent";
export const IMPORTED_SUMMARY = "[Compacted by magic-context — session history is managed by the plugin]";

export function clientFor(host: Host) {
    return OpenCode.make({
        baseUrl: host.url,
        headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
    });
}

type Client = ReturnType<typeof clientFor>;

export interface Session {
    host: Host;
    client: Client;
    sessionId: string;
    logPath: string;
}

export function hostDbPath(host: Host): string {
    return join(host.env.XDG_DATA_HOME!, "opencode", host.env.OPENCODE_DB!);
}

function contextDbPath(host: Host): string {
    return join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db");
}

export function readRows<T>(path: string, sql: string, ...params: unknown[]): T[] {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        return db.prepare(sql).all(...params) as T[];
    } finally {
        db.close();
    }
}

interface Summary {
    sequence: number;
    startMessage: number;
    endMessage: number;
    startId: string;
    endId: string;
    title: string;
}

export function summaries(path: string, sessionId: string): Summary[] {
    return readRows<Summary>(path,
        `SELECT sequence, start_message AS startMessage, end_message AS endMessage,
            start_message_id AS startId, end_message_id AS endId, title
        FROM compartments WHERE session_id = ? ORDER BY sequence`, sessionId);
}

export function state({ host, sessionId }: Session) {
    const reader = new V2StoreReader(hostDbPath(host));
    try {
        const rows = reader.range(sessionId, -1, reader.latestSequence(sessionId));
        const conversation = rows.flatMap((row) => {
            if (row.type !== "user" && row.type !== "assistant") return [];
            const marker = JSON.stringify(row.data).match(
                /ASSISTANT-WIRE-\d+#|Turn P?\d+:|PROBE-[\w-]+#|Magic Recomp/,
            )?.[0];
            return [{ id: row.id, seq: row.seq, type: row.type, marker }];
        });
        const checkpoints = rows.flatMap((row) => row.type === "compaction"
            ? [{ id: row.id, seq: row.seq, summary: row.data.summary }]
            : []);
        return {
            conversation,
            checkpoints,
            cut: reader.latestCompaction(sessionId),
            summaries: summaries(contextDbPath(host), sessionId),
            seq: new Map(rows.map(row => [row.id, row.seq])),
        };
    } finally {
        reader.close();
    }
}

export function assertStoreIsolation(host: Host): void {
    if (!host.pid) throw new Error("missing host pid");
    const result = spawnSync("lsof", ["-p", String(host.pid), "-Fn"], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`host lsof failed: ${result.status} ${result.stderr}`);
    const paths = result.stdout.split("\n")
        .filter(line => /^n\/.*\.db(?:-(?:wal|shm))?$/.test(line))
        .map(line => line.slice(1));
    expect(paths).toContain(hostDbPath(host));
    expect(paths).toContain(contextDbPath(host));
    expect(paths.filter(path => !path.startsWith(`${host.root}/`))).toEqual([]);
    console.log(`lsof -p ${host.pid}: ${JSON.stringify([...new Set(paths)])} root=${host.root}`);
}

export async function waitFor<T>(read: () => T, done: (value: T) => boolean, label: string): Promise<T> {
    const deadline = Date.now() + 60_000;
    for (;;) {
        const value = read();
        if (done(value)) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await Bun.sleep(100);
    }
}

export async function turn(s: Session, text: string): Promise<void> {
    await s.client.session.prompt({ sessionID: s.sessionId, text });
    await s.client.session.wait({ sessionID: s.sessionId }, { signal: AbortSignal.timeout(60_000) });
}

export function log(s: Session): string {
    return existsSync(s.logPath) ? readFileSync(s.logPath, "utf8") : "";
}

export async function recomp(s: Session, result: "Partial" | "Complete"): Promise<void> {
    const offset = log(s).length;
    await s.client.session.command({ sessionID: s.sessionId, name: "ctx-recomp", text: "" });
    const after = await waitFor(() => log(s).slice(offset), (text) => text.includes("recomp finished"), `${result} recomp`);
    const outcome = after.split("\n").find(line => line.includes("recomp finished"));
    console.log(outcome);
    expect(outcome).toContain("published=true");
    if (result === "Partial") expect(outcome).toContain("Partial");
    else expect(outcome).not.toContain("Partial");
}

export async function revert(s: Session, target: string): Promise<void> {
    await s.client.session.revert.stage({ sessionID: s.sessionId, messageID: target });
    // The asynchronous host subscription needs to read the staged suffix
    // before the commit deletes it, just as it does between two user actions.
    await Bun.sleep(350);
    await s.client.session.revert.commit({ sessionID: s.sessionId });
    await waitFor(() => state(s), ({ seq }) => !seq.has(target), "host revert deletion");
}

export function requestTokens(body: Record<string, unknown>): number {
    return estimateTokens(JSON.stringify({
        input: body.input ?? body.messages,
        instructions: body.instructions ?? body.system,
        tools: body.tools,
    }));
}

/** Account for every user/assistant row already stored before the probe. */
export async function probe(s: Session, label: string) {
    const before = state(s);
    const offset = s.host.mock.requests().length;
    const logOffset = log(s).length;
    const marker = `PROBE-${label}#`;
    const begin = performance.now();
    await turn(s, marker);
    const elapsedMs = Math.round(performance.now() - begin);
    const requests = s.host.mock.requests().slice(offset).map(request => request.body);
    const historian = requests.filter(body => providerSystemText(body).includes(HISTORIAN_SYSTEM));
    const wires = requests.filter(body => !historian.includes(body) && JSON.stringify(body.input ?? body.messages).includes(marker));
    const wire = wires.at(-1);
    const text = JSON.stringify(wire?.input ?? wire?.messages ?? []);
    const heads = [...text.matchAll(/History \d+-\d+/g)].map(match => match[0]);
    const accounted = before.conversation.map(row => {
        const raw = row.marker ? text.split(row.marker).length - 1 : 0;
        const summarized = before.summaries.filter(summary => {
            const first = before.seq.get(summary.startId);
            const last = before.seq.get(summary.endId);
            return first !== undefined && last !== undefined && row.seq >= first && row.seq <= last;
        }).reduce((count, { title }) => count + heads.filter(head => head === title).length, 0);
        return { seq: row.seq, marker: row.marker ?? row.id, raw, summarized,
            category: raw && summarized ? "both" : raw ? "raw" : summarized ? "summary" : "lost" };
    });
    const missing = accounted.filter(row => row.category === "lost").map(row => [row.seq, row.marker]);
    const repeated = accounted.filter(row => row.raw + row.summarized > 1);
    const events = log(s).slice(logOffset).split("\n").filter(line => /MC-S06|MC-H\d+|replay refused|history boundary (repair|unresolved)|cache_hit|cache_bust/.test(line));
    console.log(`wire ${label}: ${JSON.stringify({ sent: wires.length, elapsedMs, sizes: wires.map(requestTokens), heads, stored: accounted.length, missing, repeated, historian: historian.length, events })}`);
    return { marker, wire, heads, missing, repeated, sent: wires.length };
}

export type Probe = Awaited<ReturnType<typeof probe>>;

export function expectExactlyOnce(result: Probe): void {
    expect(result.sent).toBe(1);
    expect(result.missing).toEqual([]);
    expect(result.repeated).toEqual([]);
}

export function expectUnchangedPrefix(first: Probe, next: Probe): void {
    const prefix = (result: Probe) => {
        const wire = result.wire!;
        const input = (wire.input ?? wire.messages) as unknown[];
        const index = input.findIndex(item => JSON.stringify(item).includes(first.marker));
        expect(index).toBeGreaterThan(0);
        return JSON.stringify({ input: input.slice(0, index), instructions: wire.instructions ?? wire.system, tools: wire.tools });
    };
    expect(prefix(next)).toBe(prefix(first));
}
