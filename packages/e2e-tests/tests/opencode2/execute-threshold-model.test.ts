import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { join } from "node:path";
import {
	inspectOpenFiles,
	isolation,
	spawnOpencode2,
	waitForPluginActive,
	waitForPluginLog,
} from "../../src/opencode2-runner/spawn";

const MODEL = "muse-spark-1.3-contributor-free";
const MODEL_KEY = `opencode/${MODEL}`;

test("OpenCode 2 honors the exact per-model threshold and proactive floor with a mock provider", async () => {
	const fixture = isolation();
	const host = await spawnOpencode2({
		existingIsolation: fixture,
		magicContextPlugin: process.env.MC_E2E_THRESHOLD_PLUGIN,
		// A published snapshot must initialize its own schema, not the newer
		// source tree's pre-migrated fixture.
		prepareContextDatabase: !process.env.MC_E2E_THRESHOLD_PLUGIN,
		providerID: "opencode",
		defaultModelID: MODEL,
		// The output-reserved usable window is exactly the reporter's 917504.
		modelContextLimit: 1_048_576,
		modelOutputLimit: 131_072,
		compactionAuto: false,
		magicContextConfig: {
			execute_threshold_percentage: {
				default: 50,
				"opencode/mimo-v2.6-flash-free": 65,
				[MODEL_KEY]: 20,
			},
			cache_ttl: { default: "5m", [MODEL_KEY]: "1h" },
			output_reserve: { default: 0, [MODEL_KEY]: 131_072 },
			historian: { two_pass: false },
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
			title: "per-model threshold",
			location: { directory: host.cwd },
			model: { providerID: "opencode", id: MODEL },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.addMatcher((body) => {
			const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
			if (!range) return null;
			return {
				text: `<compartment start="${range[1]}" end="${range[2]}" title="Earlier work"><p1>Earlier work was completed.</p1></compartment>`,
				usage: { input_tokens: 100, output_tokens: 40 },
			};
		});
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
		// Enough genuine history to leave an eligible head outside the protected
		// tail. Reported provider usage alone cannot create something to summarize.
		for (let turn = 0; turn < 7; turn++) {
			await prompt(
				`under threshold ${turn} ${"older history fact ".repeat(1800)}`,
				100_000,
			);
		}
		await prompt("over threshold", 284_298);
		await prompt("observe previous response", 284_298);
		const log = await waitForPluginLog(
			host.env,
			"inputTokens=284298 cacheTtl=",
		);
		const lines = log
			.split("\n")
			.filter((line) => line.includes(`[${session.id}]`));
		const under = lines.find(
			(line) =>
				line.includes("transform scheduler:") &&
				line.includes("inputTokens=100000 "),
		);
		const over = lines.find(
			(line) =>
				line.includes("transform scheduler:") &&
				line.includes("inputTokens=284298 "),
		);
		console.log(
			lines
				.filter((line) =>
					/v2 usage:|transform scheduler:|transform threshold:/.test(line),
				)
				.join("\n"),
		);
		const paths = inspectOpenFiles(host.pid!, host.root, host.env).filter(
			(path) => /\.db(-wal|-shm)?$/.test(path),
		);
		expect(paths.length).toBeGreaterThan(0);
		for (const path of paths) expect(path.startsWith(host.root)).toBe(true);
		console.log(
			`host pid=${host.pid} throwaway databases: ${JSON.stringify(paths)}`,
		);
		expect(under).toContain("decision=defer");
		expect(over).toContain("decision=execute");
		expect(over).toContain("cacheTtl=1h");
		expect(
			lines.some(
				(line) =>
					line.includes(`contextLimit=917504`) &&
					line.includes(`responseModel=${MODEL_KEY}`),
			),
		).toBe(true);
		expect(
			lines.some((line) =>
				line.includes(
					`transform threshold: model=${MODEL_KEY} matchedModel=${MODEL_KEY} mode=percentage threshold=20% proactiveFloor=18%`,
				),
			),
		).toBe(true);
		expect(log).toContain("below proactive floor (18%)");
		// The historian may choose the size trigger before the pressure trigger;
		// both use the selected model's working budget and eligible history.
		const triggerLog = await waitForPluginLog(
			host.env,
			"historian publish completed: compartments=1",
			30_000,
		);
		expect(triggerLog).toContain("compartment trigger: firing");
		expect(triggerLog).toContain("historian publish completed: compartments=1");

		// Inspect only the throwaway plugin store: the session TTL must be frozen
		// against the model, rather than a default captured before it was known.
		const db = openTestDb(
			join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"),
			{ readonly: true },
		);
		try {
			expect(
				db
					.query("SELECT cache_ttl FROM session_meta WHERE session_id = ?")
					.get(session.id),
			).toEqual({ cache_ttl: "1h" });
			const published = db
				.query("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?")
				.get(session.id) as { n: number };
			expect(published.n).toBeGreaterThan(0);
		} finally {
			db.close();
		}
	} catch (error) {
		console.error(host.stderr().slice(-4000), host.pluginLog().slice(-8000));
		throw error;
	} finally {
		await host.stop();
	}
}, 120_000);
