import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { estimateTokens, tokenCountUsesByteBound } from "./read-session-formatting";

it("ordinary long repository texts retain exact whole-text BPE counts", () => {
    const require = createRequire(import.meta.url);
    const module = require("ai-tokenizer");
    const Tokenizer = module.default ?? module.Tokenizer;
    const whole = new Tokenizer(require("ai-tokenizer/encoding/claude"));
    const paths = [
        "assets/magic-context.schema.json",
        "crates/mc-module/testdata/decay-golden.json",
        "ARCHITECTURE.md",
        "CONFIGURATION.md",
        "packages/plugin/src/hooks/magic-context/host-runner/opencode-adapter.ts",
        "packages/pi-plugin/src/context-handler.ts",
    ];
    for (const path of paths) {
        const text = readFileSync(
            fileURLToPath(new URL(`../../../../../${path}`, import.meta.url)),
            "utf8",
        );
        expect(text.length, path).toBeGreaterThan(4096);
        expect(text.length, path).toBeLessThanOrEqual(1024 * 1024);
        expect(tokenCountUsesByteBound(text), path).toBe(false);
        expect(estimateTokens(text), path).toBe(whole.encode(text, "all").length);
    }
});
