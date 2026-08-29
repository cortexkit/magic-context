/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

const MEMORY_SURFACES = [
    "<project-memory>",
    "<user-profile>",
    "<new-user-profile>",
    "<memory-updates>",
    "<memory-mural>",
] as const;

function expectMemorySuppressed(wire: string): void {
    for (const surface of MEMORY_SURFACES) expect(wire).not.toContain(surface);
}

function expectMemoryToolSuppressed(body: Record<string, unknown>): void {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    expect(
        tools.some((tool) =>
            /ctx_memory/.test(String((tool as { name?: unknown })?.name ?? "")),
        ),
    ).toBe(false);
}

describe.skipIf(!rustPrereqs.ok)("TS/Rust parity: memory-off served wire", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            startInTsMode: true,
            magicContextConfig: { memory: { enabled: false } },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("suppresses every memory-derived surface in both transform lanes", async () => {
        const sessionId = await h.createSession();

        await h.sendPrompt(sessionId, "TS memory-off assertion");
        const tsBody = [...h.requests()]
            .reverse()
            .find((request) => JSON.stringify(request.body.messages ?? []).includes("TS memory-off assertion"))
            ?.body;
        expect(tsBody).toBeDefined();
        if (!tsBody) throw new Error("TS memory-off request was not captured");
        expectMemoryToolSuppressed(tsBody);
        expectMemorySuppressed(h.lastMainWireSerialized());

        await h.restart({ rust: true, magicContextConfig: { memory: { enabled: false } } });
        await h.sendPrompt(sessionId, "Rust memory-off assertion");
        const rustBody = [...h.requests()]
            .reverse()
            .find((request) =>
                JSON.stringify(request.body.messages ?? []).includes("Rust memory-off assertion"),
            )?.body;
        expect(rustBody).toBeDefined();
        if (!rustBody) throw new Error("Rust memory-off request was not captured");
        expectMemoryToolSuppressed(rustBody);
        expectMemorySuppressed(h.lastMainWireSerialized());
    }, 180_000);
});
