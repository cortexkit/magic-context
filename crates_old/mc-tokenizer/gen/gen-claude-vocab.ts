/**
 * Generate the vendored Claude BPE vocab asset for the Rust mc-tokenizer crate.
 *
 * Reads the installed `ai-tokenizer/encoding/claude` (the exact encoding the TS
 * `estimateTokens` uses), unifies its dual-storage form (stringEncoder +
 * binaryEncoder) into a single bytes -> rank map, and writes it in the standard
 * tiktoken asset format (`base64(token_bytes) SP rank` per line). The Rust crate
 * embeds this via include_str! and loads it into a tiktoken-rs CoreBPE.
 *
 * ai-tokenizer is a DEV-only dependency here (this generator + the differential
 * golden). Re-run when ai-tokenizer bumps its claude encoding:
 *   bun crates/mc-tokenizer/gen/gen-claude-vocab.ts
 *
 * Source encoding: ai-tokenizer@1.0.6 encoding/claude (name="claude").
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

type StringEncoder = Record<string, number>;
type BinaryEncoder = Array<[Record<string, number>, number]>;

// ai-tokenizer is a dependency of packages/plugin (not of this Rust workspace),
// so resolve its `encoding/claude` export from the plugin package rather than
// from crates/ (Bun resolves bare specifiers from the importing file's location).
// This keeps the generator co-located with the crate it feeds and runnable from
// any cwd.
const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const claudeEntry = Bun.resolveSync("ai-tokenizer/encoding/claude", pluginDir);

async function main(): Promise<void> {
    const enc = (await import(claudeEntry)) as {
        stringEncoder: unknown;
        binaryEncoder: unknown;
    };
    const stringEncoder = enc.stringEncoder as StringEncoder;
    const binaryEncoder = enc.binaryEncoder as BinaryEncoder;

    // [ base64(bytes), rank ]
    const rows: Array<[string, number]> = [];

    for (const [str, rank] of Object.entries(stringEncoder)) {
        rows.push([Buffer.from(str, "utf8").toString("base64"), rank]);
    }
    for (const [obj, rank] of binaryEncoder) {
        // The byte object is { "0": b0, "1": b1, ... }; sort keys numerically so
        // the byte order is the token's real byte sequence.
        const bytes = Buffer.from(
            Object.keys(obj)
                .sort((a, b) => Number(a) - Number(b))
                .map((k) => obj[k]),
        );
        rows.push([bytes.toString("base64"), rank]);
    }

    // Validate before writing: contiguous-ish rank set, no duplicate ranks, all
    // 256 base bytes present (BPE base case). A silent gap/dupe would make the
    // Rust CoreBPE encode differently from ai-tokenizer.
    const ranks = rows.map((r) => r[1]);
    const rankSet = new Set(ranks);
    if (rankSet.size !== ranks.length) {
        throw new Error(`duplicate ranks: ${ranks.length - rankSet.size}`);
    }
    const singleByteCovered = new Set<number>();
    for (const [b64] of rows) {
        const b = Buffer.from(b64, "base64");
        if (b.length === 1) singleByteCovered.add(b[0]);
    }
    if (singleByteCovered.size !== 256) {
        throw new Error(`missing base bytes: ${256 - singleByteCovered.size}`);
    }

    // tiktoken asset ordering is by rank ascending (not required by the loader,
    // but keeps the asset stable + diffable across regenerations).
    rows.sort((a, b) => a[1] - b[1]);

    const body = rows.map(([b64, rank]) => `${b64} ${rank}`).join("\n");
    const outPath = join(import.meta.dir, "..", "assets", "claude.tiktoken");
    writeFileSync(outPath, `${body}\n`, "utf8");

    // eslint-disable-next-line no-console
    console.log(
        `wrote ${rows.length} vocab entries (ranks ${ranks.length ? Math.min(...ranks) : 0}..${
            ranks.length ? Math.max(...ranks) : 0
        }) -> ${outPath}`,
    );
}

main();
