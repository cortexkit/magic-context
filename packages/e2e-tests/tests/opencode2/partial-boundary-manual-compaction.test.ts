import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { moduleRawBlockMappings } from "../../../plugin/src/hooks/magic-context/module-wire";
import { Database } from "../../../plugin/src/shared/sqlite";
import { rawMessages } from "../../../plugin/src/v2/hooks/store";
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";
import {
	CLI,
	inspectOpenFiles,
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

// A compartment can end inside a stored message: it records the index of the
// last block it summarizes (`end_block_index`), and the message's later blocks
// are in no summary. Here the boundary message is a tool step whose call (block
// 0) is summarized and whose result (block 1) is not, as happens when the call
// was summarized before it completed. The shared transform keeps that message
// raw so the result still reaches the model. After a manual /compact the
// OpenCode 2 adapter restores the rows the host checkpoint replaced; before the
// fix it restored strictly after the boundary message, so the result vanished
// from every later request although nothing was deleted from the store.
//
// partial: the tool result is served once before the compaction, after it, on
//   the next turn and after a restart, and the request after the compaction
//   keeps the request before it as its exact prefix.
// whole-row: the same compartment without a block index covers the message;
//   the request after the compaction also keeps the earlier request as its
//   prefix, and the normalized request digest printed here was compared with
//   the base commit's on a real 2.1.0 host.

const MARKER = "UNSUMMARIZED_TOOL_RESULT_MARKER";
const CALL_ID = "call_read_marker";
const hostVersion = spawnSync(CLI, ["--version"], { env: isolation().env, encoding: "utf8" })
	.stdout.trim()
	.replace(/^opencode\s+v?/, "");
const [major = 0, minor = 0, patch = 0] = hostVersion.split(".").map(Number);
// OpenCode 2.3.1 added `compaction.background` and turned it on by default: the
// host then writes the summary after the turn instead of asking the compaction
// hook with a running checkpoint row. This scenario needs the hook to see that
// row on every host, so it turns background compaction off where it exists.
const backgroundCompactionHost =
	major > 2 || (major === 2 && (minor > 3 || (minor === 3 && patch >= 1)));

type Body = { model?: string; input?: unknown[] };

for (const arm of ["partial", "whole-row"] as const) {
	test(`OpenCode 2 manual compaction keeps a ${arm} tool-step boundary as it was served before`, async () => {
		const fixture = isolation();
		const logPath = join(fixture.root, "magic-context.log");
		fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
		const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
		const options = {
			existingIsolation: fixture,
			compactionConfig: {
				auto: false,
				buffer: 1024,
				keep: { tokens: 1024 },
				...(backgroundCompactionHost ? { background: false } : {}),
			},
			magicContextConfig: {
				cache_ttl: "never",
				temporal_awareness: false,
				historian: { disable: true },
				dreamer: { disable: true },
				memory: { enabled: false },
			},
		};
		let host = await spawnOpencode2(options);
		const mock = host.mock;
		const connect = () =>
			OpenCode.make({
				baseUrl: host.url,
				headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
			});
		let client = connect();
		try {
			const session = await client.session.create({
				location: { directory: host.cwd },
				model: { providerID: "openai", id: "mock-model" },
			});
			await waitForPluginActive(client, host.cwd);
			const file = join(host.cwd, "marker.txt");
			writeFileSync(file, `${MARKER}\n`);
			let issued = false;
			mock.addMatcher((body) => {
				if (body.model !== "mock-model")
					return { text: "Fixture title", usage: { input_tokens: 100, output_tokens: 10 } };
				if (issued || !JSON.stringify(body).includes("READ-MARKER")) return null;
				issued = true;
				return {
					openaiOutput: [
						{
							type: "function_call",
							id: "fc_read_marker",
							call_id: CALL_ID,
							name: "read",
							arguments: JSON.stringify({ path: file }),
						},
					],
					usage: { input_tokens: 100, output_tokens: 10 },
				};
			});
			mock.setDefault({ text: "ok", usage: { input_tokens: 100, output_tokens: 20 } });
			/** One user turn; returns the last session-model request, items as JSON. */
			const turn = async (text: string): Promise<string[]> => {
				const start = mock.requests().length;
				await client.session.prompt({ sessionID: session.id, text });
				await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
				const body = mock
					.requests()
					.slice(start)
					.map((request) => request.body as Body)
					.filter((candidate) => candidate.model === "mock-model")
					.at(-1);
				expect(body).toBeDefined();
				return (body!.input ?? []).map((item) => JSON.stringify(item));
			};
			const markers = (input: string[]) => input.join("\n").split(MARKER).length - 1;

			for (const k of [1, 2, 3]) await turn(`COVERED-${k} ${"older history ".repeat(40)}`);
			await turn("READ-MARKER please read marker.txt");
			expect(issued).toBe(true);
			for (const k of [1, 2, 3]) await turn(`TAIL-${k} ${"recent history ".repeat(40)}`);

			// The tool step: the assistant row holding the read call and its result.
			const reader = new V2StoreReader(gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env));
			const raw = rawMessages(reader.history(session.id));
			reader.close();
			const step = raw.find((message) => JSON.stringify(message.parts).includes(CALL_ID));
			expect(step).toBeDefined();
			const blocks = moduleRawBlockMappings(step!).map((block) => block.kind);
			// Precondition: the row ends with the call and its result.
			expect(blocks.slice(-2)).toEqual(["tool_call", "tool_result"]);
			const callBlock = blocks.length - 2;

			const mc = new Database(join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
			mc.exec("PRAGMA busy_timeout = 5000");
			mc.prepare(
				"INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, end_block_index, title, content, p1, created_at, harness) VALUES (?, 0, 1, ?, ?, ?, ?, 'Covered', 'SUMMARY-COVERED', 'SUMMARY-COVERED', ?, 'opencode2')",
			).run(
				session.id,
				step!.ordinal,
				raw[0]!.id,
				step!.id,
				arm === "partial" ? callBlock : null,
				Date.now(),
			);
			// A stale system-prompt hash on the cached history head (m[0]) makes the
			// next pass rebuild that head.
			mc.prepare("UPDATE session_meta SET cached_m0_system_hash = 'stale' WHERE session_id = ?").run(session.id);
			mc.close();
			await turn("PASS-A-PRICED");
			await turn("PASS-B");
			const before = await turn("PASS-C");
			expect(before.join("\n")).toContain("SUMMARY-COVERED");
			expect(before.some((item) => item.includes("COVERED-1"))).toBe(false);
			expect(markers(before)).toBe(arm === "partial" ? 1 : 0);

			const logStart = log().length;
			await client.session.compact({ sessionID: session.id });
			await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
			const after = await turn("AFTER-COMPACT");
			const next = await turn("NEXT");
			await host.stopHost();
			host = await spawnOpencode2({
				...options,
				existingIsolation: { root: host.root, env: host.env, cwd: host.cwd },
				existingMock: { mock, baseURL: host.mockBaseURL },
			});
			client = connect();
			await waitForPluginActive(client, host.cwd);
			const restarted = await turn("RESTARTED");
			// The compaction ran through Magic Context's hook with the running row.
			expect(log().slice(logStart)).toMatch(/v2 compaction hook|host checkpoint head/);

			for (const input of [after, next, restarted])
				expect(markers(input)).toBe(arm === "partial" ? 1 : 0);
			// The checkpoint only replaced rows the request already served: each
			// request keeps the one before it as its exact prefix.
			expect(after.slice(0, before.length)).toEqual(before);
			expect(next.slice(0, after.length)).toEqual(after);
			expect(restarted.slice(0, next.length)).toEqual(next);

			const normalize = (input: string[]) =>
				input
					.join("\n")
					.split(host.root)
					.join("<root>")
					.replace(/\b(ses|msg|prt|call|fc|rs)_[A-Za-z0-9_]+/g, "$1_<id>");
			const digest = (input: string[]) =>
				createHash("sha256").update(normalize(input)).digest("hex").slice(0, 16);
			console.log(
				`[${arm}] host ${hostVersion} normalized request digests before=${digest(before)} after=${digest(after)} next=${digest(next)} restarted=${digest(restarted)}`,
			);
			// Captured on a real 2.1.0 host from commit ebf0bf06ea, the last commit
			// before partly summarized boundary rows were restored: a whole-row
			// boundary must still serve exactly these requests. Other host versions
			// frame the request differently, so the pin is per version.
			if (arm === "whole-row" && hostVersion === "2.1.0")
				expect([before, after, next, restarted].map(digest)).toEqual([
					"b3d055223904d001",
					"2a547abf9c9f463f",
					"52b11125ede483bd",
					"5fcc9aeb7b03cde3",
				]);
			if (process.env.MC_PARTIAL_BOUNDARY_DUMP === "1")
				for (const [name, input] of [["before", before], ["restarted", restarted]] as const)
					for (const [index, line] of normalize(input).split("\n").entries())
						console.log(`DUMP ${arm} ${name} ${index} ${line.slice(0, 600)}`);

			// Every database the host process holds open lives under the throwaway root.
			const openDatabases = inspectOpenFiles(host.pid!, host.root, host.env).filter((path) =>
				/\.db(-wal|-shm)?$/.test(path),
			);
			expect(openDatabases.length).toBeGreaterThan(0);
			for (const path of openDatabases) expect(path.startsWith(host.root)).toBe(true);
			console.log(`[${arm}] host open databases: ${JSON.stringify(openDatabases)}`);
		} catch (error) {
			console.error(host.stderr().slice(-4000), log().slice(-8000));
			throw error;
		} finally {
			await host.stop();
		}
	}, 240_000);
}
