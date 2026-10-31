import { expect, spyOn, test } from "bun:test";
import * as embedding from "@magic-context/core/features/magic-context/memory/embedding";
import {
	createAutoSearchReplayFixture,
	replayHint,
} from "@magic-context/core/hooks/magic-context/auto-search-replay.fixture";
import { autoSearchTestSnapshot } from "@magic-context/core/hooks/magic-context/auto-search-snapshot.fixture";
import * as worker from "@magic-context/core/hooks/magic-context/auto-search-worker-client";
import * as logger from "@magic-context/core/shared/logger";
import { runAutoSearchHintForPi } from "./auto-search-pi";
import { userMessage } from "./test-utils.test";

for (const host of ["pi", "omp"] as const) {
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
			const snapshot = spyOn(
				embedding,
				"getProjectEmbeddingSnapshot",
			).mockReturnValue(
				outcome === "unregistered"
					? null
					: autoSearchTestSnapshot(fixture.projectPath),
			);
			const log = spyOn(logger, "sessionLog");
			const globalLog = spyOn(logger, "log");
			const search = spyOn(worker, "searchAutoHint").mockImplementation(
				async (_db, _session, _project, _query, options) => {
					const diagnostics = options.autoSearchDiagnostics;
					if (!diagnostics) throw new Error("missing auto-search diagnostics");
					diagnostics.workerStarted = false;
					diagnostics.pool = "warm";
					diagnostics.peek = "hit";
					diagnostics.poolRows = 17;
					diagnostics.lanes = {
						memory: { top: outcome === "attached" ? 0.8 : 0.55, nearMisses: 2 },
						summaries: { top: 0.51, nearMisses: 1 },
						git: { top: null, nearMisses: 0 },
					};
					if (outcome === "timeout") return new Promise(() => {});
					if (outcome === "error")
						throw new Error("PRIVATE QUERY / PRIVATE MEMORY");
					if (outcome === "no-candidates") {
						diagnostics.lanes = { memory: { top: null, nearMisses: 0 } };
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
			const backfill = spyOn(
				worker,
				"queueAutoSearchBackfill",
			).mockResolvedValue();
			const prompt =
				outcome === "too-short"
					? "short"
					: `PRIVATE QUERY${outcome === "stacked" ? " <ctx-search-hint>PRIVATE MEMORY</ctx-search-hint>" : ""}`;
			const invoke = () =>
				runAutoSearchHintForPi({
					db: fixture.db,
					sessionId: fixture.sessionId,
					entryIds: ["turn"],
					messages: [userMessage(prompt, 1)],
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
				const expected = ["too-short", "stacked", "unregistered"].includes(
					outcome,
				)
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
						`lanes=memory:${outcome === "attached" ? "0.800" : "0.550"},summaries:0.510,git:none nearMisses=3`,
					);
					expect(lines[0]).toContain(
						"pool=warm rows=17 workerStarted=false peek=hit",
					);
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
