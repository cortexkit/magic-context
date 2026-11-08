/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    cloneKeepingCoveredInstructionMarks,
    hostInstructionRow,
    isCoveredInstructionRow,
    isHostRenderedSystemMessage,
    isHostUnservedRow,
    markCoveredInstructionRow,
    markHostInstructionRow,
    markHostUnservedRow,
    retreatPastHostUnservedRows,
    snapTerminalCompartmentToServedRow,
    takeCoveredInstructionRows,
} from "./host-served-rows";

const line = (ordinal: number, unserved = false) => {
    const value = { ordinal, messageId: `m${ordinal}` };
    return unserved ? markHostUnservedRow(value) : value;
};

describe("host-served rows", () => {
    it("marks rows without changing their enumerable shape", () => {
        const marked = markHostUnservedRow({ ordinal: 1, messageId: "m1" });
        expect(isHostUnservedRow(marked)).toBe(true);
        expect(JSON.stringify(marked)).toBe('{"ordinal":1,"messageId":"m1"}');
        expect(isHostUnservedRow({ ordinal: 1 })).toBe(false);
    });

    it("moves an exclusive end back past unserved rows but never below the floor", () => {
        const rows = [line(5), line(6), line(7, true), line(8, true), line(9)];
        expect(retreatPastHostUnservedRows(rows, 9, 5)).toBe(7);
        expect(retreatPastHostUnservedRows(rows, 10, 5)).toBe(10);
        expect(retreatPastHostUnservedRows(rows, 9, 8)).toBe(8);
        expect(retreatPastHostUnservedRows([line(5), line(6)], 7, 5)).toBe(7);
    });

    it("ends the final compartment on the nearest served row", () => {
        const lines = [line(1), line(2), line(3), line(4, true)];
        const result = snapTerminalCompartmentToServedRow(
            [
                { startMessage: 1, endMessage: 2, endMessageId: "m2" },
                { startMessage: 3, endMessage: 4, endMessageId: "m4" },
            ],
            lines,
        );
        expect(result.snapped).toBe(true);
        expect(result.compartments).toEqual([
            { startMessage: 1, endMessage: 2, endMessageId: "m2" },
            { startMessage: 3, endMessage: 3, endMessageId: "m3" },
        ]);
    });

    it("drops a final compartment that holds only unserved rows", () => {
        const lines = [line(1), line(2), line(3, true)];
        const result = snapTerminalCompartmentToServedRow(
            [
                { startMessage: 1, endMessage: 2, endMessageId: "m2" },
                { startMessage: 3, endMessage: 3, endMessageId: "m3" },
            ],
            lines,
        );
        expect(result.compartments).toEqual([
            { startMessage: 1, endMessage: 2, endMessageId: "m2" },
        ]);
    });

    it("leaves compartments alone when every row is served", () => {
        const compartments = [{ startMessage: 1, endMessage: 2, endMessageId: "m2" }];
        const result = snapTerminalCompartmentToServedRow(compartments, [line(1), line(2)]);
        expect(result).toEqual({ compartments, snapped: false });
    });

    it("recognizes only id-less system messages as host-rendered instruction rows", () => {
        expect(isHostRenderedSystemMessage({ info: { role: "system" } })).toBe(true);
        expect(isHostRenderedSystemMessage({ info: { role: "system", id: "row" } })).toBe(false);
        expect(isHostRenderedSystemMessage({ info: { role: "user" } })).toBe(false);
    });

    it("native instruction coordinates survive fit retry without changing request identity", () => {
        const message = { info: { role: "system" }, parts: [{ type: "text", text: "catalog" }] };
        const original = JSON.stringify(message);
        const row = { id: "native-row", seq: 9 };
        markHostInstructionRow(message.info, row);
        expect(JSON.stringify(message)).toBe(original);
        const copy = cloneKeepingCoveredInstructionMarks([message]);
        expect(hostInstructionRow(copy[0]!.info)).toEqual(row);
        expect(JSON.stringify(copy[0])).toBe(original);
    });
});

describe("covered instruction rows", () => {
    // The signed-thinking fit retry re-runs the pass from a deep copy of its
    // input. The copy must keep the covered marks, or the retried pass would
    // serve those rows as ordinary host rows instead of setting them aside.
    it("a retry copy keeps covered marks and the same bytes", () => {
        const covered = markCoveredInstructionRowOn({
            info: { role: "system" },
            parts: [{ type: "text", text: "Today's date is now: day 2." }],
        });
        const user = { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] };
        const input = [covered, user];
        const copy = cloneKeepingCoveredInstructionMarks(input);
        expect(JSON.stringify(copy)).toBe(JSON.stringify(input));
        expect(copy[0]).not.toBe(covered);
        expect(isCoveredInstructionRow(copy[0]?.info)).toBe(true);
        expect(isCoveredInstructionRow(copy[1]?.info)).toBe(false);
        expect(takeCoveredInstructionRows(copy)).toEqual([covered]);
        expect(copy).toEqual([user]);
    });
});

function markCoveredInstructionRowOn<T extends { info: object }>(message: T): T {
    markCoveredInstructionRow(message.info);
    return message;
}
