import { expect, test } from "bun:test";
import {
    retiredLiveInstructionIDs,
    setCoveredInstructionSupersessionEnabledForTests,
} from "../fold/instruction-supersession";
import {
    changedDate,
    instructionRow,
    type McpServerFixture,
    replaceCodeModeCatalog,
    updateMcpGuidance,
} from "./__tests__/code-mode-catalog.fixture";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

const options = { area: "issue-886", instructions: false, temporal: false, cacheTtl: "never" };
const both = { notice: "instructions", instructionSources: ["core/codemode", "core/mcp-guidance"] };
const dated = { notice: "instructions", instructionSources: ["core/date"] };
const bothDated = {
    notice: "instructions",
    instructionSources: ["core/codemode", "core/mcp-guidance", "core/date"],
};
const docs: McpServerFixture = { server: "docs", instructions: "DOCS_SERVER_GUIDANCE" };
const github: McpServerFixture = {
    server: "github",
    instructions: "GITHUB_SERVER_GUIDANCE\nCheck the open pull requests first.",
};
const search: McpServerFixture = { server: "search", instructions: "SEARCH_SERVER_GUIDANCE" };

type Pass = Awaited<ReturnType<Awaited<ReturnType<typeof oc2ContextFixture>>["pass"]>>;
const instructionTexts = (pass: Pass) =>
    pass.draft.messages
        .filter((message) => message.role === "system")
        .flatMap((message) => message.content.map((part) => part.text));

/**
 * The row OpenCode 2.2 writes when the connected MCP servers change: the
 * server's tools leave or join a partial Code Mode catalog, so the catalog is
 * restated in full, and the MCP guidance names only the server that changed.
 */
const catalogRow = (
    label: string,
    previous: readonly McpServerFixture[],
    current: readonly McpServerFixture[],
) =>
    instructionRow(
        replaceCodeModeCatalog([`${label} ${"tool description ".repeat(300)}`], "2.2.3"),
        updateMcpGuidance(previous, current, "2.2.3"),
    );

test("an MCP server that keeps disconnecting and reconnecting leaves only the newest catalog row after a rebuild", async () => {
    const f = await oc2ContextFixture(30886, options);
    const pass = () =>
        f.pass((draft) => {
            draft.model.limit = { context: 302000 };
        });
    try {
        await pass();
        const rows: string[] = [];
        let connected = [docs, github];
        for (let i = 0; i < 24; i++) {
            const next = i % 2 === 0 ? [docs] : [docs, github];
            rows.push(catalogRow(`CATALOG_${i}`, connected, next));
            f.instruction(rows.at(-1)!, both);
            connected = next;
        }
        const held = await pass();
        expect(instructionTexts(held)).toEqual(rows);
        f.respond(1, 260000);
        const rebuilt = await pass();
        expect(instructionTexts(rebuilt)).toEqual([rows.at(-1)!]);
        expect(retiredLiveInstructionIDs(f.db, f.session).size).toBe(23);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("an older server's addition stays while no newer row mentions that server", async () => {
    const f = await oc2ContextFixture(31886, options);
    try {
        await f.pass();
        const addedSearch = catalogRow("ADDED_SEARCH", [docs, github], [docs, github, search]);
        const githubGone = catalogRow("GITHUB_GONE", [docs, github, search], [docs, search]);
        const githubBack = catalogRow("GITHUB_BACK", [docs, search], [docs, github, search]);
        for (const text of [addedSearch, githubGone, githubBack]) f.instruction(text, both);
        f.respond(1, 900000);
        expect(instructionTexts(await f.pass())).toEqual([addedSearch, githubBack]);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("a rebuilt request drops only the superseded rows and keeps the newest restatement of each source", async () => {
    const f = await oc2ContextFixture(32886, options);
    const pass = () =>
        f.pass((draft) => {
            draft.model.limit = { context: 302000 };
        });
    try {
        await pass();
        const day = (offset: number) => changedDate(new Date(Date.UTC(2026, 10, 7 + offset, 12)));
        const githubGone = catalogRow("CATALOG_0", [docs, github], [docs]);
        const searchAdded = catalogRow("CATALOG_1", [docs], [docs, search]);
        const githubBack = catalogRow("CATALOG_2", [docs, search], [docs, github, search]);
        const firstDay = day(0);
        const githubGoneNextDay = instructionRow(
            replaceCodeModeCatalog([`CATALOG_3 ${"tool description ".repeat(300)}`], "2.2.3"),
            updateMcpGuidance([docs, github, search], [docs, search], "2.2.3"),
            day(1),
        );
        const githubBackAgain = catalogRow("CATALOG_4", [docs, search], [docs, github, search]);
        const latestDay = day(2);
        const all: [string, Record<string, unknown>][] = [
            [githubGone, both],
            [searchAdded, both],
            [githubBack, both],
            [firstDay, dated],
            [githubGoneNextDay, bothDated],
            [githubBackAgain, both],
            [latestDay, dated],
        ];
        for (const [text, metadata] of all) f.instruction(text, metadata);
        const held = await pass();
        expect(instructionTexts(held)).toEqual(all.map(([text]) => text));
        f.respond(1, 260000);
        const rebuilt = await pass();
        // The newest catalog and github mention, the only search mention (its
        // row is atomic, so its older catalog stays with it) and the newest date.
        const kept = [searchAdded, githubBackAgain, latestDay];
        expect(instructionTexts(rebuilt)).toEqual(kept);
        const superseded = new Set(
            all.map(([text]) => text).filter((text) => !kept.includes(text)),
        );
        const expected = held.draft.messages.filter(
            (message) =>
                message.role !== "system" ||
                !message.content.some((part) => superseded.has(part.text ?? "")),
        );
        expect(JSON.stringify(rebuilt.draft.system)).toBe(JSON.stringify(held.draft.system));
        // Everything else the held request carried is unchanged, byte for byte;
        // the rebuilt request only appends the new reply.
        expect(JSON.stringify(rebuilt.draft.messages.slice(0, expected.length))).toBe(
            JSON.stringify(expected),
        );
        expect(rebuilt.draft.messages.slice(expected.length).map((m) => m.role)).toEqual([
            "assistant",
        ]);
        expect((await pass()).bytes).toBe(rebuilt.bytes);
        await f.restart();
        expect((await pass()).bytes).toBe(rebuilt.bytes);
    } finally {
        await f.cleanup();
    }
}, 60000);

// OpenCode 2 sends a reasoning part with a signature even when its text is
// empty (the thinking display was omitted), so such a block is kept thinking
// like a visible one: an edit in front of it must strip it.
for (const [label, thinking] of [
    [
        "a kept signed block",
        {
            type: "reasoning",
            text: "KEEP_SIGNED_REASONING",
            native: { anthropic: { signature: "signed-block" } },
        },
    ],
    [
        "a kept signature-only block (text omitted)",
        {
            type: "reasoning",
            text: "",
            providerMetadata: { anthropic: { signature: "KEEP_SIGNED_REASONING" } },
        },
    ],
] as const) {
    test(`a per-server retirement before ${label} strips that block on a prefix-bound model`, async () => {
        const f = await oc2ContextFixture(33886, {
            ...options,
            provider: "anthropic",
            model: "claude-opus-5-5",
        });
        try {
            await f.pass();
            const githubGone = catalogRow("BEFORE_THINKING", [docs, github], [docs]);
            f.instruction(githubGone, both);
            f.respond();
            const signedID = f.rows.at(-1)!.id;
            const addThinking = (
                draft: Parameters<NonNullable<Parameters<typeof f.pass>[0]>>[0],
            ) => {
                draft.messages
                    .find((message) => message.id === signedID)!
                    .content.unshift(structuredClone(thinking));
            };
            const before = await f.pass(addThinking);
            expect(before.bytes).toContain("KEEP_SIGNED_REASONING");
            // The newer row restates the catalog and mentions github again, so the
            // older row retires on this rebuilding pass. That edit sits before the
            // signed block, which therefore no longer verifies and is removed.
            const githubBack = catalogRow("AFTER_THINKING", [docs], [docs, github]);
            f.instruction(githubBack, both);
            f.user("Continue after the completed signed turn.", 1000);
            f.respond(1, 900000);
            const after = await f.pass(addThinking);
            expect(instructionTexts(after)).toEqual([githubBack]);
            expect(after.bytes).not.toContain("KEEP_SIGNED_REASONING");
            expect((await f.pass(addThinking)).bytes).toBe(after.bytes);
        } finally {
            await f.cleanup();
        }
    }, 60000);
}

// Rows the history summary covers are cut from the conversation and served
// again at the head of the request, ahead of every uncovered row. They must
// follow the same supersession decisions as the rows after the cut.
const sameBytes = (later: Pass, earlier: Pass) => {
    expect(JSON.stringify(later.draft.system)).toBe(JSON.stringify(earlier.draft.system));
    expect(JSON.stringify(later.draft.messages.slice(0, earlier.draft.messages.length))).toBe(
        JSON.stringify(earlier.draft.messages),
    );
};

test("a covered row is retired by a newer uncovered row on the next pass that may rebuild", async () => {
    const f = await oc2ContextFixture(34886, options);
    const pass = () =>
        f.pass((draft) => {
            draft.model.limit = { context: 302000 };
        });
    try {
        await pass();
        const githubGone = catalogRow("COVERED_GONE", [docs, github], [docs]);
        f.instruction(githubGone, both);
        const coveredID = f.rows.at(-1)!.id;
        f.user("First batch.", 1000);
        f.respond();
        // The summary covers the row, and the rebuild after it moves the cut.
        f.compartment(f.rows.length - 1);
        f.user("Second batch.", 1000);
        f.respond(1, 260000);
        expect(instructionTexts(await pass())).toEqual([githubGone]);
        f.respond();
        expect(instructionTexts(await pass())).toEqual([githubGone]);
        // A newer row after the cut restates the catalog and names github.
        const githubBack = catalogRow("LIVE_BACK", [docs], [docs, github]);
        f.instruction(githubBack, both);
        f.user("Third batch.", 1000);
        f.respond(1, 260000);
        const rebuilt = await pass();
        expect(instructionTexts(rebuilt)).toEqual([githubBack]);
        expect(retiredLiveInstructionIDs(f.db, f.session).has(coveredID)).toBe(true);
        f.respond();
        sameBytes(await pass(), rebuilt);
        await f.restart();
        f.respond();
        expect(instructionTexts(await pass())).toEqual([githubBack]);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("a row retired before the cut stays retired once the history summary covers it", async () => {
    const f = await oc2ContextFixture(35886, options);
    const pass = () =>
        f.pass((draft) => {
            draft.model.limit = { context: 302000 };
        });
    try {
        await pass();
        const githubGone = catalogRow("RETIRED_LIVE", [docs, github], [docs]);
        const githubBack = catalogRow("NEWEST", [docs], [docs, github]);
        f.instruction(githubGone, both);
        f.user("First batch.", 1000);
        f.respond();
        f.instruction(githubBack, both);
        f.user("Second batch.", 1000);
        f.respond(1, 260000);
        expect(instructionTexts(await pass())).toEqual([githubBack]);
        // A later summary covers both rows; the rebuild that moves the cut
        // must not serve the retired row again.
        f.compartment(f.rows.length - 1);
        f.user("Third batch.", 1000);
        f.respond(1, 260000);
        const covered = await pass();
        expect(instructionTexts(covered)).toEqual([githubBack]);
        f.respond();
        sameBytes(await pass(), covered);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("after an upgrade, covered rows a release served are retired only on a pass that may rebuild", async () => {
    const f = await oc2ContextFixture(36886, options);
    const pass = () =>
        f.pass((draft) => {
            draft.model.limit = { context: 302000 };
        });
    // Serve the session as the previous release did: covered rows skipped
    // supersession, so a row retired while uncovered came back once covered.
    setCoveredInstructionSupersessionEnabledForTests(false);
    try {
        await pass();
        const githubGone = catalogRow("RESERVED_BY_RELEASE", [docs, github], [docs]);
        const githubBack = catalogRow("NEWEST", [docs], [docs, github]);
        f.instruction(githubGone, both);
        f.user("First batch.", 1000);
        f.respond();
        f.instruction(githubBack, both);
        f.user("Second batch.", 1000);
        f.respond(1, 260000);
        await pass();
        f.compartment(f.rows.length - 1);
        f.user("Third batch.", 1000);
        f.respond(1, 260000);
        // The rebuild that moves the cut still sees both rows uncovered.
        expect(instructionTexts(await pass())).toEqual([githubBack]);
        // The next pass sets them aside as covered, and that release served
        // the retired row again, on a pass that may not rebuild.
        f.respond();
        const legacy = await pass();
        expect(instructionTexts(legacy)).toEqual([githubGone, githubBack]);
        // Upgrade: a pass that may not rebuild serves the same bytes.
        setCoveredInstructionSupersessionEnabledForTests(true);
        await f.restart();
        f.respond();
        const upgraded = await pass();
        sameBytes(upgraded, legacy);
        expect(
            f.db
                .prepare(
                    "SELECT json_extract(trailing_blank_decisions, '$.coveredInstructionSupersession') AS doc FROM session_meta WHERE session_id=?",
                )
                .get(f.session),
        ).toEqual({ doc: null });
        // The next pass that may rebuild retires the covered row and turns the
        // switch on; later passes replay that request.
        f.respond(1, 260000);
        const rebuilt = await pass();
        expect(instructionTexts(rebuilt)).toEqual([githubBack]);
        f.respond();
        sameBytes(await pass(), rebuilt);
    } finally {
        setCoveredInstructionSupersessionEnabledForTests(true);
        await f.cleanup();
    }
}, 60000);

test("rows the OpenCode 2 hook restores after a host checkpoint go through the same supersession", async () => {
    const f = await oc2ContextFixture(43886, options);
    const pass = () =>
        f.pass((draft) => {
            draft.model.limit = { context: 302000 };
        });
    try {
        await pass();
        const githubGone = catalogRow("RESTORED_GONE", [docs, github], [docs]);
        f.instruction(githubGone, both);
        const restoredID = f.rows.at(-1)!.id;
        f.user("First batch.", 1000);
        f.respond();
        // The summary covers the row before the host folds, so after the
        // checkpoint the hook restores it as a covered row.
        f.compartment(f.rows.length - 1);
        f.user("Second batch.", 1000);
        f.respond(1, 260000);
        await pass();
        f.respond();
        await pass();
        // The host folds and then sends only its short window.
        await f.fold();
        f.user("After the checkpoint.", 1000);
        f.respond();
        const folded = await pass();
        expect(instructionTexts(folded)).toEqual([githubGone]);
        const githubBack = catalogRow("AFTER_CHECKPOINT", [docs], [docs, github]);
        f.instruction(githubBack, both);
        f.user("Third batch.", 1000);
        f.respond(1, 260000);
        const rebuilt = await pass();
        expect(instructionTexts(rebuilt)).toEqual([githubBack]);
        expect(retiredLiveInstructionIDs(f.db, f.session).has(restoredID)).toBe(true);
        f.respond();
        sameBytes(await pass(), rebuilt);
    } finally {
        await f.cleanup();
    }
}, 60000);
