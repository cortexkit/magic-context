import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveNpmRegistry } from "./resolve-npm-registry";

const REGISTRY_KEY = "npm_config_registry";
const originalRegistry = process.env[REGISTRY_KEY];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

const scratchRoots: string[] = [];

function makeScratchDir(): string {
    const dir = join(tmpdir(), `mc-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    scratchRoots.push(dir);
    return dir;
}

function clearRegistryEnv(): void {
    delete process.env[REGISTRY_KEY];
}

describe("resolveNpmRegistry", () => {
    afterEach(() => {
        clearRegistryEnv();
        if (originalRegistry !== undefined) process.env[REGISTRY_KEY] = originalRegistry;
        if (originalHome !== undefined) process.env.HOME = originalHome;
        if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
        for (const dir of scratchRoots.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("env var wins over everything", () => {
        const project = makeScratchDir();
        writeFileSync(join(project, ".npmrc"), "registry = https://mirror.example.test/npm/\n");
        process.env[REGISTRY_KEY] = "https://env.example.test/npm/";

        expect(resolveNpmRegistry(project)).toBe("https://env.example.test/npm");
    });

    test("project .npmrc wins over user .npmrc", () => {
        clearRegistryEnv();
        const project = makeScratchDir();
        const home = makeScratchDir();
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        writeFileSync(join(project, ".npmrc"), "registry=https://project.example.test/npm/\n");
        writeFileSync(join(home, ".npmrc"), "registry=https://user.example.test/npm/\n");

        expect(resolveNpmRegistry(project)).toBe("https://project.example.test/npm");
    });

    test("user .npmrc is used when the project has no .npmrc", () => {
        clearRegistryEnv();
        const project = makeScratchDir();
        const home = makeScratchDir();
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        writeFileSync(join(home, ".npmrc"), "registry=https://user.example.test/npm/\n");

        expect(resolveNpmRegistry(project)).toBe("https://user.example.test/npm");
    });

    test("falls back to the public default when nothing is configured", () => {
        clearRegistryEnv();
        const project = makeScratchDir();
        const home = makeScratchDir();
        process.env.HOME = home;
        process.env.USERPROFILE = home;

        expect(resolveNpmRegistry(project)).toBe("https://registry.npmjs.org");
    });

    test("trailing slashes are trimmed", () => {
        clearRegistryEnv();
        process.env[REGISTRY_KEY] = "https://env.example.test/npm///";

        expect(resolveNpmRegistry(null)).toBe("https://env.example.test/npm");
    });

    test("comment lines and scoped-registry keys are ignored", () => {
        clearRegistryEnv();
        process.env.HOME = "";
        process.env.USERPROFILE = "";
        const project = makeScratchDir();
        writeFileSync(
            join(project, ".npmrc"),
            [
                "# operator comment",
                "; another comment",
                "@cortexkit:registry=https://scoped.example.test/npm/",
                "",
            ].join("\n"),
        );

        expect(resolveNpmRegistry(project)).toBe("https://registry.npmjs.org");
    });

    test("a malformed .npmrc fails open to the default", () => {
        clearRegistryEnv();
        process.env.HOME = "";
        process.env.USERPROFILE = "";
        const project = makeScratchDir();
        // A directory named .npmrc makes readFileSync throw.
        mkdirSync(join(project, ".npmrc"), { recursive: true });

        expect(resolveNpmRegistry(project)).toBe("https://registry.npmjs.org");
    });

    test("a null project directory skips the project file", () => {
        clearRegistryEnv();
        const home = makeScratchDir();
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        writeFileSync(join(home, ".npmrc"), "registry=https://user.example.test/npm/\n");

        expect(resolveNpmRegistry(null)).toBe("https://user.example.test/npm");
    });
});
