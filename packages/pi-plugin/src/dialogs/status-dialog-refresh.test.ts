import { describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage-meta";
import * as formatting from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";
import { createTestDb, fakeContext } from "../test-utils.test";
import {
	buildPiStatusDetail,
	PiStatusDetailRefresh,
	PiStatusTokenCache,
	showStatusDialog,
} from "./status-dialog";

function fixture(db = createTestDb()) {
	let sessionId = "ses-refresh";
	let system = "You are a helpful coding assistant.";
	let inputTokens = 40_000;
	const tools = [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	];
	const pi = { getAllTools: () => tools };
	const ctx = {
		...fakeContext(sessionId),
		model: {
			provider: "anthropic",
			id: "model-a",
			contextWindow: 100_000,
			maxTokens: 20_000,
		},
		getSystemPrompt: () => system,
		getContextUsage: () => ({
			tokens: inputTokens,
			percent: 40,
			contextWindow: 100_000,
		}),
	};
	ctx.sessionManager.getSessionId = () => sessionId;
	const deps = {
		db,
		projectIdentity: "/fixture/project",
		activeProfile: "default",
	};
	const estimates: string[] = [];
	const tokens = new PiStatusTokenCache((text) => {
		estimates.push(text);
		return formatting.estimateTokens(text);
	});
	const refresh = new PiStatusDetailRefresh(
		pi as never,
		ctx as never,
		deps,
		sessionId,
		tokens,
	);
	return {
		db,
		pi,
		ctx,
		deps,
		tools,
		estimates,
		refresh,
		setSystem: (value: string) => {
			system = value;
		},
		setInput: (value: number) => {
			inputTokens = value;
		},
		setSession: (value: string) => {
			sessionId = value;
		},
	};
}

describe("Pi status refresh work", () => {
	it("invalidates token estimates for exact system/tool bytes and model changes mid-session", () => {
		const f = fixture();
		try {
			f.refresh.refresh(0);
			expect(f.estimates).toHaveLength(2);
			f.refresh.refresh(1000);
			expect(f.estimates).toHaveLength(2);

			const system =
				"Use precise steps, verify every edit, and explain the result.";
			f.setSystem(system);
			expect(f.refresh.refresh(2000).systemPromptTokens).toBe(
				formatting.estimateTokens(system),
			);
			expect(f.estimates.at(-1)).toBe(system);
			expect(f.estimates).toHaveLength(3);

			// Mutate the same tool object, including nested schema bytes. An
			// identity-only key would incorrectly retain the earlier estimate.
			f.tools[0]!.description =
				"Read file contents with numbered lines and metadata";
			f.tools[0]!.parameters.properties.path.type = "array";
			const toolBytes = `read\n${f.tools[0]!.description}\n${JSON.stringify(f.tools[0]!.parameters)}`;
			expect(f.refresh.refresh(3000).toolDefinitionTokens).toBe(
				formatting.estimateTokens(toolBytes),
			);
			expect(f.estimates.at(-1)).toBe(toolBytes);
			expect(f.estimates).toHaveLength(4);

			f.ctx.model.id = "model-b";
			f.ctx.model.maxTokens = 30_000;
			const changed = f.refresh.refresh(4000);
			expect(changed.contextLimit).toBe(75_000); // Output reserve is capped at 25% of the window.
			expect(f.estimates.slice(-2)).toEqual([system, toolBytes]);
			expect(f.estimates).toHaveLength(6);

			f.setSystem("");
			expect(f.refresh.refresh(5000).systemPromptTokens).toBe(0);
			f.tools.length = 0;
			expect(f.refresh.refresh(6000).toolDefinitionTokens).toBe(0);
			f.refresh.refresh(7000);
			expect(f.estimates).toHaveLength(7);
		} finally {
			closeQuietly(f.db);
		}
	});

	it("updates countdowns and usage every second without querying full detail", () => {
		const f = fixture();
		try {
			updateSessionMeta(f.db, "ses-refresh", {
				lastResponseTime: 10_000,
				cacheTtl: "5m",
			});
			const initial = f.refresh.refresh(10_000);
			f.setInput(50_000);
			const live = f.refresh.refresh(11_000);
			expect(live.cacheRemainingMs).toBe(initial.cacheRemainingMs - 1000);
			expect(live.inputTokens).toBe(50_000);
			expect(live.usagePercentage).toBe(62.5);
			expect(live.conversationTokens - initial.conversationTokens).toBe(10_000);
			expect(f.estimates).toHaveLength(2);
			expect(f.refresh.refresh(310_000).cacheExpired).toBe(true);
		} finally {
			closeQuietly(f.db);
		}
	});

	it("refreshes stored detail on local writes, session changes, config changes and rollback", () => {
		const f = fixture();
		try {
			expect(f.refresh.refresh(0).historianRunning).toBe(false);
			updateSessionMeta(f.db, "ses-refresh", { compartmentInProgress: true });
			expect(f.refresh.refresh(1000).historianRunning).toBe(true);
			f.deps.activeProfile = "review";
			expect(f.refresh.refresh(2000).activeProfile).toBe("review");
			f.setSession("ses-other");
			expect(f.refresh.refresh(3000).sessionId).toBe("ses-other");
			expect(f.refresh.refresh(3000).historianRunning).toBe(false);
			f.db.exec("BEGIN");
			f.db
				.prepare(
					"UPDATE session_meta SET compartment_in_progress = 1 WHERE session_id = ?",
				)
				.run("ses-other");
			expect(f.refresh.refresh(4000).historianRunning).toBe(true);
			f.db.exec("ROLLBACK");
			expect(f.refresh.refresh(5000).historianRunning).toBe(false);
			expect(f.estimates).toHaveLength(2);
		} finally {
			closeQuietly(f.db);
		}
	});

	it("refreshes on commits from another connection", () => {
		const { dir, cleanup } = createTestTempDir("mc-status-refresh-");
		const f = fixture(createTestDb(join(dir, "fixture.db")));
		const writer = createTestDb(join(dir, "fixture.db"));
		try {
			expect(f.refresh.refresh(0).historianRunning).toBe(false);
			updateSessionMeta(writer, "ses-refresh", { compartmentInProgress: true });
			expect(f.refresh.refresh(1000).historianRunning).toBe(true);
		} finally {
			closeQuietly(writer);
			closeQuietly(f.db);
			cleanup();
		}
	});

	it("measures tokenizations and database queries for a minute of unchanged detail", () => {
		const f = fixture();
		const estimate = formatting.estimateTokens;
		let tokenizations = 0;
		let queries = 0;
		const tokenize = spyOn(formatting, "estimateTokens").mockImplementation(
			(text) => {
				tokenizations += 1;
				return estimate(text);
			},
		);
		const prepare = f.db.prepare.bind(f.db);
		const dbSpy = spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
			const statement = prepare(sql);
			return new Proxy(statement, {
				get(target, key) {
					const value = Reflect.get(target, key, target);
					if (typeof value !== "function") return value;
					return (...args: unknown[]) => {
						if (key === "get" || key === "all") queries += 1;
						return value.apply(target, args);
					};
				},
			});
		}) as never);
		try {
			// Pre-seed as a real open dialog would; exclude opening/migrations
			// from both minute-long measurements.
			getOrCreateSessionMeta(f.db, "ses-refresh");
			buildPiStatusDetail(f.pi as never, f.ctx as never, f.deps, "ses-refresh");
			queries = 0;
			tokenizations = 0;
			for (let second = 1; second <= 60; second++) {
				buildPiStatusDetail(
					f.pi as never,
					f.ctx as never,
					f.deps,
					"ses-refresh",
				);
			}
			const before = { queries, tokenizations };
			const refresh = new PiStatusDetailRefresh(
				f.pi as never,
				f.ctx as never,
				f.deps,
				"ses-refresh",
			);
			refresh.refresh(0);
			queries = 0;
			tokenizations = 0;
			for (let second = 1; second <= 60; second++)
				refresh.refresh(second * 1000);
			const after = { queries, tokenizations };
			expect(before.tokenizations).toBeGreaterThanOrEqual(120);
			expect(after.tokenizations).toBe(0);
			// Six full detail builds plus one cheap revision query per second
			// and one post-build revision query per build.
			expect(after.queries).toBe(before.queries / 10 + 66);
			expect(after.queries).toBeLessThan(before.queries);
			console.log(
				`Pi work/minute (excluding open): before=${JSON.stringify(before)} after=${JSON.stringify(after)}; full detail builds=60 -> 6`,
			);
		} finally {
			dbSpy.mockRestore();
			tokenize.mockRestore();
			closeQuietly(f.db);
		}
	});

	it("the mounted dialog uses the same change-aware refresh on its one-second timer", async () => {
		const f = fixture();
		let tick = () => {};
		let renders = 0;
		let dialog:
			| { render(width: number): string[]; dispose(): void }
			| undefined;
		const timer = spyOn(globalThis, "setInterval").mockImplementation(((
			callback: () => void,
			ms: number,
		) => {
			expect(ms).toBe(1000);
			tick = callback;
			return 123;
		}) as never);
		try {
			await showStatusDialog(
				f.pi as never,
				{
					...f.ctx,
					ui: {
						custom: async (factory: (...args: unknown[]) => typeof dialog) => {
							dialog = factory(
								{
									terminal: { rows: 100 },
									requestRender: () => {
										renders += 1;
									},
								},
								{
									fg: (_: string, text: string) => text,
									bold: (text: string) => text,
								},
								{},
								() => {},
							);
						},
					},
				} as never,
				f.deps,
			);
			f.ctx.model.maxTokens = 25_000;
			tick();
			expect(renders).toBe(1);
			expect(dialog?.render(110).join("\n")).toContain(
				"window 100k · 25k output reserve",
			);
		} finally {
			dialog?.dispose();
			timer.mockRestore();
			closeQuietly(f.db);
		}
	});
});
