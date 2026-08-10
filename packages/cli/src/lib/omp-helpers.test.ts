import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    detectOmpBinary,
    getOmpCommandInvocation,
    getOmpFallbackCandidates,
    parseOmpModelsOutput,
    runOmpCommand,
} from "./omp-helpers";

const originalPath = process.env.PATH;
const originalPackageDir = process.env.PI_PACKAGE_DIR;
const originalHome = process.env.HOME;
const roots: string[] = [];

afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = originalPackageDir;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OMP binary discovery", () => {
    /** A real OMP package root plus a fake `bun` on PATH; HOME has no OMP. */
    function makePackageRoot(): { root: string; binDir: string } {
        const root = mkdtempSync(join(tmpdir(), "mc-omp-package-"));
        roots.push(root);
        const binDir = join(root, "bin");
        mkdirSync(join(root, "pkg", "dist"), { recursive: true });
        mkdirSync(binDir, { recursive: true });
        writeFileSync(
            join(root, "pkg", "package.json"),
            JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }),
        );
        writeFileSync(join(root, "pkg", "dist", "cli.js"), "");
        writeFileSync(join(binDir, "bun"), "#!/bin/sh\n");
        chmodSync(join(binDir, "bun"), 0o755);
        process.env.HOME = join(root, "home");
        process.env.PI_PACKAGE_DIR = join(root, "pkg");
        return { root, binDir };
    }

    it("honors a validated PI_PACKAGE_DIR install root when Bun can run it", () => {
        const { root, binDir } = makePackageRoot();
        process.env.PATH = binDir;

        expect(detectOmpBinary()).toEqual({
            path: join(root, "pkg", "dist", "cli.js"),
            source: "package",
        });
    });

    it("ignores the package root when no Bun runtime can execute the CLI script", () => {
        const { root } = makePackageRoot();
        process.env.PATH = join(root, "empty-bin");

        expect(detectOmpBinary()).toBeNull();
    });

    it("routes a package CLI script through Bun instead of spawning it directly", () => {
        const { root, binDir } = makePackageRoot();
        process.env.PATH = binDir;
        const cli = join(root, "pkg", "dist", "cli.js");

        expect(getOmpCommandInvocation(cli, ["--version"])).toEqual({
            command: join(binDir, "bun"),
            args: [cli, "--version"],
        });
    });

    it("leaves a native OMP binary path untouched", () => {
        const { binDir } = makePackageRoot();
        process.env.PATH = binDir;

        expect(getOmpCommandInvocation("/usr/bin/omp", ["config", "path"])).toEqual({
            command: "/usr/bin/omp",
            args: ["config", "path"],
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
