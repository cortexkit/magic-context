import { expect, test } from "bun:test";
import { retiredLiveInstructionIDs } from "../fold/instruction-supersession";
import {
    instructionRow,
    type McpServerFixture,
    replaceCodeModeCatalog,
    updateMcpGuidance,
} from "./__tests__/code-mode-catalog.fixture";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

const options = { area: "issue-886", instructions: false, temporal: false, cacheTtl: "never" };
const both = { notice: "instructions", instructionSources: ["core/codemode", "core/mcp-guidance"] };
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

test.failing("an MCP server that keeps disconnecting and reconnecting leaves only the newest catalog row after a rebuild", async () => {
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

test.failing("an older server's addition stays while no newer row mentions that server", async () => {
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
