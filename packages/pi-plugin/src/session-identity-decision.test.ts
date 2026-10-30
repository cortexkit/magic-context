import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	__resetProjectIdentityForTests,
	__setProjectIdentityTestHooks,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import { rememberPinnedProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity-cache";
import {
	__resetSessionIdentityDecisionsForTests,
	readSessionIdentityDecision,
	resolveSessionProjectIdentity,
} from "@magic-context/core/features/magic-context/memory/session-identity-decision";
import {
	closeDatabase,
	openDatabase,
} from "@magic-context/core/features/magic-context/storage";
import {
	readSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage-meta-session";
import {
	_resetHarnessForTesting,
	setHarness,
} from "@magic-context/core/shared/harness";
import * as logger from "@magic-context/core/shared/logger";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	hasSystemPromptRefresh,
	registerPiContextHandler,
	signalPiSystemPromptRefreshForProject,
	trackSessionForProject,
} from "./context-handler";
import extension, { __test as indexTest } from "./index";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";
import {
	createIdentityPeer,
	registeredProjectId,
} from "./session-identity-test-peer";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

const originalEnv = { ...process.env };
const envKeys = [
	"MAGIC_CONTEXT_TEST_DATA_DIR",
	"MAGIC_CONTEXT_STORAGE_DIR",
	"XDG_DATA_HOME",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
];
let temp: ReturnType<typeof createTestTempDir>;
const cleanups: (() => void | Promise<void>)[] = [];
const sessions = new Set<string>();

beforeEach(() => {
	closeDatabase();
	temp = createTestTempDir("mc-pi-session-identity-");
	for (const key of envKeys) process.env[key] = join(temp.dir, key);
	mkdirSync(process.env.XDG_CONFIG_HOME as string, { recursive: true });
	__setProjectIdentityTestHooks({
		execFileSync: (() => "a".repeat(40)) as unknown as typeof execFileSync,
	});
	// Background maintenance is unrelated to lifecycle identity selection.
	indexTest.claimPiStartupMaintenance();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const id of sessions) clearContextHandlerSession(id);
	sessions.clear();
	closeDatabase();
	__resetSessionIdentityDecisionsForTests();
	__resetProjectIdentityForTests();
	indexTest.clearPiStartupMaintenanceClaim();
	indexTest.clearPiInProcessSubagentInitContext();
	__setPiHarnessKindForTesting(undefined);
	_resetHarnessForTesting();
	setHarness("pi");
	for (const key of envKeys) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
	temp.cleanup();
});

function folder(name: string, git = true) {
	const dir = join(temp.dir, name);
	mkdirSync(git ? join(dir, ".git") : dir, { recursive: true });
	return dir;
}

function context(sessionId: string, cwd: string) {
	sessions.add(sessionId);
	const ctx = fakeContext(sessionId, cwd);
	return {
		...ctx,
		hasUI: false,
		ui: { ...ctx.ui, setStatus: () => {} },
	} as unknown as ExtensionContext;
}

function row(sessionId: string) {
	return (
		openDatabase()
			?.prepare(
				"SELECT project_path FROM session_projects WHERE session_id = ? AND harness = 'pi'",
			)
			.get(sessionId) as { project_path: string } | null
	)?.project_path;
}

async function runtime(directory: string, dreamerEnabled = false) {
	const peer = await createIdentityPeer(temp.dir, directory);
	cleanups.push(() => peer.close());
	const configDir = join(process.env.XDG_CONFIG_HOME as string, "cortexkit");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "magic-context.jsonc"),
		JSON.stringify({
			subc: { connection_file: peer.connectionFile },
			memory: { enabled: true },
			dreamer: { disable: !dreamerEnabled },
			embedding: { provider: "off" },
		}),
	);
	const handlers = new Map<
		string,
		((event: never, ctx: ExtensionContext) => unknown)[]
	>();
	const tools = new Map<string, ToolDefinition>();
	let activeTools: string[] = [];
	const pi = {
		events: { on: () => () => {} },
		on: (
			name: string,
			handler: (event: never, ctx: ExtensionContext) => unknown,
		) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
			activeTools.push(tool.name);
		},
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
		registerFlag: () => {},
		registerCommand: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	const cwd = spyOn(process, "cwd").mockReturnValue(directory);
	try {
		await extension(pi);
	} finally {
		cwd.mockRestore();
	}
	async function emit(
		name: string,
		ctx: ExtensionContext,
		event: unknown = {},
	) {
		let result: unknown;
		for (const handler of handlers.get(name) ?? [])
			result = await handler(event as never, ctx);
		return result;
	}
	const pass = (ctx: ExtensionContext) =>
		emit("context", ctx, { messages: [userMessage("hello")] });
	const start = (ctx: ExtensionContext) =>
		emit("session_start", ctx, { type: "session_start", reason: "startup" });
	cleanups.push(async () => {
		await emit("session_shutdown", context("shutdown", directory));
	});
	return { peer, handlers, tools, emit, pass, start };
}

describe("Pi session identity decisions", () => {
	it("keeps search and smart notes on the served owner during a pending move", async () => {
		const a = folder("search-served");
		const b = folder("search-pending");
		const host = await runtime(a, true);
		const sessionId = "pi-search-owner";
		const ctx = context(sessionId, a);
		await host.start(ctx);
		await host.pass(ctx);
		rememberPinnedProjectIdentity(b, "pj-PENDING");
		const moved = context(sessionId, b);
		await host.tools.get("ctx_memory")!.execute(
			"write",
			{
				action: "write",
				category: "PROJECT_RULES",
				content: "Unrendered gateway upload rule.",
			},
			undefined,
			undefined,
			moved,
		);
		const db = openDatabase()!;
		const memory = db
			.prepare("SELECT id FROM memories WHERE content = ?")
			.get("Unrendered gateway upload rule.") as { id: number };
		const search = await host.tools
			.get("ctx_search")!
			.execute(
				"search",
				{ query: String(memory.id) },
				undefined,
				undefined,
				moved,
			);
		expect(JSON.stringify(search)).toContain("Unrendered gateway upload rule.");
		await host.tools.get("ctx_note")!.execute(
			"smart",
			{
				action: "write",
				content: "Served-owner smart note.",
				surface_condition: "When editing upload limits",
			},
			undefined,
			undefined,
			moved,
		);
		expect(
			db
				.prepare("SELECT project_path FROM notes WHERE content = ?")
				.get("Served-owner smart note."),
		).toEqual({ project_path: registeredProjectId });
	});

	it("recovers an upgraded owner from cached bytes without changing the prefix", async () => {
		const directory = folder("proven-upgrade");
		const host = await runtime(directory);
		const sessionId = "pi-proven-upgrade";
		const ctx = context(sessionId, directory);
		await host.start(ctx);
		await host.pass(ctx);
		const db = openDatabase()!;
		const served = readSessionMeta(db, sessionId);
		updateSessionMeta(db, sessionId, { cachedM0ProjectIdentity: null });
		expect(
			await resolveSessionProjectIdentity(sessionId, directory, { db }),
		).toBe(registeredProjectId);
		const recovered = readSessionMeta(db, sessionId);
		expect(recovered.cachedM0ProjectIdentity).toBe(registeredProjectId);
		expect(recovered.cachedM0Bytes).toEqual(served.cachedM0Bytes);
		expect(recovered.cachedM1Bytes).toEqual(served.cachedM1Bytes);
		expect(recovered.cachedM0MaterializedAt).toBe(
			served.cachedM0MaterializedAt,
		);
	});

	for (const harness of ["pi", "omp"] as const) {
		it(`${harness}: unknown-owner refusal clears at the next admitted rebuild without restart`, async () => {
			__setPiHarnessKindForTesting(harness);
			_resetHarnessForTesting();
			setHarness(harness);
			const directory = folder(`${harness}-upgrade-rebuild`);
			const host = await runtime(directory, true);
			const sessionId = `${harness}-upgrade-rebuild`;
			const ctx = context(sessionId, directory);
			await host.start(ctx);
			await host.pass(ctx);
			const db = openDatabase()!;
			await host.tools.get("ctx_note")!.execute(
				"smart-before-upgrade",
				{
					action: "write",
					content: "Existing smart note.",
					surface_condition: "When editing upload limits",
				},
				undefined,
				undefined,
				ctx,
			);
			const smart = db
				.prepare("SELECT id FROM notes WHERE content = ?")
				.get("Existing smart note.") as { id: number };
			updateSessionMeta(db, sessionId, { cachedM0ProjectIdentity: null });
			db.prepare(
				"DELETE FROM memory_applied_snapshots WHERE session_id = ?",
			).run(sessionId);
			const baseline = readSessionMeta(db, sessionId);
			const execute = (name: string, params: Record<string, unknown>) =>
				host.tools
					.get(name)!
					.execute("upgrade", params, undefined, undefined, ctx);
			expect(
				JSON.stringify(
					await execute("ctx_memory", {
						action: "write",
						category: "PROJECT_RULES",
						content: "Allowed only after rebuilding.",
					}),
				),
			).toContain("ctx_memory write refused");
			expect(
				JSON.stringify(
					await execute("ctx_note", {
						action: "write",
						content: "Smart note must wait.",
						surface_condition: "When editing upload limits",
					}),
				),
			).toContain("ctx_note write refused");
			for (const action of ["read", "update", "dismiss"]) {
				expect(
					JSON.stringify(
						await execute("ctx_note", {
							action,
							note_ids: [smart.id],
							content: "Must not update.",
						}),
					),
				).toContain(`ctx_note ${action} refused`);
			}
			expect(
				JSON.stringify(
					await execute("ctx_search", {
						query: "Existing smart note",
						sources: ["memory", "primer", "note"],
					}),
				),
			).toContain("ctx_search memory refused");
			const sessionNote = await execute("ctx_note", {
				action: "write",
				content: "Session notes still work.",
			});
			expect(sessionNote.isError).not.toBe(true);
			const note = db
				.prepare("SELECT id FROM notes WHERE content = ?")
				.get("Session notes still work.") as { id: number };
			for (const action of ["read", "update", "dismiss"]) {
				expect(
					(
						await execute("ctx_note", {
							action,
							note_ids: [note.id],
							content: "Updated session note.",
						})
					).isError,
				).not.toBe(true);
			}
			await host.pass(ctx);
			const deferred = readSessionMeta(db, sessionId);
			expect(deferred.cachedM0ProjectIdentity).toBeNull();
			expect(deferred.cachedM0Bytes).toEqual(baseline.cachedM0Bytes);
			expect(deferred.cachedM1Bytes).toEqual(baseline.cachedM1Bytes);
			// A changed system prompt independently admits the next prefix rebuild.
			updateSessionMeta(db, sessionId, {
				systemPromptHash: "new-system-prompt",
			});
			await host.pass(ctx);
			expect(readSessionMeta(db, sessionId).cachedM0ProjectIdentity).toBe(
				registeredProjectId,
			);
			expect(
				db
					.prepare("SELECT harness FROM session_projects WHERE session_id = ?")
					.get(sessionId),
			).toEqual({ harness });
			expect(
				(
					await execute("ctx_memory", {
						action: "write",
						category: "PROJECT_RULES",
						content: "Allowed only after rebuilding.",
					})
				).isError,
			).not.toBe(true);
			expect(
				db
					.prepare("SELECT project_path FROM memories WHERE content = ?")
					.get("Allowed only after rebuilding."),
			).toEqual({ project_path: registeredProjectId });
		});
	}

	it("review: Pi memory writes must follow the served prefix rather than a pending directory move", async () => {
		const a = folder("served-project");
		const b = folder("pending-project");
		const host = await runtime(a);
		const sessionId = "pi-review-served-owner";
		const ctx = context(sessionId, a);
		await host.start(ctx);
		await host.tools.get("ctx_memory")!.execute(
			"review-baseline-write",
			{
				action: "write",
				category: "PROJECT_RULES",
				content: "The served project keeps upload limits in its gateway.",
			},
			undefined,
			undefined,
			ctx,
		);
		await host.pass(ctx);
		const db = openDatabase()!;
		const served = readSessionMeta(db, sessionId);
		expect(served.cachedM0ProjectIdentity).toBe(registeredProjectId);
		expect(served.cachedM0Bytes).not.toBeNull();
		expect(served.cachedM0Bytes!.toString()).toContain(
			"The served project keeps upload limits in its gateway.",
		);
		rememberPinnedProjectIdentity(b, "pj-PENDING");
		await host.tools.get("ctx_memory")!.execute(
			"review-move-write",
			{
				action: "write",
				category: "PROJECT_RULES",
				content: "Pi served-owner witness",
			},
			undefined,
			undefined,
			context(sessionId, b),
		);
		expect(readSessionMeta(db, sessionId).cachedM0Bytes).toEqual(
			served.cachedM0Bytes,
		);
		const saved = db
			.prepare("SELECT project_path FROM memories WHERE content = ?")
			.get("Pi served-owner witness") as { project_path: string } | null;
		expect(saved).not.toBeNull();
		expect(saved!.project_path).toBe(registeredProjectId);
	});

	it("review: Pi memory writes must refuse an unproven upgraded prefix", async () => {
		const directory = folder("legacy-project");
		const host = await runtime(directory);
		const sessionId = "pi-review-unproven-owner";
		const ctx = context(sessionId, directory);
		await host.start(ctx);
		await host.pass(ctx);
		const db = openDatabase()!;
		updateSessionMeta(db, sessionId, { cachedM0ProjectIdentity: null });
		db.prepare("DELETE FROM memory_applied_snapshots WHERE session_id = ?").run(
			sessionId,
		);
		expect(readSessionMeta(db, sessionId).cachedM0Bytes).not.toBeNull();
		const result = await host.tools.get("ctx_memory")!.execute(
			"review-unproven-write",
			{
				action: "write",
				category: "PROJECT_RULES",
				content: "Pi unknown-owner witness",
			},
			undefined,
			undefined,
			ctx,
		);
		const saved = db
			.prepare("SELECT project_path FROM memories WHERE content = ?")
			.get("Pi unknown-owner witness");
		expect(saved).toBeNull();
		expect(JSON.stringify(result)).toContain("ctx_memory write refused");
	});

	it("keeps A's git decision after B rebuilds the same directory's config cache", async () => {
		const directory = folder("shared");
		const host = await runtime(directory);
		host.peer.up = false;
		const a = context("pi-A", directory);
		await host.start(a);
		expect(readSessionIdentityDecision("pi-A", directory)?.identity).toBe(
			`git:${"a".repeat(40)}`,
		);
		host.peer.up = true;
		const b = context("pi-B", directory);
		await host.start(b);
		expect(readSessionIdentityDecision("pi-B", directory)?.identity).toBe(
			registeredProjectId,
		);
		expect(host.peer.calls).toHaveLength(2);
		await host.pass(a);
		await host.pass(b);
		await host.pass(a);
		expect(row("pi-A")).toBe(`git:${"a".repeat(40)}`);
		expect(row("pi-B")).toBe(registeredProjectId);
		expect(host.peer.calls).toHaveLength(2);
		const agentStart = host.handlers.get("agent_start")?.[0];
		expect(agentStart).toBeDefined();
		expect(agentStart?.({} as never, a)).toBeUndefined();
		const memory = host.tools.get("ctx_memory");
		expect(memory).toBeDefined();
		await memory?.execute(
			"memory-a",
			{
				action: "write",
				category: "PROJECT_RULES",
				content: "session A's memory",
			},
			undefined,
			undefined,
			a,
		);
		const saved = openDatabase()
			?.prepare("SELECT project_path FROM memories WHERE content = ?")
			.get("session A's memory") as { project_path: string };
		expect(saved.project_path).toBe(`git:${"a".repeat(40)}`);
	});

	it("shares the pending session_start decision with the first context pass", async () => {
		const directory = folder("delayed");
		const host = await runtime(directory);
		host.peer.delayMs = 150;
		let reached!: () => void;
		const resolving = new Promise<void>((resolve) => {
			reached = resolve;
		});
		host.peer.onResolve = reached;
		const ctx = context("pi-delayed", directory);
		const start = host.start(ctx);
		await resolving;
		expect(
			readSessionIdentityDecision("pi-delayed", directory),
		).toBeUndefined();
		const pass = host.pass(ctx);
		await Promise.all([start, pass]);
		expect(row("pi-delayed")).toBe(registeredProjectId);
		expect(host.peer.calls).toHaveLength(1);
	});

	it("creates the decision in a resumed context pass without session_start", async () => {
		const directory = folder("resumed");
		const peer = await createIdentityPeer(temp.dir, directory);
		cleanups.push(() => peer.close());
		const db = createTestDb();
		cleanups.push(() => {
			db.close();
		});
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			subcConnectionFile: peer.connectionFile,
		});
		const handler = fake.handlers.get("context") as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;
		await handler(
			{ messages: [userMessage("hello")] },
			context("pi-resumed", directory),
		);
		const saved = db
			.prepare("SELECT project_path FROM session_projects WHERE session_id = ?")
			.get("pi-resumed") as { project_path: string };
		expect(saved.project_path).toBe(registeredProjectId);
		expect(peer.calls).toHaveLength(1);
	});

	it("observes ctx.cwd moving from an unregistered folder to a pin without resolving again", async () => {
		const initial = folder("unregistered", false);
		const pinned = folder("pinned");
		const host = await runtime(initial);
		host.peer.up = false;
		const ctx = context("pi-move", initial);
		await host.start(ctx);
		expect(
			readSessionIdentityDecision("pi-move", initial)?.identity,
		).toStartWith("dir:");
		rememberPinnedProjectIdentity(pinned, "pj-moved");
		host.peer.up = true;
		host.peer.calls.length = 0;
		const logs = spyOn(logger, "log").mockImplementation(() => {});
		try {
			ctx.cwd = pinned;
			await host.pass(ctx);
			await host.pass(ctx);
			expect(row("pi-move")).toBe("pj-moved");
			expect(readSessionIdentityDecision("pi-move", pinned)).toEqual({
				directory: pinned,
				identity: "pj-moved",
			});
			expect(host.peer.calls).toHaveLength(0);
			expect(
				logs.mock.calls.filter(([line]) =>
					String(line).includes("directory moved from"),
				),
			).toHaveLength(1);
		} finally {
			logs.mockRestore();
		}
	});

	it("does not let a pending start replace a context-observed directory move", async () => {
		const initial = folder("pending-start");
		const moved = folder("moved-before-answer");
		rememberPinnedProjectIdentity(moved, "pj-new-root");
		const host = await runtime(initial);
		host.peer.delayMs = 150;
		let reached!: () => void;
		const resolving = new Promise<void>((resolve) => {
			reached = resolve;
		});
		host.peer.onResolve = reached;
		const ctx = context("pi-pending-move", initial);
		const start = host.start(ctx);
		await resolving;
		ctx.cwd = moved;
		await host.pass(ctx);
		await start;
		expect(row("pi-pending-move")).toBe("pj-new-root");
		expect(
			readSessionIdentityDecision("pi-pending-move", moved)?.identity,
		).toBe("pj-new-root");
		expect(host.peer.calls).toHaveLength(1);
	});

	it("accepts pj- identities in Pi's project session filter", () => {
		sessions.add("pi-pj-filter");
		trackSessionForProject("pj-registered", "pi-pj-filter");
		expect(hasSystemPromptRefresh("pi-pj-filter")).toBe(false);
		signalPiSystemPromptRefreshForProject("pj-registered");
		expect(hasSystemPromptRefresh("pi-pj-filter")).toBe(true);
	});
});
