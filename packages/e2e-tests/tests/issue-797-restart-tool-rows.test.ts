/// <reference types="bun-types" />

/**
 * Real-host check of the tool-definition totals after a restart (GitHub issue
 * 797). Skipped unless MC_REPRO_797=1.
 *
 * Versions before stored tool-definition rows were pruned kept a row for every
 * tool a route was ever offered, and summed them all into the tool-definition
 * total that sizes a request. A restart reloaded every row. This case seeds a
 * real session at about 60% of the usable window, adds 74 stored rows for
 * tools the route no longer offers (the state an earlier version leaves), lets
 * the provider cache expire, and restarts the host. The first pass after the
 * restart owes the idle rebuild and has no live provider reading, so it sizes
 * the request from its local count, which includes the tool-definition total.
 * With the 74 rows counted that count is past the 95% emergency line; counting
 * only the tools the request carries it stays near 60%, so no emergency drop
 * runs. The stored rows of the retired tools are deleted by the first request
 * after the restart, once it has measured the tools it carries.
 * OpenCode 2 reads the session's last usage from its own store before the
 * transform, so its first pass has a reading and does not size from the count;
 * there the case checks that the stored set becomes exactly the request's tools.
 *
 * Live-store isolation: every host child runs under the harness's throwaway
 * root, and an lsof inventory of the host PID before and after the restart
 * must list only database files under that root.
 */

import { expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { estimateTokens } from "../../plugin/src/hooks/magic-context/read-session-formatting";
import { inspectHostOpenFiles } from "../src/host-open-files";
import type { CapturedRequest } from "../src/mock-provider/server";
import {
    createFreshSession,
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import { createE2ETempDir } from "../src/temp-dir";
import { openTestDb } from "../src/test-db";

const ENABLED = process.env.MC_REPRO_797 === "1";
const CONTEXT_LIMIT = 100_000;
const WARM_USAGE = { input_tokens: 55_000, output_tokens: 10, cache_creation_input_tokens: 0 };
const IDLE_MS = 2 * 60 * 60 * 1000;
const RETIRED_TOOLS = 74;
const RETIRED_TOKENS = 1_000;
const FORCE_BAND = 85;

function isSessionRequest(request: CapturedRequest): boolean {
    return (
        Array.isArray(request.body.tools) &&
        request.body.tools.length > 0 &&
        JSON.stringify(request.body.system ?? request.body.instructions).includes("Magic Context")
    );
}

function hostPid(h: ScenarioHarness): number | undefined {
    const handle = h as unknown as {
        opencode?: { pid?: number };
        hostPid?: number;
    };
    return handle.opencode?.pid ?? handle.hostPid;
}

/** lsof inventory of the host PID: every open database must sit under the throwaway root. */
function assertContained(h: ScenarioHarness) {
    const pid = hostPid(h);
    if (!pid) throw new Error("host PID unavailable for live-store isolation");
    const inventory = inspectHostOpenFiles(pid, dirname(h.dataDir));
    expect(inventory.databases.length).toBeGreaterThan(0);
    return { pid, root: dirname(h.dataDir), databases: inventory.databases };
}

function pluginLog(h: ScenarioHarness): string {
    if (h.host === "opencode2") {
        return (h as unknown as { opencode: { pluginLog: () => string } }).opencode.pluginLog();
    }
    const path =
        process.env.MAGIC_CONTEXT_LOG_PATH ?? join(h.dataDir, "cortexkit", "magic-context-e2e.log");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function linesSince(h: ScenarioHarness, session: string, since: number): string[] {
    return pluginLog(h)
        .split("\n")
        .filter((line) => line.includes(session) && Date.parse(line.slice(1, 25)) >= since);
}

type ToolRow = { provider_id: string; model_id: string; agent_name: string; tool_id: string };

function toolRows(h: ScenarioHarness): ToolRow[] {
    const db = openTestDb(h.contextDbPath(), { readonly: true });
    try {
        return db
            .prepare(
                "SELECT provider_id, model_id, agent_name, tool_id FROM tool_definition_measurements ORDER BY provider_id, model_id, agent_name, tool_id",
            )
            .all() as ToolRow[];
    } finally {
        db.close();
    }
}

/** The rows an earlier version leaves: tools each measured route was offered once. */
function addRetiredRows(h: ScenarioHarness, routes: ToolRow[]): void {
    const db = openTestDb(h.contextDbPath());
    try {
        const insert = db.prepare(
            "INSERT OR REPLACE INTO tool_definition_measurements (provider_id, model_id, agent_name, tool_id, token_count, recorded_at) VALUES (?, ?, ?, ?, ?, 1)",
        );
        for (const route of routes)
            for (let i = 0; i < RETIRED_TOOLS; i++)
                insert.run(
                    route.provider_id,
                    route.model_id,
                    route.agent_name,
                    `retired_tool_${i}`,
                    RETIRED_TOKENS,
                );
    } finally {
        db.close();
    }
}

/** Ages the idle clock the way a long host downtime would. */
function expireIdleClock(h: ScenarioHarness, session: string): void {
    const db = openTestDb(h.contextDbPath());
    try {
        const result = db
            .prepare(
                "UPDATE session_meta SET last_response_time = last_response_time - ?, cached_m0_materialized_at = cached_m0_materialized_at - ? WHERE session_id = ? AND harness = ? AND last_response_time > 0",
            )
            .run(IDLE_MS, IDLE_MS, session, h.harnessId);
        expect(result.changes).toBe(1);
    } finally {
        db.close();
    }
}

async function runCase(host: Parameters<typeof createScenarioHarness>[0]) {
    const previousLogPath = process.env.MAGIC_CONTEXT_LOG_PATH;
    process.env.MAGIC_CONTEXT_LOG_PATH = join(createE2ETempDir("issue-797-log-"), "plugin.log");
    const h = await createScenarioHarness(host, {
        modelContextLimit: CONTEXT_LIMIT,
        magicContextConfig: {
            cache_ttl: { default: "1h" },
            execute_threshold_percentage: 65,
            protected_tokens: 2_000,
            historian: { disable: true },
        },
        mockDefault: { text: "answer", usage: WARM_USAGE },
    });
    try {
        const session = await createFreshSession(h);
        const turn = async (text: string) => {
            const start = Date.now();
            const count = h.requests().length;
            await h.sendPrompt(session, text, { timeoutMs: 120_000 });
            await h.waitForMockQuiescence();
            await h.waitFor(
                () =>
                    linesSince(h, session, start).some((line) =>
                        /transform completed|rust pass:/.test(line),
                    ),
                { timeoutMs: 10_000, label: "completed transform log" },
            );
            const requests = h.requests().slice(count).filter(isSessionRequest);
            expect(requests.length).toBeGreaterThan(0);
            return { start, end: Date.now(), requests, log: linesSince(h, session, start) };
        };

        const sample = h.ballast(10_000);
        const chunk = h.ballast(Math.round((5_000 * 10_000) / estimateTokens(sample)));
        await turn(`history one\n${chunk}`);
        await turn(`history two\n${chunk}`);
        const warm = await turn(`history three\n${chunk}`);
        const liveRows = toolRows(h);
        expect(liveRows.length).toBeGreaterThan(0);
        const routes = [
            ...new Map(
                liveRows.map((row) => [`${row.provider_id}/${row.model_id}/${row.agent_name}`, row]),
            ).values(),
        ];
        const containedBefore = assertContained(h);

        addRetiredRows(h, routes);
        expireIdleClock(h, session);
        await h.restart();
        const containedAfterRestart = assertContained(h);

        const boot = await turn("first turn after the restart");
        const rowsAfterBoot = toolRows(h);
        const containedAfter = assertContained(h);
        const usageLine = boot.log.find((line) => line.includes("unknown provider usage;"));
        const bootReading = Number(/ percentage=([\d.]+)/.exec(usageLine ?? "")?.[1]);
        const summary = {
            host,
            session,
            liveTools: liveRows.length,
            routes: routes.map((row) => `${row.provider_id}/${row.model_id}/${row.agent_name}`),
            retiredRowsSeeded: RETIRED_TOOLS * routes.length,
            retiredRowsAfterBoot: rowsAfterBoot.filter((row) =>
                row.tool_id.startsWith("retired_tool_"),
            ).length,
            rowsAfterBoot: rowsAfterBoot.length,
            warmToolCount: (warm.requests.at(-1)!.body.tools as unknown[]).length,
            bootToolCount: (boot.requests[0]!.body.tools as unknown[]).length,
            usageLine,
            bootReading,
            emergencyLines: boot.log.filter((line) => /emergency tiered drop: /.test(line)),
            containment: [containedBefore, containedAfterRestart, containedAfter],
        };
        console.log("ISSUE_797_HOST", JSON.stringify(summary));

        // OpenCode 1: the first pass after the restart has no provider reading,
        // sizes the request from its local count, and counts only the tools the
        // request carries. OpenCode 2 reads the session's last usage from its own
        // store before the transform runs, so its first pass has a reading and
        // needs no count; there the stored set must become exactly the tools of
        // the request.
        if (host === "opencode") expect(usageLine).toContain("using wire estimate");
        else expect(rowsAfterBoot.length).toBe(summary.bootToolCount);
        if (usageLine !== undefined) {
            expect(bootReading).toBeGreaterThan(0);
            expect(bootReading).toBeLessThan(FORCE_BAND);
        }
        expect(summary.emergencyLines).toEqual([]);
        // After the first request following the restart, the retired tools' rows
        // are gone and the rows of the request's own tools remain.
        expect(summary.retiredRowsAfterBoot).toBe(0);
        expect(rowsAfterBoot.length).toBeGreaterThan(0);
    } finally {
        await h.dispose();
        if (previousLogPath === undefined) delete process.env.MAGIC_CONTEXT_LOG_PATH;
        else process.env.MAGIC_CONTEXT_LOG_PATH = previousLogPath;
    }
}

forEachHost(import.meta.url, "issue 797 tool-definition totals after a host restart", (host) => {
    it.skipIf(!ENABLED)(
        "an expired restart with stored rows of retired tools sizes the session from the request's own tools",
        () => runCase(host),
        300_000,
    );
});
