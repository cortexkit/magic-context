import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TestHarness } from "../src/harness";
import { MockProvider } from "../src/mock-provider/server";

const bytes = (v: unknown) =>
	JSON.stringify(v, (k, x) => (k === "cache_control" ? undefined : x));
const thinking = (n: number) => ({
	type: "thinking",
	thinking: `Reason ${n}`,
	signature: `signed-${n}`,
});

test("mock rejects edited, missing and reordered latest-turn thinking across tool results", async () => {
	const mock = new MockProvider();
	const { baseURL } = await mock.start({
		thinkingScope: () => "negative-control",
	});
	mock.setDefault({
		content: [thinking(1), { type: "redacted_thinking", data: "opaque-1" }],
		usage: { input_tokens: 10, output_tokens: 10 },
	});
	const send = (messages: unknown[]) =>
		fetch(`${baseURL}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({ messages }),
		});
	const user = { role: "user", content: "prompt" };
	const returned = [
		thinking(1),
		{ type: "redacted_thinking", data: "opaque-1" },
	];
	const result = {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "a", content: "done" }],
	};
	try {
		expect((await send([user])).status).toBe(200);
		for (const content of [
			[{ ...thinking(1), thinking: "edited" }, returned[1]],
			[returned[0]],
			[...returned].reverse(),
			[],
		]) {
			const rejected = await send([
				user,
				{ role: "assistant", content },
				result,
			]);
			expect(rejected.status).toBe(400);
			expect(await rejected.text()).toContain(
				"latest assistant message cannot be modified",
			);
		}
		expect(
			(
				await send([
					{ ...user, content: "edited prompt" },
					{ role: "assistant", content: [] },
					result,
				])
			).status,
		).toBe(400);
		// Neither tool results nor merging assistant blocks release the turn.
		expect(
			(await send([user, { role: "assistant", content: returned }, result]))
				.status,
		).toBe(200);
		expect(
			(
				await send([
					user,
					{ role: "assistant", content: [] },
					{ role: "user", content: "next real user" },
				])
			).status,
		).toBe(200);
	} finally {
		await mock.stop();
	}
});

for (const { band, mode } of [{ band: 76, mode: "drops" }, { band: 85, mode: "drops" }, { band: 76, mode: "primary" }, { band: 85, mode: "primary" }, { band: 76, mode: "legacy-accepted" }, { band: 76, mode: "legacy-rejected" }]) {
	test(mode === "primary" ? `Anthropic primary long tool loop defers thinking-changing queued drops at ${band}%` : mode === "drops" ? `Anthropic task preserves latest-turn thinking and queues ctx_reduce at ${band}%` : `Anthropic task ${mode} thinking replay`, async () => {
        let enforceLegacy = mode !== "legacy-accepted";
        const modelID = mode.startsWith("legacy-") ? "mock-sonnet" : "claude-sonnet-5-5";
		const oldTmp = process.env.TMPDIR;
		const taskRoot = join(tmpdir(), "magic-context", "issue-630");
		mkdirSync(taskRoot, { recursive: true });
		process.env.TMPDIR = taskRoot;
		let h: TestHarness;
		try {
			h = await TestHarness.create({
                mockProviderID: "anthropic",
                mockModelID: modelID,
				prepareContextDatabase: !process.env.MC_E2E_PLUGIN_ENTRY,
				thinkingScope: (body) => !enforceLegacy ? undefined :
					bytes(body.system).includes("ISSUE-630-WORKER")
						? "worker"
						: bytes(body.system),
				modelContextLimit: 100_000,
				magicContextConfig: {
					execute_threshold_tokens: { default: 5000 },
					protected_tokens: 4000,
					dreamer: { disable: true },
					memory: { enabled: false },
				},
				openCodeConfigExtra: {
					agent: {
						"thinking-worker": {
							mode: mode === "primary" ? "primary" : "subagent",
							description: "Thinking worker",
							prompt: "ISSUE-630-WORKER",
                            model: `anthropic/${modelID}`,
							permission: { "*": "allow" },
						},
					},
				},
			});
		} finally {
			if (oldTmp === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = oldTmp;
		}
		const root = dirname(h.opencode.env.configDir);
		const proof = join(
			taskRoot,
			`proof-${process.env.MC_E2E_PLUGIN_ENTRY ? "v045" : "master"}-${band}-${Date.now()}`,
		);
		mkdirSync(proof, { recursive: true });
		let pass = 0;
		// A primary keeps the newest tool calls in its protected working set, so its
		// loop runs two more calls before the queued drop can leave that window.
		const reducePass = mode === "primary" ? 6 : 4;
		const lastPass = reducePass + 3;
		let parentSent = false;
		let childId = "";
		let tag = 0;
		const wire: unknown[][] = [];
		try {
			expect(realpathSync(root).startsWith(realpathSync(taskRoot) + "/")).toBe(
				true,
			);
			const version = (
				(await fetch(`${h.serverUrl}/global/health`).then((r) => r.json())) as {
					version: string;
				}
			).version;
			expect(version).toMatch(/^1\.18\./);
			const contain = () => {
				const lsof = spawnSync("lsof", ["-p", String(h.opencode.pid), "-Fn"], {
					encoding: "utf8",
				});
				expect(lsof.status).toBe(0);
				const dbs = lsof.stdout
					.split("\n")
					.filter((l) => /^n.*\.(db|sqlite)(-(wal|shm))?$/.test(l))
					.map((l) => l.slice(1));
				expect(dbs.length).toBeGreaterThan(0);
				expect(dbs.every((p) => p.startsWith(root + "/"))).toBe(true);
				writeFileSync(join(proof, "lsof-proof.txt"), lsof.stdout);
			};
			contain();
			for (const name of ["a", "b", "c"])
				writeFileSync(
					join(h.workdir, `${name}.txt`),
					`SPENT-${name}\n` +
						Array.from(
							{ length: 2000 },
							(_, n) => `${n * 7919}:${n * 3571}!`,
						).join(" "),
				);
			h.mock.addMatcher((body) => {
				const usage = {
					input_tokens: 0,
					output_tokens: 20,
					cache_read_input_tokens:
						pass >= 4 ? Math.ceil((band * (100_000 - 8192)) / 100) : 100,
					cache_creation_input_tokens: 0,
				};
				const tool = (name: string, input: unknown) => ({
					content: [
						thinking(pass),
						{ type: "tool_use", id: `call-${pass}`, name, input },
					],
					stop_reason: "tool_use" as const,
					usage,
				});
				if (!bytes(body.system).includes("ISSUE-630-WORKER")) {
					if (bytes(body.system).includes("title generator"))
						return { text: "Thinking test", usage };
					if (parentSent) return { text: "Parent done", usage };
					parentSent = true;
					return {
						content: [
							{
								type: "tool_use",
								id: "task-630",
								name: "task",
								input: {
									subagent_type: "thinking-worker",
									description: "Thinking turn",
									prompt: "Read files and reduce spent outputs.",
								},
							},
						],
						stop_reason: "tool_use",
						usage,
					};
				}
				pass++;
				wire.push(structuredClone(body.messages as unknown[]));
				if (pass <= 2)
					return tool("bash", {
						command: `cat ${pass === 1 ? "a" : "b"}.txt`,
						description: "Read spent output",
					});
				if (pass === 3 && (mode === "drops" || mode === "primary")) return tool("bash", { command: "cat c.txt", description: "Displace the protected output floor" });
				if (mode === "primary" && pass > 3 && pass < reducePass)
					return tool("bash", {
						command: `printf step-${pass}`,
						description: "Grow the active tool loop",
					});
                if (pass === reducePass) {
					const child = h
						.contextDb()
						.query("SELECT session_id FROM session_meta WHERE is_subagent = 1")
						.get() as { session_id: string };
					if (mode !== "primary") childId = child.session_id;
					const tags = h
						.contextDb()
						.query(
							"SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' AND status = 'active' ORDER BY tag_number",
						)
						.all(childId) as Array<{ tag_number: number }>;
					tag = tags[1]!.tag_number;
                    if (mode.startsWith("legacy-")) {
                        const owners = h.contextDb().query("SELECT tool_owner_message_id AS id FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number").all(childId) as Array<{ id: string }>;
                        writeFileSync(join(h.workdir, "seed-legacy.ts"), `import {Database} from "bun:sqlite"; import {join} from "node:path"; const db = new Database(join(process.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db")); db.exec("PRAGMA busy_timeout = 10000"); db.query("UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ?").run(${JSON.stringify(JSON.stringify([`binding_mismatch:${owners[1]!.id}`, `binding_mismatch:${owners[2]!.id}`]))}, ${JSON.stringify(childId)}); db.close(); console.log("Legacy seed installed");`);
                        return { ...tool("bash", { command: "bun seed-legacy.ts", description: "Seed recorded legacy thinking decision" }), usage: { ...usage, cache_read_input_tokens: Math.ceil(band * (100_000 - 8192) / 100) } };
                    }

					return {
						...tool("ctx_reduce", { drop: String(tag) }),
						usage: {
							...usage,
							cache_read_input_tokens: Math.ceil(
								(band * (100_000 - 8192)) / 100,
							),
						},
					};
				}
				if (mode === "legacy-accepted" && pass >= 5) {
                    if (pass === 5) {
                        h.mock.resumeLegacyThinking("worker", 1, [thinking(1), thinking(4), thinking(5)]);
                        enforceLegacy = true;
                    }
                    if (pass < 7) return tool("bash", { command: "printf legacy-continue", description: "Continue accepted legacy replay" });
                    return { text: "Legacy worker done", usage };
                }
                if (pass < lastPass)
					return tool("bash", {
						command: "printf continue",
						description: "Continue",
					});
				return { text: "Worker done", usage };
			});
			const parent = await h.createSession();
            if (mode === "primary") childId = parent;
            await h.sendPrompt(parent, "Delegate to thinking-worker.", mode === "primary" ? { timeoutMs: 90_000, agent: "thinking-worker" } : { timeoutMs: 90_000 });
			contain();
			writeFileSync(
				join(proof, "requests.json"),
				JSON.stringify(h.mock.requests(), null, 2),
			);
			writeFileSync(
				join(proof, "plugin-log.txt"),
				readFileSync(join(h.dataDir, "cortexkit", "magic-context-e2e.log")),
			);
			console.log(
				JSON.stringify({ version, pid: h.opencode.pid, root, band, pass, tag }),
			);
            if (mode.startsWith("legacy-")) {
                if (mode === "legacy-rejected") {
                    expect(pass).toBe(4);
                    expect(h.mock.requests().filter(r => r.thinkingViolation)).toHaveLength(1);
                    // The arm binds to the real user message that started the rejected turn.
                    expect((h.contextDb().query("SELECT thinking_binding_recovery_target AS target FROM session_meta WHERE session_id = ?").get(childId) as { target: string }).target).toMatch(/^latest_thinking_original_armed:\S+$/);
                }
                if (mode === "legacy-accepted") {
                    expect(pass).toBe(7);
                    const oldThinking = (messages: unknown[]) => messages.flatMap(message => (message as { content: unknown[] }).content).filter(part => (part as { type?: string }).type === "thinking");
                    expect(bytes(oldThinking(wire[5]!).slice(0, 2))).toBe(bytes(oldThinking(wire[4]!)));
                    expect(h.mock.requests().some(r => r.thinkingViolation)).toBe(false);
                    contain();
                    return;
                }
                const hostDb = new Database(join(h.dataDir, "opencode", "opencode.db"), { readonly: true });
                let prompt: { id: string }; let parts: Array<{ id: string; type: "text"; text: string }>;
                try {
                    prompt = hostDb.query("SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY id LIMIT 1").get(childId) as { id: string };
                    parts = (hostDb.query("SELECT id, data FROM part WHERE message_id = ? ORDER BY id").all(prompt.id) as Array<{ id: string; data: string }>).map(row => ({ ...JSON.parse(row.data), id: row.id })).filter(part => part.type === "text");
                } finally { hostDb.close(); }
                const retry = await h.client.session.prompt({ path: { id: childId }, body: { messageID: prompt.id, model: { providerID: "anthropic", modelID: "mock-sonnet" }, agent: "thinking-worker", parts } });
                writeFileSync(join(proof, "retry-result.json"), JSON.stringify(retry, null, 2));
                expect(retry.error).toBeUndefined();
                expect((retry.data as { info?: { error?: unknown } })?.info?.error).toBeUndefined();
                expect(pass).toBe(7);
                expect(h.mock.requests().filter(r => r.thinkingViolation)).toHaveLength(1);
                expect(bytes(wire[4])).toContain('"signature":"signed-2"');
                expect(bytes(wire[4])).toContain('"signature":"signed-3"');
                contain();
                return;
            }
			expect(pass).toBe(lastPass);
			expect(h.mock.requests().some((r) => r.thinkingViolation)).toBe(false);
			// The request after ctx_reduce still carries the output and extends the
			// previous request byte for byte: no thinking was edited or removed.
			expect(bytes(wire[reducePass])).toContain("SPENT-b");
			expect(bytes(wire[reducePass]!.slice(0, wire[reducePass - 1]!.length))).toBe(
				bytes(wire[reducePass - 1]),
			);
			expect(
				h
					.contextDb()
					.query("SELECT tag_id FROM pending_ops WHERE session_id = ?")
					.all(childId),
			).toContainEqual({ tag_id: tag });
			// A real user turn releases the queued drop, even in a former child.
			await h.sendPrompt(childId, "Next real user turn; finish.", {
				timeoutMs: 30_000,
				agent: "thinking-worker",
			});
			expect(bytes(wire.at(-1))).not.toContain("SPENT-b");
			expect(
				h
					.contextDb()
					.query("SELECT tag_id FROM pending_ops WHERE session_id = ?")
					.all(childId),
			).toHaveLength(0);
        } finally {
            const hostProofDb = new Database(join(h.dataDir, "opencode", "opencode.db"), { readonly: true });
            try { writeFileSync(join(proof, "original-thinking-parts.json"), JSON.stringify(hostProofDb.query("SELECT message_id, data FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'reasoning'").all(childId), null, 2)); } finally { hostProofDb.close(); }
            writeFileSync(join(proof, "recovery-state.json"), JSON.stringify(h.contextDb().query("SELECT thinking_binding_recovery_target, merged_reasoning_stripped_ids FROM session_meta WHERE session_id = ?").get(childId), null, 2));
			writeFileSync(
				join(proof, "requests.json"),
				JSON.stringify(h.mock.requests(), null, 2),
			);
			const log = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
			writeFileSync(join(proof, "plugin-log.txt"), readFileSync(log));
			await h.dispose();
		}
	}, 120_000);
}
