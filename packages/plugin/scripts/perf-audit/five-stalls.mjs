import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __test as piTest } from "../../../pi-plugin/src/context-handler.ts";
import {
    createStallContext,
    createStallHost,
    OLD_LEGACY_MARKER_SQL,
    OLD_PI_OWNER_SQL,
    STALL_SESSION,
    stallMessageId,
} from "../../src/features/magic-context/__tests__/stall.fixture.ts";
import {
    closeCompactionMarkerDb,
    getPreparedCompactionMarkerSummaryIds,
    injectCompactionMarker,
    LEGACY_MARKER_LINEAGE_SQL,
    prepareCompactionMarkerCandidates,
} from "../../src/features/magic-context/compaction-marker.ts";
import {
    findPiFallbackToolOwnerTags,
    getAllStatusTagTokenTotalsFlat,
} from "../../src/features/magic-context/storage-tags.ts";
import { setHarness } from "../../src/shared/harness.ts";

const dir = join(tmpdir(), "magic-context", `five-stalls-${process.pid}`);
mkdirSync(dir, { recursive: true });
process.env.XDG_DATA_HOME = dir;
setHarness("opencode");
const count = 160000,
    parts = 500000;
const host = createStallHost(join(dir, "opencode", "opencode.db"), count, parts);
const context = createStallContext(join(dir, "context.db"), count);
const results = {
    runtime: process.versions,
    fixture: { directory: dir, messages: count, parts, tags: count * 3 + 6 },
    calls: [],
};
function measure(name, call) {
    const start = performance.now();
    const value = call();
    results.calls.push({ name, wall_ms: +(performance.now() - start).toFixed(3) });
    return value;
}
async function heartbeat(name, call) {
    let ticks = 0,
        maxGap = 0,
        previous = performance.now();
    const interval = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - previous);
        previous = now;
        ticks++;
    }, 5);
    await new Promise((resolve) => setTimeout(resolve, 10));
    ticks = 0;
    maxGap = 0;
    previous = performance.now();
    const start = performance.now();
    const value = await call();
    const wall = performance.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 10));
    clearInterval(interval);
    results.calls.push({
        name,
        wall_ms: +wall.toFixed(3),
        heartbeat_ticks: ticks,
        max_main_thread_gap_ms: +maxGap.toFixed(3),
    });
    return value;
}
try {
    // Invalid JSON is a reader fixture, not a valid marker candidate. The old writer rejects it.
    host.prepare("UPDATE message SET data='{}' WHERE json_valid(data)=0").run();
    const boundary = stallMessageId(count - 32),
        time = count - 32;
    for (const [index, id] of ["legacy-a", "legacy-b"].entries()) {
        host.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
            id,
            STALL_SESSION,
            time + index,
            time + index,
            JSON.stringify({
                role: "assistant",
                summary: true,
                finish: "stop",
                parentID: boundary,
            }),
        );
        host.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
            `${id}-part`,
            id,
            STALL_SESSION,
            time + index,
            time + index,
            JSON.stringify({ type: "text", text: "summary" }),
        );
    }
    const oldMarkers = measure("legacy marker select before", () =>
        host.prepare(OLD_LEGACY_MARKER_SQL).all(STALL_SESSION, "canonical", boundary, "summary"),
    );
    assert.equal(
        await heartbeat("marker summary discovery off-thread", () =>
            prepareCompactionMarkerCandidates(STALL_SESSION),
        ),
        true,
    );
    const basis = measure("marker candidate proof", () =>
        getPreparedCompactionMarkerSummaryIds(STALL_SESSION),
    );
    assert.deepEqual(
        measure("legacy marker select after", () =>
            host
                .prepare(LEGACY_MARKER_LINEAGE_SQL)
                .all(STALL_SESSION, JSON.stringify(basis), "canonical", boundary, "summary"),
        ),
        oldMarkers,
    );
    assert.ok(
        measure("marker write after", () =>
            injectCompactionMarker({
                sessionId: STALL_SESSION,
                endMessageId: boundary,
                endOrdinal: time + 1,
                summaryText: "summary",
                directory: dir,
                resolvedBoundary: { id: boundary, timeCreated: time },
            }),
        ),
    );
    for (const row of oldMarkers)
        assert.ok(host.prepare("SELECT id FROM message WHERE id=?").get(row.id) == null);
    const calibration = { proseRatio: 1.37, toolsRatio: 0.83 };
    const full = measure("token totals before", () =>
        getAllStatusTagTokenTotalsFlat(context, STALL_SESSION, 0, calibration),
    );
    const owners = Array.from({ length: 32 }, (_, i) => stallMessageId(count - 32 + i));
    const scoped = measure("token totals after", () =>
        getAllStatusTagTokenTotalsFlat(context, STALL_SESSION, 0, calibration, owners),
    );
    for (const owner of owners) {
        assert.equal(scoped.totals.get(owner), full.totals.get(owner));
        assert.equal(scoped.nullMessageIds.has(owner), full.nullMessageIds.has(owner));
    }
    const oldOwners = measure("Pi fallback owners before", () =>
        context.prepare(OLD_PI_OWNER_SQL).all(STALL_SESSION),
    );
    assert.deepEqual(
        measure("Pi fallback owners after", () =>
            findPiFallbackToolOwnerTags(context, STALL_SESSION),
        ),
        oldOwners,
    );
    const oldHeaders = measure(
        "Pi fingerprint headers before",
        () =>
            new Set(
                context
                    .prepare(
                        `SELECT DISTINCT entry_fingerprint FROM tags WHERE session_id=? AND type='message' AND entry_fingerprint IS NOT NULL AND message_id LIKE 'pi-msg-%'`,
                    )
                    .all(STALL_SESSION)
                    .map((row) => JSON.stringify(JSON.parse(row.entry_fingerprint).slice(0, 4))),
            ),
    );
    assert.deepEqual(
        measure("Pi fingerprint headers after", () =>
            piTest.readPiFallbackFingerprintHeaders(context, STALL_SESSION),
        ),
        oldHeaders,
    );
    console.log(JSON.stringify({ ...results, differential_checks: "all passed" }, null, 2));
} finally {
    closeCompactionMarkerDb();
    host.close();
    context.close();
}
