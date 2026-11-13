import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CountAdapter, functionTools, requireCount } from "./counting";

export const OFFLINE_CAVEAT = "Offline HF raw-text counts without special tokens or a provider chat template; no API model availability or billed-usage equivalence is claimed.";

export function decodeOfflineCounts(output: string): Record<string, number> {
    const result = JSON.parse(output) as { skip?: string; counts?: Record<string, unknown> };
    if (result.skip) throw new Error(`SKIP: ${result.skip}`);
    if (!result.counts) throw new Error("Offline tokenizer returned no counts");
    return Object.fromEntries(Object.entries(result.counts).map(([name, count]) => [name, requireCount(count)]));
}

/** Stage only tokenizer data in node_modules scratch, never in tracked fixtures. */
export const measureDeepseekOffline: CountAdapter = async (_model, _key, system, tools, prose) => {
    const source = process.env.DEEPSEEK_TOKENIZER_DIR || join(homedir(), "Downloads/deepseek_v4_tokenizer");
    const files = ["tokenizer.json", "tokenizer_config.json"];
    if (files.some((file) => !existsSync(join(source, file)))) throw new Error("SKIP: missing DeepSeek V4 tokenizer.json or tokenizer_config.json");
    const scratchRoot = fileURLToPath(new URL("../../../node_modules/.cache/calibrate-tokenizer/", import.meta.url));
    mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(join(scratchRoot, "deepseek-v4-"));
    const hashes: Record<string, string> = {};
    for (const file of files) {
        copyFileSync(join(source, file), join(scratch, file));
        hashes[file] = createHash("sha256").update(readFileSync(join(scratch, file))).digest("hex");
    }
    const probes = {
        system, tools: JSON.stringify(functionTools(tools).map((tool) => ({ type: "function", function: tool }))),
        prose: Object.values(prose).join("\n\n"),
        ...Object.fromEntries(Object.entries(prose).map(([name, text]) => [`section:${name}`, text])),
    };
    const processResult = spawnSync(process.env.DEEPSEEK_TOKENIZER_PYTHON || "python3", [fileURLToPath(new URL("./deepseek-offline.py", import.meta.url)), scratch], {
        input: JSON.stringify(probes), encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }, windowsHide: true,
    });
    if (processResult.error || processResult.status !== 0) throw new Error("SKIP: offline Python tokenizer subprocess unavailable or failed");
    const counts = decodeOfflineCounts(processResult.stdout);
    const sections = Object.fromEntries(Object.keys(prose).map((name) => [name, requireCount(counts[`section:${name}`])]));
    return { method: "offline_hf_tokenizer", systemApi: requireCount(counts.system), toolsApi: requireCount(counts.tools), proseApi: requireCount(counts.prose), sections, caveat: `${OFFLINE_CAVEAT} Tokenizer SHA-256: ${JSON.stringify(hashes)}` };
};
