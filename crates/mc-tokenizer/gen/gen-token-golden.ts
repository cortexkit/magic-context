/**
 * Generate the differential token golden for the Rust mc-tokenizer crate.
 *
 * For a diverse corpus, emits each string with ai-tokenizer's EXACT ordinary
 * token-ID sequence (encode(_, "all"), which is byte-BPE with no special
 * handling — see the crate docs). The Rust `token_golden` test asserts
 * `encode_ordinary(s) == ids` for every case, which proves the port's merges are
 * bit-identical to ai-tokenizer (stronger than matching the count alone).
 *
 * ai-tokenizer is a DEV-only dependency (resolved from packages/plugin, like the
 * vocab generator). Re-run alongside gen-claude-vocab.ts when ai-tokenizer bumps:
 *   bun crates/mc-tokenizer/gen/gen-token-golden.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const claudeEntry = Bun.resolveSync("ai-tokenizer/encoding/claude", pluginDir);
const tokenizerEntry = Bun.resolveSync("ai-tokenizer", pluginDir);

interface GoldenCase {
    label: string;
    text: string;
    ids: number[];
}

async function main(): Promise<void> {
    const enc = await import(claudeEntry);
    const { default: Tokenizer } = await import(tokenizerEntry);
    const tk = new Tokenizer(enc);
    const encode = (text: string): number[] => Array.from(tk.encode(text, "all"));

    // A deliberately adversarial corpus: the merge-sensitive and byte-boundary
    // cases where a naive port would diverge from ai-tokenizer.
    const corpus: Array<[string, string]> = [
        ["empty", ""],
        ["single-space", " "],
        ["ascii-basic", "hello world"],
        ["sentence-punct", "The quick brown fox jumps over the lazy dog."],
        ["contractions", "I'm sure it's you've done well, they'll see, we're 'ready'."],
        ["leading-space-word", " leadingspace"],
        ["multi-space-run", "a    b\t\tc\n\nd"],
        ["trailing-whitespace", "trailing   "],
        ["digits-runs", "1234567890 42 007 3.14159 1,000,000"],
        ["mixed-alnum", "abc123def456 v2 gpt-5.5 claude-4"],
        ["punct-runs", "!!! ??? ... --- +++ === //// |||| ***"],
        ["symbols", "a→b + c // d | e \\ f ~ g @ h # i $ j % k ^"],
        ["code-snippet", "const x = foo(bar, baz).map((y) => y * 2);"],
        ["json-blob", '{"key":"value","n":42,"arr":[1,2,3],"nested":{"a":true}}'],
        ["path-like", "/Users/foo/Work/Projects/CortexKit/magic-context/src/x.ts"],
        ["special-substrings", "before <EOT> mid <META_START> after <SOS> end"],
        ["special-adjacent", "<EOT><META><META_START><META_END><SOS>"],
        ["unicode-accents", "café résumé naïve Zürich piñata Malmö"],
        ["cjk", "你好世界 これはテストです 안녕하세요 世界"],
        ["emoji", "hello 👋 world 🌍 rocket 🚀 family 👨‍👩‍👧‍👦 flag 🏳️‍🌈"],
        ["cyrillic-greek", "Привет мир αβγδε Ελληνικά Русский"],
        ["mixed-script", "user说hello и café🚀 test123"],
        ["newlines-heavy", "line1\nline2\n\nline3\n\n\nline4\r\nwindows"],
        ["repeated-token", "the the the the the the the the"],
        ["long-word", "supercalifragilisticexpialidocious"],
        ["url", "https://docs.cortexkit.io/magic-context/reference/configuration/?q=x&y=1"],
        [
            "prose-paragraph",
            "Magic Context rewrites the message array on every LLM call to keep a long " +
                "session inside the context window without losing history. Durable SQLite " +
                "state, never ephemeral; if storage is unavailable the plugin fails closed.",
        ],
        ["rtl-arabic-hebrew", "مرحبا بالعالم שלום עולם mixed العربية with English"],
        ["combining-marks", "e\u0301 a\u0300 n\u0303 o\u0308 cafe\u0301 A\u030a\u0301"],
        ["zero-width", "a\u200bb\u200cc\u200dd\ufeffe word\u00a0nbsp"],
        ["control-chars", "tab\tvertical\x0bform\x0cbell text"],
        ["surrogate-pairs", "𝕳𝖊𝖑𝖑𝖔 𝟙𝟚𝟛 🄰🄱🄲 𐍈 𠀀𠀁"],
        ["repeated-char-run", `${"a".repeat(300)} ${"=".repeat(100)} ${" ".repeat(50)}x`],
        [
            "session-chunk",
            "U: Can you fix the tagger perf issue?\nA: I traced it to tag.initFromDb " +
                "reloading all 105k rows every pass. TC: read({filePath:'tagger.ts',startLine:1," +
                "endLine:80}) -> loaded 80 lines. The floor-scoped query is 2.8µs vs 32ms full scan.",
        ],
        [
            "stack-trace",
            "Error: QuickJSUseAfterFree\n    at Lifetime.assertAlive (quickjs.ts:412:11)\n" +
                "    at QuickJSContext.getProp (context.ts:88:5)\n    at <anonymous>:1:1",
        ],
        [
            "large-mixed-blob",
            Array.from({ length: 40 }, (_, i) =>
                `Line ${i}: the quick brown fox (café ${i * 3.14}) 你好 🚀 {"k":${i}} https://x.io/${i}`,
            ).join("\n"),
        ],
    ];

    const cases: GoldenCase[] = corpus.map(([label, text]) => ({
        label,
        text,
        ids: encode(text),
    }));

    const outPath = join(import.meta.dir, "..", "testdata", "token-golden.json");
    writeFileSync(outPath, `${JSON.stringify(cases, null, 2)}\n`, "utf8");

    const totalToks = cases.reduce((n, c) => n + c.ids.length, 0);
    // eslint-disable-next-line no-console
    console.log(`wrote ${cases.length} golden cases (${totalToks} total tokens) -> ${outPath}`);
}

main();
