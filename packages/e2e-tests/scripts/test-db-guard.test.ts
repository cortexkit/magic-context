import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createE2ETempDir } from "../src/temp-dir";
import { openTestDb } from "../src/test-db";
import { databaseOpenViolations } from "./test-db-guard";

test("e2e SQLite handles use openTestDb or immediately set their own longer timeout", async () => {
    const root = resolve(import.meta.dir, "..");
    const violations: string[] = [];
    let scanned = 0;
    for (const directory of ["src", "tests"]) {
        const files = await readdir(resolve(root, directory), { recursive: true });
        for (const file of files.sort()) {
            if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
            const path = `${directory}/${file}`;
            violations.push(
                ...databaseOpenViolations(path, await readFile(resolve(root, path), "utf8")),
            );
            scanned++;
        }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(violations, violations.join("\n")).toEqual([]);
});

test("the guard reports named, renamed, default and namespace SQLite constructors with line numbers", () => {
    const source = [
        'import { Database as Sqlite } from "bun:sqlite";',
        'import Database from "bun:sqlite";',
        'import * as sqlite from "bun:sqlite";',
        'const a = new Sqlite(":memory:");',
        'const b = new Database(":memory:");',
        'const c = new sqlite.Database(":memory:");',
    ].join("\n");
    const violations = databaseOpenViolations("tests/example.test.ts", source);
    expect(violations).toHaveLength(3);
    for (const [index, violation] of violations.entries()) {
        expect(violation).toContain(`tests/example.test.ts:${index + 4}: use openTestDb`);
    }
});

test("only an allowlisted handle's first use may set its longer timeout", () => {
    const path = "src/rust-harness.ts";
    const prefix = 'import { Database } from "bun:sqlite";\nconst db = new Database(":memory:");\n';
    expect(
        databaseOpenViolations(
            path,
            `${prefix}try { db.exec("PRAGMA busy_timeout=30000"); db.query("SELECT 1"); } finally { db.close(); }`,
        ),
    ).toEqual([]);
    for (const suffix of [
        'const other = new Database(":memory:"); other.exec("PRAGMA busy_timeout=30000"); db.query("SELECT 1");',
        'db.query("SELECT 1"); db.exec("PRAGMA busy_timeout=30000");',
        'db.exec("PRAGMA busy_timeout=0");',
        'db.exec("PRAGMA busy_timeout=5000");',
        'const later = () => db.exec("PRAGMA busy_timeout=30000"); db.query("SELECT 1");',
        'if (false) db.exec("PRAGMA busy_timeout=30000"); db.query("SELECT 1");',
        "db.close();",
    ]) {
        expect(databaseOpenViolations(path, prefix + suffix).length).toBeGreaterThan(0);
    }
    expect(
        databaseOpenViolations(
            "tests/not-allowlisted.test.ts",
            `${prefix}db.exec("PRAGMA busy_timeout=30000");`,
        ),
    ).toHaveLength(1);
});

test("the helper, generated extension source, comments and unrelated Database classes are not violations", () => {
    expect(
        databaseOpenViolations(
            "src/test-db.ts",
            'import { Database } from "bun:sqlite"; new Database(":memory:");',
        ),
    ).toEqual([]);
    expect(
        databaseOpenViolations(
            "tests/example.test.ts",
            [
                'import { Database } from "bun:sqlite";',
                '// new Database(":memory:")',
                'const extension = `import { Database } from "bun:sqlite"; const db = new Database(":memory:");`;',
                'const db = openTestDb(":memory:");',
            ].join("\n"),
        ),
    ).toEqual([]);
    expect(
        databaseOpenViolations(
            "tests/example.test.ts",
            'import { Database } from "other-module"; new Database();',
        ),
    ).toEqual([]);
});

test("openTestDb preserves constructor options and sets a five-second busy timeout", () => {
    const path = resolve(createE2ETempDir("test-db-options-"), "context.db");
    const writer = openTestDb(path, { create: true, readwrite: true, strict: true });
    try {
        expect(writer.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
        writer.exec("CREATE TABLE sample (value TEXT)");
        expect(writer.query("SELECT $value AS value").get({ value: 42 })).toEqual({ value: 42 });
    } finally {
        writer.close();
    }
    const reader = openTestDb(path, { readonly: true, create: false });
    try {
        expect(reader.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
        expect(() => reader.exec("INSERT INTO sample VALUES ('write')")).toThrow();
    } finally {
        reader.close();
    }
    expect(() => openTestDb(`${path}.missing`, { create: false })).toThrow();
    const integers = openTestDb(":memory:", { safeIntegers: true });
    try {
        expect(integers.query("SELECT 9007199254740993 AS value").get()).toEqual({
            value: 9007199254740993n,
        });
    } finally {
        integers.close();
    }
});
