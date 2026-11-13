import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeTestExecutable } from "@magic-context/core/shared/test-fake-executable";
import {
    cleanupTestTempDir,
    createTestTempDirFromPath,
} from "@magic-context/core/shared/test-temp-dir";
import {
    getAvailableModels,
    getPiCommandInvocation,
    getPiVersion,
    parseModelListOutput,
} from "./pi-helpers";

const originalComSpec = process.env.ComSpec;

afterEach(() => {
    if (originalComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = originalComSpec;
});

const HEADER = "provider      model                context  max-out  thinking  images";

describe("parseModelListOutput", () => {
    it("parses validated rows below the models table header", () => {
        const output = [
            HEADER,
            "anthropic     claude-fable-5       1M       128K     yes       yes",
            "openai-codex  gpt-5.5              400K     128K     yes       yes",
            "opencode-go   kimi-k2.6            262.1K   65.5K    yes       yes",
        ].join("\n");
        expect(parseModelListOutput(output)).toEqual([
            "anthropic/claude-fable-5",
            "openai-codex/gpt-5.5",
            "opencode-go/kimi-k2.6",
        ]);
    });

    it("allows provider-qualified model ids in the model column", () => {
        const output = [HEADER, "openrouter anthropic/claude-sonnet-4 200K 64K yes no"].join("\n");
        expect(parseModelListOutput(output)).toEqual(["openrouter/anthropic/claude-sonnet-4"]);
    });

    it("ignores headings, prose, and rows before a recognized header", () => {
        const output = [
            "Available models:",
            "anthropic claude-fake 1M 128K yes yes",
            HEADER,
            "Documentation is available online now",
            "anthropic claude-real 1M 128K yes yes",
        ].join("\n");
        expect(parseModelListOutput(output)).toEqual(["anthropic/claude-real"]);
    });

    it("requires the expected metadata columns", () => {
        const output = [
            HEADER,
            "anthropic claude-prose words that look plausible here",
            "anthropic claude-real 1M 128K yes no",
        ].join("\n");
        expect(parseModelListOutput(output)).toEqual(["anthropic/claude-real"]);
    });

    it("dedupes rows and strips ANSI color codes", () => {
        const esc = String.fromCharCode(27);
        const output = [
            HEADER,
            `${esc}[32manthropic${esc}[0m claude-opus-4-8 1M 128K yes yes`,
            "anthropic claude-opus-4-8 1M 128K yes yes",
        ].join("\n");
        expect(parseModelListOutput(output)).toEqual(["anthropic/claude-opus-4-8"]);
    });
});

describe("Pi command execution", () => {
    // Spawns three real subprocesses; under heavy machine load (parallel release
    // gates) the default 5s test timeout produced false reds. The subprocesses
    // are trivial shell scripts, so a generous ceiling costs nothing when idle.
    it("routes cmd shims through ComSpec and parses their output", () => {
        // Shared content-addressed stub (see writeTestExecutable); never deleted per test.
        const comSpec = writeTestExecutable(
            "fake-cmd",
            `#!/bin/sh\nif [ "$5" = "--version" ]; then\n  printf '0.75.1\\n'\nelse\n  printf '${HEADER}\\nanthropic claude-fable-5 1M 128K yes yes\\n'\nfi\n`,
        );
        process.env.ComSpec = comSpec;
        const shim = join(dirname(comSpec), "pi.cmd");

        expect(getPiCommandInvocation(shim, ["--version"])).toEqual({
            command: comSpec,
            args: ["/d", "/s", "/c", shim, "--version"],
        });
        expect(getPiVersion(shim)).toBe("0.75.1");
        expect(getAvailableModels(shim)).toEqual(["anthropic/claude-fable-5"]);
    }, 30_000);

    it("invokes a POSIX binary directly", () => {
        expect(getPiCommandInvocation("/usr/local/bin/pi", ["--version"])).toEqual({
            command: "/usr/local/bin/pi",
            args: ["--version"],
        });
    });
});

describe("getAvailableModels", () => {
    it("returns [] when pi output parses to no models (no static fallback)", () => {
        const piPath = process.platform === "win32" ? "where" : "true";
        expect(getAvailableModels(piPath)).toEqual([]);
    });

    // Any other words reach Pi as a prompt and start a billed session.
    it.skipIf(process.platform === "win32")(
        "runs only `pi --list-models`, once, even when it lists nothing",
        () => {
            const dir = createTestTempDirFromPath(join(tmpdir(), "pi-model-list-args"));
            const log = join(dir, "args.log");
            const pi = writeTestExecutable(
                "fake-pi-recording-args",
                `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_ARGS_LOG"\n`,
            );
            process.env.PI_ARGS_LOG = log;
            try {
                expect(getAvailableModels(pi)).toEqual([]);
                expect(readFileSync(log, "utf-8")).toBe("--list-models\n");
            } finally {
                delete process.env.PI_ARGS_LOG;
                cleanupTestTempDir(dir);
            }
        },
        30_000,
    );
});
