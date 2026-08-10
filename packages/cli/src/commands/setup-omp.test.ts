import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { PromptIO, PromptSpinner, SelectOption } from "../lib/prompts";
import { __test } from "./setup-omp";

class MockPrompts implements PromptIO {
    readonly messages: string[] = [];
    constructor(private readonly confirms: boolean[]) {}
    readonly log = {
        info: (message: string) => this.messages.push(`info:${message}`),
        success: (message: string) => this.messages.push(`success:${message}`),
        warn: (message: string) => this.messages.push(`warn:${message}`),
        error: (message: string) => this.messages.push(`error:${message}`),
        message: (message: string) => this.messages.push(`message:${message}`),
        step: (message: string) => this.messages.push(`step:${message}`),
    };
    intro(): void {}
    outro(): void {}
    note(): void {}
    spinner(): PromptSpinner {
        return { start: () => {}, stop: () => {}, message: () => {} };
    }
    async confirm(): Promise<boolean> {
        const value = this.confirms.shift();
        if (value === undefined) throw new Error("missing confirm response");
        return value;
    }
    async text(): Promise<string> {
        return "";
    }
    async selectOne(_message: string, options: SelectOption[]): Promise<string> {
        return options[0]?.value ?? "";
    }
    async selectMany(_message: string, options: SelectOption[]): Promise<string[]> {
        return options.map((option) => option.value);
    }
    async selectAutocomplete(_message: string, options: SelectOption[]): Promise<string> {
        return options[0]?.value ?? "";
    }
}

const roots: string[] = [];
const original = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PI_CONFIG_FILES: process.env.PI_CONFIG_FILES,
};

afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeFakeOmp(options: { failMemorySet?: boolean } = {}): {
    root: string;
    binary: string;
    state: string;
} {
    const root = mkdtempSync(join(tmpdir(), "mc-omp-setup-"));
    roots.push(root);
    const state = join(root, "state.json");
    const binary = join(root, "omp");
    writeFileSync(state, JSON.stringify({ compaction: true, memory: "mnemopi" }));
    writeFileSync(
        binary,
        `#!/usr/bin/env node
const fs = require("fs");
const statePath = ${JSON.stringify(state)};
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const failMemorySet = ${JSON.stringify(options.failMemorySet === true)};
const args = process.argv.slice(2);
if (args[0] === "config" && args[1] === "get") {
  const value = args[2] === "compaction.enabled" ? state.compaction : state.memory;
  process.stdout.write(JSON.stringify({ value }));
} else if (args[0] === "config" && args[1] === "set") {
  if (args[2] === "compaction.enabled") state.compaction = args[3] === "true";
  else {
    if (failMemorySet) {
      process.stderr.write("memory set failed");
      process.exit(1);
    }
    state.memory = args[3];
  }
  fs.writeFileSync(statePath, JSON.stringify(state));
} else if (args[0] === "plugin" && args[1] === "list") {
  process.stdout.write(JSON.stringify({ npm: [], marketplace: [] }));
}
`,
    );
    chmodSync(binary, 0o755);
    process.env.PATH = [root, original.PATH].filter(Boolean).join(delimiter);
    process.env.HOME = root;
    return { root, binary, state };
}

describe("OMP setup transaction", () => {
    it("restores native settings when a later setup step rolls back", async () => {
        const { root, binary, state } = makeFakeOmp();
        const prompts = new MockPrompts([true, true]);
        const rollback = await __test.OMP_HOST.beforeWrite?.({
            binaryPath: binary,
            cwd: root,
            prompts,
            dryRun: false,
            configureHost: true,
        });
        expect(typeof rollback).toBe("function");
        expect(JSON.parse(readFileSync(state, "utf-8"))).toEqual({
            compaction: false,
            memory: "off",
        });

        if (typeof rollback === "function") await rollback();
        expect(JSON.parse(readFileSync(state, "utf-8"))).toEqual({
            compaction: true,
            memory: "mnemopi",
        });
    });

    it("automatically restores an earlier setting when a later write fails", async () => {
        const { root, binary, state } = makeFakeOmp({ failMemorySet: true });
        const prompts = new MockPrompts([true, true]);

        const result = await __test.OMP_HOST.beforeWrite?.({
            binaryPath: binary,
            cwd: root,
            prompts,
            dryRun: false,
            configureHost: true,
        });

        expect(result).toBe(false);
        expect(JSON.parse(readFileSync(state, "utf-8"))).toEqual({
            compaction: true,
            memory: "mnemopi",
        });
        expect(prompts.messages.join("\n")).toContain("memory set failed");
        expect(prompts.messages.join("\n")).toContain("Restored OMP compaction.enabled=true");
    });

    it("does not change native settings when registration is skipped and plugin is absent", async () => {
        const { root, binary, state } = makeFakeOmp();
        const prompts = new MockPrompts([]);
        const rollback = await __test.OMP_HOST.beforeWrite?.({
            binaryPath: binary,
            cwd: root,
            prompts,
            dryRun: false,
            configureHost: false,
        });
        expect(typeof rollback).toBe("function");
        expect(JSON.parse(readFileSync(state, "utf-8"))).toEqual({
            compaction: true,
            memory: "mnemopi",
        });
    });

    it("refuses global setting writes when a project OMP config is active", async () => {
        const { binary, state } = makeFakeOmp();
        const cwd = mkdtempSync(join(tmpdir(), "mc-omp-project-"));
        roots.push(cwd);
        mkdirSync(join(cwd, ".omp"), { recursive: true });
        writeFileSync(join(cwd, ".omp", "config.yml"), "compaction:\n  enabled: true\n");
        const prompts = new MockPrompts([true, true]);

        const result = await __test.OMP_HOST.beforeWrite?.({
            binaryPath: binary,
            cwd,
            prompts,
            dryRun: false,
            configureHost: true,
        });

        expect(result).toBe(false);
        expect(JSON.parse(readFileSync(state, "utf-8"))).toEqual({
            compaction: true,
            memory: "mnemopi",
        });
        expect(prompts.messages.join("\n")).toContain("refusing to mutate the global config");
    });

    it("refuses global setting writes when PI_CONFIG_FILES overlays are active", async () => {
        const { binary, state } = makeFakeOmp();
        const cwd = mkdtempSync(join(tmpdir(), "mc-omp-overlay-"));
        roots.push(cwd);
        process.env.PI_CONFIG_FILES = "settings/omp.yml";
        const prompts = new MockPrompts([true, true]);

        const result = await __test.OMP_HOST.beforeWrite?.({
            binaryPath: binary,
            cwd,
            prompts,
            dryRun: false,
            configureHost: true,
        });

        expect(result).toBe(false);
        expect(JSON.parse(readFileSync(state, "utf-8"))).toEqual({
            compaction: true,
            memory: "mnemopi",
        });
        expect(prompts.messages.join("\n")).toContain(join(cwd, "settings", "omp.yml"));
    });
});
