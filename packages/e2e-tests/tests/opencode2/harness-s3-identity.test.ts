import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { spawnOpencode2, waitForPluginActive } from '../../src/opencode2-runner/spawn';

test("R12 v2 setup selects opencode2 before session storage opens", async () => {
	const host = await spawnOpencode2();
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.addMatcher(() => ({
			text: "Done.",
			usage: { input_tokens: 100, output_tokens: 10 },
		}));
		await client.session.prompt({ sessionID: session.id, text: "Reply briefly." });
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20000) },
		);
		const db = openTestDb(
			join(host.env.XDG_DATA_HOME!, "cortexkit/magic-context/context.db"),
			{ readonly: true },
		);
		try {
			expect(
				db.query("SELECT harness FROM session_meta WHERE session_id = ?")
					.get(session.id),
			).toEqual({ harness: "opencode2" });
		} finally {
			db.close();
		}
	} finally {
		await host.stop();
	}
}, 60000);
