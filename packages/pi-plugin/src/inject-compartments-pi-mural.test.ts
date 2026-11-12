import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MEMORY_MURAL_BLOCK,
	MEMORY_MURAL_GUIDANCE,
} from "@magic-context/core/agents/magic-context-prompt";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import * as renderTrigger from "@magic-context/core/features/magic-context/mural/render-trigger";
import { resolveMuralWire } from "@magic-context/core/features/magic-context/mural/render-trigger";
import type { MuralPool } from "@magic-context/core/features/magic-context/mural/resolve-mural";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	clearModelsDevCache,
	refreshModelLimitsFromApi,
} from "@magic-context/core/shared/models-dev-cache";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { patchSessionMeta } from "../../plugin/src/features/magic-context/__tests__/session-meta-fixture";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { clearContextHandlerSession } from "./context-handler";
import {
	__test,
	injectM0M1Pi,
	type PiM0M1State,
} from "./inject-compartments-pi";
import {
	__test as hygieneTest,
	measurePiTailHygiene,
} from "./tail-hygiene-walk-pi";
import { createTestDb, textOf, userMessage } from "./test-utils.test";

const SESSION_ID = "ses_pi_mural_inject";

// 1x1 transparent PNG data URL (same fixture as OpenCode mural inject tests).
const FAKE_MURAL_DATA_URL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const FAKE_MURAL_BASE64 = FAKE_MURAL_DATA_URL.slice(
	"data:image/png;base64,".length,
);

function muralOption(
	dataUrl = FAKE_MURAL_DATA_URL,
	contentHash = "mural-hash-1",
) {
	return {
		enabled: true,
		supportsVision: true,
		dataUrl,
		contentHash,
	};
}

function baseState(overrides: Partial<PiM0M1State> = {}): PiM0M1State {
	return {
		sessionId: SESSION_ID,
		projectIdentity: "git:pi-mural",
		projectDirectory: "/tmp/pi-mural",
		hardSignals: {
			systemHash: "sys",
			modelKey: "anthropic/claude-sonnet-4",
			cacheExpired: false,
			lastResponseTime: 0,
		},
		...overrides,
	};
}

function replaceCurrentManifest(db: ReturnType<typeof createTestDb>): string {
	const image = Buffer.from("current pi mural", "utf8");
	db.prepare(
		`INSERT OR REPLACE INTO mural_manifest
			(project_path, image, content_hash, rendered_at, memory_ids_json, width, height)
		 VALUES (?, ?, ?, ?, '[]', 1, 1)`,
	).run("git:pi-mural", image, "current-pi-manifest", Date.now());
	return image.toString("base64");
}

function findM0Image(messages: Array<{ content?: unknown }>): {
	type?: string;
	mimeType?: string;
	data?: string;
} | null {
	const head = messages[0];
	if (!head || !Array.isArray(head.content)) return null;
	for (const part of head.content) {
		if (
			part &&
			typeof part === "object" &&
			(part as { type?: string }).type === "image"
		) {
			return part as { type?: string; mimeType?: string; data?: string };
		}
	}
	return null;
}

describe("Pi m[0] mural image fold (on-demand render → wire)", () => {
	it("session teardown frees mural and hygiene bodies without changing persisted replay bytes", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const first = [userMessage("hello")];
			injectM0M1Pi(
				baseState({ mural: muralOption() }),
				db,
				first as never,
				undefined,
				true,
			);
			measurePiTailHygiene({
				messages: first,
				tags: [],
				protectedTagNumbers: new Set(),
			});
			expect(__test.hasMuralProcessCache(SESSION_ID)).toBe(true);
			expect(hygieneTest.contentMemoStats().bytes).toBeGreaterThan(0);
			clearContextHandlerSession(SESSION_ID);
			expect(__test.hasMuralProcessCache(SESSION_ID)).toBe(false);
			expect(hygieneTest.contentMemoStats()).toEqual({ entries: 0, bytes: 0 });
			const replay = [userMessage("hello")];
			injectM0M1Pi(baseState(), db, replay as never, undefined, false);
			expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
		} finally {
			__test.clearPiMuralProcessCache(SESSION_ID);
			closeQuietly(db);
		}
	});
	it("replays a pre-legend baseline unchanged until the next HARD fold", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const firstMessages = [userMessage("first")];
			injectM0M1Pi(
				baseState({ mural: muralOption() }),
				db,
				firstMessages as never,
				undefined,
				true,
			);
			const meta = getOrCreateSessionMeta(db, SESSION_ID);
			const legacy = Buffer.from(
				meta.cachedM0Bytes
					?.toString("utf8")
					.replace(`${MEMORY_MURAL_GUIDANCE}\n`, ""),
			);
			db.prepare(
				"INSERT INTO session_render_cache (session_id,cache_key,value) VALUES (?, 'cached_m0_bytes', ?) ON CONFLICT(session_id,cache_key) DO UPDATE SET value=excluded.value",
			).run(SESSION_ID, legacy);
			__test.clearPiMuralProcessCache(SESSION_ID);
			const deferredMessages = [userMessage("defer")];
			const deferred = injectM0M1Pi(
				baseState(),
				db,
				deferredMessages as never,
				undefined,
				false,
			);
			expect(deferred.m0Materialized).toBe(false);
			expect(textOf(deferredMessages[0])).toBe(
				textOf(firstMessages[0]).replace(`${MEMORY_MURAL_GUIDANCE}\n`, ""),
			);
			const foldedMessages = [userMessage("hard")];
			injectM0M1Pi(
				baseState({
					mural: muralOption(),
					hardSignals: { ...baseState().hardSignals!, systemHash: "next" },
				}),
				db,
				foldedMessages as never,
				undefined,
				true,
			);
			expect(textOf(foldedMessages[0])).toContain(MEMORY_MURAL_BLOCK);
		} finally {
			__test.clearPiMuralProcessCache(SESSION_ID);
			closeQuietly(db);
		}
	});

	it("folds the <memory-mural> block and Pi image part on HARD, replays byte-identical on defer", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const state = baseState({ mural: muralOption() });

			const hardMessages = [userMessage("hello")];
			const first = injectM0M1Pi(
				state,
				db,
				hardMessages as never,
				undefined,
				true,
			);
			expect(first.injected).toBe(true);
			expect(first.m0Materialized).toBe(true);
			expect(textOf(hardMessages[0])).toContain(MEMORY_MURAL_BLOCK);
			const hardImage = findM0Image(hardMessages);
			expect(hardImage).toBeDefined();
			expect(hardImage?.mimeType).toBe("image/png");
			expect(hardImage?.data).toBe(FAKE_MURAL_BASE64);

			// Simulate restart after another session advances the project manifest.
			// The defer must reload this session's persisted frozen payload instead.
			const currentManifestBase64 = replaceCurrentManifest(db);
			__test.clearPiMuralProcessCache(SESSION_ID);
			const deferState = baseState();
			const deferMessages = [userMessage("again")];
			const second = injectM0M1Pi(
				deferState,
				db,
				deferMessages as never,
				undefined,
				false,
			);
			expect(second.m0Reason).toBeNull();
			expect(second.m0Materialized).toBe(false);
			expect(textOf(deferMessages[0])).toContain("<memory-mural>");
			const deferImage = findM0Image(deferMessages);
			expect(deferImage?.data).toBe(FAKE_MURAL_BASE64);
			expect(deferImage?.data).not.toBe(currentManifestBase64);
			expect(textOf(deferMessages[0])).toBe(textOf(hardMessages[0]));

			const refreshedMessages = [userMessage("natural hard")];
			const refreshed = injectM0M1Pi(
				baseState({
					mural: muralOption(
						`data:image/png;base64,${currentManifestBase64}`,
						"current-pi-manifest",
					),
					hardSignals: {
						systemHash: "sys-next",
						modelKey: "anthropic/claude-sonnet-4",
						cacheExpired: false,
						lastResponseTime: 0,
					},
				}),
				db,
				refreshedMessages as never,
				undefined,
				false,
			);
			expect(refreshed.m0Reason).toBe("system_hash");
			expect(refreshed.m0Materialized).toBe(true);
			expect(findM0Image(refreshedMessages)?.data).toBe(currentManifestBase64);
		} finally {
			closeQuietly(db);
		}
	});

	it("folds once when mural is disabled, removes the image, then defers byte-identically", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const firstMessages = [userMessage("enabled")];
			injectM0M1Pi(
				baseState({
					muralEnabled: true,
					mural: muralOption(),
					injectionBudgetTokens: 8_000,
					historyBudgetTokens: 60_000,
				}),
				db,
				firstMessages as never,
				undefined,
				true,
			);
			expect(findM0Image(firstMessages)?.data).toBe(FAKE_MURAL_BASE64);

			const disabledMessages = [userMessage("disabled")];
			const disabled = injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 8_000,
					historyBudgetTokens: 60_000,
				}),
				db,
				disabledMessages as never,
				undefined,
				false,
			);
			expect(disabled.m0Reason).toBe("render_config:mural(true→false)");
			expect(disabled.m0Materialized).toBe(true);
			expect(findM0Image(disabledMessages)).toBeNull();
			expect(textOf(disabledMessages[0])).not.toContain("<memory-mural>");
			expect(textOf(disabledMessages[0])).not.toContain(MEMORY_MURAL_GUIDANCE);

			const deferMessages = [userMessage("defer")];
			const defer = injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 8_000,
					historyBudgetTokens: 60_000,
				}),
				db,
				deferMessages as never,
				undefined,
				false,
			);
			expect(defer.m0Materialized).toBe(false);
			expect(textOf(deferMessages[0])).toBe(textOf(disabledMessages[0]));
			expect(findM0Image(deferMessages)).toBeNull();
		} finally {
			__test.clearPiMuralProcessCache(SESSION_ID);
			closeQuietly(db);
		}
	});

	it("folds once when memory or history render budgets change", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 1_000,
					historyBudgetTokens: 2_000,
				}),
				db,
				[userMessage("first")] as never,
				undefined,
				true,
			);
			const changed = injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 1_001,
					historyBudgetTokens: 2_000,
				}),
				db,
				[userMessage("changed")] as never,
				undefined,
				false,
			);
			expect(changed.m0Reason).toBe(
				"render_config:budget(m1000-h2000→m1001-h2000)",
			);
			expect(changed.m0Materialized).toBe(true);

			const unchanged = injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 1_001,
					historyBudgetTokens: 2_000,
				}),
				db,
				[userMessage("unchanged")] as never,
				undefined,
				false,
			);
			expect(unchanged.m0Materialized).toBe(false);
		} finally {
			__test.clearPiMuralProcessCache(SESSION_ID);
			closeQuietly(db);
		}
	});

	it("hydrates a sibling cached-row mural payload", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			injectM0M1Pi(
				baseState({ mural: muralOption() }),
				db,
				[userMessage("hard")] as never,
				undefined,
				true,
			);

			const siblingDataUrl = "data:image/png;base64,cGktc2libGluZy1tdXJhbA==";
			db.transaction(() => {
				patchSessionMeta(db, SESSION_ID, {
					cached_m0_mural_data_url: siblingDataUrl,
					cached_m0_mural_hash: "pi-sibling-hash",
				});
				db.prepare(
					"UPDATE session_meta SET cached_m0_materialized_at=cached_m0_materialized_at+1 WHERE session_id=?",
				).run(SESSION_ID);
			}).immediate();

			const messages = [userMessage("soft")];
			injectM0M1Pi(baseState(), db, messages as never, undefined, true);
			expect(findM0Image(messages)?.data).toBe(
				siblingDataUrl.slice("data:image/png;base64,".length),
			);
		} finally {
			__test.clearPiMuralProcessCache(SESSION_ID);
			closeQuietly(db);
		}
	});

	it("uses a text-only fallback when a legacy cached row lacks its image payload", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			injectM0M1Pi(
				baseState({ mural: muralOption() }),
				db,
				[userMessage("hard")] as never,
				undefined,
				true,
			);
			const currentManifestBase64 = replaceCurrentManifest(db);
			patchSessionMeta(db, SESSION_ID, {
				cached_m0_mural_data_url: null,
				cached_m0_mural_hash: null,
			});
			__test.clearPiMuralProcessCache(SESSION_ID);

			const messages = [userMessage("defer")];
			injectM0M1Pi(baseState(), db, messages as never, undefined, false);
			expect(findM0Image(messages)).toBeNull();
			expect(findM0Image(messages)?.data).not.toBe(currentManifestBase64);
			expect(textOf(messages[0])).not.toContain("<memory-mural>");
		} finally {
			__test.clearPiMuralProcessCache(SESSION_ID);
			closeQuietly(db);
		}
	});

	it("omits the mural when the feature flag is off", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const messages = [userMessage("hello")];
			const result = injectM0M1Pi(
				baseState({ muralEnabled: false }),
				db,
				messages as never,
				undefined,
				true,
			);
			expect(result.injected).toBe(true);
			expect(textOf(messages[0])).not.toContain("<memory-mural>");
			expect(findM0Image(messages)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("stays text-only when the model has no vision metadata (fail closed)", async () => {
		const tempDir = createTestTempDirFromPath(
			join(tmpdir(), "mc-pi-mural-novision-"),
		);
		const originalXdgData = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = tempDir;
		clearModelsDevCache();
		const db = createTestDb();
		try {
			// Seed a non-vision model so the gate has metadata but vision=false.
			await refreshModelLimitsFromApi({
				config: {
					providers: async () => ({
						data: {
							providers: [
								{
									id: "anthropic",
									models: {
										"claude-sonnet-4": {
											limit: { context: 200_000, input: 200_000 },
										},
									},
								},
							],
						},
					}),
				},
			});
			getOrCreateSessionMeta(db, `${SESSION_ID}_novision`);
			const messages = [userMessage("hello")];
			injectM0M1Pi(
				baseState({
					sessionId: `${SESSION_ID}_novision`,
					muralEnabled: true,
					hardSignals: {
						systemHash: "sys",
						modelKey: "anthropic/claude-sonnet-4",
						cacheExpired: false,
						lastResponseTime: 0,
					},
				}),
				db,
				messages as never,
				undefined,
				true,
			);
			expect(textOf(messages[0])).not.toContain("<memory-mural>");
			expect(findM0Image(messages)).toBeNull();
		} finally {
			if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = originalXdgData;
			clearModelsDevCache();
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
			closeQuietly(db);
		}
	});
});

describe("Pi mural pool capture", () => {
	// The HARD fold hands the mural the rows it read with the m[0] memories. A
	// memory written after that read must not reach the image (and so its cue
	// manifest) through a live re-read, or text and image would describe two states.
	it("resolves the mural from the fold's captured pool, not live rows", () => {
		const db = createTestDb();
		const spy = spyOn(renderTrigger, "resolveMuralWire");
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const frozen = insertMemory(db, {
				projectPath: "git:pi-mural",
				category: "ARCHITECTURE",
				content: "Read with the m[0] memories.",
			});
			let late = 0;
			let captured: MuralPool | undefined;
			spy.mockImplementation((...args: unknown[]) => {
				captured = args[6] as MuralPool | undefined;
				return { enabled: true, supportsVision: false };
			});
			injectM0M1Pi(
				baseState({
					muralEnabled: true,
					afterM0InputsReadForTest: () => {
						late = insertMemory(db, {
							projectPath: "git:pi-mural",
							category: "ARCHITECTURE",
							content: "Written after the frozen read.",
						}).id;
					},
				}),
				db,
				[userMessage("hello")] as never,
				undefined,
				true,
			);
			expect(late).toBeGreaterThan(0);
			expect(spy).toHaveBeenCalledTimes(1);
			expect(captured?.memories.map((memory) => memory.id)).toEqual([
				frozen.id,
			]);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});
});

describe("resolveMuralWire Pi provider-prefix translation", () => {
	let tempDir: string;
	let originalXdgData: string | undefined;

	beforeEach(() => {
		// Isolate the persisted models-dev cache so vision seeds never touch the
		// real ~/.local/share tree or leak across cases via cold-start reload.
		tempDir = createTestTempDirFromPath(join(tmpdir(), "mc-pi-mural-models-"));
		originalXdgData = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = tempDir;
		clearModelsDevCache();
	});
	afterEach(() => {
		if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = originalXdgData;
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		clearModelsDevCache();
	});

	it("accepts Pi-native openai-codex/… after translating to canonical openai/…", async () => {
		await refreshModelLimitsFromApi({
			config: {
				providers: async () => ({
					data: {
						providers: [
							{
								id: "openai",
								models: {
									"gpt-4o": {
										limit: { context: 128_000, input: 128_000 },
										// models-dev vision detection looks for modalities/input
										// containing "image" or a vision-ish name.
										modalities: { input: ["text", "image"] },
									},
								},
							},
						],
					},
				}),
			},
		});
		const db = createTestDb();
		try {
			// Empty cue pool → supportsVision true but no dataUrl. The important
			// assertion is that the Pi-native prefix is NOT rejected as unknown.
			const wire = resolveMuralWire(
				db,
				"git:pi-mural-prefix",
				"openai-codex/gpt-4o",
				true,
			);
			expect(wire.enabled).toBe(true);
			expect(wire.supportsVision).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("fails closed when models.dev metadata is absent", () => {
		clearModelsDevCache();
		const db = createTestDb();
		try {
			const wire = resolveMuralWire(
				db,
				"git:pi-mural-prefix",
				"openai-codex/gpt-4o",
				true,
			);
			expect(wire.supportsVision).toBe(false);
			expect(wire.dataUrl).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});
});
