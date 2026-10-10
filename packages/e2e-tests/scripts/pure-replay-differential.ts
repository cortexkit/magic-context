#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectHostOpenFiles } from "../src/host-open-files";

type ReplayPass = {
	pass: number;
	decision: string | null;
	bytes: number;
	sha256: string;
	systemSha256: string;
	toolsSha256: string;
	historySha256?: string;
};

type RefReplay = {
	ref: string;
	commit: string;
	passes: ReplayPass[];
	hostFiles?: { pid: number; databases: string[] };
	priced?: {
		mode: string;
		hardMessagesSha256: string;
		hardHistorySha256: string;
		expectedLocalBudget: number;
		commonHistorySha256: string;
		tailMessagesSha256: string;
		expectedDropped: number[];
		actualDropped: number[];
		restarted: boolean;
	};
};

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../../..");
const RESULT_PREFIX = "PURE_REPLAY_RESULT=";
const tsOnly = Bun.argv.includes("--ts-only");
const priced = Bun.argv.includes("--priced");
const neutral = Bun.argv.includes("--neutral");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

// --provider-pipeline compares the whole-history Rust transform with the
// message-hook/compaction path, using separate stores seeded with the same data.
// It needs neither a running OpenCode host nor two Git refs. Existing ref-to-ref
// comparisons and --priced wire captures keep their original path.
// Run: bun packages/e2e-tests/scripts/pure-replay-differential.ts --provider-pipeline
if (Bun.argv.includes("--provider-pipeline")) {
	if (tsOnly || priced || neutral)
		throw new Error("--provider-pipeline cannot be combined with TS/priced overrides");
	const { runProviderPipelineDifferential } = await import("./provider-pipeline-differential");
	const selected = Bun.argv.flatMap((arg, i) => arg === "--case" ? [Bun.argv[i + 1]!] : []);
	await runProviderPipelineDifferential(selected);
	process.exit(0);
}

function valueAfter(flag: string): string | undefined {
	const index = Bun.argv.indexOf(flag);
	return index === -1 ? undefined : Bun.argv[index + 1];
}

function fullCommit(ref: string): string {
	return execFileSync("git", ["rev-parse", `${ref}^{commit}`], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	}).trim();
}

async function createReplayHarness() {
	const { RustTestHarness } = await import("../src/rust-harness");
	const options = {
		startInTsMode: true,
		startHistorianProducer: false,
		providerID: "anthropic",
		providerAPI: "@ai-sdk/anthropic",
		modelID: priced ? "claude-fable-5-1" : "mock-sonnet",
		modelContextLimit: 200_000,
		magicContextConfig: {
			execute_threshold_percentage: priced ? 65 : 90,
			memory: { auto_search: { enabled: false } },
			compressor: { enabled: false },
			...(priced
				? {
						output_reserve: 0,
						history_budget_percentage: 60000 / 130000 + Number.EPSILON,
						protected_tokens: 6000,
						temporal_awareness: false,
						historian: { disable: true },
						dreamer: { disable: true, inject_docs: false },
						memory: { enabled: false, auto_search: { enabled: false } },
					}
				: {}),
		},
	} as const;
	if (!tsOnly) {
		const harness = await RustTestHarness.create(options);
		const fixtureWorkdir = valueAfter("--fixture-workdir");
		if (fixtureWorkdir) {
			if (resolve(fixtureWorkdir) !== join(dirname(REPO_ROOT), "fixture-work"))
				throw new Error(
					"fixture workdir must be inside the throwaway comparison root",
				);
			mkdirSync(join(fixtureWorkdir, ".cortexkit"), { recursive: true });
			const config = join(
				harness.env.workdir,
				".cortexkit/magic-context.jsonc",
			);
			if (existsSync(config))
				copyFileSync(
					config,
					join(fixtureWorkdir, ".cortexkit/magic-context.jsonc"),
				);
			harness.env.workdir = fixtureWorkdir;
		}
		return Object.assign(harness, schedulerObserver(harness.logPath), {
			inspectIsolation: () => inspectReplayHost(harness.opencode.pid, harness.env.dataDir),
		});
	}

	// TS comparisons need no native daemon. Keep the original provider route
	// and reuse the original capture methods, not a second wire serializer.
	process.env.MC_E2E_MODE = "ts";
	const { TestHarness } = await import("../src/harness");
	const gateLog = join(REPO_ROOT, ".calibration-host.log");
	const priorLog = process.env.MAGIC_CONTEXT_LOG_PATH;
	process.env.MAGIC_CONTEXT_LOG_PATH = gateLog;
	const harness = await TestHarness.create(options);

	try {
		const fixtureWorkdir = valueAfter("--fixture-workdir");
		if (fixtureWorkdir) {
			if (resolve(fixtureWorkdir) !== join(dirname(REPO_ROOT), "fixture-work"))
				throw new Error(
					"fixture workdir must be inside the throwaway comparison root",
				);
			mkdirSync(fixtureWorkdir, { recursive: true });
			harness.opencode.env.workdir = fixtureWorkdir;
		}
		const configure = async () => {
			const path = join(harness.opencode.env.configDir, "opencode.json");
			const config = JSON.parse(readFileSync(path, "utf8"));
			config.provider[options.providerID] =
				config.provider["mock-anthropic"] ??
				config.provider[options.providerID];
			const provider = config.provider[options.providerID];
			provider.models[options.modelID] = {
				...provider.models["mock-sonnet"],
				id: options.modelID,
				name: `Mock ${options.modelID}`,
			};
			delete config.provider["mock-anthropic"];
			config.model = `${options.providerID}/${options.modelID}`;
			config.small_model = config.model;
			config.enabled_providers = [options.providerID];
			writeFileSync(path, JSON.stringify(config, null, 2));
			const userConfig = join(
				harness.opencode.env.configDir,
				"cortexkit/magic-context.jsonc",
			);
			writeFileSync(
				userConfig,
				readFileSync(userConfig, "utf8").replaceAll(
					"mock-anthropic/mock-sonnet",
					`${options.providerID}/${options.modelID}`,
				),
			);
			const { createOpencodeClient } = await import("@opencode-ai/sdk");
			await createOpencodeClient({
				baseUrl: harness.opencode.url,
			}).instance.dispose({
				query: { directory: harness.opencode.env.workdir },
				throwOnError: true,
			});
		};
		await configure();
		return {
			inspectIsolation: () => inspectReplayHost(harness.opencode.pid, harness.opencode.env.dataDir),
			mock: harness.mock,
			createSession: () => harness.createSession(),
			contextDb: () => harness.contextDb(),
			openFixtureWriter: () => {
				const path = harness.contextDbPath();
				if (!existsSync(path))
					throw new Error("isolated context database is not initialized");
				return new Database(path);
			},
			readMessages: async (sessionId: string) => {
				const { createOpencodeClient } = await import("@opencode-ai/sdk");
				const result = await createOpencodeClient({
					baseUrl: harness.opencode.url,
				}).session.messages({
					path: { id: sessionId },
					query: { directory: harness.opencode.env.workdir },
					throwOnError: true,
				});
				return result.data ?? [];
			},
			restart: async () => {
				await harness.restart();
				await configure();
			},
			sendPrompt: (sessionId: string, text: string) =>
				harness.sendPrompt(sessionId, text, options),
			sendSeedPrompt: (sessionId: string, text: string) =>
				harness.sendPrompt(sessionId, text, {
					...options,
					modelID: "mock-sonnet",
				}),
			...schedulerObserver(gateLog),
			dispose: async () => {
				await harness.dispose();
				rmSync(gateLog, { force: true });
				if (priorLog === undefined) delete process.env.MAGIC_CONTEXT_LOG_PATH;
				else process.env.MAGIC_CONTEXT_LOG_PATH = priorLog;
			},
			mainRequests: RustTestHarness.prototype.mainRequests,
			lastMainWireSerialized: RustTestHarness.prototype.lastMainWireSerialized,
		};
	} catch (error) {
		await harness.dispose();
		throw error;
	}
}

/** Retain real host descriptors, not just the environment intended for that host. */
function inspectReplayHost(pid: number, dataDir: string) {
	const proof = inspectHostOpenFiles(
		pid,
		realpathSync(dirname(dataDir)),
		join(dataDir, "cortexkit/magic-context/context.db"),
	);
	const output = process.env.MC_REPLAY_ISOLATION_DIR;
	if (output) {
		mkdirSync(output, { recursive: true });
		writeFileSync(join(output, `host-${pid}-lsof.txt`), proof.inventory);
	}
	return { pid: proof.pid, databases: proof.databases };
}

async function captureCurrentCheckout(
	ref: string,
	commit: string,
): Promise<RefReplay> {
	if (priced && neutral) {
		if (existsSync(join(REPO_ROOT, ".git")) || !valueAfter("--fixture-workdir"))
			throw new Error(
				"neutral override is allowed only inside an extracted throwaway ref",
			);
		const path = join(
			REPO_ROOT,
			"packages/plugin/src/hooks/magic-context/tokenizer-calibration.ts",
		);
		const source = readFileSync(path, "utf8");
		const signature =
			/export function resolveModelCalibration\([\s\S]*?\): ModelCalibration \{/;
		if (!signature.test(source))
			throw new Error("neutral override could not locate resolver");
		writeFileSync(
			path,
			source.replace(
				signature,
				(match) =>
					`${match}\n    if (providerId === "anthropic" && modelId === "claude-fable-5-1") return { systemRatio: 1, toolsRatio: 1, proseRatio: 1 };`,
			),
		);
	}
	const harness = await createReplayHarness();
	try {
		if (priced) return await capturePricedCheckout(harness, ref, commit);
		const sessionId = await harness.createSession();
		const db = harness.contextDb();
		const passes: ReplayPass[] = [];
		for (let warm = 0; warm < 2; warm++) {
			harness.mock.setDefault({
				text: `[[warm-answer-${warm}]]`,
				usage: { input_tokens: 1000, output_tokens: 10 },
			});
			await harness.sendPrompt(sessionId, `[[warm-generation-${warm}]]`);
		}
		const hostFiles = harness.inspectIsolation();
		const generation = db
			.prepare(
				"SELECT cached_m0_bytes, cached_m0_materialized_at FROM session_meta WHERE session_id = ?",
			)
			.get(sessionId) as {
			cached_m0_bytes: Uint8Array | null;
			cached_m0_materialized_at: number;
		};
		if (!generation?.cached_m0_bytes)
			throw new Error("warmup did not establish a cached m0 generation");
		for (let index = 0; index < 4; index += 1) {
			const cursor =
				"schedulerCursor" in harness ? harness.schedulerCursor(sessionId) : 0;
			harness.mock.setDefault({
				text: `[[pure-replay-${index}]]`,
				usage: { input_tokens: 1_000 + index, output_tokens: 10 },
			});
			await harness.sendPrompt(sessionId, `[[pure-replay-prompt-${index}]]`);
			const wire = harness.lastMainWireSerialized("messages");
			const request = harness.mainRequests().at(-1);
			if (
				!request ||
				!Object.hasOwn(request.body, "system") ||
				!Object.hasOwn(request.body, "tools")
			)
				throw new Error("main capture lacks system/tools fields");
			// lastMainWireSerialized reads the requested body field unchanged. Its historical TypeScript signature permits only messages/input, so widen the field choice here without introducing another serializer.
			const system = harness.lastMainWireSerialized("system" as "messages");
			const tools = harness.lastMainWireSerialized("tools" as "messages");
			const observations =
				"schedulerSince" in harness
					? await harness.schedulerSince(sessionId, cursor)
					: [];
			if (observations.length === 0 || observations.some((d) => d !== "defer"))
				throw new Error(
					`expected a current defer observation, got ${observations}`,
				);
			const decision = observations.at(-1);
			const current = db
				.prepare(
					"SELECT cached_m0_bytes, cached_m0_materialized_at FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as typeof generation;
			if (
				current.cached_m0_materialized_at !==
					generation.cached_m0_materialized_at ||
				!current.cached_m0_bytes ||
				!Buffer.from(current.cached_m0_bytes).equals(
					Buffer.from(generation.cached_m0_bytes),
				)
			)
				throw new Error("defer changed the established cached generation");
			passes.push({
				pass: index + 1,
				decision: decision ?? null,
				bytes: Buffer.byteLength(wire),
				sha256: createHash("sha256").update(wire).digest("hex"),
				systemSha256: createHash("sha256").update(system).digest("hex"),
				toolsSha256: createHash("sha256").update(tools).digest("hex"),
			});
		}
		return { ref, commit, passes, hostFiles };
	} finally {
		await harness.dispose();
	}
}

function extractRef(
	ref: string,
	destination: string,
	sharedRoot: string,
): void {
	mkdirSync(destination, { recursive: true });
	const archive = execFileSync("git", ["archive", "--format=tar", ref], {
		cwd: REPO_ROOT,
		maxBuffer: 256 * 1024 * 1024,
	});
	execFileSync("tar", ["-xf", "-", "-C", destination], {
		input: archive,
		maxBuffer: 256 * 1024 * 1024,
	});

	for (const name of ["node_modules", "target"] as const) {
		const source = join(REPO_ROOT, name);
		if (existsSync(source)) symlinkSync(source, join(destination, name), "dir");
	}
	for (const packageName of [
		"e2e-tests",
		"plugin",
		"retina-local-fs",
	] as const) {
		const source = join(REPO_ROOT, "packages", packageName, "node_modules");
		if (existsSync(source)) {
			symlinkSync(
				source,
				join(destination, "packages", packageName, "node_modules"),
				"dir",
			);
		}
	}
	for (const name of ["commons", "subconscious"] as const) {
		const source = resolve(REPO_ROOT, "..", name);
		if (existsSync(source) && !existsSync(join(sharedRoot, name))) {
			symlinkSync(source, join(sharedRoot, name), "dir");
		}
	}

	// The instrument itself is held constant; only imported harness/plugin source
	// comes from the requested ref.
	copyFileSync(
		SCRIPT_PATH,
		join(destination, "packages/e2e-tests/scripts/pure-replay-differential.ts"),
	);
}

function captureRef(
	ref: string,
	slot: "left" | "right",
	sharedRoot: string,
): RefReplay {
	const destination = join(sharedRoot, slot);
	const commit = fullCommit(ref);
	extractRef(ref, destination, sharedRoot);
	const child = spawnSync(
		process.execPath,
		[
			"packages/e2e-tests/scripts/pure-replay-differential.ts",
			...(tsOnly ? ["--ts-only"] : []),
			...(priced
				? [
						"--priced",
						"--expected-local-budget",
						// Both refs now carry the Fable 5.1 calibration seed
						// (proseRatio 1.571778, toolsRatio 1.551639), so the calibrated
						// expectation applies to either slot; only --neutral removes it.
						neutral ? "60000" : "38173",
						"--expected-tool-ratio",
						neutral ? "1" : "1.551639",
					]
				: []),
			...(neutral ? ["--neutral"] : []),
			"--fixture-workdir",
			join(sharedRoot, "fixture-work"),
			"--single-ref",
			ref,
			"--single-commit",
			commit,
		],
		{ cwd: destination, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
	);
	if (child.status !== 0) {
		throw new Error(
			`pure replay failed for ${ref} (exit ${child.status ?? "signal"})\n${child.stdout}\n${child.stderr}`,
		);
	}
	const resultLine = child.stdout
		.split("\n")
		.find((line) => line.startsWith(RESULT_PREFIX));
	if (!resultLine)
		throw new Error(
			`pure replay for ${ref} emitted no result\n${child.stdout}`,
		);
	return JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as RefReplay;
}

function printRef(result: RefReplay): void {
	console.log(`REF ${result.ref} ${result.commit}`);
	if (result.hostFiles) console.log(`ISOLATION ${JSON.stringify(result.hostFiles)}`);
	if (result.priced) console.log(`PRICED ${JSON.stringify(result.priced)}`);
	for (const pass of result.passes) {
		console.log(
			`PASS ${pass.pass} decision=${pass.decision ?? "unknown"} bytes=${pass.bytes} sha256=${pass.sha256} system_sha256=${pass.systemSha256} tools_sha256=${pass.toolsSha256}`,
		);
	}
}

function compare(left: RefReplay, right: RefReplay): boolean {
	if (priced) {
		if (!left.priced || !right.priced) return false;
		// Each ref already checked its own HARD history against the expected
		// allowance; with the same calibration on both sides the HARD wire must match.
		const hard =
			left.priced.hardMessagesSha256 === right.priced.hardMessagesSha256;
		const tail =
			left.priced.commonHistorySha256 === right.priced.commonHistorySha256;
		const defers = [left, right].every(
			(r) =>
				r.passes.length === 4 &&
				r.passes.every(
					(p) =>
						p.decision === "defer" &&
						p.historySha256 === r.priced!.commonHistorySha256,
				),
		);
		console.log(
			`PRICED_GATE hard=${hard} tail_m0_equal=${tail} four_defers_each=${defers}`,
		);
		return hard && tail && defers;
	}
	let identical = left.passes.length === 4 && right.passes.length === 4;
	for (
		let index = 0;
		index < Math.max(left.passes.length, right.passes.length);
		index += 1
	) {
		const leftPass = left.passes[index];
		const rightPass = right.passes[index];

		const same =
			leftPass?.decision === "defer" &&
			rightPass?.decision === "defer" &&
			leftPass.bytes === rightPass.bytes &&
			leftPass.sha256 === rightPass.sha256 &&
			leftPass.systemSha256 === rightPass.systemSha256 &&
			leftPass.toolsSha256 === rightPass.toolsSha256;
		identical &&= same;
		console.log(
			`DEFER PASS ${index + 1} ${same ? "IDENTICAL" : "DIVERGENT"} left_bytes=${leftPass?.bytes ?? "missing"} left_sha256=${leftPass?.sha256 ?? "missing"} right_bytes=${rightPass?.bytes ?? "missing"} right_sha256=${rightPass?.sha256 ?? "missing"}`,
		);
	}
	return identical;
}

const singleRef = valueAfter("--single-ref");
const singleCommit = valueAfter("--single-commit");
if (singleRef) {
	if (!singleCommit) throw new Error("--single-ref requires --single-commit");
	const result = await captureCurrentCheckout(singleRef, singleCommit);
	console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
} else {
	const refs = Bun.argv
		.slice(2)
		.filter((argument) => !argument.startsWith("--"));
	if (refs.length !== 2) {
		console.error(
			"usage: bun pure-replay-differential.ts [--ts-only] <left-ref> <right-ref>",
		);
		process.exit(2);
	}
	// One fixed parent for every run's scratch tree, so a file watcher can exclude a
	// single path; macOS watch exclusions are fixed paths, not globs.
	const scratchParent = process.env.MC_REPLAY_SCRATCH_ROOT ?? join(REPO_ROOT, ".pure-replay-differential");
	mkdirSync(scratchParent, { recursive: true });
	const sharedRoot = mkdtempSync(join(realpathSync(scratchParent), "run-"));
	try {
		const left = captureRef(refs[0], "left", sharedRoot);
		const right = captureRef(refs[1], "right", sharedRoot);
		printRef(left);
		printRef(right);
		const deferPasses = left.passes.filter(
			(pass) => pass.decision === "defer",
		).length;
		const identical = deferPasses > 0 && compare(left, right);
		console.log(
			`RESULT ${identical ? (priced ? "PRICED_EXPECTATIONS_MET" : "IDENTICAL") : "DIVERGENT"} defer_passes=${deferPasses}`,
		);
		process.exitCode = identical ? 0 : 1;
	} finally {
		rmSync(sharedRoot, { recursive: true, force: true });
	}
}

async function capturePricedCheckout(
	harness: Awaited<ReturnType<typeof createReplayHarness>>,
	ref: string,
	commit: string,
): Promise<RefReplay> {
	if (
		!("readMessages" in harness) ||
		!("restart" in harness) ||
		!("openFixtureWriter" in harness)
	)
		throw new Error("priced comparison requires --ts-only");
	const { appendCompartments } = await import(
		"../../plugin/src/features/magic-context/compartment-storage"
	);
	const { queuePendingOp } = await import(
		"../../plugin/src/features/magic-context/storage"
	);
	const { renderDecayedCompartments } = await import(
		"../../plugin/src/hooks/magic-context/decay-render"
	);
	const sessionId = await harness.createSession();
	let db = harness.openFixtureWriter();
	try {
		const usage = { input_tokens: 1000, output_tokens: 10 };
		for (let i = 0; i < 26; i++) {
			harness.mock.setDefault({ text: `[[seed-answer-${i}]]`, usage });
			await harness.sendSeedPrompt(sessionId, `[[seed-prompt-${i}]]`);
		}
		const raw = (await harness.readMessages(sessionId)).filter(
			(m) => m.info.role === "user" || m.info.role === "assistant",
		);
		if (raw.length !== 52)
			throw new Error(`expected 52 real seed messages, got ${raw.length}`);
		const filler = "summary code decision result ";
		const compartments = raw.map((message, i) => ({
			sequence: i + 1,
			startMessage: i + 1,
			endMessage: i + 1,
			startMessageId: message.info.id,
			endMessageId: message.info.id,
			title: `Work arc ${i}`,
			content: "",
			p1: `P1_ROW_${i} ${filler.repeat(640)}`,
			p2: `P2_ROW_${i} ${filler.repeat(320)}`,
			p3: `P3_ROW_${i} ${filler.repeat(160)}`,
			p4: `P4_ROW_${i} ${filler.repeat(48)}`,
			importance: 50,
			legacy: 0,
		}));
		// The fixture opens Bun directly; shared helpers type their common SQL surface with the cross-runtime adapter.
		appendCompartments(
			db as unknown as Parameters<typeof appendCompartments>[0],
			sessionId,
			compartments,
		);
		// Restart to load the seeded rows; switching mock-sonnet to Fable requests a newly rendered history body.
		db.close();
		await harness.restart();
		db = harness.openFixtureWriter();
		harness.mock.setDefault({ text: "[[priced-answer]]", usage });
		await harness.sendPrompt(sessionId, "[[priced-hard-edge]]");
		const latestDecision = () =>
			db
				.prepare(
					"SELECT decision, materialized, materialize_reason FROM transform_decisions WHERE session_id = ? ORDER BY ts_ms DESC LIMIT 1",
				)
				.get(sessionId) as {
				decision: string;
				materialized: number;
				materialize_reason: string;
			} | null;
		const history = () => {
			const request = harness.mainRequests().at(-1);
			const texts = (request?.body.messages ?? []).flatMap((m) =>
				typeof m.content === "string"
					? [m.content]
					: Array.isArray(m.content)
						? m.content.flatMap((p: unknown) =>
								p &&
								typeof p === "object" &&
								typeof (p as { text?: unknown }).text === "string"
									? [(p as { text: string }).text]
									: [],
							)
						: [],
			);
			const block = texts
				.join("\n")
				.match(/<session-history>[\s\S]*?<\/session-history>/)?.[0];
			if (!block)
				throw new Error("actual provider capture has no history block");
			return block;
		};
		const budget = Number(valueAfter("--expected-local-budget"));
		const expectedHistory = `<session-history>\n${renderDecayedCompartments({ compartments, historyBudgetTokens: budget })}\n</session-history>`;
		const actualHardHistory = history();
		if (actualHardHistory !== expectedHistory) {
			const meta = db
				.prepare(
					"SELECT cached_m0_upgrade_state, cached_m0_model_key, last_usage_context_limit FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId);
			const markers = (text: string) =>
				[...new Set(text.match(/P[1-4]_ROW_\d+/g) ?? [])].join(",");
			throw new Error(
				`HARD history differs from independent local allowance ${budget}: actual=${hash(actualHardHistory)} expected=${hash(expectedHistory)} decision=${JSON.stringify(latestDecision())} meta=${JSON.stringify(meta)} actualTiers=${markers(actualHardHistory)} expectedTiers=${markers(expectedHistory)}`,
			);
		}
		if (latestDecision()?.materialized !== 1)
			throw new Error(
				`expected an existing HARD materialization edge: ${JSON.stringify(latestDecision())}`,
			);
		const hardMessagesSha256 = hash(harness.lastMainWireSerialized("messages"));
		for (let i = 0; i < 8; i++) {
			harness.mock.script([
				{
					content: [
						{
							type: "tool_use",
							id: `priced-tool-${i}`,
							name: "bash",
							input: {
								command: 'python3 -c \'print("word " * 999, end="")\'',
								description: "Synthetic calibration fixture",
							},
						},
					],
					stop_reason: "tool_use",
					usage,
				},
				{ text: `[[tool-complete-${i}]]`, usage },
			]);
			await harness.sendPrompt(sessionId, `[[tool-fixture-${i}]]`);
		}
		const rows = db
			.prepare(
				"SELECT tag_number, token_count FROM tags WHERE session_id = ? AND type = 'tool' AND message_id LIKE 'priced-tool-%' ORDER BY tag_number",
			)
			.all(sessionId) as Array<{
			tag_number: number;
			token_count: number | null;
		}>;
		if (
			rows.length !== 8 ||
			rows.some((r) => !r.token_count || r.token_count <= 0)
		)
			throw new Error(
				`tool fixture was not observed completely: rows=${rows.length}`,
			);
		const ratio = Number(valueAfter("--expected-tool-ratio"));
		const protectedTags = new Set<number>();
		let mass = 0;
		for (const row of [...rows].reverse()) {
			protectedTags.add(row.tag_number);
			mass += row.token_count! * ratio;
			if (Math.ceil(mass) >= 6000 && protectedTags.size >= 3) break;
		}
		const expectedDropped = rows
			.filter((r) => !protectedTags.has(r.tag_number))
			.map((r) => r.tag_number);
		if (expectedDropped.length === 0)
			throw new Error("tail fixture has no independently eligible tool tags");
		// Seed identical cached history in master and candidate; queued tool drops must not re-render it.
		const commonHistory = `<session-history>\n${renderDecayedCompartments({ compartments, historyBudgetTokens: 60000 })}\n</session-history>`;
		db.prepare(
			"UPDATE session_meta SET cached_m0_bytes = ? WHERE session_id = ?",
		).run(Buffer.from(commonHistory), sessionId);
		db.close();
		await harness.restart();
		db = harness.openFixtureWriter();
		// After restart, supply current provider usage before testing drops. At 85.5% drops are allowed
        // while the newest protected tools remain protected; that protection can be yielded at 95%.
		harness.mock.script([]);
		harness.mock.setDefault({
			text: "[[pressure-prime-answer]]",
			usage: { input_tokens: 171000, output_tokens: 10 },
		});
		await harness.sendPrompt(sessionId, "[[prime-tail-pressure]]");
		const readPressure = () =>
			db
				.prepare(
					"SELECT last_input_tokens, last_context_percentage FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as {
				last_input_tokens: number;
				last_context_percentage: number;
			};
		const pressureDeadline = Date.now() + 3000;
		while (
			readPressure().last_input_tokens < 171000 &&
			Date.now() < pressureDeadline
		)
			await Bun.sleep(20);
		if (readPressure().last_input_tokens < 171000)
			throw new Error(
				`pressure priming was not persisted: ${JSON.stringify(readPressure())}`,
			);
		for (const row of rows)
			queuePendingOp(
				db as unknown as Parameters<typeof queuePendingOp>[0],
				sessionId,
				row.tag_number,
				"drop",
				Date.now(),
			);
		harness.mock.setDefault({ text: "[[tail-answer]]", usage });
		const tailMaterializedAt = (
			db
				.prepare(
					"SELECT cached_m0_materialized_at AS at FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as { at: number }
		).at;
		const tailCursor = harness.schedulerCursor(sessionId);
		await harness.sendPrompt(sessionId, "[[tail-only-bust]]");
		const tailDecisions = await harness.schedulerSince(sessionId, tailCursor);
		const afterTailMaterializedAt = (
			db
				.prepare(
					"SELECT cached_m0_materialized_at AS at FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as { at: number }
		).at;
		if (
			history() !== commonHistory ||
			afterTailMaterializedAt !== tailMaterializedAt ||
			!tailDecisions.includes("execute")
		)
			throw new Error(
				`tail-only edge did not preserve the generation: latestPriced=${JSON.stringify(latestDecision())} scheduler=${tailDecisions} materializedAtSame=${afterTailMaterializedAt === tailMaterializedAt} observed=${harness.schedulerLastLine(sessionId)}`,
			);
		const actualDropped = (
			db
				.prepare(
					"SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' AND message_id LIKE 'priced-tool-%' AND status = 'dropped' ORDER BY tag_number",
				)
				.all(sessionId) as Array<{ tag_number: number }>
		).map((r) => r.tag_number);
		if (JSON.stringify(actualDropped) !== JSON.stringify(expectedDropped))
			throw new Error(
				`tail eligibility differs: expected=${expectedDropped} actual=${actualDropped} decision=${JSON.stringify(latestDecision())}`,
			);
		const tailMessagesSha256 = hash(harness.lastMainWireSerialized("messages"));
		const settledDeadline = Date.now() + 3000;
		while (
			readPressure().last_input_tokens > 1000 &&
			Date.now() < settledDeadline
		)
			await Bun.sleep(20);
		if (readPressure().last_input_tokens > 1000)
			throw new Error("tail response usage did not settle before defer checks");
		const passes: ReplayPass[] = [];
		for (let i = 0; i < 4; i++) {
			if (i === 2) {
				db.close();
				await harness.restart();
				db = harness.openFixtureWriter();
			}
			harness.mock.setDefault({ text: `[[priced-defer-answer-${i}]]`, usage });
			const cursor = harness.schedulerCursor(sessionId);
			await harness.sendPrompt(sessionId, `[[priced-defer-${i}]]`);
			const decisions = await harness.schedulerSince(sessionId, cursor);
			if (decisions.some((d) => d !== "defer"))
				throw new Error(
					`priced generation defer ${i + 1} was not a defer: ${decisions}`,
				);
			const wire = harness.lastMainWireSerialized("messages");
			const historySha256 = hash(history());
			if (historySha256 !== hash(commonHistory))
				throw new Error(`defer ${i + 1} changed cached m0`);
			passes.push({
				pass: i + 1,
				decision: decisions.at(-1) ?? null,
				bytes: Buffer.byteLength(wire),
				sha256: hash(wire),
				systemSha256: hash(
					harness.lastMainWireSerialized("system" as "messages"),
				),
				toolsSha256: hash(
					harness.lastMainWireSerialized("tools" as "messages"),
				),
				historySha256,
			});
		}
		return {
			ref,
			commit,
			passes,
			priced: {
				mode: neutral ? "neutral" : "fable",
				hardMessagesSha256,
				hardHistorySha256: hash(actualHardHistory),
				expectedLocalBudget: budget,
				commonHistorySha256: hash(commonHistory),
				tailMessagesSha256,
				expectedDropped,
				actualDropped,
				restarted: true,
			},
		};
	} finally {
		db.close();
	}
}

function schedulerObserver(logPath: string) {
	const lines = (sessionId: string) =>
		existsSync(logPath)
			? readFileSync(logPath, "utf8")
					.split("\n")
					.filter(
						(line) =>
							line.includes(`[${sessionId}]`) &&
							line.includes("transform scheduler:"),
					)
			: [];
	return {
		schedulerCursor: (sessionId: string) => lines(sessionId).length,
		schedulerLastLine: (sessionId: string) => lines(sessionId).at(-1),
		schedulerSince: async (sessionId: string, cursor: number) => {
			const deadline = Date.now() + 2000;
			while (lines(sessionId).length <= cursor && Date.now() < deadline)
				await Bun.sleep(10);
			const observed = lines(sessionId).slice(cursor);
			if (!observed.length)
				throw new Error("no current transform scheduler observation");
			return observed.map(
				(line) => line.match(/decision=(execute|defer)/)?.[1] ?? "unknown",
			);
		},
	};
}
