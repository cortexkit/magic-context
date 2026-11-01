/**
 * Issue 610 investigation: measure the first expired request and every request
 * after it on a real host. The long tool-loop probe is opt-in because it sends
 * about 240k tokens of history; the ordinary restart regression runs in CI.
 */
import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { estimateTokens } from "../../plugin/src/hooks/magic-context/read-session-formatting";
import type { CapturedRequest } from "../src/mock-provider/server";
import { inspectHostOpenFiles } from "../src/host-open-files";
import {
	createFreshSession,
	createScenarioHarness,
	forEachHost,
	type ScenarioHarness,
} from "../src/scenario-hosts";
import { openTestDb } from "../src/test-db";
import { createE2ETempDir } from "../src/temp-dir";
import { PLUGIN_ENTRY } from "../src/opencode-runner/spawn";
import { TestHarness } from "../src/harness";
import { PiTestHarness } from "../src/pi-harness";
import { OpenCode } from "@opencode/client";

const IDLE = 16.5 * 60 * 60 * 1000;
const RUST_MODE = process.env.MC_E2E_MODE === "rust";
const LOW_USAGE = {
	input_tokens: 10_000,
	output_tokens: 10,
	cache_creation_input_tokens: 0,
};
const LONG_USAGE = {
	input_tokens: 240_000,
	output_tokens: 10,
	cache_creation_input_tokens: 0,
};

type Decision = {
	message_id: string;
	ts_ms: number;
	decision: string;
	materialized: number;
	materialize_reason: string | null;
};
type Turn = {
	label: string;
	start: number;
	end: number;
	passLog: string[];
	requests: CapturedRequest[];
};

/** Hosts move cache breakpoints forward; only that metadata is excluded. */
function durable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(durable);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== "cache_control")
				.map(([key, inner]) => [key, durable(inner)]),
		);
	}
	return value;
}

const serialize = (value: unknown) => JSON.stringify(durable(value));
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");

function prefixComparison(first: CapturedRequest, second: CapturedRequest) {
	const a = serialize(first.body.messages);
	const b = serialize(
		second.body.messages?.slice(0, first.body.messages?.length),
	);
	let commonChars = 0;
	while (
		commonChars < Math.min(a.length, b.length) &&
		a[commonChars] === b[commonChars]
	)
		commonChars++;
	return {
		identicalMessages: a === b,
		identicalSystem:
			serialize(first.body.system) === serialize(second.body.system),
		identicalTools:
			serialize(first.body.tools) === serialize(second.body.tools),
		sharedMessageBytes: Buffer.byteLength(a.slice(0, commonChars)),
		priorMessageBytes: Buffer.byteLength(a),
		sharedMessageTokensEstimate: estimateTokens(a.slice(0, commonChars)),
		priorMessageTokensEstimate: estimateTokens(a),
		firstMessageSha256: hash(a),
		secondPrefixSha256: hash(b),
	};
}

function assertReplay(
	first: CapturedRequest,
	second: CapturedRequest,
	ompBilling = false,
) {
	const comparison = prefixComparison(first, second);
	// This compares the whole previous request, not merely the synthetic head.
	expect(comparison.identicalMessages).toBe(true);
	if (ompBilling) {
		// OMP adds a per-request Claude Code billing checksum outside MC. Keep
		// that raw difference in the evidence, but compare every instruction.
		const instructions = (value: unknown) =>
			Array.isArray(value)
				? value.filter(
						(block) =>
							!String((block as { text?: string }).text ?? "").startsWith(
								"x-anthropic-billing-header:",
							),
					)
				: value;
		expect(serialize(instructions(second.body.system))).toBe(
			serialize(instructions(first.body.system)),
		);
	} else {
		expect(comparison.identicalSystem).toBe(true);
	}
	expect(comparison.identicalTools).toBe(true);
}

function assertContained(h: ScenarioHarness) {
	const handle = h as unknown as {
		opencode?: { pid: number };
		hostPid?: number;
		fixture?: { pid: number };
	};
	const pid = handle.opencode?.pid ?? handle.hostPid ?? handle.fixture?.pid;
	// The v2 runner already checks its entire process group at handoff/teardown.
	if (h.host === "opencode2")
		return { guardedBy: "OC2 runner process-group/inode guard" };
	if (!pid) throw new Error("host PID unavailable for live-store isolation");
	// OMP is spawned directly as Bun + CLI, not through a shell wrapper.
	// Requiring context.db's inode makes a stale or wrapper PID fail closed.
	const hostInventory = inspectHostOpenFiles(pid, dirname(h.dataDir),
		h.host === "omp" ? h.contextDbPath() : undefined);
	expect(hostInventory.databases.length).toBeGreaterThan(0);
	const moduleInventories = RUST_MODE
		? (JSON.parse(
				readFileSync(join(h.dataDir, "cortexkit", "rust-e2e-pids.json"), "utf8"),
			) as { pids: { pid: number; role: string }[] }).pids
			.filter((entry) => entry.role === "module" || entry.role === "daemon")
			.map((entry) => {
				const inventory = inspectHostOpenFiles(entry.pid, dirname(h.dataDir));
				if (entry.role === "module") expect(inventory.databases.length).toBeGreaterThan(0);
				return { ...entry, ...inventory };
			})
		: [];
	return { ...hostInventory, moduleInventories };
}

function moduleDbPath(h: ScenarioHarness) {
	return join(h.dataDir, "cortexkit", "magic-context", "store.db");
}

function moduleMeta(h: ScenarioHarness, session: string) {
	const db = openTestDb(moduleDbPath(h), { readonly: true });
	try {
		const row = db.query("SELECT meta FROM mc_cache_state WHERE session_id = ?")
			.get(session) as { meta: string };
		return JSON.parse(row.meta) as {
			expiry_cutoff_ms: number;
			last_system_prompt_hash: string;
			last_render_config: string;
		};
	} finally {
		db.close();
	}
}

async function queueDrop(h: ScenarioHarness, session: string, tag: number) {
	if (RUST_MODE) {
		if (!(h instanceof TestHarness) || !h.rustStack) {
			throw new Error("Rust module stack unavailable");
		}
		const response = await h.rustStack.moduleRequest(session, h.workdir, {
			name: "ctx_reduce", arguments: { drop: String(tag) },
		});
		expect(response.isError).not.toBe(true);
	} else {
		const db = openTestDb(h.contextDbPath());
		try {
			db.prepare(
				"INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, ?)",
			).run(session, tag, Date.now(), h.harnessId);
		} finally {
			db.close();
		}
	}
}

function pendingCount(h: ScenarioHarness, session: string): number {
	const db = openTestDb(RUST_MODE ? moduleDbPath(h) : h.contextDbPath(), {
		readonly: true,
	});
	try {
		return (db.query(RUST_MODE
			? "SELECT COUNT(*) AS n FROM pending_agent_drops WHERE session_id = ?"
			: "SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ?",
		).get(session) as { n: number }).n;
	} finally {
		db.close();
	}
}

function expire(h: ScenarioHarness, session: string, acrossMidnight = false) {
	const today = new Date();
	today.setUTCHours(0, 0, 0, 0);
	const idleOffset = acrossMidnight
		? Math.max(IDLE, Date.now() - (today.getTime() - 3_600_000))
		: IDLE;
	const db = openTestDb(h.contextDbPath());
	try {
		// Preserve response-after-fold ordering. Aging only the response clock
		// would instead describe an expiry already consumed by a newer fold.
		const result = db
			.prepare(
				"UPDATE session_meta SET last_response_time = last_response_time - ?, cached_m0_materialized_at = cached_m0_materialized_at - ? WHERE session_id = ? AND harness = ? AND last_response_time > 0",
			)
			.run(idleOffset, idleOffset, session, h.harnessId);
		expect(result.changes).toBe(1);
	} finally {
		db.close();
	}
	if (RUST_MODE) {
		const moduleDb = openTestDb(moduleDbPath(h));
		try {
			expect(moduleDb.query(
				"UPDATE mc_cache_state SET meta = json_set(meta, '$.expiry_cutoff_ms', json_extract(meta, '$.expiry_cutoff_ms') - ?) WHERE session_id = ?",
			).run(idleOffset, session).changes).toBe(1);
		} finally {
			moduleDb.close();
		}
	}
	if (h.host === "opencode2") {
		// Native v2 re-reads the last accepted reply's completion time before
		// scheduling. Age that persisted source too; otherwise it correctly
		// replaces an artificially older MC watermark with the recent reply.
		const env = (h as unknown as { opencode: { env: { OPENCODE_DB: string } } })
			.opencode.env;
		const hostDb = openTestDb(join(h.dataDir, "opencode", env.OPENCODE_DB));
		try {
			hostDb
				.prepare(
					"UPDATE session_message SET data = json_set(data, '$.time.completed', json_extract(data, '$.time.completed') - ?) WHERE session_id = ? AND type = 'assistant'",
				)
				.run(idleOffset, session);
		} finally {
			hostDb.close();
		}
	}
}

async function probe(
	host: Parameters<typeof createScenarioHarness>[0],
	restart: boolean,
	long: boolean,
	queued: boolean,
	abortAndChange = false,
) {
	const previousLogPath = process.env.MAGIC_CONTEXT_LOG_PATH;
	const traceRoot = createE2ETempDir("ttl-trace-");
	const logPath = join(traceRoot, "pass.log");
	const systemEpochPath = join(traceRoot, "system-epoch.txt");
	const epochPlugin = join(traceRoot, "system-epoch.js");
	if (abortAndChange) {
		writeFileSync(systemEpochPath, "old");
		writeFileSync(
			epochPlugin,
			`import plugin from ${JSON.stringify(process.env.MC_E2E_PLUGIN_ENTRY ?? PLUGIN_ENTRY)};
export default async (ctx) => {
    const hooks = await (typeof plugin === "function" ? plugin : plugin.server)(ctx);
    const system = hooks["experimental.chat.system.transform"];
    const messages = hooks["experimental.chat.messages.transform"];
    const pending = new Map();
    const transformed = new Set();
    return { ...hooks,
        "experimental.chat.system.transform": async (input, output) => {
            if (!input.sessionID || output.system.join("\\n").includes("You are a title generator")) return system(input, output);
            const stage = await Bun.file(${JSON.stringify(systemEpochPath)}).text();
            const date = stage === "old" || stage === "aborted" ? "Fri Oct 02 2026" : "Sat Oct 03 2026";
            for (let i = 0; i < output.system.length; i++) output.system[i] = output.system[i].replace(/Today's date: [^\\n]+/g, "Today's date: " + date);
            // Seed the actual system identity on both paths before delaying the
            // returning request's observer into the reporter's messages-first order.
            if (stage === "old") {
                transformed.delete(input.sessionID);
                return system(input, output);
            }
            // Render guidance before the host copies its system text, but delay
            // the real session's hash observation until its messages pass. The
            // reporter's Desktop used that order; the CLI can observe it earlier.
            await system({ ...input, sessionID: input.sessionID + ":render:" + Date.now() }, output);
            // OpenCode 1.18.32 runs messages before system. In that order the
            // current request is already transformed, so observe it now, before
            // its reply completes, rather than on the next warm tool step.
            if (transformed.delete(input.sessionID)) {
                if (stage !== "aborted") await system(input, output);
                return;
            }
            pending.set(input.sessionID, { input, output, stage });
        },
        "experimental.chat.messages.transform": async (input, output) => {
            const sid = output.messages.find((message) => message.info?.sessionID)?.info.sessionID;
            await messages(input, output);
            transformed.add(sid);
            const next = pending.get(sid);
            if (next) {
                pending.delete(sid);
                transformed.delete(sid);
                if (next.stage !== "aborted") {
                    await system(next.input, next.output);
                }
            }
        }
    };
};`,
		);
	}
	process.env.MAGIC_CONTEXT_LOG_PATH = logPath;
	let h: ScenarioHarness | undefined;
	try {
		h = await createScenarioHarness(host, {
			modelContextLimit: long ? 1_000_000 : 100_000,
			prepareContextDatabase: process.env.IDLE_TTL_RELEASE !== "0.44.4",
			...(abortAndChange
				? {
						openCodeConfigExtra: {
							plugin: [`file://${epochPlugin}`],
						},
					}
				: {}),
			magicContextConfig: {
				cache_ttl: { default: abortAndChange ? "15s" : "1h" },
				execute_threshold_percentage: long ? 65 : 90,
				protected_tokens: 4_000,
				historian: { disable: true },
			},
			mockDefault: { text: "answer", usage: long ? LONG_USAGE : LOW_USAGE },
		});
		const harness = h;
		const session = await createFreshSession(h);
		const turns: Turn[] = [];
		const inventories: unknown[] = [];
		const logs = () =>
			host === "opencode2"
				? (
						h as unknown as { opencode: { pluginLog: () => string } }
					).opencode.pluginLog()
				: existsSync(logPath)
					? readFileSync(logPath, "utf8")
					: "";
		const turn = async (label: string, text = label): Promise<Turn> => {
			const start = Date.now();
			const count = harness.requests().length;
			await harness.sendPrompt(session, text, { timeoutMs: 90_000 });
			await harness.waitForMockQuiescence();
			// Host title generation has no context transform. Do not count it
			// as another pass or compare its unrelated prompt with the session.
			const requests = harness
				.requests()
				.slice(count)
				.filter(
					(request) =>
						Array.isArray(request.body.tools) &&
						request.body.tools.length > 0 &&
						JSON.stringify(request.body.system).includes("## Magic Context"),
				);
			expect(requests.length).toBeGreaterThan(0);
			const currentLines = () =>
				logs()
					.split("\n")
					.filter(
						(line) =>
							line.includes(session) && Date.parse(line.slice(1, 25)) >= start,
					);
			// Logs flush asynchronously. Require a completed transform, not an
			// early scheduler line flushed ahead of materialization. Channel 2
			// nudges can send an extra provider request without another messages
			// transform, so network request count is not a transform-log count.
			// Keep every captured request below for the byte replay assertions.
			await harness.waitFor(
				() =>
					currentLines().filter((line) =>
						/transform completed|rust pass:/.test(line),
					).length > 0,
				{ timeoutMs: 5_000, label: "complete idle pass logs" },
			);
			const result = {
				label,
				start,
				end: Date.now(),
				passLog: currentLines(),
				requests,
			};
			turns.push(result);
			return result;
		};
		if (long) {
			// Calibrate the varied prose with the local Claude tokenizer instead
			// of assuming the ballast helper's approximate 4 chars/token ratio.
			const sample = h.ballast(10_000);
			const chunk = h.ballast(
				Math.round((75_000 * 10_000) / estimateTokens(sample)),
			);
			// Seed through real provider replies. Very large single user inputs
			// exercise the host's attachment parser rather than a resumed history.
			h.mock.setDefault({ text: chunk, usage: LONG_USAGE });
			for (let i = 0; i < 3; i++) await turn(`history-${i}`);
			h.mock.setDefault({ text: "answer", usage: LONG_USAGE });
		} else {
			await turn("initial");
		}
		const warm = await turn("warm");
		if (abortAndChange)
			expect(JSON.stringify(warm.requests[0]!.body.system)).toContain(
				"Today's date: Fri Oct 02 2026",
			);
		inventories.push(assertContained(h));
		if (queued) {
			await queueDrop(h, session, 1);
			await turn("warm with queued drop");
			expect(pendingCount(h, session)).toBe(1);
		}
		expire(h, session, abortAndChange);
		if (restart) {
			const dataDir = h.dataDir;
			await h.restart();
			expect(h.dataDir).toBe(dataDir);
		}
		inventories.push(assertContained(h));
		let responseClockAfterAbort: unknown;
		let preparedModuleMeta: unknown;
		if (abortAndChange) {
			// Also cross a real TTL window: the old module's process-local prepare
			// clock cannot be aged by editing the host's durable completion clock.
			await Bun.sleep(16_000);
			writeFileSync(systemEpochPath, "aborted");
			const abortedStart = Date.now();
			const count = h.requests().length;
			h.mock.enqueue({
				text: "never served",
				usage: { input_tokens: 0, output_tokens: 0 },
				delayMs: 5_000,
			});
			const aborted = h
				.sendPrompt(session, "aborted idle attempt", { timeoutMs: 30_000 })
				.catch((error) => {
					expect(String(error)).toContain("MessageAbortedError");
				});
			await h.waitFor(() => h!.requests().length > count, {
				label: "aborted request reaches provider",
			});
			const response = await fetch(`${h.serverUrl}/session/${session}/abort`, {
				method: "POST",
			});
			expect(response.ok).toBe(true);
			await aborted;
			turns.push({
				label: "aborted idle attempt",
				start: abortedStart,
				end: Date.now(),
				passLog: logs()
					.split("\n")
					.filter(
						(line) =>
							line.includes(session) &&
							Date.parse(line.slice(1, 25)) >= abortedStart,
					),
				requests: h.requests().slice(count),
			});
			responseClockAfterAbort = h
				.contextDb()
				.prepare(
					"SELECT last_response_time FROM session_meta WHERE session_id = ? AND harness = ?",
				)
				.get(session, h.harnessId);
			if (RUST_MODE) preparedModuleMeta = moduleMeta(h, session);
			const hostMessages = (await (
				await fetch(`${h.serverUrl}/session/${session}/message`)
			).json()) as { info: { id: string; role: string } }[];
			const lastUser = [...hostMessages]
				.reverse()
				.find((message) => message.info.role === "user")!.info.id;
			const reverted = await fetch(`${h.serverUrl}/session/${session}/revert`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messageID: lastUser }),
			});
			expect(reverted.ok).toBe(true);
			writeFileSync(systemEpochPath, "new");
			await queueDrop(h, session, 2);
		}
		if (long) {
			// Two real bash tool calls in the returning turn. New provider usage
			// arrives between context passes, as it does in the dashboard steps.
			const bashName = (
				warm.requests.at(-1)!.body.tools as { name: string }[]
			).find((tool) => tool.name === "bash")?.name;
			expect(bashName).toBe("bash");
			for (let step = 0; step < 2; step++) {
				h.mock.enqueue({
					content: [
						{
							type: "tool_use",
							id: `toolu_idle_${step}`,
							name: bashName!,
							input: {
								command: `printf 'idle probe ${step}\\n'`,
								description: `idle probe ${step}`,
							},
						},
					],
					stop_reason: "tool_use",
					usage: LONG_USAGE,
				});
			}
			h.mock.enqueue({ text: "loop finished", usage: LONG_USAGE });
		}
		const first = await turn("resume after idle");
		const second = await turn("next warm turn");
		inventories.push(assertContained(h));
		// Pi binds a pending decision at the NEXT context pass, once the host's
		// branch includes the assistant. The row can be persisted after the provider
		// reply and after the context pass is logged, so wait for the expired pass's
		// durable row, not network idle.
		const readDecisions = () =>
			harness
				.contextDb()
				.prepare(
					"SELECT * FROM transform_decisions WHERE session_id = ? AND harness = ? ORDER BY ts_ms",
				)
				.all(session, host === "omp" ? "pi" : harness.harnessId) as Decision[];
		if (host !== "opencode2") {
			await h.waitFor(
				() =>
					readDecisions().some(
						(row) =>
							row.ts_ms >= first.start &&
							row.ts_ms <= first.end &&
							["ttl_idle", "ttl_expiry"].includes(row.materialize_reason ?? ""),
					),
				{
					timeoutMs: 5_000,
					label: `persisted idle TTL decision for ${session} in ${first.start}..${first.end}`,
				},
			);
		}
		const decisions = readDecisions();
		const expiredDecision = decisions.find(
			(row) => row.ts_ms >= first.start && row.ts_ms <= first.end,
		);
		const afterExpiry = [...first.requests, ...second.requests];
		const comparisons = afterExpiry
			.slice(1)
			.map((request, index) => prefixComparison(afterExpiry[index]!, request));
		const summary = {
			host,
			restart,
			long,
			queued,
			abortAndChange,
			responseClockAfterAbort,
			preparedModuleMeta,
			finalModuleMeta: RUST_MODE ? moduleMeta(h, session) : undefined,
			release: process.env.IDLE_TTL_RELEASE ?? "worktree",
			mode: process.env.MC_E2E_MODE ?? "ts",
			session,
			decisions,
			turns: turns.map((entry) => ({
				label: entry.label,
				passLog: entry.passLog.filter((line) =>
					/scheduler|rematerialized|HARD fold|rust pass:|decision=|nudge|caveman|auto-search/.test(
						line,
					),
				),
				requests: entry.requests.map((request) => ({
					rawBytes: Buffer.byteLength(request.rawBody!),
					sha256: hash(request.rawBody!),
					receivedAt: request.receivedAt,
				})),
			})),
			comparisons,
		};
		console.log("IDLE_TTL_REPLAY", JSON.stringify(summary));
		const evidence = process.env.IDLE_TTL_EVIDENCE;
		if (evidence) {
			mkdirSync(evidence, { recursive: true });
			const name = `${host}-${summary.mode}-${restart ? "restart" : "continuous"}-${long ? "long-loop" : "single"}-${queued ? "queued" : "plain"}${abortAndChange ? "-abort-system" : ""}`;
			writeFileSync(
				join(evidence, `${name}.json`),
				JSON.stringify({ summary, inventories, turns }, null, 2),
			);
			writeFileSync(join(evidence, `${name}.log`), logs());
		}
		if (host === "opencode2") {
			// The native v2 usage hook does not bind the v1 delegate's pending
			// decision row. Verify its actual fold log and bytes without claiming
			// that the absent telemetry row exists in this harness.
			expect(
				first.passLog.some((line) =>
					/reason=ttl_idle executed=true/.test(line),
				),
			).toBe(true);
			expect(
				second.passLog.some((line) =>
					/reason=ttl_idle executed=true/.test(line),
				),
			).toBe(false);
		} else {
			expect(expiredDecision).toMatchObject({
				decision: "execute",
				materialized: abortAndChange ? 0 : 1,
			});
			expect(["ttl_idle", "ttl_expiry"]).toContain(
				expiredDecision!.materialize_reason ?? "",
			);
			expect(
				decisions.filter(
					(row) =>
						row.ts_ms >= first.start &&
						["ttl_idle", "ttl_expiry"].includes(row.materialize_reason ?? ""),
				),
			).toHaveLength(1);
		}
		expect(first.requests).toHaveLength(long ? 3 : 1);
		for (let i = 1; i < afterExpiry.length; i++)
			assertReplay(afterExpiry[i - 1]!, afterExpiry[i]!, host === "omp");
		if (abortAndChange) {
			writeFileSync(systemEpochPath, "aborted");
			expect(JSON.stringify(first.requests[0]!.body.system)).toContain(
				"Today's date: Sat Oct 03 2026",
			);
			expect(
				(responseClockAfterAbort as { last_response_time: number })
					.last_response_time,
			).toBeLessThan(Date.now() - IDLE + 60_000);
			expect(
				first.passLog.some((line) =>
					/adopting on idle-expired request/.test(line),
				),
			).toBe(true);
			expect(
				first.passLog.filter((line) =>
					/reason=system_hash executed=true/.test(line),
				),
			).toHaveLength(0);
		}
		if (queued || abortAndChange) {
			expect(pendingCount(h, session)).toBe(0);
		}
		if (RUST_MODE && abortAndChange) {
			const meta = moduleMeta(h, session);
			expect(meta.expiry_cutoff_ms).toBe((preparedModuleMeta as typeof meta).expiry_cutoff_ms);
			const hostMeta = h.contextDb().query("SELECT system_prompt_hash FROM session_meta WHERE session_id = ? AND harness = ?").get(session, h.harnessId) as { system_prompt_hash: string };
			expect(meta.last_system_prompt_hash).toBe(hostMeta.system_prompt_hash);
		}
	} finally {
		await h?.dispose();
		if (previousLogPath === undefined)
			delete process.env.MAGIC_CONTEXT_LOG_PATH;
		else process.env.MAGIC_CONTEXT_LOG_PATH = previousLogPath;
	}
}

forEachHost(import.meta.url, "idle TTL head replay", (host) => {
	it("completed replies without usage spend one expiry after a reporting/model switch, but failures do not", async () => {
		const oldLogPath = process.env.MAGIC_CONTEXT_LOG_PATH;
		const logPath = join(createE2ETempDir("no-usage-clock-"), "pass.log");
		process.env.MAGIC_CONTEXT_LOG_PATH = logPath;
		const h = await createScenarioHarness(host, {
			modelContextLimit: 100_000,
			historianMockModel: { id: "usage-less", contextLimit: 100_000 },
			magicContextConfig: {
				cache_ttl: { default: "1h" },
				execute_threshold_percentage: 90,
				historian: { disable: true },
			},
			mockDefault: { text: "measured answer", usage: LOW_USAGE },
		});
		try {
			const session = await createFreshSession(h);
			const clock = () =>
				(
					h
						.contextDb()
						.prepare(
							"SELECT last_response_time AS at FROM session_meta WHERE session_id = ? AND harness = ?",
						)
						.get(session, h.harnessId) as { at: number }
				).at;
			const logs = () =>
				host === "opencode2"
					? (
							h as unknown as { opencode: { pluginLog: () => string } }
						).opencode.pluginLog()
					: existsSync(logPath)
						? readFileSync(logPath, "utf8")
						: "";
			const send = (text: string) =>
				h instanceof TestHarness
					? h.sendPrompt(session, text, {
							modelID:
								text === "initial measured reply"
									? "mock-sonnet"
									: "usage-less",
							timeoutMs: 60_000,
						})
					: h.sendPrompt(session, text, { timeoutMs: 60_000 });
			await send("initial measured reply");
			await h.waitForMockQuiescence();
			const measuredClock = clock();
			expect(measuredClock).toBeGreaterThan(0);
			h.mock.setDefault({
				text: "completed without usage",
				usage: { input_tokens: 0, output_tokens: 0 },
			});
			await send("switch to replies without usage");
			await send("settle the new model identity");
			await h.waitForMockQuiescence();
			expect(clock()).toBeGreaterThan(measuredClock);
			expire(h, session);
			const expiredClock = clock();
			const start = Date.now();
			await send("one expired request with no usage");
			await h.waitFor(() => clock() > expiredClock, {
				timeoutMs: 5_000,
				label: "usage-less completion spends expiry",
			});
			await send("warm request with no usage");
			await h.waitForMockQuiescence();
			// Wait for the two scheduler lines asserted below (the expired execute and
			// the warm defer). Other `decision=` lines, such as a HARD pass's todo
			// permission probe, can satisfy a looser count while the warm pass's line is
			// still in the plugin's buffered log.
			const schedulerLine = RUST_MODE
				? /rust pass:.*scheduler=(?:execute|defer)/
				: /(?:scheduler:|transform: usage=).*decision=(?:execute|defer)/;
			await h.waitFor(
				() =>
					logs()
						.split("\n")
						.filter(
							(line) =>
								line.includes(session) &&
								Date.parse(line.slice(1, 25)) >= start &&
								schedulerLine.test(line),
						).length >= 2,
				{ timeoutMs: 5_000, label: "no-usage scheduler logs" },
			);
			const passLog = logs()
				.split("\n")
				.filter(
					(line) =>
						line.includes(session) &&
						Date.parse(line.slice(1, 25)) >= start &&
						/decision=|rematerialized/.test(line),
				);
			expect(
				passLog.filter((line) =>
					(RUST_MODE ? /rust pass:.*scheduler=execute/ : /(?:scheduler:|transform: usage=).*decision=execute/).test(line),
				),
			).toHaveLength(1);
			expect(passLog.some((line) => (RUST_MODE ? /scheduler=defer/ : /decision=defer/).test(line))).toBe(true);
			const beforeAbort = clock();
			const count = h.requests().length;
			// Hold an active stream so the abort precedes any clean terminal reply.
			h.mock.enqueue(
				h instanceof PiTestHarness
					? {
							error: {
								status: 400,
								type: "invalid_request_error",
								message: "Request refused without serving a response.",
							},
						}
					: {
							text: "not served",
							usage: { input_tokens: 0, output_tokens: 0 },
							streamHoldMs: 3_000,
						},
			);
			const aborted = send("abort a usage-less attempt").catch((error) =>
				String(error),
			);
			await h.waitFor(() => h.requests().length > count, {
				label: "usage-less abort reaches provider",
			});
			if (h instanceof TestHarness) {
				expect(
					(
						await fetch(`${h.serverUrl}/session/${session}/abort`, {
							method: "POST",
						})
					).ok,
				).toBe(true);
			} else if (h instanceof PiTestHarness) {
				// Exercise the real failure record. The pinned Pi RPC abort
				// waits indefinitely for idle in this held-stream drive; its
				// distinct "aborted" stop reason is covered by the message_end
				// unit fixture rather than claiming a real abort completed here.
			} else {
				const oc = (
					h as unknown as { opencode: { url: string; password: string } }
				).opencode;
				await OpenCode.make({
					baseUrl: oc.url,
					headers: {
						authorization: `Basic ${btoa(`opencode:${oc.password}`)}`,
					},
				}).session.interrupt({ sessionID: session });
			}
			await aborted;
			await h.waitForMockQuiescence();
			let assistantStates: unknown;
			if (h instanceof TestHarness) {
				const messages = (await (
					await fetch(`${h.serverUrl}/session/${session}/message`)
				).json()) as { info: Record<string, unknown> }[];
				assistantStates = messages
					.filter((message) => message.info.role === "assistant")
					.map((message) => message.info);
			} else if (h instanceof PiTestHarness) {
				assistantStates = (await h.getMessages())
					.filter((message) => message.role === "assistant")
					.map(({ stopReason, errorMessage, timestamp, usage }) => ({
						stopReason,
						errorMessage,
						timestamp,
						usage,
					}));
			} else {
				const env = (
					h as unknown as { opencode: { env: { OPENCODE_DB: string } } }
				).opencode.env;
				const db = openTestDb(join(h.dataDir, "opencode", env.OPENCODE_DB));
				try {
					assistantStates = db
						.prepare(
							"SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY id",
						)
						.all(session);
				} finally {
					db.close();
				}
			}
			const inventory = assertContained(h);
			console.log(
				"USAGE_LESS_CLOCK",
				JSON.stringify({
					host,
					measuredClock,
					expiredClock,
					beforeAbort,
					afterAbort: clock(),
					passLog,
					assistantStates,
				}),
			);
			const evidence = process.env.IDLE_TTL_EVIDENCE;
			if (evidence) {
				mkdirSync(evidence, { recursive: true });
				writeFileSync(
					join(evidence, `${host}-usage-less-clock.json`),
					JSON.stringify(
						{
							measuredClock,
							expiredClock,
							beforeAbort,
							afterAbort: clock(),
							passLog,
							assistantStates,
							inventory,
							requests: h.requests(),
						},
						null,
						2,
					),
				);
			}
			expect(clock()).toBe(beforeAbort);
		} finally {
			await h.dispose();
			if (oldLogPath === undefined) delete process.env.MAGIC_CONTEXT_LOG_PATH;
			else process.env.MAGIC_CONTEXT_LOG_PATH = oldLogPath;
		}
	}, 120_000);
	for (const expired of [false, true])
		it.skipIf(host !== "opencode")(
			`a ${expired ? "genuinely expired" : "normal warm"} turn across midnight ${expired ? "releases the date only on the rebuild" : "keeps the frozen date and prefix"}`,
			async () => {
				const root = createE2ETempDir("warm-midnight-");
				const datePath = join(root, "date.txt");
				const datePlugin = join(root, "date-plugin.js");
				writeFileSync(datePath, "Fri Oct 02 2026");
				writeFileSync(
					datePlugin,
					`import plugin from ${JSON.stringify(process.env.MC_E2E_PLUGIN_ENTRY ?? PLUGIN_ENTRY)}; export default async (ctx) => { const hooks = await (typeof plugin === "function" ? plugin : plugin.server)(ctx); const system = hooks["experimental.chat.system.transform"]; return { ...hooks, "experimental.chat.system.transform": async (input, output) => { const date = await Bun.file(${JSON.stringify(datePath)}).text(); for (let i = 0; i < output.system.length; i++) output.system[i] = output.system[i].replace(/Today's date: [^\\n]+/g, "Today's date: " + date); return system(input, output); } }; };`,
				);
				const h = await createScenarioHarness(host, {
					modelContextLimit: 100_000,
					prepareContextDatabase: process.env.IDLE_TTL_RELEASE !== "0.44.4",
					magicContextConfig: {
						cache_ttl: { default: "1h" },
						execute_threshold_percentage: 90,
						historian: { disable: true },
					},
					openCodeConfigExtra: { plugin: [`file://${datePlugin}`] },
					mockDefault: { text: "answer", usage: LOW_USAGE },
				});
				try {
					const session = await createFreshSession(h);
					const turn = async (text: string) => {
						const count = h.requests().length;
						await h.sendPrompt(session, text);
						await h.waitForMockQuiescence();
						return h
							.requests()
							.slice(count)
							.find(
								(request) =>
									Array.isArray(request.body.tools) &&
									request.body.tools.length > 0,
							)!;
					};
					await turn("initial before midnight");
					const before = await turn("warm before midnight");
					writeFileSync(datePath, "Sat Oct 03 2026");
					if (expired) expire(h, session, true);
					const after = await turn("after midnight");
					expect(JSON.stringify(after.body.system)).toContain(
						expired
							? "Today's date: Sat Oct 03 2026"
							: "Today's date: Fri Oct 02 2026",
					);
					if (expired) {
						const next = await turn("next warm after midnight");
						assertReplay(after, next);
					} else assertReplay(before, after);
					const inventory = assertContained(h);
					const evidence = process.env.IDLE_TTL_EVIDENCE;
					if (evidence) {
						mkdirSync(evidence, { recursive: true });
						writeFileSync(
							join(evidence, `${RUST_MODE ? "rust" : "ts"}-${expired ? "idle" : "warm"}-midnight.json`),
							JSON.stringify(
								{
									before,
									after,
									inventory,
									comparison: prefixComparison(before, after),
								},
								null,
								2,
							),
						);
					}
				} finally {
					await h.dispose();
				}
			},
			90_000,
		);
	for (const restart of [false, true]) {
		const suffix = `${restart ? "with" : "without"} a host restart`;
		it(
			`folds the expired head once ${suffix}`,
			() => probe(host, restart, false, false),
			120_000,
		);
		for (const queued of [false, true]) {
			it.skipIf(host !== "opencode" || process.env.IDLE_TTL_LONG !== "1")(
				`replays the entire 240k tool-loop prefix ${suffix} (${queued ? "queued drops" : "no drops"})`,
				() => probe(host, restart, true, queued),
				240_000,
			);
		}
		it.skipIf(host !== "opencode")(
			`an aborted idle attempt and late system change do not rewrite the next step ${suffix}`,
			() => probe(host, restart, true, false, true),
			240_000,
		);
	}
});
