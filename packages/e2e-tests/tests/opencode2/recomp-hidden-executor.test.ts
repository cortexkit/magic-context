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
	// /ctx-recomp on OpenCode 2 used to fail every time with MC-R01 ("undefined is
	// not an object (evaluating 'client.session')"): the rebuild reached for the
	// OpenCode 1 SDK client, which this host does not give a plugin. It now runs
	// the historian through the same hidden-completion executor the incremental
	// historian uses here. The test proves the whole loop on a real host: the
	// command publishes compartments, and the next turn renders them.
	test(`OpenCode 2 /ctx-recomp publishes through the hidden executor and the next pass renders it (${kind}, reopen=${reopen})`, async () => {
		const { fixture, mock, provider, sessionId } =
			await commandStoreFixture(kind);
		const logPath = join(fixture.root, "recomp.log");
		fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
		const options = {
			existingIsolation: fixture,
			existingMock: { mock, baseURL: provider.baseURL },
			modelContextLimit: 200_000,
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
						title: "recomp hidden completion",
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
					text: `<compartment start="${range[1]}" end="${range[2]}" title="Rebuilt by recomp"><p1>The rebuilt history keeps the source turns.</p1></compartment>`,
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
			const db = new Database(
				join(
					host.env.XDG_DATA_HOME!,
					"cortexkit",
					"magic-context",
					"context.db",
				),
				{ readonly: true, fileMustExist: true },
			);
			try {
				const count = () =>
					(
						db
							.prepare(
								"SELECT COUNT(*) AS count FROM compartments WHERE session_id = ?",
							)
							.get(session.id) as { count: number }
					).count;
				expect(count()).toBe(0);
				await client.session.command({
					sessionID: session.id,
					name: "ctx-recomp",
					text: "",
				});
				const deadline = Date.now() + 60_000;
				while (count() === 0 && Date.now() < deadline) await Bun.sleep(100);
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
				expect(count()).toBeGreaterThan(0);
			} finally {
				db.close();
			}

			// The buffered log catches up after the run finishes.
			const logDeadline = Date.now() + 30_000;
			let log = "";
			while (!log.includes("recomp finished") && Date.now() < logDeadline) {
				await Bun.sleep(100);
				log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
			}
			console.error(
				log
					.split("\n")
					.filter(
						(line) =>
							line.includes("[rpc] recomp") || line.includes("recomp finished"),
					)
					.join("\n"),
			);
			expect(log).toContain("recomp finished (published=true)");
			expect(log).not.toContain("MC-R01");
			expect(log).not.toContain("client.session");
			expect(log).not.toContain("generation mismatch");
			expect(log).not.toContain("compaction-marker");
			expect(legacyStoreSnapshot(fixture.openCodeDbPath, kind)).toBe(
				legacyBefore,
			);

			const before = host.mock.requests().length;
			const marker = "first turn after the rebuild";
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
			expect(JSON.stringify(served[0]!.body)).toContain(
				"The rebuilt history keeps the source turns.",
			);
		} catch (error) {
			console.error(
				host.stderr().slice(-4_000),
				existsSync(logPath)
					? readFileSync(logPath, "utf8").slice(-20_000)
					: "(no plugin log)",
			);
			throw error;
		} finally {
			await host.stop();
		}
	}, 180_000);
}
