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
		const options = {
			existingIsolation: fixture,
			existingMock: { mock, baseURL: provider.baseURL },
			modelContextLimit: 16_000,
			modelOutputLimit: 1_024,
			magicContextConfig: {
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
			for (let index = 0; index < 6; index++) {
				await client.session.prompt({
					sessionID: session.id,
					text: `Source turn ${index}: ${"durable history ".repeat(80)}`,
				});
				await client.session.wait(
					{ sessionID: session.id },
					{ signal: AbortSignal.timeout(30_000) },
				);
			}
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
				const row = db
					.prepare(
						"SELECT COUNT(*) AS count FROM compartments WHERE session_id = ?",
					)
					.get(session.id) as { count: number };
				expect(row.count).toBe(0);
				await client.session.command({
					sessionID: session.id,
					name: "ctx-wrapup",
					text: "2",
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
				// Wrapup deliberately defers publication until a priced pass. Flush is
				// the user's explicit request to consume it on the very next message.
				await client.session.command({
					sessionID: session.id,
					name: "ctx-flush",
					text: "",
				});
				const before = host.mock.requests().length;
				const marker = "first turn after wrapup";
				await client.session.prompt({ sessionID: session.id, text: marker });
				await client.session.wait(
					{ sessionID: session.id },
					{ signal: AbortSignal.timeout(30_000) },
				);
				const served = host.mock
					.requests()
					.slice(before)
					.filter((request) => JSON.stringify(request.body).includes(marker));
				expect(served).toHaveLength(1);
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
				expect(JSON.stringify(served[0]!.body)).toContain(
					"The source turns record durable history.",
				);
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
