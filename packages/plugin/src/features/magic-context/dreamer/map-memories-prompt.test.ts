import { describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { extractCompleteManifestBody } from "./manifest-parser";

import {
    buildMapMemoriesPrompt,
    extractMemoryCandidatePaths,
    MAP_MEMORIES_SYSTEM_PROMPT,
    parseMapMemoriesManifest,
    parsePartialMapMemoriesManifest,
    validateMapMemoriesManifest,
} from "./map-memories-prompt";

it("partial recovery never borrows attributes from a later memory after a truncated tag", () => {
    expect(
        parsePartialMapMemoriesManifest(
            '<mappings><memory id="1" <memory id="2" files="src/two.ts"/>',
            new Set([1, 2]),
        ),
    ).toEqual([{ id: 2, files: ["src/two.ts"], independent: false }]);
});

it("partial recovery leaves conflicting unknown and malformed entries unmapped", () => {
    expect(
        parsePartialMapMemoriesManifest(
            `<mappings>
        <memory id="1" files="src/one.ts"/>
        <memory id="1" independent="true"/>
        <memory id="99" independent="true"/>
        <memory id="2"/>
        <memory id="3" files="src/three.ts"/>
        <memory id="4" files="src/truncated`,
            new Set([1, 2, 3, 4]),
        ),
    ).toEqual([{ id: 3, files: ["src/three.ts"], independent: false }]);
});

/** Real model deviations from the map-memories contract. Each used to parse
 *  to zero entries (or silently flip independent) and skip the fallback chain. */
const GEMINI_MAP_CHILDREN = `<mappings>
<map id="1">
config/magic-default.jsonc
</map>
</mappings>`;

const GLM52_JSON_ARRAY = `<mappings>
[
  { "id": "CONFIG_VALUES", "files": ["config/magic-default.jsonc"] }
]
</mappings>`;

const GLM53_MAPPING_ELEMENT = `<mappings>
  <mapping id="CONFIG_VALUES">
    <files><file path="config/magic-default.jsonc">claim</file></files>
    <status>confirmed</status>
  </mapping>
</mappings>`;

const DEEPSEEK_NESTED_FILE = `<mappings>
  <memory id="1" name="CONFIG_VALUES">
    <file path="config/magic-default.jsonc" claim="defaults live here" verified="true" line="14"/>
  </memory>
</mappings>`;

describe("parseMapMemoriesManifest", () => {
    const eighty =
        '<mappings>\n<memory id="123456" files="src/example-backing-file.ts"/>\n</mappings>';
    it.each([
        eighty,
        ` \n${eighty}\n\t `,
        eighty.replaceAll("\n", "\r\n"),
    ])("accepts a complete self-closing mapping with surrounding or CRLF whitespace: %j", (text) => {
        expect(eighty.length).toBe(80);
        expect(validateMapMemoriesManifest(text, new Set([123456]))).toEqual([
            { id: 123456, files: ["src/example-backing-file.ts"], independent: false },
        ]);
    });
    it.each([
        "src/a&b.ts",
        "src/a<b.ts",
        'src/a"b.ts',
        "src/a'b.ts",
        "src/a.ts,src/b.ts",
        "src/a b.ts",
        "src/a&amp;b.ts",
        "src/a&lt;b.ts",
        "src/a&quot;b.ts",
    ])("attribute characters do not affect complete-root extraction: %s", (files) => {
        const entry = `<memory id="123456" files="${files.padEnd(27, "x")}"/>`;
        const text = `<mappings>\n${entry}\n</mappings>`;
        expect(text.length).toBe(80);
        expect(extractCompleteManifestBody(text, "mappings")).toBe(`\n${entry}\n`);
    });
    it("parses files and independent flags, tolerant of attribute order", () => {
        const text = `prose before
<mappings>
<memory id="1" files="a/b.ts,c/d.ts"/>
<memory id="2" independent="true"/>
<memory files="x/y.ts" id="3"/>
</mappings>`;
        const out = parseMapMemoriesManifest(text);
        expect(out).toEqual([
            { id: 1, files: ["a/b.ts", "c/d.ts"], independent: false },
            { id: 2, files: [], independent: true },
            { id: 3, files: ["x/y.ts"], independent: false },
        ]);
    });

    it("rejects a memory that has neither files nor the independent sentinel", () => {
        // Mutation: flipping the default back to `independent || files.length === 0`
        // makes this parse succeed as independent=true instead of throwing.
        expect(() => parseMapMemoriesManifest(`<mappings><memory id="9"/></mappings>`)).toThrow(
            /neither files nor independent/,
        );
    });

    it("honors independent only when the explicit sentinel is present", () => {
        const out = parseMapMemoriesManifest(
            `<mappings><memory id="2" independent="true"/></mappings>`,
        );
        expect(out).toEqual([{ id: 2, files: [], independent: true }]);
    });

    it("rescues nested <file path> children instead of marking independent", () => {
        const out = parseMapMemoriesManifest(DEEPSEEK_NESTED_FILE);
        expect(out).toEqual([{ id: 1, files: ["config/magic-default.jsonc"], independent: false }]);
    });

    it("rejects wrong-but-rooted empty parses with a named retry-visible error", () => {
        expect(() => parseMapMemoriesManifest(GEMINI_MAP_CHILDREN)).toThrow(
            /root <map> unrecognized; expected <mappings> with <memory> entries/,
        );
        expect(() => parseMapMemoriesManifest(GLM52_JSON_ARRAY)).toThrow(
            /JSON array unrecognized; expected <mappings> with <memory> entries/,
        );
        expect(() => parseMapMemoriesManifest(GLM53_MAPPING_ELEMENT)).toThrow(
            /root <mapping> unrecognized; expected <mappings> with <memory> entries/,
        );
    });

    it("rejects a wrong document root and a bare JSON array", () => {
        expect(() => parseMapMemoriesManifest(`<map><memory id="1" files="a.ts"/></map>`)).toThrow(
            /root <map> unrecognized; expected <mappings> with <memory> entries/,
        );
        expect(() => parseMapMemoriesManifest(`[{ "id": 1, "files": ["a.ts"] }]`)).toThrow(
            /JSON array unrecognized; expected <mappings> with <memory> entries/,
        );
    });

    it("still accepts an empty mappings body (no unrecognized children)", () => {
        expect(parseMapMemoriesManifest(`<mappings></mappings>`)).toEqual([]);
    });

    it("trims file whitespace", () => {
        const out = parseMapMemoriesManifest(
            `<mappings><memory id="5" files=" a.ts ,  b.ts "/></mappings>`,
        );
        expect(out).toEqual([{ id: 5, files: ["a.ts", "b.ts"], independent: false }]);
    });

    it("rejects truncated and invalid entries", () => {
        expect(() => parseMapMemoriesManifest(`<mappings><memory id="5" files="a.ts"/>`)).toThrow(
            /closing root/,
        );
        expect(() =>
            parseMapMemoriesManifest(`<mappings><memory id="x" files="a.ts"/></mappings>`),
        ).toThrow(/numeric id/);
    });
});

describe("extractMemoryCandidatePaths", () => {
    const dir = createTestTempDirFromPath(path.join(tmpdir(), "mc-map-prompt-"));
    writeFileSync(path.join(dir, "real.ts"), "x");
    const sub = path.join(dir, "pkg");
    require("node:fs").mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "file.ts"), "x");

    it("returns only repo-relative paths that actually exist", () => {
        const found = extractMemoryCandidatePaths(
            "In `pkg/file.ts`, X does Y; also nonexistent/ghost.ts is referenced.",
            dir,
        );
        expect(found).toEqual(["pkg/file.ts"]);
    });

    it("does not seed when the memory names no path (conceptual memory)", () => {
        const found = extractMemoryCandidatePaths(
            "The classify task scores importance, scope, and shareability.",
            dir,
        );
        expect(found).toEqual([]);
    });

    it("ignores traversal paths", () => {
        const found = extractMemoryCandidatePaths("see ../escape/file.ts", dir);
        expect(found).toEqual([]);
    });

    it("resets regex state per call (no lastIndex bleed across memories)", () => {
        // The bug this guards: a module-level /g regex carries lastIndex; calling
        // twice must each resolve the leading path.
        const a = extractMemoryCandidatePaths("pkg/file.ts is here", dir);
        const b = extractMemoryCandidatePaths("pkg/file.ts is here", dir);
        expect(a).toEqual(["pkg/file.ts"]);
        expect(b).toEqual(["pkg/file.ts"]);
        rmSync(dir, { recursive: true, force: true });
    });
});

describe("validateMapMemoriesManifest", () => {
    it.each([
        "<mappings>\n</mappings>\n\nI couldn't confirm backing files for any of the five memories, so none are mapped. …",
        "<mappings>\n</mappings>\n\nI couldn't map any of the five memories, so I'm leaving all of them unmapped rather than guessing. …",
        "<mappings>\n</mappings>",
        "<mappings></mappings>",
    ])("accepts a closed empty manifest when every memory is uncertain: %j", (text) => {
        expect(parseMapMemoriesManifest(text)).toEqual([]);
        expect(validateMapMemoriesManifest(text, new Set([1, 2, 3, 4, 5]))).toEqual([]);
    });

    it.each([
        ["<map>…</map>", "root <map> unrecognized; expected <mappings> with <memory> entries"],
        [
            '[{ "id": 1, "files": ["a.ts"] }]',
            "JSON array unrecognized; expected <mappings> with <memory> entries",
        ],
        [
            '<mappings><mapping id="1"/></mappings>',
            "root <mapping> unrecognized; expected <mappings> with <memory> entries",
        ],
        ["<mappings>", "mappings manifest missing closing root tag"],
        [
            '<mappings><memory files="a.ts"/></mappings>',
            "mappings manifest entry missing numeric id",
        ],
    ])("rejects malformed output with its existing error: %s", (text, message) => {
        expect(() => validateMapMemoriesManifest(text, new Set([1]))).toThrow(message);
    });

    it("accepts a closed subset and unknown ids for apply-time filtering", () => {
        expect(
            validateMapMemoriesManifest(
                `<mappings><memory id="1" files="a.ts"/></mappings>`,
                new Set([1, 2]),
            ),
        ).toHaveLength(1);
        expect(
            validateMapMemoriesManifest(
                `<mappings><memory id="1" files="a.ts"/><memory id="9" independent="true"/></mappings>`,
                new Set([1]),
            ),
        ).toHaveLength(2);
    });

    it("still rejects an unclosed root before a partial prefix can apply", () => {
        expect(() =>
            validateMapMemoriesManifest(`<mappings><memory id="1" files="a.ts"/>`, new Set([1, 2])),
        ).toThrow(/closing root/);
    });

    it("rejects duplicate ids that belong to the requested batch", () => {
        expect(() =>
            validateMapMemoriesManifest(
                `<mappings><memory id="1" files="a.ts"/><memory id="1" independent="true"/></mappings>`,
                new Set([1]),
            ),
        ).toThrow(/duplicate id/);
    });

    it("accepts exact coverage", () => {
        const out = validateMapMemoriesManifest(
            `<mappings><memory id="1" files="a.ts"/><memory id="2" independent="true"/></mappings>`,
            new Set([1, 2]),
        );
        expect(out).toHaveLength(2);
    });
});

describe("buildMapMemoriesPrompt", () => {
    it("states that behavioral directives stay independent despite named files", () => {
        expect(MAP_MEMORIES_SYSTEM_PROMPT).toContain(
            "A BEHAVIORAL claim (when to act, how to work, who decides, or tool-usage discipline) is file-independent",
        );
        expect(MAP_MEMORIES_SYSTEM_PROMPT).toContain(
            "A path named inside a process directive is an action target or example",
        );
    });

    it("includes the seed line only when candidates exist", () => {
        const prompt = buildMapMemoriesPrompt("git:abc", [
            { id: 1, category: "ARCHITECTURE", content: "foo", candidates: ["a/b.ts"] },
            { id: 2, category: "CONSTRAINTS", content: "bar", candidates: [] },
        ]);
        expect(prompt).toContain("[1] ARCHITECTURE");
        expect(prompt).toContain("Likely files (candidate paths, confirmed to exist): a/b.ts");
        expect(prompt).toContain("[2] CONSTRAINTS\nbar");
        // memory 2 has no candidates → no seed line for it
        expect(prompt).not.toContain("Likely files (candidate paths, confirmed to exist): \n");
    });
});
