import { expect, test } from "bun:test";
import {
    addCodeModeEntries,
    CODE_MODE_REMOVED,
    changedDate,
    instructionRow,
    MCP_GUIDANCE_REMOVED,
    type McpServerFixture,
    renderCodeModeCatalog,
    renderMcpGuidance,
    replaceCodeModeCatalog,
    updateMcpGuidance,
} from "../hooks/__tests__/code-mode-catalog.fixture";
import { codeModeCatalogKind, supersededInstructionIDs } from "./code-mode-catalog";

for (const version of ["2.0.22", "2.1.4", "2.2.3"] as const) {
    test(`recognizes initial, empty, replacement and incremental catalog text from OpenCode ${version}`, () => {
        expect(
            codeModeCatalogKind({ text: renderCodeModeCatalog(["CATALOG_ENTRY"], version) }),
        ).toBe("initial");
        expect(codeModeCatalogKind({ text: renderCodeModeCatalog([], version) })).toBe("initial");
        expect(
            codeModeCatalogKind({ text: replaceCodeModeCatalog(["CATALOG_ENTRY"], version) }),
        ).toBe("replacement");
        expect(codeModeCatalogKind({ text: replaceCodeModeCatalog([], version) })).toBe(
            "replacement",
        );
        expect(codeModeCatalogKind({ text: addCodeModeEntries(["ADDED_ENTRY"]) })).toBe(
            "incremental",
        );
    });
}

test("ordinary instructions and the invented catalog prefix are not Code Mode catalogs", () => {
    for (const text of [
        "Never deploy without permission.",
        "This catalog supersedes the previous catalog:",
        "# Code Mode unrelated heading",
    ]) {
        expect(codeModeCatalogKind({ text })).toBeUndefined();
    }
});

test("persisted instruction source keys own catalog identity, without retiring combined sources", () => {
    const text = replaceCodeModeCatalog(["CATALOG_ENTRY"]);
    expect(
        codeModeCatalogKind({
            text: "Host-keyed Code Mode catalog",
            metadata: { instructionSources: ["core/codemode"] },
        }),
    ).toBe("initial");
    expect(
        codeModeCatalogKind({
            text,
            metadata: { notice: "instructions", instructionSources: ["core/codemode"] },
        }),
    ).toBe("replacement");
    expect(
        codeModeCatalogKind({
            text,
            metadata: { instructionSources: ["core/codemode", "plugin/policy"] },
        }),
    ).toBe("combined-replacement");
    for (const instructionSources of [["plugin/policy"], [], "core/codemode"]) {
        expect(codeModeCatalogKind({ text, metadata: { instructionSources } })).toBeUndefined();
    }
});

const codeMode = "core/codemode";
const mcp = "core/mcp-guidance";
const date = "core/date";
const docs: McpServerFixture = { server: "docs", instructions: "DOCS_SERVER_GUIDANCE" };
const github: McpServerFixture = {
    server: "github",
    instructions: "GITHUB_SERVER_GUIDANCE\n\nCheck the open pull requests first.",
};
const search: McpServerFixture = { server: "search", instructions: "SEARCH_SERVER_GUIDANCE" };

const rows = (...entries: [id: string, text: string, sources: string[]][]) =>
    entries.map(([id, text, instructionSources]) => ({
        id,
        data: { text, metadata: { notice: "instructions", instructionSources } },
    }));
const retired = (list: ReturnType<typeof rows>) => [...supersededInstructionIDs(list)].sort();

for (const version of ["2.0.22", "2.1.4", "2.2.3"] as const) {
    test(`an MCP server that comes and goes leaves only the newest catalog and its newest mention (OpenCode ${version})`, () => {
        const list: [string, string, string[]][] = [];
        let connected = [docs, github];
        for (let i = 0; i < 6; i++) {
            const next = i % 2 === 0 ? [docs] : [docs, github];
            const guidance = updateMcpGuidance(connected, next, version);
            expect(guidance).not.toContain("This list supersedes");
            list.push([
                `row-${i}`,
                instructionRow(replaceCodeModeCatalog([`CATALOG_${i}`], version), guidance),
                [codeMode, mcp],
            ]);
            connected = next;
        }
        expect(retired(rows(...list))).toEqual(["row-0", "row-1", "row-2", "row-3", "row-4"]);
    });
}

test("a server's newest mention stays, whether it added or removed the server", () => {
    const addedSearch: [string, string, string[]] = [
        "a",
        instructionRow(
            replaceCodeModeCatalog(["A"]),
            updateMcpGuidance([docs, github], [docs, github, search]),
        ),
        [codeMode, mcp],
    ];
    const githubGone: [string, string, string[]] = [
        "b",
        instructionRow(
            replaceCodeModeCatalog(["B"]),
            updateMcpGuidance([docs, github, search], [docs, search]),
        ),
        [codeMode, mcp],
    ];
    const codeOnly: [string, string, string[]] = ["c", replaceCodeModeCatalog(["C"]), [codeMode]];
    expect(retired(rows(addedSearch, githubGone, codeOnly))).toEqual([]);
    const githubBack: [string, string, string[]] = [
        "d",
        instructionRow(
            replaceCodeModeCatalog(["D"]),
            updateMcpGuidance([docs, search], [docs, github, search]),
        ),
        [codeMode, mcp],
    ];
    expect(retired(rows(addedSearch, githubGone, codeOnly, githubBack))).toEqual(["b", "c"]);
});

test("a full MCP list is retired only by a newer full list or removal notice", () => {
    const catalog = (label: string, guidance: string): [string, string, string[]] => [
        label,
        instructionRow(replaceCodeModeCatalog([label]), guidance),
        [codeMode, mcp],
    ];
    const list = catalog("l", renderMcpGuidance([docs, github]));
    const gone = catalog("x", updateMcpGuidance([docs, github], [docs]));
    const back = catalog("y", updateMcpGuidance([docs], [docs, github]));
    expect(retired(rows(list, gone, back))).toEqual(["x"]);
    const none: [string, string, string[]] = ["z", MCP_GUIDANCE_REMOVED, [mcp]];
    expect(retired(rows(list, gone, back, none))).toEqual(["l", "x"]);
    const initial = catalog("w", renderMcpGuidance([github]));
    expect(retired(rows(list, gone, back, none, initial))).toEqual(["l", "x", "y", "z"]);
});

test("a changed server restates the whole list before 2.2 and names only that server from 2.2", () => {
    const changedGithub = { ...github, instructions: "GITHUB_SERVER_GUIDANCE_V2" };
    for (const [version, expected] of [
        ["2.1.4", ["o", "p"]],
        ["2.2.3", ["p"]],
    ] as const) {
        const catalog = (label: string, guidance: string): [string, string, string[]] => [
            label,
            instructionRow(replaceCodeModeCatalog([label], version), guidance),
            [codeMode, mcp],
        ];
        expect(
            retired(
                rows(
                    catalog("o", renderMcpGuidance([docs, github])),
                    catalog("p", updateMcpGuidance([docs], [docs, github], version)),
                    catalog(
                        "q",
                        updateMcpGuidance([docs, github], [docs, changedGithub], version),
                    ),
                ),
            ),
        ).toEqual([...expected]);
    }
});

test("Code Mode removal and an empty catalog restate the catalog; deltas restate nothing", () => {
    expect(
        retired(
            rows(
                ["r1", replaceCodeModeCatalog(["X"]), [codeMode]],
                ["r2", CODE_MODE_REMOVED, [codeMode]],
                ["r3", replaceCodeModeCatalog([]), [codeMode]],
                ["r4", addCodeModeEntries(["ADDED"]), [codeMode]],
            ),
        ),
    ).toEqual(["r1", "r2"]);
});

test("a row carrying the date is retired only once a newer date line restates it", () => {
    const day = (offset: number) => changedDate(new Date(Date.UTC(2026, 10, 6 + offset, 12)));
    const before: [string, string, string[]] = ["d0", day(0), [date]];
    const mixed: [string, string, string[]] = [
        "m",
        instructionRow(
            replaceCodeModeCatalog(["M"], "2.2.3"),
            updateMcpGuidance([docs, github], [docs]),
            day(1),
        ),
        [codeMode, mcp, date],
    ];
    const next: [string, string, string[]] = [
        "n",
        instructionRow(
            replaceCodeModeCatalog(["N"], "2.2.3"),
            updateMcpGuidance([docs], [docs, github]),
        ),
        [codeMode, mcp],
    ];
    expect(retired(rows(before, mixed, next))).toEqual(["d0"]);
    expect(retired(rows(before, mixed, next, ["o", day(2), [date]]))).toEqual(["d0", "m"]);
});

test("a row with project instructions stays, and only its leading catalog restates anything", () => {
    const added: [string, string, string[]] = [
        "a",
        instructionRow(replaceCodeModeCatalog(["A"]), updateMcpGuidance([docs], [docs, github])),
        [codeMode, mcp],
    ];
    const withInstructions: [string, string, string[]] = [
        "i",
        instructionRow(
            replaceCodeModeCatalog(["I"]),
            updateMcpGuidance([docs, github], [docs]),
            "The instructions from /work/AGENTS.md no longer apply.",
        ),
        [codeMode, mcp, "core/instructions"],
    ];
    const codeOnly: [string, string, string[]] = ["c", replaceCodeModeCatalog(["C"]), [codeMode]];
    expect(retired(rows(codeOnly, added, withInstructions))).toEqual(["c"]);
    const back: [string, string, string[]] = [
        "n",
        instructionRow(replaceCodeModeCatalog(["N"]), updateMcpGuidance([docs], [docs, github])),
        [codeMode, mcp],
    ];
    expect(retired(rows(codeOnly, added, withInstructions, back))).toEqual(["a", "c"]);
});

test("parts, entries and source lists OpenCode never writes keep their rows", () => {
    const catalog = replaceCodeModeCatalog(["OLD"]);
    const header = "New MCP server instructions are available in addition to those previously listed:";
    const malformed: [string, string, string[]][] = [
        ["unindented", `${catalog}\n\n${header}\n  <server name="github">\nGUIDANCE\n  </server>`],
        ["unclosed", `${catalog}\n\n${header}\n  <server name="github">\n    GUIDANCE`],
        ["empty entry", `${catalog}\n\n${header}\n  <server name="github">\n  </server>`],
        [
            "trailing text",
            `${catalog}\n\n${updateMcpGuidance([docs], [docs, github])}\nUnrelated closing line`,
        ],
        [
            "no period",
            `${catalog}\n\nInstructions for the following MCP servers are no longer available: github`,
        ],
        ["missing part", catalog],
        ["unknown catalog", `Unrecognized catalog\n\n${updateMcpGuidance([docs], [docs, github])}`],
    ].map(([id, text]) => [id!, text!, [codeMode, mcp]]);
    const valid = instructionRow(catalog, updateMcpGuidance([docs], [docs, github]));
    malformed.push(["reversed", valid, [mcp, codeMode]]);
    malformed.push(["duplicated", valid, [codeMode, mcp, mcp]]);
    const newest: [string, string, string[]] = [
        "newest",
        instructionRow(replaceCodeModeCatalog(["NEW"]), renderMcpGuidance([docs, github])),
        [codeMode, mcp],
    ];
    expect(retired(rows(...malformed, newest))).toEqual([]);
    // A server entry that does not parse names no server, so it cannot
    // supersede an older mention of that server.
    const older: [string, string, string[]] = [
        "older",
        updateMcpGuidance([docs], [docs, github]),
        [mcp],
    ];
    const unparsedGuidance = malformed.filter(([id]) => id !== "unknown catalog");
    expect(retired(rows(older, ...unparsedGuidance))).toEqual([]);
});
