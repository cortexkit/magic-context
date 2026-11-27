import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { deleteChunkEmbedBackoffForSession } from "../../../plugin/src/features/magic-context/compartment-chunk-embedding";
import { clearCompressionDepth } from "../../../plugin/src/features/magic-context/compression-depth-storage";
import { getHiddenSeamPlaceholderIds, getStrippedPlaceholderIds } from "../../../plugin/src/features/magic-context/storage-meta-persisted";
import { clearCachedM0M1 } from "../../../plugin/src/features/magic-context/storage-meta-shared";
import { estimateTokens } from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { Database } from "../../../plugin/src/shared/sqlite";
import { V2StoreReader } from "../../../plugin/src/v2/store-reader";
import { type spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";
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
    // The host under test writes to this store; wait for its lock instead of failing.
    db.exec("PRAGMA busy_timeout = 5000");
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

async function recompOutcome(s: Session): Promise<string | undefined> {
    const offset = log(s).length;
    await s.client.session.command({ sessionID: s.sessionId, name: "ctx-recomp", text: "" });
    const after = await waitFor(() => log(s).slice(offset), (text) => text.includes("recomp finished"), "recomp outcome");
    const outcome = after.split("\n").find(line => line.includes("recomp finished"));
    console.log(outcome);
    return outcome;
}

export async function recomp(s: Session): Promise<string | undefined> {
    const outcome = await recompOutcome(s);
    expect(outcome).toContain("published=true");
    expect(outcome).not.toContain("Partial");
    return outcome;
}

export async function seedUnprovedRevert(s: Session, cutoff: number, boot: () => Promise<Host>): Promise<void> {
    assertStoreIsolation(s.host);
    await s.host.stopHost();
    const path = hostDbPath(s.host);
    expect(path.startsWith(`${s.host.root}/`)).toBe(true);
    const db = new Database(path, { fileMustExist: true });
    db.exec("PRAGMA busy_timeout = 5000");
    try {
        db.exec("PRAGMA foreign_keys = ON");
        db.prepare("DELETE FROM session_message WHERE session_id = ? AND seq >= ?").run(s.sessionId, cutoff);
    } finally {
        db.close();
    }
    s.host = await boot();
    s.client = clientFor(s.host);
    await waitForPluginActive(s.client, s.host.cwd);
    assertStoreIsolation(s.host);
}

/** The current command can stage the shorter history, but it no longer publishes it. */
export async function seedLegacyPartialRebuild(
    s: Session,
    boot: () => Promise<Host>,
    endMessage: number,
): Promise<void> {
    const before = state(s);
    const readReceipts = () => readRows<{ key: string; value: string }>(hostDbPath(s.host), `
        SELECT key, value FROM kv WHERE key LIKE ? OR key LIKE ? ORDER BY key
    `, `%:native-fold/v3/${s.sessionId}`, `%:native-fold-state/v3/${s.sessionId}`);
    const receipts = readReceipts();
    expect(receipts.some(({ key }) => key.includes(":native-fold-state/v3/"))).toBe(true);
    const outcome = await recompOutcome(s);
    expect(outcome).toContain("published=false");
    expect(outcome).toContain("Magic Recomp — Paused");
    expect(state(s).summaries).toEqual(before.summaries);

    assertStoreIsolation(s.host);
    await s.host.stopHost();
    // Only the fixture writes the old published state, with no host running.
    // Copy staging to preserve the exact message IDs and block coordinates.
    const path = contextDbPath(s.host);
    expect(path.startsWith(`${s.host.root}/`)).toBe(true);
    const db = new Database(path, { fileMustExist: true });
    db.exec("PRAGMA busy_timeout = 5000");
    try {
        const staged = db.prepare(`
            SELECT sequence, start_message AS startMessage, end_message AS endMessage,
                start_message_id AS startId, end_message_id AS endId, title
            FROM recomp_compartments WHERE session_id = ? ORDER BY sequence
        `).all(s.sessionId) as Summary[];
        expect(staged).toEqual([{
            sequence: 0, startMessage: 1, endMessage,
            startId: expect.any(String), endId: expect.any(String), title: `History 1-${endMessage}`,
        }]);
        const [{ startId, endId }] = staged as [Summary];
        expect(before.seq.get(startId)).toBeLessThan(before.seq.get(endId)!);

        db.transaction(() => {
            deleteChunkEmbedBackoffForSession(db, s.sessionId);
            db.prepare("DELETE FROM compartments WHERE session_id = ?").run(s.sessionId);
            db.prepare("DELETE FROM session_facts WHERE session_id = ?").run(s.sessionId);
            db.prepare(`
                INSERT INTO compartments (session_id, sequence, start_message, end_message,
                    start_message_id, end_message_id, start_block_index, end_block_index,
                    title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness)
                SELECT session_id, sequence, start_message, end_message,
                    start_message_id, end_message_id, start_block_index, end_block_index,
                    title, content, p1, p2, p3, p4, importance, episode_type,
                    CASE WHEN length(p1) > 0 THEN 0 ELSE 1 END, created_at, harness
                FROM recomp_compartments WHERE session_id = ?
            `).run(s.sessionId);
            db.prepare(`
                INSERT INTO m0_mutation_log (session_id, mutation_type, target_id, queued_at)
                VALUES (?, 'recomp_boundary_change', NULL, ?)
            `).run(s.sessionId, Date.now());
            db.prepare("DELETE FROM recomp_compartments WHERE session_id = ?").run(s.sessionId);
            db.prepare("DELETE FROM recomp_facts WHERE session_id = ?").run(s.sessionId);
            clearCachedM0M1(db, s.sessionId);
            clearCompressionDepth(db, s.sessionId);
        }).immediate();

        expect(summaries(path, s.sessionId)).toEqual(staged);
        expect(db.prepare(`
            SELECT cached_m0_bytes AS m0, cached_m1_bytes AS m1,
                cached_m0_last_baseline_end_message_id AS boundary,
                (SELECT count(*) FROM recomp_compartments WHERE session_id = ?) AS stagedSummaries,
                (SELECT count(*) FROM recomp_facts WHERE session_id = ?) AS stagedFacts
            FROM session_meta WHERE session_id = ?
        `).get(s.sessionId, s.sessionId, s.sessionId)).toEqual({ m0: null, m1: null, boundary: null, stagedSummaries: 0, stagedFacts: 0 });
    } finally {
        db.close();
    }
    expect(readReceipts()).toEqual(receipts);
    expect(state(s).checkpoints).toEqual(before.checkpoints);

    s.host = await boot();
    s.client = clientFor(s.host);
    await waitForPluginActive(s.client, s.host.cwd);
    assertStoreIsolation(s.host);
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
    const db = new Database(contextDbPath(s.host), { readonly: true, fileMustExist: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const { droppedTags, stripped, hiddenSeam } = (() => {
        try {
            return {
                droppedTags: db.prepare("SELECT message_id AS id, tag_number AS tag FROM tags WHERE session_id=? AND type='message' AND status='dropped'").all(s.sessionId) as { id: string; tag: number }[],
                stripped: getStrippedPlaceholderIds(db, s.sessionId),
                hiddenSeam: getHiddenSeamPlaceholderIds(db, s.sessionId),
            };
        } finally {
            db.close();
        }
    })();
    const accounted = before.conversation.map(row => {
        const raw = row.marker ? text.split(row.marker).length - 1 : 0;
        const summarized = before.summaries.filter(summary => {
            const first = before.seq.get(summary.startId);
            const last = before.seq.get(summary.endId);
            return first !== undefined && last !== undefined && row.seq >= first && row.seq <= last;
        }).reduce((count, { title }) => count + heads.filter(head => head === title).length, 0);
        const tags = droppedTags.filter(tag => tag.id.startsWith(`${row.id}:`));
        const placeholders = tags.reduce((count, { tag }) => count + text.split(`[dropped §${tag}§]`).length - 1, 0);
        const neutralized = row.type === "assistant" && !raw && !summarized && !placeholders && stripped.has(row.id)
            ? hiddenSeam.has(row.id) ? "removed by frozen seam decision" : "neutralized by frozen placeholder decision"
            : undefined;
        return { id: row.id, seq: row.seq, marker: row.marker ?? row.id, raw, summarized, placeholders, neutralized,
            droppedTagNumbers: tags.map(({ tag }) => tag), frozenPlaceholder: stripped.has(row.id), frozenSeam: hiddenSeam.has(row.id),
            category: raw && summarized ? "both" : raw ? "raw" : summarized ? "summary" : "lost" };
    });
    const missing = accounted.filter(row => row.category === "lost").map(row => [row.seq, row.marker]);
    const repeated = accounted.filter(row => row.raw + row.summarized > 1);
    const passLog = log(s).slice(logOffset);
    const events = passLog.split("\n").filter(line => /MC-S06|MC-H\d+|replay refused|history boundary (repair|unresolved)|cache_hit|cache_bust|HARD fold decision|compartment trigger|stale-floor trigger|v2 restore: ignored/.test(line));
    console.log(`wire ${label}: ${JSON.stringify({ sent: wires.length, elapsedMs, sizes: wires.map(requestTokens), heads, stored: accounted.length, missing, repeated, historian: historian.length, events })}`);
    const ingress = passLog.match(/stale-floor ingress: (\[.*\])/);
    return { marker, wire, heads, missing, repeated, sent: wires.length, accounted,
        staleHeads: heads.filter(title => !before.summaries.some(summary => summary.title === title)),
        ingress: ingress ? JSON.parse(ingress[1]!) as string[] : undefined,
    };
}

export type Probe = Awaited<ReturnType<typeof probe>>;

export function expectExactlyOnce(result: Probe): void {
    expect(result.sent).toBe(1);
    expect(result.missing).toEqual([]);
    expect(result.repeated).toEqual([]);
}

export function expectRestoredHistory(result: Probe): void {
    expect(result.sent).toBe(1);
    expect(result.staleHeads).toEqual([]);
    if (process.env.MC_E2E_REQUIRE_STALE_FLOOR_TRACE === "1") expect(result.ingress).toBeDefined();
    const unrestored = [];
    const decisions = [];
    for (const row of result.accounted) {
        const states = row.raw + row.summarized + row.placeholders + Number(!!row.neutralized);
        if (states !== 1) unrestored.push(row);
        const ingressCount = result.ingress?.filter(id => id === row.id).length;
        if (row.summarized === 0 && ingressCount !== undefined && ingressCount !== 1)
            unrestored.push({ seq: row.seq, ingressCount });
        if (row.neutralized || row.placeholders) decisions.push([row.seq, row.neutralized ?? "tagged drop placeholder"]);
    }
    console.log(`recorded drop replay: ${JSON.stringify(decisions)}`);
    expect(unrestored).toEqual([]);
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
