import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { MockProvider } from "./mock-provider/server";

export const CHILD_SYSTEM = "SUBAGENT-WRITE-POLICY-WORKER";
const usage = { input_tokens: 100, output_tokens: 10 };

/** Drive actual host tools; never emulate the plugin's writes in the fixture. */
export async function subagentWriteScenario(f: {
    host: "oc1" | "oc2";
    mock: MockProvider;
    db: Database;
    parent: string;
    turn: (text: string) => Promise<unknown>;
    child: () => string;
}) {
    const calls = (prefix: string) => [
        {
            type: "tool_use" as const,
            id: `${prefix}_memory`,
            name: "ctx_memory",
            input: {
                action: "write",
                category: "PROJECT_RULES",
                content: `${prefix} memory sentinel`,
                ids: [],
            },
        },
        {
            type: "tool_use" as const,
            id: `${prefix}_note`,
            name: "ctx_note",
            input: { action: "write", content: `${prefix} note sentinel`, note_ids: [] },
        },
    ];
    f.mock.setDefault({ text: "finished", usage });
    let primaryWritten = false;
    f.mock.addMatcher((body) => {
        if (
            !primaryWritten &&
            body.tools &&
            JSON.stringify(body.messages).includes("PRIMARY-WRITES")
        ) {
            primaryWritten = true;
            return { content: calls("primary"), stop_reason: "tool_use", usage };
        }
        return null;
    });
    await f.turn("PRIMARY-WRITES");
    const primaryRequest = f.mock
        .requests()
        .find(
            (r) => r.body.tools && JSON.stringify(r.body.messages).includes("PRIMARY-WRITES"),
        )!.body;
    const primaryBytes = JSON.stringify(primaryRequest.tools);
    const names = (primaryRequest.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("ctx_memory");
    expect(names).toContain("ctx_note");
    expect(f.db.query("SELECT content FROM memories").all()).toEqual([
        { content: "primary memory sentinel" },
    ]);
    expect(f.db.query("SELECT content FROM notes").all()).toEqual([
        { content: "primary note sentinel" },
    ]);
    // This optional external snapshot is captured from the unfixed host run,
    // not computed from the fixed registry. It compares the entire wire tool list.
    const proof = process.env.MC_SUBAGENT_PROOF;
    if (proof) {
        const path = join(proof, `${f.host}-primary-tools.json`);
        if (existsSync(path)) expect(primaryBytes).toBe(readFileSync(path, "utf8"));
        else writeFileSync(path, primaryBytes);
    }
    let launched = false;
    let attempted = false;
    const childRequests: (typeof primaryRequest)[] = [];
    f.mock.addMatcher((body) => {
        if (JSON.stringify(body.system).includes(CHILD_SYSTEM)) {
            childRequests.push(body);
            const childNames = (body.tools as Array<{ name: string }>).map((t) => t.name);
            if (
                !attempted &&
                childNames.includes("ctx_memory") &&
                childNames.includes("ctx_note")
            ) {
                attempted = true;
                return { content: calls("child"), stop_reason: "tool_use", usage };
            }
            return { text: "child finished", usage };
        }
        if (!launched && JSON.stringify(body.messages).includes("LAUNCH-WORKER")) {
            launched = true;
            return {
                content: [
                    {
                        type: "tool_use",
                        id: "launch_worker",
                        name: f.host === "oc1" ? "task" : "subagent",
                        input:
                            f.host === "oc1"
                                ? {
                                      description: "Write policy worker",
                                      prompt: "CHILD-WORK",
                                      subagent_type: "write-worker",
                                  }
                                : {
                                      description: "Write policy worker",
                                      prompt: "CHILD-WORK",
                                      agent: "write-worker",
                                  },
                    },
                ],
                stop_reason: "tool_use",
                usage,
            };
        }
        return null;
    });
    await f.turn("LAUNCH-WORKER");
    expect(launched).toBe(true);
    expect(childRequests.length).toBeGreaterThan(0);
    const child = f.child();
    expect(
        f.db.query("SELECT is_subagent FROM session_meta WHERE session_id = ?").get(child),
    ).toEqual({ is_subagent: 1 });
    // Run the primary again after the child; request-local filtering must not
    // remove tools or change definitions in the parent's cached prefix.
    await f.turn("PRIMARY-AFTER-CHILD");
    expect(JSON.stringify(f.mock.requests().at(-1)!.body.tools)).toBe(primaryBytes);
    for (const body of childRequests) {
        expect(JSON.stringify(body.system)).not.toContain("ctx_memory");
        expect(JSON.stringify(body.system)).not.toContain("ctx_note");
        const childNames = (body.tools as Array<{ name: string }>).map((t) => t.name);
        expect(childNames).toContain("ctx_search");
        expect(childNames).toContain("ctx_expand");
        expect(childNames).toContain("ctx_reduce");
        expect(childNames).not.toContain("ctx_memory");
        expect(childNames).not.toContain("ctx_note");
    }
    expect(f.db.query("SELECT content FROM memories").all()).toEqual([
        { content: "primary memory sentinel" },
    ]);
    expect(f.db.query("SELECT content FROM notes").all()).toEqual([
        { content: "primary note sentinel" },
    ]);
    if (proof)
        writeFileSync(
            join(proof, `${f.host}-after.json`),
            JSON.stringify(
                {
                    child,
                    primaryBytes,
                    childRequests,
                    memories: f.db.query("SELECT content FROM memories").all(),
                    notes: f.db.query("SELECT content FROM notes").all(),
                },
                null,
                2,
            ),
        );
    console.log(
        JSON.stringify({
            host: f.host,
            child,
            childRequests: childRequests.length,
            attempted,
            primaryToolBytes: Buffer.byteLength(primaryBytes, "utf8"),
            primaryBytesUnchanged: true,
            memories: 1,
            notes: 1,
        }),
    );
}
