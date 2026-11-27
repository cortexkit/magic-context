import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	type RpcPortFileRecord,
	rpcPortDir,
} from "../../../plugin/src/shared/rpc-utils";
import {
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

/**
 * The TUI's `/ctx-flush` calls the `flush` RPC handler. The next request must
 * allow queued drops and cleanup as a user flush, not as a system change or fit
 * retry. With nothing queued, that permission does not require rewriting the prefix.
 */
const HEURISTICS_DECISION = "heuristics WILL";
const EXPLICIT_FLUSH = "heuristics WILL RUN — reason=pending_materialization origin=user_flush";

async function eventually<T>(
	read: () => T | undefined,
	what: string,
	timeoutMs = 15_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(50);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Pass decisions this session logged. The logger buffers, so callers poll. */
function decisions(logPath: string, sessionID: string): string[] {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter(
			(line) =>
				line.includes(`[${sessionID}]`) && line.includes(HEURISTICS_DECISION),
		);
}

test("the /ctx-flush RPC opens the reclaim gate on the next OpenCode 2 request only", async () => {
	const fixture = isolation();
	const logPath = join(fixture.root, "magic-context-flush.log");
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		providerID: "anthropic",
	});
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "ctx-flush effect",
			location: { directory: host.cwd },
			model: { providerID: "anthropic", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.setDefault({
			text: "flush fixture reply",
			usage: { input_tokens: 140, output_tokens: 12 },
		});

		const prompt = async (text: string): Promise<void> => {
			await client.session.prompt({ sessionID: session.id, text });
			await client.session.wait(
				{ sessionID: session.id },
				{ signal: AbortSignal.timeout(30_000) },
			);
		};

		await prompt("first turn before the flush");
		await prompt("second turn before the flush");
		// Control: wait until both ordinary turns have recorded a decision, then
		// require that neither of them claimed an explicit flush. Without the
		// wait an unflushed log would make this pass while proving nothing.
		const control = await eventually(
			() => {
				const seen = decisions(logPath, session.id);
				return seen.length >= 2 ? seen : undefined;
			},
			"the two control turns to record a pass decision",
		);
		expect(control.filter((line) => line.includes(EXPLICIT_FLUSH))).toEqual([]);

		const storageDir = join(
			host.env.XDG_DATA_HOME as string,
			"cortexkit",
			"magic-context",
		);
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
		}, "the v2 RPC discovery file");

		// The same call the TUI's /ctx-flush command makes.
		const response = await fetch(
			`http://127.0.0.1:${discovery.port}/rpc/flush`,
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
		const flushed = (await response.json()) as { ok: boolean; message?: string };
		expect(flushed.ok).toBe(true);
		expect(flushed.message).toBeString();

		await prompt("turn after the flush");
		await prompt("ordinary turn after the flush was consumed");
		const afterFlush = await eventually(
			() => {
				const seen = decisions(logPath, session.id);
				return seen.length >= 4 ? seen : undefined;
			},
			"both turns after the flush to record a pass decision",
		);
		expect(afterFlush.map((line) => line.includes(EXPLICIT_FLUSH))).toEqual([false, false, true, false]);
		expect(readFileSync(join(fixture.root, "llm-schema-guard.jsonl"), "utf8")).toContain(`PASS ${session.id} `);
	} catch (error) {
		console.error(host.stdout(), host.stderr());
		throw error;
	} finally {
		await host.stop();
	}
}, 120_000);
