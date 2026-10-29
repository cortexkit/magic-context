import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { macCredentialSource } from "../two-pass-activation-runs/container-launcher";
import configJSON from "./deepseek.json";
import { mockCases, mockReply, mockServer } from "./mock";
import { memoryDrafts, request, turnOne, turnTwo } from "./prompts";
import { cost, DeepSeek, Ledger, logger, parseUsage, retryDelay, sanitizer } from "./provider";
import { mechanicalClaim } from "./report";
import { type Config, runTrial, validateConfig } from "./run";
import { transcript } from "./transcript";

const config = configJSON as Config;
const prices = config.peakUSDPerMillion;
const fixtures = mockCases(config.caseIds);
const first = turnOne(fixtures[0]);
function scratch() {
    const parent = resolve("target/scratch");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "small-trial-"));
    return { dir: join(root, "run"), close: () => rmSync(root, { recursive: true, force: true }) };
}
describe("direct DeepSeek small trial", () => {
    test("both turns preserve exact conversation, capture usage, costs, report and serialize all five cases", async () => {
        const tmp = scratch(),
            server = mockServer({ delayMs: 2 });
        const logs: string[] = [];
        try {
            const cases = fixtures.map((c) => ({
                ...c,
                userPrompt: `<session_references>recorded-input-must-stay-private</session_references>\n\n${c.userPrompt}`,
            }));
            const result = await runTrial({
                config,
                cases,
                material: "mock-key",
                mode: "mock",
                outputDir: tmp.dir,
                mockEndpoint: server.url,
                emit: (text) => logs.push(text),
            });
            expect(result.failure).toBeUndefined();
            expect(result.cases.every((c) => !c.failure && c.drafts?.length === 1)).toBe(true);
            expect(server.requests).toHaveLength(10);
            expect(server.maxActive).toBe(1);
            for (let i = 0; i < 10; i += 2) {
                expect(server.requests[i].messages).toHaveLength(2);
                expect(server.requests[i + 1].messages.slice(0, 2)).toEqual(
                    server.requests[i].messages,
                );
                expect(server.requests[i + 1].messages[2]).toEqual({
                    role: "assistant",
                    content: result.cases[i / 2].firstReply!,
                });
                expect(server.requests[i + 1].messages[3].content).toContain(
                    "## Fact 1 [CONSTRAINTS]",
                );
            }
            expect(result.attempts.reduce((sum, row) => sum + row.costCeilingUSD!, 0)).toBeCloseTo(
                0.0005295,
                10,
            );
            const md = readFileSync(join(tmp.dir, "review.md"), "utf8");
            expect(md).toContain("75.00% (750/1000 input tokens)");
            expect(md).toContain("CAPTURED?");
            expect(md).toContain("[CONSTRAINTS]");
            expect(md).toContain("Mechanical first pass");
            expect(result.attempts[0].raw).toBe(JSON.stringify(mockReply(first)));
            expect(result.attempts.every((r) => r.latencyMs! >= 0)).toBe(true);
            expect(
                readFileSync(join(tmp.dir, "run.json"), "utf8") + md + logs.join(""),
            ).not.toContain("mock-key");
            expect(readFileSync(join(tmp.dir, "run.json"), "utf8") + md).not.toContain(
                "recorded-input-must-stay-private",
            );
            for (const record of result.cases) {
                const saved = readFileSync(
                    join(tmp.dir, `transcript-case-${record.caseId}.md`),
                    "utf8",
                );
                expect(saved).toBe(
                    transcript({
                        ...record,
                        providerReplies: result.attempts
                            .filter((row) => row.caseId === record.caseId)
                            .map((row) => ({
                                turn: row.turn,
                                attempt: row.attempt,
                                raw: row.raw ?? "",
                            })),
                    }),
                );
                expect(saved).toContain("recorded-input-must-stay-private");
                expect(saved).toContain(record.secondRequest!.messages[3].content);
                expect(saved).toContain(record.secondReply!);
                expect(saved).toContain('"check":"Stated by the user in message 1."');
                for (const req of [record.firstRequest, record.secondRequest!]) {
                    for (const message of req.messages) expect(saved).toContain(message.content);
                }
                for (const row of result.attempts.filter((row) => row.caseId === record.caseId))
                    expect(saved).toContain(row.raw!);
            }
            expect(
                JSON.parse(readFileSync(join(tmp.dir, "run.json"), "utf8")).cases[0].checks,
            ).toEqual([{ factId: 1, check: "Stated by the user in message 1." }]);
        } finally {
            server.stop();
            tmp.close();
        }
    });
    test("thinking is independently trial-configurable per turn with disabled defaults", async () => {
        const c = fixtures[0];
        const first = turnOne(c);
        const firstEnabled = turnOne(c, "enabled");
        expect(first).toEqual(turnOne(c, "disabled"));
        expect(JSON.stringify(first)).toBe(JSON.stringify(request(first.messages)));
        expect(firstEnabled.thinking).toEqual({ type: "enabled" });
        expect(firstEnabled.max_tokens).toBe(64000);
        expect({ ...firstEnabled, thinking: first.thinking, max_tokens: first.max_tokens }).toEqual(
            first,
        );
        const reply = mockReply(first).choices[0].message.content;
        const production = await turnTwo(c, first, reply);
        const thinking = await turnTwo(c, first, reply, "enabled");
        expect(first.thinking).toEqual({ type: "disabled" });
        expect(production.request.thinking).toEqual({ type: "disabled" });
        expect(thinking.request.thinking).toEqual({ type: "enabled" });
        expect(thinking.request.max_tokens).toBe(64000);
        expect(production.request.max_tokens).toBe(32000);
        expect(thinking.request.messages).toEqual(production.request.messages);
        const both = await turnTwo(c, firstEnabled, reply, "enabled");
        expect(both.request.thinking).toEqual({ type: "enabled" });
        expect(both.request.messages.slice(0, 2)).toEqual(firstEnabled.messages);
        expect(() => validateConfig({ ...config, turnTwoThinking: "other" as "enabled" })).toThrow(
            "invalid_trial_config",
        );
        expect(() => validateConfig({ ...config, turnOneThinking: "other" as "enabled" })).toThrow(
            "invalid_trial_config",
        );
    });
    test("runner applies turn-one thinking without implicitly enabling turn two", async () => {
        const tmp = scratch(),
            server = mockServer();
        try {
            const result = await runTrial({
                config: { ...config, turnOneThinking: "enabled" },
                cases: fixtures,
                material: "mock-key",
                mode: "mock",
                outputDir: tmp.dir,
                mockEndpoint: server.url,
                emit() {},
            });
            expect(result.failure).toBeUndefined();
            expect(server.requests).toHaveLength(10);
            for (let index = 0; index < server.requests.length; index++)
                expect(server.requests[index].thinking).toEqual({
                    type: index % 2 === 0 ? "enabled" : "disabled",
                });
        } finally {
            server.stop();
            tmp.close();
        }
    });
    test("cap refusal happens before HTTP dispatch and survives in report", async () => {
        const tmp = scratch(),
            server = mockServer();
        try {
            const result = await runTrial({
                config: { ...config, maxSpendUSD: 0.000001 },
                cases: fixtures,
                material: "mock-key",
                mode: "mock",
                outputDir: tmp.dir,
                mockEndpoint: server.url,
                emit() {},
            });
            expect(result.failure).toBe("spend_cap_refused");
            expect(server.requests).toHaveLength(0);
            expect(result.attempts).toHaveLength(0);
            expect(readFileSync(join(tmp.dir, "review.md"), "utf8")).toContain("spend_cap_refused");
            expect(readFileSync(join(tmp.dir, "review.md"), "utf8")).toContain("NOT ASSESSED");
        } finally {
            server.stop();
            tmp.close();
        }
    });
    test("429 honors retry-after, reserves every attempt, and has at most two retries", async () => {
        const server = mockServer({ statuses: [429, 429, 429, 200], retryAfter: "2" });
        const ledger = new Ledger(2, prices, () => {}),
            waits: number[] = [];
        const client = new DeepSeek({
            endpoint: server.url,
            material: "mock-key",
            ledger,
            save() {},
            log() {},
            sleep: async (ms) => {
                waits.push(ms);
            },
        });
        try {
            await expect(client.send(first, 0, 1)).rejects.toThrow("credential_rate_limited");
            expect(waits).toEqual([2000, 2000]);
            expect(server.requests).toHaveLength(3);
            expect(ledger.rows).toHaveLength(3);
            expect(ledger.committedUSD).toBeGreaterThan(0.1);
            await expect(client.send(first, 0, 1)).rejects.toThrow("client_stopped");
        } finally {
            server.stop();
        }
    });
    test("429 recovers and continues both turns without reordering", async () => {
        const tmp = scratch(),
            server = mockServer({ statuses: [429, 200] });
        try {
            const result = await runTrial({
                config,
                cases: fixtures,
                material: "mock-key",
                mode: "mock",
                outputDir: tmp.dir,
                mockEndpoint: server.url,
                emit() {},
                sleep: async () => {},
            });
            expect(result.failure).toBeUndefined();
            expect(server.requests).toHaveLength(11);
            expect(server.requests[0]).toEqual(server.requests[1]);
            expect(server.requests[2].messages).toHaveLength(4);
            expect(result.attempts[0].costCeilingUSD).toBeUndefined();
            expect(result.attempts[0].error).toBe("retry_429");
        } finally {
            server.stop();
            tmp.close();
        }
    });
    test("cap is checked again before a 429 retry", async () => {
        const tmp = scratch(),
            server = mockServer({ statuses: [429, 200] });
        try {
            const result = await runTrial({
                config: { ...config, maxSpendUSD: 0.08 },
                cases: fixtures,
                material: "mock-key",
                mode: "mock",
                outputDir: tmp.dir,
                mockEndpoint: server.url,
                emit() {},
                sleep: async () => {},
            });
            expect(result.failure).toBe("spend_cap_refused");
            expect(server.requests).toHaveLength(1);
            expect(result.attempts).toHaveLength(1);
        } finally {
            server.stop();
            tmp.close();
        }
    });
    test("billing refusal stops as credential_no_credit without retry or another case", async () => {
        for (const status of [402, 429, 403]) {
            const tmp = scratch(),
                server = mockServer({
                    statuses: [status],
                    body: '{"error":{"message":"Insufficient Balance: billing credit exhausted"}}',
                });
            try {
                const result = await runTrial({
                    config,
                    cases: fixtures,
                    material: "mock-key",
                    mode: "mock",
                    outputDir: tmp.dir,
                    mockEndpoint: server.url,
                    emit() {},
                    sleep: async () => {
                        throw new Error("must not retry billing");
                    },
                });
                expect(result.failure).toBe("credential_no_credit");
                expect(result.cases).toHaveLength(1);
                expect(server.requests).toHaveLength(1);
                expect(result.attempts[0].costCeilingUSD).toBeUndefined();
            } finally {
                server.stop();
                tmp.close();
            }
        }
    });
    test("ledger accumulates settled costs and unknown reservations instead of resetting per case", () => {
        const ledger = new Ledger(0.08, prices, () => {});
        const row = ledger.reserve(first, 0, 1, 0);
        ledger.settle(row, parseUsage(mockReply(first).usage));
        ledger.reserve(first, 0, 2, 0);
        expect(() => ledger.reserve(first, 2, 1, 0)).toThrow("spend_cap_refused");
        expect(ledger.rows).toHaveLength(2);
        expect(ledger.committedUSD).toBeGreaterThan(row.costCeilingUSD!);
    });
    test("malformed usage fails closed, pricing uses cache hit and miss independently", () => {
        const usage = parseUsage({
            prompt_tokens: 150,
            prompt_cache_hit_tokens: 100,
            prompt_cache_miss_tokens: 50,
            completion_tokens: 25,
            total_tokens: 175,
        });
        expect(cost(usage, prices)).toBeCloseTo(0.0000456, 12);
        expect(() => parseUsage({ ...usage, prompt_cache_miss_tokens: 49 })).toThrow(
            "invalid_usage_sum",
        );
        expect(() => parseUsage({ ...usage, prompt_cache_hit_tokens: undefined })).toThrow(
            "invalid_usage",
        );
        expect(() => parseUsage({ ...usage, completion_tokens: -1 })).toThrow("invalid_usage");
        expect(
            retryDelay("Mon, 26 Oct 2026 00:00:02 GMT", Date.parse("2026-10-26T00:00:00Z")),
        ).toBe(2000);
        expect(() => retryDelay("121")).toThrow("credential_rate_limited");
    });
    test("grant, endpoint, budget and real-case fence cannot be widened by config", () => {
        validateConfig(config);
        validateConfig({ ...config, caseIds: [0, 1, 2, 3, 8, 10, 12, 20, 30, 35] });
        for (const bad of [
            { maxSpendUSD: 2.01 },
            { caseIds: [0, 8, 10, 12] },
            { caseIds: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
            { endpoint: "https://opencode.ai/zen" },
            { caseIds: [0, 2, 27, 12, 35] },
            { caseIds: [0, 2, 8, 8, 35] },
            { grant: { name: "apikey:another", kind: "api_key" } },
            { repeats: 2 },
        ]) {
            expect(() => validateConfig({ ...config, ...bad } as Config)).toThrow(
                "invalid_trial_config",
            );
        }
    });
    test("redaction includes raw/base64/hex in logs", () => {
        const key = "private-deepseek-key",
            lines: string[] = [];
        const log = logger(key, (line) => lines.push(line));
        log(
            `key ${key} ${Buffer.from(key).toString("base64")} ${Buffer.from(key).toString("hex")}`,
        );
        expect(lines.join("")).not.toContain(key);
        expect(lines.join("").match(/\[REDACTED\]/g)).toHaveLength(3);
        expect(sanitizer(key)(JSON.stringify({ echo: key }))).toBe('{"echo":"[REDACTED]"}');
    });
    test("echoed key material is redacted from raw errors and all artifacts", async () => {
        const key = "private-deepseek-key",
            tmp = scratch();
        const server = mockServer({
            statuses: [402],
            body: `billing: ${key} ${Buffer.from(key).toString("base64")} ${Buffer.from(key).toString("hex")}`,
        });
        const logs: string[] = [];
        try {
            const result = await runTrial({
                config,
                cases: fixtures,
                material: key,
                mode: "mock",
                outputDir: tmp.dir,
                mockEndpoint: server.url,
                emit: (line) => logs.push(line),
            });
            expect(result.failure).toBe("credential_no_credit");
            const stored =
                readFileSync(join(tmp.dir, "run.json"), "utf8") +
                readFileSync(join(tmp.dir, "review.md"), "utf8") +
                logs.join("");
            for (const secret of [
                key,
                Buffer.from(key).toString("base64"),
                Buffer.from(key).toString("hex"),
            ])
                expect(stored).not.toContain(secret);
            expect(result.attempts[0].raw).toBe("billing: [REDACTED] [REDACTED] [REDACTED]");
        } finally {
            server.stop();
            tmp.close();
        }
    });
    test("mock imports never open vault and Linux refuses macCredentialSource", async () => {
        if (process.platform === "darwin") return;
        await expect(macCredentialSource("must-not-read-enrollment.json")).rejects.toThrow(
            "credential_broker_trusted_host_required",
        );
    });
    test("mechanical review flags a numeric contradiction and an omitted claim", () => {
        const claim = {
            id: "x",
            family: "safety",
            text: "Reject payloads above 64 KiB.",
            anchor: { startOrdinal: 1, endOrdinal: 1 },
        };
        expect(
            mechanicalClaim(claim, [
                {
                    factId: 1,
                    action: "new",
                    category: "CONSTRAINTS",
                    text: "Reject payloads above 128 KiB.",
                },
            ]).mark,
        ).toContain("CONTRADICTED?");
        expect(mechanicalClaim(claim, []).mark).toContain("MISSED?");
    });
    test("production builders use recorded transcript and anchor facts; parser rejects malformed decisions", async () => {
        expect(first.messages[1].content).toContain("<fact_anchors>required</fact_anchors>");
        expect(first.messages[1].content).toContain("[1] U: Always serialize DeepSeek requests.");
        const second = await turnTwo(
            fixtures[0],
            first,
            mockReply(first).choices[0].message.content,
        );
        expect(second.facts[0].anchorKnown).toBe(true);
        expect(second.facts[0].blocks).toEqual(
            fixtures[0].blocks.slice(0, 1).map((b) => ({ ...b, parts: [...b.parts] })),
        );
        expect(() =>
            memoryDrafts(
                '{"result":{"step":"turn_two","decisions":[]}}',
                second.facts,
                fixtures[0],
            ),
        ).toThrow("turn_two_missing_decision");
        expect(() => memoryDrafts("not JSON", second.facts, fixtures[0])).toThrow(
            "turn_two_schema_invalid",
        );
    });
    test("production retrieval preserves seeded IDs and revisions; review includes final edit text but not covered writes", async () => {
        const c = {
            ...fixtures[0],
            memories: [
                {
                    id: 35,
                    revision: 7,
                    category: "CONFIG_VALUES" as const,
                    content: "Always serialize DeepSeek requests.",
                },
            ],
        };
        const second = await turnTwo(c, first, mockReply(first).choices[0].message.content);
        expect(second.facts[0].neighbours).toEqual(c.memories);
        const edit = JSON.stringify({
            result: {
                step: "turn_two",
                decisions: [
                    {
                        fact_id: 1,
                        check: "Audit fixture.",
                        action: "edit",
                        target_id: 35,
                        revision: 7,
                        removed: [],
                        replaced: [],
                        added: [],
                        kept: [],
                        final_text: "DeepSeek request concurrency is one.",
                    },
                ],
            },
        });
        expect(memoryDrafts(edit, second.facts, c)).toEqual([
            {
                factId: 1,
                action: "edit",
                targetId: 35,
                category: "CONFIG_VALUES",
                text: "DeepSeek request concurrency is one.",
            },
        ]);
        const covered = JSON.stringify({
            result: {
                step: "turn_two",
                decisions: [
                    {
                        fact_id: 1,
                        check: "Audit fixture.",
                        action: "covered",
                        target_id: 35,
                        revision: 7,
                        clauses: [1],
                    },
                ],
            },
        });
        expect(memoryDrafts(covered, second.facts, c)).toEqual([]);
    });
});
