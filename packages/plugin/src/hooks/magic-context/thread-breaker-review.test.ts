import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../features/magic-context/migrations";
import { getOrCreateSessionMeta, getTagsBySession } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { readReplayEnvelope } from "../../features/magic-context/storage-replay-document";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { buildLkgPrefix } from "./lkg-replay";
import { projectStructuralSentinels } from "./project-structural-sentinels";
import { releaseRecoveryPrefix, snapshotRecoveryMessages } from "./release-recovery-prefix";
import { stripStructuralNoise } from "./strip-structural-noise";
import { type MessageLike, tagMessages } from "./tag-messages";
import { runPostTransformPhase } from "./transform-postprocess-phase";

const databases: Database[] = [];
const directories: string[] = [];
afterEach(() => {
    for (const db of databases) db.close();
    databases.length = 0;
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
});

function database(): Database {
    const db = new Database(":memory:");
    databases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function signedReply(id = "signed"): MessageLike {
    return {
        info: { id, role: "assistant" },
        parts: [
            { type: "step-start" },
            {
                type: "reasoning",
                text: "original thinking",
                metadata: { anthropic: { signature: "original-signature" } },
            },
            { type: "text", text: "original reply" },
            { type: "step-finish" },
        ],
    };
}

type PostprocessArgs = Parameters<typeof runPostTransformPhase>[0];
function postprocessArgs(
    db: Database,
    sessionId: string,
    messages: MessageLike[],
    overrides: Partial<PostprocessArgs> = {},
): PostprocessArgs {
    return {
        db,
        sessionId,
        messages,
        tags: [],
        targets: new Map(),
        reasoningByMessage: new Map(),
        messageTagNumbers: new Map(),
        tagger: createTagger(),
        ctxReduceAvailability: { callable: true, frozen: true },
        todowriteAvailability: { callable: true, frozen: true },
        batch: null,
        contextUsage: { percentage: 20, inputTokens: 1000 },
        usableWindow: 128_000,
        schedulerDecision: "defer",
        schedulerDeferReason: "scheduler_defer",
        fullFeatureMode: true,
        canRunCompartments: false,
        awaitedCompartmentRun: false,
        phaseJustAwaitedPublication: false,
        compartmentInProgress: false,
        historyRefreshExplicitBeforePrepare: false,
        deferredHistoryWasPendingAtPassStart: false,
        compartmentInjectionRebuiltFromDb: false,
        rebuiltHistoryFromInitialPrepare: false,
        historyRebuiltThisPass: false,
        canConsumeDeferredLate: false,
        sessionMeta: getOrCreateSessionMeta(db, sessionId),
        currentTurnId: null,
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        deferredMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 999,
        protectedTagIds: new Set(),
        protectedTagNumbers: new Set(),
        protectedCutoff: null,
        protectedCount: 0,
        pendingCompartmentInjection: null,
        didMutateFromFlushedStatuses: false,
        watermark: 0,
        forceMaterializationPercentage: 85,
        hasRecentReduceCall: false,
        resolvedProviderID: "anthropic",
        opencode1: true,
        ...overrides,
    };
}

test("review: a later recovery edit must not re-render an untouched structural reply", () => {
    const earlier = signedReply("earlier");
    const edited: MessageLike = {
        info: { id: "edited", role: "assistant" },
        parts: [{ type: "text", text: "old result" }],
    };
    const frozen = structuredClone([earlier, edited]);
    stripStructuralNoise(frozen);
    frozen[0].parts.push({ type: "text", text: "frozen previously served note" });
    const after = [earlier, structuredClone(edited)];

    // Match transform.ts: snapshot before persisted-status replay and structural
    // stripping, then release a conversation-only edit after final projection.
    const before = snapshotRecoveryMessages(after);
    stripStructuralNoise(after);
    after[1].parts = [{ type: "text", text: "[dropped §9§]" }];
    const released = releaseRecoveryPrefix({ frozen, before, after });

    expect(released[1].parts).toEqual([{ type: "text", text: "[dropped §9§]" }]);
    expect(JSON.stringify(released[0])).toBe(JSON.stringify(frozen[0]));
});

test("review: a known new signed reply omits sentinels without opening rebuild permission", async () => {
    const db = database();
    const messages = [signedReply()];
    stripStructuralNoise(messages);
    const result = await runPostTransformPhase(
        postprocessArgs(db, "review-new", messages, { readLastServedMessages: () => [] }),
    );
    expect(result.prefixMutationPermitted).toBe(false);
    expect(result.bustedThisPass).toBe(false);
    expect(messages[0].parts.map((part) => (part as { type: string }).type)).toEqual([
        "reasoning",
        "text",
    ]);
});

test("review: unknown previous history cannot authorize a first sentinel omission", () => {
    const db = database();
    const messages = [signedReply()];
    stripStructuralNoise(messages);
    const before = JSON.stringify(messages);
    expect(
        projectStructuralSentinels({
            db,
            sessionId: "review-unknown",
            messages,
            rebuilding: false,
            readPreviouslyServed: () => null,
        }),
    ).toBe(0);
    expect(JSON.stringify(messages)).toBe(before);
});

test("review: a truncated last-good prefix cannot prove a served signed reply is new", async () => {
    const db = database();
    const source: MessageLike[] = [
        {
            info: { id: "user", role: "user", time: { created: 1 } },
            parts: [{ type: "text", text: "question" }],
        },
        signedReply(),
    ];
    source[1].info.time = { created: 2 };
    source[1].info.finish = "stop";
    const previous = structuredClone(source);
    stripStructuralNoise(previous);

    // With no last-good request, the first defer pass conservatively retains
    // the old slots. For models whose signatures do not bind earlier prompt
    // bytes, capture saves only the prefix through the last real user, not the
    // signed reply it also served.
    await runPostTransformPhase(
        postprocessArgs(db, "review-partial-lkg", previous, {
            resolvedModelID: "claude-sonnet-4-6",
            readLastServedMessages: () => null,
        }),
    );
    const before = JSON.stringify(previous);
    const slot = buildLkgPrefix(source, previous);
    expect(slot).not.toBeNull();
    expect(JSON.parse(slot!.jsonPrefix).map((message: MessageLike) => message.info.id)).toEqual([
        "user",
    ]);

    const messages = structuredClone(source);
    stripStructuralNoise(messages);
    const result = await runPostTransformPhase(
        postprocessArgs(db, "review-partial-lkg", messages, {
            resolvedModelID: "claude-sonnet-4-6",
            readLastServedMessages: () => JSON.parse(slot!.jsonPrefix),
        }),
    );
    expect(result.prefixMutationPermitted).toBe(false);
    expect(result.bustedThisPass).toBe(false);
    expect(JSON.stringify(messages)).toBe(before);
});

test("review: OpenCode 2 does not adopt the OpenCode 1 sentinel projection", async () => {
    const db = database();
    const messages = [signedReply()];
    stripStructuralNoise(messages);
    const before = JSON.stringify(messages);
    await runPostTransformPhase(
        postprocessArgs(db, "review-oc2", messages, {
            opencode1: false,
            opencode2: true,
            readLastServedMessages: () => [],
        }),
    );
    expect(JSON.stringify(messages)).toBe(before);
});

test("review: frozen omissions survive two database reopenings and reasoning clearing", () => {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-thread-review-"));
    directories.push(directory);
    const path = join(directory, "context.db");
    let expected: string | undefined;
    for (let restart = 0; restart < 3; restart++) {
        const db = new Database(path);
        try {
            initializeDatabase(db);
            runMigrations(db);
            const messages = [signedReply()];
            stripStructuralNoise(messages);
            expect(
                projectStructuralSentinels({
                    db,
                    sessionId: "review-restarts",
                    messages,
                    rebuilding: false,
                    readPreviouslyServed: () => (restart === 0 ? [] : null),
                }),
            ).toBe(2);
            const bytes = JSON.stringify(messages);
            if (expected === undefined) expected = bytes;
            else expect(bytes).toBe(expected);
            expect(readReplayEnvelope(db, "review-restarts").structuralSentinelOmissions).toEqual([
                "signed",
            ]);

            const cleared = [signedReply()];
            (cleared[0].parts[1] as { text: string }).text = "[cleared]";
            stripStructuralNoise(cleared);
            projectStructuralSentinels({
                db,
                sessionId: "review-restarts",
                messages: cleared,
                rebuilding: false,
                readPreviouslyServed: () => null,
            });
            // A cleared-reasoning slot is not a structural marker; its own
            // removal policy must remain separate from the persisted omission.
            expect(cleared[0].parts).toEqual([
                { type: "text", text: "" },
                { type: "text", text: "original reply" },
            ]);
        } finally {
            db.close();
        }
    }
});

test("review: tool coordinates stay stable until final sentinel projection", () => {
    const db = database();
    const sessionId = "review-part-indices";
    const messages = [signedReply()];
    const tool = {
        type: "tool",
        tool: "read",
        callID: "review-call",
        state: { status: "completed", input: { filePath: "example.ts" }, output: "result" },
    };
    messages[0].parts.splice(3, 0, tool);
    const tagger = createTagger();
    tagger.initFromDb(sessionId, db);
    const tagged = tagMessages(sessionId, messages, tagger, db);
    stripStructuralNoise(messages);
    expect(messages[0].parts[3]).toBe(tool);
    const tag = getTagsBySession(db, sessionId).find((row) => row.type === "tool");
    expect(tag).toBeDefined();
    expect(tagged.targets.get(tag!.tagNumber)?.readInput?.()).toEqual({ filePath: "example.ts" });
    projectStructuralSentinels({
        db,
        sessionId,
        messages,
        rebuilding: false,
        readPreviouslyServed: () => [],
    });
    expect(messages[0].parts[2]).toBe(tool);
    expect(tool.state.output).toContain(`§${tag!.tagNumber}§`);
});
