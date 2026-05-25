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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createSystemPromptHashHandler } from "./system-prompt-hash";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
});

function buildHandler(opts?: {
    historyRefreshSessions?: Set<string>;
    systemPromptRefreshSessions?: Set<string>;
    pendingMaterializationSessions?: Set<string>;
    injectionEnabled?: boolean;
    injectionSkipSignatures?: string[];
    dreamerEnabled?: boolean;
    injectDocs?: boolean;
    directory?: string;
    experimentalUserMemories?: boolean;
}): ReturnType<typeof createSystemPromptHashHandler> {
    return createSystemPromptHashHandler({
        db: openDatabase(),
        protectedTags: 1,
        ctxReduceEnabled: true,
        dropToolStructure: true,
        dreamerEnabled: opts?.dreamerEnabled ?? false,
        injectDocs: opts?.injectDocs ?? false,
        directory: opts?.directory ?? "/tmp",
        historyRefreshSessions: opts?.historyRefreshSessions ?? new Set<string>(),
        systemPromptRefreshSessions: opts?.systemPromptRefreshSessions ?? new Set<string>(),
        pendingMaterializationSessions: opts?.pendingMaterializationSessions ?? new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        injectionEnabled: opts?.injectionEnabled,
        injectionSkipSignatures: opts?.injectionSkipSignatures,
        experimentalUserMemories: opts?.experimentalUserMemories,
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

describe("system-prompt-hash v2 system prompt contents", () => {
    it("keeps project docs, user profile, and key files out of the system prompt", async () => {
        useTempDataHome("sph-v2-adjuncts-out-");
        const directory = mkdtempSync(join(tmpdir(), "sph-docs-project-"));
        tempDirs.push(directory);
        writeFileSync(join(directory, "ARCHITECTURE.md"), "Alpha <closing-tag> & beta", "utf-8");
        const sessionId = "ses-v2-adjuncts-out";
        const { handler } = buildHandler({
            dreamerEnabled: true,
            injectDocs: true,
            directory,
            experimentalUserMemories: true,
        });

        const system = ["You are a helpful coding assistant. Today's date: 2026-05-28"];
        await handler({ sessionID: sessionId }, { system });
        const joined = system.join("\n");

        expect(joined).toContain("## Magic Context");
        expect(joined).toContain("Today's date: 2026-05-28");
        expect(joined).not.toContain("<project-docs>");
        expect(joined).not.toContain("<user-profile>");
        expect(joined).not.toContain("<key-files>");
        expect(joined).not.toContain("Alpha &lt;closing-tag&gt;");
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

        // The normal-agent path still appends the magic-context guidance.
        expect(system.length).toBeGreaterThan(1);
        expect(system.join("\n")).toContain("## Magic Context");
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

        // Injection still happened — guidance was appended.
        expect(system.length).toBeGreaterThan(1);
        expect(system.join("\n")).toContain("## Magic Context");
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
        expect(system.length).toBeGreaterThan(1);
        expect(system.join("\n")).toContain("## Magic Context");
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
