import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { editOutsideCompanionTransaction, pairedThinkingEdit } from "./paired-thinking-edit";
import {
    clearPendingMaterialization,
    hasOnlySystemHashMaterialization,
    pendingMaterializationOrigin,
    requestPendingMaterialization,
    snapshotPendingMaterialization,
} from "./pending-materialization";

function fixture() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE decisions (kind TEXT PRIMARY KEY)");
    const messages: unknown[] = [{ text: "unchanged" }];
    const kinds = () => db.prepare("SELECT kind FROM decisions ORDER BY kind").all();
    const pair = (
        edit: () => boolean,
        companion = () => {
            db.exec("INSERT INTO decisions VALUES ('strip')");
        },
    ) =>
        pairedThinkingEdit({
            db,
            messages,
            edit,
            needsCompanion: (changed) => changed,
            persistCompanion: companion,
        });
    return { db, messages, kinds, pair };
}

describe("paired thinking decisions", () => {
    it("commits a landed edit only together with its companion", () => {
        const f = fixture();
        try {
            f.pair(() => {
                f.db.exec("INSERT INTO decisions VALUES ('edit')");
                return true;
            });
            expect(f.kinds()).toEqual([{ kind: "edit" }, { kind: "strip" }]);
        } finally {
            f.db.close();
        }
    });
    it("a failed edit never commits a strip ahead of its edit", () => {
        const f = fixture();
        try {
            expect(() =>
                f.pair(() => {
                    f.messages[0] = { text: "changed" };
                    f.db.exec("INSERT INTO decisions VALUES ('edit')");
                    throw new Error("edit failed");
                }),
            ).toThrow("edit failed");
            expect(f.kinds()).toEqual([]);
            expect(f.messages).toEqual([{ text: "unchanged" }]);
        } finally {
            f.db.close();
        }
    });
    it("a companion failure rolls back the edit and the rendered bytes", () => {
        const f = fixture();
        try {
            expect(() =>
                f.pair(
                    () => {
                        f.messages[0] = { text: "changed" };
                        f.db.exec("INSERT INTO decisions VALUES ('edit')");
                        return true;
                    },
                    () => {
                        throw new Error("strip failed");
                    },
                ),
            ).toThrow("strip failed");
            expect(f.kinds()).toEqual([]);
            expect(f.messages).toEqual([{ text: "unchanged" }]);
        } finally {
            f.db.close();
        }
    });
    it("a no-op never creates a companion decision", () => {
        const f = fixture();
        try {
            f.pair(() => false);
            expect(f.kinds()).toEqual([]);
            expect(f.messages).toEqual([{ text: "unchanged" }]);
        } finally {
            f.db.close();
        }
    });
});

it("paired rollback preserves opaque host callbacks without refusing the render", () => {
    const db = new Database(":memory:");
    const callback = () => "opaque extension";
    const messages = [{ text: "before", callback }];
    try {
        expect(() =>
            pairedThinkingEdit({
                db,
                messages,
                edit: () => {
                    messages[0].text = "after";
                    throw new Error("failed");
                },
                needsCompanion: () => false,
                persistCompanion: () => {},
            }),
        ).toThrow("failed");
        expect(messages[0].text).toBe("before");
        expect(messages[0].callback).toBe(callback);
    } finally {
        db.close();
    }
});

it("rollback preserves non-enumerable host metadata without serializing it", () => {
    const db = new Database(":memory:");
    const info = { role: "system" };
    const source = { id: "instruction-row" };
    Object.defineProperty(info, "hostInstructionRow", {
        value: source,
        enumerable: false,
        configurable: true,
    });
    const descriptor = Object.getOwnPropertyDescriptor(info, "hostInstructionRow");
    const messages = [{ info, parts: [{ type: "text", text: "catalog" }] }];
    const before = JSON.stringify(messages);
    const edit = () => {
        Object.defineProperty(info, "hostInstructionRow", {
            value: { id: "edited-row" },
            enumerable: true,
            configurable: true,
        });
        Object.defineProperty(info, "added", { value: true, configurable: true });
        throw new Error("refuse edit");
    };
    const unchanged = () => {
        expect(Object.getOwnPropertyDescriptor(info, "hostInstructionRow")).toEqual(descriptor);
        expect(Object.hasOwn(info, "added")).toBe(false);
        expect(JSON.stringify(messages)).toBe(before);
        expect(JSON.stringify(messages)).not.toContain("hostInstructionRow");
    };
    try {
        expect(() =>
            pairedThinkingEdit({
                db,
                messages,
                edit,
                needsCompanion: () => false,
                persistCompanion: () => {},
            }),
        ).toThrow("refuse edit");
        unchanged();
        expect(() => editOutsideCompanionTransaction({ messages, edit })).toThrow("refuse edit");
        unchanged();
    } finally {
        db.close();
    }
});

it("a failed pair restores the trigger's original reasons and in-memory metadata", () => {
    const db = new Database(":memory:");
    const flags = new Set<string>();
    requestPendingMaterialization(flags, "session", "system_hash");
    requestPendingMaterialization(flags, "session", "user_flush");
    const restore = snapshotPendingMaterialization(flags, "session");
    const state = { watermark: 0 };
    try {
        expect(() =>
            pairedThinkingEdit({
                db,
                messages: [],
                state,
                edit: () => {
                    clearPendingMaterialization(flags, "session");
                    state.watermark = 10;
                    return true;
                },
                needsCompanion: () => true,
                persistCompanion: () => {
                    throw new Error("refuse companion");
                },
                onRollback: restore,
            }),
        ).toThrow("refuse companion");
        expect(flags.has("session")).toBe(true);
        expect(pendingMaterializationOrigin(flags, "session")).toBe("system_hash");
        expect(hasOnlySystemHashMaterialization(flags, "session")).toBe(false);
        expect(state.watermark).toBe(0);
    } finally {
        db.close();
    }
});

describe("edits outside the companion transaction", () => {
    it("open no write transaction and keep their writes", () => {
        const db = new Database(":memory:");
        db.exec("CREATE TABLE decisions (kind TEXT PRIMARY KEY)");
        try {
            const outcome = editOutsideCompanionTransaction({
                messages: [],
                edit: () => {
                    expect(db.inTransaction).toBe(false);
                    db.exec("INSERT INTO decisions VALUES ('held')");
                    return 1;
                },
            });
            expect(outcome).toEqual({ result: 1 });
            expect(db.prepare("SELECT kind FROM decisions").all()).toEqual([{ kind: "held" }]);
        } finally {
            db.close();
        }
    });

    it("stop before a write that needs omissions, so the rerun pairs it with its strip", () => {
        const db = new Database(":memory:");
        db.exec("CREATE TABLE decisions (kind TEXT PRIMARY KEY)");
        const original = { text: "unchanged", parts: ["kept"] };
        const messages: unknown[] = [original];
        const state = { watermark: 0 };
        let rolledBack = 0;
        // The edit's second write fails, after the omissions it needs were planned.
        const edit = (requirePairing?: () => never) => {
            db.exec("INSERT OR IGNORE INTO decisions VALUES ('held')");
            original.text = "changed";
            original.parts.push("added");
            messages.push({ text: "appended" });
            state.watermark = 10;
            requirePairing?.();
            db.exec("INSERT INTO decisions VALUES ('strip')");
            throw new Error("edit failed");
        };
        try {
            expect(
                editOutsideCompanionTransaction({
                    messages,
                    state,
                    edit,
                    onRollback: () => rolledBack++,
                }),
            ).toBeUndefined();
            // Hosts map message objects to entry ids, so the rerun needs the same objects.
            expect(messages).toEqual([{ text: "unchanged", parts: ["kept"] }]);
            expect(messages[0]).toBe(original);
            expect(state.watermark).toBe(0);
            expect(rolledBack).toBe(1);
            expect(() =>
                pairedThinkingEdit({
                    db,
                    messages,
                    edit: () => edit(),
                    needsCompanion: () => true,
                    persistCompanion: () => {},
                }),
            ).toThrow("edit failed");
            // Only the write a held pass makes anyway survives; no strip without its edit.
            expect(db.prepare("SELECT kind FROM decisions ORDER BY kind").all()).toEqual([
                { kind: "held" },
            ]);
        } finally {
            db.close();
        }
    });
});
