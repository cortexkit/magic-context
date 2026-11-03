import { openTestDb } from "../src/test-db";
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
import { MockProvider } from "../src/mock-provider/server";

const base = join(tmpdir(), "magic-context/issue-581");
mkdirSync(base, { recursive: true });
const root = realpathSync(mkdtempSync(join(base, "opencode2-")));
const { spawnOpencode2, ROOT_KEYS, waitForPluginActive } = await import(
	"../src/opencode2-runner/spawn"
);
const env: NodeJS.ProcessEnv = {
	PATH: process.env.PATH,
	OPENCODE_DB: "opencode2.db",
	TMPDIR: root,
	OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
};
for (const key of ROOT_KEYS) {
	env[key] = join(root, key);
	mkdirSync(env[key]!);
}
env.MAGIC_CONTEXT_STORAGE_DIR = join(root, "storage");
const cwd = join(root, "work");
mkdirSync(cwd);
for (let n = 0; n < 25; n++)
	writeFileSync(join(cwd, `noise-${n}.txt`), "noise\n".repeat(2000));
const probePlugin = join(root, "probe");
mkdirSync(probePlugin);
writeFileSync(
	join(probePlugin, "server.js"),
	`import { appendFileSync } from 'node:fs'; export default { id: 'answer-probe', async setup(context) { await context.session.hook('context', draft => { appendFileSync(${JSON.stringify(join(root, "drafts.jsonl"))}, JSON.stringify(draft) + '\\n'); }); } };`,
);
const mock = new MockProvider();
const { baseURL } = await mock.start();
mock.setDefault({
	text: "done",
	usage: { input_tokens: 100, output_tokens: 10 },
});
let phase = 0;
mock.addMatcher((body) => {
	if (!JSON.stringify(body.tools ?? []).includes('"question"')) return null;
	if (phase === 1) {
		phase++;
		return {
			content: Array.from({ length: 25 }, (_, n) => ({
				type: "tool_use",
				id: `noise-${n}`,
				name: "read",
				input: { path: join(cwd, `noise-${n}.txt`) },
			})),
			stop_reason: "tool_use",
			usage: { input_tokens: 90000, output_tokens: 1000 },
		};
	}
	if (phase !== 0) return null;
	phase++;
	return {
		content: [
			{
				type: "tool_use",
				id: "question581",
				name: "question",
				input: {
					questions: [
						{
							question: "Choose",
							header: "Choice",
							options: [{ label: "ANSWER_581", description: "retain" }],
						},
					],
				},
			},
		],
		stop_reason: "tool_use",
		usage: { input_tokens: 100, output_tokens: 10 },
	};
});
console.log(JSON.stringify({ root }));
let host: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
try {
	host = await spawnOpencode2({
		providerID: "anthropic",
		probePlugin,
		modelContextLimit: 100000,
		includeMagicContext: true,
		prepareContextDatabase: true,
		compactionAuto: true,
		modelOutputLimit: 4096,
		magicContextConfig: {
			embedding: { provider: "off" },
			memory: { enabled: false },
			dreamer: { disable: true },
			protected_tokens: 16000,
			historian: { opencode: { model: "anthropic/mock-model" } },
			commit_cluster_trigger: { enabled: false },
		},
		existingIsolation: { root, env, cwd },
		existingMock: { mock, baseURL },
	});
	const pid = host.pid;
	const lsof = Bun.spawnSync(["lsof", "-p", String(pid)]).stdout.toString();
	writeFileSync(join(root, "lsof.txt"), lsof);
	if (
		!lsof ||
		/\/Users\/[^\s]+\/(?:\.config\/(?:opencode|cortexkit)|\.local\/share\/(?:opencode|cortexkit\/magic-context))/.test(
			lsof,
		)
	)
		throw new Error("live store isolation failed");
	const client = OpenCode.make({
		baseUrl: host.url,
		headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
	});
	const session = await client.session.create({
		location: { directory: cwd },
		model: { providerID: "anthropic", id: "mock-model" },
	});
	await waitForPluginActive(client, cwd);
	await client.session.prompt({ sessionID: session.id, text: "PROBE_581" });
	let form: any;
	for (let i = 0; i < 100; i++) {
		form = (await client.session.form.list({ sessionID: session.id }))[0];
		if (form) break;
		await Bun.sleep(100);
	}
	if (!form) throw new Error("question form not exposed");
	const detail = await client.session.form.get({
		sessionID: session.id,
		formID: form.id,
	});
	console.log(JSON.stringify({ form, detail }, null, 2));
	const fields = (detail as any).fields ?? [];
	await client.session.form.reply({
		sessionID: session.id,
		formID: form.id,
		answer: { [fields[0]?.key ?? "q0"]: "ANSWER_581" },
	});
	await client.session.wait(
		{ sessionID: session.id },
		{ signal: AbortSignal.timeout(30000) },
	);
	const messages = await client.message.list({ sessionID: session.id });
	writeFileSync(join(root, "messages.json"), JSON.stringify(messages, null, 2));
	const request = mock
		.requests()
		.filter((request) =>
			JSON.stringify(request.body.tools ?? []).includes('"question"'),
		)
		.at(-1);
	if (
		!JSON.stringify(request?.body.messages).includes(
			"User has answered your questions:",
		)
	)
		throw new Error("real OpenCode 2 emergency loses answered question");
	const db = openTestDb(join(env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"), {
		readonly: true,
	});
	try {
		const emergency = db
			.query(
				"SELECT COUNT(*) AS dropped_count FROM tags WHERE status = 'dropped' AND tool_name = 'read'",
			)
			.get() as { dropped_count: number };
		const log = readFileSync(
			join(root, "opencode2/magic-context/magic-context.log"),
			"utf8",
		);
		const later = db
			.query(
				"SELECT SUM(token_count) AS tokens FROM tags WHERE tool_name = 'read'",
			)
			.get() as { tokens: number };
		if (
			!emergency.dropped_count ||
			!log.includes("emergency tiered drop:") ||
			later.tokens <= 16000
		)
			throw new Error(
				"real OpenCode 2 emergency pressure not reached outside protected tail",
			);
		console.log(JSON.stringify({ emergency, later }));
	} finally {
		db.close();
	}
	console.log(JSON.stringify({ root, messages }, null, 2));
	writeFileSync(
		join(root, "requests.json"),
		JSON.stringify(mock.requests(), null, 2),
	);
	console.log(
		JSON.stringify(
			{ root, tools: mock.requests().at(-1)?.body.tools },
			null,
			2,
		),
	);
} finally {
	await host?.stopHost();
	await mock.stop();
}
