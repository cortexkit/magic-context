import { expect, test } from "bun:test";
import type { StoreRow } from "../store-reader";
import { RestoredRowCache, type RestoreRowReader } from "./restore-rows";

function fixture() {
    let decoded = 0;
    const rows = (sessionID: string): StoreRow[] =>
        Array.from({ length: 6 }, (_, seq) => ({
            id: `${sessionID}-${seq}`,
            session_id: sessionID,
            seq,
            type: "user",
            data: { text: `row ${seq} 🐈` },
        }));
    const rowBytes = Buffer.byteLength(JSON.stringify(rows("a")[0]!.data));
    const reader: RestoreRowReader = {
        spanRowStamps: (sessionID, after, through) =>
            new Map(
                rows(sessionID)
                    .filter((row) => row.seq > after && row.seq <= through)
                    .map((row) => [row.seq, `${row.id}\u00000\u0000${rowBytes}`]),
            ),
        page: (sessionID, options = {}) => {
            const selected = rows(sessionID).filter(
                (row) =>
                    row.seq > (options.after ?? -1) && row.seq <= (options.through ?? Infinity),
            );
            decoded += selected.length;
            return { rows: selected };
        },
    };
    return {
        reader,
        rowBytes,
        rows,
        cost: (run: () => unknown) => {
            const before = decoded;
            run();
            return decoded - before;
        },
    };
}

test("restore retention obeys per-session row and byte caps without changing any returned bytes", () => {
    for (const bound of ["rows", "bytes"]) {
        const f = fixture();
        const cache = new RestoredRowCache(
            bound === "rows" ? { sessionRows: 2 } : { sessionBytes: 2 * f.rowBytes },
        );
        const read = () => {
            const restored = cache.rows(f.reader, "a", -1, 5);
            expect(JSON.stringify(restored)).toBe(JSON.stringify(f.rows("a")));
            restored[0]!.data.text = "edited by the transform";
        };
        expect(f.cost(read)).toBe(6);
        expect(f.cost(read)).toBe(4);
    }
});

test("restore evicts the least recently used session at the total row or byte cap", () => {
    for (const bound of ["rows", "bytes", "sessions"]) {
        const f = fixture();
        const limits =
            bound === "rows"
                ? { totalRows: 12 }
                : bound === "bytes"
                  ? { totalBytes: 12 * f.rowBytes }
                  : { maxSessions: 2 };
        const cache = new RestoredRowCache(limits);
        const read = (id: string) => {
            expect(JSON.stringify(cache.rows(f.reader, id, -1, 5))).toBe(
                JSON.stringify(f.rows(id)),
            );
        };
        read("a");
        read("b");
        expect(f.cost(() => read("a"))).toBe(0);
        read("c");
        expect(f.cost(() => read("a"))).toBe(0);
        expect(f.cost(() => read("b"))).toBe(6);
    }
});

test("an empty restore span releases its rows and forget and clear release total accounting", () => {
    const f = fixture();
    const cache = new RestoredRowCache({ totalRows: 12 });
    const read = (id: string) => cache.rows(f.reader, id, -1, 5);
    read("a");
    expect(cache.rows(f.reader, "a", 5, 5)).toEqual([]);
    expect(f.cost(() => read("a"))).toBe(6);
    cache.forget("a");
    read("b");
    read("c");
    expect(f.cost(() => read("b"))).toBe(0);
    cache.clear();
    read("a");
    read("b");
    expect(f.cost(() => read("a"))).toBe(0);
});
