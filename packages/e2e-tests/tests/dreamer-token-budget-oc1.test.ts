/// <reference types="bun-types" />

/**
 * Real OpenCode 1.18.30 probe for the dreamer cost guard. Opt in with
 * MC_E2E_OC1_BUDGET_PROBE=1; the ordinary e2e suite may run against another host.
 * The host, its databases and the provider are isolated under throwaway roots.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import {
    formatDreamRunFailure,
    type DreamRunFailureDetail,
} from "../../plugin/src/features/magic-context/dreamer/storage-dream-runs";
import { CANONICAL_DREAM_TASKS } from "../../plugin/src/features/magic-context/dreamer/task-registry";
import { insertMemory } from "../../plugin/src/features/magic-context/memory/storage-memory";
import { TestHarness } from "../src/harness";
import { openTestDb } from "../src/test-db";
import { assertIsolatedStores, projectIdentity, startDream } from "./dreamer-timeout-support";

const TASK = "map-memories";
const SOFT_PROMPT = "You're out of token budget";
const TOOL_REFUSAL = "Out of token budget: no more tool calls. Output your result now.";
const USAGE = {
    input_tokens: 81,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
};
const LOW_USAGE = { ...USAGE, input_tokens: 1 };

type TaskRecord = {
    name: string;
    error?: string;
    failure?: DreamRunFailureDetail;
    tokenBudget?: { budget: number; spent: number; finalizeFired: boolean; banked: number };
};

function contextDbPath(h: TestHarness): string {
    return join(h.dataDir, "cortexkit", "magic-context", "context.db");
}

function records(h: TestHarness, identity: string): TaskRecord[] {
    const db = openTestDb(contextDbPath(h), { readonly: true });
    try {
        const rows = db
            .prepare("SELECT tasks_json FROM dream_runs WHERE project_path = ? ORDER BY id")
            .all(identity) as Array<{ tasks_json: string }>;
        return rows
            .flatMap((row) => JSON.parse(row.tasks_json) as TaskRecord[])
            .filter((task) => task.name === TASK);
    } finally {
        db.close();
    }
}

let seedOrdinal = 0;
function seed(h: TestHarness, identity: string): number {
    const db = openTestDb(contextDbPath(h));
    try {
        return insertMemory(db as never, {
            projectPath: identity,
            category: "ARCHITECTURE",
            content: `External probe observation ${++seedOrdinal} is unrelated to local source files.`,
            sourceSessionId: "ses-oc1-budget-seed",
        }).id;
    } finally {
        db.close();
    }
}

function assertNoLiveStores(h: TestHarness, liveHome: string): void {
    assertIsolatedStores(h);
    const opened = spawnSync("lsof", ["-nP", "-p", String(h.opencode.pid)], {
        encoding: "utf8",
    });
    expect(opened.status).toBe(0);
    for (const path of [
        "/.local/share/opencode/",
        "/.local/share/cortexkit/magic-context/",
        "/.config/opencode/",
        "/.config/cortexkit/",
        "/.pi/agent/",
    ]) {
        expect(opened.stdout).not.toContain(`${liveHome}${path}`);
    }
}

function mappedRows(h: TestHarness, memoryId: number): number {
    const db = openTestDb(contextDbPath(h), { readonly: true });
    try {
        const row = db
            .prepare("SELECT COUNT(*) AS n FROM memory_verifications WHERE memory_id = ?")
            .get(memoryId) as { n: number };
        return row.n;
    } finally {
        db.close();
    }
}

test.skipIf(process.env.MC_E2E_OC1_BUDGET_PROBE !== "1")(
    "OpenCode 1.18.30 keeps tools across abort/finalize, banks manifest, and records MC-D11",
    async () => {
        const original = {
            HOME: process.env.HOME,
            PATH: process.env.PATH,
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            XDG_DATA_HOME: process.env.XDG_DATA_HOME,
            XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
            MC_E2E_PLUGIN_ENTRY: process.env.MC_E2E_PLUGIN_ENTRY,
        };
        const isolatedHome = mkdtempSync(join(tmpdir(), "mc-oc1-budget-home-"));
        const liveHome = original.HOME ?? "";
        process.env.HOME = isolatedHome;
        process.env.XDG_CONFIG_HOME = join(isolatedHome, "config");
        process.env.XDG_DATA_HOME = join(isolatedHome, "data");
        process.env.XDG_CACHE_HOME = join(isolatedHome, "cache");
        process.env.PATH = `${join(liveHome, ".opencode", "bin")}:${original.PATH ?? ""}`;
        process.env.MC_E2E_PLUGIN_ENTRY = resolve(import.meta.dir, "../../plugin/src/index.ts");
        let h: TestHarness | undefined;
        let releaseReplies!: () => void;
        const until = new Promise<void>((resolve) => {
            releaseReplies = resolve;
        });
        try {
            const hostVersion = spawnSync("opencode", ["--version"], {
                env: process.env,
                encoding: "utf8",
            });
            expect(hostVersion.status).toBe(0);
            expect(hostVersion.stdout.trim()).toBe("1.18.30");
            const tasks = Object.fromEntries(
                CANONICAL_DREAM_TASKS.map((name) => [
                    name,
                    {
                        schedule: name === TASK ? "0 3 * * *" : "",
                        ...(name === TASK ? { token_budget: 100 } : {}),
                    },
                ]),
            );
            h = await TestHarness.create({
                magicContextConfig: {
                    embedding: { provider: "off" },
                    dreamer: {
                        disable: false,
                        tasks,
                        opencode: { tasks: { [TASK]: { timeout_minutes: 5 } } },
                    },
                },
            });
            assertNoLiveStores(h, liveHome);
            console.log(
                `[oc1-isolation] pid=${h.opencode.pid} OPENCODE_DB=${join(h.dataDir, "opencode", "opencode.db")} MAGIC_CONTEXT_STORAGE_DIR=${join(h.dataDir, "cortexkit", "magic-context")}`,
            );

            const parent = await h.createSession();
            h.mock.setDefault({ text: "ack", usage: LOW_USAGE });
            await h.sendPrompt(parent, "bootstrap the isolated dreamer probe");
            const identity = projectIdentity(h);
            let mode: "manifest" | "hard" = "manifest";
            let id = seed(h, identity);
            let refusalCount = 0;
            h.mock.addMatcher((body) => {
                const payload = JSON.stringify(body);
                if (
                    !payload.includes("A memory's BACKING FILES") &&
                    !payload.includes("Output ONE XML manifest")
                ) {
                    return null;
                }
                const finalize = payload.includes(SOFT_PROMPT);
                const refused = payload.includes(TOOL_REFUSAL);
                if (finalize && refused) refusalCount++;
                if (finalize && refused && mode === "manifest") {
                    return {
                        text: `<mappings><memory id="${id}" independent="true"/></mappings>`,
                        usage: LOW_USAGE,
                    };
                }
                // Only the budget monitor should end these generations. If a
                // reply finishes first, the monitor may never see a busy child.
                if (!finalize && payload.includes("tool_result")) {
                    return { text: "investigating", usage: LOW_USAGE, until };
                }
                if (mode === "hard" && finalize && refusalCount >= 2) {
                    return { text: "waiting", usage: LOW_USAGE, until };
                }
                return {
                    content: [{
                        type: "tool_use",
                        id: `toolu_budget_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                        name: "read",
                        input: { filePath: "fact.txt" },
                    }],
                    stop_reason: "tool_use",
                    usage: finalize ? LOW_USAGE : USAGE,
                };
            });

            const dream1 = startDream(h, parent, TASK);
            await h.waitFor(() => records(h!, identity).length >= 1, {
                timeoutMs: 60_000,
                intervalMs: 500,
                label: "budgeted mapping recorded",
            });
            await dream1;
            const success = records(h, identity).at(-1)!;
            expect(mappedRows(h, id)).toBe(1);
            expect(success.tokenBudget).toMatchObject({
                budget: 100,
                finalizeFired: true,
                banked: 1,
            });
            expect(success.tokenBudget!.spent).toBeGreaterThanOrEqual(81);
            const firstRequests = h.mock.requests().filter((request) =>
                JSON.stringify(request.body).includes("Output ONE XML manifest"),
            );
            const finalizeRequest = firstRequests.find((request) =>
                JSON.stringify(request.body).includes(SOFT_PROMPT),
            );
            expect(finalizeRequest).toBeDefined();
            expect((firstRequests[0]!.body.tools as unknown[]).length).toBeGreaterThan(0);
            expect(JSON.stringify(finalizeRequest!.body.tools)).toBe(
                JSON.stringify(firstRequests[0]!.body.tools),
            );
            expect(refusalCount).toBeGreaterThan(0);
            console.log(
                `[oc1-soft] child usable after abort; provider requests=${firstRequests.length}; tools-byte-identical=true refused=${refusalCount} banked=1 record=${JSON.stringify(success)}`,
            );

            mode = "hard";
            refusalCount = 0;
            id = seed(h, identity);
            const dream2 = startDream(h, parent, TASK);
            await h.waitFor(() => records(h!, identity).length >= 2, {
                timeoutMs: 60_000,
                intervalMs: 500,
                label: "token-budget failure recorded",
            });
            await dream2;
            const failed = records(h, identity).at(-1)!;
            expect(failed.failure?.failure_class).toBe("token_budget");
            expect(formatDreamRunFailure(failed.failure!)).toContain("MC-D11");
            expect(failed.tokenBudget).toMatchObject({
                budget: 100,
                finalizeFired: true,
                banked: 0,
            });
            expect(refusalCount).toBeGreaterThanOrEqual(2);
            expect(mappedRows(h, id)).toBe(0);
            assertNoLiveStores(h, liveHome);
            console.log(`[oc1-hard] refused=${refusalCount} record=${JSON.stringify(failed)}`);
        } finally {
            releaseReplies();
            await h?.dispose();
            for (const [key, value] of Object.entries(original)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            rmSync(isolatedHome, { recursive: true, force: true });
        }
    },
    180_000,
);
