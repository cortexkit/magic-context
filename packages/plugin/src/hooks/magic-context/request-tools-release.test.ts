/// <reference types="bun-types" />

import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    type RequestTool,
    requestToolSchemaDigest,
    requestToolsFingerprint,
} from "../../features/magic-context/request-tool-definitions";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import * as loggerModule from "../../shared/logger";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { evaluateRequestToolsRelease } from "./request-tools-release";

const roots: string[] = [];
afterEach(() => {
    closeDatabase();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function database() {
    const parent = join(tmpdir(), "magic-context", "request-tools-release");
    mkdirSync(parent, { recursive: true });
    const root = createTestTempDirFromPath(join(parent, "db-"));
    roots.push(root);
    const db = openDatabase(join(root, "context.db"));
    if (!db) throw new Error("throwaway database unavailable");
    getOrCreateSessionMeta(db, "ses");
    return db;
}

const fingerprint = (...tools: Array<[string, string, unknown]>) =>
    requestToolsFingerprint(
        tools.map(
            ([name, description, schema]): RequestTool => ({
                name,
                description,
                schemaDigest: requestToolSchemaDigest(schema),
            }),
        ),
    );

const READ = fingerprint(["read", "Read", { type: "object" }]);
const MODEL = "anthropic/claude-fable-5-2";

test("adopts silently on the first pass and on another model, then releases on a change", () => {
    const db = database();
    const logs = spyOn(loggerModule, "sessionLog").mockImplementation(() => {});
    try {
        const evaluate = (fp: typeof READ, modelKey = MODEL) => {
            const release = evaluateRequestToolsRelease({
                db,
                sessionId: "ses",
                modelKey,
                fingerprint: fp,
            });
            release.commit();
            return release.change;
        };
        expect(evaluate(READ)).toBeNull();
        expect(evaluate(READ)).toBeNull();
        expect(evaluate(fingerprint(["read", "Read", { type: "object", required: [] }]))).toBe(
            "schemas",
        );
        // The changed list is now the one compared with.
        expect(
            evaluate(fingerprint(["read", "Read", { type: "object", required: [] }])),
        ).toBeNull();
        expect(evaluate(fingerprint(["read", "Read a file", { type: "object" }]))).toBe(
            "descriptions",
        );
        expect(
            evaluate(
                fingerprint(["read", "Read a file", { type: "object" }], ["grep", "Grep", {}]),
            ),
        ).toBe("names");
        // A model switch has its own handling: the other model's list is adopted.
        expect(evaluate(READ, "anthropic/claude-opus-5-5")).toBeNull();
        expect(evaluate(READ, "anthropic/claude-opus-5-5")).toBeNull();
        const lines = logs.mock.calls.map((call) => String(call[1]));
        expect(lines.filter((line) => line.startsWith("request tools changed"))).toEqual([
            expect.stringContaining("kind=schema-only"),
            expect.stringContaining("kind=descriptions"),
            expect.stringContaining("kind=names"),
        ]);
        expect(
            lines.filter((line) => line.startsWith("request tools fingerprint adopted")),
        ).toHaveLength(2);
    } finally {
        logs.mockRestore();
        closeQuietly(db);
    }
});

test("a pass that never commits is evaluated again", () => {
    const db = database();
    try {
        const changed = fingerprint(["read", "Read", { type: "object", required: [] }]);
        evaluateRequestToolsRelease({
            db,
            sessionId: "ses",
            modelKey: MODEL,
            fingerprint: READ,
        }).commit();
        const failed = evaluateRequestToolsRelease({
            db,
            sessionId: "ses",
            modelKey: MODEL,
            fingerprint: changed,
        });
        expect(failed.change).toBe("schemas");
        // No commit: the pass failed before persisting its strip.
        expect(
            evaluateRequestToolsRelease({
                db,
                sessionId: "ses",
                modelKey: MODEL,
                fingerprint: changed,
            }).change,
        ).toBe("schemas");
    } finally {
        closeQuietly(db);
    }
});
