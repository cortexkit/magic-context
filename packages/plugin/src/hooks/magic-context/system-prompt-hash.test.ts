/// <reference types="bun-types" />

/**
 * Regression suite for `createSystemPromptHashHandler`'s drain semantics.
 *
 * Oracle review 2026-04-26 Finding A1 caught a real bug: the handler's
 * unconditional drain of `systemPromptRefreshSessions` at the end of the
 * handler was silently dropping the flag added by hash-change detection
 * earlier in the same handler call. That meant a real prompt-content
 * change set the flag, then immediately discarded it before any future
 * pass could observe it — adjuncts (project docs, user profile, key
 * files) stayed stale forever.
 *
 * The fix made the drain conditional on the value of `isCacheBusting`
 * captured at the top of the handler. These tests lock that contract in.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { convertToOpenAICompatibleChatMessages } from "@ai-sdk/openai-compatible/internal";
import { buildHiddenAgentRegistrations } from "../../agents/hidden-agent-registrations";
import { CLASSIFY_SYSTEM_PROMPT } from "../../features/magic-context/dreamer/classify-prompt";
import { MAP_MEMORIES_SYSTEM_PROMPT } from "../../features/magic-context/dreamer/map-memories-prompt";
import {
    CURATE_SYSTEM_PROMPT,
    DREAMER_SYSTEM_PROMPT,
    MAINTAIN_DOCS_SYSTEM_PROMPT,
    PRIMER_INVESTIGATOR_SYSTEM_PROMPT,
    REVIEW_USER_MEMORIES_SYSTEM_PROMPT,
} from "../../features/magic-context/dreamer/task-prompts";
import { VERIFY_SYSTEM_PROMPT } from "../../features/magic-context/dreamer/verify-prompt";
import { MIGRATION_SYSTEM_PROMPT } from "../../features/magic-context/memory/memory-migration";
import { SIDEKICK_SYSTEM_PROMPT } from "../../features/magic-context/sidekick/agent";
import { SMART_NOTE_COMPILER_SYSTEM_PROMPT } from "../../features/magic-context/smart-notes/compiler-prompt";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import { createPromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import {
    COMPARTMENT_AGENT_SYSTEM_PROMPT,
    COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
    HISTORIAN_EDITOR_SYSTEM_PROMPT,
} from "./compartment-prompt";
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "./ctx-reduce-availability";
import { createSystemPromptHashHandler, isMagicContextInternalAgent } from "./system-prompt-hash";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
});

async function captureAnthropicSystem(system: string[]): Promise<unknown> {
    const capturedBodies: Array<{ system?: unknown }> = [];
    const model = createAnthropic({
        apiKey: "test-key",
        fetch: async (_input, init) => {
            capturedBodies.push(JSON.parse(String(init?.body)) as { system?: unknown });
            throw new Error("request captured");
        },
    }).messages("claude-sonnet-4-20250514");

    await model
        .doGenerate({
            prompt: [
                ...system.map((content) => ({ role: "system" as const, content })),
                {
                    role: "user" as const,
                    content: [{ type: "text" as const, text: "Hello" }],
                },
            ],
            maxOutputTokens: 1,
        })
        .catch(() => undefined);

    expect(capturedBodies).toHaveLength(1);
    return capturedBodies[0]?.system;
}

function buildHandler(opts?: {
    historyRefreshSessions?: Set<string>;
    systemPromptRefreshSessions?: Set<string>;
    pendingMaterializationSessions?: Set<string>;
    injectionEnabled?: boolean;
    injectionSkipSignatures?: string[];
    dreamerEnabled?: boolean;
    experimentalUserMemories?: boolean;
    internalChildSessions?: Set<string>;
    experimentalCavemanTextCompression?: boolean;
    experimentalTemporalAwareness?: boolean;
    language?: string;
    protectedTags?: number;
    promptSurface?: PromptSurfaceConfig;
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    resolveModel?: (sessionId: string) => { providerID: string; modelID: string } | undefined;
}): ReturnType<typeof createSystemPromptHashHandler> {
    return createSystemPromptHashHandler({
        db: openDatabase(),
        protectedTags: opts?.protectedTags ?? 1,
        language: opts?.language,
        dreamerEnabled: opts?.dreamerEnabled ?? false,
        promptSurface: opts?.promptSurface,
        promptSurfaceRuntime: opts?.promptSurfaceRuntime,
        resolveModel:
            opts?.resolveModel ?? (() => ({ providerID: "provider", modelID: "default-model" })),
        historyRefreshSessions: opts?.historyRefreshSessions ?? new Set<string>(),
        systemPromptRefreshSessions: opts?.systemPromptRefreshSessions ?? new Set<string>(),
        pendingMaterializationSessions: opts?.pendingMaterializationSessions ?? new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        injectionEnabled: opts?.injectionEnabled,
        injectionSkipSignatures: opts?.injectionSkipSignatures,
        experimentalUserMemories: opts?.experimentalUserMemories,
        internalChildSessions: opts?.internalChildSessions,
        experimentalCavemanTextCompression: opts?.experimentalCavemanTextCompression,
        experimentalTemporalAwareness: opts?.experimentalTemporalAwareness,
    });
}

describe("system-prompt-hash drain semantics (Oracle review 2026-04-26 Finding A1)", () => {
    it("drains pre-existing systemPromptRefresh flag set by /ctx-flush", async () => {
        useTempDataHome("sph-drain-existing-");
        const sessionId = "ses-existing-flag";
        const systemPromptRefreshSessions = new Set<string>([sessionId]);

        const { handler } = buildHandler({ systemPromptRefreshSessions });

        // Seed a prior hash so this looks like an existing session, no
        // hash change on this pass.
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, {
            systemPromptHash: "deadbeef",
            systemPromptTokens: 100,
        });

        await handler({ sessionID: sessionId }, { system: ["You are a helpful agent."] });

        // Flag was set on entry → handler consumed it → drain.
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(false);
    });

    it("does NOT drain just-added flag from hash-change detection (the bug Oracle caught)", async () => {
        useTempDataHome("sph-drain-just-added-");
        const sessionId = "ses-hash-change";
        const systemPromptRefreshSessions = new Set<string>(); // empty on entry
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();

        const { handler } = buildHandler({
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
        });

        // Seed a prior hash that will mismatch the prompt below.
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, {
            systemPromptHash: "stalehash",
            systemPromptTokens: 100,
        });

        await handler(
            { sessionID: sessionId },
            { system: ["You are a helpful agent.", "New system content here"] },
        );

        // Hash detection added all three signals.
        expect(historyRefreshSessions.has(sessionId)).toBe(true);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(true);

        // CRITICAL: systemPromptRefreshSessions was added by hash-change
        // detection AFTER `isCacheBusting` was captured at the top of
        // the handler. The drain at the end is conditional on that
        // captured value (false in this case), so the just-added flag
        // must SURVIVE for the next pass to consume.
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(true);
    });

    it("does NOT drain if handler short-circuits before the drain (early return)", async () => {
        useTempDataHome("sph-drain-early-return-");
        const sessionId = "ses-empty-prompt";
        const systemPromptRefreshSessions = new Set<string>([sessionId]);

        const { handler } = buildHandler({ systemPromptRefreshSessions });

        // Empty system prompt triggers early return at line 375.
        await handler({ sessionID: sessionId }, { system: [] });

        // The handler returned early before reaching the drain. With the
        // OLD unconditional drain, the flag would have been dropped
        // anyway because the early return is BEFORE the drain. With the
        // current code structure, the drain still only fires after Step
        // 3 — so this test documents that early returns preserve the
        // flag for a future valid pass to consume.
        //
        // Note: this is a low-severity Oracle finding D — the main fix
        // was for Finding A1, but the conditional drain also makes
        // early-return paths safer by default.
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(true);
    });

    it("on subsequent pass after hash-change pass, drains the surviving flag", async () => {
        useTempDataHome("sph-drain-followup-");
        const sessionId = "ses-followup";
        const systemPromptRefreshSessions = new Set<string>();
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();

        const { handler } = buildHandler({
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
        });

        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, {
            systemPromptHash: "stalehash",
            systemPromptTokens: 100,
        });

        // Pass 1: hash mismatch → flag added but survives.
        await handler({ sessionID: sessionId }, { system: ["New prompt content"] });
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(true);

        // Pass 2: same prompt content (hash now matches stored value
        // from Pass 1). Flag was set on entry → handler reads adjuncts
        // with isCacheBusting=true → drain.
        await handler({ sessionID: sessionId }, { system: ["New prompt content"] });
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(false);
    });
});

describe("system-prompt-hash token estimation (council audit bg_51106601 #2)", () => {
    it("does not refresh systemPromptTokens when the system prompt hash is unchanged", async () => {
        useTempDataHome("sph-unchanged-token-skip-");
        const sessionId = "ses-unchanged-token-skip";
        const { handler } = buildHandler();
        const db = openDatabase();

        const firstPassSystem = ["You are a helpful coding assistant."];
        await handler({ sessionID: sessionId }, { system: firstPassSystem });

        const initializedMeta = getOrCreateSessionMeta(db, sessionId);
        expect(initializedMeta.systemPromptHash).toBe(
            createHash("md5").update(firstPassSystem.join("\n")).digest("hex"),
        );
        expect(initializedMeta.systemPromptTokens).toBeGreaterThan(50);

        updateSessionMeta(db, sessionId, { systemPromptTokens: 1 });

        const secondPassSystem = ["You are a helpful coding assistant."];
        await handler({ sessionID: sessionId }, { system: secondPassSystem });

        const unchangedMeta = getOrCreateSessionMeta(db, sessionId);
        expect(unchangedMeta.systemPromptHash).toBe(initializedMeta.systemPromptHash);
        expect(unchangedMeta.systemPromptTokens).toBe(1);
    });
});

describe("system-prompt-hash fail-open (per-turn handler must never throw)", () => {
    it("resolves and preserves the mutated prompt when the meta write fails", async () => {
        useTempDataHome("sph-fail-open-");
        const sessionId = "ses-fail-open";
        const { handler } = buildHandler();
        const db = openDatabase();

        // Pass 1 primes session_meta (hash + tokens) cleanly.
        await handler({ sessionID: sessionId }, { system: ["You are a helpful agent."] });

        // Now sabotage the persistence layer so the hash-change branch's
        // updateSessionMeta throws on pass 2. Dropping the table makes any write
        // raise — simulating a busy/failing DB. The handler must NOT propagate it.
        db.exec("DROP TABLE session_meta");

        const system = ["You are a helpful agent.", "DIFFERENT content forces a hash change"];
        // Must not throw — a throw here would fail the LLM call instead of just
        // losing a telemetry write.
        await handler({ sessionID: sessionId }, { system });

        // The prompt was still mutated/injected (guidance present) — failing open
        // means we keep what we did, not crash.
        expect(system.join("\n")).toContain("## Magic Context");
    });
});

describe("system-prompt-hash v2 system prompt contents", () => {
    it("keeps project docs, user profile, and key files out of the system prompt", async () => {
        useTempDataHome("sph-v2-adjuncts-out-");
        const directory = mkdtempSync(join(tmpdir(), "sph-docs-project-"));
        tempDirs.push(directory);
        writeFileSync(join(directory, "ARCHITECTURE.md"), "Alpha <closing-tag> & beta", "utf-8");
        const sessionId = "ses-v2-adjuncts-out";
        const { handler } = buildHandler({
            dreamerEnabled: true,
            experimentalUserMemories: true,
        });

        const system = ["You are a helpful coding assistant. Today's date: 2026-05-28"];
        await handler({ sessionID: sessionId }, { system });
        const joined = system.join("\n");

        expect(system).toHaveLength(1);
        expect(joined).toContain("## Magic Context");
        expect(joined).toContain("Today's date: 2026-05-28");
        expect(joined).not.toContain("<project-docs>");
        expect(joined).not.toContain("<user-profile>");
        expect(joined).not.toContain("<key-files>");
        expect(joined).not.toContain("Alpha &lt;closing-tag&gt;");
    });

    it("injects language guidance and stabilizes after the config changes once", async () => {
        useTempDataHome("sph-language-fold-once-");
        const sessionId = "ses-language-fold";
        const systemPromptRefreshSessions = new Set<string>();
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const db = openDatabase();

        const withoutLanguage = buildHandler({
            systemPromptRefreshSessions,
            historyRefreshSessions,
            pendingMaterializationSessions,
        });
        await withoutLanguage.handler({ sessionID: sessionId }, { system: ["You are helpful."] });
        historyRefreshSessions.clear();
        pendingMaterializationSessions.clear();
        systemPromptRefreshSessions.clear();

        const withLanguage = buildHandler({
            systemPromptRefreshSessions,
            historyRefreshSessions,
            pendingMaterializationSessions,
            language: "tr",
        });
        const changed = ["You are helpful."];
        await withLanguage.handler({ sessionID: sessionId }, { system: changed });
        expect(changed.join("\n")).toContain(
            "Use Turkish (Türkçe) for your natural-language replies",
        );
        expect(historyRefreshSessions.has(sessionId)).toBe(true);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(true);

        historyRefreshSessions.clear();
        pendingMaterializationSessions.clear();
        systemPromptRefreshSessions.clear();
        const stable = ["You are helpful."];
        await withLanguage.handler({ sessionID: sessionId }, { system: stable });
        expect(stable.join("\n")).toContain(
            "Use Turkish (Türkçe) for your natural-language replies",
        );
        expect(historyRefreshSessions.has(sessionId)).toBe(false);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
        expect(getOrCreateSessionMeta(db, sessionId).systemPromptHash).not.toBe("");
    });
});

describe("single system-entry serialization (issue #311)", () => {
    it("produces one system message through the real OpenAI-compatible converter", async () => {
        useTempDataHome("sph-openai-single-system-");
        const sessionId = "ses-openai-single-system";
        const system = ["You are a helpful coding assistant."];
        const { handler } = buildHandler();

        await handler({ sessionID: sessionId }, { system });

        expect(system).toHaveLength(1);
        expect(system[0]).toContain("## Magic Context");
        const wireMessages = convertToOpenAICompatibleChatMessages([
            { role: "system", content: system[0] },
            {
                role: "user",
                content: [{ type: "text", text: "Hello" }],
            },
        ]);
        const wireSystemMessages = wireMessages.filter((message) => message.role === "system");
        expect(wireSystemMessages).toHaveLength(1);
        expect(wireSystemMessages[0]?.content).toBe(system[0]);
    });

    it("documents Anthropic's unavoidable two-block to one-block byte transition", async () => {
        useTempDataHome("sph-anthropic-blocks-");
        const sessionId = "ses-anthropic-blocks";
        const hostPrompt = "You are a helpful coding assistant.";
        const system = [hostPrompt];
        const { handler } = buildHandler();

        await handler({ sessionID: sessionId }, { system });

        expect(system).toHaveLength(1);
        const prefix = `${hostPrompt}\n\n`;
        expect(system[0]).toStartWith(prefix);
        const guidance = system[0].slice(prefix.length);
        expect(guidance).toContain("## Magic Context");

        const previousWireSystem = await captureAnthropicSystem([hostPrompt, guidance]);
        const mergedWireSystem = await captureAnthropicSystem(system);
        expect(previousWireSystem).toEqual([
            { type: "text", text: hostPrompt },
            { type: "text", text: guidance },
        ]);
        expect(mergedWireSystem).toEqual([{ type: "text", text: system[0] }]);
        expect(JSON.stringify(mergedWireSystem)).not.toBe(JSON.stringify(previousWireSystem));
    });

    it("changes the persisted hash once so the existing HARD-fold signals coordinate migration", async () => {
        useTempDataHome("sph-single-system-fold-");
        const referenceSessionId = "ses-single-system-reference";
        const sessionId = "ses-single-system-fold";
        const hostPrompt = "You are a helpful coding assistant.";
        const historyRefreshSessions = new Set<string>();
        const systemPromptRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const { handler } = buildHandler({
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
        });
        resolveCtxReduceAvailabilityFromMessages(referenceSessionId, [
            { info: { role: "user", tools: { "*": true } } },
        ]);
        resolveCtxReduceAvailabilityFromMessages(sessionId, [
            { info: { role: "user", tools: { "*": true } } },
        ]);

        const referenceSystem = [hostPrompt];
        await handler(
            {
                sessionID: referenceSessionId,
                model: { providerID: "provider", modelID: "model" },
            },
            { system: referenceSystem },
        );
        const guidance = referenceSystem[0].slice(`${hostPrompt}\n\n`.length);
        expect(guidance).toContain("## Magic Context");
        const previousTwoEntryHash = createHash("md5")
            .update(`${hostPrompt}\n${guidance}`)
            .digest("hex");
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, {
            systemPromptHash: previousTwoEntryHash,
            cachedM0SystemHash: previousTwoEntryHash,
        });

        const migratedSystem = [hostPrompt];
        await handler(
            { sessionID: sessionId, model: { providerID: "provider", modelID: "model" } },
            { system: migratedSystem },
        );

        expect(migratedSystem).toHaveLength(1);
        const migratedHash = createHash("md5").update(migratedSystem[0]).digest("hex");
        const migratedMeta = getOrCreateSessionMeta(db, sessionId);
        expect(migratedHash).not.toBe(previousTwoEntryHash);
        expect(migratedMeta.systemPromptHash).toBe(migratedHash);
        expect(migratedMeta.cachedM0SystemHash).toBe(previousTwoEntryHash);
        expect(historyRefreshSessions.has(sessionId)).toBe(true);
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(true);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(true);

        historyRefreshSessions.clear();
        systemPromptRefreshSessions.clear();
        pendingMaterializationSessions.clear();
        const stableSystem = [hostPrompt];
        await handler(
            { sessionID: sessionId, model: { providerID: "provider", modelID: "model" } },
            { system: stableSystem },
        );
        expect(stableSystem).toEqual(migratedSystem);
        expect(getOrCreateSessionMeta(db, sessionId).systemPromptHash).toBe(migratedHash);
        expect(historyRefreshSessions.has(sessionId)).toBe(false);
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(false);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
    });
});

/**
 * Issue #52 regression: Magic Context guidance was being injected into the
 * system prompt for OpenCode's three native hidden agents (title, summary,
 * compaction). These agents run on small/cheap models with a fixed single-
 * shot job — they don't benefit from any of our injection (no tools, no
 * `ctx_reduce`, no nudges) and pay for the extra prompt content in cost.
 */
describe("system-prompt-hash skips OpenCode internal hidden agents (issue #52)", () => {
    const TITLE_PROMPT_HEAD =
        "You are a title generator. You output ONLY a thread title. Nothing else.";
    const SUMMARY_PROMPT_HEAD =
        "Summarize what was done in this conversation. Write like a pull request description.";
    const COMPACTION_PROMPT_HEAD =
        "You are an anchored context summarization assistant for coding sessions.";

    it("skips ALL injection for the title agent (signature from title.txt)", async () => {
        useTempDataHome("sph-skip-title-");
        const sessionId = "ses-title";
        const { handler } = buildHandler();

        const system = [TITLE_PROMPT_HEAD];
        await handler({ sessionID: sessionId }, { system });

        // Nothing appended: no `## Magic Context`, no `<project-docs>`,
        // no `<user-profile>`, no `<key-files>`. The system array stays
        // exactly as OpenCode passed it in.
        expect(system).toHaveLength(1);
        expect(system[0]).toBe(TITLE_PROMPT_HEAD);
        expect(system.join("\n")).not.toContain("## Magic Context");
    });

    it("skips ALL injection for the summary agent", async () => {
        useTempDataHome("sph-skip-summary-");
        const sessionId = "ses-summary";
        const { handler } = buildHandler();

        const system = [SUMMARY_PROMPT_HEAD];
        await handler({ sessionID: sessionId }, { system });

        expect(system).toHaveLength(1);
        expect(system[0]).toBe(SUMMARY_PROMPT_HEAD);
    });

    it("skips ALL injection for the compaction agent", async () => {
        useTempDataHome("sph-skip-compaction-");
        const sessionId = "ses-compaction";
        const { handler } = buildHandler();

        const system = [COMPACTION_PROMPT_HEAD];
        await handler({ sessionID: sessionId }, { system });

        expect(system).toHaveLength(1);
        expect(system[0]).toBe(COMPACTION_PROMPT_HEAD);
    });

    it("does NOT update systemPromptHash for internal-agent calls", async () => {
        // Title-gen runs once on the first user turn with a totally
        // different system prompt than the main agent. If we updated the
        // hash here, every subsequent main-agent turn would see a
        // "hash changed" flush and burn cache for nothing.
        useTempDataHome("sph-skip-no-hash-update-");
        const sessionId = "ses-no-hash-update";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { systemPromptHash: "main-agent-hash-abc123" });

        const { handler } = buildHandler();
        await handler({ sessionID: sessionId }, { system: [TITLE_PROMPT_HEAD] });

        const meta = getOrCreateSessionMeta(db, sessionId);
        expect(meta.systemPromptHash).toBe("main-agent-hash-abc123");
    });

    it("still injects guidance for normal agents whose prompts don't match signatures", async () => {
        useTempDataHome("sph-still-injects-");
        const sessionId = "ses-normal";
        const { handler } = buildHandler();

        const system = ["You are a helpful coding assistant."];
        await handler({ sessionID: sessionId }, { system });

        // The normal-agent path keeps host identity and guidance in one entry.
        expect(system).toHaveLength(1);
        expect(system[0]).toContain("## Magic Context");
        expect(system[0]).toContain("You are a helpful coding assistant.");
    });
});

/**
 * Magic Context's OWN hidden children (historian/dreamer/sidekick/migration)
 * must not get the guidance block — wasted spend + a contradictory second
 * identity frame. Detected by prompt signature (pass-1, timing-independent)
 * AND the title-prefix `internalChildSessions` flag.
 */
describe("system-prompt-hash skips Magic Context internal child agents", () => {
    const HISTORIAN_HEAD =
        "You are Historian — the hippocampus of a long-running coding agent. You and the primary agent are one mind.";
    const SIDEKICK_HEAD =
        "You are Sidekick, a focused memory-retrieval subagent for an AI coding assistant.";
    // Every dreamer task prompt shares "for the magic-context system"; each opener
    // below must be detected so the guidance block is never injected into a dreamer
    // child even in the title-flag race window.
    const DREAMER_BASE_HEAD =
        "You are a background maintenance agent for the magic-context system,";
    const CURATE_HEAD = "You are a memory-pool curator for the magic-context system.";
    const MAINTAIN_DOCS_HEAD = "You are a documentation maintainer for the magic-context system.";
    const REVIEW_USER_HEAD = "You are a user-profile reviewer for the magic-context system.";
    const PRIMER_HEAD = "You are a read-only code investigator for the magic-context system.";

    for (const [label, head] of [
        ["historian", HISTORIAN_HEAD],
        ["dreamer-base", DREAMER_BASE_HEAD],
        ["curate", CURATE_HEAD],
        ["maintain-docs", MAINTAIN_DOCS_HEAD],
        ["review-user-memories", REVIEW_USER_HEAD],
        ["primer-investigator", PRIMER_HEAD],
        ["sidekick", SIDEKICK_HEAD],
    ] as const) {
        it(`skips ALL injection for the ${label} agent (prompt signature)`, async () => {
            useTempDataHome(`sph-skip-mc-${label}-`);
            const { handler } = buildHandler();
            const system = [head];
            await handler({ sessionID: `ses-mc-${label}` }, { system });
            expect(system).toHaveLength(1);
            expect(system[0]).toBe(head);
            expect(system.join("\n")).not.toContain("## Magic Context");
        });
    }

    it("detects every registered hidden-agent prompt", () => {
        const registrations = buildHiddenAgentRegistrations({
            dreamerPrompt: DREAMER_SYSTEM_PROMPT,
            smartNoteCompilerPrompt: SMART_NOTE_COMPILER_SYSTEM_PROMPT,
            historianPrompt: COMPARTMENT_AGENT_SYSTEM_PROMPT,
            historianRecompPrompt: COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT,
            historianEditorPrompt: HISTORIAN_EDITOR_SYSTEM_PROMPT,
            sidekickPrompt: SIDEKICK_SYSTEM_PROMPT,
            historianDisallowed: [],
        });

        for (const registration of registrations) {
            expect(registration.prompt, registration.id).toBeString();
            expect(
                isMagicContextInternalAgent(registration.prompt as string),
                registration.id,
            ).toBe(true);
        }
    });

    it("detects every dedicated Magic Context child prompt constant", () => {
        const prompts = [
            ["dreamer-base", DREAMER_SYSTEM_PROMPT],
            ["curate", CURATE_SYSTEM_PROMPT],
            ["maintain-docs", MAINTAIN_DOCS_SYSTEM_PROMPT],
            ["review-user-memories", REVIEW_USER_MEMORIES_SYSTEM_PROMPT],
            ["primer-investigator", PRIMER_INVESTIGATOR_SYSTEM_PROMPT],
            ["map-memories", MAP_MEMORIES_SYSTEM_PROMPT],
            ["verify", VERIFY_SYSTEM_PROMPT],
            ["classify", CLASSIFY_SYSTEM_PROMPT],
            ["smart-note-compiler", SMART_NOTE_COMPILER_SYSTEM_PROMPT],
            ["historian", COMPARTMENT_AGENT_SYSTEM_PROMPT],
            ["historian-recomp", COMPARTMENT_STRUCTURAL_SYSTEM_PROMPT],
            ["historian-editor", HISTORIAN_EDITOR_SYSTEM_PROMPT],
            ["memory-migration", MIGRATION_SYSTEM_PROMPT],
            ["sidekick", SIDEKICK_SYSTEM_PROMPT],
        ] as const;

        for (const [label, prompt] of prompts) {
            expect(isMagicContextInternalAgent(prompt), label).toBe(true);
        }
    });

    it("skips injection via the internalChildSessions flag even when the prompt has no known signature", async () => {
        // Covers the title-prefix detection path: a child whose prompt opener
        // we don't signature-match (e.g. a future MC agent) is still exempt
        // because session.created flagged it by `magic-context-` title.
        useTempDataHome("sph-skip-mc-flag-");
        const sessionId = "ses-mc-flagged";
        const { handler } = buildHandler({
            internalChildSessions: new Set<string>([sessionId]),
        });
        const system = ["Some custom internal prompt with no known opener."];
        await handler({ sessionID: sessionId }, { system });
        expect(system).toHaveLength(1);
        expect(system.join("\n")).not.toContain("## Magic Context");
    });

    it("does NOT update systemPromptHash for internal MC child calls", async () => {
        useTempDataHome("sph-skip-mc-no-hash-");
        const sessionId = "ses-mc-no-hash";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { systemPromptHash: "main-agent-hash-xyz" });
        const { handler } = buildHandler();
        await handler({ sessionID: sessionId }, { system: [HISTORIAN_HEAD] });
        expect(getOrCreateSessionMeta(db, sessionId).systemPromptHash).toBe("main-agent-hash-xyz");
    });
});

/**
 * Unit B: subagent self-management. A subagent session (isSubagent=true) with
 * ctx_reduce enabled gets the MINIMAL §N§ + ctx_reduce block — not the full
 * primary block, not the no-reduce block. Internal MC children still skip
 * entirely (order invariant: the internal-child skip runs BEFORE the subagent
 * branch).
 */
describe("system-prompt-hash subagent self-management (Unit B)", () => {
    it("injects the MINIMAL block for a subagent with ctx_reduce enabled", async () => {
        useTempDataHome("sph-subagent-min-");
        const sessionId = "ses-subagent";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { isSubagent: true });

        const { handler } = buildHandler();
        const system = ["You are a general-purpose coding subagent."];
        await handler({ sessionID: sessionId }, { system });

        const joined = system.join("\n");
        // Minimal block: marker + §N§ + ctx_reduce mechanics …
        expect(joined).toContain("## Magic Context");
        expect(joined).toContain("§N§ identifiers");
        expect(joined).toContain("ctx_reduce");
        // … but NONE of the primary's role/guidance.
        expect(joined).not.toContain("long-term partner");
        expect(joined).not.toContain("### Reduction Triggers");
        expect(joined).not.toContain("ctx_memory");
        expect(joined).not.toContain("ctx_search");
    });

    it("injects NO block for a subagent without callable ctx_reduce (no primary-role leak)", async () => {
        useTempDataHome("sph-subagent-denied-");
        const sessionId = "ses-subagent-denied";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { isSubagent: true });

        // Tool allow-list denies ctx_reduce: the subagent has no §N§ and no tool
        // to act on, so it must get NO Magic Context block — not the no-reduce
        // PRIMARY block (which would leak the partner frame + memory/search/note
        // guidance).
        clearCtxReduceAvailability(sessionId);
        resolveCtxReduceAvailabilityFromMessages(sessionId, [
            { info: { role: "user", tools: { "*": false, read: true } } },
        ]);
        const { handler } = buildHandler();
        const system = ["You are a general-purpose coding subagent."];
        await handler({ sessionID: sessionId }, { system });

        const joined = system.join("\n");
        expect(joined).not.toContain("## Magic Context");
        expect(joined).not.toContain("long-term partner");
        expect(joined).not.toContain("ctx_memory");
    });

    it("a PRIMARY (non-subagent) still gets the full long-term-partner block", async () => {
        useTempDataHome("sph-primary-full-");
        const sessionId = "ses-primary-full";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        // isSubagent defaults false.

        const { handler } = buildHandler();
        const system = ["You are the primary coding assistant."];
        await handler({ sessionID: sessionId }, { system });

        const joined = system.join("\n");
        expect(joined).toContain("## Magic Context");
        expect(joined).toContain("long-term partner");
        expect(joined).toContain("ctx_memory");
    });

    it("warns primary sessions about caveman compression even when ctx_reduce is callable", async () => {
        useTempDataHome("sph-primary-caveman-reduce-");
        const sessionId = "ses-primary-caveman-reduce";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);

        const { handler } = buildHandler({ experimentalCavemanTextCompression: true });
        const system = ["You are the primary coding assistant."];
        await handler({ sessionID: sessionId }, { system });

        const joined = system.join("\n");
        expect(joined).toContain("ctx_reduce");
        expect(joined).toContain("History compression is on");
        expect(joined).toContain("DO NOT mimic this style");
    });

    it("ORDER INVARIANT: an internal MC child that is ALSO marked subagent still skips entirely", async () => {
        useTempDataHome("sph-subagent-internal-");
        const sessionId = "ses-internal-and-subagent";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { isSubagent: true });

        const { handler } = buildHandler({
            internalChildSessions: new Set<string>([sessionId]),
        });
        const system = ["Some internal MC prompt."];
        await handler({ sessionID: sessionId }, { system });

        // Internal-child skip wins — no block at all, despite isSubagent=true.
        expect(system).toHaveLength(1);
        expect(system.join("\n")).not.toContain("## Magic Context");
    });
});

/**
 * Issue #53 regression: users can opt specific agents out of system-prompt
 * injection so Magic Context's `## Magic Context` guidance doesn't tell the
 * LLM to use tools that the user has denied for that agent.
 */
describe("system-prompt-hash honors per-agent opt-out (issue #53)", () => {
    it("skips ALL injection when injectionEnabled=false (global escape hatch)", async () => {
        useTempDataHome("sph-issue53-disabled-");
        const sessionId = "ses-disabled";
        const { handler } = buildHandler({ injectionEnabled: false });

        const system = ["You are a helpful coding assistant."];
        await handler({ sessionID: sessionId }, { system });

        expect(system).toHaveLength(1);
        expect(system[0]).toBe("You are a helpful coding assistant.");
        expect(system.join("\n")).not.toContain("## Magic Context");
    });

    it("skips injection when an agent prompt contains a custom skip signature", async () => {
        useTempDataHome("sph-issue53-skip-sig-");
        const sessionId = "ses-skipsig";
        const { handler } = buildHandler({
            injectionSkipSignatures: ["<!-- magic-context: skip -->"],
        });

        const system = [
            "You are a read-only QA agent.\n<!-- magic-context: skip -->\nDeny all writes.",
        ];
        await handler({ sessionID: sessionId }, { system });

        expect(system).toHaveLength(1);
        expect(system.join("\n")).not.toContain("## Magic Context");
    });

    it("matches multiple skip signatures (any one match opts the agent out)", async () => {
        useTempDataHome("sph-issue53-multi-sig-");
        const sessionId = "ses-multisig";
        const { handler } = buildHandler({
            injectionSkipSignatures: [
                "<!-- magic-context: skip -->",
                "I AM A TINY SPECIALIZED AGENT",
            ],
        });

        const system = ["I AM A TINY SPECIALIZED AGENT — do nothing else."];
        await handler({ sessionID: sessionId }, { system });

        expect(system).toHaveLength(1);
        expect(system.join("\n")).not.toContain("## Magic Context");
    });

    it("does NOT skip when skip signatures don't match the prompt", async () => {
        useTempDataHome("sph-issue53-no-match-");
        const sessionId = "ses-nomatch";
        const { handler } = buildHandler({
            injectionSkipSignatures: ["<!-- magic-context: skip -->"],
        });

        const system = ["You are a normal agent without any skip marker."];
        await handler({ sessionID: sessionId }, { system });

        // Injection still happened without adding a second system entry.
        expect(system).toHaveLength(1);
        expect(system[0]).toContain("## Magic Context");
    });

    it("ignores empty skip-signature strings (would otherwise match everything)", async () => {
        // Defensive: an empty string in skip_signatures would make
        // `prompt.includes("")` true for every prompt, silently disabling
        // injection globally. The handler explicitly filters out empty
        // signatures so a misconfiguration can't break injection silently.
        useTempDataHome("sph-issue53-empty-sig-");
        const sessionId = "ses-emptysig";
        const { handler } = buildHandler({
            injectionSkipSignatures: ["", "<!-- magic-context: skip -->"],
        });

        const system = ["You are a normal agent — no skip marker here."];
        await handler({ sessionID: sessionId }, { system });

        // Empty signature ignored, real signature didn't match → guidance injected.
        expect(system).toHaveLength(1);
        expect(system[0]).toContain("## Magic Context");
    });

    it("does NOT update systemPromptHash for opted-out calls", async () => {
        // Same reasoning as the issue #52 hash-update test: an opted-out
        // agent's system prompt is structurally different from the main
        // agent's, so updating the hash here would cause every later
        // main-agent turn to see a hash-change flush.
        useTempDataHome("sph-issue53-no-hash-update-");
        const sessionId = "ses-issue53-no-hash";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { systemPromptHash: "main-agent-hash" });

        const { handler } = buildHandler({ injectionEnabled: false });
        await handler({ sessionID: sessionId }, { system: ["Custom agent prompt"] });

        const meta = getOrCreateSessionMeta(db, sessionId);
        expect(meta.systemPromptHash).toBe("main-agent-hash");
    });
});

describe("provisional ctx_reduce availability (pre-first-user race)", () => {
    function createOpenCodeDbWithFirstUser(
        dataHome: string,
        sessionId: string,
        tools: Record<string, unknown>,
    ): void {
        const { Database } = require("../../shared/sqlite");
        const { mkdirSync } = require("node:fs");
        mkdirSync(join(dataHome, "opencode"), { recursive: true });
        const oc = new Database(join(dataHome, "opencode", "opencode.db"));
        oc.exec(
            "CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        oc.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 1, 1, ?)",
        ).run("msg-first-user", sessionId, JSON.stringify({ role: "user", tools }));
        oc.close();
    }

    it("does not persist a hash while the availability verdict is provisional", async () => {
        // A system pass can run BEFORE the session's first user message is
        // persisted to opencode.db. The availability verdict is then a
        // provisional fail-open true; persisting a hash computed from the
        // reduce-enabled guidance variant would flip (hash change → flush →
        // HARD fold) as soon as the real first user message denies the tool.
        const dir = mkdtempSync(join(tmpdir(), "sph-provisional-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        const { mkdirSync } = require("node:fs");
        const { Database } = require("../../shared/sqlite");
        mkdirSync(join(dir, "opencode"), { recursive: true });
        // opencode.db exists but has NO first-user row for this session yet.
        const oc = new Database(join(dir, "opencode", "opencode.db"));
        oc.exec(
            "CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
        );
        oc.close();

        const sessionId = "ses-provisional";
        clearCtxReduceAvailability(sessionId);
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);

        const { handler } = buildHandler();
        const system = ["Base agent prompt"];
        await handler({ sessionID: sessionId }, { system });

        // Guidance still renders (a prompt must go out)...
        expect(system.join("\n")).toContain("## Magic Context");
        // ...but no hash baseline is written from the provisional variant.
        const meta = getOrCreateSessionMeta(db, sessionId);
        expect(meta.systemPromptHash === "" || meta.systemPromptHash === "0").toBe(true);
    });

    it("persists the hash from the frozen deny-verdict variant once the first user row exists", async () => {
        const dir = mkdtempSync(join(tmpdir(), "sph-frozen-deny-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;

        const sessionId = "ses-frozen-deny";
        clearCtxReduceAvailability(sessionId);
        createOpenCodeDbWithFirstUser(dir, sessionId, { "*": false, read: true });

        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);

        const { handler } = buildHandler();
        const system = ["Base agent prompt"];
        await handler({ sessionID: sessionId }, { system });

        // Deny-list session: the no-reduce guidance variant renders...
        const joined = system.join("\n");
        expect(joined).toContain("## Magic Context");
        expect(joined).not.toContain("ctx_reduce");
        // ...and the hash IS persisted (frozen verdict owns the baseline).
        const meta = getOrCreateSessionMeta(db, sessionId);
        expect(meta.systemPromptHash).not.toBe("");
        expect(meta.systemPromptHash).not.toBe("0");
    });
});

function readA1PrimaryGuidance(): { guidance: string; hash: string } {
    const document = readFileSync(
        join(import.meta.dir, "../../shared/prompt-surface-a1-golden.md"),
        "utf8",
    );
    const guidance = document.match(
        /### PRIMARY full \(reduce=on, memory=on, dreamer=on, temporal=on\)[\s\S]*?```markdown\n([\s\S]*?)\n```/,
    )?.[1];
    const hash = document.match(/\| PRIMARY full \| \d+ \| `([0-9a-f]{32})` \|/)?.[1];
    if (!guidance || !hash) throw new Error("Malformed A1 primary guidance golden");
    return { guidance, hash };
}

describe("OpenCode prompt-surface guidance epochs", () => {
    it("matches A1 guidance for no config and explicit full", async () => {
        useTempDataHome("sph-a1-full-");
        const golden = readA1PrimaryGuidance();
        const common = {
            protectedTags: 20,
            dreamerEnabled: true,
            experimentalTemporalAwareness: true,
        };
        resolveCtxReduceAvailabilityFromMessages("ses-a1-implicit", [
            { info: { role: "user", tools: { "*": true } } },
        ]);
        resolveCtxReduceAvailabilityFromMessages("ses-a1-explicit", [
            { info: { role: "user", tools: { "*": true } } },
        ]);
        const implicit = buildHandler(common);
        const explicit = buildHandler({
            ...common,
            promptSurface: { default: "full" },
        });
        const implicitSystem = ["Base system prompt"];
        const explicitSystem = ["Base system prompt"];

        await implicit.handler(
            {
                sessionID: "ses-a1-implicit",
                model: { providerID: "provider", modelID: "model" },
            },
            { system: implicitSystem },
        );
        await explicit.handler(
            {
                sessionID: "ses-a1-explicit",
                model: { providerID: "provider", modelID: "model" },
            },
            { system: explicitSystem },
        );

        expect(implicitSystem).toHaveLength(1);
        expect(explicitSystem).toHaveLength(1);
        const guidancePrefix = "Base system prompt\n\n";
        const implicitGuidance = implicitSystem[0].slice(guidancePrefix.length);
        const explicitGuidance = explicitSystem[0].slice(guidancePrefix.length);
        expect(implicitSystem[0]).toStartWith(guidancePrefix);
        expect(explicitSystem[0]).toStartWith(guidancePrefix);
        expect(implicitGuidance).toBe(golden.guidance);
        expect(explicitGuidance).toBe(golden.guidance);
        expect(createHash("md5").update(implicitGuidance).digest("hex")).toBe(golden.hash);
        expect(implicitSystem[0]).toBe(explicitSystem[0]);
        const expectedComposedHash = createHash("md5").update(implicitSystem[0]).digest("hex");
        expect(getOrCreateSessionMeta(openDatabase(), "ses-a1-implicit").systemPromptHash).toBe(
            expectedComposedHash,
        );
        expect(getOrCreateSessionMeta(openDatabase(), "ses-a1-explicit").systemPromptHash).toBe(
            expectedComposedHash,
        );
    });

    it("defers the baseline until the model route is resolved", async () => {
        useTempDataHome("sph-model-freeze-");
        const sessionID = "ses-model-freeze";
        resolveCtxReduceAvailabilityFromMessages(sessionID, [
            { info: { role: "user", tools: { "*": true } } },
        ]);
        let recoveredModel: { providerID: string; modelID: string } | undefined;
        const historyRefreshSessions = new Set<string>();
        const systemPromptRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const { handler } = buildHandler({
            promptSurface: {
                default: "full",
                models: { "provider/light": "light" },
            },
            resolveModel: () => recoveredModel,
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
        });

        const modelLessSystem = ["Base system prompt"];
        await handler({ sessionID }, { system: modelLessSystem });
        const afterModelLess = getOrCreateSessionMeta(openDatabase(), sessionID);
        expect(
            afterModelLess.systemPromptHash === "" || afterModelLess.systemPromptHash === "0",
        ).toBe(true);

        recoveredModel = { providerID: "provider", modelID: "light" };
        const resolvedSystem = ["Base system prompt"];
        await handler({ sessionID }, { system: resolvedSystem });
        const baselineHash = getOrCreateSessionMeta(openDatabase(), sessionID).systemPromptHash;
        expect(baselineHash).not.toBe("");
        expect(baselineHash).not.toBe("0");
        expect(resolvedSystem.join("\n")).not.toBe(modelLessSystem.join("\n"));
        expect(historyRefreshSessions.has(sessionID)).toBe(false);
        expect(systemPromptRefreshSessions.has(sessionID)).toBe(false);
        expect(pendingMaterializationSessions.has(sessionID)).toBe(false);

        const stableSystem = ["Base system prompt"];
        await handler({ sessionID }, { system: stableSystem });
        expect(getOrCreateSessionMeta(openDatabase(), sessionID).systemPromptHash).toBe(
            baselineHash,
        );
        expect(historyRefreshSessions.has(sessionID)).toBe(false);
    });

    it("coalesces a midnight date and preset flip into one hash change", async () => {
        useTempDataHome("sph-midnight-preset-");
        const sessionID = "ses-midnight-preset";
        resolveCtxReduceAvailabilityFromMessages(sessionID, [
            { info: { role: "user", tools: { "*": true } } },
        ]);
        const historyRefreshSessions = new Set<string>();
        const systemPromptRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const { handler } = buildHandler({
            promptSurface: {
                default: "full",
                models: { "provider/light": "light" },
            },
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
        });
        const run = async (modelID: string, date: string) => {
            const system = [`Base prompt\nToday's date: ${date}`];
            await handler({ sessionID, model: { providerID: "provider", modelID } }, { system });
            return system.join("\n");
        };

        await run("full", "Mon Jan 01 2024");
        const firstHash = getOrCreateSessionMeta(openDatabase(), sessionID).systemPromptHash;
        historyRefreshSessions.clear();
        systemPromptRefreshSessions.clear();
        pendingMaterializationSessions.clear();

        const changed = await run("light", "Tue Jan 02 2024");
        const changedHash = getOrCreateSessionMeta(openDatabase(), sessionID).systemPromptHash;
        expect(changed).toContain("Today's date: Tue Jan 02 2024");
        expect(changedHash).not.toBe(firstHash);
        expect(historyRefreshSessions.has(sessionID)).toBe(true);

        historyRefreshSessions.clear();
        systemPromptRefreshSessions.clear();
        pendingMaterializationSessions.clear();
        const stable = await run("light", "Tue Jan 02 2024");
        expect(stable).toBe(changed);
        expect(getOrCreateSessionMeta(openDatabase(), sessionID).systemPromptHash).toBe(
            changedHash,
        );
        expect(historyRefreshSessions.has(sessionID)).toBe(false);
    });

    it("emits one hash fold when a preset/model boundary selects authored light", async () => {
        useTempDataHome("sph-prompt-epoch-");
        const config = {
            default: "full" as const,
            models: { "provider/light": "light" as const },
        };
        const warnings: string[] = [];
        const runtime = createPromptSurfaceRuntime({
            userConfigDirectory: process.cwd(),
            warn: (warning) => warnings.push(warning),
        });
        const historyRefreshSessions = new Set<string>();
        const systemPromptRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const { handler } = buildHandler({
            promptSurface: config,
            promptSurfaceRuntime: runtime,
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
        });
        const sessionID = "ses-prompt-surface-epoch";
        resolveCtxReduceAvailabilityFromMessages(sessionID, [
            { info: { role: "user", tools: { "*": true } } },
        ]);
        const run = (modelID: string) => {
            const system = ["Base system prompt"];
            return handler(
                {
                    sessionID,
                    model: { providerID: "provider", modelID },
                },
                { system },
            ).then(() => system.join("\n"));
        };

        const first = await run("full");
        const firstHash = getOrCreateSessionMeta(openDatabase(), sessionID).systemPromptHash;
        expect(first).toContain("## Magic Context");
        historyRefreshSessions.clear();
        systemPromptRefreshSessions.clear();
        pendingMaterializationSessions.clear();

        for (let pass = 0; pass < 5; pass++) {
            const frozen = await run("full");
            expect(frozen).toBe(first);
            expect(getOrCreateSessionMeta(openDatabase(), sessionID).systemPromptHash).toBe(
                firstHash,
            );
            expect(historyRefreshSessions.has(sessionID)).toBe(false);
            expect(pendingMaterializationSessions.has(sessionID)).toBe(false);
        }

        const changed = await run("light");
        const changedHash = getOrCreateSessionMeta(openDatabase(), sessionID).systemPromptHash;
        expect(changed).not.toBe(first);
        expect(changedHash).not.toBe(firstHash);
        expect(historyRefreshSessions.has(sessionID)).toBe(true);
        expect(systemPromptRefreshSessions.has(sessionID)).toBe(true);
        expect(pendingMaterializationSessions.has(sessionID)).toBe(true);
        expect(warnings).toEqual([]);

        historyRefreshSessions.clear();
        systemPromptRefreshSessions.clear();
        pendingMaterializationSessions.clear();
        for (let pass = 0; pass < 5; pass++) {
            const stable = await run("light");
            expect(stable).toBe(changed);
            expect(getOrCreateSessionMeta(openDatabase(), sessionID).systemPromptHash).toBe(
                changedHash,
            );
            expect(historyRefreshSessions.has(sessionID)).toBe(false);
            expect(pendingMaterializationSessions.has(sessionID)).toBe(false);
        }
    });
});
