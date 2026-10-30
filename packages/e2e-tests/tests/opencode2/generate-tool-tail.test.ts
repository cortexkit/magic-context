import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { clearCachedM0M1 } from "../../../plugin/src/features/magic-context/storage-meta-shared";
import {
	assertOpenPaths,
	CLI,
	ROOT_KEYS,
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

function wireField(raw: string, key: string): { bytes: string; end: number } {
	const marker = `${JSON.stringify(key)}:`;
	const start = raw.indexOf(marker) + marker.length;
	expect(start).toBeGreaterThanOrEqual(marker.length);
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let end = start; end < raw.length; end++) {
		const char = raw[end];
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
		} else if (char === '"') quoted = true;
		else if (char === "[" || char === "{") depth++;
		else if (char === "]" || char === "}") depth--;
		if (!quoted && depth === 0)
			return { bytes: raw.slice(start, end + 1), end: end + 1 };
	}
	throw new Error(`Unterminated wire field ${key}`);
}

test("OpenCode 2 generate replays the last runner wire prefix after an id-less tool tail", async () => {
	const base = join(tmpdir(), "magic-context", "issue-666");
	mkdirSync(base, { recursive: true });
	const root = realpathSync(mkdtempSync(join(base, "capture-")));
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		OPENCODE_DB: "opencode2.db",
		OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
		TMPDIR: root,
		MAGIC_CONTEXT_LOG_PATH: join(root, "magic-context.log"),
	};
	for (const key of ROOT_KEYS) {
		env[key] = join(root, key);
		mkdirSync(env[key]!);
	}
	env.CFFIXED_USER_HOME = env.HOME;
	env.MAGIC_CONTEXT_STORAGE_DIR = join(
		env.XDG_DATA_HOME!,
		"cortexkit",
		"magic-context",
	);
	const cwd = join(root, "work");
	mkdirSync(cwd);
	const version = spawnSync(CLI, ["--version"], { env, cwd, encoding: "utf8" });
	expect(version.status).toBe(0);
	console.info(`tool-tail host=${version.stdout.trim()} root=${root}`);
	writeFileSync(join(root, "host-version.txt"), version.stdout);
	const probe = join(root, "probe");
	mkdirSync(probe);
	const trace = join(root, "trace.jsonl");
	writeFileSync(
		join(probe, "server.js"),
		`
        import mc from ${JSON.stringify(new URL("../../../plugin/dist/v2/server.js", import.meta.url).pathname)};
        import { appendFileSync } from 'node:fs';
        export default { id:'opencode-magic-context', async setup(context) {
            const session=new Proxy(context.session,{get(target,key) {
                if(key!=='hook') return Reflect.get(target,key);
                return (name,callback)=>target.hook(name,async draft=>{
                    const raw=JSON.parse(JSON.stringify(draft));
                    await callback(draft);
                    if(name==='context'||name==='generate') appendFileSync(${JSON.stringify(trace)},JSON.stringify({name,raw,served:draft})+'\\n');
                });
            }});
            return mc.setup(new Proxy(context,{get(target,key){return key==='session'?session:Reflect.get(target,key);}}));
        }};
    `,
	);
	const host = await spawnOpencode2({
		existingIsolation: { root, env, cwd },
		includeMagicContext: false,
		probePlugin: probe,
		compactionAuto: false,
		magicContextConfig: {
			dreamer: { disable: true },
			memory: { enabled: false },
			historian: { disable: true },
			temporal_awareness: false,
		},
	});
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "generate tool tail",
			location: { directory: cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, cwd);
		const prompt = async (text: string) => {
			await client.session.prompt({ sessionID: session.id, text });
			await client.session.wait(
				{ sessionID: session.id },
				{ signal: AbortSignal.timeout(60000) },
			);
		};
		const tool = (id: string, name: string) => ({
			openaiOutput: [
				{
					type: "function_call",
					id: `fc_${id}`,
					call_id: `call_${id}`,
					name,
					arguments: JSON.stringify({
						command: `printf RAW-${id}-OUTPUT`,
						description: "Produce tool tail",
					}),
				},
			],
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		const toolTurns = new Set<string>();
		host.mock.addMatcher((body) => {
			const text = JSON.stringify(body);
			const id = text.includes("TOOL-TURN-QUESTION")
				? "final"
				: text.includes("SEED-QUESTION")
					? "seed"
					: undefined;
			if (!id || toolTurns.has(id) || body.model !== "mock-model") return null;
			toolTurns.add(id);
			const tools = body.tools as Array<{ name: string }>;
			return tool(
				id,
				tools.some((entry) => entry.name === "shell") ? "shell" : "bash",
			);
		});
		await prompt("SEED-QUESTION");
		const frames = () =>
			readFileSync(trace, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		const start = frames().find((frame) => frame.name === "context").raw
			.messages[0].id;
		const db = openTestDb(join(env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
		try {
			db.query(
				`INSERT INTO compartments (session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,created_at,harness) VALUES (?,0,1,1,?,?,'Seeded work','TOOL-TAIL-COMPARTMENT','TOOL-TAIL-COMPARTMENT',?,'opencode')`,
			).run(session.id, start, start, Date.now());
			expect(
				db
					.query(
						"UPDATE tags SET status='dropped',drop_mode='output' WHERE session_id=? AND type='tool' AND message_id='call_seed'",
					)
					.run(session.id).changes,
			).toBeGreaterThan(0);
			clearCachedM0M1(db as never, session.id);
		} finally {
			db.close(true);
		}
		await prompt("TOOL-TURN-QUESTION");
		const runner = host.mock
			.requests()
			.filter((request) => request.rawBody?.includes("TOOL-TURN-QUESTION"))
			.at(-1)!;
		const contexts = frames().filter((frame) => frame.name === "context");
		const last = contexts.at(-1);
		expect(last.raw.messages.at(-1).role).toBe("tool");
		expect(last.raw.messages.at(-1).id).toBeUndefined();
		expect(runner.rawBody).toContain("TOOL-TAIL-COMPARTMENT");
		const fds = spawnSync("lsof", ["-p", String(host.pid), "-Fn"], {
			encoding: "utf8",
		});
		expect(fds.status).toBe(0);
		writeFileSync(join(root, "lsof-host.txt"), fds.stdout);
		const paths = fds.stdout
			.split("\n")
			.filter((line) => line.startsWith("n"))
			.map((line) => line.slice(1));
		assertOpenPaths(paths, root);
		const databases = [
			...new Set(paths.filter((path) => /\.db(-wal|-shm)?$/.test(path))),
		];
		expect(databases.length).toBeGreaterThan(0);
		expect(databases.every((path) => path.startsWith(`${root}/`))).toBe(true);
		const response = await fetch(
			`${host.url}/api/session/${session.id}/generate`,
			{
				method: "POST",
				headers: {
					authorization: `Basic ${btoa(`opencode:${host.password}`)}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ prompt: "SIDE-QUESTION" }),
				signal: AbortSignal.timeout(60000),
			},
		);
		expect(response.status).toBe(200);
		await response.text();
		const side = host.mock
			.requests()
			.find((request) => request.rawBody?.includes("SIDE-QUESTION"))!;
		writeFileSync(join(root, "runner.json"), runner.rawBody!);
		writeFileSync(join(root, "btw.json"), side.rawBody!);
		const generate = frames().find((frame) => frame.name === "generate");
		// The previous implementation saved a request snapshot only if its final host
		// message had an ID. Find that snapshot, then check whether generate still has
		// the same model, agent and message ID. If so, the old replay accepted the stale
		// snapshot rather than taking one of its rejection branches.
		const captured = contexts
			.filter(
				(frame) =>
					frame.raw.messages.at(-1)?.id &&
					JSON.stringify(frame.served.messages).includes("<session-history>"),
			)
			.at(-1);
		const oldExit = !captured
			? "no-prefix"
			: captured.raw.model.id !== generate.raw.model.id ||
					captured.raw.model.providerID !== generate.raw.model.providerID
				? "model-mismatch"
				: captured.raw.agent !== generate.raw.agent
					? "agent-mismatch"
					: !generate.raw.messages.some(
								(message: { id?: string }) =>
									message.id === captured.raw.messages.at(-1).id,
							)
						? "anchor-not-found"
						: "none (stale first-step prefix applied)";
		// Compare the literal request prefix through the last input item. Its closing
		// array bracket is framing, not cached history; /btw appends more items there.
		const input = wireField(runner.rawBody!, "input");
		const prefix = runner.rawBody!.slice(0, input.end - 1);
		const wirePrefixEqual = side.rawBody!.startsWith(prefix);
		const instructionsEqual =
			wireField(side.rawBody!, "instructions").bytes ===
			wireField(runner.rawBody!, "instructions").bytes;
		const toolsEqual =
			wireField(side.rawBody!, "tools").bytes ===
			wireField(runner.rawBody!, "tools").bytes;
		const diagnostic = {
			host: version.stdout.trim(),
			databases,
			lastIdOnlyCaptureSkip:
				last.raw.messages.at(-1)?.id === undefined ? "no-anchor" : null,
			lastIdOnlyApplyExit: oldExit,
			wirePrefixEqual,
			wirePrefixBytes: Buffer.byteLength(prefix),
			instructionsEqual,
			toolsEqual,
			runnerBytes: Buffer.byteLength(runner.rawBody!),
			btwBytes: Buffer.byteLength(side.rawBody!),
		};
		writeFileSync(
			join(root, "diagnostic.json"),
			JSON.stringify(diagnostic, null, 2),
		);
		console.info(`tool-tail diagnostic=${JSON.stringify(diagnostic)}`);
		const runnerInput = runner.body.input as unknown[];
		expect(Array.isArray(runnerInput)).toBe(true);
		expect(
			JSON.stringify(
				(side.body.input as unknown[]).slice(0, runnerInput.length),
			),
		).toBe(JSON.stringify(runnerInput));
		expect(JSON.stringify(side.body.tools)).toBe(
			JSON.stringify(runner.body.tools),
		);
		expect(side.body.instructions).toBe(runner.body.instructions);
		expect(prefix.length).toBeGreaterThan(0);
		expect(wirePrefixEqual).toBe(true);
		expect(instructionsEqual).toBe(true);
		expect(toolsEqual).toBe(true);
	} finally {
		writeFileSync(join(root, "plugin-log.txt"), host.pluginLog());
		writeFileSync(join(root, "host-stderr.txt"), host.stderr());
		await host.stop();
	}
}, 120000);
