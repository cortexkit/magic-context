import { openTestDb } from "../test-db";
/** Real OpenCode 1.x probe; all host state and provider traffic stay in a disposable root.
 * Usage: bun <this file> --opencode <binary> --plugin <entry> --out <temp root>
 *   --pressure 85|98 --size small|large --subagent
 * Omit --subagent for an optional primary-session control (historian disabled).
 * Provider usage is scripted, not inferred from filler bytes: this isolates automatic tool-result reclaim
 * at a known pressure while the host executes its real task/read/ctx_expand tools.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { MockProvider, type MockResponse } from "../mock-provider/server";

const arg = (name: string) => {
	const i = process.argv.indexOf(`--${name}`);
	if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing --${name}`);
	return process.argv[i + 1];
};
const out = resolve(arg("out"));
const allowed =
	resolve(process.env.TMPDIR ?? "/tmp", "magic-context/issue-585") + sep;
if (!out.startsWith(allowed))
	throw new Error(`Output must be beneath ${allowed}`);
const binary = resolve(arg("opencode"));
const plugin = resolve(arg("plugin"));
const subagent = process.argv.includes("--subagent");
const pressure = Number(arg("pressure"));
const size = arg("size");
if (![85, 98].includes(pressure) || !["small", "large"].includes(size))
	throw new Error("Invalid case");
const dirs = Object.fromEntries(
	["home", "config", "data", "cache", "state", "work", "tmp"].map((k) => [
		k,
		join(out, k),
	]),
);
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const storage = join(dirs.data, "cortexkit/magic-context");
const hostDb = join(dirs.data, "opencode/issue-repro.db");
const report =
	"TASK_REVIEW_START\n" +
	(size === "large"
		? Array.from({ length: 1600 }, (_, i) =>
				createHash("sha256").update(`review-${i}`).digest("hex").slice(0, 28),
			).join("\n")
		: "review evidence unique detail ".repeat(80)) +
	"\nTASK_REVIEW_END";
writeFileSync(
	join(dirs.work, "control.txt"),
	"READ_CONTROL_START\n" +
		"older reference data\n".repeat(1000) +
		"\nREAD_CONTROL_END",
);
const mock = new MockProvider();
const { baseURL } = await mock.start();
const window = 239000;
const usage = {
	input_tokens: Math.round(((window - 8192) * pressure) / 100),
	output_tokens: 40,
};
let parentStep = 0;
let index = 0;
let parentId = "";
const records: unknown[] = [];
const probes: Array<{ kind: string; tag: number; ordinal: number }> = [];
function lookup() {
	const host = new Database(hostDb, { readonly: true });
	const rows = host
		.query(
			"SELECT id FROM message WHERE session_id = ? ORDER BY time_created, id",
		)
		.all(parentId) as Array<{ id: string }>;
	const parts = host
		.query("SELECT message_id, data FROM part WHERE session_id = ?")
		.all(parentId) as Array<{ message_id: string; data: string }>;
	const mc = openTestDb(join(storage, "context.db"), { readonly: true });
	const tags = mc
		.query("SELECT * FROM tags WHERE session_id = ? ORDER BY tag_number")
		.all(parentId) as Array<Record<string, any>>;
	writeFileSync(
		join(out, `tags-${parentStep}.json`),
		JSON.stringify(tags, null, 2),
	);
	for (const kind of ["task", "read"]) {
		const part = parts.find((p) => JSON.parse(p.data).tool === kind);
		const tag = tags.find((t) => t.tool_name === kind);
		if (!part || !tag) throw new Error(`Missing ${kind} evidence`);
		probes.push({
			kind,
			tag: tag.tag_number,
			ordinal: rows.findIndex((r) => r.id === part.message_id) + 1,
		});
		writeFileSync(join(out, `raw-${kind}.json`), part.data);
	}
	host.close();
	mc.close();
}
function call(
	name: string,
	input: Record<string, unknown>,
	id: string,
	u = usage,
): MockResponse {
	return {
		content: [
			...(id === "toolu_read"
				? [{ type: "text", text: "Preparing reference read." }]
				: []),
			{ type: "tool_use", id, name, input },
		],
		stop_reason: "tool_use",
		usage: u,
	};
}
mock.addMatcher((body) => {
	index++;
	const wire = JSON.stringify(body);
	writeFileSync(join(out, `wire-${index}.json`), JSON.stringify(body, null, 2));
	const messages = (body.messages ?? []) as Array<{
		role: string;
		content: any;
	}>;
	const userTexts = messages
		.filter((m) => m.role === "user")
		.flatMap((m) =>
			Array.isArray(m.content)
				? m.content.filter((b) => b.type === "text").map((b) => b.text)
				: [m.content],
		)
		.join(" ");
	const lane = userTexts.includes("CHILD_585")
		? "child"
		: userTexts.includes("PARENT_585")
			? "parent"
			: "other";
	records.push({
		index,
		lane,
		parentStep,
		taskVisible: wire.includes("TASK_REVIEW_START"),
		readVisible: wire.includes("READ_CONTROL_START"),
		bytes: wire.length,
	});
	if (!Array.isArray(body.tools) || body.tools.length === 0)
		return {
			text: "OK",
			stop_reason: "end_turn",
			usage: { input_tokens: 1000, output_tokens: 40 },
		};
	if (lane === "child")
		return {
			text: report,
			stop_reason: "end_turn",
			usage: { input_tokens: 1000, output_tokens: 40 },
		};
	if (lane !== "parent")
		return {
			text: "OK",
			stop_reason: "end_turn",
			usage: { input_tokens: 1000, output_tokens: 40 },
		};
	parentStep++;
	if (parentStep === 1)
		return call(
			"read",
			{ filePath: join(dirs.work, "control.txt") },
			"toolu_read",
			{ input_tokens: 1000, output_tokens: 40 },
		);
	if (parentStep === 2)
		return call(
			"task",
			{
				description: "review",
				prompt: "CHILD_585 produce review",
				subagent_type: "worker",
			},
			"toolu_task",
		);
	if (parentStep === 3) lookup();
	const probeIndex = parentStep - 3;
	if (probeIndex < 4) {
		const probe = probes[Math.floor(probeIndex / 2)];
		const coordinate = probeIndex % 2 === 0 ? "tag" : "ordinal";
		return call(
			"ctx_expand",
			{ message: probe[coordinate] },
			`toolu_expand_${probe.kind}_${coordinate}`,
		);
	}
	return { text: "PROBE_DONE", stop_reason: "end_turn", usage };
});
writeFileSync(
	join(dirs.config, "opencode.json"),
	JSON.stringify(
		{
			plugin: [`file://${plugin}`],
			subagent_depth: 3,
			autoupdate: false,
			share: "disabled",
			compaction: { auto: false, prune: false },
			permission: { "*": "allow" },
			provider: {
				mock: {
					npm: "@ai-sdk/anthropic",
					env: [],
					options: { apiKey: "mock-only", baseURL },
					models: {
						sonnet: {
							name: "Mock Sonnet",
							limit: { context: window, output: 8192 },
						},
					},
				},
			},
			enabled_providers: ["mock"],
			model: "mock/sonnet",
			small_model: "mock/sonnet",
			agent: {
				worker: {
					mode: "subagent",
					description: "Returns review",
					prompt: "Return review",
				},
			},
		},
		null,
		2,
	),
);
mkdirSync(join(dirs.config, "cortexkit"), { recursive: true });
writeFileSync(
	join(dirs.config, "cortexkit/magic-context.jsonc"),
	JSON.stringify({
		historian: { disable: true, opencode: { model: "mock/sonnet" } },
		dreamer: { disable: true },
		embedding: { provider: "off" },
	}),
);
const env = {
	PATH: process.env.PATH!,
	HOME: dirs.home,
	XDG_CONFIG_HOME: dirs.config,
	XDG_DATA_HOME: dirs.data,
	XDG_CACHE_HOME: dirs.cache,
	XDG_STATE_HOME: dirs.state,
	OPENCODE_CONFIG_DIR: dirs.config,
	OPENCODE_DB: "issue-repro.db",
	MAGIC_CONTEXT_STORAGE_DIR: storage,
	MAGIC_CONTEXT_LOG_PATH: join(out, "magic-context.log"),
	TMPDIR: dirs.tmp,
	ANTHROPIC_API_KEY: "mock-only",
	OPENCODE_DISABLE_AUTOUPDATE: "true",
};
const version = Bun.spawnSync([binary, "--version"], { env })
	.stdout.toString()
	.trim();
if (!version.startsWith("1.18.")) throw new Error(`Wrong host ${version}`);
const port = 22000 + Math.floor(Math.random() * 20000);
const child = spawn(
	binary,
	["serve", "--port", String(port), "--hostname", "127.0.0.1", "--print-logs"],
	{ cwd: dirs.work, env, stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
child.stdout?.on("data", (c) => (serverLog += c));
child.stderr?.on("data", (c) => (serverLog += c));
const url = `http://127.0.0.1:${port}`;
function isolation(name: string) {
	const sample = Bun.spawnSync(["lsof", "-p", String(child.pid)]);
	if (sample.exitCode !== 0) throw new Error("lsof failed");
	const text = sample.stdout.toString();
	writeFileSync(join(out, name), text);
	const dbRows = text
		.split("\n")
		.filter((l) => /REG/.test(l) && /\.db(?:-|\s|$)/.test(l));
	if (!dbRows.length || dbRows.some((l) => !l.includes(out)))
		throw new Error(`Unisolated DB handles: ${dbRows.join("\n")}`);
}
try {
	for (let i = 0; ; i++) {
		try {
			if (
				(await fetch(`${url}/session`, { signal: AbortSignal.timeout(1000) }))
					.ok
			)
				break;
		} catch {}
		if (i === 120) throw new Error(`Host startup failed ${serverLog}`);
		await Bun.sleep(500);
	}
	isolation("lsof-before.txt");
	const api = async (path: string, body?: unknown) => {
		const response = await fetch(
			`${url}${path}?directory=${encodeURIComponent(dirs.work)}`,
			{
				method: body ? "POST" : "GET",
				headers: { "content-type": "application/json" },
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(180000),
			},
		);
		if (!response.ok)
			throw new Error(`${path}: ${response.status} ${await response.text()}`);
		return response.json();
	};
	const rootId = (await api("/session", { title: "Issue 585 probe" })).id;
	parentId = subagent
		? (
				await api("/session", {
					parentID: rootId,
					title: "Issue 585 nested probe",
				})
			).id
		: rootId;
	await api(`/session/${parentId}/message`, {
		agent: "build",
		parts: [
			{
				type: "text",
				text:
					"PARENT_585 review these reference notes. " +
					"background context detail ".repeat(15000),
			},
		],
	});
	isolation("lsof-after.txt");
	const history = await api(`/session/${parentId}/message`);
	writeFileSync(join(out, "history.json"), JSON.stringify(history, null, 2));
	const expands = history.flatMap((m: any) =>
		m.parts
			.filter((p: any) => p.tool === "ctx_expand")
			.map((p: any) => ({
				call: p.callID,
				input: p.state.input,
				output: p.state.output,
			})),
	);
	const log = readFileSync(join(out, "magic-context.log"), "utf8")
		.split("\n")
		.filter(
			(l) =>
				l.includes(parentId) &&
				/heuristics WILL|emergency tiered|heuristic cleanup|protected token|scheduler:|smart drop/.test(
					l,
				),
		);
	const summary = {
		version,
		pressure,
		size,
		subagent,
		parentId,
		reportChars: report.length,
		records,
		probes,
		expands: expands.map((p: any) => ({
			...p,
			output: p.output?.slice(0, 500),
			chars: p.output?.length,
			hasTask: p.output?.includes("TASK_REVIEW_START"),
			hasRead: p.output?.includes("READ_CONTROL_START"),
		})),
		log,
	};
	writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
	console.log(
		JSON.stringify(
			{
				...summary,
				log: log.filter((l) => /emergency tiered|heuristic cleanup/.test(l)),
			},
			null,
			2,
		),
	);
	if (parentStep !== 7 || expands.length !== 4 || probes.length !== 2)
		throw new Error("Probe sequence incomplete");
	if (history.some((m: any) => m.info.error))
		throw new Error("Host message error");
	const arrival = (
		records as Array<{ lane: string; parentStep: number; taskVisible: boolean }>
	).find((r) => r.lane === "parent" && r.parentStep === 2);
	if (arrival?.taskVisible !== (pressure === 85))
		throw new Error("Unexpected arrival visibility");
	if (probes[0].tag === probes[0].ordinal)
		throw new Error("Tag/ordinal divergence was not exercised");
	if (expands[0].output?.includes("TASK_REVIEW_START"))
		throw new Error("Tag lookup unexpectedly recovered task");
	if (!expands[1].output?.includes(report))
		throw new Error("Raw ordinal did not recover full task result");
	if (!expands[3].output?.includes("READ_CONTROL_END"))
		throw new Error("Raw ordinal did not recover read control");
} finally {
	child.kill("SIGTERM");
	await mock.stop();
	writeFileSync(join(out, "serve.log"), serverLog);
}
