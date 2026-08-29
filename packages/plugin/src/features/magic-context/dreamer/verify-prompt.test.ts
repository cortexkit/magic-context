import { describe, expect, it } from "bun:test";

import {
    buildVerifyPrompt,
    parseVerifyManifest,
    VERIFY_SYSTEM_PROMPT,
    validateVerifyManifest,
} from "./verify-prompt";

describe("parseVerifyManifest", () => {
    it("parses verified / update / archive with attribute-order tolerance", () => {
        const text = `narration
<verify>
<verified id="1" files="a/b.ts,c/d.ts"/>
<update id="2" files="x.ts" consolidation="true">X uses Y now</update>
<archive id="3" reason="the symbol no longer exists"/>
<verified files="z.ts" id="4"/>
<skip id="5" reason="behavioral directive"/>
</verify>`;
        const out = parseVerifyManifest(text);
        expect(out.verified).toEqual([
            { id: 1, files: ["a/b.ts", "c/d.ts"] },
            { id: 4, files: ["z.ts"] },
        ]);
        expect(out.updated).toEqual([
            { id: 2, files: ["x.ts"], content: "X uses Y now", consolidation: true },
        ]);
        expect(out.archived).toEqual([{ id: 3, reason: "the symbol no longer exists" }]);
        expect(out.skipped).toEqual([{ id: 5, reason: "behavioral directive" }]);
    });

    it("handles a self-closing update (no content)", () => {
        const out = parseVerifyManifest(`<verify><update id="7" files="a.ts"/></verify>`);
        expect(out.updated).toEqual([
            { id: 7, files: ["a.ts"], content: "", consolidation: false },
        ]);
    });

    it("rejects a truncated manifest with no closing root", () => {
        expect(() => parseVerifyManifest(`<verify><archive id="9" reason="r"/>`)).toThrow(
            /closing root/,
        );
    });

    it("still accepts an empty verify body (no unrecognized children)", () => {
        expect(parseVerifyManifest(`<verify></verify>`)).toEqual({
            verified: [],
            updated: [],
            archived: [],
            skipped: [],
        });
    });

    it("rejects a well-formed root with no recognized entries", () => {
        expect(() => parseVerifyManifest(`<verify><item id="1"/></verify>`)).toThrow(
            /root <item> unrecognized; expected <verify> with <verified> entries/,
        );
        expect(() =>
            parseVerifyManifest(`<verify>[{ "id": 1, "status": "verified" }]</verify>`),
        ).toThrow(/JSON array unrecognized; expected <verify> with <verified> entries/);
    });

    it("preserves ids for batch-aware duplicate validation and rejects invalid entries", () => {
        const parsed = parseVerifyManifest(
            `<verify><verified id="9" files="a.ts"/><archive id="9" reason="r"/></verify>`,
        );
        expect([...parsed.verified, ...parsed.archived].map((entry) => entry.id)).toEqual([9, 9]);
        expect(() =>
            parseVerifyManifest(`<verify><verified id="x" files="a.ts"/></verify>`),
        ).toThrow(/numeric id/);
    });
});

describe("validateVerifyManifest", () => {
    it("rejects an empty parse against a non-empty batch", () => {
        expect(() => validateVerifyManifest(`<verify></verify>`, new Set([1]))).toThrow(
            /parsed zero entries; expected <verify> with <verified> entries/,
        );
    });

    it("accepts a closed subset and unknown ids for apply-time filtering", () => {
        expect(
            validateVerifyManifest(
                `<verify><verified id="1" files="a.ts"/></verify>`,
                new Set([1, 2]),
            ).verified,
        ).toHaveLength(1);
        expect(
            validateVerifyManifest(
                `<verify><verified id="1" files="a.ts"/><verified id="9" files="b.ts"/></verify>`,
                new Set([1]),
            ).verified,
        ).toHaveLength(2);
    });

    it("rejects duplicate ids that belong to the requested batch", () => {
        expect(() =>
            validateVerifyManifest(
                `<verify><verified id="1" files="a.ts"/><archive id="1" reason="r"/></verify>`,
                new Set([1, 2]),
            ),
        ).toThrow(/duplicate id/);
    });

    it("still rejects an unclosed root before a partial prefix can apply", () => {
        expect(() =>
            validateVerifyManifest(`<verify><verified id="1" files="a.ts"/>`, new Set([1, 2])),
        ).toThrow(/closing root/);
    });
});

describe("buildVerifyPrompt", () => {
    it("limits destructive verdicts to file-falsifiable code facts", () => {
        expect(VERIFY_SYSTEM_PROMPT).toContain(
            "UPDATE and ARCHIVE are ONLY for claims a repository file can falsify",
        );
        expect(VERIFY_SYSTEM_PROMPT).toContain(
            "Behavioral directives (when to act, how to work, who decides, tool-usage discipline) can only be VERIFIED or SKIPPED",
        );
        expect(VERIFY_SYSTEM_PROMPT).toContain('consolidation="true"');
    });

    it("lists each memory with its backing files and instructs default-verified", () => {
        const prompt = buildVerifyPrompt("git:abc", [
            { id: 1, category: "ARCHITECTURE", content: "foo", mappedFiles: ["a.ts", "b.ts"] },
        ]);
        expect(prompt).toContain("[1] ARCHITECTURE");
        expect(prompt).toContain("Backing files: a.ts, b.ts");
        expect(prompt).toContain("default verified");
    });
});
