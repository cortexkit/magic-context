import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	type RpcPortFileRecord,
	rpcPortDir,
} from "../../../plugin/src/shared/rpc-utils";
import {
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

async function eventually<T>(
	read: () => T | undefined,
	timeoutMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(25);
	}
	throw new Error("timed out waiting for v2 RPC discovery");
}

test("v2_rpc_listener_publishes_nonzero_sidebar_snapshot_after_prompt", async () => {
	const host = await spawnOpencode2({ providerID: "anthropic" });
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "anthropic", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.setDefault({
			text: "RPC sidebar fixture reply",
			usage: { input_tokens: 137, output_tokens: 11 },
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "RPC sidebar fixture prompt",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(20_000) },
		);

		const dataHome = host.env.XDG_DATA_HOME;
		if (!dataHome) throw new Error("v2 fixture is missing XDG_DATA_HOME");
		const storageDir = join(dataHome, "cortexkit", "magic-context");
		const sessionMeta = await eventually(() => {
			const databasePath = join(storageDir, "context.db");
			if (!existsSync(databasePath)) return undefined;
			const db = openTestDb(databasePath, { readonly: true });
			try {
				const row = db
					.prepare<
						[string],
						{ last_input_tokens: number; last_context_percentage: number }
					>(
						"SELECT last_input_tokens, last_context_percentage FROM session_meta WHERE session_id = ? AND harness = 'opencode2'",
					)
					.get(session.id);
				return row && row.last_input_tokens > 0 ? row : undefined;
			} finally {
				db.close();
			}
		});
		expect(sessionMeta.last_input_tokens).toBeGreaterThan(0);

		const discovery = await eventually(() => {
			const directory = rpcPortDir(storageDir, host.cwd);
			if (!existsSync(directory)) return undefined;
			const file = readdirSync(directory).find(
				(name) => name.startsWith("port-") && name.endsWith(".json"),
			);
			return file
				? (JSON.parse(
						readFileSync(join(directory, file), "utf8"),
					) as RpcPortFileRecord)
				: undefined;
		});
		expect(discovery.port).toBeGreaterThan(0);

		const response = await fetch(
			`http://127.0.0.1:${discovery.port}/rpc/sidebar-snapshot`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${discovery.token}`,
				},
				body: JSON.stringify({ sessionId: session.id, directory: host.cwd }),
			},
		);
		expect(response.status).toBe(200);
		const snapshot = (await response.json()) as {
			inputTokens: number;
			usagePercentage: number;
			contextLimit: number;
		};
		expect(snapshot.inputTokens).toBeGreaterThan(0);
		expect(snapshot.usagePercentage).toBeGreaterThan(0);
		expect(snapshot.contextLimit).toBeGreaterThan(0);
	} catch (error) {
		console.error(host.stdout(), host.stderr());
		throw error;
	} finally {
		await host.stop();
	}
}, 60_000);
