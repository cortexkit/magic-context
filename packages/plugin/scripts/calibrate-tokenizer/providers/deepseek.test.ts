import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeOfflineCounts } from "./deepseek";
import { resolveModelCalibration } from "../../../src/hooks/magic-context/tokenizer-calibration";
import { createTestTempDir } from "../../../src/shared/test-temp-dir";

it("runs the offline Python protocol without remote loading or special tokens", () => {
    const { dir: directory, cleanup } = createTestTempDir("calibration-python-test-");
    try {
        writeFileSync(join(directory, "transformers.py"), `
class AutoTokenizer:
    @staticmethod
    def from_pretrained(path, *, trust_remote_code, local_files_only):
        assert trust_remote_code is True
        assert local_files_only is True
        return AutoTokenizer()
    def encode(self, text, *, add_special_tokens):
        assert add_special_tokens is False
        return list(text)
`);
        const result = spawnSync("python3", [fileURLToPath(new URL("./deepseek-offline.py", import.meta.url)), directory], {
            input: JSON.stringify({ system: "abcd", tools: "[]", prose: "abc", "section:docs": "hi" }),
            encoding: "utf8", env: { ...process.env, PYTHONPATH: directory }, timeout: 10_000, windowsHide: true,
        });
        expect(result.status).toBe(0);
        expect(decodeOfflineCounts(result.stdout)).toEqual({ system: 4, tools: 2, prose: 3, "section:docs": 2 });
    } finally { cleanup(); }
});

it("reports missing offline dependencies and never invents V4 calibration from V3", () => {
    expect(() => decodeOfflineCounts('{"skip":"install transformers in a venv"}')).toThrow("SKIP: install transformers in a venv");
    expect(() => decodeOfflineCounts('{"counts":{"system":null}}')).toThrow();
    expect(resolveModelCalibration("deepseek", "deepseek-v4-flash")).toEqual({ systemRatio: 1, toolsRatio: 1, proseRatio: 1 });
    expect(resolveModelCalibration("fireworks-ai", "accounts/fireworks/models/deepseek-v3p2")).toMatchObject({ systemRatio: 1.05, toolsRatio: 1.09, proseRatio: 1 });
});
