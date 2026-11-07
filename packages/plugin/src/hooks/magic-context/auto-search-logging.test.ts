import { expect, spyOn, test } from "bun:test";
import * as embedding from "../../features/magic-context/memory/embedding";
import * as logger from "../../shared/logger";
import { createAutoSearchReplayFixture, replayHint } from "./auto-search-replay.fixture";
import { runAutoSearchHint } from "./auto-search-runner";
import { autoSearchTestSnapshot } from "./auto-search-snapshot.fixture";
import * as worker from "./auto-search-worker-client";

for (const host of ["opencode", "opencode2"] as const) {
    for (const outcome of [
        "attached",
        "below-threshold",
        "timeout",
        "no-candidates",
        "disabled",
        "error",
        "too-short",
        "stacked",
        "unregistered",
    ] as const) {
        test(`${host} logs one content-free ${outcome} decision, not its replay`, async () => {
            const fixture = createAutoSearchReplayFixture(host, `logging-${outcome}`);
            const snapshot = spyOn(embedding, "getProjectEmbeddingSnapshot").mockReturnValue(
                outcome === "unregistered" ? null : autoSearchTestSnapshot(fixture.projectPath),
            );
            const log = spyOn(logger, "sessionLog");
            const globalLog = spyOn(logger, "log");
            const search = spyOn(worker, "searchAutoHint").mockImplementation(
                async (_db, _session, _project, _query, options) => {
                    const diagnostics = options.autoSearchDiagnostics!;
                    diagnostics.workerStarted = true;
                    diagnostics.pool = "cold";
                    diagnostics.peek = "missing";
                    diagnostics.poolRows = 0;
                    diagnostics.lanes = {
                        memory: { top: outcome === "attached" ? 0.8 : 0.55, nearMisses: 2 },
                        messages: { top: 0.4, nearMisses: 0 },
                    };
                    if (outcome === "timeout") return new Promise(() => {});
                    if (outcome === "error") throw new Error("PRIVATE QUERY / PRIVATE MEMORY");
                    if (outcome === "no-candidates") {
                        diagnostics.lanes = { messages: { top: null, nearMisses: 0 } };
                        return [];
                    }
                    return [
                        {
                            ...replayHint,
                            content: "PRIVATE MEMORY",
                            relevanceScore: outcome === "attached" ? 0.8 : 0.55,
                        },
                    ];
                },
            );
            const backfill = spyOn(worker, "queueAutoSearchBackfill").mockResolvedValue();
            const prompt =
                outcome === "too-short"
                    ? "short"
                    : `PRIVATE QUERY${outcome === "stacked" ? " <ctx-search-hint>PRIVATE MEMORY</ctx-search-hint>" : ""}`;
            const invoke = () =>
                runAutoSearchHint({
                    db: fixture.db,
                    sessionId: fixture.sessionId,
                    messages: [
                        {
                            info: { id: "turn", role: "user" },
                            parts: [{ type: "text", text: prompt }],
                        },
                    ],
                    options: {
                        enabled: outcome !== "disabled",
                        projectPath: fixture.projectPath,
                        scoreThreshold: 0.6,
                        minPromptChars: 10,
                    },
                });
            try {
                await Promise.all([invoke(), invoke()]);
                await invoke();
                const lines = log.mock.calls
                    .map(([, line]) => line)
                    .filter((line) => line.startsWith("auto-search:"));
                expect(lines).toHaveLength(1);
                const expected = ["too-short", "stacked", "unregistered"].includes(outcome)
                    ? "no-candidates"
                    : outcome;
                expect(lines[0]).toContain(`outcome=${expected}`);
                for (const field of [
                    "lanes=",
                    "nearMisses=",
                    "threshold=0.6",
                    "pool=",
                    "rows=",
                    "workerStarted=",
                    "peek=",
                    "elapsedMs=",
                ])
                    expect(lines[0]).toContain(field);
                if (
                    outcome === "attached" ||
                    outcome === "below-threshold" ||
                    outcome === "timeout"
                ) {
                    expect(lines[0]).toContain(
                        `lanes=memory:${outcome === "attached" ? "0.800" : "0.550"},messages:0.400 nearMisses=2`,
                    );
                    expect(lines[0]).toContain("pool=cold rows=0 workerStarted=true peek=missing");
                }
                const allLogs = JSON.stringify([log.mock.calls, globalLog.mock.calls]);
                expect(allLogs).not.toContain("PRIVATE QUERY");
                expect(allLogs).not.toContain("PRIVATE MEMORY");
                expect(lines[0]).not.toContain("\n");
            } finally {
                backfill.mockRestore();
                search.mockRestore();
                globalLog.mockRestore();
                log.mockRestore();
                snapshot.mockRestore();
                fixture.close();
            }
        });
    }
}
