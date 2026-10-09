import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HISTORIAN_TRUNCATION_MARKER } from "../../../hooks/magic-context/producer-window-guard";
import { WHOLE_MESSAGE_PLACEHOLDER_TEXT } from "../../../hooks/magic-context/sentinel";
import * as constants from "./lifecycle-constants";
import {
    EVIDENCE_MARKERS,
    extractEvidenceWindow,
    hasEvidenceMarker,
    matchFactEvidence,
    normalizeLifecycleText,
    scanConcreteTokens,
    splitMemoryClauses,
} from "./lifecycle-text";

// In this host-versus-Broca routing memory, the trailing gap statement must be clause four.
// The abbreviation e.g. in the host-default statement must not create another boundary.
// Source: docs/reports/historian-merge-turn-trial-v6-sonnet.md:71 (#17639), db0582e9c6.
const GAP_MEMORY =
    "Rust transform mode must not require Broca (or any other CK module) to be running: every module under CK/subc stays decoupled unless coupling is necessary. Historian and dreamer completions in rust mode run by default in the same harness as the parent session (the host runs the prompt, e.g. OpenCode/Pi child session or the v2 child carrier), and route to the Broca runner only when the user configures it (Ufuk ruling, 2026-09-17). Today `crates/mc-module/src/historian_producer.rs` opens a route straight to `broca` (DEFAULT_RUNNER_MODULE_ID) — that is the gap to close with a host-runner default.";

describe("memory lifecycle text goldens", () => {
    test("named constants and lists are fixed", () => {
        expect([
            constants.LEXICAL_SLOT_COUNT,
            constants.NEIGHBOUR_SHORTLIST_CAP,
            constants.NARROW_CHECK_WINDOW_MAX,
            constants.KEPT_CHECK_INPUT_MAX,
            constants.NARROW_CHECK_CALL_CEILING,
            constants.MAX_STAGE2_ATTEMPTS,
            constants.RETRY_BACKLOG_PER_RUN,
            constants.EXCERPT_BEFORE,
            constants.EXCERPT_AFTER,
        ]).toEqual([2, 12, 1200, 48000, 8, 3, 8, 2, 4]);
        expect(constants.CLAUSE_ABBREVIATIONS).toEqual(["e.g.", "i.e.", "etc.", "vs."]);
        expect(constants.CONCRETE_UNITS.join(" ")).toBe(
            "KiB MiB GiB TiB KB MB GB TB byte bytes ns us µs ms s sec secs millisecond milliseconds second seconds m min mins minute minutes h hour hours d day days w week weeks token tokens percent %",
        );
    });
    test("v6 #17639 yields four clauses with c4 the gap and preserves every byte", () => {
        const clauses = splitMemoryClauses(GAP_MEMORY);
        expect(clauses).toHaveLength(4);
        expect(clauses[3]?.text).toBe("that is the gap to close with a host-runner default.");
        expect(clauses.map((clause) => clause.text).join("")).toBe(GAP_MEMORY);
        expect(clauses[1]?.text).toContain("e.g. OpenCode/Pi");
    });
    test("splitter respects backticks abbreviations list lines and newline bytes", () => {
        expect(
            splitMemoryClauses("e.g. A. Foo. Next!\n- One. Two.\n`x. y` — last.").map(
                (clause) => clause.text,
            ),
        ).toEqual(["e.g. A. Foo. ", "Next!\n", "- One. Two.\n", "`x. y` — ", "last."]);
    });
    test("whitespace is explicit and excludes FEFF and 180E", () => {
        expect(normalizeLifecycleText("\u0085 A\t\u00a0B\u3000 ")).toBe("A B");
        expect(normalizeLifecycleText("\uFEFF A \u180E")).toBe("\uFEFF A \u180E");
    });
    test("token golden distinguishes numeric identifier prefix and suffix collisions", () => {
        expect(
            scanConcreteTokens(
                "164 KiB >512 KiB 64 KiB 2026-09-17 12:10 50% memory.auto_promote REFUSAL_CODE src/file.rs `x` abc64 64suffix OTHER_REFUSAL_CODE",
            ),
        ).toEqual([
            "164 KiB",
            ">512 KiB",
            "64 KiB",
            "2026-09-17",
            "12:10",
            "50%",
            "memory.auto_promote",
            "REFUSAL_CODE",
            "src/file.rs",
            "`x`",
            "OTHER_REFUSAL_CODE",
        ]);
        expect(scanConcreteTokens("164 KiB")).not.toContain("64 KiB");
    });
    test("marker list includes renderer constants and literal user markers are rejected", () => {
        expect(EVIDENCE_MARKERS).toEqual([
            " / ",
            "[N]",
            "[N-M]",
            "Messages N-M:",
            "...[truncated]",
            "[… tokens truncated by Magic Context to fit the historian window …]",
            "…",
            "… +N more",
            "[dropped]",
            "[dropped §",
            "[truncated §",
            "<!-- +",
        ]);
        expect(EVIDENCE_MARKERS).toContain(WHOLE_MESSAGE_PLACEHOLDER_TEXT);
        expect(EVIDENCE_MARKERS).toContain(HISTORIAN_TRUNCATION_MARKER);
        // Inspect actual renderer literals independently of the list under test.
        const markerFile = readFileSync(
            new URL("../../../hooks/magic-context/edit-marker.ts", import.meta.url),
            "utf8",
        );
        expect(markerFile).toContain('"...[truncated]"');
        expect(EVIDENCE_MARKERS).toContain("...[truncated]");
        for (const marker of [
            " / ",
            "[42]",
            "[42-43]",
            "Messages 42-43:",
            "...[truncated]",
            HISTORIAN_TRUNCATION_MARKER,
            "…",
            "… +3 more",
            "[dropped]",
            "[dropped §3§]",
            "[truncated §3§]",
            "<!-- +5m -->",
        ])
            expect(hasEvidenceMarker(`literal user text ${marker} end`)).toBe(true);
    });
    test("matcher uses first occurrence one part and exact normalized bytes", () => {
        const parts = ["First   quote. Repeat quote. First quote.", "elsewhere"];
        const blocks = [
            {
                startOrdinal: 42,
                endOrdinal: 42,
                role: "user",
                parts,
                joinedText: parts.join(" / "),
            },
        ];
        expect(matchFactEvidence(blocks, 42, "First quote.")).toEqual({
            blockStartOrdinal: 42,
            partIndex: 0,
            start: 0,
            end: 14,
            text: "First   quote.",
            window: "First   quote. ",
        });
        expect(matchFactEvidence(blocks, 42, "First paraphrase.")).toBeNull();
        expect(matchFactEvidence(blocks, 42, "First quote. elsewhere")).toBeNull();
        expect(matchFactEvidence(blocks, 43, "First quote.")).toBeNull();
    });
    test("windows contain whole span at boundaries no terminator joined parts and astral cuts", () => {
        expect(extractEvidenceWindow("One. Two. Three. Four.", 10, 15)).toBe("One. Two. Three. ");
        expect(extractEvidenceWindow("One. Two. Three. Four.", 5, 20)).toBe(
            "One. Two. Three. Four.",
        );
        expect(extractEvidenceWindow("x".repeat(2000), 1950, 1999)).toBe("x".repeat(1200));
        expect(extractEvidenceWindow("x".repeat(2000), 0, 1201)).toBeNull();
        expect(extractEvidenceWindow("a / b", 4, 5)).toBe("a / b");
        const astral = "x".repeat(800) + "😀" + "y".repeat(1199);
        expect(extractEvidenceWindow(astral, 1999, 2001)).toBe("y".repeat(1199));
    });
});
