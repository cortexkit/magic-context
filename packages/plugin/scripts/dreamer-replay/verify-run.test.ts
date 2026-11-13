import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cleanupRegisteredTestTempDirs, createTestTempDir } from "../../src/shared/test-temp-dir";
import { type ProviderAnswer, runVerify, TRAJECTORY, type Trajectory } from "./verify-run";

afterAll(cleanupRegisteredTestTempDirs);

const KEY = "sk-test-key-123";

/** Every file under `root`, relative to it. */
function listing(root: string, folder = root): string[] {
    return readdirSync(folder, { withFileTypes: true })
        .flatMap((entry) =>
            entry.isDirectory()
                ? listing(root, join(folder, entry.name))
                : [relative(root, join(folder, entry.name))],
        )
        .sort();
}

/**
 * A checkout with one source file and a readme, a file outside it, a link
 * out of it and a link inside it, and a recorded request in an output
 * folder.
 */
function fixture(maxSteps = 60) {
    const { dir } = createTestTempDir("verify-run-");
    const checkout = join(dir, "checkout");
    mkdirSync(join(checkout, "src"), { recursive: true });
    mkdirSync(join(checkout, "docs"), { recursive: true });
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(checkout, "src", "a.rs"), "fn alpha() {}\nfn beta() {}\nfn gamma() {}\n");
    writeFileSync(join(checkout, "docs", "readme.md"), "readme\n");
    writeFileSync(join(dir, "outside", "secret.txt"), "TOP SECRET\n");
    symlinkSync(join(dir, "outside", "secret.txt"), join(checkout, "link-out"));
    symlinkSync(join(checkout, "src", "a.rs"), join(checkout, "link-in"));
    const folder = join(dir, "out", "verify", "batch-0");
    mkdirSync(folder, { recursive: true });
    const requestPath = join(folder, "verify.request.json");
    writeFileSync(
        requestPath,
        JSON.stringify({
            task: "swe:verify",
            kind: "verify",
            batch: 0,
            model: "deepseek-flash",
            settings: { maxOutputTokens: 32000, maxSteps },
            messages: [
                { role: "system", content: "You are a memory verifier." },
                { role: "user", content: "<memories>\n[1] ARCHITECTURE\nContent: alpha exists.\n</memories>" },
            ],
        }),
    );
    return { dir, checkout, folder, requestPath };
}

/** A model that answers with `replies` in turn and records each body it was sent. */
function stub(replies: unknown[]) {
    const bodies: unknown[] = [];
    return {
        bodies,
        send: async (body: unknown): Promise<ProviderAnswer> => {
            bodies.push(structuredClone(body));
            const reply = replies.shift();
            if (reply === undefined) throw new Error("the stub has no more replies");
            if (typeof reply === "number") return { status: reply, text: "{\"error\":\"refused\"}" };
            return { status: 200, text: JSON.stringify(reply) };
        },
    };
}

function toolReply(calls: [string, Record<string, unknown>][], reasoning = "I should look.") {
    return {
        choices: [
            {
                finish_reason: "tool_calls",
                message: {
                    role: "assistant",
                    content: "",
                    reasoning_content: reasoning,
                    tool_calls: calls.map(([name, input], index) => ({
                        id: `call-${index}`,
                        type: "function",
                        function: { name, arguments: JSON.stringify(input) },
                    })),
                },
            },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 5 } },
    };
}

const MANIFEST = '<verify>\n<verified id="1" files="src/a.rs"/>\n</verify>';

function finalReply(content: string) {
    return {
        choices: [{ finish_reason: "stop", message: { role: "assistant", content, reasoning_content: "Done." } }],
        usage: { prompt_tokens: 200, completion_tokens: 30 },
    };
}

describe("verify-run", () => {
    it("runs the tool loop inside the checkout and saves every request, reply and tool call", async () => {
        const { dir, checkout, folder, requestPath } = fixture();
        const before = listing(dir);
        const model = stub([
            toolReply(
                [
                    ["read", { path: "src/a.rs", startLine: 2, endLine: 3 }],
                    ["read", { path: "../outside/secret.txt" }],
                    ["read", { path: "link-out" }],
                    ["read", { path: join(dir, "outside", "secret.txt") }],
                    ["grep", { pattern: "fn (alpha|gamma)" }],
                    ["glob", { pattern: "**/*.md" }],
                    ["read", { path: "link-in", endLine: 1 }],
                    ["read", { path: "src" }],
                    ["nosuch", {}],
                ],
                `thinking with ${KEY} in view`,
            ),
            finalReply(MANIFEST),
        ]);
        const trajectory = await runVerify({ requestPath, checkout, key: KEY, send: model.send });

        expect(trajectory.stopReason).toBe("final");
        expect(trajectory.final).toEqual({ text: MANIFEST, completeManifest: true });
        expect(trajectory.temperature).toBe(0.1);
        expect(trajectory.usage).toEqual({ promptTokens: 300, completionTokens: 50, reasoningTokens: 5 });
        const outputs = trajectory.steps[0].toolCalls.map((call) => [call.name, call.refused, call.output]);
        expect(outputs).toEqual([
            ["read", false, "2: fn beta() {}\n3: fn gamma() {}"],
            ["read", true, "refused: ../outside/secret.txt is outside the checkout"],
            ["read", true, "refused: link-out is a symlink out of the checkout"],
            ["read", true, `refused: ${join(dir, "outside", "secret.txt")} is outside the checkout`],
            [
                "grep",
                false,
                "link-in:1: fn alpha() {}\nlink-in:3: fn gamma() {}\nsrc/a.rs:1: fn alpha() {}\nsrc/a.rs:3: fn gamma() {}",
            ],
            ["glob", false, "docs/readme.md"],
            ["read", false, "1: fn alpha() {}"],
            ["read", false, "a.rs"],
            ["nosuch", true, "refused: there is no tool nosuch; the tools are read, grep and glob"],
        ]);
        expect(JSON.stringify(trajectory)).not.toContain("TOP SECRET");

        // The second request carries the first reply whole, reasoning
        // included, and each tool's output.
        const second = model.bodies[1] as { messages: Record<string, unknown>[]; tools: unknown[]; temperature: number };
        expect(second.temperature).toBe(0.1);
        expect(second.messages[2].reasoning_content).toBe(`thinking with ${KEY} in view`);
        expect(second.messages[3]).toEqual({
            role: "tool",
            tool_call_id: "call-0",
            content: "2: fn beta() {}\n3: fn gamma() {}",
        });
        expect(second.messages).toHaveLength(2 + 1 + 9);

        // The file holds what was returned, with the key redacted, and is
        // the only file the run wrote.
        const saved = readFileSync(join(folder, TRAJECTORY), "utf8");
        expect(saved).not.toContain(KEY);
        const parsed = JSON.parse(saved) as Trajectory;
        expect(parsed.steps).toHaveLength(2);
        expect(parsed.steps[1].request).toEqual(JSON.parse(JSON.stringify(model.bodies[1]).split(KEY).join("[redacted]")));
        expect((parsed.steps[0].reply as { choices: { message: { reasoning_content: string } }[] }).choices[0].message.reasoning_content).toBe(
            "thinking with [redacted] in view",
        );
        expect(listing(dir)).toEqual([...before, relative(dir, join(folder, TRAJECTORY))].sort());
    });

    it("stops at the plan's step bound when the model never answers", async () => {
        const { checkout, requestPath } = fixture(3);
        const model = stub([1, 2, 3, 4].map(() => toolReply([["read", { path: "src/a.rs" }]])));
        const trajectory = await runVerify({ requestPath, checkout, key: KEY, send: model.send });
        expect(trajectory.stopReason).toBe("step_bound");
        expect(trajectory.steps).toHaveLength(3);
        expect(trajectory.final).toBeNull();
        expect(model.bodies).toHaveLength(3);
    });

    it("records a final message without a manifest, and a provider refusal", async () => {
        const first = fixture();
        const prose = await runVerify({
            requestPath: first.requestPath,
            checkout: first.checkout,
            key: KEY,
            send: stub([finalReply("All memories hold.")]).send,
        });
        expect(prose.final).toEqual({ text: "All memories hold.", completeManifest: false });

        const second = fixture();
        const refused = await runVerify({
            requestPath: second.requestPath,
            checkout: second.checkout,
            key: KEY,
            send: stub([400]).send,
        });
        expect(refused.stopReason).toBe("provider_error");
        expect(refused.error).toBe("HTTP 400");
        expect(refused.steps[0].attempts).toHaveLength(1);
    });

    it("never overwrites a trajectory and needs a key", async () => {
        const { checkout, folder, requestPath } = fixture();
        await expect(runVerify({ requestPath, checkout, key: " ", send: stub([]).send })).rejects.toThrow(
            "no provider key on standard input",
        );
        writeFileSync(join(folder, TRAJECTORY), "{}");
        await expect(runVerify({ requestPath, checkout, key: KEY, send: stub([]).send })).rejects.toThrow(
            "already exists",
        );
        expect(readFileSync(join(folder, TRAJECTORY), "utf8")).toBe("{}");
    });

    it("reads the key from standard input and sends it only as the bearer token", async () => {
        const { checkout, folder, requestPath } = fixture();
        const seen: { authorization: string | null; body: { model: string; temperature: number } }[] = [];
        const server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            async fetch(request) {
                seen.push({
                    authorization: request.headers.get("authorization"),
                    body: (await request.json()) as { model: string; temperature: number },
                });
                return Response.json(finalReply(MANIFEST));
            },
        });
        try {
            const child = Bun.spawn(
                [
                    "bun",
                    join(import.meta.dir, "verify-run.ts"),
                    "--request",
                    requestPath,
                    "--checkout",
                    checkout,
                    "--endpoint",
                    `http://127.0.0.1:${server.port}/v1/chat/completions`,
                ],
                { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true },
            );
            child.stdin.write(`${KEY}\n`);
            await child.stdin.end();
            const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
            expect(code).toBe(0);
            expect(JSON.parse(stdout)).toMatchObject({ stopReason: "final", steps: 1, completeManifest: true });
            expect(seen).toEqual([{ authorization: `Bearer ${KEY}`, body: expect.objectContaining({ model: "deepseek-flash", temperature: 0.1 }) }]);
            expect(readFileSync(join(folder, TRAJECTORY), "utf8")).not.toContain(KEY);
        } finally {
            server.stop(true);
        }
    });
});
