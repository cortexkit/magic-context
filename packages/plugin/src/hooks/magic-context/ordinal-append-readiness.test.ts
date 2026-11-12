/// <reference types="bun-types" />
import { Database as RawDatabase } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../features/magic-context/__tests__/opencode1-query-fixture";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getReasoningTokenEstimatesByMessage,
    isTagOwnerSummaryReady,
} from "../../features/magic-context/storage-tags";
import * as logger from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { listOpenFiles } from "../../shared/test-open-files";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { createCtxExpandTools } from "../../tools/ctx-expand/tools";
import {
    prewarmRawSessionOrdinalsForDb,
    resetRawSessionOrdinalWarmupsForTest,
} from "./raw-ordinal-warmup";
import {
    closeReadOnlySessionDb,
    observeOpenCodeTurnEvent,
    withReadOnlySessionDb,
} from "./read-session-db";
import {
    countRawSessionMessageOrdinalsFromDb,
    getRawSessionSummaryFullScansForTest,
    isRawSessionSummaryWarm,
    noteRawSessionSummaryRowWritten,
    readRawSessionMessageOrdinalByIdFromDb,
    resetRawSessionOrdinalJsonRowsReadForTest,
} from "./read-session-raw";
import { prewarmTagOwners } from "./tag-owner-warmup";

const SESSION = "ses-append-readiness";
const id = (index: number) => `message-${String(index).padStart(8, "0")}`;
const stressRoot = process.env.MC_ORDINAL_STRESS_ROOT;

async function fixture(
    run: (
        source: RawDatabase,
        reader: Database,
        context: Database,
        root: string,
        length: number,
    ) => Promise<void>,
    large = false,
) {
    const temp = createTestTempDir("mc-ordinal-append-");
    const root = large && stressRoot ? resolve(stressRoot) : temp.dir;
    if (root.includes("/.local/share/") || root.includes("/.config/"))
        throw new Error("fixture root must not be a live store");
    mkdirSync(root, { recursive: true });
    const path = join(root, "opencode.db");
    const context = new Database(join(root, "context.db"));
    initializeDatabase(context);
    context.exec("CREATE TABLE IF NOT EXISTS foreign_activity (value INTEGER)");
    const source = new RawDatabase(path);
    source.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF");
    source.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
    const length = large && stressRoot ? 150_000 : 4096;
    const insert = source.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const part = source.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    const payload = large && stressRoot ? "x".repeat(18_000) : "original text";
    for (let start = 0; start < length; start += 5000)
        source.transaction(() => {
            for (let index = start; index < Math.min(start + 5000, length); index++) {
                insert.run(
                    id(index),
                    SESSION,
                    index,
                    index,
                    JSON.stringify(
                        index % 1000 === 999
                            ? { role: "assistant", summary: true, finish: "stop" }
                            : { role: "user" },
                    ),
                );
                part.run(
                    `part-${index}`,
                    id(index),
                    SESSION,
                    index,
                    index,
                    JSON.stringify({ type: "text", text: payload }),
                );
            }
        })();
    source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const previousPath = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = path;
    closeReadOnlySessionDb();
    try {
        await withReadOnlySessionDb((reader) => run(source, reader, context, root, length));
    } finally {
        closeReadOnlySessionDb();
        if (previousPath === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = previousPath;
        source.close();
        context.close();
        resetRawSessionOrdinalWarmupsForTest();
        temp.cleanup();
    }
}

function recount(db: RawDatabase, through: number): number {
    return (
        db
            .prepare(`SELECT COUNT(*) AS n FROM message WHERE session_id=? AND time_created<=?
        AND NOT (COALESCE(json_extract(data,'$.summary'),0)=1 AND COALESCE(json_extract(data,'$.finish'),'')='stop')`)
            .get(SESSION, through) as { n: number }
    ).n;
}

// Each call is a commit from another process, not a mocked data_version change.
function foreignWrite(root: string): void {
    const child = Bun.spawnSync({
        cmd: [
            process.execPath,
            "-e",
            `import { Database } from 'bun:sqlite'; const db=new Database(process.argv[1]); db.exec('INSERT INTO foreign_activity VALUES (1)'); db.close();`,
            join(root, "context.db"),
        ],
        windowsHide: true,
    });
    expect(child.exitCode).toBe(0);
}

test(
    "append preparation stays warm for 120 commits and ctx_expand serves the active session",
    async () => {
        await fixture(async (source, reader, context, root, length) => {
            const log = spyOn(logger, "log");
            try {
                expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");
                context.transaction(() => {
                    const insert = context.prepare(
                        "INSERT INTO tags (session_id,message_id,type,tag_number,byte_size,reasoning_token_count) VALUES (?,?, 'message',?,10,42)",
                    );
                    for (let tag = 0; tag < (stressRoot ? 100_000 : 2048); tag++)
                        insert.run(SESSION, id(tag), tag + 1);
                })();
                expect(await prewarmTagOwners(context, SESSION, 1)).toBe(true);
                resetRawSessionOrdinalJsonRowsReadForTest();
                const timings: number[] = [];
                const ownerTimings: number[] = [];
                let random = 0x1ab23;
                for (let pass = 0; pass < 120; pass++) {
                    const index = length + pass;
                    source
                        .prepare("INSERT INTO message VALUES (?,?,?,?,?)")
                        .run(id(index), SESSION, index, index, '{"role":"user"}');
                    source
                        .prepare("INSERT INTO part VALUES (?,?,?,?,?,?)")
                        .run(
                            `part-${index}`,
                            id(index),
                            SESSION,
                            index,
                            index,
                            JSON.stringify({ type: "text", text: `active append ${pass}` }),
                        );
                    // Assistant-part updates cannot change this session's message ordinals.
                    source
                        .prepare("UPDATE part SET time_updated=time_updated+1 WHERE id=?")
                        .run(`part-${index}`);
                    foreignWrite(root);
                    const started = performance.now();
                    expect(isRawSessionSummaryWarm(reader, SESSION)).toBe(true);
                    expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");
                    timings.push(performance.now() - started);
                    const ownersStarted = performance.now();
                    expect(isTagOwnerSummaryReady(context, SESSION, 1)).toBe(true);
                    ownerTimings.push(performance.now() - ownersStarted);
                    expect(
                        getReasoningTokenEstimatesByMessage(context, SESSION, 1).get(id(0)),
                    ).toBe(42);
                    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
                    const sample = random % (index + 1);
                    expect(
                        readRawSessionMessageOrdinalByIdFromDb(reader, SESSION, id(sample)),
                    ).toBe(recount(source, sample));
                    expect(countRawSessionMessageOrdinalsFromDb(reader, SESSION)).toBe(
                        recount(source, index),
                    );
                }
                const expanded = await createCtxExpandTools({ db: context }).ctx_expand.execute(
                    { message: recount(source, length + 119) },
                    { sessionID: SESSION } as never,
                );
                expect(expanded).toContain("active append 119");
                expect(expanded).not.toContain("warming in the background");
                expect(
                    log.mock.calls.filter((call) => String(call[0]).includes("warmed off-thread")),
                ).toHaveLength(1);
                expect(getRawSessionSummaryFullScansForTest()).toBe(0);
                console.info(
                    JSON.stringify({
                        fixtureBytes: statSync(join(root, "opencode.db")).size,
                        messages: length,
                        passes: timings.length,
                        ready: true,
                        warmups: 1,
                        prepareAverageMs: timings.reduce((a, b) => a + b, 0) / timings.length,
                        prepareMaxMs: Math.max(...timings),
                        ownerPrepareAverageMs:
                            ownerTimings.reduce((a, b) => a + b, 0) / ownerTimings.length,
                        ownerPrepareMaxMs: Math.max(...ownerTimings),
                        ctx_expand: "active append 119",
                    }),
                );
                if (stressRoot) {
                    expect(statSync(join(root, "opencode.db")).size).toBeGreaterThan(2_000_000_000);
                    const inventory = listOpenFiles();
                    // The stress fixture needs positive evidence that no live database is open.
                    if (!inventory.available) throw new Error(inventory.reason);
                    const dbLines = inventory.paths.filter((path) =>
                        /\.db(?:-wal|-shm)?\s*$/.test(path),
                    );
                    expect(dbLines.length).toBeGreaterThan(0);
                    for (const line of dbLines) expect(line).toContain(root);
                    console.info(`HOST PID ${process.pid}\n${dbLines.join("\n")}`);
                }
            } finally {
                log.mockRestore();
            }
        }, true);
    },
    stressRoot ? 600_000 : 30_000,
);

test("revert truncates checkpoints without rescanning the surviving prefix", async () => {
    await fixture(async (source, reader, _context, _root, length) => {
        const log = spyOn(logger, "log");
        try {
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");
            source
                .prepare("DELETE FROM message WHERE session_id=? AND time_created>=?")
                .run(SESSION, length - 900);
            observeOpenCodeTurnEvent("message.removed", {
                sessionID: SESSION,
                messageID: id(length - 900),
            });
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");
            expect(countRawSessionMessageOrdinalsFromDb(reader, SESSION)).toBe(
                recount(source, length),
            );
            source
                .prepare("INSERT INTO message VALUES (?,?,?,?,?)")
                .run("after-revert", SESSION, length, length, '{"role":"user"}');
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");
            expect(readRawSessionMessageOrdinalByIdFromDb(reader, SESSION, "after-revert")).toBe(
                recount(source, length),
            );
            expect(
                log.mock.calls.filter((call) => String(call[0]).includes("warmed off-thread")),
            ).toHaveLength(1);
        } finally {
            log.mockRestore();
        }
    });
});

test("excluded marker appends preserve durable ordinals", async () => {
    await fixture(async (source, reader, _context, _root, length) => {
        const log = spyOn(logger, "log");
        try {
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");
            const original = readRawSessionMessageOrdinalByIdFromDb(
                reader,
                SESSION,
                id(length - 2),
            );
            source
                .prepare("INSERT INTO message VALUES (?,?,?,?,?)")
                .run(
                    "marker",
                    SESSION,
                    length,
                    length,
                    '{"role":"assistant","summary":true,"finish":"stop"}',
                );
            noteRawSessionSummaryRowWritten(SESSION, "marker");
            expect(await prewarmRawSessionOrdinalsForDb(reader, SESSION)).toBe("warm");
            expect(readRawSessionMessageOrdinalByIdFromDb(reader, SESSION, id(length - 2))).toBe(
                original,
            );
            expect(countRawSessionMessageOrdinalsFromDb(reader, SESSION)).toBe(
                recount(source, length),
            );
            expect(
                log.mock.calls.filter((call) => String(call[0]).includes("warmed off-thread")),
            ).toHaveLength(1);
        } finally {
            log.mockRestore();
        }
    });
});
