import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "../features/magic-context/compartment-storage";
import {
    insertMemory,
    setMemoryClassification,
    updateMemorySeenCount,
    updateMemoryVerification,
} from "../features/magic-context/memory/storage-memory";
import {
    recordIndexedMessageTime,
    recordMessageFtsRowid,
} from "../features/magic-context/message-fts-rowid-map";
import { runMigrations } from "../features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../features/magic-context/storage";
import { initializeDatabase } from "../features/magic-context/storage-db";
import { recoverUnresolvedCompartments } from "../features/magic-context/store-generation-rebase";
import { renderMemoryBlockV2 } from "../hooks/magic-context/inject-compartments";
import { estimateTokens } from "../hooks/magic-context/read-session-formatting";
import { Database } from "./sqlite";
import { createTestTempDirFromPath } from "./test-temp-dir";

export interface LockedDeltaFixture {
    db: Database;
    sibling: Database;
    directory: string;
    sessionId: string;
    projectPath: string;
    close: () => void;
}

export function createLockedDeltaFixture(
    label: string,
    open?: (path: string) => Database,
): LockedDeltaFixture {
    const directory = createTestTempDirFromPath(join(tmpdir(), `mc-locked-delta-${label}-`));
    const path = join(directory, "context.db");
    const db = open ? open(path) : new Database(path);
    if (!open) {
        initializeDatabase(db);
        runMigrations(db);
    }
    db.exec("PRAGMA journal_mode=WAL");
    const sibling = new Database(path);
    const sessionId = label;
    const projectPath = "git:locked-delta";
    getOrCreateSessionMeta(db, sessionId);
    return {
        db,
        sibling,
        directory,
        sessionId,
        projectPath,
        close: () => {
            sibling.close();
            db.close();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}
export interface LockedDeltaOptions {
    memoryBudget?: number;
    temporalAwareness?: boolean;
}
interface LockedDeltaDriver<Markers> {
    host: string;
    create: (label: string) => LockedDeltaFixture;
    materialize: (fixture: LockedDeltaFixture, options: LockedDeltaOptions) => Markers;
    refresh: (
        fixture: LockedDeltaFixture,
        options: LockedDeltaOptions,
        beforeAdmission: () => void,
    ) => void;
    render: (fixture: LockedDeltaFixture, options: LockedDeltaOptions, markers: Markers) => string;
    temporalHeadings?: boolean;
}
function compartment() {
    return {
        sequence: 0,
        startMessage: 1,
        endMessage: 2,
        startMessageId: "a",
        endMessageId: "b",
        title: "locked history",
        content: "locked history",
        p1: "locked history",
        p2: "summary",
        p3: "outcome",
        p4: "anchor",
        legacy: 0,
    };
}
function persistedDelta(f: LockedDeltaFixture): string {
    return getOrCreateSessionMeta(f.db, f.sessionId).cachedM1Bytes?.toString("utf8") ?? "";
}
function refreshAtAdmission<Markers>(
    driver: LockedDeltaDriver<Markers>,
    f: LockedDeltaFixture,
    options: LockedDeltaOptions,
    write: () => void,
) {
    let admissions = 0;
    let hooks = 0;
    const exec = f.db.exec.bind(f.db);
    f.db.exec = (sql) => {
        if (sql === "BEGIN IMMEDIATE") admissions++;
        return exec(sql);
    };
    try {
        driver.refresh(f, options, () => {
            expect(admissions).toBe(0);
            hooks++;
            write();
        });
        expect(hooks).toBe(1);
        expect(admissions).toBe(1);
    } finally {
        f.db.exec = exec;
    }
}

/** These fixtures use real sibling writes, then compare persisted bytes to an independent live render. */
export function registerLockedDeltaRegressions<Markers>(driver: LockedDeltaDriver<Markers>): void {
    for (const change of ["importance", "reinforcement", "verification"] as const) {
        test(`${driver.host} m[1] reads memory ${change} under its writer`, () => {
            const f = driver.create(`${driver.host}-${change}`);
            try {
                const sample = insertMemory(f.db, {
                    projectPath: "git:budget-only",
                    category: "ARCHITECTURE",
                    content: "candidate A ".repeat(40),
                });
                const options = {
                    memoryBudget:
                        4 * (estimateTokens(renderMemoryBlockV2([sample], "new-memories")) + 2),
                };
                const markers = driver.materialize(f, options);
                const a = insertMemory(f.db, {
                    projectPath: f.projectPath,
                    category: "ARCHITECTURE",
                    content: "candidate A ".repeat(40),
                });
                const b = insertMemory(f.db, {
                    projectPath: f.projectPath,
                    category: "ARCHITECTURE",
                    content: "candidate B ".repeat(40),
                });
                setMemoryClassification(f.db, a.id, { importance: 50 });
                setMemoryClassification(f.db, b.id, { importance: 50 });
                f.db
                    .prepare(
                        "UPDATE memories SET last_seen_at = CASE WHEN id = ? THEN 1000 ELSE 0 END, verified_at = NULL WHERE id IN (?, ?)",
                    )
                    .run(a.id, a.id, b.id);
                const before = driver.render(f, options, markers);
                expect(before).toContain("candidate A");
                expect(before).not.toContain("candidate B");
                refreshAtAdmission(driver, f, options, () => {
                    if (change === "importance")
                        setMemoryClassification(f.sibling, b.id, { importance: 100 });
                    else if (change === "reinforcement") updateMemorySeenCount(f.sibling, b.id);
                    else updateMemoryVerification(f.sibling, b.id, "verified");
                });
                const fresh = driver.render(f, options, markers);
                expect(fresh).toContain("candidate B");
                expect(fresh).not.toContain("candidate A");
                expect(persistedDelta(f)).toBe(fresh);
                expect(persistedDelta(f)).not.toBe(before);
            } finally {
                f.close();
            }
        });
    }

    test(`${driver.host} m[1] reads in-place recovered compartment ranges under its writer`, () => {
        const f = driver.create(`${driver.host}-ranges`);
        try {
            const options = {};
            const markers = driver.materialize(f, options);
            appendCompartments(f.db, f.sessionId, [compartment()]);
            f.db
                .prepare(
                    "UPDATE compartments SET rebase_status = 'unresolved' WHERE session_id = ?",
                )
                .run(f.sessionId);
            const before = driver.render(f, options, markers);
            expect(before).toContain("## 1-2");
            const revision = f.db
                .prepare("SELECT version FROM compartment_history_versions WHERE session_id = ?")
                .get(f.sessionId) as { version: number };
            refreshAtAdmission(driver, f, options, () => {
                const recovered = recoverUnresolvedCompartments({
                    db: f.sibling,
                    sessionId: f.sessionId,
                    resolveOrdinal: (id) => (id === "a" ? 3 : id === "b" ? 4 : undefined),
                    reason: "Recovered fixture anchors",
                });
                expect(recovered.rowsRewritten).toBe(1);
            });
            const updated = f.db
                .prepare("SELECT version FROM compartment_history_versions WHERE session_id = ?")
                .get(f.sessionId) as { version: number };
            expect(updated.version).toBeGreaterThan(revision.version);
            const fresh = driver.render(f, options, markers);
            expect(fresh).toContain("## 3-4");
            expect(fresh).not.toContain("## 1-2");
            expect(persistedDelta(f)).toBe(fresh);
        } finally {
            f.close();
        }
    });

    test(`${driver.host} m[1] uses the baseline cutoff for a newly expired additive memory`, () => {
        const f = driver.create(`${driver.host}-expiry`);
        const realNow = Date.now;
        let now = 1000;
        Date.now = () => now;
        try {
            const options = {};
            const markers = driver.materialize(f, options);
            now = 2000;
            const before = driver.render(f, options, markers);
            expect(before).not.toContain("eligible at the baseline cutoff");
            refreshAtAdmission(driver, f, options, () => {
                insertMemory(f.sibling, {
                    projectPath: f.projectPath,
                    category: "ARCHITECTURE",
                    content: "Memory eligible at the baseline cutoff",
                    expiresAt: 2500,
                });
                now = 3000;
            });
            const fresh = driver.render(f, options, markers);
            expect(fresh).toContain("eligible at the baseline cutoff");
            expect(persistedDelta(f)).toBe(fresh);
        } finally {
            Date.now = realNow;
            f.close();
        }
    });

    if (driver.temporalHeadings) {
        test(`${driver.host} m[1] reads indexed temporal headings under its writer`, () => {
            const f = driver.create(`${driver.host}-dates`);
            const originalXdgDataHome = process.env.XDG_DATA_HOME;
            process.env.XDG_DATA_HOME = f.directory;
            try {
                const options = { temporalAwareness: true };
                const markers = driver.materialize(f, options);
                appendCompartments(f.db, f.sessionId, [compartment()]);
                for (const ordinal of [1, 2])
                    recordMessageFtsRowid(f.db, f.sessionId, ordinal, ordinal);
                const before = driver.render(f, options, markers);
                expect(before).not.toContain("2025-01-01");
                refreshAtAdmission(driver, f, options, () => {
                    for (const ordinal of [1, 2])
                        recordIndexedMessageTime(
                            f.sibling,
                            f.sessionId,
                            ordinal,
                            Date.UTC(2025, 0, 1),
                        );
                });
                const fresh = driver.render(f, options, markers);
                expect(fresh).toContain("2025-01-01");
                expect(persistedDelta(f)).toBe(fresh);
            } finally {
                if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
                else process.env.XDG_DATA_HOME = originalXdgDataHome;
                f.close();
            }
        });
    }
}
