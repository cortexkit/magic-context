import { expect, test } from "bun:test";
import {
    beginSidebarHistorianRun,
    clearSidebarObservations,
    rememberWaitingMessages,
    sidebarObservations,
} from "./sidebar-observations";

test("sidebar observations evict old sessions and deletion clears both readings", () => {
    for (let i = 0; i < 257; i++) {
        const id = `bounded-sidebar-${i}`;
        rememberWaitingMessages(id, i);
        beginSidebarHistorianRun(id)({
            outcome: "failed",
            model: null,
            primaryModel: "primary",
            fallback: false,
            primaryAttempts: 2,
            primaryRejections: 2,
        });
    }
    expect(sidebarObservations("bounded-sidebar-0")).toEqual({
        historianRun: undefined,
        waitingMessages: undefined,
    });
    expect(sidebarObservations("bounded-sidebar-256").waitingMessages).toBe(256);
    clearSidebarObservations("bounded-sidebar-256");
    expect(sidebarObservations("bounded-sidebar-256")).toEqual({
        historianRun: undefined,
        waitingMessages: undefined,
    });
    for (let i = 0; i < 257; i++) clearSidebarObservations(`bounded-sidebar-${i}`);
});

test("a failed run cannot reset degraded counters even when its primary output had no rejection", () => {
    const id = "sidebar-failed-not-clean";
    beginSidebarHistorianRun(id)({
        outcome: "fallback",
        model: "fallback",
        primaryModel: "primary",
        fallback: true,
        primaryAttempts: 2,
        primaryRejections: 2,
    });
    beginSidebarHistorianRun(id)({
        outcome: "failed",
        model: null,
        primaryModel: "primary",
        fallback: false,
        primaryAttempts: 1,
        primaryRejections: 0,
    });
    expect(sidebarObservations(id).historianRun).toMatchObject({
        outcome: "failed",
        model: null,
        sinceLastClean: { primaryAttempts: 3, primaryRejections: 2, fallbackRuns: 1 },
    });
    clearSidebarObservations(id);
});
