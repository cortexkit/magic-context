import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import magicContextPiExtension, { __test } from "./index";
import { MAGIC_CONTEXT_PI_SUBAGENT_ENV } from "./subagent-runner";

const originalEnv = {
	MAGIC_CONTEXT_PI_SUBAGENT: process.env.MAGIC_CONTEXT_PI_SUBAGENT,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

function restoreEnv() {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function isolateXdgEnv() {
	const root = mkdtempSync(join(tmpdir(), "magic-context-pi-latch-test-"));
	process.env.XDG_CONFIG_HOME = join(root, "config");
	// Use the preload's migration-safe test database; isolate only configuration.
	delete process.env.XDG_DATA_HOME;
}

/**
 * Counting ExtensionAPI seam. Every ordinary registration method pushes the name onto
 * a list, so a test can assert that a child init registered NOTHING (no
 * duplicate tools, events, commands, timers, or watchers). The custom event
 * bus drives the in-process child lifecycle signal.
 */
function createCountingPi() {
	const events: string[] = [];
	const tools: string[] = [];
	const flags: string[] = [];
	const commands: string[] = [];
	const entryRenderers: string[] = [];
	const eventBusHandlers = new Map<string, Set<(data: unknown) => void>>();
	const piEventHandlers = new Map<
		string,
		Set<(event: unknown, ctx: unknown) => unknown>
	>();
	const pi = {
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				const handlers = eventBusHandlers.get(channel) ?? new Set();
				handlers.add(handler);
				eventBusHandlers.set(channel, handlers);
				return () => handlers.delete(handler);
			},
		},
		on: mock(
			(event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				events.push(event);
				const handlers = piEventHandlers.get(event) ?? new Set();
				handlers.add(handler);
				piEventHandlers.set(event, handlers);
			},
		),
		registerTool: mock((tool: { name?: string }) => {
			tools.push(tool.name ?? "<unnamed>");
		}),
		registerFlag: mock((name: string) => {
			flags.push(name);
		}),
		registerCommand: mock((name: string) => {
			commands.push(name);
		}),
		registerEntryRenderer: mock((customType: string) => {
			entryRenderers.push(customType);
		}),
		appendEntry: mock(() => undefined),
		sendMessage: mock(() => undefined),
		sendUserMessage: mock(() => undefined),
	} as unknown as ExtensionAPI;
	return {
		pi,
		events,
		tools,
		flags,
		commands,
		entryRenderers,
		eventBusHandlerCount(channel: string) {
			return eventBusHandlers.get(channel)?.size ?? 0;
		},
		emitEvent(channel: string, data: unknown = {}) {
			for (const handler of eventBusHandlers.get(channel) ?? []) handler(data);
		},
		async emitPiEvent(event: string, data: unknown = {}, ctx: unknown = {}) {
			for (const handler of piEventHandlers.get(event) ?? []) {
				await handler(data, ctx);
			}
		},
	};
}

afterEach(() => {
	restoreEnv();
	// The marker context lives on globalThis (process-global by design), so clear it
	// between tests or one test's child state could suppress the next.
	__test.clearPiInProcessSubagentInitContext();
	__test.clearPiStartupMaintenanceClaim();
});

describe("Pi in-process child guard (#247)", () => {
	it("claims process-wide startup maintenance from the full runtime", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const first = createCountingPi();
		await magicContextPiExtension(first.pi);
		expect(__test.claimPiStartupMaintenance()).toBe(false);

		const second = createCountingPi();
		await magicContextPiExtension(second.pi);
		expect(__test.claimPiStartupMaintenance()).toBe(false);
	}, 15_000);
	it("registers independent sessions in the same process", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const first = createCountingPi();
		await magicContextPiExtension(first.pi);
		// Sanity: the first init registered the full runtime.
		expect(first.events.length).toBeGreaterThan(0);
		expect(first.tools).toContain("ctx_search");
		expect(first.commands).toContain("ctx-status");
		expect(first.entryRenderers).toEqual(["ctx-status"]);

		const second = createCountingPi();
		await magicContextPiExtension(second.pi);
		expect(second.events.length).toBeGreaterThan(0);
		expect(second.tools).toContain("ctx_search");
		expect(second.commands).toContain("ctx-status");
		expect(second.entryRenderers).toEqual(["ctx-status"]);
	}, 15_000);

	it("unsubscribes child lifecycle listeners on session shutdown", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const runtime = createCountingPi();
		await magicContextPiExtension(runtime.pi);
		expect(
			runtime.eventBusHandlerCount("subagents:child:session-created"),
		).toBe(1);
		expect(runtime.eventBusHandlerCount("subagents:child:disposed")).toBe(1);

		await runtime.emitPiEvent(
			"session_shutdown",
			{},
			{
				sessionManager: { getSessionId: () => undefined },
				ui: { setStatus: () => undefined },
			},
		);
		expect(
			runtime.eventBusHandlerCount("subagents:child:session-created"),
		).toBe(0);
		expect(runtime.eventBusHandlerCount("subagents:child:disposed")).toBe(0);
	}, 15_000);

	it("skips only the marked in-process child", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const parent = createCountingPi();
		await magicContextPiExtension(parent.pi);
		parent.emitEvent("subagents:child:spawning");
		parent.emitEvent("subagents:child:session-created");

		// Second init in the SAME process (the in-process child case).
		// It must register nothing — same contract as a spawned subagent.
		const child = createCountingPi();
		await magicContextPiExtension(child.pi);
		expect(child.events).toEqual([]);
		expect(child.tools).toEqual([]);
		expect(child.commands).toEqual([]);

		// Simulate the child dispose path clearing its lifecycle marker.
		parent.emitEvent("subagents:child:disposed");
		// A subsequent independent init re-registers the full runtime.
		const sibling = createCountingPi();
		await magicContextPiExtension(sibling.pi);
		expect(sibling.tools).toContain("ctx_search");
		expect(sibling.commands).toContain("ctx-status");
	}, 15_000);

	it("does not suppress an independent session while a child marker is active", async () => {
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const parent = createCountingPi();
		await magicContextPiExtension(parent.pi);

		let childMarked!: () => void;
		const marked = new Promise<void>((resolve) => {
			childMarked = resolve;
		});
		let releaseChild!: () => void;
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		const child = createCountingPi();
		const childBranch = Promise.resolve().then(async () => {
			parent.emitEvent("subagents:child:session-created");
			await magicContextPiExtension(child.pi);
			childMarked();
			await release;
			parent.emitEvent("subagents:child:disposed");
		});

		await marked;
		try {
			expect(child.tools).toEqual([]);

			const independent = createCountingPi();
			await magicContextPiExtension(independent.pi);
			expect(independent.tools).toContain("ctx_search");
			expect(independent.commands).toContain("ctx-status");
		} finally {
			releaseChild();
			await childBranch;
		}
	}, 15_000);

	it("keeps the spawned-child environment guard", async () => {
		isolateXdgEnv();
		process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV] = "1";

		const registrations = createCountingPi();
		await magicContextPiExtension(registrations.pi);

		expect(registrations.events).toEqual([]);
		expect(registrations.tools).toEqual([]);
		expect(registrations.flags).toEqual([]);
		expect(registrations.commands).toEqual([]);
		expect(registrations.entryRenderers).toEqual([]);
		// The env guard returns BEFORE registering lifecycle markers, so a later
		// independent init in the same process would still initialize fully.
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
		const later = createCountingPi();
		await magicContextPiExtension(later.pi);
		expect(later.tools).toContain("ctx_search");
	});

	it("mutation direction: clearing the marker makes the child-init test fail", async () => {
		// This test documents the regression guard: if the marker check is
		// removed from the entry, a child init would register everything.
		// We simulate the marker being absent before the child init and assert
		// that it then registers the full runtime — proving the marker suppresses it.
		isolateXdgEnv();
		delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];

		const parent = createCountingPi();
		await magicContextPiExtension(parent.pi);
		parent.emitEvent("subagents:child:session-created");

		// Simulate the marker being absent: clear it before the child init.
		__test.clearPiInProcessSubagentInitContext();

		const child = createCountingPi();
		await magicContextPiExtension(child.pi);

		// Without the marker suppressing it, the child init registers.
		expect(child.events.length).toBeGreaterThan(0);
		expect(child.tools.length).toBeGreaterThan(0);
		expect(child.commands.length).toBeGreaterThan(0);
	}, 15_000);
});
