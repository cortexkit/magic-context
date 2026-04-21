import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

import { substituteConfigVariables } from "./variable";

describe("substituteConfigVariables", () => {
    const ORIGINAL_ENV = { ...process.env };
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "mc-variable-test-"));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
        process.env = { ...ORIGINAL_ENV };
    });

    describe("env substitution", () => {
        it("replaces {env:VAR} with process.env value", () => {
            process.env.MC_TEST_KEY = "sk-real-value";
            const input = `{ "api_key": "{env:MC_TEST_KEY}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "sk-real-value" }`);
            expect(result.warnings).toHaveLength(0);
        });

        it("trims whitespace inside env token", () => {
            process.env.MC_TEST_KEY = "trimmed-value";
            const input = `{ "api_key": "{env: MC_TEST_KEY }" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "trimmed-value" }`);
            expect(result.warnings).toHaveLength(0);
        });

        it("emits warning and empty string for missing env var", () => {
            delete process.env.MC_MISSING_VAR;
            const input = `{ "api_key": "{env:MC_MISSING_VAR}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "" }`);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toContain("MC_MISSING_VAR");
            expect(result.warnings[0]).toContain("not set");
        });

        it("emits warning for empty-string env var", () => {
            process.env.MC_EMPTY = "";
            const input = `{ "api_key": "{env:MC_EMPTY}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "" }`);
            expect(result.warnings).toHaveLength(1);
        });

        it("passes {env:} literally through (matches OpenCode regex: at least one char required)", () => {
            const input = `{ "api_key": "{env:}" }`;

            const result = substituteConfigVariables({ text: input });

            // The regex `{env:([^}]+)}` requires ≥1 char between the colon and
            // brace. An empty `{env:}` is not a valid token and passes through
            // to be parsed as literal JSONC text.
            expect(result.text).toBe(input);
            expect(result.warnings).toHaveLength(0);
        });

        it("handles multiple env tokens in one text", () => {
            process.env.MC_A = "alpha";
            process.env.MC_B = "beta";
            const input = `{ "a": "{env:MC_A}", "b": "{env:MC_B}", "c": "{env:MC_MISSING}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "a": "alpha", "b": "beta", "c": "" }`);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toContain("MC_MISSING");
        });
    });

    describe("file substitution", () => {
        it("inlines file contents for absolute path", () => {
            const keyFile = join(tmpDir, "key.txt");
            writeFileSync(keyFile, "sk-from-file\n");
            const input = `{ "api_key": "{file:${keyFile}}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "sk-from-file" }`);
            expect(result.warnings).toHaveLength(0);
        });

        it("resolves relative path against configPath directory", () => {
            const keyFile = join(tmpDir, "key.txt");
            writeFileSync(keyFile, "relative-value");
            const configPath = join(tmpDir, "magic-context.jsonc");

            const input = `{ "api_key": "{file:./key.txt}" }`;
            const result = substituteConfigVariables({ text: input, configPath });

            expect(result.text).toBe(`{ "api_key": "relative-value" }`);
            expect(result.warnings).toHaveLength(0);
        });

        it("resolves relative path without leading ./", () => {
            const keyFile = join(tmpDir, "key.txt");
            writeFileSync(keyFile, "no-dot-slash");
            const configPath = join(tmpDir, "magic-context.jsonc");

            const input = `{ "api_key": "{file:key.txt}" }`;
            const result = substituteConfigVariables({ text: input, configPath });

            expect(result.text).toBe(`{ "api_key": "no-dot-slash" }`);
        });

        it("expands ~/ to home directory", () => {
            const input = `{ "marker": "{file:~/__mc-never-exists-${Date.now()}}" }`;

            const result = substituteConfigVariables({ text: input });

            // File doesn't exist, so warning fires — but warning must show it
            // resolved under homedir, proving the ~ expansion happened.
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toContain(homedir() + sep);
        });

        it("JSON-escapes quotes and newlines in file contents", () => {
            const keyFile = join(tmpDir, "multiline.txt");
            writeFileSync(keyFile, 'line1 with "quote"\nline2');
            const input = `{ "value": "{file:${keyFile}}" }`;

            const result = substituteConfigVariables({ text: input });

            // Escaped so the outer JSONC string still parses cleanly.
            expect(result.text).toBe(`{ "value": "line1 with \\"quote\\"\\nline2" }`);
            const parsed = JSON.parse(result.text);
            expect(parsed.value).toBe('line1 with "quote"\nline2');
        });

        it("emits warning and empty string for missing file", () => {
            const missing = join(tmpDir, "never-exists.txt");
            const input = `{ "api_key": "{file:${missing}}" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "" }`);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toContain("not found");
            expect(result.warnings[0]).toContain(missing);
        });

        it("passes {file:} literally through (matches OpenCode regex: at least one char required)", () => {
            const input = `{ "api_key": "{file:}" }`;

            const result = substituteConfigVariables({ text: input });

            // Same reasoning as {env:} — empty token pattern doesn't match.
            expect(result.text).toBe(input);
            expect(result.warnings).toHaveLength(0);
        });

        it("preserves {file:} tokens inside // line comments", () => {
            const keyFile = join(tmpDir, "key.txt");
            writeFileSync(keyFile, "should-not-appear");
            const input = [
                `{`,
                `    // see docs: {file:${keyFile}}`,
                `    "other": "value"`,
                `}`,
            ].join("\n");

            const result = substituteConfigVariables({ text: input });

            // Token inside comment stays literal — only active values substitute.
            expect(result.text).toContain(`// see docs: {file:${keyFile}}`);
            expect(result.text).not.toContain("should-not-appear");
            expect(result.warnings).toHaveLength(0);
        });
    });

    describe("combined substitution", () => {
        it("handles env and file tokens together", () => {
            process.env.MC_COMBINED = "env-val";
            const keyFile = join(tmpDir, "combined.txt");
            writeFileSync(keyFile, "file-val");

            const input = `{ "e": "{env:MC_COMBINED}", "f": "{file:${keyFile}}" }`;
            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "e": "env-val", "f": "file-val" }`);
            expect(result.warnings).toHaveLength(0);
        });

        it("env tokens inside {file:} path expand before file read", () => {
            // Tokens are substituted left-to-right in passes: env first, then
            // file. So an env var naming a file path gets resolved during file
            // substitution.
            process.env.MC_FILE_DIR = tmpDir;
            const keyFile = join(tmpDir, "indirect.txt");
            writeFileSync(keyFile, "indirect-value");

            const input = `{ "api_key": "{file:{env:MC_FILE_DIR}/indirect.txt}" }`;
            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(`{ "api_key": "indirect-value" }`);
        });
    });

    describe("no-op cases", () => {
        it("returns text unchanged when no tokens present", () => {
            const input = `{ "api_key": "literal-value", "provider": "openai-compatible" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(input);
            expect(result.warnings).toHaveLength(0);
        });

        it("leaves partial patterns like {env alone", () => {
            const input = `{ "note": "this {env is not a token" }`;

            const result = substituteConfigVariables({ text: input });

            expect(result.text).toBe(input);
            expect(result.warnings).toHaveLength(0);
        });
    });
});
