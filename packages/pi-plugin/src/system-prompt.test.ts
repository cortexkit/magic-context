import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { insertUserMemory } from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import {
	createPromptSurfaceGuidanceEpochCache,
	createPromptSurfaceRuntime,
} from "@magic-context/core/shared/prompt-surface-runtime";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	createTestTempDir,
	type TestTempDirPrefix,
} from "@magic-context/core/shared/test-temp-dir";

import {
	buildMagicContextBlock,
	clearPiSystemPromptSession,
	composeMagicContextSystemPrompt,
	MAGIC_CONTEXT_GUIDANCE_MARKER,
	processSystemPromptForCache,
	SYSTEM_PROMPT_DATA_MARKERS,
} from "./system-prompt";
import { createTestDb } from "./test-utils.test";

function tempDir(prefix: TestTempDirPrefix): string {
	return createTestTempDir(prefix).dir;
}

describe("Pi system date through an idle expiry", () => {
	for (const expired of [false, true]) {
		it(`freezes the midnight date on an ${expired ? "expired" : "warm"} provider cache until a real rebuild moves it`, () => {
			const db = createTestDb();
			const sessionId = `ses-pi-idle-date-${expired}`;
			try {
				getOrCreateSessionMeta(db, sessionId);
				const first = processSystemPromptForCache({
					db,
					sessionId,
					systemPrompt: "Base\nToday's date: Fri Oct 02 2026",
					isCacheBusting: false,
				});
				updateSessionMeta(db, sessionId, {
					cacheTtl: "1h",
					lastResponseTime: Date.now() - (expired ? 16.5 * 3_600_000 : 1_000),
				});
				const next = processSystemPromptForCache({
					db,
					sessionId,
					systemPrompt: "Base\nToday's date: Sat Oct 03 2026",
					isCacheBusting: false,
				});
				// An expired cache only means the provider forgot it, so the date
				// stays frozen exactly as on a warm cache.
				expect(next.systemPrompt).toContain("Fri Oct 02 2026");
				expect(next.hashChanged).toBe(false);
				expect(next.currentHash).toBe(first.currentHash);
				// A pass that really rebuilds the prefix moves it.
				const rebuilt = processSystemPromptForCache({
					db,
					sessionId,
					systemPrompt: "Base\nToday's date: Sat Oct 03 2026",
					isCacheBusting: true,
				});
				expect(rebuilt.systemPrompt).toContain("Sat Oct 03 2026");
				expect(rebuilt.hashChanged).toBe(true);
			} finally {
				clearPiSystemPromptSession(sessionId);
				closeQuietly(db);
			}
		});
	}
});

describe("Pi single system-prompt serialization parity", () => {
	it("keeps host identity and Magic Context guidance in one OpenAI-compatible wire message", () => {
		const basePrompt = "You are a helpful coding assistant.";
		const guidance = "## Magic Context\nUse ctx_search when needed.";
		const composedPrompt = composeMagicContextSystemPrompt(
			basePrompt,
			guidance,
		);

		expect(composedPrompt).toBe(`${basePrompt}\n\n${guidance}`);
		const wireMessages = convertMessages(
			{
				provider: "test",
				reasoning: false,
				input: ["text"],
			} as unknown as Parameters<typeof convertMessages>[0],
			{ systemPrompt: composedPrompt, messages: [] } as Parameters<
				typeof convertMessages
			>[1],
			{ supportsDeveloperRole: false } as unknown as Parameters<
				typeof convertMessages
			>[2],
		);
		const systemMessages = wireMessages.filter(
			(message) => message.role === "system",
		);
		expect(systemMessages).toHaveLength(1);
		expect(systemMessages[0]?.content).toBe(composedPrompt);
	});
});

describe("buildMagicContextBlock v2 system-prompt parity", () => {
	it("keeps Magic Context guidance in the system prompt", () => {
		const db = createTestDb();
		try {
			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-guidance-"),
				sessionId: "ses-guidance",
				memoryEnabled: true,
				includeGuidance: true,
			});

			expect(block).not.toBeNull();
			expect(block).toContain(MAGIC_CONTEXT_GUIDANCE_MARKER);
			expect(block).toContain("ctx_search");
			expect(block).toContain("ctx_memory");
			expect(block).toContain("ctx_note");
		} finally {
			closeQuietly(db);
		}
	});

	it("removes ctx_memory guidance when memory is disabled", () => {
		const db = createTestDb();
		try {
			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-memory-off-guidance-"),
				sessionId: "ses-memory-off-guidance",
				memoryEnabled: false,
				includeGuidance: true,
			});

			expect(block).toContain("ctx_search");
			expect(block).not.toContain("ctx_memory");
			expect(block).not.toContain("Save to memory proactively");
		} finally {
			closeQuietly(db);
		}
	});

	it("does not render project-docs, user-profile, or key-files in the system prompt", () => {
		const db = createTestDb();
		const cwd = tempDir("pi-system-v2-");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "ARCHITECTURE.md"), "# Architecture", "utf8");
		try {
			insertUserMemory(db, "Stable profile should move to m[0]", []);

			const block = buildMagicContextBlock({
				db,
				cwd,
				sessionId: "ses-v2-system",
				memoryEnabled: true,
				includeGuidance: true,
				userMemoriesEnabled: true,
			});

			expect(block).not.toContain(SYSTEM_PROMPT_DATA_MARKERS.projectDocs);
			expect(block).not.toContain(SYSTEM_PROMPT_DATA_MARKERS.userProfile);
			expect(block).not.toContain("Stable profile should move to m[0]");
		} finally {
			closeQuietly(db);
		}
	});

	it("returns null when guidance is disabled because data blocks moved to m[0]/m[1]", () => {
		const db = createTestDb();
		const cwd = tempDir("pi-no-guidance-");
		writeFileSync(join(cwd, "STRUCTURE.md"), "# Structure", "utf8");
		try {
			insertUserMemory(db, "Profile", []);
			const block = buildMagicContextBlock({
				db,
				cwd,
				sessionId: "ses-no-guidance",
				memoryEnabled: true,
				includeGuidance: false,
				userMemoriesEnabled: true,
				pinKeyFilesEnabled: true,
			});

			expect(block).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("deduplicates guidance when the base prompt already contains it", () => {
		const db = createTestDb();
		try {
			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-guidance-dedup-"),
				sessionId: "ses-guidance-dedup",
				memoryEnabled: false,
				includeGuidance: true,
				existingSystemPrompt: "base\n## Magic Context\nalready present",
			});

			expect(block).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("emits no-reduce guidance variant when ctx_reduce is not callable", () => {
		const db = createTestDb();
		try {
			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-noreduce-"),
				sessionId: "ses-noreduce",
				memoryEnabled: false,
				includeGuidance: true,
				ctxReduceCallable: false,
			});

			expect(block).toContain(MAGIC_CONTEXT_GUIDANCE_MARKER);
			expect(block).not.toContain("ctx_reduce");
			expect(block).toContain("ctx_search");
		} finally {
			closeQuietly(db);
		}
	});

	it("includes language guidance only when configured", () => {
		const db = createTestDb();
		try {
			const baseline = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-language-baseline-"),
				sessionId: "ses-language-baseline",
				memoryEnabled: true,
				includeGuidance: true,
			});
			const unset = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-language-unset-"),
				sessionId: "ses-language-unset",
				memoryEnabled: true,
				includeGuidance: true,
				language: " ",
			});
			const localized = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-language-set-"),
				sessionId: "ses-language-set",
				memoryEnabled: true,
				includeGuidance: true,
				language: "es",
			});

			expect(unset).toBe(baseline);
			expect(localized).toContain(
				"Use Spanish (Español) for your natural-language replies",
			);
		} finally {
			closeQuietly(db);
		}
	});
});

function readA1PrimaryGuidance(): { guidance: string; hash: string } {
	const document = readFileSync(
		join(
			import.meta.dir,
			"../../plugin/src/shared/prompt-surface-a1-golden.md",
		),
		"utf8",
	);
	const guidance = document.match(
		/### PRIMARY full \(reduce=on, memory=on, dreamer=on, temporal=on\)[\s\S]*?```markdown\n([\s\S]*?)\n```/,
	)?.[1];
	const hash = document.match(
		/\| PRIMARY full \| \d+ \| `([0-9a-f]{32})` \|/,
	)?.[1];
	if (!guidance || !hash)
		throw new Error("Malformed A1 primary guidance golden");
	return { guidance, hash };
}

describe("Pi prompt-surface guidance epochs", () => {
	it("matches the A1 guidance and hash for no config and explicit full", () => {
		const db = createTestDb();
		try {
			const golden = readA1PrimaryGuidance();
			const common = {
				db,
				cwd: tempDir("pi-a1-guidance-"),
				sessionId: "ses-a1-guidance",
				memoryEnabled: true,
				includeGuidance: true,
				protectedTags: 20,
				ctxReduceCallable: true,
				dreamerEnabled: true,
				temporalAwarenessEnabled: true,
				cavemanTextCompressionEnabled: false,
			};
			const implicit = buildMagicContextBlock(common);
			const explicit = buildMagicContextBlock({
				...common,
				promptSurfacePreset: "full",
			});

			expect(implicit).toBe(golden.guidance);
			expect(explicit).toBe(golden.guidance);
			expect(
				createHash("md5")
					.update(implicit ?? "")
					.digest("hex"),
			).toBe(golden.hash);
		} finally {
			closeQuietly(db);
		}
	});

	it("folds once when a preset/model epoch selects authored light", () => {
		const db = createTestDb();
		const directory = tempDir("pi-prompt-epoch-");
		const sessionId = "ses-prompt-surface-epoch";
		const warnings: string[] = [];
		const runtime = createPromptSurfaceRuntime({
			userConfigDirectory: directory,
			warn: (warning) => warnings.push(warning),
		});
		const epochs = createPromptSurfaceGuidanceEpochCache(runtime);
		const config = {
			default: "full" as const,
			models: { "provider/light": "light" as const },
		};
		const render = (selection: ReturnType<typeof epochs.resolve>) =>
			buildMagicContextBlock({
				db,
				cwd: directory,
				sessionId,
				memoryEnabled: true,
				promptSurfacePreset: selection.preset,
				primaryGuidanceOverride: selection.primaryOverride,
			}) ?? "";

		try {
			const firstSelection = epochs.resolve(sessionId, config, "provider/full");
			const firstPrompt = render(firstSelection);
			const first = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: firstPrompt,
				isCacheBusting: false,
				promptSurfacePreset: firstSelection.preset,
			});
			expect(first.hashChanged).toBe(false);

			for (let pass = 0; pass < 5; pass++) {
				const frozenSelection = epochs.resolve(
					sessionId,
					config,
					"provider/full",
				);
				expect(frozenSelection.primaryOverride).toBeUndefined();
				const frozen = processSystemPromptForCache({
					db,
					sessionId,
					systemPrompt: render(frozenSelection),
					isCacheBusting: false,
					promptSurfacePreset: frozenSelection.preset,
				});
				expect(frozen.hashChanged).toBe(false);
				expect(frozen.currentHash).toBe(first.currentHash);
			}

			const changedSelection = epochs.resolve(
				sessionId,
				config,
				"provider/light",
			);
			expect(changedSelection.preset).toBe("light");
			expect(changedSelection.primaryOverride).toBeUndefined();
			expect(render(changedSelection)).not.toBe(firstPrompt);
			const changed = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: render(changedSelection),
				isCacheBusting: false,
				promptSurfacePreset: changedSelection.preset,
			});
			expect(changed.hashChanged).toBe(true);
			expect(changed.currentHash).not.toBe(first.currentHash);

			expect(warnings).toEqual([]);

			for (let pass = 0; pass < 5; pass++) {
				const stableSelection = epochs.resolve(
					sessionId,
					config,
					"provider/light",
				);
				const stable = processSystemPromptForCache({
					db,
					sessionId,
					systemPrompt: render(stableSelection),
					isCacheBusting: false,
					promptSurfacePreset: stableSelection.preset,
				});
				expect(stable.hashChanged).toBe(false);
				expect(stable.currentHash).toBe(changed.currentHash);
			}
		} finally {
			clearPiSystemPromptSession(sessionId);
			closeQuietly(db);
		}
	});

	it("coalesces a midnight date and preset flip into one hash change", () => {
		const db = createTestDb();
		const sessionId = "ses-midnight-preset";
		try {
			const first = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "Base prompt\nToday's date: Mon Jan 01 2024",
				isCacheBusting: false,
				promptSurfacePreset: "full",
			});
			expect(first.hashChanged).toBe(false);

			const changed = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "Base prompt\nToday's date: Tue Jan 02 2024",
				isCacheBusting: false,
				promptSurfacePreset: "light",
			});
			expect(changed.hashChanged).toBe(true);
			expect(changed.currentHash).not.toBe(first.currentHash);
			expect(changed.systemPrompt).toContain("Today's date: Tue Jan 02 2024");

			const stable = processSystemPromptForCache({
				db,
				sessionId,
				systemPrompt: "Base prompt\nToday's date: Tue Jan 02 2024",
				isCacheBusting: false,
				promptSurfacePreset: "light",
			});
			expect(stable.hashChanged).toBe(false);
			expect(stable.currentHash).toBe(changed.currentHash);
		} finally {
			clearPiSystemPromptSession(sessionId);
			closeQuietly(db);
		}
	});
});
