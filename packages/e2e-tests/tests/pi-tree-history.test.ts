import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildMockHistorianPayload,
	findHistorianOrdinalRange,
} from "../src/mock-historian";
import { PiTestHarness } from "../src/pi-harness";
import { childEnv, resolvePiHostInvocation } from "../src/pi-runner/spawn";
import { forEachHost } from "../src/scenario-hosts";
import { createE2ETempDir } from "../src/temp-dir";

forEachHost(import.meta.url, null, (host) => {
	if (host !== "pi" && host !== "omp")
		throw new Error(`Unsupported host ${host}`);
	it(`${host}: tree navigation retires abandoned history and wrapup can progress`, async () => {
		const base = join(realpathSync(tmpdir()), "magic-context/issue-562");
		mkdirSync(base, { recursive: true });
		const previousTmp = process.env.TMPDIR;
		process.env.TMPDIR = base;
		const fixture = createE2ETempDir(`${host}-tree-`);
		const snapshotPath = join(fixture, "tree.json");
		const extension = join(fixture, "tree-probe.mjs");
		writeFileSync(
			extension,
			`
import { appendFileSync, writeFileSync } from "node:fs";
export default function(pi) {
    const preview = message => JSON.stringify(message?.content ?? "").slice(0, 100);
    pi.on("context", (event, ctx) => {
        appendFileSync(${JSON.stringify(join(fixture, "host-contexts.jsonl"))}, JSON.stringify({ branch: ctx.sessionManager.getBranch().filter(e => e.type === "message").map(e => ({id: e.id, parentId: e.parentId, preview: preview(e.message)})), request: event.messages.map(preview) }) + "\\n");
    });
    pi.registerCommand("e2e-tree-snapshot", { description: "Capture the real host tree", handler(_args, ctx) {
        writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify({ leaf: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch(), entries: ctx.sessionManager.getEntries() }));
    }});
    pi.registerCommand("e2e-tree-goto", { description: "Navigate with the same host API as /tree", async handler(id, ctx) {
        await ctx.navigateTree(id.trim(), { summarize: false });
    }});
}
`,
		);
		const invocation = resolvePiHostInvocation(host);
		const version = JSON.parse(
			readFileSync(invocation.packageJson, "utf8"),
		).version;
		console.log(`${host} real host ${version}; evidence ${fixture}`);
		let h: PiTestHarness | undefined;
		try {
			h = await PiTestHarness.create({
				host,
				extensionsBeforeMagicContext: [extension],
				magicContextConfig: {
					execute_threshold_percentage: 95,
					protected_tokens: 4000,
				},
			});
			const harness = h;
			const latestMain = () =>
				harness.mock
					.requests()
					.filter(
						(request) =>
							!JSON.stringify(request.body.system).includes(
								"the hippocampus of a long-running coding agent",
							),
					)
					.at(-1)!.body;
			await h.getState();
			const wrap = async () => {
				await harness.invokeExtensionCommand("e2e-tree-snapshot");
				const start = JSON.parse(readFileSync(snapshotPath, "utf8")).entries
					.length;
				await harness.invokeExtensionCommand("ctx-wrapup 2");
				const deadline = Date.now() + 20000;
				while (Date.now() < deadline) {
					await harness.invokeExtensionCommand("e2e-tree-snapshot");
					const statuses = JSON.parse(
						readFileSync(snapshotPath, "utf8"),
					).entries.slice(start);
					if (
						statuses.some(
							(entry: any) =>
								entry.customType === "ctx-status" &&
								/Wrapped up|Nothing to wrap up|Magic Wrapup —/.test(
									entry.data?.text,
								),
						)
					)
						return statuses;
					await Bun.sleep(25);
				}
				throw new Error("wrapup terminal status timed out");
			};
			const env = childEnv(h.env);
			for (const key of [
				"HOME",
				"XDG_DATA_HOME",
				"XDG_CONFIG_HOME",
				"XDG_STATE_HOME",
				"XDG_RUNTIME_DIR",
				"XDG_CACHE_HOME",
				"MAGIC_CONTEXT_STORAGE_DIR",
				"PI_CODING_AGENT_DIR",
			]) {
				expect(realpathSync(env[key]!).startsWith(`${base}/`)).toBe(true);
			}
			const opened = execFileSync("lsof", ["-Fn", "-p", String(h.hostPid)], {
				encoding: "utf8",
			});
			writeFileSync(join(fixture, "lsof.txt"), opened);
			const stores = opened
				.split("\n")
				.filter(
					(line) =>
						line.startsWith("n/") &&
						(/\.db(?:-wal|-shm)?$/.test(line) ||
							/\/\.(?:config|pi|omp)\//.test(line)),
				)
				.map((line) => line.slice(1));
			expect(stores.length).toBeGreaterThan(0);
			expect(stores.every((path) => path.startsWith(`${base}/`))).toBe(true);
			let generation = "ABANDONED_HISTORY";
			h.mock.addMatcher((body) => {
				if (
					!JSON.stringify(body.system).includes(
						"the hippocampus of a long-running coding agent",
					)
				)
					return null;
				const range = findHistorianOrdinalRange(body);
				if (!range) throw new Error("Historian source range missing");
				return {
					text: buildMockHistorianPayload({
						start: range.start,
						end: range.end,
						title: generation,
						body: `${generation}: completed work on this branch.`,
					}),
					usage: { input_tokens: 500, output_tokens: 200 },
				};
			});
			const session = await h.createSession();
			for (let i = 0; i < 12; i++)
				await h.sendPrompt(session, `ORIGINAL_TURN_${i}. ${h.ballast(1500)}`);
			await h.invokeExtensionCommand("e2e-tree-snapshot");
			const original = JSON.parse(readFileSync(snapshotPath, "utf8"));
			const target = original.branch.filter(
				(entry: any) => entry.message?.role === "assistant",
			)[3].id;
			writeFileSync(
				join(fixture, "initial-wrapup.json"),
				JSON.stringify(await wrap(), null, 2),
			);
			expect(h.countCompartments(session)).toBeGreaterThan(0);
			await h.invokeExtensionCommand("ctx-flush");
			await h.sendPrompt(session, "Render the published original history.");
			const beforeJump = latestMain();
			expect(JSON.stringify(beforeJump.messages)).toContain(
				"ABANDONED_HISTORY",
			);
			generation = "REACHABLE_HISTORY";
			await h.invokeExtensionCommand(`e2e-tree-goto ${target}`);
			await h.invokeExtensionCommand("e2e-tree-snapshot");
			const jumped = JSON.parse(readFileSync(snapshotPath, "utf8"));
			expect(jumped.entries.length).toBeGreaterThan(jumped.branch.length);
			const priorHistorianRequests = h.mock
				.requests()
				.filter((request) =>
					JSON.stringify(request.body.system).includes(
						"the hippocampus of a long-running coding agent",
					),
				).length;
			// The large new turn fills the protected recent tail. The remaining
			// shared history is still too small to trigger summarization by size.
			await h.sendPrompt(session, `FIRST_AFTER_TREE ${h.ballast(120000)}`);
			const firstAfterTree = latestMain();
			// OMP's first context callback in this fixture does not yet have the new
			// user in getBranch(). The next request exposes that large turn to the
			// raw historian reader; host-contexts.jsonl records the host ordering.
			if (host === "omp")
				await h.sendPrompt(session, "NEXT_ELIGIBLE_AFTER_TREE");
			let automaticCovered = false;
			try {
				await h.waitFor(
					() =>
						harness.mock
							.requests()
							.filter((request) =>
								JSON.stringify(request.body.system).includes(
									"the hippocampus of a long-running coding agent",
								),
							).length > priorHistorianRequests &&
						!JSON.parse(
							(
								harness
									.contextDb()
									.prepare(
										"SELECT deferred_execute_state AS state FROM session_meta WHERE session_id = ?",
									)
									.get(session) as { state: string | null } | null
							)?.state ?? "{}",
						).piHistorianRetirement,
					{
						timeoutMs: 15000,
						label: "small reachable range is automatically summarized",
					},
				);
				automaticCovered = true;
			} catch {
				// Still collect the wrapup result and provider requests if automatic summarization times out.
			}
			const automaticCompartments = h
				.contextDb()
				.prepare(
					"SELECT start_message, end_message, title FROM compartments WHERE session_id = ? ORDER BY sequence",
				)
				.all(session);
			writeFileSync(
				join(fixture, "automatic-compartments.json"),
				JSON.stringify(automaticCompartments, null, 2),
			);
			const wrapup = await wrap();
			writeFileSync(
				join(fixture, "wrapup.json"),
				JSON.stringify(wrapup, null, 2),
			);
			await h.invokeExtensionCommand("ctx-flush");
			await h.sendPrompt(
				session,
				"AFTER_TREE: only describe work on the reachable branch.",
			);
			const afterJump = latestMain();
			for (let i = 0; i < 3; i++)
				await h.sendPrompt(session, `LATER_TURN_${i}. ${h.ballast(1500)}`);
			const later = latestMain();
			h.mock.setDefault({
				text: "pressure",
				usage: {
					input_tokens: 198000,
					output_tokens: 20,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
			});
			await h.sendPrompt(session, "Report high usage on the reachable branch.");
			h.mock.setDefault({
				text: "after pressure",
				usage: { input_tokens: 500, output_tokens: 20 },
			});
			await h.sendPrompt(session, "Allow the automatic historian to run.");
			await h.waitForMockQuiescence({ quietMs: 1500 });
			const historianRuns = h
				.contextDb()
				.prepare(
					"SELECT status, failure_reason, chunk_start_ordinal, chunk_end_ordinal FROM historian_runs WHERE session_id = ? ORDER BY id",
				)
				.all(session);
			writeFileSync(
				join(fixture, "historian-runs.json"),
				JSON.stringify(historianRuns, null, 2),
			);
			await h.invokeExtensionCommand(`e2e-tree-goto ${original.leaf}`);
			await h.sendPrompt(session, "BACK_TO_ORIGINAL_BRANCH");
			const returned = latestMain();
			writeFileSync(
				join(fixture, "requests.json"),
				JSON.stringify(h.mock.requests(), null, 2),
			);
			writeFileSync(
				join(fixture, "observations.json"),
				JSON.stringify(
					{
						host,
						version,
						target,
						automaticCovered,
						originalLeaf: original.leaf,
						jumpedLeaf: jumped.leaf,
						beforeJump,
						firstAfterTree,
						afterJump,
						later,
						returned,
					},
					null,
					2,
				),
			);
			writeFileSync(join(fixture, "diagnostics.txt"), h.diagnostics());
			harness.assertHistorianRequestsUseMock();
			expect(JSON.stringify(wrapup)).not.toContain(
				"stored history boundaries no longer match",
			);
			expect(automaticCovered).toBe(true);
			expect(JSON.stringify(automaticCompartments)).toContain(
				"REACHABLE_HISTORY",
			);
			expect(JSON.stringify(firstAfterTree.messages)).not.toContain(
				"ABANDONED_HISTORY",
			);
			expect(JSON.stringify(afterJump.messages)).not.toContain(
				"ABANDONED_HISTORY",
			);
			expect(JSON.stringify(afterJump.messages)).toContain("REACHABLE_HISTORY");
			expect(JSON.stringify(later.messages)).not.toContain("ABANDONED_HISTORY");
			expect(JSON.stringify(returned.messages)).not.toContain(
				"ABANDONED_HISTORY",
			);
		} finally {
			if (h) {
				writeFileSync(
					join(fixture, "requests.json"),
					JSON.stringify(h.mock.requests(), null, 2),
				);
				writeFileSync(join(fixture, "diagnostics.txt"), h.diagnostics());
			}
			await h?.dispose();
			if (previousTmp === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTmp;
		}
	}, 120000);

	it(`${host}: raw search excludes the abandoned tree branch but keeps the active archive`, async () => {
		const fixture = createE2ETempDir(`${host}-tree-search-`);
		const snapshotPath = join(fixture, "tree.json");
		const eventPath = join(fixture, "tree-event.json");
		const extension = join(fixture, "tree-search-probe.mjs");
		writeFileSync(extension, `
import { writeFileSync } from "node:fs";
export default function(pi) {
    pi.registerCommand("e2e-tree-snapshot", { description: "Capture active path", handler(_args, ctx) {
        writeFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify({ leaf: ctx.sessionManager.getLeafId(), branch: ctx.sessionManager.getBranch() }));
    }});
    pi.registerCommand("e2e-tree-goto", { description: "Use the host tree navigation API", async handler(id, ctx) {
        await ctx.navigateTree(id.trim(), { summarize: false });
    }});
    pi.on("session_tree", (event, ctx) => {
        writeFileSync(${JSON.stringify(eventPath)}, JSON.stringify({ ...event, actualLeaf: ctx.sessionManager.getLeafId() }));
    });
}
`);
		let h: PiTestHarness | undefined;
		try {
			h = await PiTestHarness.create({
				host, extensionsBeforeMagicContext: [extension],
				magicContextConfig: { execute_threshold_percentage: 95, protected_tokens: 4000 },
			});
			const harness = h;
			const session = await h.createSession();
			const db = h.contextDb();
			const opened = execFileSync("lsof", ["-Fn", "-p", String(h.hostPid)], { encoding: "utf8" });
			writeFileSync(join(fixture, "lsof.txt"), opened);
			const stores = opened.split("\n").filter((line) => line.startsWith("n/") && /\.db(?:-wal|-shm)?$/.test(line));
			expect(stores.length).toBeGreaterThan(0);
			expect(stores.every((line) => line.slice(1).startsWith(`${harness.env.baseDir}/`))).toBe(true);
			const abandoned = "abandonedzephyr807";
			const legitimate = "survivorquartz807";
			h.mock.addMatcher((body) => {
				if (!JSON.stringify(body.system).includes("the hippocampus of a long-running coding agent")) return null;
				const range = findHistorianOrdinalRange(body);
				if (!range) throw new Error("Historian range missing");
				return { text: buildMockHistorianPayload({ start: range.start, end: range.end, title: "Active archive", body: "Completed work on the active path." }), usage: { input_tokens: 500, output_tokens: 200 } };
			});
			for (let i = 0; i < 8; i++)
				await h.sendPrompt(session, `${i === 0 ? legitimate : i === 4 ? abandoned : `original_${i}`} ${h.ballast(1500)}`);
			await h.invokeExtensionCommand("e2e-tree-snapshot");
			const original = JSON.parse(readFileSync(snapshotPath, "utf8"));
			const target = original.branch.filter((entry: any) => entry.message?.role === "assistant")[2].id;
			const abandonedEntry = original.branch.find((entry: any) => JSON.stringify(entry.message?.content ?? "").includes(abandoned));
			const oldRow = () => db.prepare("SELECT message_id, CAST(message_ordinal AS INTEGER) AS ordinal FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ?").get(session, abandoned) as { message_id: string; ordinal: number } | null;
			// Production indexing waits for its fixed two-minute boot quiet period.
			await h.waitFor(() => oldRow() !== null, { timeoutMs: 150000, label: "abandoned phrase indexed before rewind" });
			const indexed = oldRow()!;
			expect(indexed.message_id).toBe(abandonedEntry.id);
			await h.invokeExtensionCommand(`e2e-tree-goto ${target}`);
			await h.invokeExtensionCommand("e2e-tree-snapshot");
			const jumped = JSON.parse(readFileSync(snapshotPath, "utf8"));
			const event = JSON.parse(readFileSync(eventPath, "utf8"));
			expect(event.oldLeafId).toBe(original.leaf);
			expect(event.newLeafId).toBe(target);
			expect(event.actualLeaf).toBe(jumped.leaf);
			expect(jumped.branch.some((entry: any) => entry.id === indexed.message_id)).toBe(false);
			for (let i = 0; i < 12; i++) await h.sendPrompt(session, `replacement_${i} ${h.ballast(1500)}`);
			await h.invokeExtensionCommand("ctx-wrapup 2");
			const cutoff = () => (db.prepare("SELECT MAX(end_message) AS n FROM compartments WHERE session_id = ? AND rebase_status != 'unresolved'").get(session) as { n: number | null }).n ?? 0;
			await h.waitFor(() => cutoff() >= indexed.ordinal, { timeoutMs: 30000, label: "active summary covers the reused abandoned ordinal" });
			expect(cutoff()).toBeGreaterThanOrEqual(indexed.ordinal);

			const search = async (query: string) => {
				const id = `toolu_search_${crypto.randomUUID().replaceAll("-", "")}`;
				harness.mock.script([{ content: [{ type: "tool_use", id, name: "ctx_search", input: { query, sources: ["message"] } }], stop_reason: "tool_use", usage: { input_tokens: 500, output_tokens: 20 } }]);
				await harness.sendPrompt(session, "Search the archived conversation.");
				for (const request of [...harness.mock.requests()].reverse()) {
					for (const message of (request.body.messages ?? []) as Array<{ content?: unknown }>) {
						if (!Array.isArray(message.content)) continue;
						for (const block of message.content) if (block.type === "tool_result" && block.tool_use_id === id) return JSON.stringify(block.content);
					}
				}
				throw new Error(`ctx_search result missing for ${id}`);
			};
			const abandonedResult = await search(abandoned);
			const legitimateResult = await search(legitimate);
			const invocation = resolvePiHostInvocation(host);
			writeFileSync(join(fixture, "observations.json"), JSON.stringify({ host, version: JSON.parse(readFileSync(invocation.packageJson, "utf8")).version, indexed, cutoff: cutoff(), event, abandonedResult, legitimateResult }, null, 2));
			console.log(`${host} tree search evidence ${fixture}: old ordinal ${indexed.ordinal}, cutoff ${cutoff()}`);
			expect(abandonedResult).toContain("No results");
			expect(legitimateResult).toContain(legitimate);
			expect(legitimateResult).toContain("ctx_expand");
			h.assertHistorianRequestsUseMock();
		} finally {
			if (h) {
				writeFileSync(join(fixture, "diagnostics.txt"), h.diagnostics());
				writeFileSync(join(fixture, "requests.json"), JSON.stringify(h.mock.requests()));
			}
			await h?.dispose();
		}
	}, 240000);
});
