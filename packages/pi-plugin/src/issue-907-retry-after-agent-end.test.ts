import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
	clearPiContextReceipt,
	piBlockedDispatches,
	registerPiGuardedContext,
} from "./__tests__/dispatch-probe";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import { assistantMessage, fakeContext, userMessage } from "./test-utils.test";

// Event orders measured on real Oh My Pi 18.18.6 and 18.18.9 hosts with the
// built plugin and a mock provider that answers with HTTP 429. Oh My Pi's
// automatic retry removes the failed assistant message from the active
// context, starts a new run (agent_start), runs a fresh context pass and sends
// the request again. The failed run's extension agent_end carries
// `willContinue: true`.
const SESSION = "issue-907";
const prompt = userMessage("prompt", 10);
const failed = assistantMessage("", 20, {
	stopReason: "error",
	errorMessage: "429 Rate limit exceeded",
});
const answered = assistantMessage("answer", 30);

function harness() {
	__setPiHarnessKindForTesting("omp");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const refusals: string[] = [];
	let managedMessages: unknown[] = [];
	const branch = [
		{ type: "message" as const, id: "native-0", message: prompt },
	];
	const ctx = {
		...fakeContext(SESSION),
		isIdle: () => false,
		sessionManager: {
			getSessionId: () => SESSION,
			getBranch: () => branch,
		},
		abort: () => {},
	};
	registerPiGuardedContext(
		{
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
				handlers.set(name, handler),
			appendEntry: (_type: string, data: { message: string }) =>
				refusals.push(data.message),
		} as never,
		async (event) => {
			managedMessages = structuredClone(event.messages);
			return { messages: event.messages };
		},
	);
	const emit = (name: string, event: unknown = {}) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`missing ${name}`);
		return handler(event, ctx);
	};
	return {
		refusals,
		emit,
		get blocked() {
			return piBlockedDispatches(ctx);
		},
		context: () => emit("context", { messages: [structuredClone(prompt)] }),
		// Re-sending the same prepared payload, as the host's provider layer does
		// when it retries a failed stream without a new context pass.
		dispatch: () =>
			emit("before_provider_request", {
				payload: { messages: structuredClone(managedMessages) },
			}),
		failedRunEnd: () =>
			emit("agent_end", {
				messages: [structuredClone(prompt), structuredClone(failed)],
				willContinue: true,
			}),
	};
}

afterEach(() => {
	clearPiContextReceipt(SESSION);
	__setPiHarnessKindForTesting(undefined);
});

test("issue 907: in the measured order the automatic retry gets its own context pass and is admitted", async () => {
	const h = harness();
	h.emit("agent_start");
	await h.context();
	h.dispatch();
	// Provider error, backoff; then the failed run's end, then the retry run.
	h.failedRunEnd();
	h.emit("agent_start");
	await h.context();
	h.dispatch();
	expect(h.refusals).toEqual([]);
	expect(h.blocked).toBe(0);
});

test("issue 907: a willContinue end that arrives before the retry pass is dispatched keeps that pass", async () => {
	const h = harness();
	h.emit("agent_start");
	await h.context();
	h.dispatch();
	await h.context();
	h.failedRunEnd();
	h.dispatch();
	expect(h.refusals).toEqual([]);
});

test("issue 907: a final end still refuses a later request without a fresh pass", async () => {
	const h = harness();
	h.emit("agent_start");
	await h.context();
	h.dispatch();
	h.emit("agent_end", {
		messages: [structuredClone(prompt), structuredClone(answered)],
	});
	h.dispatch();
	expect(h.blocked).toBe(1);
	expect(h.refusals[0]).toContain("origin=agent_end");
});

// Measured on Oh My Pi 18.18.6 and 18.18.9 when a handler earlier in the same
// extension holds the failed run's agent_end: the host orders agent_start and
// agent_end per extension but delivers context and before_provider_request at
// once, so the retry's pass is prepared and sent before the late end arrives.
// The provider layer's own resend of that request is then refused.
test("issue 907: a late willContinue end after the retry was sent leaves its provider resend without a receipt (current behaviour)", async () => {
	const h = harness();
	h.emit("agent_start");
	await h.context();
	h.dispatch();
	await h.context();
	h.dispatch();
	expect(h.refusals).toEqual([]);
	h.failedRunEnd();
	h.emit("agent_start");
	h.dispatch();
	expect(h.blocked).toBe(1);
	expect(h.refusals[0]).toContain("no context pass ran for this operation");
});

// The sequence in the issue: the retry's pass was prepared and sent, the
// failed run's end (willContinue) is delivered afterwards, and the provider
// layer resends the same prepared request with no new start or context pass.
// The end belongs to the earlier failed attempt, so the resend should pass.
test.failing("issue 907: a provider resend after the failed run's late willContinue end is admitted", async () => {
	const h = harness();
	h.emit("agent_start");
	await h.context();
	h.dispatch();
	await h.context();
	h.dispatch();
	h.failedRunEnd();
	h.dispatch();
	expect(h.refusals).toEqual([]);
	expect(h.blocked).toBe(0);
});

// Host facts the analysis relies on, read from the Oh My Pi package pinned in
// this repository: the extension agent_end carries willContinue, generic
// events wait for the extension's earlier deliveries, and the context and
// provider-request hooks do not.
test("issue 907: Oh My Pi 18.18.6 delivers willContinue and orders only generic events per extension", () => {
	const require = createRequire(import.meta.url);
	const root = require
		.resolve("omp-coding-agent-18186/package.json")
		.slice(0, -"package.json".length);
	const session = readFileSync(
		join(root, "src/session/agent-session.ts"),
		"utf8",
	);
	expect(session).toContain("willContinue: options?.willContinue,");
	const runner = readFileSync(
		join(root, "src/extensibility/extensions/runner.ts"),
		"utf8",
	);
	const body = (name: string) => {
		const start = runner.indexOf(`\tasync ${name}(`);
		expect(start).toBeGreaterThan(-1);
		const end = runner.indexOf("\n\t}\n", start);
		return runner.slice(start, end);
	};
	expect(body("#emitTo<TEvent extends RunnerEmitEvent>")).toContain(
		"#reserveDeliveryTurns",
	);
	expect(body("emitContext")).not.toContain("DeliveryTurn");
	expect(body("emitBeforeProviderRequest")).not.toContain("DeliveryTurn");
});
