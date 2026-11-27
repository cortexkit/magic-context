import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestHarness } from "../src/harness";
import type { MockResponse } from "../src/mock-provider/server";
import {
    assertIsolatedStores,
    countBanked,
    dreamerConfig,
    isVerifyRequest,
    MOCK_USAGE,
    projectIdentity,
    readDreamerInvocations,
    requestText,
    seedMappedMemories,
    startDream,
    userMessagesContaining,
    verifyPromptIds,
} from "./dreamer-timeout-support";

const TASK = "verify-broad";
const FINALIZE = "You're out of token budget";
const REFUSAL = "Out of token budget: no more tool calls. Output your result now.";
const BATCH_SIZE = 5;
const CHILD_BUDGET = 500_000;
const INITIAL_USAGE = { ...MOCK_USAGE, input_tokens: 50_000, cache_read_input_tokens: 360_000 };
const FINAL_USAGE = { ...MOCK_USAGE, input_tokens: 110_000 };
const INVESTIGATE = "toolu_budget_investigate";
const FIRST = "toolu_budget_first_refusal";
const SECOND = "toolu_budget_second_refusal";
const EVIDENCE = "The claims are implemented in this fixture.";
const FORBIDDEN_EVIDENCE = "Tool execution after finalize must not reveal this.";

type Run = {
    name: string;
    status: string;
    tokenBudget?: { budget: number; spent: number; finalizeFired: boolean; banked: number };
    failure?: { failure_class: string };
};

function runFor(h: TestHarness, identity: string): Run | undefined {
    const row = h.contextDb().prepare(
        "SELECT tasks_json FROM dream_runs WHERE project_path = ? ORDER BY id DESC LIMIT 1",
    ).get(identity) as { tasks_json: string } | null;
    return row ? (JSON.parse(row.tasks_json) as Run[]).find((run) => run.name === TASK) : undefined;
}

function toolResult(body: Record<string, unknown>, id: string): string | undefined {
    if (!Array.isArray(body.messages)) return undefined;
    for (const message of body.messages) {
        if (!Array.isArray(message.content)) continue;
        const parts = message.content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>;
        const part = parts.find((item) => item?.type === "tool_result" && item.tool_use_id === id);
        if (part) return requestText({ messages: [part.content] });
    }
    return undefined;
}

function read(path: string, id: string, usage = MOCK_USAGE): MockResponse {
    return {
        content: [{ type: "tool_use", id, name: "read", input: { filePath: path } }],
        stop_reason: "tool_use",
        usage,
    };
}

const manifest = (ids: readonly number[]) =>
    `<verify>${ids.map((id) => `<verified id="${id}"/>`).join("")}</verify>`;

async function witness(bank: boolean): Promise<void> {
    const h = await TestHarness.create({
        modelContextLimit: 1_000_000,
        magicContextConfig: { embedding: { provider: "off" }, dreamer: dreamerConfig(TASK, 5) },
    });
    const held = Promise.withResolvers<void>();
    const logPath = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
    const budgetLines = () => readFileSync(logPath, "utf8").split("\n")
        .filter((line) => line.includes("dreamer token budget:"));
    try {
        assertIsolatedStores(h);
        const parent = await h.createSession();
        await h.sendPrompt(parent, "Initialize the isolated project before verifying memories.");
        const identity = projectIdentity(h);
        const ids = seedMappedMemories(h, identity, BATCH_SIZE);
        const checked = ids.slice(0, 2);
        const evidence = join(h.workdir, "src", "fact.ts");
        const denied = join(h.workdir, "after-finalize.txt");
        mkdirSync(join(h.workdir, "src"), { recursive: true });
        writeFileSync(evidence, EVIDENCE);
        writeFileSync(denied, FORBIDDEN_EVIDENCE);
        h.mock.addMatcher((body) => {
            if (!isVerifyRequest(body)) return null;
            if (!requestText(body).includes(FINALIZE)) {
                // Leave the next provider response pending so only the budget monitor can end investigation.
                return toolResult(body, INVESTIGATE) === undefined
                    ? read(evidence, INVESTIGATE, INITIAL_USAGE)
                    : { text: manifest(ids), usage: MOCK_USAGE, until: held.promise };
            }
            if (toolResult(body, FIRST) === undefined) return read(denied, FIRST);
            if (bank) return { text: manifest(checked), usage: FINAL_USAGE };
            if (toolResult(body, SECOND) === undefined) return read(denied, SECOND);
            // After the second refusal, an unfinished generation cannot supply a verdict.
            return { text: manifest(ids), usage: MOCK_USAGE, until: held.promise };
        });

        const dream = startDream(h, parent, TASK);
        const run = await h.waitFor(() => runFor(h, identity), {
            timeoutMs: 15_000,
            label: "verify-broad run ledger",
        });
        await dream;
        const requests = h.requests().filter(({ body }) => isVerifyRequest(body));
        const ordinary = requests.filter(({ body }) => !requestText(body).includes(FINALIZE));
        const afterFinalize = requests.filter(({ body }) => requestText(body).includes(FINALIZE));
        expect(ordinary).toHaveLength(2);
        expect(verifyPromptIds(ordinary[0]!.body)).toEqual(ids);
        expect(toolResult(ordinary[1]!.body, INVESTIGATE)).toContain(EVIDENCE);
        expect(ordinary[1]!.responseCompletedAt).toBeUndefined();
        if (bank) expect(afterFinalize).toHaveLength(2);
        else {
            // The budget monitor may stop the child before the host sends another provider request.
            expect(afterFinalize.length).toBeGreaterThanOrEqual(2);
            expect(afterFinalize.length).toBeLessThanOrEqual(3);
        }
        expect(afterFinalize.map(({ body }) => userMessagesContaining(body, FINALIZE))).toEqual(
            afterFinalize.map(() => 1),
        );
        expect(toolResult(afterFinalize[1]!.body, FIRST)).toContain(REFUSAL);
        expect(afterFinalize.some(({ body }) => requestText(body).includes(FORBIDDEN_EVIDENCE))).toBe(false);
        const refusalStates = await h.waitFor(() => {
            const lines = budgetLines().filter((line) => line.includes("tool call refused"));
            return lines.length >= (bank ? 1 : 2) ? lines : undefined;
        }, { timeoutMs: 3_000, label: "flushed tool refusal diagnostics" });
        expect(refusalStates.map((line) => line.match(/"hardStopped":(true|false)/)?.[1])).toEqual(
            bank ? ["false"] : ["false", "true"],
        );
        expect(budgetLines().filter((line) => line.includes("finalize fired"))).toHaveLength(1);
        const invocations = readDreamerInvocations(h, parent);
        expect(invocations).toHaveLength(1);
        expect(invocations[0]?.task).toBe(TASK);
        const expectedSpent = 410_000 + MOCK_USAGE.input_tokens + (bank ? FINAL_USAGE.input_tokens : MOCK_USAGE.input_tokens);
        expect(run.tokenBudget).toEqual({
            budget: 2_500_000,
            spent: expectedSpent,
            finalizeFired: true,
            banked: bank ? 2 : 0,
        });
        if (bank) {
            expect(run.status).toBe("completed");
            expect(run.tokenBudget!.spent).toBeGreaterThan(CHILD_BUDGET);
            expect(invocations[0]?.status).toBe("completed");
            expect(countBanked(h, checked)).toBe(2);
            expect(countBanked(h, ids.slice(2))).toBe(0);
        } else {
            if (afterFinalize.length === 3) {
                expect(toolResult(afterFinalize[2]!.body, SECOND)).toContain(REFUSAL);
                expect(afterFinalize[2]!.responseCompletedAt).toBeUndefined();
            }
            expect(run.status).toBe("failed");
            expect(run.failure?.failure_class).toBe("token_budget");
            expect(run.tokenBudget!.spent).toBeLessThan(CHILD_BUDGET);
            expect(invocations[0]?.error).toContain("token_budget");
            expect(countBanked(h, ids)).toBe(0);
        }
    } catch (error) {
        console.error("verify-broad budget diagnostics:", budgetLines().join("\n"));
        throw error;
    } finally {
        held.resolve();
        await h.dispose();
    }
}

test("OpenCode 1 verify-broad refuses tools on finalize and banks its answer above the hard limit", () => witness(true), 25_000);
test("OpenCode 1 verify-broad stops after the second finalize refusal without banking verdicts", () => witness(false), 25_000);
