import { expect, test } from "bun:test";
import {
	existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { gaDatabasePath } from "../../../plugin/src/v2/store-reader";
import {
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";
import { providerSystemText } from "../../src/provider-system-text";
import { writeJsonAtomically } from "../../src/write-json-atomically";

const hasProbeSystem = (body: Record<string, unknown>, agent: string) =>
	providerSystemText(body).split("\n").includes(`DREAM_LOOP_${agent}`);

const hasMapperSystem = (body: Record<string, unknown>) =>
	providerSystemText(body).includes("memory mapper for the magic-context system");

async function waitFile(file: string) {
	const deadline = Date.now() + 25000;
	while (!existsSync(file)) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${file}`);
		await Bun.sleep(30);
	}
}

test("OpenCode 2 tool-loop families execute scoped tools across steps and remove their children", async () => {
    const stableRoot = join(tmpdir(), "magic-context", "opencode2-dream-loop");
    mkdirSync(stableRoot, { recursive: true });
    const stableTmp = realpathSync(stableRoot);
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = stableTmp;
    const bundle = mkdtempSync(join(stableTmp, "mc-dream-loop-"));
	const build = await Bun.build({
		entrypoints: [join(import.meta.dir, "dream-loop-probe.ts")],
		outdir: bundle,
		naming: "index.js",
		target: "node",
		format: "esm",
		define: { "process.env.NODE_ENV": '"production"' },
		external: ["bun:sqlite", "node:sqlite"],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const host = await spawnOpencode2({
		probePlugin: bundle,
		includeMagicContext: false,
		serviceMode: true,
	});
    try {
        expect(host.cwd.startsWith(stableTmp)).toBe(true);
        const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		await waitForPluginActive(client, host.cwd, "mc-dream-loop-probe");
		await waitFile(join(host.cwd, "dream-loop-ready"));
		const user = await client.session.create({
			title: "user",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		const families = [
			{ agent: "dreamer", name: "ctx_memory", value: "curate" },
			{ agent: "dreamer-memory-mapper", name: "read", value: "mapper" },
			{
				agent: "dreamer-retrospective",
				name: "ctx_search",
				value: "retrospective",
			},
		];
		let seq = 0;
		for (const family of families) {
			const name = family.name;
			let steps = 0;
			host.mock.addMatcher((body) => {
				if (!hasProbeSystem(body, family.agent)) return null;
				steps++;
				return steps === 1
					? {
							openaiOutput: [
								{
									type: "function_call",
									id: `fc_${seq}`,
									call_id: `call_${seq}`,
									name,
									arguments: JSON.stringify(
										name === "read"
											? { path: join(host.cwd, "fixture.txt") }
											: {
													value: family.value,
													...(name === "ctx_memory" ? { action: "write" } : {}),
												},
									),
								},
							],
							usage: { input_tokens: 100, output_tokens: 10 },
						}
					: {
							text:
								family.agent === "dreamer-retrospective"
									? '<learnings><learning route="memory" category="ARCHITECTURE">Use verified search evidence before revising project guidance.</learning></learnings>'
									: `MANIFEST_${family.value}`,
							usage: { input_tokens: 110, output_tokens: 10 },
						};
			});
			if (name === "read")
				writeFileSync(join(host.cwd, "fixture.txt"), "read-tool-result");
			const resultFile = join(host.cwd, `dream-loop-result-${seq}.json`);
			writeJsonAtomically(
				join(host.cwd, "dream-loop-command.json"),
				{ parent: user.id, seq, agent: family.agent },
			);
			await waitFile(resultFile);
			const result = JSON.parse(readFileSync(resultFile, "utf8"));
			if (!result.ok)
				throw new Error(
					`${family.agent}: ${result.error}; steps=${readFileSync(join(host.cwd, "hook-steps.jsonl"), "utf8")}`,
				);
			if (family.agent === "dreamer") {
				expect(result.completion.messages[0].parts[0].state).toMatchObject({
					status: "completed",
					input: { action: "write" },
				});
			}
			if (family.agent === "dreamer-retrospective") {
				expect(result.applied.memoryWritten).toBe(1);
			} else expect(result.completion.text).toBe(`MANIFEST_${family.value}`);
			expect(steps).toBe(2);
			const wire = host.mock
				.requests()
				.filter((r) => hasProbeSystem(r.body, family.agent));
			const fullSecondInput = wire[1]?.body.input as Array<{
				type: string;
				role?: string;
				content?: Array<{ text?: string }>;
			}>;
			// The host can put system instructions before the conversation as developer items.
			const secondInput = fullSecondInput.filter((item) => item.role !== "developer");
			expect(secondInput[0]?.content?.[0]?.text).toBe(
				`DREAM_PROMPT_${family.agent}`,
			);
			expect(JSON.stringify(fullSecondInput)).not.toContain("mc:hidden:");
			expect(secondInput[1]?.type).toBe("function_call");
			expect(secondInput[2]?.type).toBe("function_call_output");
			expect(JSON.stringify(secondInput)).toContain(
				name === "read" ? "read-tool-result" : `${name}-result:${family.value}`,
			);
			const db = new Database(
				gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env),
				{ readonly: true, fileMustExist: true },
			);
			try {
				db.exec("PRAGMA busy_timeout = 5000");
				const deadline = Date.now() + 12000;
				while (
					db.prepare("SELECT id FROM session_v2 WHERE id = ?").get(result.child)
				) {
					if (Date.now() > deadline) throw new Error("Child was not removed");
					await Bun.sleep(50);
				}
			} finally {
				db.close();
			}
			seq++;
		}
		let mapSteps = 0;
		writeFileSync(
			join(host.cwd, "src-fixture.ts"),
			"export const fixture = true;\n",
		);
		host.mock.addMatcher((body) => {
			if (!hasMapperSystem(body)) return null;
			mapSteps++;
			const text = JSON.stringify(body.input);
			const id = text.match(/\[(\d+)\]/)?.[1];
			if (!id)
				throw new Error(
					`Map request omitted memory id: ${text.slice(0, 2000)}`,
				);
			return mapSteps === 1
				? {
						openaiOutput: [
							{
								type: "function_call",
								id: "fc_map",
								call_id: "call_map",
								name: "read",
								arguments: JSON.stringify({
									path: join(host.cwd, "src-fixture.ts"),
								}),
							},
						],
						usage: { input_tokens: 100, output_tokens: 10 },
					}
				: {
						text: `<mappings><memory id="${id}" files="src-fixture.ts"/></mappings>`,
						usage: { input_tokens: 110, output_tokens: 10 },
					};
		});
		const mapFile = join(host.cwd, `dream-loop-result-${seq + 1}.json`);
		writeJsonAtomically(
			join(host.cwd, "dream-loop-command.json"),
			{ parent: user.id, seq: seq + 1, agent: "map-runner" },
		);
		await waitFile(mapFile);
		const mapped = JSON.parse(readFileSync(mapFile, "utf8"));
		expect(mapped.ok).toBe(true);
		expect(mapped.outcome.mapped).toBeGreaterThanOrEqual(1);
		expect(mapped.mapping?.files).toContain("src-fixture.ts");
		expect(mapSteps).toBeGreaterThanOrEqual(2);
		const mapWire = host.mock
			.requests()
			.filter((r) => hasMapperSystem(r.body));
		expect(JSON.stringify(mapWire[1]?.body.input)).toContain(
			"Map these memories",
		);
		expect(JSON.stringify(mapWire[1]?.body.input)).not.toContain("mc:hidden:");
		const beforeDenied = readFileSync(join(host.cwd, "tool-executed"), "utf8");
		let deniedSteps = 0;
		host.mock.addMatcher((body) => {
			if (!hasProbeSystem(body, "dreamer-docs")) return null;
			deniedSteps++;
			return deniedSteps === 1
				? {
						openaiOutput: [
							{
								type: "function_call",
								id: "fc_denied",
								call_id: "call_denied",
								name: "ctx_memory",
								arguments: JSON.stringify({ value: "forbidden" }),
							},
						],
						usage: { input_tokens: 100, output_tokens: 10 },
					}
				: {
						text: "DENIED_MANIFEST",
						usage: { input_tokens: 110, output_tokens: 10 },
					};
		});
		const deniedResultFile = join(host.cwd, `dream-loop-result-${seq}.json`);
		writeJsonAtomically(
			join(host.cwd, "dream-loop-command.json"),
			{ parent: user.id, seq, agent: "dreamer-docs" },
		);
		await waitFile(deniedResultFile);
		const denied = JSON.parse(readFileSync(deniedResultFile, "utf8"));
		expect(denied.ok).toBe(true);
		expect(deniedSteps).toBe(2);
		const deniedWire = host.mock
			.requests()
			.filter((r) => hasProbeSystem(r.body, "dreamer-docs"));
		expect(JSON.stringify(deniedWire[0]?.body.tools)).not.toContain(
			"ctx_memory",
		);
		expect(JSON.stringify(deniedWire[1]?.body.input)).toContain(
			"No tool named",
		);
		expect(readFileSync(join(host.cwd, "tool-executed"), "utf8")).toBe(
			beforeDenied,
		);
		const frames = readFileSync(join(host.cwd, "hook-steps.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(frames.at(-2).tools).not.toContain("ctx_memory");
		expect(readFileSync(join(host.cwd, "tool-executed"), "utf8")).toContain(
			"ctx_memory:curate",
		);
		expect(readFileSync(join(host.cwd, "tool-executed"), "utf8")).toContain(
			"ctx_search:retrospective",
		);
        const cleanupDeadline = Date.now() + 12000;
        for (;;) {
            const roots = await client.session.list({ directory: host.cwd, parentID: null });
            if (roots.data.every(session => session.metadata?.magic_context !== "hidden-run")) break;
            if (Date.now() > cleanupDeadline) throw new Error("Tool-loop child survived settlement");
            await Bun.sleep(50);
        }
        const storedUser = await client.session.get({ sessionID: user.id });
		expect(storedUser.model).toMatchObject({
			providerID: "openai",
			id: "mock-model",
		});
		expect(storedUser.tokens).toMatchObject({ input: 0, output: 0 });
        // Parented child requests carry their root's session header. Classify the actual
        // hidden-run system prompts instead, including the production mapper's prompt.
        expect(host.mock.requests().filter((request) => {
            const instructions = providerSystemText(request.body);
            return !instructions.split("\n").some((line) => line.startsWith("DREAM_LOOP_")) &&
                !hasMapperSystem(request.body);
        })).toHaveLength(0);
    } catch (error) {
        console.error(host.stderr());
        throw error;
    } finally {
        await host.stop();
        rmSync(bundle, { recursive: true, force: true });
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
	}
}, 120000);
