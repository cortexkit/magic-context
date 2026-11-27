import { expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { gaDatabasePath } from "../../../plugin/src/v2/store-reader";
import {
	inspectOpenFiles,
	isolation,
	readPluginLog,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

/**
 * With Magic Context's compaction off, the host's own compaction must run for a
 * user session exactly as if Magic Context registered no compaction hook.
 *
 * Magic Context registers its compaction hook in every mode, because hidden
 * children need an answer even when compaction is off. For a user session in
 * compaction-off mode the hook leaves `result` unset. This pins that an unset
 * result is a clean decline on the real host: the host summarizes with the
 * model, stores a completed checkpoint, and the turn goes on to the provider
 * with that checkpoint, instead of recording `compaction.failed` and ending the
 * turn.
 */
const TEMPLATE_PROMPT = "You MUST use this format for your response";
const SUMMARY = "## Objective\n- keep the fixture conversation going\n\n## Next Move\n1. answer the next turn";
const WINDOW = 20_000;

test("with compaction off, the host's own compaction of a user session succeeds and the turn continues", async () => {
	const host = await spawnOpencode2({
		modelContextLimit: WINDOW,
		magicContextConfig: {
			compaction: { enabled: false },
			memory: { enabled: false },
			historian: { disable: true },
			dreamer: { disable: true },
		},
	});
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "compaction off",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.addMatcher((body) =>
			JSON.stringify(body).includes(TEMPLATE_PROMPT)
				? { text: SUMMARY, usage: { input_tokens: 400, output_tokens: 40 } }
				: null,
		);
		// The first reply reports a prompt just under the window, so the measured size
		// alone puts the next turn over the host's compaction threshold.
		host.mock.setDefault({
			text: "first reply",
			usage: { input_tokens: WINDOW - 600, output_tokens: 10 },
		});
		const turn = async (text: string) => {
			await client.session.prompt({ sessionID: session.id, text });
			await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
		};
		await turn("first turn");
		host.mock.setDefault({ text: "second reply", usage: { input_tokens: 600, output_tokens: 10 } });
		const before = host.mock.requests().length;
		await turn("second turn");

		const rows = (() => {
			const db = new Database(gaDatabasePath(host.env.XDG_DATA_HOME as string, "latest", host.env), {
				readonly: true,
			});
			try {
				db.exec("PRAGMA busy_timeout = 5000");
				return (
					db
						.prepare("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq")
						.all(session.id) as Array<{ type: string; data: string }>
				).map((row) => ({ type: row.type, data: JSON.parse(row.data) as Record<string, unknown> }));
			} finally {
				db.close();
			}
		})();
		const compactions = rows.filter((row) => row.type === "compaction");
		console.log(
			`[compaction-off] host=${process.env.MC_E2E_OPENCODE2_CLI ?? "pinned"} rows=${rows.map((row) => row.type).join(",")} compactions=${JSON.stringify(compactions.map((row) => ({ status: row.data.status, reason: row.data.reason, summary: String(row.data.summary).slice(0, 40) })))} requests=${host.mock.requests().length}`,
		);
		// The host's own model-written summary, stored as completed checkpoints: some
		// releases compact again once the first checkpoint's measured size is known,
		// so the count is the host's business, but every one must be the host's own
		// summary and none may have failed.
		expect(compactions.length).toBeGreaterThan(0);
		for (const compaction of compactions) {
			expect(compaction.data.status).toBe("completed");
			expect(String(compaction.data.summary)).toContain("## Objective");
		}
		const idle = rows.filter((row) => row.type === "idle").at(-1);
		expect(idle?.data.outcome).not.toBe("failed");

		const after = host.mock.requests().slice(before).map((request) => JSON.stringify(request.body));
		const summaryRequest = after.findIndex((body) => body.includes(TEMPLATE_PROMPT));
		expect(summaryRequest).toBeGreaterThanOrEqual(0);
		// The turn then reached the provider, opening with the host's checkpoint.
		const continued = after.slice(summaryRequest + 1);
		expect(continued.some((body) => body.includes("conversation-checkpoint") && body.includes("second turn"))).toBe(
			true,
		);
		expect(readPluginLog(host.env)).not.toContain("v2 compaction hook: fired");
	} catch (error) {
		console.error(host.stderr(), readPluginLog(host.env));
		throw error;
	} finally {
		await host.stop();
	}
}, 180_000);

/**
 * With Magic Context's compaction off and the host's automatic compaction on,
 * the request after the host's checkpoint is the checkpoint plus the tail the
 * host kept, so it is far smaller than the request before it and the host does
 * not compact again. Magic Context used to put back every stored message from
 * before the checkpoint, so the request never shrank and the host compacted
 * again on every following step.
 *
 * The mock reports each request's input tokens from its size, as a real
 * provider would, so the host's usage reading follows what was actually sent.
 */
const CHECKPOINT_WINDOW = 40_000;
const BALLAST =
	"The service retries each failed upload with exponential backoff, records the attempt in the audit table, and moves on to the next queued item. ";
// About 1.5k tokens per turn, so the host's checkpoint summarizes many turns and
// keeps only the newest few.
const ballastTurn = (turn: number) => `checkpoint-scenario turn ${turn}: ${BALLAST.repeat(40)}`;
const turnMarkers = (text: string) =>
	[...new Set([...text.matchAll(/checkpoint-scenario turn (\d+):/g)].map((match) => Number(match[1])))];

test("with compaction off, the host's checkpoint shrinks the next request and compaction does not repeat (issue 944)", async () => {
	const namespace = join(tmpdir(), "magic-context");
	mkdirSync(namespace, { recursive: true });
	const fixture = isolation(createTestTempDirFromPath(join(namespace, "issue-944-")));
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		modelContextLimit: CHECKPOINT_WINDOW,
		modelOutputLimit: 1_024,
		// The reported configuration: automatic compaction with a fifth of the
		// window kept free, written as the token count every host version accepts.
		compactionConfig: { auto: true, buffer: CHECKPOINT_WINDOW / 5, keep: { tokens: 1_024 } },
		magicContextConfig: {
			compaction: { enabled: false },
			memory: { enabled: false },
			historian: { disable: true },
			dreamer: { disable: true },
		},
	});
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "compaction off checkpoint",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.addMatcher((body) => {
			const text = JSON.stringify(body);
			return {
				text: text.includes(TEMPLATE_PROMPT) ? SUMMARY : "noted",
				usage: { input_tokens: Math.ceil(text.length / 4), output_tokens: 10 },
			};
		});
		const compactions = () => {
			const db = new Database(gaDatabasePath(host.env.XDG_DATA_HOME as string, "latest", host.env), {
				readonly: true,
			});
			try {
				db.exec("PRAGMA busy_timeout = 5000");
				return (
					db
						.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'compaction' ORDER BY seq")
						.all(session.id) as Array<{ data: string }>
				).map((row) => JSON.parse(row.data) as Record<string, unknown>);
			} finally {
				db.close();
			}
		};
		type Turn = {
			turn: string;
			/** Completed host compactions once the turn ended. */
			compactions: number;
			timedOut: boolean;
			requests: Array<{ bytes: number; summary: boolean; checkpoint: boolean; markers: number[] }>;
		};
		const turns: Turn[] = [];
		const turn = async (label: string, text: string) => {
			const before = host.mock.requests().length;
			await client.session.prompt({ sessionID: session.id, text });
			let timedOut = false;
			try {
				await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(90_000) });
			} catch {
				// Recorded rather than thrown, so the report below still shows what was sent.
				timedOut = true;
			}
			turns.push({
				turn: label,
				compactions: compactions().filter((row) => row.status === "completed").length,
				timedOut,
				requests: host.mock
					.requests()
					.slice(before)
					.map((request) => {
						const body = JSON.stringify(request.body);
						return {
							bytes: body.length,
							summary: body.includes(TEMPLATE_PROMPT),
							// The host's checkpoint carries the summary the mock wrote.
							checkpoint: !body.includes(TEMPLATE_PROMPT) && body.includes("keep the fixture conversation going"),
							markers: turnMarkers(body),
						};
					}),
			});
		};
		for (let big = 1; big <= 30 && !turns.at(-1)?.compactions; big++) await turn(`turn ${big}`, ballastTurn(big));
		for (let followUp = 1; followUp <= 3; followUp++)
			await turn(`follow-up ${followUp}`, `checkpoint-scenario follow-up ${followUp}: what is next?`);

		const openDatabases = inspectOpenFiles(host.pid!, host.root, host.env).filter((path) =>
			/\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(path),
		);
		console.log(
			`[issue-944] host=${process.env.MC_E2E_OPENCODE2_CLI ?? "pinned"} root=${host.root} openDatabases=${JSON.stringify([...new Set(openDatabases)])}`,
		);
		for (const entry of turns) console.log(`[issue-944] ${JSON.stringify(entry)}`);
		const root = realpathSync(host.root);
		for (const path of openDatabases) expect(path.startsWith(`${root}/`)).toBe(true);

		// The turn the host compacted in, and the turns before and after it.
		const compacted = turns.findIndex((entry) => entry.compactions > 0);
		expect(compacted).toBeGreaterThan(0);
		const main = (entries: Turn[]) => entries.flatMap((entry) => entry.requests.filter((request) => !request.summary));
		const before = main(turns.slice(0, compacted)).at(-1)!;
		const after = main(turns.slice(compacted));
		const summarized = new Set(
			turns.flatMap((entry) => entry.requests.filter((request) => request.summary)).flatMap((request) => request.markers),
		);
		console.log(
			`[issue-944] summarized turns=${JSON.stringify([...summarized])} last request before the checkpoint=${before.bytes}B (~${Math.ceil(before.bytes / 4)} tokens) requests after=${JSON.stringify(after.map((request) => request.bytes))}B compactions=${turns.at(-1)!.compactions}`,
		);
		expect(summarized.size).toBeGreaterThan(0);
		expect(after.length).toBeGreaterThanOrEqual(3);
		for (const request of after) {
			// The host's checkpoint is served, and nothing it summarized comes back.
			expect(request.checkpoint).toBe(true);
			expect(request.markers.filter((marker) => summarized.has(marker))).toEqual([]);
			// So the request shrinks well below the one that triggered compaction...
			expect(request.bytes).toBeLessThan(before.bytes * 0.75);
		}
		// ...and the host does not compact again.
		expect(turns.every((entry) => !entry.timedOut)).toBe(true);
		expect(turns.at(-1)!.compactions).toBe(1);
		expect(compactions().filter((row) => row.status !== "completed")).toEqual([]);
	} catch (error) {
		console.error(host.stderr().slice(-20_000), readPluginLog(host.env).slice(-20_000));
		throw error;
	} finally {
		await host.stop();
		if (process.env.MC_E2E_KEEP !== "1") cleanupTestTempDir(fixture.root);
	}
}, 900_000);
