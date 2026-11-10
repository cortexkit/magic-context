import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

const NOTICE = "Context full — /ctx-flush or /clear to continue.";

test("provider-proven emergency pressure stores a visible refusal before v2 interrupts", async () => {
	const host = await spawnOpencode2({
		modelContextLimit: 100_000,
		modelOutputLimit: 1_024,
		magicContextConfig: {
			historian: { disable: true },
			dreamer: { disable: true },
			memory: { enabled: false },
		},
	});
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "emergency refusal visibility",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.setDefault({
			error: {
				status: 400,
				type: "invalid_request_error",
				message: "prompt is too long: 1091002 tokens > 100000 maximum",
			},
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "arm provider-proven overflow",
		});
		await client.session
			.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) })
			.catch(() => undefined);
		await Bun.sleep(100);

		const providerRequests = host.mock.requests().length;
		host.mock.setDefault({
			text: "must not reach provider",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "blocked follow-up",
		});
		await client.session
			.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) })
			.catch(() => undefined);

		expect(host.mock.requests()).toHaveLength(providerRequests);
		const dataHome = host.env.XDG_DATA_HOME;
		const databaseName = host.env.OPENCODE_DB;
		if (!dataHome || !databaseName)
			throw new Error("isolated store path is unavailable");
		const db = openTestDb(join(dataHome, "opencode", databaseName), {
			readonly: true,
		});
		try {
			const rows = db
				.prepare(
					"SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 4",
				)
				.all(session.id) as Array<{ type: string; data: string }>;
			const decoded = rows.map((row) => ({
				...row,
				data: JSON.parse(row.data),
			}));
			expect(decoded).toContainEqual({
				type: "synthetic",
				data: expect.objectContaining({ text: NOTICE }),
			});
			expect(decoded).toContainEqual({
				type: "idle",
				data: expect.objectContaining({ outcome: "interrupted" }),
			});
		} finally {
			db.close();
		}
	} finally {
		await host.stop();
	}
}, 120_000);
