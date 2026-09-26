import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	isolation,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

/**
 * `execute_threshold_tokens` on OpenCode 2. The config sets an 80% percentage
 * threshold and a 20,000-token default on a 100k window, so the token threshold
 * (20%) is the one that must decide. The plugin logs one scheduler decision per
 * pass; each pass reads the usage the previous turn reported.
 *
 *   - 10,000 input tokens (10%) is under both thresholds: the next pass defers.
 *     This is the control, so an "execute" below cannot come from something
 *     other than the threshold (a cache-TTL expiry, say).
 *   - 30,000 input tokens (30%) is over the token threshold and under the
 *     percentage one: the next pass must execute. When the OpenCode 2 context
 *     hook did not hand the token threshold to the scheduler, this pass deferred.
 */
const CONTEXT_LIMIT = 100_000;

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

/**
 * The scheduler decision lines logged for the session `sessionID`, oldest first. The
 * logger buffers its writes, so callers poll until the line they expect appears.
 */
function schedulerLines(logPath: string, sessionID: string): string[] {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter(
			(line) =>
				line.includes(`[${sessionID}]`) &&
				line.includes("transform scheduler:"),
		);
}

test("OpenCode 2 executes a pass over execute_threshold_tokens below the percentage threshold", async () => {
	const fixture = isolation();
	const logPath = join(fixture.root, "magic-context-threshold.log");
	fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		modelContextLimit: CONTEXT_LIMIT,
		modelOutputLimit: 1024,
		compactionAuto: false,
		magicContextConfig: {
			execute_threshold_percentage: 80,
			execute_threshold_tokens: { default: 20_000 },
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
			title: "execute threshold tokens",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);

		const prompt = async (text: string, inputTokens: number) => {
			host.mock.setDefault({
				text: `reply to ${text}`,
				usage: { input_tokens: inputTokens, output_tokens: 20 },
			});
			await client.session.prompt({ sessionID: session.id, text });
			await client.session.wait(
				{ sessionID: session.id },
				{ signal: AbortSignal.timeout(30_000) },
			);
		};
		const decisionFor = (inputTokens: number) =>
			eventually(
				() =>
					schedulerLines(logPath, session.id).find((line) =>
						line.includes(`inputTokens=${inputTokens} `),
					),
				`a scheduler decision at inputTokens=${inputTokens}`,
			);

		await prompt("first turn", 10_000);
		await prompt("second turn", 30_000);
		await prompt("third turn", 30_000);

		const under = await decisionFor(10_000);
		expect(under).toContain("decision=defer");
		const over = await decisionFor(30_000);
		expect(over).toContain("decision=execute");
		expect(
			readFileSync(join(fixture.root, "llm-schema-guard.jsonl"), "utf8"),
		).toContain(`PASS ${session.id} `);
	} catch (error) {
		console.error(host.stdout(), host.stderr());
		throw error;
	} finally {
		await host.stop();
	}
}, 120_000);
