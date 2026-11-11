import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    AstrocyteRunnerMeterSource,
    decodeRunnerFeedPage,
    runnerFeedRow,
} from "./cache-bust-runner-feed";

const fixture = (path: string): unknown =>
    JSON.parse(readFileSync(join(import.meta.dir, "test-fixtures/usage-steps-v1", path), "utf8"));
test("decodes authoritative pages, open harness ids and tolerant members", () => {
    const page = decodeRunnerFeedPage({ result: fixture("read/reply-page.json") });
    expect(page.rows).toHaveLength(8);
    expect(new Set(page.rows.map((row) => `${row.harness}/${row.step_ref}`)).size).toBe(7);
    expect(page.next).not.toBeNull();
    expect(decodeRunnerFeedPage({ result: fixture("read/reply-last-page.json") }).next).toBeNull();
    expect(decodeRunnerFeedPage({ result: fixture("read/reply-empty.json") }).rows).toEqual([]);
    expect(
        decodeRunnerFeedPage({ result: fixture("tolerant/reply-next-absent.json") }).next,
    ).toBeNull();
    expect(
        decodeRunnerFeedPage({ result: fixture("tolerant/reply-unknown-member.json") }).through,
    ).toBeDefined();
    const row = runnerFeedRow.parse(fixture("tolerant/row-unknown-member.json"));
    expect(row.harness).toBe("example-runner");
    expect(row).not.toHaveProperty("cache_hint_ms");
    for (const name of ["occurred_at_ms", "verdict"])
        expect(() => runnerFeedRow.parse(fixture(`rejected/row-missing-${name}.json`))).toThrow();
    expect(() => decodeRunnerFeedPage(fixture("read/reply-page.json"))).toThrow();
});

test("source uses managed call identity, opaque cursors, and preserves refusal codes", async () => {
    const calls: unknown[][] = [];
    const source = new AstrocyteRunnerMeterSource(async () => ({
        call: async (...args) => {
            calls.push(args);
            if (calls.length === 2) throw fixture("refusals/cursor_expired.json");
            return { result: fixture("read/reply-last-page.json") };
        },
    }));
    expect((await source.read(undefined, 1234)).next).toBeNull();
    expect(calls[0]).toMatchObject([
        "astrocyte",
        "usage.steps.read",
        { limit: 1000 },
        { consumerIdentity: null, timeoutMs: 1234, identity: { harness: "magic-context" } },
    ]);
    await expect(source.read("opaque", 100)).rejects.toMatchObject({ code: "cursor_expired" });
    expect(calls[1]![2]).toEqual({ after: "opaque", limit: 1000 });
});
