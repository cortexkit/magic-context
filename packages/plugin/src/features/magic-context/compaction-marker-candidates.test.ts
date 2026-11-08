import { expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ordinalWarmup from "../../hooks/magic-context/raw-ordinal-warmup";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { fixture, hostStore, messageId, SESSION } from "./__tests__/host-stalls.fixture";
import {
    closeCompactionMarkerDb,
    getPreparedCompactionMarkerSummaryIds,
    injectCompactionMarker,
    prepareCompactionMarkerCandidates,
    replaceCompactionMarker,
} from "./compaction-marker";
import { prepareMarkerCandidateBasis } from "./compaction-marker-candidates";

it("an unloadable candidate worker reports its file once and retains the marker", async () => {
    const f = fixture();
    const oldHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = f.dir;
    mkdirSync(join(f.dir, "opencode"));
    const db = hostStore(join(f.dir, "opencode/opencode.db"), 20);
    const logs = spyOn(logger, "log");
    try {
        expect(await prepareCompactionMarkerCandidates(SESSION)).toBe(true);
        expect(
            injectCompactionMarker({
                sessionId: SESSION,
                endMessageId: messageId(12),
                endOrdinal: 13,
                summaryText: "summary",
                directory: f.dir,
            }),
        ).not.toBeNull();
        const before = db.prepare("SELECT id,data FROM message ORDER BY id").all();
        const entry = join(f.dir, "unloadable-worker.mjs");
        writeFileSync(entry, `throw new Error("candidate worker fixture cannot load");`);
        for (let attempt = 0; attempt < 2; attempt++)
            expect(
                await prepareCompactionMarkerCandidates(SESSION, {
                    entry: new URL(`file://${entry}`),
                }),
            ).toBe(false);
        expect(getPreparedCompactionMarkerSummaryIds(SESSION)).toBeUndefined();
        expect(db.prepare("SELECT id,data FROM message ORDER BY id").all()).toEqual(before);
        const errors = logs.mock.calls.filter(([line]) =>
            String(line).includes("[ERROR] compaction-marker: candidate worker unavailable"),
        );
        expect(errors).toHaveLength(1);
        expect(errors[0]?.[0]).toContain(entry);
        expect(errors[0]?.[0]).toContain("marker unchanged, advancement deferred");
    } finally {
        logs.mockRestore();
        closeCompactionMarkerDb();
        db.close();
        process.env.XDG_DATA_HOME = oldHome;
        f.cleanup();
    }
});

it("marker receipt mismatch defers the advance without deleting any current marker rows", async () => {
    const f = fixture();
    const oldHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = f.dir;
    mkdirSync(join(f.dir, "opencode"));
    const path = join(f.dir, "opencode/opencode.db");
    const db = hostStore(path, 20);
    const forbidden = spyOn(ordinalWarmup, "prewarmRawSessionOrdinalsForDb").mockImplementation(
        () => {
            throw new Error("marker preparation must not warm ordinals");
        },
    );
    const logs = spyOn(logger, "log");
    try {
        expect(await prepareCompactionMarkerCandidates(SESSION)).toBe(true);
        const args = {
            sessionId: SESSION,
            endMessageId: messageId(12),
            endOrdinal: 13,
            summaryText: "summary",
            directory: f.dir,
            resolvedBoundary: { id: messageId(12), timeCreated: 4 },
        };
        const current = injectCompactionMarker(args);
        expect(current).not.toBeNull();
        const beforeParts = db.prepare("SELECT id FROM part ORDER BY id").all();
        const entry = join(f.dir, "delayed-candidates.mjs");
        const sqlite = new URL("../../shared/sqlite.ts", import.meta.url).href;
        const scan = new URL("./compaction-marker-candidates.ts", import.meta.url).href;
        writeFileSync(
            entry,
            `import {parentPort,workerData} from 'node:worker_threads';
            import {existsSync,writeFileSync} from 'node:fs';
            parentPort.postMessage({kind:'accepted'});
            const {Database}=await import(${JSON.stringify(sqlite)});
            const {scanMarkerCandidateSnapshot}=await import(${JSON.stringify(scan)});
            const db=new Database(workerData.path,{readonly:true});
            const snapshot=scanMarkerCandidateSnapshot(db,workerData.sessionId);db.close();
            writeFileSync(workerData.path+'.ready','ready');
            while(!existsSync(workerData.path+'.release'))await new Promise(r=>setTimeout(r,5));
            parentPort.postMessage({kind:'candidates',snapshot});parentPort.close();`,
        );
        const pending = prepareCompactionMarkerCandidates(SESSION, {
            entry: new URL(`file://${entry}`),
            acceptMs: 60000,
            resultMs: 120000,
        });
        const deadline = Date.now() + 60000;
        while (!existsSync(`${path}.ready`)) {
            if (Date.now() > deadline) throw new Error("candidate barrier not reached");
            await Bun.sleep(5);
        }
        const peer = new Database(path);
        try {
            peer.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
                "concurrent-summary",
                SESSION,
                null,
                100,
                JSON.stringify({ role: "assistant", summary: true, finish: "stop" }),
            );
        } finally {
            peer.close();
        }
        writeFileSync(`${path}.release`, "go");
        expect(await pending).toBe(false);
        const before = db.prepare("SELECT id FROM message ORDER BY id").all();
        expect(getPreparedCompactionMarkerSummaryIds(SESSION)).toBeUndefined();
        const next = replaceCompactionMarker(current, {
            ...args,
            endMessageId: messageId(15),
            endOrdinal: 16,
            resolvedBoundary: { id: messageId(15), timeCreated: 5 },
        });
        expect(next.kind).toBe("deferred");
        expect(db.prepare("SELECT id FROM message ORDER BY id").all()).toEqual(before);
        expect(db.prepare("SELECT id FROM part ORDER BY id").all()).toEqual(beforeParts);
        expect(
            logs.mock.calls.filter(([line]) =>
                String(line).includes("summary set or frontier changed during discovery"),
            ),
        ).toHaveLength(1);
        expect(forbidden).not.toHaveBeenCalled();
    } finally {
        logs.mockRestore();
        forbidden.mockRestore();
        closeCompactionMarkerDb();
        db.close();
        process.env.XDG_DATA_HOME = oldHome;
        f.cleanup();
    }
});

// Marker discovery jobs for one store share a worker thread and run one at a
// time, and one session's part scan can take many seconds. A discovery queued
// behind it must count its accept deadline from when its own job starts, not
// from when it was queued; otherwise it fails with a misleading worker error.
it("a discovery queued behind another session's long scan on the shared worker still succeeds", async () => {
    const f = fixture();
    const path = join(f.dir, "host.db");
    const db = hostStore(path, 20);
    const entry = join(f.dir, "queued-discovery.mjs");
    writeFileSync(
        entry,
        `import {existsSync} from 'node:fs';
        import {serveWorkerJobs} from ${JSON.stringify(new URL("../../shared/reusable-worker-entry.ts", import.meta.url).href)};
        serveWorkerJobs(async (input, port) => {
            port.postMessage({kind:'accepted'});
            if (input.sessionId === 'long-scan')
                while (!existsSync(input.path + '.release')) await new Promise((r) => setTimeout(r, 5));
            const {Database} = await import(${JSON.stringify(new URL("../../shared/sqlite.ts", import.meta.url).href)});
            const {scanMarkerCandidateSnapshot} = await import(${JSON.stringify(new URL("./compaction-marker-candidates.ts", import.meta.url).href)});
            const db = new Database(input.path, {readonly: true});
            const snapshot = scanMarkerCandidateSnapshot(db, input.sessionId, input.references !== false);
            db.close();
            port.postMessage({kind: 'candidates', snapshot});
        });`,
    );
    const options = {
        entry: new URL(`file://${entry}`),
        shareWorker: true,
        acceptMs: 300,
        resultMs: 60_000,
    };
    const logs = spyOn(logger, "log");
    try {
        const long = prepareMarkerCandidateBasis(db, "long-scan", options);
        const queued = prepareMarkerCandidateBasis(db, "queued", options);
        // Hold the first scan well past the queued job's 300 ms accept deadline.
        await Bun.sleep(1_000);
        writeFileSync(`${path}.release`, "go");
        expect(await long).toBe(true);
        expect(await queued).toBe(true);
        expect(
            logs.mock.calls.filter(([line]) => String(line).includes("worker deadline exceeded")),
        ).toHaveLength(0);
    } finally {
        logs.mockRestore();
        db.close();
        f.cleanup();
    }
});
