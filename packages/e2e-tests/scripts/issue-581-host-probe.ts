import { openTestDb } from "../src/test-db";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnOpencode } from "../src/opencode-runner/spawn";
import { MockProvider } from "../src/mock-provider/server";

const directory = join(
	tmpdir(),
	"magic-context/issue-581",
	`opencode-${Date.now()}`,
);
mkdirSync(directory, { recursive: true });
const root = realpathSync(directory);
const env = {
	configDir: join(root, "config"),
	dataDir: join(root, "data"),
	cacheDir: join(root, "cache"),
	workdir: join(root, "work"),
};
for (const path of Object.values(env)) mkdirSync(path, { recursive: true });
for (let n = 0; n < 25; n++)
	writeFileSync(join(env.workdir, `noise-${n}.txt`), "noise\n".repeat(2000));
const mock = new MockProvider();
const { baseURL } = await mock.start();
mock.setDefault({
	text: "done",
	usage: { input_tokens: 100, output_tokens: 10 },
});
let phase = 0;
mock.addMatcher((body) => {
	if (
		!JSON.stringify(body.tools ?? []).includes('"question"') ||
		!JSON.stringify(body.messages).includes("PROBE_581")
	)
		return null;
	if (phase === 1) {
		phase++;
		return {
			content: Array.from({ length: 25 }, (_, n) => ({
				type: "tool_use",
				id: `noise-${n}`,
				name: "read",
				input: { filePath: join(env.workdir, `noise-${n}.txt`) },
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
let host: Awaited<ReturnType<typeof spawnOpencode>> | undefined;
try {
	host = await spawnOpencode({
		mockProviderURL: baseURL,
		existingEnv: env,
		modelContextLimit: 100000,
		magicContextConfig: {
			embedding: { provider: "off" },
			memory: { enabled: false },
			dreamer: { disable: true },
			protected_tokens: 16000,
			historian: { opencode: { model: "mock-anthropic/mock-sonnet" } },
			commit_cluster_trigger: { enabled: false },
		},
		expectedMagicContextState: "enabled",
		prepareContextDatabase: true,
		extraEnv: { TMPDIR: root, HOME: root },
	});
	console.log(JSON.stringify({ hostPid: host.pid }));
	const files = Bun.spawnSync(["lsof", "-p", String(host.pid)]);
	const evidence = files.stdout.toString();
	writeFileSync(join(root, "lsof.txt"), evidence);
	if (
		!evidence ||
		/\/Users\/[^\s]+\/(?:\.config\/(?:opencode|cortexkit)|\.local\/share\/(?:opencode|cortexkit\/magic-context))/.test(
			evidence,
		)
	)
		throw new Error("live store isolation failed");
	const api = async (path: string, body?: unknown) => {
		const response = await fetch(
			host!.url + path,
			body === undefined
				? { signal: AbortSignal.timeout(60000) }
				: {
						signal: AbortSignal.timeout(60000),
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					},
		);
		if (!response.ok)
			throw new Error(`${path}: ${response.status} ${await response.text()}`);
		return response.json();
	};
	const session = await api("/session", {});
	const prompt = api(`/session/${session.id}/message`, {
		model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
		parts: [{ type: "text", text: "PROBE_581" }],
	});
	let question: any;
	for (let i = 0; i < 100; i++) {
		question = (await api("/question"))[0];
		if (question) break;
		await Bun.sleep(100);
	}
	if (!question) {
		console.log(
			JSON.stringify(
				{
					requests: mock.requests(),
					messages: await api(`/session/${session.id}/message`),
					stderr: host.stderr(),
				},
				null,
				2,
			),
		);
		throw new Error("question not exposed");
	}
	await api(`/question/${question.id}/reply`, { answers: [["ANSWER_581"]] });
	console.log("question answered");
	await prompt;
	console.log("pressure run finished");
	const messages = await api(`/session/${session.id}/message`);
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
		throw new Error(
			"real OpenCode 1 emergency retains answered question - FAILED",
		);
	const db = openTestDb(
		join(env.dataDir, "cortexkit/magic-context/context.db"),
		{ readonly: true },
	);
	try {
		const emergency = db
			.query(
				"SELECT emergency, dropped_count FROM transform_decisions WHERE emergency = 1 AND dropped_count > 0",
			)
			.all();
		const later = db
			.query(
				"SELECT SUM(token_count) AS tokens FROM tags WHERE tool_name = 'read'",
			)
			.get() as { tokens: number };
		if (!emergency.length || later.tokens <= 16000)
			throw new Error(
				"real OpenCode 1 emergency pressure not reached outside protected tail",
			);
		console.log(JSON.stringify({ emergency, later }));
	} finally {
		db.close();
	}
	writeFileSync(
		join(root, "requests.json"),
		JSON.stringify(mock.requests(), null, 2),
	);
	console.log(
		JSON.stringify(
			{
				root,
				question,
				toolParts: messages
					.flatMap((m: any) => m.parts)
					.filter((p: any) => p.tool === "question"),
				requests: mock.requests().length,
			},
			null,
			2,
		),
	);
} finally {
	await host?.kill();
	await mock.stop();
}
