import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    detectOmpBinary,
    getOmpFallbackCandidates,
    parseOmpModelsOutput,
    runOmpCommand,
} from "./omp-helpers";

const originalPath = process.env.PATH;
const originalPackageDir = process.env.PI_PACKAGE_DIR;
const roots: string[] = [];

afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = originalPackageDir;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OMP binary discovery", () => {
    it("honors a validated PI_PACKAGE_DIR install root", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-omp-package-"));
        roots.push(root);
        mkdirSync(join(root, "dist"), { recursive: true });
        writeFileSync(
            join(root, "package.json"),
            JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }),
        );
        writeFileSync(join(root, "dist", "cli.js"), "");
        process.env.PATH = "";
        process.env.PI_PACKAGE_DIR = root;

        expect(detectOmpBinary()).toEqual({
            path: join(root, "dist", "cli.js"),
            source: "package",
        });
    });
});

describe("OMP fallback discovery", () => {
    it("covers standard Windows npm and Bun install directories", () => {
        const home = "C:\\Users\\fox";
        const appData = "C:\\Users\\fox\\AppData\\Roaming";
        expect(getOmpFallbackCandidates("win32", home, appData)).toEqual([
            join(appData, "npm", "omp.cmd"),
            join(appData, "npm", "omp.exe"),
            join(home, ".bun", "bin", "omp.exe"),
            join(home, ".bun", "bin", "omp.cmd"),
        ]);
    });
});

describe("OMP model discovery", () => {
    it("parses model selectors without flattening scoped or nested IDs", () => {
        const output = JSON.stringify({
            models: [
                {
                    provider: "anthropic",
                    id: "claude-opus",
                    selector: "anthropic/claude-opus",
                },
                {
                    provider: "modal",
                    id: "@modal/qwen/model-v1",
                    selector: "modal/@modal/qwen/model-v1",
                },
                { provider: "openai", id: "fallback/model" },
            ],
        });

        expect(parseOmpModelsOutput(output)).toEqual([
            "anthropic/claude-opus",
            "modal/@modal/qwen/model-v1",
            "openai/fallback/model",
        ]);
    });
});

describe("OMP command execution", () => {
    it("preserves spawn timeout errors when stderr is empty", () => {
        const result = runOmpCommand(process.execPath, ["-e", "while (true) {}"], 10);
        expect(result.ok).toBe(false);
        expect(result.stderr.length).toBeGreaterThan(0);
    });

    it("captures JSON-sized output above Node's default buffer", () => {
        const result = runOmpCommand(process.execPath, [
            "-e",
            "process.stdout.write('x'.repeat(2 * 1024 * 1024))",
        ]);
        expect(result.ok).toBe(true);
        expect(result.stdout.length).toBe(2 * 1024 * 1024);
    });
});
