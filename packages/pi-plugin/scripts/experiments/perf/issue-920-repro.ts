#!/usr/bin/env bun
/**
 * Reproduce a large Pi session whose tool calls were tagged twice: once under a
 * temporary `pi-msg-*` assistant owner and once under the real entry id.
 *
 *   bun issue-920-repro.ts --phase build --dir <scratch> --messages 20000 --duplicates 5835
 *   bun issue-920-repro.ts --phase measure --dir <scratch> --passes 4 --out <report.json>
 *
 * `build` warms a synthetic session through the real registered context
 * handler, then rewrites the store into the duplicated shape. `measure` runs
 * in a fresh process (cold module caches, as after a host restart) on a copy
 * of that directory and records each pass's stage timings and outcome.
 * Every path lives under the scratch directory; no host store is opened.
 */
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";

const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : fallback;
};
const phase = option("phase", "build");
const root = resolve(option("dir") ?? "");
if (!option("dir")) throw new Error("--dir is required");
const messageCount = Number(option("messages", "20000"));
const duplicateCount = Number(option("duplicates", "5835"));
const nullFingerprints = Number(option("null-fingerprints", "625"));
const passCount = Number(option("passes", "4"));
const resultRepeat = Number(option("result-repeat", "40"));
const sessionId = "mc-pi-issue-920";

const dataDir =
	phase === "build" ? join(root, "seed") : join(root, `run-${Date.now()}`);
if (phase === "build") {
	rmSync(root, { recursive: true, force: true });
	mkdirSync(dataDir, { recursive: true });
} else {
	cpSync(join(root, "seed"), dataDir, { recursive: true });
}
process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dataDir;
process.env.XDG_DATA_HOME = dataDir;
process.env.XDG_CONFIG_HOME = join(dataDir, "config");
process.env.XDG_STATE_HOME = join(dataDir, "state");
process.env.XDG_RUNTIME_DIR = join(dataDir, "runtime");
process.env.MAGIC_CONTEXT_STORAGE_DIR = dataDir;
process.env.MAGIC_CONTEXT_LOG_PATH = join(dataDir, "magic-context.log");
process.env.PI_CODING_AGENT_DIR = join(dataDir, "pi");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
delete process.env.NODE_ENV;
const { flushLogger } = await import("@magic-context/core/shared/logger");
process.env.NODE_ENV = "test";
const { Database } = await import("@magic-context/core/shared/sqlite");
const { initializeDatabase } = await import(
	"@magic-context/core/features/magic-context/storage-db"
);
const { runMigrations } = await import(
	"@magic-context/core/features/magic-context/migrations"
);
const { setHarness } = await import("@magic-context/core/shared/harness");
const { registerPiContextHandler, clearContextHandlerSession } = await import(
	"../../../src/context-handler"
);
const { setPiTransformTimingObserver } = await import(
	"../../../src/context-perf-hooks"
);
setHarness("pi");

/** Mostly tool arcs: a user turn every five assistant steps, 1-2 calls per step. */
function generate(): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	let timestamp = 1_760_000_000_000;
	let sequence = 0;
	const append = (message: Record<string, unknown>) => {
		const id = `e${String(sequence).padStart(6, "0")}`;
		entries.push({
			type: "message",
			id,
			parentId,
			timestamp: new Date(timestamp).toISOString(),
			message: { ...message, timestamp },
		} as unknown as SessionEntry);
		parentId = id;
		timestamp += 1_000;
		sequence++;
	};
	let step = 0;
	while (sequence < messageCount) {
		if (step % 5 === 0)
			append({ role: "user", content: `Continue with step ${step}.` });
		const calls = step % 5 === 4 ? 2 : 1;
		const ids = Array.from({ length: calls }, (_, n) => `call-${step}-${n}`);
		append({
			role: "assistant",
			content: [
				{ type: "text", text: `Step ${step}.` },
				...ids.map((id) => ({
					type: "toolCall",
					id,
					name: "read",
					arguments: { path: `/tmp/p/f-${step % 97}.ts`, offset: step },
				})),
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		});
		for (const id of ids)
			append({
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [
					{ type: "text", text: `out ${id} ${"line ".repeat(resultRepeat)}` },
				],
				isError: false,
			});
		step++;
	}
	return entries.slice(0, messageCount);
}

function contextFor(entries: SessionEntry[]) {
	const leafId = entries.at(-1)?.id ?? null;
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	return {
		messages: buildSessionContext(entries, leafId, byId).messages as unknown[],
		ctx: {
			cwd: dataDir,
			hasUI: false,
			getSystemPrompt: () => "You are a synthetic coding agent.",
			signal: new AbortController().signal,
			ui: { notify: () => undefined },
			model: {
				provider: "anthropic",
				id: "claude-sonnet-4-5",
				contextWindow: 10_000_000,
			},
			sessionManager: {
				getSessionId: () => sessionId,
				getLeafId: () => leafId,
				getBranch: () => entries,
				getEntry: (id: string) => byId.get(id),
			},
			getContextUsage: () => ({
				tokens: 25_000,
				percent: 0.25,
				contextWindow: 10_000_000,
			}),
		} as unknown as ExtensionContext,
	};
}

const db = new Database(join(dataDir, "context.db"));
initializeDatabase(db);
runMigrations(db);
const handlers = new Map<string, (...a: unknown[]) => unknown>();
registerPiContextHandler(
	{
		getAllTools: () => [],
		on: (event: string, h: (...a: unknown[]) => unknown) =>
			handlers.set(event, h),
	} as never,
	{
		db: db as never,
		protectedTags: 20,
		scheduler: { executeThresholdPercentage: 95 },
		heuristics: { caveman: { enabled: false, minChars: 2_000 } },
		injection: {
			memoryEnabled: false,
			injectDocs: false,
			injectionBudgetTokens: 4_000,
			temporalAwareness: false,
		},
	} as never,
);
const handler = handlers.get("context");
if (!handler) throw new Error("no context handler");
let samples: { stage: string; elapsedMs: number }[] = [];
setPiTransformTimingObserver((sample: { stage: string; elapsedMs: number }) =>
	samples.push(sample),
);

const logPath = process.env.MAGIC_CONTEXT_LOG_PATH as string;
const logLength = () =>
	existsSync(logPath) ? readFileSync(logPath, "utf8").length : 0;

async function runPass(entries: SessionEntry[]) {
	const { messages, ctx } = contextFor(entries);
	samples = [];
	const logStart = logLength();
	const started = performance.now();
	let error: string | undefined;
	let result: { messages?: unknown[] } | undefined;
	try {
		result = (await handler?.(
			{ messages: structuredClone(messages) },
			ctx,
		)) as typeof result;
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	}
	const handlerMs = performance.now() - started;
	flushLogger();
	await new Promise((r) => setTimeout(r, 200));
	flushLogger();
	const log = existsSync(logPath)
		? readFileSync(logPath, "utf8").slice(logStart)
		: "";
	const serialized = JSON.stringify(result?.messages ?? []);
	const count = (pattern: RegExp) =>
		log.split("\n").filter((line) => pattern.test(line)).length;
	const stages: Record<string, number> = {};
	for (const sample of samples)
		stages[sample.stage] = Math.round(
			(stages[sample.stage] ?? 0) + sample.elapsedMs,
		);
	return {
		handlerMs: Math.round(handlerMs),
		error,
		refused: serialized.includes("could not safely prepare this turn"),
		wireHash: createHash("sha256").update(serialized).digest("hex"),
		outputMessages: result?.messages?.length ?? 0,
		stages,
		log: {
			decisionWriteFailed: count(
				/tag identity decision .* could not be written/,
			),
			foldFailed: count(/tag identity fold failed/),
			recurred: count(/tag identity recurred after its one repair/),
			repairWithoutEvidence: count(
				/tag identity repair without last-served evidence/,
			),
			unresolved: count(/tag identity unresolved/),
			slowWriter: count(/sqlite writer site=/),
			deadline: count(/stage=.*elapsed=/),
			paused: count(/tag identity adoption reached the pass budget/),
			unguarded: count(/tag identity repairs without a stored guard/),
		},
		db: shape(),
	};
}

function shape() {
	const one = (sql: string) =>
		(db.prepare(sql).get(sessionId) as { n: number }).n;
	const ledger = db
		.prepare(
			"SELECT merged_reasoning_stripped_ids AS v FROM session_meta WHERE session_id = ?",
		)
		.get(sessionId) as { v: string | null } | null;
	const guards = db
		.prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
		.get(`pi_identity_fold_guards:${sessionId}`) as { value: string } | null;
	return {
		toolTags: one(
			"SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND type = 'tool'",
		),
		fallbackOwnerTools: one(
			"SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND type = 'tool' AND tool_owner_message_id LIKE 'pi-msg-%'",
		),
		distinctOwners: one(
			"SELECT COUNT(DISTINCT tool_owner_message_id) AS n FROM tags WHERE session_id = ? AND type = 'tool'",
		),
		twiceTaggedCalls: one(
			"SELECT COUNT(*) AS n FROM (SELECT message_id FROM tags WHERE session_id = ? AND type = 'tool' GROUP BY message_id HAVING COUNT(*) > 1)",
		),
		nullFingerprintMessages: one(
			"SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND type = 'message' AND entry_fingerprint IS NULL",
		),
		ledgerEntries: ledger?.v ? (JSON.parse(ledger.v) as unknown[]).length : 0,
		foldGuardBytes: guards?.value.length ?? 0,
		foldGuards: guards ? (JSON.parse(guards.value) as unknown[]).length : 0,
	};
}

const entries = generate();
if (phase === "build") {
	const warm: unknown[] = [];
	for (let point = 3_000; point < entries.length + 3_000; point += 3_000) {
		const report = await runPass(
			entries.slice(0, Math.min(point, entries.length)),
		);
		warm.push({
			point: Math.min(point, entries.length),
			handlerMs: report.handlerMs,
			refused: report.refused,
			wireHash: report.wireHash,
		});
		console.error(
			`warm ${Math.min(point, entries.length)} ${report.handlerMs}ms refused=${report.refused}`,
		);
	}
	// A second full pass records the final numbers as served.
	await runPass(entries);
	clearContextHandlerSession(sessionId);
	// Rewrite the oldest `duplicateCount` tool tags into the duplicated shape:
	// the served row moves under a temporary owner id built from the owning
	// assistant's timestamp, and the real owner gets a second, newer number.
	const owners = new Map<
		string,
		{ id: string; timestamp: number; index: number }
	>();
	entries.forEach((entry, index) => {
		const message = (
			entry as unknown as {
				message: { role: string; timestamp: number; content: unknown };
			}
		).message;
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;
		for (const part of message.content as { type: string; id?: string }[])
			if (part.type === "toolCall" && part.id)
				owners.set(part.id, {
					id: entry.id,
					timestamp: message.timestamp,
					index,
				});
	});
	const rows = db
		.prepare(
			"SELECT * FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number ASC LIMIT ?",
		)
		.all(sessionId, duplicateCount) as Record<string, unknown>[];
	let next =
		(
			db
				.prepare("SELECT MAX(tag_number) AS n FROM tags WHERE session_id = ?")
				.get(sessionId) as { n: number }
		).n + 1;
	const columns = Object.keys(rows[0] ?? {}).filter(
		(column) => column !== "id",
	);
	const insert = db.prepare(
		`INSERT INTO tags (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
	);
	db.exec("BEGIN");
	for (const row of rows) {
		const owner = owners.get(String(row.message_id));
		if (!owner) continue;
		db.prepare(
			"UPDATE tags SET tool_owner_message_id = ? WHERE session_id = ? AND tag_number = ?",
		).run(
			`pi-msg-${owner.index}-${owner.timestamp}-assistant`,
			sessionId,
			row.tag_number as number,
		);
		insert.run(
			...(columns.map((column) =>
				column === "tag_number" ? next : row[column],
			) as never[]),
		);
		next++;
	}
	db.prepare(
		`UPDATE tags SET entry_fingerprint = NULL WHERE session_id = ? AND tag_number IN (
		   SELECT tag_number FROM tags WHERE session_id = ? AND type = 'message' ORDER BY tag_number LIMIT ?)`,
	).run(sessionId, sessionId, nullFingerprints);
	db.exec("COMMIT");
	console.log(JSON.stringify({ phase, warm, shape: shape() }, null, 2));
} else {
	const passes: unknown[] = [];
	for (let pass = 0; pass < passCount; pass++) {
		const report = await runPass(entries);
		passes.push({ pass: pass + 1, ...report });
		console.error(
			`pass ${pass + 1}: ${report.handlerMs}ms refused=${report.refused} fallback=${report.stages.fallbackIdentityAndAdoption}`,
		);
	}
	const report = {
		phase,
		messages: messageCount,
		duplicates: duplicateCount,
		passes,
	};
	const out = option("out");
	if (out) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report, null, 2));
}
db.close();
process.exit(0);
