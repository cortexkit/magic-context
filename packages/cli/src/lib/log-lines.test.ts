import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import golden from "./__fixtures__/log_format_golden.json";
import opaqueMessages from "./__fixtures__/opaque-log-messages.json";

import {
    getMagicContextLogPaths,
    inspectLogFile,
    inspectMagicContextLogs,
    type LogLevel,
    logSpecAdmits,
    parseLogLine,
    readLogLines,
} from "./log-lines";
import { extractHistorianFailureLines } from "./logs-opencode";

it("reads message.updated identifiers as event fields", () => {
    const line =
        "[2026-09-05T10:41:03.130Z] [magic-context][ses_538] event message.updated: provider=mock model=test hasUsageTokens=true tokens.input=10 cache.read=2 cache.write=0 message.id=msg_538 session.id=ses_538";
    const record = parseLogLine(line);
    expect(record?.session).toBe("ses_538");
    expect(record?.message).toBe("event message.updated:");
    expect(record?.kv["message.id"]).toBe("msg_538");
    expect(record?.kv["session.id"]).toBe("ses_538");
});

/**
 * The writer removes complete CSI escape sequences (7-bit `ESC [` or the C1
 * byte 0x9b, parameters, intermediates, final byte) before rendering, so a
 * reader can never recover them. The fixture's `event` still holds the colored
 * input, so the expected record is the event with those sequences removed.
 * Lone ESC and other control characters are escaped, not removed, and round-trip.
 */
function stripCompleteCsi(value: string): string {
    const inRange = (char: string | undefined, low: number, high: number) =>
        char !== undefined && char.charCodeAt(0) >= low && char.charCodeAt(0) <= high;
    let out = "";
    let i = 0;
    while (i < value.length) {
        let j = -1;
        if (value[i] === "\u001b" && value[i + 1] === "[") j = i + 2;
        else if (value[i] === "\u009b") j = i + 1;
        if (j >= 0) {
            while (inRange(value[j], 0x30, 0x3f)) j++;
            while (inRange(value[j], 0x20, 0x2f)) j++;
            if (inRange(value[j], 0x40, 0x7e)) {
                i = j + 1;
                continue;
            }
        }
        out += value[i];
        i++;
    }
    return out;
}

const roots: string[] = [];
const original = {
    MAGIC_CONTEXT_LOG_PATH: process.env.MAGIC_CONTEXT_LOG_PATH,
    MAGIC_CONTEXT_STORAGE_DIR: process.env.MAGIC_CONTEXT_STORAGE_DIR,
    MAGIC_CONTEXT_TEST_DATA_DIR: process.env.MAGIC_CONTEXT_TEST_DATA_DIR,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseLogLine", () => {
    it("reads module store failures through the r2 envelope", () => {
        const parsed = parseLogLine(
            "2026-09-23T00:11:14.902Z ERROR magic-context: mc-module: store open failed: database locked",
        );
        expect(parsed?.grammar).toBe("fleet-r2");
        expect(parsed?.message).toBe("mc-module: store open failed: database locked");
    });

    it("reads historian lifecycle failures through the r2 envelope", () => {
        const parsed = parseLogLine(
            "2026-09-23T00:11:14.902Z ERROR magic-context: mc-module: historian firing failed for ses_a: timed out",
        );
        expect(parsed?.message).toBe("mc-module: historian firing failed for ses_a: timed out");
    });

    it("reads per-pass stage timing through the r2 envelope", () => {
        const parsed = parseLogLine(
            "2026-09-23T00:11:14.902Z INFO  magic-context.perf: mc-pass-stage session=ses_a stage=historian_inline_wait event=end outcome=ok elapsed_ms=12.3",
        );
        expect(parsed?.grammar).toBe("fleet-r2");
        expect(parsed?.logger).toBe("magic-context.perf");
        expect(parsed?.message).toBe("mc-pass-stage");
        expect(parsed?.kv.stage).toBe("historian_inline_wait");
    });

    it("reads module configuration warnings through the r2 envelope", () => {
        const parsed = parseLogLine(
            "2026-09-23T00:11:14.902Z WARN  magic-context: mc-module: config warning: invalid setting",
        );
        expect(parsed?.message).toBe("mc-module: config warning: invalid setting");
    });
    it("reads every render case of the authority fleet r2 fixture", () => {
        for (const fixture of golden.cases) {
            const bound: Record<string, string> = Object.fromEntries(fixture.event.bound);
            // The reader hands consumers the bare id: `session=` carries the
            // issuer so the id can be matched against a session store, and the
            // pickers that filter on it show the id alone.
            const session = bound.session
                ? bound.session.slice(bound.session.indexOf(":") + 1)
                : null;

            const { rawMessage, ...parsed } = parseLogLine(fixture.line)!;
            expect(typeof rawMessage).toBe("string");
            expect(parsed, fixture.name).toEqual({
                ts: new Date(fixture.event.at_ms).toISOString(),
                level: fixture.event.level.toUpperCase(),
                logger: fixture.event.logger,
                session,
                tags: fixture.event.logger.split(".").slice(1),
                bound,
                message: stripCompleteCsi(fixture.event.message),
                kv: Object.fromEntries(
                    fixture.event.fields.map(([key, value]) => [key, stripCompleteCsi(value)]),
                ),
                grammar: "fleet-r2",
            });
        }
    });

    it("admits or filters every CK_LOG case of the authority fixture", () => {
        for (const fixture of golden.level_filter.cases) {
            const level = fixture.level.toUpperCase() as LogLevel;
            expect(
                logSpecAdmits(fixture.spec, level, fixture.logger),
                `${fixture.spec || "<empty>"} @ ${fixture.level} ${fixture.logger}`,
            ).toBe(fixture.emit);
        }
    });

    it("retains opaque bodies even when no field or message escape grammar applies", () => {
        for (const body of [
            "",
            'invalid "',
            'invalid "  ',
            String.raw`invalid \q`,
            "status=failed",
            "failure \u001b[31m",
        ]) {
            for (const envelope of [
                "[2026-09-05T10:41:03.130Z] [magic-context][ses_opaque] ",
                "2026-09-05T10:41:03.130Z ERROR magic-context ",
            ]) {
                expect(parseLogLine(envelope + body)?.message).toBe(body);
            }
        }
    });

    // One event, written by the three producers a developer box can still have
    // on disk. Each line is the shape of exactly one grammar, and the reader
    // must not read any of them as another.
    const sameEvent = {
        r2: "2026-09-05T10:41:03.130Z WARN  magic-context.perf: [harness=opencode session=opencode:ses_00fc88222ffe] transform stage folded ms=412 retry=2",
        r1: "2026-09-05T10:41:03.130Z WARN  magic-context session=opencode:ses_00fc88222ffe tag=perf transform stage folded ms=412 retry=2",
        legacy: "[2026-09-05T10:41:03.130Z] [magic-context][ses_00fc88222ffe] transform stage folded ms=412 retry=2",
    };

    it("reads the r2 shape as r2 and nothing else", () => {
        expect(parseLogLine(sameEvent.r2)).toEqual({
            ts: "2026-09-05T10:41:03.130Z",
            level: "WARN",
            logger: "magic-context.perf",
            session: "ses_00fc88222ffe",
            tags: ["perf"],
            bound: { harness: "opencode", session: "opencode:ses_00fc88222ffe" },
            message: "transform stage folded",
            rawMessage: "transform stage folded ms=412 retry=2",
            kv: { ms: "412", retry: "2" },
            grammar: "fleet-r2",
        });
    });

    it("reads the r1 shape as r1 and nothing else", () => {
        expect(parseLogLine(sameEvent.r1)).toEqual({
            ts: "2026-09-05T10:41:03.130Z",
            level: "WARN",
            logger: "magic-context",
            session: "ses_00fc88222ffe",
            tags: ["perf"],
            bound: { session: "opencode:ses_00fc88222ffe" },
            message: "transform stage folded",
            rawMessage: "transform stage folded ms=412 retry=2",
            kv: { ms: "412", retry: "2" },
            grammar: "fleet-r1",
        });
    });

    it("reads the legacy bracketed shape as legacy and maps synthetic global to no session", () => {
        expect(parseLogLine(sameEvent.legacy)).toEqual({
            ts: "2026-09-05T10:41:03.130Z",
            level: null,
            logger: "magic-context",
            session: "ses_00fc88222ffe",
            tags: [],
            bound: {},
            message: "transform stage folded",
            rawMessage: "transform stage folded ms=412 retry=2",
            kv: { ms: "412", retry: "2" },
            grammar: "legacy",
        });
        expect(
            parseLogLine("[2026-09-05T10:41:03.130Z] [magic-context][global] maintenance completed")
                ?.session,
        ).toBeNull();
        expect(
            parseLogLine("[2026-09-05T10:41:03.130Z] [magic-context][] maintenance completed")
                ?.session,
        ).toBeNull();
    });

    it("maps one event written in all three grammars onto one record shape", () => {
        const records = [sameEvent.r2, sameEvent.r1, sameEvent.legacy].map(parseLogLine);
        expect(records.map((record) => record?.grammar)).toEqual([
            "fleet-r2",
            "fleet-r1",
            "legacy",
        ]);
        for (const record of records) {
            expect(record?.session).toBe("ses_00fc88222ffe");
            expect(record?.message).toBe("transform stage folded");
            expect(record?.kv).toEqual({ ms: "412", retry: "2" });
        }
        // What r1 wrote as `tag=perf` is r2's logger component; the legacy
        // grammar had no way to express it at all.
        expect(records.map((record) => record?.tags)).toEqual([["perf"], ["perf"], []]);
    });

    for (const fixture of opaqueMessages) {
        it(`retains ${fixture.name} in historian failure extraction`, async () => {
            let line = fixture.line;
            if (fixture.name.startsWith("legacy")) {
                const root = createTestTempDirFromPath(join(tmpdir(), "mc-opaque-log-"));
                roots.push(root);
                const logPath = join(root, "writer.log");
                const loggerPath = resolve(import.meta.dir, "../../../plugin/src/shared/logger.ts");
                const body = fixture.line.slice(
                    fixture.line.indexOf("] ", fixture.line.indexOf("[magic-context]")) + 2,
                );
                const child = Bun.spawn(
                    [
                        process.execPath,
                        "-e",
                        `const {sessionLog, flushLogger} = await import(${JSON.stringify(loggerPath)});
                     Date.prototype.toISOString = () => "2026-09-05T10:41:03.130Z";
                     sessionLog("ses_opaque", ${JSON.stringify(body)}); flushLogger();`,
                    ],
                    {
                        windowsHide: true,
                        env: {
                            ...process.env,
                            NODE_ENV: "development",
                            MAGIC_CONTEXT_LOG_PATH: logPath,
                        },
                        stdout: "pipe",
                        stderr: "pipe",
                    },
                );
                const stderr = await new Response(child.stderr).text();
                expect(await child.exited, stderr).toBe(0);
                line = readFileSync(logPath, "utf8").trimEnd();
                expect(line).toBe(fixture.line);
            }
            expect(extractHistorianFailureLines(line)).toEqual([line]);
            const parsed = parseLogLine(line);
            expect(parsed?.message).toBe(fixture.message);
            expect(parsed?.kv).toEqual(
                fixture.name.endsWith("before-fields") ? { "cache.read": "5" } : {},
            );
        });
    }

    it("rejects wrong-grammar lines instead of silently splitting them", () => {
        expect(
            parseLogLine(
                "2026-09-05T10:41:03.130Z WARN magic-context session=opencode:ses_bad transform failed: boom",
            ),
        ).toBeNull();
        expect(parseLogLine("[2026-09-05T10:41:03.130Z] unrelated text")).toBeNull();
        for (const rejected of golden.parse_rejects) {
            expect(parseLogLine(rejected.line), rejected.name).toBeNull();
        }
    });
});

describe("log path discovery", () => {
    it("enumerates an override, legacy harness path, fleet lane, and module log", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-log-paths-"));
        roots.push(root);
        process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
        process.env.XDG_DATA_HOME = root;
        process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "override.log");

        expect(getMagicContextLogPaths("omp")).toEqual([
            join(root, "override.log"),
            join(tmpdir(), "omp", "magic-context", "magic-context.log"),
            join(root, "cortexkit", "magic-context", "logs", "magic-context.omp.log"),
            join(root, "cortexkit", "magic-context", "logs", "magic-context.log"),
        ]);
    });

    it("discovers a fleet log when no legacy file exists", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-log-new-only-"));
        roots.push(root);
        const fleetPath = join(root, "storage", "logs", "magic-context.pi.log");
        mkdirSync(join(root, "storage", "logs"), { recursive: true });
        writeFileSync(
            fleetPath,
            "2026-09-05T10:41:03.000Z INFO  magic-context fleet-only message\n",
        );

        const files = inspectMagicContextLogs("pi", {
            tempDir: root,
            storageDir: join(root, "storage"),
            override: null,
        });
        expect(files.find((file) => file.exists)).toMatchObject({
            path: fleetPath,
            grammar: "fleet-r1",
            lineCount: 1,
        });
    });

    it("reports grammar and line count and merges existing files chronologically", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-log-read-"));
        roots.push(root);
        const legacy = join(root, "legacy.log");
        const fleetR1 = join(root, "fleet-r1.log");
        const fleetR2 = join(root, "fleet-r2.log");
        writeFileSync(
            legacy,
            "[2026-09-05T10:41:04.000Z] [magic-context][global] legacy message\n",
        );
        writeFileSync(fleetR1, "2026-09-05T10:41:03.000Z INFO  magic-context fleet message\n");
        writeFileSync(
            fleetR2,
            "2026-09-05T10:41:02.000Z INFO  magic-context.transform: r2 message ms=3\n",
        );

        const legacyInfo = inspectLogFile(legacy);
        const fleetR1Info = inspectLogFile(fleetR1);
        const fleetR2Info = inspectLogFile(fleetR2);
        expect(legacyInfo).toMatchObject({ exists: true, lineCount: 1, grammar: "legacy" });
        expect(fleetR1Info).toMatchObject({ exists: true, lineCount: 1, grammar: "fleet-r1" });
        expect(fleetR2Info).toMatchObject({ exists: true, lineCount: 1, grammar: "fleet-r2" });
        expect(readLogLines([legacyInfo, fleetR1Info, fleetR2Info])).toEqual([
            "2026-09-05T10:41:02.000Z INFO  magic-context.transform: r2 message ms=3",
            "2026-09-05T10:41:03.000Z INFO  magic-context fleet message",
            "[2026-09-05T10:41:04.000Z] [magic-context][global] legacy message",
        ]);
    });

    it("resolves no dated segment, which is why the writer-side fixture sections are inert", () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-log-segments-"));
        roots.push(root);

        // `segment_name` and `retention_prune` pin the WRITER: which file a
        // module opens for today's UTC day and which old segments it unlinks by
        // filename. magic-context still writes one `magic-context.log` rotated
        // to `.1` (packages/plugin/src/shared/logger.ts) and the doctor reads no
        // daemon log, so no reader here resolves or prunes a dated segment.
        const dated = /\.\d{4}-\d{2}-\d{2}\.log$/;
        for (const path of getMagicContextLogPaths("opencode", {
            tempDir: root,
            storageDir: join(root, "storage"),
            override: null,
        })) {
            expect(path, path).not.toMatch(dated);
        }
    });
});
