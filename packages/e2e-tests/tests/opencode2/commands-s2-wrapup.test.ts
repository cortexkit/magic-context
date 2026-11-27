import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import {
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

import {
	commandStoreFixture,
	legacyStoreSnapshot,
	recordCommandStoreContainment,
} from "../../src/opencode2-runner/command-store";

for (const { kind, reopen } of [
	{ kind: "pure-v2", reopen: false },
	{ kind: "pure-v2", reopen: true },
	{ kind: "converted-v1", reopen: true },
] as const) {
	// A command response alone cannot prove the hidden historian published anything.
	// Read only the throwaway context store owned by this host after the command returns.
	test(`OpenCode 2 /ctx-wrapup publishes compartments through the hidden executor (${kind}, reopen=${reopen})`, async () => {
		const { fixture, mock, provider, sessionId } =
			await commandStoreFixture(kind);
		const logPath = join(fixture.root, "wrapup.log");
		fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
		fixture.env.MC_OC2_HOST_FOLD_ROWS = "999999";
		const options = {
			existingIsolation: fixture,
			existingMock: { mock, baseURL: provider.baseURL },
			compactionAuto: false,
			modelContextLimit: 751_024,
			modelOutputLimit: 1_024,
			magicContextConfig: {
				cache_ttl: "never",
				execute_threshold_percentage: { default: 65, "openai/mock-model": 60 },
				memory: { enabled: false },
				dreamer: { disable: true },
				historian: { two_pass: false },
			},
		};
		let host = await spawnOpencode2(options);
		try {
			let client = OpenCode.make({
				baseUrl: host.url,
				headers: {
					authorization: `Basic ${btoa(`opencode:${host.password}`)}`,
				},
			});
			const session = sessionId
				? { id: sessionId }
				: await client.session.create({
						title: "wrapup hidden completion",
						location: { directory: host.cwd },
						model: { providerID: "openai", id: "mock-model" },
					});
			await waitForPluginActive(client, host.cwd);
			host.mock.setDefault({
				text: "ordinary turn",
				usage: { input_tokens: 100, output_tokens: 10 },
			});
			const turn = async (text: string) => {
				const offset = host.mock.requests().length;
				await client.session.prompt({ sessionID: session.id, text });
				await client.session.wait(
					{ sessionID: session.id },
					{ signal: AbortSignal.timeout(30_000) },
				);
				const requests = host.mock.requests().slice(offset).filter((request) =>
					JSON.stringify(request.body).includes(text),
				);
				expect(requests).toHaveLength(1);
				const input = requests[0]!.body.input;
				if (!Array.isArray(input)) throw new Error("No provider message array");
				return input;
			};
			let cached: unknown[] = [];
			for (let index = 0; index < 8; index++) {
				cached = await turn(`Source turn ${index}: ${"durable history ".repeat(35)}`);
			}
			expect(JSON.stringify(cached)).toContain("Source turn 0:");
			expect(JSON.stringify(cached)).not.toContain("The source turns record durable history.");
			let historianCalls = 0;
			host.mock.addMatcher((body) => {
				const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
				if (!range) return null;
				historianCalls++;
				return {
					text: `<compartment start="${range[1]}" end="${range[2]}" title="Source history"><p1>The source turns record durable history.</p1></compartment>`,
					usage: { input_tokens: 100, output_tokens: 40 },
				};
			});
			// Commands must also work on a reopened session before its first context hook.
			if (reopen) {
				await host.stopHost();
				host = await spawnOpencode2(options);
				client = OpenCode.make({
					baseUrl: host.url,
					headers: {
						authorization: `Basic ${btoa(`opencode:${host.password}`)}`,
					},
				});
				await waitForPluginActive(client, host.cwd);
			}
			recordCommandStoreContainment(host);
			const legacyBefore = legacyStoreSnapshot(fixture.openCodeDbPath, kind);
			if (!host.env.XDG_DATA_HOME)
				throw new Error("isolated data root is missing");
			const db = new Database(
				join(
					host.env.XDG_DATA_HOME,
					"cortexkit",
					"magic-context",
					"context.db",
				),
				{
					readonly: true,
					fileMustExist: true,
				},
			);
			try {
				db.exec("PRAGMA busy_timeout = 5000");
				const row = db
					.prepare(
						"SELECT COUNT(*) AS count FROM compartments WHERE session_id = ?",
					)
					.get(session.id) as { count: number };
				expect(row.count).toBe(0);
				await client.session.command({
					sessionID: session.id,
					name: "ctx-wrapup",
					text: "6",
				});
				const deadline = Date.now() + 30_000;
				let count = row.count;
				while (count === row.count && Date.now() < deadline) {
					await Bun.sleep(100);
					count = (
						db
							.prepare(
								"SELECT COUNT(*) AS count FROM compartments WHERE session_id = ?",
							)
							.get(session.id) as { count: number }
					).count;
				}
				expect(historianCalls).toBeGreaterThan(0);
				// This turn exists only in session_message, never in the converted v1 tables.
				expect(
					host.mock.requests().some((request) => {
						const body = JSON.stringify(request.body);
						return (
							/Messages \d+-\d+:/.test(body) && body.includes("Source turn 0:")
						);
					}),
				).toBe(true);
				expect(count).toBeGreaterThan(row.count);
				const settled = () =>
					(
						db
							.prepare(
								"SELECT wrapup_in_progress_state FROM session_meta WHERE session_id = ?",
							)
							.get(session.id) as { wrapup_in_progress_state: string | null }
					).wrapup_in_progress_state === null;
				while (!settled() && Date.now() < deadline) await Bun.sleep(100);
				expect(settled()).toBe(true);
				const published = db
					.prepare(
						"SELECT pending_compaction_marker_state FROM session_meta WHERE session_id = ?",
					)
					.get(session.id) as {
					pending_compaction_marker_state: string | null;
				};
				expect(published.pending_compaction_marker_state).toBeNull();
				expect(legacyStoreSnapshot(fixture.openCodeDbPath, kind)).toBe(
					legacyBefore,
				);
				const served = await turn("first turn after wrapup");
				console.error(
					host
						.pluginLog()
						.split("\n")
						.filter(
							(line) =>
								line.includes("[rpc] wrapup") || line.includes("wrapup chunk"),
						)
						.join("\n"),
				);
				expect(host.pluginLog()).not.toContain("generation mismatch");
				const line = host
					.pluginLog()
					.split("\n")
					.find((line) => line.includes("wrapup chunk 1:"));
				expect(line).toContain('"usable":450000');
				expect(line).toContain('"capTokens":192000');
				expect(JSON.stringify(served)).toContain(
					"The source turns record durable history.",
				);
				for (let index = 0; index < 5; index++) {
					expect(JSON.stringify(served)).not.toContain(`Source turn ${index}:`);
				}
				for (let index = 5; index < 8; index++) {
					expect(JSON.stringify(served)).toContain(`Source turn ${index}:`);
				}
				const baseline = (wire: unknown[]) => wire.find((item) => JSON.stringify(item).includes("<session-history>"));
				expect(baseline(cached)).toBeDefined();
				expect(JSON.stringify(baseline(served))).toBe(JSON.stringify(baseline(cached)));
				const defer = await turn("second turn after wrapup");
				expect(JSON.stringify(defer.slice(0, served.length))).toBe(JSON.stringify(served));
			} finally {
				db.close();
			}
		} catch (error) {
			console.error(
				host.stderr().slice(-4_000),
				existsSync(logPath) ? readFileSync(logPath, "utf8") : "(no plugin log)",
			);
			throw error;
		} finally {
			await host.stop();
		}
	}, 180_000);
}
