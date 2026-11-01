import "./quiet-live-log";
/**
 * Vendor the historian SYSTEM prompt from the TS source of truth.
 *
 * The TS side generates historian-prompt.generated.ts from historian-prompt.source.md;
 * this script re-exports that exact string as a committed text asset so the Rust
 * producer sends byte-identical system-prompt bytes. Never edit the .txt by hand.
 *
 * Run:         bun crates/mc-module/gen/gen-historian-system-prompt.ts
 * Drift check: bun crates/mc-module/gen/gen-historian-system-prompt.ts --check
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);
const mod = (await import(
    resolve("./src/hooks/magic-context/historian-prompt.generated")
)) as Record<string, unknown>;

const candidates = Object.entries(mod).filter(
    ([, v]) => typeof v === "string" && (v as string).length > 10_000,
);
if (candidates.length !== 1) {
    throw new Error(
        `expected exactly one large prompt export, found: ${candidates.map(([k]) => k).join(", ") || "none"}`,
    );
}
const prompt = candidates[0][1] as string;

const path = join(import.meta.dir, "..", "testdata", "historian-system-prompt.txt");
if (process.argv.includes("--check")) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== prompt) {
        throw new Error(
            "historian system prompt drift; run bun crates/mc-module/gen/gen-historian-system-prompt.ts",
        );
    }
} else {
    writeFileSync(path, prompt);
}
