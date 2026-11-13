import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	closeDatabase,
	openDatabase,
} from "../../../plugin/src/features/magic-context/storage";
import { createTagger } from "../../../plugin/src/features/magic-context/tagger";
import { resolveOpenCodeProtectedTailBoundary } from "../../../plugin/src/hooks/magic-context/protected-tail-boundary";
import {
	prepareRawSessionOrdinals,
	readRawSessionMessages,
} from "../../../plugin/src/hooks/magic-context/read-session-chunk";
import { findLastAssistantModelFromOpenCodeDb } from "../../../plugin/src/hooks/magic-context/read-session-db";
import {
	createTransform,
	resolveTransformHostSeams,
	sendEmergencyRefusalNotice,
} from "../../../plugin/src/hooks/magic-context/transform";
import { abortSessionFailClosed } from "../../../plugin/src/hooks/magic-context/transform-postprocess-phase";
import {
	__resetNotificationStateForTests,
	drainNotifications,
} from "../../../plugin/src/shared/rpc-notifications";
import {
	deliverSynthetic,
	isAdmittedSynthetic,
} from "../../../plugin/src/v2/hooks/channel2";
import { createHostSeams } from "../../../plugin/src/v2/hooks/context";
import { adaptPayload, HEAD_IDS } from "../../../plugin/src/v2/hooks/payload";
import {
	INTERRUPT_CONFIRMATION_TIMEOUT_MS,
	type InterruptTimers,
	interruptBeforeProvider,
	V2ContextRefusal,
} from "../../../plugin/src/v2/hooks/refusal";
import type {
	SessionContext,
	V2Context,
} from "../../../plugin/src/v2/hooks/types";
import { startUpdateChecks } from "../../../plugin/src/v2/hooks/update-check";

const sha = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const root = resolve(import.meta.dir, "../../../..");

test("I14 sdk_renames: v2 supplies every host seam, v1 defaults retain function identity", async () => {
	const defaults = resolveTransformHostSeams({});
	expect(defaults).toEqual({
		hostRawMessages: readRawSessionMessages,
		hostMessageReconciliationSource: readRawSessionMessages,
		hostPrepareRawOrdinals: prepareRawSessionOrdinals,
		hostProtectedTailBoundary: resolveOpenCodeProtectedTailBoundary,
		hostModelFallback: findLastAssistantModelFromOpenCodeDb,
		hostRefusalNotice: sendEmergencyRefusalNotice,
		hostRefuse: abortSessionFailClosed,
	});
	const read = Object.assign(() => [], {
		readPage: () => [],
		getCount: () => 0,
	});
	const supplied = createHostSeams({} as V2Context, read, read, new Map());
	const resolved = resolveTransformHostSeams(supplied);
	for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
		expect(typeof supplied[key]).toBe("function");
		expect(resolved[key]).toBe(supplied[key]);
	}
	expect(supplied.hostRawMessages).toBe(read);
	expect(supplied.hostRawMessages).not.toBe(defaults.hostRawMessages);
	expect(supplied.hostPrepareRawOrdinals).not.toBe(defaults.hostPrepareRawOrdinals);
	expect(await supplied.hostPrepareRawOrdinals("v2-session")).toBe(true);
	expect(supplied.hostRefusalNotice).not.toBe(defaults.hostRefusalNotice);
	expect(supplied.hostRefuse).not.toBe(defaults.hostRefuse);
	expect(supplied.hostProtectedTailBoundary).not.toBe(
		defaults.hostProtectedTailBoundary,
	);
	expect(supplied.hostModelFallback).not.toBe(defaults.hostModelFallback);
	for (const file of [
		"server.ts",
		"hooks/context.ts",
		"hooks/refusal.ts",
		"hooks/channel2.ts",
		"hooks/payload.ts",
	]) {
		const source = readFileSync(
			join(root, "packages/plugin/src/v2", file),
			"utf8",
		);
		expect(source).not.toMatch(/\.\s*session\s*\.\s*(abort|delete|promptAsync)\s*\(/);
		expect(source).not.toMatch(/import\s+(?!type\b).*from\s+["']@opencode\//);
		expect(source).not.toMatch(/live-session-state/);
	}
});

test("I9b v2 fail-closed notice is TUI-visible and synthetic-visible before interruption", async () => {
	__resetNotificationStateForTests();
	const records = new Map<string, unknown>();
	const order: string[] = [];
	const visible: Array<{ sessionID: string; text: string }> = [];
	const context = {
		storage: {
			get: async (key: string) => records.get(key),
			set: async (key: string, value: unknown) => {
				records.set(key, value);
			},
		},
		session: {
			synthetic: async (input: { sessionID: string; text: string }) => {
				order.push("notice");
				visible.push(input);
			},
			interrupt: async () => {
				order.push("interrupt");
				return { interrupted: true };
			},
		},
	} as unknown as V2Context;
	const read = Object.assign(() => [], {
		readPage: () => [],
		getCount: () => 0,
	});
	const seams = createHostSeams(context, read, readRawSessionMessages, new Map());
	const notice = "Context full — /ctx-flush or /clear to continue.";

	await seams.hostRefusalNotice(undefined, "ses-emergency", notice, {});
	await seams.hostRefuse(undefined, "ses-emergency");

	expect(order).toEqual(["notice", "interrupt"]);
	expect(visible).toHaveLength(1);
	expect(visible[0]).toMatchObject({ sessionID: "ses-emergency", text: notice });
	expect(drainNotifications(0, "ses-emergency", { sessionOnly: true })).toEqual([
		expect.objectContaining({
			type: "toast",
			payload: { message: notice, variant: "error" },
			sessionId: "ses-emergency",
		}),
	]);
	expect(
		[...records.keys()].some((key) => key.startsWith("synthetic/ses-emergency/msg_")),
	).toBe(true);
	__resetNotificationStateForTests();
});

test("I9b interrupt resolved confirmation returns normally", async () => {
	await expect(
		interruptBeforeProvider(
			{ interrupt: async () => ({ interrupted: true }) },
			"ses-fixture",
		),
	).resolves.toBeUndefined();
});
test("I9b interrupt rejected throws only the typed refusal", async () => {
	await expect(
		interruptBeforeProvider(
			{
				interrupt: async () => {
					throw new Error("rejected");
				},
			},
			"ses-fixture",
		),
	).rejects.toBeInstanceOf(V2ContextRefusal);
});
test("I9b interrupt idle no-op refuses rather than permitting a provider request", async () => {
	await expect(
		interruptBeforeProvider(
			{ interrupt: async () => ({ interrupted: false }) },
			"ses-fixture",
		),
	).rejects.toBeInstanceOf(V2ContextRefusal);
});
// A manual clock drives the deadline. Measuring real elapsed time around a
// 2000 ms timer failed whenever other work in the same test process held the
// event loop, so the test checks the scheduled delay and the ordering instead.
function manualTimers() {
	const scheduled: Array<{ ms: number; fire: () => void; cleared: boolean }> = [];
	const timers: InterruptTimers = {
		setTimeout: (fire, ms) => {
			const entry = { ms, fire, cleared: false };
			scheduled.push(entry);
			return entry;
		},
		clearTimeout: (handle) => {
			(handle as { cleared: boolean }).cleared = true;
		},
	};
	return { scheduled, timers };
}

test("I9b interrupt timed-out is bounded to 2000 ms and throws typed refusal", async () => {
	const clock = manualTimers();
	let settled = false;
	const refused = interruptBeforeProvider(
		{ interrupt: () => new Promise(() => {}) },
		"ses-fixture",
		clock.timers,
	).finally(() => {
		settled = true;
	});
	expect(clock.scheduled.map((entry) => entry.ms)).toEqual([2000]);
	expect(INTERRUPT_CONFIRMATION_TIMEOUT_MS).toBe(2000);
	// A host that never answers must not be refused before the deadline fires.
	for (let turn = 0; turn < 10; turn++) await Promise.resolve();
	expect(settled).toBe(false);
	clock.scheduled[0]!.fire();
	const error = await refused.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(V2ContextRefusal);
	expect(((error as Error).cause as Error).message).toBe("interrupt exceeded 2000 ms");
});

test("I9b interrupt confirmed before the deadline clears the deadline timer", async () => {
	const clock = manualTimers();
	await expect(
		interruptBeforeProvider(
			{ interrupt: async () => ({ interrupted: true }) },
			"ses-fixture",
			clock.timers,
		),
	).resolves.toBeUndefined();
	expect(clock.scheduled).toHaveLength(1);
	expect(clock.scheduled[0]!.cleared).toBe(true);
});

function fixture(sessionID: string): SessionContext {
	return {
		sessionID,
		model: { providerID: "openai", id: "mock-model" },
		agent: "build",
		tools: {},
		system: [],
		options: {},
		messages: [
			{
				id: "msg_probe_a",
				role: "user",
				content: [{ type: "text", text: "probe text" }],
			},
			{
				id: "msg_probe_b",
				role: "assistant",
				content: [
					{
						type: "tool-call",
						id: "call_probe",
						name: "read",
						input: { path: "probe.txt" },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						id: "call_probe",
						name: "read",
						result: { type: "text", value: "probe result" },
					},
				],
			},
			{
				id: "msg_probe_c",
				role: "user",
				content: [{ type: "text", text: "continue probe" }],
			},
		],
	};
}

test("I5 sentinel lookup reuses the existing head identities on a shared-draft replay", () => {
	const draft = fixture("ses-id");
	draft.messages.unshift(
		...HEAD_IDS.map((id) => ({
			id,
			role: "user",
			content: [{ type: "text", text: id }],
		})),
	);
	const before = draft.messages.slice(0, 2);
	const adapter = adaptPayload(draft);
	expect(adapter.messages).toHaveLength(3);
	adapter.messages.unshift(
		...HEAD_IDS.map((id) => ({
			info: { syntheticHead: true, role: "user" },
			parts: [{ type: "text", text: id, synthetic: true }],
		})),
	);
	adapter.commit();
	expect(draft.messages.slice(0, 2)).toEqual(before);
	expect(draft.messages[0]).toBe(before[0]);
	expect(draft.messages[1]).toBe(before[1]);
	expect(
		draft.messages.filter((message) =>
			HEAD_IDS.includes(message.id as (typeof HEAD_IDS)[number]),
		),
	).toHaveLength(2);
});

test("I6 v2 adapter served contributions equal the v1 fixture transform golden", async () => {
	const directory = mkdtempSync(join(tmpdir(), "mc-s2-golden-"));
	const db = openDatabase(join(directory, "context.db"));
	if (!db) throw new Error("fixture storage unavailable");
	try {
		const makeTransform = () =>
			createTransform({
				db,
				tagger: createTagger(),
				scheduler: { shouldExecute: () => "defer" },
				contextUsageMap: new Map(),
				historyRefreshSessions: new Set(),
				pendingMaterializationSessions: new Set(),
				lastHeuristicsTurnId: new Map(),
				clearReasoningAge: 50,
				historianRunnable: false,
				directory,
				injectDocs: false,
				memoryConfig: {
					enabled: false,
					injectionBudgetTokens: 0,
					autoPromote: false,
				},
			});
		const v1 = makeTransform();
		const v2 = makeTransform();
		const hashes: string[] = [];
		// Values are from the committed v1 wire fixture, not from the v2 mapper.
		const wire = JSON.parse(
			readFileSync(
				join(root, "packages/e2e-tests/src/opencode2-runner/payload-v1.json"),
				"utf8",
			),
		);
		for (let pass = 0; pass < 3; pass++) {
			const raw = [
				{
					info: { id: "msg_probe_a", role: "user", sessionID: "ses-golden-v1" },
					parts: [{ type: "text", text: wire.messages[0].content[0].text }],
				},
				{
					info: {
						id: "msg_probe_b",
						role: "assistant",
						sessionID: "ses-golden-v1",
					},
					parts: [
						{
							type: "tool",
							callID: "call_probe",
							tool: "read",
							state: {
								status: "completed",
								input: wire.messages[1].content[1].input,
								output: wire.messages[2].content[0].content,
							},
						},
					],
				},
				{
					info: { id: "msg_probe_c", role: "user", sessionID: "ses-golden-v1" },
					parts: [{ type: "text", text: wire.messages[2].content[1].text }],
				},
			];
			await v1({}, { messages: raw });
			const expected = raw.flatMap((message) =>
				message.parts.map((part) =>
					"text" in part ? part.text : part.state.output,
				),
			);
			const draft = fixture("ses-golden-v2");
			const adapter = adaptPayload(draft);
			await v2({}, adapter);
			adapter.commit();
			const actual = draft.messages.flatMap((message) =>
				message.content.flatMap((part) =>
					part.type === "text"
						? [part.text]
						: part.type === "tool-result"
							? [(part.result as { value: unknown }).value]
							: [],
				),
			);
			expect(actual).toEqual(expected);
			hashes.push(sha(actual));
		}
		expect(new Set(hashes).size).toBe(1);
		expect(hashes).toEqual(
			Array(3).fill(
				"32fbdb1bffdc5eee04e6108bd801262bbd5c7a323191811b54fd717739b89e0a",
			),
		);
	} finally {
		closeDatabase();
	}
});

test("I9b update event subscription terminates on teardown without a dangling iterator", async () => {
	let entered = false;
	let closed = false;
	let finish = () => {};
	const context = {
		event: {
			async *subscribe({ signal }: { signal: AbortSignal }) {
				entered = true;
				try {
					await new Promise<void>((resolve) => {
						finish = resolve;
						signal.addEventListener("abort", () => resolve(), { once: true });
					});
					if (!signal.aborted) yield {};
				} finally {
					closed = true;
				}
			},
		},
		storage: { get: async () => undefined, set: async () => {} },
	};
	const checks = startUpdateChecks(context, async () => null);
	try {
		expect(entered).toBe(true);
		const disposed = await Promise.race([
			checks.dispose().then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
		]);
		expect(disposed).toBe(true);
		expect(closed).toBe(true);
	} finally {
		finish();
		await checks.done;
	}
});

test("I5 tool composite identity pairs reused call ids by assistant owner", () => {
	const draft = fixture("ses-pair");
	draft.messages.splice(
		3,
		0,
		{
			id: "msg_second_owner",
			role: "assistant",
			content: [
				{
					type: "tool-call",
					id: "call_probe",
					name: "read",
					input: { path: "second.txt" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					id: "call_probe",
					name: "read",
					result: { type: "text", value: "second result" },
				},
			],
		},
	);
	const before = structuredClone(draft.messages);
	const adapter = adaptPayload(draft);
	const owners = adapter.messages.filter(
		(message) => message.info.role === "assistant",
	);
	expect(owners.map((message) => message.info.id)).toEqual([
		"msg_probe_b",
		"msg_second_owner",
	]);
	expect(
		owners.map(
			(message) =>
				(message.parts[0] as { state: { output: string } }).state.output,
		),
	).toEqual(["probe result", "second result"]);
	adapter.commit();
	expect(draft.messages).toEqual(before);
});

test("I15 admitted synthetic identity is recorded before steer and recognized only by recorded id", async () => {
	const records = new Map<string, unknown>();
	const sent: unknown[] = [];
	const context = {
		storage: {
			get: async (key: string) => records.get(key),
			set: async (key: string, value: unknown) => {
				records.set(key, value);
			},
		},
		session: {
			synthetic: async (input: {
				sessionID: string;
				id: string;
				text: string;
				delivery: "steer";
			}) => {
				expect(
					await isAdmittedSynthetic(
						context as never,
						input.sessionID,
						input.id,
					),
				).toBe(true);
				sent.push(input);
			},
		},
	};
	const id = await deliverSynthetic(context as never, "ses-record", "nudge");
	expect(sent).toEqual([
		{ sessionID: "ses-record", id, text: "nudge", delivery: "steer" },
	]);
	expect(await isAdmittedSynthetic(context, "ses-record", id)).toBe(true);
	expect(await isAdmittedSynthetic(context, "other-session", id)).toBe(false);
	expect(
		await isAdmittedSynthetic(context, "ses-record", "msg_same_shape"),
	).toBe(false);
	expect(await isAdmittedSynthetic(context, "ses-record", HEAD_IDS[1])).toBe(
		false,
	);
});
