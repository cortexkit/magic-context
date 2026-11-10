import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../src/shared/test-temp-dir";
import { __test, analyzeOpenCodeCacheBustSession } from "./analyze-cache-busts";
import {
    classifyBustAfterReclaim,
    classifyCacheBust,
    isUnaccountedCacheBustClass,
} from "./cache-bust-attribution";
import { eventForWindow, groupBustWindows, loadSentinelState } from "./cache-bust-sentinel";

const roots: string[] = [];
const epoch = Date.parse("2026-09-04T10:00:00Z");
const sessionId = "ses_cacheScope";
const accountA = "sticky:vault:oauth:anthropic:alpha~001";
const accountB = "sticky:vault:oauth:anthropic:beta~002";
const user = (text: string) => ({
    role: "user",
    content: [{ type: "text", text, cache_control: { type: "ephemeral", ttl: "1h" } }],
});
const assistant = { role: "assistant", content: [{ type: "text", text: "reply" }] };

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const root = createTestTempDirFromPath(join(tmpdir(), "cache-scope-dumps-"));
    roots.push(root);
    function dump(
        index: number,
        options: {
            model?: string;
            route?: string;
            thread?: "create" | "continue";
            messages?: unknown[];
            read?: number;
            write?: number;
            reason?: { type: string; cache_missed_input_tokens: number };
        } = {},
    ) {
        const createdAt = new Date(epoch + index * 1000).toISOString();
        const route = options.route ?? accountA;
        const stem = `${createdAt.replace(/[:.]/g, "-")}-${index}-${sessionId}-${route.replaceAll(":", "-")}`;
        const body = join(root, `${stem}.body.json`);
        const response = join(root, `${stem}.response.json`);
        writeFileSync(
            body,
            JSON.stringify({
                model: options.model ?? "model-a",
                system: [
                    {
                        type: "text",
                        text: "system",
                        cache_control: { type: "ephemeral", ttl: "1h" },
                    },
                ],
                thread: { type: options.thread ?? "create" },
                messages: options.messages ?? [user("baseline")],
            }),
        );
        writeFileSync(
            response,
            JSON.stringify({
                message_id: `msg_${index}`,
                diagnostics: options.reason ? { cache_miss_reason: options.reason } : null,
                usage: {
                    input_tokens: 4,
                    cache_read_input_tokens: options.read ?? (index < 2 ? 100_000 : 0),
                    cache_creation_input_tokens: options.write ?? (index < 2 ? 0 : 100_000),
                },
            }),
        );
        writeFileSync(
            join(root, `${stem}.meta.json`),
            JSON.stringify({ session: sessionId, createdAt, route, files: { body, response } }),
        );
    }
    const snapshots = () =>
        __test.loadSnapshots(
            __test.parseArgs([
                "bun",
                "analyze-cache-busts.ts",
                "--session",
                sessionId,
                "--dir",
                root,
            ]),
        );
    const rows = () => __test.analyzeSnapshots(snapshots());
    const analysis = () =>
        analyzeOpenCodeCacheBustSession({
            sessionId,
            anthropicDir: root,
            openaiDir: join(root, "missing"),
            mcLogPath: null,
        });
    const cli = () =>
        Bun.spawnSync(
            [
                process.execPath,
                join(import.meta.dir, "analyze-cache-busts.ts"),
                "--source",
                "dumps",
                "--session",
                sessionId,
                "--dir",
                root,
                "--mc-log",
                join(root, "missing.log"),
                "--all-rows",
            ],
            { cwd: join(import.meta.dir, ".."), windowsHide: true },
        );
    return { root, dump, snapshots, rows, analysis, cli };
}

for (const reason of [undefined, { type: "model_changed", cache_missed_input_tokens: 266_275 }])
    test(`wire model change accounts the miss before thread evidence and expiry (reason=${Boolean(reason)})`, () => {
        const f = fixture();
        f.dump(0);
        f.dump(1, { thread: "continue", messages: [user("delta")] });
        f.dump(4000, {
            model: "model-b",
            messages: [user("baseline"), assistant, user("delta")],
            reason,
        });
        const row = f.rows()[2];
        expect(row.divergenceClass).toBe("cache_scope_changed");
        expect(row.comparisonNote).toContain("model model-a → model-b");
        expect(row.divergenceIndex).toBe(-1);
        expect(f.analysis().requests[2].firstDivergence).toContain("model model-a → model-b");
        if (reason) {
            expect(row.providerCacheMissReason).toEqual({
                type: "model_changed",
                cacheMissedInputTokens: 266_275,
            });
            expect(f.analysis().requests[2].providerCacheMissReason).toEqual(
                row.providerCacheMissReason,
            );
            const run = f.cli();
            expect(run.exitCode).toBe(0);
            expect(run.stdout.toString()).toContain("provider says: model_changed, 266,275 missed");
        }
    });

test("account change compares the preceding session request across account routes", () => {
    const f = fixture();
    f.dump(0, { route: accountA });
    f.dump(1, { route: accountA, thread: "continue", messages: [user("delta")] });
    f.dump(2, { route: accountB, messages: [user("baseline"), assistant, user("delta")] });
    expect(f.rows()[2].divergenceClass).toBe("cache_scope_changed");
    expect(f.rows()[2].comparisonNote).toContain("account alpha~001 → beta~002");
    expect(f.analysis().requests[2].firstDivergence).toContain("account alpha~001 → beta~002");
});

test("provider model_changed reason accounts a continuation without a visible model change", () => {
    const f = fixture();
    f.dump(0);
    f.dump(1, {
        thread: "continue",
        messages: [user("delta")],
        read: 50_000,
        write: 50_000,
        reason: { type: "model_changed", cache_missed_input_tokens: 12_345 },
    });
    expect(f.rows()[1].divergenceClass).toBe("cache_scope_changed");
    expect(f.rows()[1].providerCacheMissReason).toEqual({
        type: "model_changed",
        cacheMissedInputTokens: 12_345,
    });
    expect(
        classifyCacheBust({
            divergenceIndex: -1,
            previousMessageCount: 2,
            idleCacheExpiry: true,
            threadEvidence: "continuation_short_read",
            providerCacheMissReason: "model_changed",
        }),
    ).toBe("cache_scope_changed");
});

test("unknown provider reason is printed without reclassifying the thread finding", () => {
    const f = fixture();
    f.dump(0);
    f.dump(1, { thread: "continue", messages: [user("delta")] });
    f.dump(2, {
        messages: [user("baseline"), assistant, user("delta")],
        read: 50_000,
        write: 50_000,
        reason: { type: "provider_maintenance", cache_missed_input_tokens: 123_456 },
    });
    expect(f.rows()[2].divergenceClass).toBe("thread_break_unchanged_client_bytes");
    expect(f.rows()[2].providerCacheMissReason).toEqual({
        type: "provider_maintenance",
        cacheMissedInputTokens: 123_456,
    });
    const run = f.cli();
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("provider says: provider_maintenance, 123,456 missed");
});

test("zero read with the same model and account remains a provider full miss", () => {
    const f = fixture();
    f.dump(0);
    f.dump(2, { messages: [user("changed baseline")] });
    expect(f.rows()[1].divergenceClass).toBe("provider_full_miss");
    expect(f.rows()[1].providerCacheMissReason).toBeUndefined();
    const run = f.cli();
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).not.toContain("provider says:");
});

for (const tokens of [0, 19_999, 20_000, 10_000_000])
    test(`sentinel never wakes for cache_scope_changed at ${tokens} tokens`, () => {
        const f = fixture();
        const state = loadSentinelState(join(f.root, "state.json"));
        const row = {
            session: sessionId,
            timestampMs: epoch,
            at: new Date(epoch).toISOString(),
            verdict: "SHORT" as const,
            divergenceClass: "cache_scope_changed" as const,
            rewrittenTokens: tokens,
            firstDivergence: "account changed",
            analyzerCmd: "fixture",
        };
        expect(isUnaccountedCacheBustClass("cache_scope_changed", tokens)).toBe(false);
        expect(classifyBustAfterReclaim("accounted_hard_fold", "cache_scope_changed")).toBe(
            "cache_scope_changed",
        );
        expect(eventForWindow(groupBustWindows([row])[0], "fixture", state)).toBeNull();
    });

for (const kind of ["oc2", "pi"] as const)
    test(`${kind} scope detection uses the dumped wire model before idle expiry`, () => {
        const f = fixture();
        f.dump(0);
        f.dump(4000, { model: "model-b" });
        const dumps = f.snapshots();
        const snapshots = __test.runnerSnapshots(
            {
                kind,
                session: sessionId,
                files: [],
                requests: dumps.map((dump) => ({
                    id: dump.file,
                    at: dump.requestTimestampMs,
                    sequence: dump.sequence,
                    model: "host-alias",
                    provider: "anthropic",
                    usage: {
                        input: dump.usage!.input,
                        output: 10,
                        cacheRead: dump.usage!.cacheRead,
                        cacheWrite: dump.usage!.cacheCreation ?? 0,
                    },
                })),
            },
            dumps,
        );
        const row = __test.analyzeSnapshots(snapshots)[1];
        expect(row.current.wireModel).toBe("model-b");
        expect(row.divergenceClass).toBe("cache_scope_changed");
        expect(row.comparisonNote).toContain("model model-a → model-b");
    });

test("cache scope compares the preceding session request even when it was unmetered", () => {
    const f = fixture();
    f.dump(0);
    f.dump(1, { model: "model-b" });
    f.dump(2, { model: "model-b", messages: [user("changed baseline")] });
    const snapshots = f.snapshots();
    snapshots[1].usage = undefined;
    expect(__test.analyzeSnapshots(snapshots)[2].divergenceClass).toBe("provider_full_miss");
});
