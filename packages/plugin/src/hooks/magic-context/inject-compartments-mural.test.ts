/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
    buildMagicContextSection,
    MEMORY_MURAL_BLOCK,
    MEMORY_MURAL_GUIDANCE,
} from "../../agents/magic-context-prompt";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta-session";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    injectM0M1,
    type M0M1State,
    renderM0,
    servedHeadTexts,
    stripMemoryMuralBlock,
} from "./inject-compartments";
import { servedPrefixMatches } from "./strict-thinking-prefix";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_mural_inject";
const PROJECT_ID = "git:mural-project";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    getOrCreateSessionMeta(db, SESSION_ID);
    return db;
}

// A 1x1 transparent PNG data URL, standing in for a rendered mural.
const FAKE_MURAL_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function muralOption(dataUrl = FAKE_MURAL_DATA_URL, contentHash = "mural-hash-1") {
    return {
        enabled: true,
        supportsVision: true,
        dataUrl,
        contentHash,
    };
}

function imageUrl(messages: MessageLike[]): string | undefined {
    return (
        messages[0]?.parts.find((part) => (part as { type?: string }).type === "file") as
            | { url?: string }
            | undefined
    )?.url;
}

function replaceCurrentManifest(db: Database, content = "current mural"): string {
    const image = Buffer.from(content, "utf8");
    db.prepare(
        `INSERT OR REPLACE INTO mural_manifest
            (project_path, image, content_hash, rendered_at, memory_ids_json, width, height)
         VALUES (?, ?, ?, ?, '[]', 1, 1)`,
    ).run(PROJECT_ID, image, "current-manifest-hash", Date.now());
    return `data:image/png;base64,${image.toString("base64")}`;
}

describe("m[0] mural image fold (on-demand render → wire)", () => {
    it("keeps the Rust mural block byte-equal and the system prompt unchanged", () => {
        const rust = readFileSync(
            new URL("../../../../../crates/mc-module/src/m0_compose.rs", import.meta.url),
            "utf8",
        );
        const literal = rust.match(/const MEMORY_MURAL_BLOCK: &str =\s*("[^;]+");/)![1]!;
        expect(JSON.parse(literal)).toBe(MEMORY_MURAL_BLOCK);
        expect(buildMagicContextSection(null, 0)).not.toContain(MEMORY_MURAL_GUIDANCE);
    });

    it("emits the legend only with an enabled vision image", () => {
        const base = {
            projectDocs: "",
            userProfileBaseline: [],
            compartments: [],
            memories: [],
            facts: [],
        };
        expect(renderM0({ ...base, mural: muralOption() })).toContain(MEMORY_MURAL_BLOCK);
        for (const mural of [
            undefined,
            { ...muralOption(), enabled: false },
            { ...muralOption(), supportsVision: false },
            { ...muralOption(), dataUrl: "" },
        ]) {
            expect(renderM0({ ...base, mural })).not.toContain(MEMORY_MURAL_GUIDANCE);
        }
        for (const block of [
            MEMORY_MURAL_BLOCK,
            "<memory-mural>\nThe project memory mural image follows.\n</memory-mural>",
        ]) {
            expect(stripMemoryMuralBlock(`before\n\n${block}\n\nafter`)).toBe("before\n\nafter");
        }
    });

    it("replays a pre-legend baseline unchanged until the next HARD fold", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const args = {
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: undefined,
                mural: muralOption(),
                hardSignals: {
                    systemHash: "old",
                    modelKey: "anthropic/test-model",
                    cacheExpired: false,
                    lastResponseTime: 0,
                },
            };
            injectM0M1({ ...args, messages: [], isCacheBustingPass: true });
            const legacy = Buffer.from(
                state.cachedM0Bytes!.toString("utf8").replace(`${MEMORY_MURAL_GUIDANCE}\n`, ""),
            );
            db.prepare("UPDATE session_meta SET cached_m0_bytes = ? WHERE session_id = ?").run(
                legacy,
                SESSION_ID,
            );
            state.cachedM0Bytes = legacy;
            const deferred = injectM0M1({ ...args, messages: [], isCacheBustingPass: false });
            expect(deferred.m0RematerializedThisPass).toBe(false);
            expect(deferred.m0Bytes).toEqual(legacy);
            const folded = injectM0M1({
                ...args,
                hardSignals: { ...args.hardSignals, systemHash: "next" },
                messages: [],
                isCacheBustingPass: false,
            });
            expect(folded.m0RematerializedThisPass).toBe(true);
            expect(folded.m0Bytes?.toString("utf8")).toContain(MEMORY_MURAL_GUIDANCE);
        } finally {
            closeQuietly(db);
        }
    });
    it("folds the <memory-mural> block and image part when a mural is supplied, and replays it on defer", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;

            const hardMessages: MessageLike[] = [];
            const first = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: hardMessages,
                state,
                projectPath: undefined,
                isCacheBustingPass: true,
                mural: muralOption(),
            });
            expect(first.injected).toBe(true);
            // m[0] carries the mural marker block.
            expect(first.m0Bytes?.toString("utf8")).toContain(MEMORY_MURAL_BLOCK);
            // The prepended synthetic head message carries an image file part.
            const head = hardMessages[0];
            const imagePart = head?.parts.find(
                (part) => (part as { type?: string }).type === "file",
            ) as { type: string; mime?: string; url?: string } | undefined;
            expect(imagePart).toBeDefined();
            expect(imagePart?.mime).toBe("image/png");
            expect(imagePart?.url).toBe(FAKE_MURAL_DATA_URL);

            // A defer pass (no mural option supplied) must replay the SAME baked-in
            // data URL from state, not drop the image — the "swaps only on a HARD
            // fold" rule.
            const deferMessages: MessageLike[] = [];
            const second = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: deferMessages,
                state,
                projectPath: undefined,
                isCacheBustingPass: false,
            });
            expect(second.m0Bytes).toEqual(first.m0Bytes);
            const deferImage = deferMessages[0]?.parts.find(
                (part) => (part as { type?: string }).type === "file",
            ) as { url?: string } | undefined;
            expect(deferImage?.url).toBe(FAKE_MURAL_DATA_URL);
        } finally {
            closeQuietly(db);
        }
    });

    it("lets a new mural ride the next natural HARD instead of triggering one", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const hardSignals = (systemHash: string) => ({
                systemHash,
                modelKey: "anthropic/test-model",
                cacheExpired: false,
                lastResponseTime: 0,
            });
            const firstMessages: MessageLike[] = [];
            const first = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: firstMessages,
                state,
                projectPath: undefined,
                isCacheBustingPass: true,
                muralEnabled: true,
                mural: muralOption(FAKE_MURAL_DATA_URL, "mural-hash-a"),
                hardSignals: hardSignals("system-a"),
            });
            expect(first.m0RematerializedThisPass).toBe(true);

            const nextDataUrl = "data:image/png;base64,Yg==";
            const deferMessages: MessageLike[] = [];
            const deferred = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: deferMessages,
                state,
                projectPath: undefined,
                isCacheBustingPass: false,
                muralEnabled: true,
                mural: muralOption(nextDataUrl, "mural-hash-b"),
                hardSignals: hardSignals("system-a"),
            });
            expect(deferred.decision).toEqual({ value: false, reason: null });
            expect(deferred.m0RematerializedThisPass).toBe(false);
            expect(deferred.m0Bytes).toEqual(first.m0Bytes);
            expect(imageUrl(deferMessages)).toBe(FAKE_MURAL_DATA_URL);
            expect(state.cachedM0MuralHash).toBe("mural-hash-a");

            const hardMessages: MessageLike[] = [];
            const folded = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: hardMessages,
                state,
                projectPath: undefined,
                isCacheBustingPass: false,
                muralEnabled: true,
                mural: muralOption(nextDataUrl, "mural-hash-b"),
                hardSignals: hardSignals("system-b"),
            });
            expect(folded.decision).toMatchObject({ value: true, reason: "system_hash" });
            expect(folded.m0RematerializedThisPass).toBe(true);
            expect(imageUrl(hardMessages)).toBe(nextDataUrl);
            expect(state.cachedM0MuralHash).toBe("mural-hash-b");
        } finally {
            closeQuietly(db);
        }
    });

    it("folds once when mural is disabled, removes the image, then defers byte-identically", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const firstMessages: MessageLike[] = [];
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: firstMessages,
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                muralEnabled: true,
                mural: muralOption(),
                memoryInjectionBudgetTokens: 8_000,
                historyBudgetTokens: 60_000,
            });
            expect(imageUrl(firstMessages)).toBe(FAKE_MURAL_DATA_URL);

            const disabledMessages: MessageLike[] = [];
            const disabled = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: disabledMessages,
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 8_000,
                historyBudgetTokens: 60_000,
            });
            expect(disabled.decision).toEqual({
                value: true,
                reason: "render_config:mural(true→false)",
            });
            expect(disabled.m0RematerializedThisPass).toBe(true);
            expect(imageUrl(disabledMessages)).toBeUndefined();
            expect(disabled.m0Bytes?.toString("utf8")).not.toContain("<memory-mural>");
            expect(disabled.m0Bytes?.toString("utf8")).not.toContain(MEMORY_MURAL_GUIDANCE);

            const deferMessages: MessageLike[] = [];
            const defer = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: deferMessages,
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 8_000,
                historyBudgetTokens: 60_000,
            });
            expect(defer.m0RematerializedThisPass).toBe(false);
            expect(defer.m0Bytes).toEqual(disabled.m0Bytes);
            expect(imageUrl(deferMessages)).toBeUndefined();
        } finally {
            closeQuietly(db);
        }
    });

    it("folds once when memory or history render budgets change", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 1_000,
                historyBudgetTokens: 2_000,
            });
            const changed = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 1_001,
                historyBudgetTokens: 2_000,
            });
            expect(changed.decision).toEqual({
                value: true,
                reason: "render_config:budget(m1000-h2000→m1001-h2000)",
            });
            expect(changed.m0RematerializedThisPass).toBe(true);

            const unchanged = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 1_001,
                historyBudgetTokens: 2_000,
            });
            expect(unchanged.m0RematerializedThisPass).toBe(false);
            expect(unchanged.m0Bytes).toEqual(changed.m0Bytes);
        } finally {
            closeQuietly(db);
        }
    });

    it("replays the persisted frozen image after restart instead of the current project manifest", () => {
        const db = makeDb();
        try {
            const hardState = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const hardMessages: MessageLike[] = [];
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: hardMessages,
                state: hardState,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                mural: muralOption(),
            });

            const currentManifestUrl = replaceCurrentManifest(db);
            const restartedState = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            expect(restartedState.cachedM0MuralDataUrl).toBe(FAKE_MURAL_DATA_URL);
            expect(restartedState.cachedM0MuralHash).toBe("mural-hash-1");

            const deferMessages: MessageLike[] = [];
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: deferMessages,
                state: restartedState,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
            });
            expect(imageUrl(deferMessages)).toBe(FAKE_MURAL_DATA_URL);
            expect(imageUrl(deferMessages)).not.toBe(currentManifestUrl);
            expect(deferMessages[0]?.parts[0]).toEqual(hardMessages[0]?.parts[0]);
        } finally {
            closeQuietly(db);
        }
    });

    it("hydrates a sibling cached-row mural payload during adoption", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                mural: muralOption(),
            });

            const siblingDataUrl = "data:image/png;base64,c2libGluZy1tdXJhbA==";
            db.prepare(
                `UPDATE session_meta
                    SET cached_m0_mural_data_url = ?, cached_m0_mural_hash = ?,
                        cached_m0_materialized_at = cached_m0_materialized_at + 1
                  WHERE session_id = ?`,
            ).run(siblingDataUrl, "sibling-hash", SESSION_ID);

            const messages: MessageLike[] = [];
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages,
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
            });
            expect(imageUrl(messages)).toBe(siblingDataUrl);
            expect(state.cachedM0MuralDataUrl).toBe(siblingDataUrl);
            expect(state.cachedM0MuralHash).toBe("sibling-hash");
        } finally {
            closeQuietly(db);
        }
    });

    it("falls back to internally consistent text-only m0 when a legacy row lacks the payload", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                mural: muralOption(),
            });
            const currentManifestUrl = replaceCurrentManifest(db);
            db.prepare(
                `UPDATE session_meta
                    SET cached_m0_mural_data_url = NULL, cached_m0_mural_hash = NULL
                  WHERE session_id = ?`,
            ).run(SESSION_ID);

            const restartedState = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const messages: MessageLike[] = [];
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages,
                state: restartedState,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
            });
            expect(imageUrl(messages)).toBeUndefined();
            expect(imageUrl(messages)).not.toBe(currentManifestUrl);
            expect((messages[0]?.parts[0] as { text?: string })?.text).not.toContain(
                "<memory-mural>",
            );
        } finally {
            closeQuietly(db);
        }
    });

    it("omits the mural block entirely when no mural is supplied and the feature is off", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const messages: MessageLike[] = [];
            const result = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages,
                state,
                projectPath: undefined,
                isCacheBustingPass: true,
                // muralEnabled defaults undefined → no image path.
            });
            expect(result.m0Bytes?.toString("utf8")).not.toContain("<memory-mural>");
            const imagePart = messages[0]?.parts.find(
                (part) => (part as { type?: string }).type === "file",
            );
            expect(imagePart).toBeUndefined();
        } finally {
            closeQuietly(db);
        }
    });
});

// A saved m[0] from before the mural image was stored can still name a mural it
// has no image for. The injection serves it without that block, so a head
// compared with a served request must be read the same way, or every
// comparison reads as a change.
describe("servedHeadTexts", () => {
    it("reads a saved m[0] that names a mural with no stored image as the injection serves it", () => {
        const m0 = "<project-docs>\nv1\n</project-docs>";
        const legacy = `${m0}\n\n<memory-mural>\nThe project memory mural image follows.\n</memory-mural>`;
        const m1 = "<session-history>\n## 1-1 \u00b7 Baseline\n</session-history>";
        const state = {
            cachedM0Bytes: Buffer.from(legacy),
            cachedM1Bytes: Buffer.from(m1),
            cachedM0MuralDataUrl: null,
        };
        const served = [
            { info: { role: "user" }, parts: [{ type: "text", text: m0 }] },
            { info: { role: "user" }, parts: [{ type: "text", text: m1 }] },
        ];
        expect(servedHeadTexts(state)).toEqual({ m0Text: m0, m1Text: m1 });
        expect(servedPrefixMatches({ messages: served, ...servedHeadTexts(state) })).toBe(true);
        // The saved bytes themselves never equal what was served.
        expect(servedPrefixMatches({ messages: served, m0Text: legacy, m1Text: m1 })).toBe(false);
        // With its image stored, the block is served and kept.
        expect(
            servedHeadTexts({ ...state, cachedM0MuralDataUrl: "data:image/png;base64,AAAA" })
                .m0Text,
        ).toBe(legacy);
    });
});
