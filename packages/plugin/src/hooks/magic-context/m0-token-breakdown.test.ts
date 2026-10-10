import { describe, expect, spyOn, test } from "bun:test";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta";
import { Database } from "../../shared/sqlite";
import { computeM0BlockTokens } from "./m0-token-breakdown";
import { estimateTokens } from "./read-session-formatting";
import * as tokenCount from "./token-count-exact";

/**
 * The shared m[0] breakdown is the single source of truth for BOTH the OpenCode
 * sidebar/RPC and the Pi /ctx-status dialog, so they can never re-diverge on
 * categories or measurement (Pi had drifted: it still showed retired Facts and
 * lacked Docs/User Profile/v2-memory measurement).
 */

const SESSION_ID = "ses_m0_breakdown";

function makeDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    getOrCreateSessionMeta(d, SESSION_ID);
    return d;
}

describe("computeM0BlockTokens", () => {
    test("reuses exact block token counts and recounts a changed sidebar block", () => {
        const db = makeDb();
        // Every tokenizer count goes through countTokensExactly (it replays the
        // library's encoder without its quadratic paths), so that call is what
        // a recount looks like.
        const encode = spyOn(tokenCount, "countTokensExactly");
        const args = {
            m0Text: "<project-docs>sidebar memo unique docs αβ</project-docs><user-profile>sidebar memo unique profile</user-profile><project-memory>sidebar memo unique memory</project-memory><session-history>sidebar memo unique history</session-history>",
            m1Text: "<new-compartments>sidebar memo unique delta</new-compartments>",
            projectIdentity: undefined,
            injectionBudgetTokens: undefined,
            memoryBlockCount: 0,
        };
        try {
            const first = computeM0BlockTokens(db, SESSION_ID, args);
            expect(encode).toHaveBeenCalledTimes(5);
            encode.mockClear();
            expect(computeM0BlockTokens(db, SESSION_ID, { ...args })).toEqual(first);
            expect(encode).not.toHaveBeenCalled();
            const changed = computeM0BlockTokens(db, SESSION_ID, {
                ...args,
                m0Text: args.m0Text.replace(
                    "unique docs αβ",
                    "unique docs with a longer revision 😀",
                ),
            });
            expect(encode).toHaveBeenCalledTimes(1);
            expect(changed.docsTokens).not.toBe(first.docsTokens);
            expect(changed.compartmentTokens).toBe(first.compartmentTokens);
        } finally {
            encode.mockRestore();
            db.close();
        }
    });

    test("measures each m[0] slice from the rendered bytes and retires Facts", () => {
        const db = makeDb();
        const m0Text = [
            "<project-docs>\nARCHITECTURE: lorem ipsum docs body here for tokens\n</project-docs>",
            "<user-profile>\n- user prefers concise replies\n</user-profile>",
            "<project-memory>\n<PROJECT_RULES>\n#1: use the release script\n</PROJECT_RULES>\n</project-memory>",
            "<session-history>\n## 1-9 · Did a thing\nbody text\n</session-history>",
        ].join("\n");

        const b = computeM0BlockTokens(db, SESSION_ID, {
            m0Text,
            projectIdentity: "/tmp/proj",
            injectionBudgetTokens: 10_000,
            memoryBlockCount: 1,
        });

        expect(b.docsTokens).toBeGreaterThan(0);
        expect(b.profileTokens).toBeGreaterThan(0);
        expect(b.memoryTokens).toBeGreaterThan(0);
        expect(b.compartmentTokens).toBe(
            estimateTokens(
                "<session-history>\n## 1-9 · Did a thing\nbody text\n</session-history>",
            ),
        );
        // v2: facts retired (promoted to memories) → always 0.
        expect(b.factTokens).toBe(0);
        db.close();
    });

    test("missing slices read as 0 (no docs/profile/memory present)", () => {
        const db = makeDb();
        const m0Text = "<session-history>\n## 1-2 · x\ny\n</session-history>";
        const b = computeM0BlockTokens(db, SESSION_ID, {
            m0Text,
            projectIdentity: undefined,
            injectionBudgetTokens: undefined,
            memoryBlockCount: 0,
        });
        expect(b.docsTokens).toBe(0);
        expect(b.profileTokens).toBe(0);
        expect(b.memoryTokens).toBe(0);
        expect(b.factTokens).toBe(0);
        expect(b.compartmentTokens).toBeGreaterThan(0);
    });

    test("counts compartments published since the last m[0] fold from m[1]", () => {
        // Between m[0] folds, newly published compartments are served in m[1]'s
        // <new-compartments> block while m[0] keeps its older (here: empty)
        // <session-history>. The bucket must count both or it stays pinned at
        // the empty wrapper's size however many compartments are published.
        const db = makeDb();
        const m0History = "<session-history>\n</session-history>";
        const newCompartments =
            "<new-compartments>\n## 11-14 · Continued runtime inspection\nRead production, gear and ABI record code before implementing the plan.\n</new-compartments>";
        const b = computeM0BlockTokens(db, SESSION_ID, {
            m0Text: m0History,
            m1Text: `<session-history-since>\n${newCompartments}\n</session-history-since>`,
            projectIdentity: undefined,
            injectionBudgetTokens: undefined,
            memoryBlockCount: 0,
        });
        expect(b.compartmentTokens).toBe(
            estimateTokens(m0History) + estimateTokens(newCompartments),
        );
        db.close();
    });

    test("uses module history cost when Rust owns the materialized m[0]", () => {
        const db = makeDb();
        db.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ).run(SESSION_ID, 1, 1, 9, "m1", "m9", "Mirrored compartment", "p1 content", Date.now());
        const b = computeM0BlockTokens(db, SESSION_ID, {
            m0Text: "",
            projectIdentity: undefined,
            injectionBudgetTokens: undefined,
            memoryBlockCount: 0,
            compartmentTokensOverride: 17,
        });
        expect(b.compartmentTokens).toBe(17);
        db.close();
    });

    test("cold start (no materialized m[0]) falls back to Σp1 from compartments", () => {
        const db = makeDb();
        db.prepare(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ).run(SESSION_ID, 1, 1, 9, "m1", "m9", "Cold compartment", "some content body", Date.now());
        const b = computeM0BlockTokens(db, SESSION_ID, {
            m0Text: "", // no materialized m[0] yet
            projectIdentity: undefined,
            injectionBudgetTokens: undefined,
            memoryBlockCount: 0,
        });
        expect(b.compartmentTokens).toBe(
            estimateTokens("## 1-9 · Cold compartment\nsome content body\n"),
        );
        db.close();
    });
});
