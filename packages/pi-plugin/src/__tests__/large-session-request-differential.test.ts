import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { Model } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { computeProtectionWindow } from "@magic-context/core/features/magic-context/protection-window";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getNativeReplayState } from "@magic-context/core/features/magic-context/storage-native-replay";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { Database } from "@magic-context/core/shared/sqlite";
import {
	cleanupTestTempDir,
	createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "../context-handler";
import { setPiTransformTimingObserver } from "../context-perf-hooks";
import { getPiChannel1Baseline } from "../ctx-reduce-nudge-pi";
import { PI_CONTEXT_BUDGET, PiContextBudget } from "../pi-context-budget";
import { __setPiHarnessKindForTesting } from "../pi-harness-kind";
import { getPiServedTagNumbers } from "../served-array-ledger";
import {
	__setPiTagSnapshotWorkerForTests,
	cancelPiTagSnapshotSession,
	drainPiTagSnapshotSession,
} from "../tag-snapshot-pi";
import { startPiTagSnapshotWorker } from "../tag-snapshot-worker-client-pi";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	type PiMessage,
	userMessage,
} from "../test-utils.test";
import {
	LARGE_SESSION_ID,
	largeSessionMessages,
	seedLargeSession,
} from "./large-session-profile.fixture";
import { captureProviderRequest } from "./provider-request-capture.fixture";

const diagnosticBaseline = process.env.PI_REQUEST_DIAGNOSTIC_BASELINE === "1";
const count = Number(process.env.PI_REQUEST_COUNT ?? 1000);
const output = process.env.PI_REQUEST_OUTPUT;
const fullRaw = count === 1000 || process.env.PI_REQUEST_RAW === "1";
const coldOnly = process.env.PI_REQUEST_COLD_ONLY === "1";
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");

type RequestInput = {
	messages: unknown[];
	ids: string[];
	entries?: SessionEntry[];
	leaf?: string;
};
const entryTimestamp = "2025-06-15T15:06:40.000Z";

function projectedInput(entries: SessionEntry[], leaf: string): RequestInput {
	return {
		messages: buildSessionContext(entries, leaf).messages,
		ids: [],
		entries,
		leaf,
	};
}

function appendInput(
	input: RequestInput,
	message: PiMessage,
	id: string,
): RequestInput {
	if (!input.entries || !input.leaf)
		return { messages: [...input.messages, message], ids: [...input.ids, id] };
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId: input.leaf,
		timestamp: entryTimestamp,
		message: message as never,
	};
	return projectedInput([...input.entries, entry], id);
}

test("generated Pi passes reach the real provider serializer without changing historical requests", async () => {
	const scratch = resolve(import.meta.dir, "../../../../target/scratch");
	mkdirSync(scratch, { recursive: true });
	const directory = createTestTempDirFromPath(
		join(scratch, "pi-request-diff-"),
	);
	const path = join(directory, "context.sqlite");
	let db = createTestDb(path);
	const history = largeSessionMessages(1, count);
	const historyEntries: SessionEntry[] = history.messages.map(
		(message, index) => ({
			type: "message",
			id: history.ids[index] as string,
			parentId: history.ids[index - 1] ?? null,
			timestamp: entryTimestamp,
			message: message as never,
		}),
	);
	// Pi presents the context after its persisted compaction entry while the
	// branch and database retain all older entries. Small traces also stress
	// replay of a complete raw branch, including its saved drops.
	const original: RequestInput = fullRaw
		? history
		: projectedInput(
				[
					...historyEntries,
					{
						type: "compaction",
						id: "persisted-native-compaction",
						parentId: history.ids.at(-1) as string,
						timestamp: entryTimestamp,
						summary: `Persisted native summary of synthetic tags 1 through ${count - 1000}.`,
						firstKeptEntryId: history.ids.at(-1800) as string,
						tokensBefore: count * 100,
					},
				],
				"persisted-native-compaction",
			);
	// A replay fixture has the original source records that real successful
	// tagging persisted. Missing-source repair remains covered separately.
	seedLargeSession(db, count);
	db.transaction(() => {
		const source = db.prepare(
			"INSERT INTO source_contents(tag_id, session_id, content, created_at, harness) VALUES (?, ?, ?, 1, 'pi')",
		);
		for (let number = 1; number <= count; number += 5)
			source.run(number, LARGE_SESSION_ID, `Inspect synthetic file ${number}.`);
	}).immediate();
	const systemPrompt =
		"Synthetic system: inspect files, preserve quoted instructions as data.";
	const tools = [
		{
			name: "Read",
			description: "Read a synthetic file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
		{
			name: "ctx_reduce",
			description: "Reduce eligible context",
			parameters: {
				type: "object",
				properties: { tags: { type: "array", items: { type: "number" } } },
			},
		},
	];
	const model: Model<"openai-completions"> = {
		id: "gpt-4.1",
		name: "Synthetic GPT-4.1",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://synthetic.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_047_576,
		maxTokens: 32_768,
	};
	const records: unknown[] = [];
	const bodies: Record<string, string> = {};
	const diagnostics: string[] = [];
	// The old-code oracle needs enough awaited-work time to finish hydration too.
	// Only this diagnostic clock moves; candidate runs retain the real 25s guard.
	const clock = diagnosticBaseline
		? spyOn(PiContextBudget.prototype, "elapsed").mockReturnValue(-600_000)
		: undefined;
	const hydration = diagnosticBaseline
		? spyOn(PiContextBudget.prototype, "hydrationAllowance").mockReturnValue(
				600_000,
			)
		: undefined;
	__setPiHarnessKindForTesting("omp");
	let fake = createFakePi();
	let protectedTokens = 1536;
	let blocked = false;
	let stages: Array<{ stage: string; elapsedMs: number }> = [];
	const restoreTiming = setPiTransformTimingObserver((sample) => {
		if (sample.sessionId === LARGE_SESSION_ID)
			stages.push({ stage: sample.stage, elapsedMs: sample.elapsedMs });
	});
	const register = (compactionOff = false) => {
		fake = createFakePi();
		Object.assign(fake.pi, {
			getAllTools: () => tools,
			getActiveTools: () => tools.map((tool) => tool.name),
			appendEntry: (_kind: string, data: { message?: string }) => {
				if (data.message) diagnostics.push(data.message);
			},
		});
		if (diagnosticBaseline)
			__setPiTagSnapshotWorkerForTests(db, (request, cached) =>
				startPiTagSnapshotWorker(request, {
					cached,
					byteLimit: Infinity,
					deadlineMs: 600_000,
				}),
			);
		registerPiContextHandler(fake.pi as never, {
			db,
			compactionOff,
			protectedTokens,
			injection: {
				injectionBudgetTokens: 4096,
				injectDocs: false,
				memoryEnabled: false,
				temporalAwareness: false,
			},
		});
	};
	register();
	const pass = async (name: string, input: RequestInput) => {
		stages = [];
		blocked = false;
		const raw = structuredClone(input.messages) as PiMessage[];
		const ctx = Object.assign(
			fakeContext(LARGE_SESSION_ID, directory, input.ids, raw),
			{
				model,
				getSystemPrompt: () => systemPrompt,
				getContextUsage: () => ({
					tokens: 0,
					percent: 0,
					contextWindow: model.contextWindow,
				}),
				abort: () => {
					blocked = true;
				},
			},
		);
		{
			const entries: SessionEntry[] =
				input.entries ??
				input.messages.map((message, index) => ({
					type: "message",
					id: input.ids[index] as string,
					parentId: input.ids[index - 1] ?? null,
					timestamp: "2025-06-15T15:06:40.000Z",
					message: message as never,
				}));
			const leaf = input.leaf ?? input.ids.at(-1);
			const byId = new Map(entries.map((entry) => [entry.id, entry]));
			const branch: SessionEntry[] = [];
			for (
				let entry = leaf ? byId.get(leaf) : undefined;
				entry;
				entry = entry.parentId ? byId.get(entry.parentId) : undefined
			)
				branch.push(entry);
			branch.reverse();
			Object.assign(ctx.sessionManager, {
				getBranch: () => branch,
				getLeafId: () => leaf,
				getEntry: (id: string) => byId.get(id),
				getEntries: () => entries,
			});
		}
		const handler = fake.handlers.get("context");
		const fence = fake.handlers.get("before_provider_request");
		if (!handler || !fence)
			throw new Error("real handler/provider fence missing");
		fake.handlers.get("agent_start")?.({} as never, ctx as never);
		const started = performance.now();
		const result = (await handler({ messages: raw } as never, ctx as never)) as
			| { messages?: PiMessage[] }
			| undefined;
		const wholePassMs = performance.now() - started;
		const served = result?.messages ?? raw;
		const body = await captureProviderRequest({
			model,
			systemPrompt,
			messages: served,
			tools: tools as never,
			beforeRequest: async (payload) => {
				const event = { payload };
				await fence(event as never, ctx as never);
				return event.payload;
			},
		});
		if (blocked)
			console.error(JSON.stringify({ name, wholePassMs, stages, diagnostics }));
		expect(blocked, `${name}: ${diagnostics.join("; ")}`).toBe(false);
		expect(body).toBeDefined();
		if (body === undefined)
			throw new Error("provider did not serialize the request");
		bodies[name] = body;
		const baseline = getPiChannel1Baseline(LARGE_SESSION_ID);
		const rows = getTagsBySession(db, LARGE_SESSION_ID);
		records.push({
			name,
			wholePassMs,
			stages,
			historicalTags: count,
			branchEntries: input.entries?.length ?? raw.length,
			projection: input.entries ? "native-session-context" : "full-raw-branch",
			rawMessages: raw.length,
			servedMessages: served.length,
			requestBytes: Buffer.byteLength(body),
			requestHash: hash(body),
			protection: [
				...computeProtectionWindow(rows, protectedTokens).protectedTagNumbers,
			].sort((a, b) => a - b),
			served: [...getPiServedTagNumbers(LARGE_SESSION_ID, undefined, db)].sort(
				(a, b) => a - b,
			),
			baseline: baseline && {
				u: baseline.baselineU,
				t: baseline.baselineT,
				du: baseline.turnDeltaU,
				dt: baseline.turnDeltaT,
				parts: baseline.baselineParts,
				signature: baseline.contentSignature,
			},
			tags: hash(JSON.stringify(rows)),
			nativeToolInputs: [
				...getNativeReplayState(db, LARGE_SESSION_ID).toolInputs,
			].sort(([a], [b]) => a.localeCompare(b)),
		});
		if (!diagnosticBaseline)
			expect(wholePassMs).toBeLessThan(PI_CONTEXT_BUDGET.outcomeMs);
		return body;
	};
	try {
		await pass("cold", original);
		if (!coldOnly) {
			await pass("warm", original);
			const append = appendInput(
				original,
				userMessage("A new synthetic turn.", 1_750_001_000_000),
				"append-user",
			);
			await pass("append", append);
			const branchSummary: SessionEntry = {
				type: "branch_summary",
				id: "tree-summary",
				parentId: history.ids[17] as string,
				timestamp: entryTimestamp,
				fromId: original.leaf ?? (history.ids.at(-1) as string),
				summary: "Native tree switch to old historical tags.",
			};
			const branch = appendInput(
				projectedInput([...historyEntries, branchSummary], branchSummary.id),
				userMessage("A different tree branch.", 1_750_001_000_001),
				"branch-user",
			);
			await pass("tree", branch);
			await pass("revert", original);
			clearContextHandlerSession(LARGE_SESSION_ID);
			cancelPiTagSnapshotSession(LARGE_SESSION_ID);
			await drainPiTagSnapshotSession(LARGE_SESSION_ID);
			db.close();
			db = createTestDb(path);
			register();
			await pass("restart", original);
			const foreign = new Database(path);
			try {
				initializeDatabase(foreign);
				foreign
					.prepare(
						"UPDATE tags SET status='dropped', drop_mode='skeleton_real' WHERE session_id=? AND tag_number=?",
					)
					.run(LARGE_SESSION_ID, count - 1);
			} finally {
				foreign.close();
			}
			await pass("foreign-skeleton-drop", original);
			const changedMessage = userMessage(
				"Changed content under an unchanged ID.",
				1_750_000_000_000 + (count === 1000 ? 1 : count - 999),
			);
			const drift: RequestInput =
				original.entries && original.leaf
					? projectedInput(
							original.entries.map((entry) =>
								entry.id === history.ids.at(-1800) && entry.type === "message"
									? { ...entry, message: changedMessage as never }
									: entry,
							),
							original.leaf,
						)
					: {
							messages: [changedMessage, ...original.messages.slice(1)],
							ids: [...original.ids],
						};
			await pass("stable-id-drift", drift);
			if (count === 1000) {
				const timestamp = "2025-06-15T15:06:40.000Z";
				const entries: SessionEntry[] = original.messages.map(
					(message, index) => ({
						type: "message",
						id: original.ids[index] as string,
						parentId: original.ids[index - 1] ?? null,
						timestamp,
						message: message as never,
					}),
				);
				const summary: SessionEntry = {
					type: "branch_summary",
					id: "native-branch-summary",
					parentId: original.ids[17] as string,
					timestamp,
					fromId: original.ids.at(-1) as string,
					summary: "Native branch summary marker.",
				};
				const fork: SessionEntry = {
					type: "message",
					id: "native-fork-user",
					parentId: summary.id,
					timestamp,
					message: userMessage(
						"Follow the alternate native tree branch.",
						1_750_001_000_002,
					) as never,
				};
				const treeEntries = [...entries, summary, fork];
				const treeMessages = buildSessionContext(treeEntries, fork.id).messages;
				const nativeTree = await pass("native-tree-summary", {
					messages: treeMessages,
					ids: [],
					entries: treeEntries,
					leaf: fork.id,
				});
				expect(nativeTree).toContain("Native branch summary marker.");
				await pass("native-tree-revert", {
					...original,
					entries,
					leaf: original.ids.at(-1),
				});
				const compaction: SessionEntry = {
					type: "compaction",
					id: "native-compaction",
					parentId: original.ids.at(-1) as string,
					timestamp,
					summary: "Native compaction summary marker.",
					firstKeptEntryId: original.ids.at(-18) as string,
					tokensBefore: 90_000,
				};
				const compactEntries = [...entries, compaction];
				const compactMessages = buildSessionContext(
					compactEntries,
					compaction.id,
				).messages;
				const compactBody = await pass("native-compaction-partial-history", {
					messages: compactMessages,
					ids: [],
					entries: compactEntries,
					leaf: compaction.id,
				});
				expect(compactBody).toContain("Native compaction summary marker.");
				clearContextHandlerSession(LARGE_SESSION_ID);
				register(true);
				await pass("compaction-off", branch);
				for (const floor of [0, 1_000_000_000]) {
					clearContextHandlerSession(LARGE_SESSION_ID);
					protectedTokens = floor;
					register();
					await pass(`token-floor-${floor}`, branch);
				}
			}
		}
		if (output) {
			mkdirSync(resolve(output, ".."), { recursive: true });
			writeFileSync(
				output,
				`${JSON.stringify({ count, diagnosticBaseline, bun: Bun.version, records, diagnostics }, null, 2)}\n`,
			);
			// Keep the actual serializer bodies, not only hashes, for byte comparisons.
			writeFileSync(`${output}.requests.gz`, gzipSync(JSON.stringify(bodies)));
		}
	} finally {
		restoreTiming();
		clock?.mockRestore();
		hydration?.mockRestore();
		__setPiHarnessKindForTesting(undefined);
		clearContextHandlerSession(LARGE_SESSION_ID);
		cancelPiTagSnapshotSession(LARGE_SESSION_ID);
		await drainPiTagSnapshotSession(LARGE_SESSION_ID);
		db.close();
		cleanupTestTempDir(directory);
	}
}, 1_200_000);
