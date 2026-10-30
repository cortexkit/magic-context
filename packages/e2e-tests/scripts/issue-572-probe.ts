import { openTestDb } from "../src/test-db";
import { spawnOpencode } from "../src/opencode-runner/spawn";
import { MockProvider } from "../src/mock-provider/server";
import { sessionMetaFieldSelect, writeSessionMetaField } from "../src/session-meta-fields";
import { appendCompartments } from "../../plugin/src/features/magic-context/compartment-storage";
import { insertMemory } from "../../plugin/src/features/magic-context/memory/storage-memory";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { estimateTokens } from "../../plugin/src/hooks/magic-context/read-session-formatting";

// CLI: bun packages/e2e-tests/scripts/issue-572-probe.ts <scenario> [gate].
// Set TMPDIR to a throwaway magic-context/issue-572 root before running.
// Scenarios: "configured" fixes the window at 262144; "fallback" omits a model
// limit; "learned" records a ninfer overflow limit before restart; "proven"
// increases accepted-input telemetry after restart; "shrink" caches large history
// then restarts the same model with its configured window lowered to 32768.
// Gates: "proven baseline" requires repeated render-config folds in the old
// implementation; "proven stable" requires unchanged restart prefixes and one
// fold after a policy edit; "shrink safe" requires one resize and a first request
// within the smaller usable window. Later user-tail growth can independently
// exhaust the window. The mock accepts all sizes; token counts are local estimates.
// The temporary root below fences every spawned host and its generated stores.
if (!realpathSync(tmpdir()).includes("/magic-context/issue-572"))
	throw new Error("Set TMPDIR to a throwaway magic-context/issue-572 root");
const mode = Bun.argv[2] ?? "configured";
const gate = Bun.argv[3];
const records: Array<{
	turn: number;
	folds: string[];
	identity: string;
	hash: string;
	m0Bytes: number;
	localInputTokens?: number;
}> = [];
const wirePrefixes: string[] = [];
const mock = new MockProvider();
const { baseURL } = await mock.start();
const normal = { text: "ok", usage: { input_tokens: 1000, output_tokens: 10 } };
mock.setDefault(normal);
const opts = {
	mockProviderURL: baseURL,
	mockProviderID: "mock-ninfer",
	mockProviderAPI: "@ai-sdk/openai" as const,
	mockModelID: "Qwen3.8-27B",
	modelContextLimit: 262144,
	magicContextConfig: {
		...(mode === "proven" ? { compaction: { enabled: false } } : {}),
		historian: { disable: true },
		embedding: { provider: "off" },
		memory: {
			auto_search: { enabled: false },
			git_commit_indexing: { enabled: false },
		},
	},
	...(mode === "configured" || mode === "shrink"
		? {}
		: {
				openCodeConfigExtra: {
					provider: {
						"mock-ninfer": {
							npm: "@ai-sdk/openai",
							name: "Mock ninfer",
							options: { apiKey: "test-key-not-real", baseURL },
							models: { "Qwen3.8-27B": { name: "Qwen3.8-27B" } },
						},
					},
				},
			}),
};
let host = await spawnOpencode(opts);
function isolate() {
	const paths = Bun.spawnSync(["lsof", "-p", String(host.pid), "-Fn"])
		.stdout.toString()
		.split("\n")
		.filter((s) => s.startsWith("n/"))
		.map((s) => s.slice(1));
	const dbs = [...new Set(paths.filter((s) => /\.db(-wal|-shm)?$/.test(s)))];
	if (
		!dbs.length ||
		dbs.some((s) => !s.startsWith(realpathSync(host.env.dataDir)))
	)
		throw new Error("isolation failed: " + dbs);
	console.log("ISOLATED", mode, host.pid, dbs);
}
async function turn(id: string, n: number) {
	const logPath = join(host.env.dataDir, "cortexkit", "magic-context-e2e.log");
	const logOffset = readFileSync(logPath, "utf8").length;
	const before = mock.requests().length;
	const snapshotDb = openTestDb(
		join(host.env.dataDir, "cortexkit", "magic-context", "context.db"),
	);
	const snapshot = () =>
		snapshotDb
			.prepare(
				`SELECT ${sessionMetaFieldSelect("cached_m0_upgrade_state")}, last_usage_context_limit, observed_safe_input_tokens, detected_context_limit FROM session_meta WHERE session_id = ?`,
			)
			.get(id);
	console.log("BEFORE", n, snapshot());
	const ballast =
		mode === "proven" && n >= 1 && n <= 4
			? "decision result ".repeat(
					Math.ceil(([261171, 270000, 280000, 280000][n - 1] * 4) / 16),
				)
			: mode === "shrink" && n >= 1 && n <= 3
				? "decision result ".repeat(5000)
				: "";
	const result = await fetch(host.url + "/session/" + id + "/message", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: { providerID: "mock-ninfer", modelID: "Qwen3.8-27B" },
			parts: [{ type: "text", text: "turn " + n + " " + ballast }],
		}),
	});
	console.log("TURN", n, result.status);
	const response = (await result.json()) as {
		info?: { id?: string; error?: unknown };
	};
	await Bun.sleep(1200);
	console.log(
		"AFTER",
		n,
		snapshot(),
		"requests",
		mock.requests().length - before,
	);
	const row = snapshotDb
		.prepare(
			`SELECT ${sessionMetaFieldSelect("cached_m0_upgrade_state")}, ${sessionMetaFieldSelect("cached_m0_bytes")} FROM session_meta WHERE session_id = ?`,
		)
		.get(id) as {
		cached_m0_upgrade_state: string;
		cached_m0_bytes: Uint8Array;
	};
	console.log("M0_CHARS", n, row.cached_m0_bytes.byteLength);
	let localInputTokens: number | undefined;
	if (mode === "shrink") {
		const request = mock
			.requests()
			.slice(before)
			.find((r) =>
				JSON.stringify(r.body.input ?? r.body.messages).includes(
					"turn " + n + " ",
				),
			);
		if (!request) throw new Error("no shrink provider wire captured");
		localInputTokens = estimateTokens(
			JSON.stringify(request.body.input ?? request.body.messages),
		);
		console.log("SHRINK_WIRE_LOCAL_TOKENS", n, localInputTokens);
	}
	records.push({
		turn: n,
		identity: row.cached_m0_upgrade_state,
		hash: createHash("sha256").update(row.cached_m0_bytes).digest("hex"),
		m0Bytes: row.cached_m0_bytes.byteLength,
		localInputTokens,
		folds: readFileSync(logPath, "utf8")
			.slice(logOffset)
			.split("\n")
			.filter(
				(line) =>
					line.includes("transform: injected m[0]/m[1]") &&
					line.includes("rematerialized=true"),
			),
	});
	snapshotDb.close();
	if (mode === "proven" && n >= 1 && n <= 4) {
		const request = mock
			.requests()
			.slice(before)
			.find((r) =>
				JSON.stringify(r.body.input ?? r.body.messages).includes(
					"turn " + n + " ",
				),
			);
		if (!request) throw new Error("no main provider wire captured");
		// Compare the actual serialized provider prefix before the current user
		// text, not the database's cached m[0] blob. This includes system and m[1].
		const wire = JSON.stringify(request.body.input ?? request.body.messages);
		const end = wire.indexOf("turn " + n + " ");
		if (end < 0) throw new Error("current user text absent from provider wire");
		const prefix = wire.slice(0, end);
		wirePrefixes.push(prefix);
		console.log(
			"WIRE_PREFIX",
			n,
			prefix.length,
			createHash("sha256").update(prefix).digest("hex"),
		);
	}
	if (
		!result.ok ||
		(response.info?.error && n !== 98) ||
		mock.requests().length === before
	)
		throw new Error("turn failed: " + JSON.stringify(response.info));
	return response.info?.id;
}
try {
	isolate();
	const session = (await (
		await fetch(host.url + "/session", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		})
	).json()) as { id: string };
	const seedMessageId = await turn(session.id, 0);
	if (!seedMessageId) throw new Error("seed response has no message id");
	const db = openTestDb(
		join(host.env.dataDir, "cortexkit", "magic-context", "context.db"),
	);
	appendCompartments(
		db as unknown as Parameters<typeof appendCompartments>[0],
		session.id,
		[
			{
				sequence: 1,
				startMessage: 1,
				endMessage: 1,
				startMessageId: seedMessageId,
				endMessageId: seedMessageId,
				title: "Seed history",
				content: "",
				p1:
					mode === "shrink"
						? "Remember the isolated fixture. ".repeat(1600)
						: "Remember the isolated fixture.",
				p2: "Fixture.",
				p3: "Fixture.",
				p4: "Fixture.",
				importance: 50,
			},
		],
	);
	insertMemory(db as unknown as Parameters<typeof insertMemory>[0], {
		projectPath: realpathSync(host.env.workdir),
		category: "ARCHITECTURE",
		content: "The mock provider is isolated.",
	});
	writeSessionMetaField(db, session.id, "cached_m1_bytes", null);
	db.close();
	if (mode === "shrink")
		mock.setDefault({
			text: "ok",
			usage: { input_tokens: 22000, output_tokens: 10 },
		});
	await turn(session.id, 10);
	if (mode === "learned") {
		mock.script([
			{
				error: {
					status: 400,
					type: "invalid_request_error",
					message:
						"AI_APICallError: prepared prompt exceeds Engine max_context 262144",
				},
			},
		]);
		await turn(session.id, 98);
	}
	const env = host.env;
	await host.kill();
	host = await spawnOpencode({
		...opts,
		...(mode === "shrink" ? { modelContextLimit: 32768 } : {}),
		existingEnv: env,
	});
	isolate();
	for (let n = 1; n <= 3; n++) {
		if (mode === "proven")
			mock.setDefault({
				text: "ok",
				usage: {
					input_tokens: [261171, 270000, 280000][n - 1],
					output_tokens: 10,
				},
			});
		await turn(session.id, n);
	}
	if (mode === "proven") await turn(session.id, 4);
	const restartRecords = records.filter((r) => r.turn >= 1 && r.turn <= 4);
	if (
		gate === "baseline" &&
		restartRecords
			.flatMap((r) => r.folds)
			.filter((s) => s.includes("reason=render_config")).length < 2
	)
		throw new Error("baseline did not reproduce repeated render-config folds");
	if (mode === "shrink" && gate === "safe") {
		const seed = records.find((r) => r.turn === 10)!;
		const first = restartRecords[0];
		if (
			first.folds.length !== 1 ||
			!first.folds[0].includes("render_config:budget_shrink(") ||
			restartRecords.slice(1).some((r) => r.folds.length > 0)
		)
			throw new Error("shrinking window did not fold exactly once");
		if (
			first.localInputTokens === undefined ||
			first.localInputTokens > 24576 ||
			first.m0Bytes >= seed.m0Bytes
		)
			throw new Error(
				"shrinking baseline did not fit first request in usable window",
			);
		if (new Set(restartRecords.map((r) => r.hash)).size !== 1)
			throw new Error("resized prefix did not replay unchanged");
		console.log(
			"SHRINK_SAFETY_PASSED",
			first.m0Bytes,
			first.localInputTokens,
			"<= 24576; later user-tail growth is independent",
		);
	}
	if (gate === "stable") {
		// Requests append conversation turns. The initial system/history prefix
		// must remain a byte-identical prefix of every later request.
		const initial = wirePrefixes[0];
		if (!initial || wirePrefixes.some((wire) => !wire.startsWith(initial)))
			throw new Error("provider shared prefix changed as proven input rose");
		for (const [index, prefix] of wirePrefixes.entries())
			console.log(
				"SHARED_PREFIX_SHA256",
				index + 1,
				initial.length,
				createHash("sha256")
					.update(prefix.slice(0, initial.length))
					.digest("hex"),
			);
		if (
			restartRecords.some((r) => r.folds.length > 0) ||
			new Set(restartRecords.map((r) => r.hash)).size !== 1
		)
			throw new Error("restart prefix was not frozen");
		const canonical = join(
			host.env.configDir,
			"cortexkit",
			"magic-context.jsonc",
		);
		const config = JSON.parse(readFileSync(canonical, "utf8"));
		config.history_budget_percentage = 0.2;
		writeFileSync(canonical, JSON.stringify(config));
		const env = host.env;
		await host.kill();
		host = await spawnOpencode({
			...opts,
			existingEnv: env,
			magicContextConfig: {
				...opts.magicContextConfig,
				history_budget_percentage: 0.2,
			},
		});
		isolate();
		for (let n = 20; n <= 22; n++) await turn(session.id, n);
		const edits = records.filter((r) => r.turn >= 20);
		if (
			edits[0].folds.length !== 1 ||
			!edits[0].folds[0].includes("render_config:budget(") ||
			edits.slice(1).some((r) => r.folds.length)
		)
			throw new Error("policy edit did not fold exactly once");
		if (JSON.stringify(mock.requests()).includes("render_config:"))
			throw new Error("diagnostic leaked into provider prompt");
	}
	console.table(
		records.map((r) => ({
			turn: r.turn,
			identity: r.identity,
			folds: r.folds.length,
			sha256: r.hash,
		})),
	);
	console.log("ROOT", host.env.dataDir);
	console.log(
		readFileSync(
			join(host.env.dataDir, "cortexkit", "magic-context-e2e.log"),
			"utf8",
		)
			.split("\n")
			.filter(
				(s) =>
					s.includes("issue-572 probe") ||
					s.includes("rematerialized=") ||
					s.includes("context limit") ||
					s.includes("models-dev-cache") ||
					s.includes("overflow"),
			)
			.join("\n"),
	);
} finally {
	await host.kill();
	await mock.stop();
}
