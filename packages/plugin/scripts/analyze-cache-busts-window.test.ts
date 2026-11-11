import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../src/shared/test-temp-dir";
import { __test, analyzeOpenCodeCacheBustSession } from "./analyze-cache-busts";
import type { CacheBustDecisionAttribution } from "./cache-bust-attribution";

const directories: string[] = [];
const epoch = Date.parse("2026-09-04T10:00:00Z");
const sessionId = "ses_bodywindow";

function directory(): string {
    const root = createTestTempDirFromPath(join(tmpdir(), "oc-window-bodies-"));
    directories.push(root);
    return root;
}

afterEach(() => {
    for (const root of directories.splice(0))
        fs.rmSync(root, { recursive: true, force: true });
});

function dump(root: string, index: number, at: number, legacy = false): string {
    const createdAt = new Date(at).toISOString();
    const stem = legacy
        ? `legacy-${index}`
        : `${createdAt.replace(/[:.]/g, "-")}-${index}-${sessionId}`;
    const body = join(root, `${stem}.body.json`);
    const response = join(root, `${stem}.response.json`);
    fs.writeFileSync(
        body,
        JSON.stringify({
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `request ${index}`,
                            cache_control: { type: "ephemeral" },
                        },
                    ],
                },
            ],
        }),
    );
    fs.writeFileSync(
        response,
        JSON.stringify({
            usage: {
                input_tokens: 100,
                cache_read_input_tokens: index < 100 ? 10_000 : 500,
                cache_creation_input_tokens: 100,
            },
        }),
    );
    fs.writeFileSync(
        join(root, `${stem}.meta.json`),
        JSON.stringify({
            session: sessionId,
            createdAt,
            step: index,
            files: { body, response },
        }),
    );
    return body;
}

test("OpenCode no-deadline windows match full loads without opening old or future bodies", () => {
    const root = directory();
    const old: string[] = [];
    for (let index = 0; index < 100; index += 1)
        old.push(dump(root, index, epoch - (101 - index) * 3_600_000));
    const warmup = [
        dump(root, 100, epoch - 120_000, true),
        dump(root, 101, epoch - 60_000),
    ];
    const broken = dump(root, 102, epoch - 30_000);
    fs.writeFileSync(broken, "{partial");
    const inside = [dump(root, 103, epoch), dump(root, 104, epoch + 60_000)];
    const future = dump(root, 105, epoch + 120_000);
    const args = __test.parseArgs([
        "bun",
        "analyze-cache-busts.ts",
        "--session",
        sessionId,
        "--dir",
        root,
    ]);
    args.sources[0].provider = "anthropic";
    args.sources[0].label = "anthropic-auth";
    const all = __test.loadSnapshots(args);
    const snapshots = all.filter(
        (snapshot) => Date.parse(snapshot.createdAt) <= epoch + 60_000,
    );
    const first = snapshots.findIndex(
        (snapshot) => Date.parse(snapshot.createdAt) > epoch - 1,
    );
    const rows = __test.analyzeSnapshots(snapshots.slice(first - 2), [], {
        precedingRequestTimestampsMs: snapshots
            .slice(0, first - 2)
            .map((snapshot) => snapshot.requestTimestampMs),
    });
    const expected = rows
        .filter((row) => Date.parse(row.current.createdAt) > epoch - 1)
        .map((row) => {
            if (
                row.verdict === "EXPIRED" ||
                row.verdict === "PLAN_CHANGED" ||
                row.verdict === "PROVIDER_FORGOT" ||
                row.verdict === "SCOPE_CHANGED" ||
                row.verdict === "VIEW" ||
                row.verdict === "UNEXPLAINED (no bytes)"
            ) {
                throw new Error(
                    "A request-dump fixture cannot produce runner-only verdicts",
                );
            }
            const segment =
                row.divergenceIndex < 0
                    ? undefined
                    : (row.current.segments[row.divergenceIndex] ??
                      row.previous?.segments[row.divergenceIndex]);
            return {
                session: row.current.session,
                at: row.current.createdAt,
                timestampMs: Date.parse(row.current.createdAt),
                verdict: row.verdict,
                rewrittenTokens: row.rewrittenTokens,
                divergenceClass: row.divergenceClass,
                firstDivergence:
                    row.verdict === "BASE"
                        ? "(first request)"
                        : (segment?.id ?? "(identical normalized prefix)"),
            };
        });
    const read = spyOn(fs, "readFileSync");
    try {
        const analysis = analyzeOpenCodeCacheBustSession({
            sessionId,
            anthropicDir: root,
            openaiDir: join(root, "missing"),
            mcLogPath: join(root, "missing.log"),
            decisions: [],
            sinceExclusiveMs: epoch - 1,
            untilInclusiveMs: epoch + 60_000,
        });
        expect(
            analysis.requests.map(
                ({ analyzerCmd: _command, ...request }) => request,
            ),
        ).toEqual(expected);
        expect(analysis.requests).toHaveLength(2);
        const bodyReads = read.mock.calls
            .map(([path]) => String(path))
            .filter((path) => path.endsWith(".body.json"));
        expect(bodyReads.sort()).toEqual([...warmup, broken, ...inside].sort());
        expect(
            bodyReads.some((path) => old.includes(path) || path === future),
        ).toBe(false);
    } finally {
        read.mockRestore();
    }
});

test("OpenCode empty windows open no body and unbounded calls still retain full history", () => {
    const root = directory();
    for (let index = 0; index < 5; index += 1)
        dump(root, index, epoch + index * 60_000);
    const options = {
        sessionId,
        anthropicDir: root,
        openaiDir: join(root, "missing"),
        mcLogPath: join(root, "missing.log"),
        decisions: [],
    };
    const read = spyOn(fs, "readFileSync");
    try {
        expect(
            analyzeOpenCodeCacheBustSession({
                ...options,
                sinceExclusiveMs: epoch + 86_400_000,
            }).requests,
        ).toEqual([]);
        expect(
            read.mock.calls.filter(([path]) =>
                String(path).endsWith(".body.json"),
            ),
        ).toHaveLength(0);
    } finally {
        read.mockRestore();
    }
    expect(analyzeOpenCodeCacheBustSession(options).requests).toHaveLength(5);
});

test("OpenCode predecessor pass claims ignore corrupt bodies in the bounded join band", () => {
    const root = directory();
    for (let index = 0; index < 5; index += 1) {
        const body = dump(root, index, epoch + (index - 4) * 60_000);
        if (index === 1) fs.writeFileSync(body, "{partial");
    }
    const decisions: CacheBustDecisionAttribution[] = Array.from(
        { length: 5 },
        (_, index) => ({
            timestampMs: epoch - 290_000 + index * 1000,
            decision: "defer",
            materialized: false,
            materializeReason: null,
            emergency: false,
            droppedTokens: 0,
            droppedCount: 0,
            inputTokens: 1000,
            flush: false,
            source: "synthetic",
            identityDelta: [`pass-${index}`],
        }),
    );
    const args = __test.parseArgs([
        "bun",
        "analyze-cache-busts.ts",
        "--session",
        sessionId,
        "--dir",
        root,
    ]);
    args.sources[0].provider = "anthropic";
    args.sources[0].label = "anthropic-auth";
    const snapshots = __test.loadSnapshots(args);
    const rows = __test.analyzeSnapshots(snapshots.slice(-3), decisions, {
        precedingRequestTimestampsMs: snapshots
            .slice(0, -3)
            .map((snapshot) => snapshot.requestTimestampMs),
    });
    const analysis = analyzeOpenCodeCacheBustSession({
        sessionId,
        anthropicDir: root,
        openaiDir: join(root, "missing"),
        mcLogPath: join(root, "missing.log"),
        decisions,
        sinceExclusiveMs: epoch - 1,
        untilInclusiveMs: epoch,
    });
    expect(analysis.requests).toHaveLength(1);
    expect(analysis.requests[0].identityDelta).toEqual(
        rows.at(-1)?.decision?.identityDelta,
    );
    expect(analysis.requests[0].identityDelta).toEqual(["pass-1"]);
});
