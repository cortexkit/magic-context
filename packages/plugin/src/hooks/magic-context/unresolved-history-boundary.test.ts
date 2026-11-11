import { expect, test } from "bun:test";
import {
    historyBoundaryRefusalCause,
    UnresolvedHistoryBoundaryError,
} from "./unresolved-history-boundary";

test("MC-H04 names the reason the history could not be cut and a remedy that changes it", () => {
    const unordered = new UnresolvedHistoryBoundaryError(188048, 187500, "boundary-unordered")
        .message;
    const notInRequest = new UnresolvedHistoryBoundaryError(
        188048,
        187500,
        "boundary-not-in-request",
    ).message;
    const missing = new UnresolvedHistoryBoundaryError(
        188048,
        187500,
        "boundary-missing-from-store",
    ).message;
    expect(unordered).toContain("could not order it");
    expect(unordered).not.toContain("out of order relative");
    expect(notInRequest).toContain("in the host's store but not in the loaded conversation");
    expect(missing).toContain("no longer in the host's store");
    for (const message of [unordered, notInRequest, missing]) {
        expect(message).toContain("not sent");
        expect(message).toContain("/ctx-flush");
        expect(message).toEndWith("(MC-H04)");
        // Neither rebuilds anything that decides the cut, so neither may be offered.
        expect(message).not.toContain("/ctx-recomp");
        expect(message).not.toContain("Reopen");
    }
});

test("a refusal that armed overflow recovery tells the person to send again, not to flush", () => {
    const armed = new UnresolvedHistoryBoundaryError(
        188048,
        187500,
        "boundary-unordered",
        "send-again",
    ).message;
    expect(armed).toContain("Send your message again");
    expect(armed).not.toContain("/ctx-flush");
    expect(armed).toEndWith("(MC-H08)");
});

test("a boundary row the store no longer holds outranks the trim's own reason", () => {
    expect(historyBoundaryRefusalCause("boundary-unordered", false)).toBe(
        "boundary-missing-from-store",
    );
    expect(historyBoundaryRefusalCause("boundary-not-in-request", true)).toBe(
        "boundary-not-in-request",
    );
    expect(historyBoundaryRefusalCause(null, undefined)).toBeUndefined();
});
