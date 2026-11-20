import { expect, spyOn, test } from "bun:test";
import {
    appendCompartments,
    replaceAllCompartmentState,
} from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import {
    createLockedDeltaFixture,
    type LockedDeltaFixture,
    type LockedDeltaOptions,
    registerLockedDeltaRegressions,
} from "../../shared/fold-render-lock-fixtures.test";
import {
    injectM0M1,
    materializeM0,
    prepareCachedM0M1Replay,
    prepareCompartmentInjection,
    renderM1,
} from "./inject-compartments";
import * as formatting from "./read-session-formatting";

function options(f: LockedDeltaFixture, render: LockedDeltaOptions) {
    return {
        db: f.db,
        state: getOrCreateSessionMeta(f.db, f.sessionId),
        sessionId: f.sessionId,
        projectPath: f.projectPath,
        projectDirectory: f.directory,
        injectDocs: false,
        memoryInjectionBudgetTokens: render.memoryBudget,
        temporalAwareness: render.temporalAwareness,
    };
}
registerLockedDeltaRegressions({
    host: "OpenCode",
    create: createLockedDeltaFixture,
    materialize: (f, render) =>
        materializeM0({ ...options(f, render), state: getOrCreateSessionMeta(f.db, f.sessionId) })
            .snapshotMarkers,
    refresh: (f, render, beforeCacheCommitForTest) => {
        injectM0M1({
            ...options(f, render),
            state: getOrCreateSessionMeta(f.db, f.sessionId),
            isCacheBustingPass: true,
            beforeCacheCommitForTest,
        });
    },
    render: (f, render, markers) => renderM1(options(f, render), markers, []),
    temporalHeadings: true,
});

function historyRange(sequence: number, start: number, end: number, endBlockIndex?: number) {
    const text = `summary of m${start} through m${end}`;
    return {
        sequence,
        startMessage: start,
        endMessage: end,
        startMessageId: `m${start}`,
        endMessageId: `m${end}`,
        title: text,
        content: text,
        p1: text,
        endBlockIndex,
    };
}

function rawHistory(sessionID: string) {
    return [0, 1, 2, 3].map((n) => ({
        info: { id: `m${n}`, role: n % 2 ? "user" : "assistant", sessionID },
        parts: [{ type: "text", text: `original raw ${n}` }],
    }));
}

for (const cached of [false, true]) {
    test(`ordinary OpenCode ${cached ? "cached" : "cold"} pre-trim preserves a partial boundary after recomp`, () => {
        const f = createLockedDeltaFixture(`oc-pre-trim-partial-${cached}`);
        try {
            appendCompartments(f.db, f.sessionId, [historyRange(0, 0, 2, 0)]);
            injectM0M1(options(f, {}));
            const state = getOrCreateSessionMeta(f.db, f.sessionId);
            const baseline = {
                hasCachedM0: state.cachedM0Bytes !== null,
                boundary: state.cachedM0TrimBoundaryId ?? null,
                partial: state.cachedM0TrimBoundaryPartial ?? false,
            };
            const prepare = (messages: ReturnType<typeof rawHistory>) =>
                prepareCompartmentInjection(
                    f.db,
                    f.sessionId,
                    messages,
                    false,
                    [],
                    undefined,
                    undefined,
                    undefined,
                    baseline,
                );
            if (cached) prepare(rawHistory(f.sessionId));
            replaceAllCompartmentState(f.sibling, f.sessionId, [historyRange(0, 0, 2)], []);
            const messages = rawHistory(f.sessionId);
            messages[2]!.parts.push({ type: "text", text: "UNCOVERED_SUFFIX" });
            expect(prepare(messages)?.rebuiltFromDb).toBe(!cached);
            expect(messages.map((message) => message.info.id)).toEqual(["m2", "m3"]);
            expect(JSON.stringify(messages)).toContain("UNCOVERED_SUFFIX");
        } finally {
            f.close();
        }
    });
}

test("ordinary OpenCode head replay preserves a partial boundary after recomp", () => {
    const f = createLockedDeltaFixture("oc-defer-partial-recomp");
    try {
        const render = () => ({ ...options(f, {}), projectPath: undefined });
        appendCompartments(f.db, f.sessionId, [historyRange(0, 0, 2, 0)]);
        const first = injectM0M1(render());
        const messages = rawHistory(f.sessionId);
        messages[2]!.parts.push({ type: "text", text: "UNCOVERED_SUFFIX" });
        let replaced = false;
        const replay = injectM0M1({
            ...render(),
            messages,
            get isCacheBustingPass() {
                // The normal fold decision is already made when replay chooses m[1].
                if (!replaced) {
                    replaceAllCompartmentState(f.sibling, f.sessionId, [historyRange(0, 0, 2)], []);
                    replaced = true;
                }
                return false;
            },
        });
        expect(replaced).toBe(true);
        expect(replay.decision.value).toBe(false);
        expect(replay.m0Bytes).toEqual(first.m0Bytes);
        expect(replay.m1Text).toEqual(first.m1Text);
        expect(messages.slice(replay.prependedMessageCount).map((m) => m.info.id)).toEqual([
            "m2",
            "m3",
        ]);
        expect(JSON.stringify(messages)).toContain("UNCOVERED_SUFFIX");
    } finally {
        f.close();
    }
});

test("a defer does not tokenize frozen history to check refold drift", () => {
    const f = createLockedDeltaFixture("defer-drift-sizing");
    try {
        appendCompartments(f.db, f.sessionId, [historyRange(0, 0, 0)]);
        const first = injectM0M1(options(f, {}));
        const before = first.m0Bytes?.toString("utf8");
        const estimate = spyOn(formatting, "estimateTokens");
        try {
            const defer = injectM0M1({ ...options(f, {}), isCacheBustingPass: false });
            expect(defer.m0Bytes?.toString("utf8")).toBe(before);
            expect(defer.m1Text).toBe(first.m1Text);
            expect(estimate.mock.calls.filter(([text]) => text === before)).toHaveLength(0);
        } finally {
            estimate.mockRestore();
        }
    } finally {
        f.close();
    }
});

for (const hasOlderCut of [false, true]) {
    test(`defer keeps raw history beyond the captured ${hasOlderCut ? "existing" : "empty"} cut`, () => {
        const f = createLockedDeltaFixture(`oc-cut-${hasOlderCut}`);
        try {
            if (hasOlderCut) appendCompartments(f.db, f.sessionId, [historyRange(0, 0, 0)]);
            injectM0M1(options(f, {}));
            const beforeRefresh = options(f, {});
            const previousM1 = beforeRefresh.state.cachedM1Bytes?.toString("utf8");
            const next = historyRange(hasOlderCut ? 1 : 0, 1, 2);
            appendCompartments(f.sibling, f.sessionId, [next]);
            const refresh = injectM0M1({
                ...options(f, {}),
                db: f.sibling,
                state: getOrCreateSessionMeta(f.sibling, f.sessionId),
                isCacheBustingPass: true,
            });
            expect(refresh.m1Text).toContain(next.content);
            expect(refresh.preparedTrimBoundaryId).toBe("m2");
            const messages = rawHistory(f.sessionId);
            const defer = injectM0M1({ ...beforeRefresh, messages, isCacheBustingPass: false });
            expect(defer.decision.value).toBe(false);
            expect(defer.m1Text).toBe(previousM1);
            expect(messages.slice(defer.prependedMessageCount).map((m) => m.info.id)).toEqual(
                hasOlderCut ? ["m1", "m2", "m3"] : ["m0", "m1", "m2", "m3"],
            );
        } finally {
            f.close();
        }
    });
}

for (const ordered of [false, true]) {
    test(`prepared OpenCode ${ordered ? "source-order" : "visible"} replay keeps an uncovered block after recomp`, () => {
        const f = createLockedDeltaFixture(`oc-partial-${ordered}`);
        try {
            appendCompartments(f.db, f.sessionId, [historyRange(0, 0, 2, 0)]);
            injectM0M1(options(f, {}));
            const preparedPrefix = prepareCachedM0M1Replay(f.db, f.sessionId);
            expect(preparedPrefix?.preparedTrimBoundaryId).toBe("m2");
            const replay = () => {
                const messages = rawHistory(f.sessionId);
                messages[2]!.parts.push({ type: "text", text: "UNCOVERED_SUFFIX" });
                injectM0M1({
                    ...options(f, {}),
                    messages,
                    preparedPrefix,
                    prefixTrimSourceOrder: ordered
                        ? {
                              messageIds: ["m0", "m1", "m2", "m3"],
                              syntheticHeadCount: 0,
                              invalidReason: null,
                          }
                        : undefined,
                });
                return JSON.stringify(messages);
            };
            const original = replay();
            const heads = [
                "<session-history>\n## 0-2 · summary of m0 through m2\nsummary of m0 through m2\n</session-history>",
                "<session-history-since>(no new content since last materialization)</session-history-since>",
            ].map((text) => ({
                info: { role: "user", sessionID: f.sessionId, syntheticHead: true },
                parts: [{ type: "text", text, synthetic: true }],
            }));
            const untrimmed = rawHistory(f.sessionId);
            untrimmed[2]!.parts.push({ type: "text", text: "UNCOVERED_SUFFIX" });
            expect(original).toBe(JSON.stringify([...heads, ...untrimmed.slice(2)]));
            f.sibling
                .prepare("UPDATE compartments SET end_block_index = NULL WHERE session_id = ?")
                .run(f.sessionId);
            expect(replay()).toBe(original);
        } finally {
            f.close();
        }
    });
}
