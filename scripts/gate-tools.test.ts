import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
    createTestHome,
    gitAncestor,
    LSOF_DEB,
    missingLibraries,
    prepareTestTools,
    requiredTools,
    type ToolHost,
    verifyDownload,
} from "./gate-tools";

const root = resolve(import.meta.dir, "..");
const abc = new TextEncoder().encode("abc");
const fixturePin = {
    url: "https://example.invalid/lsof.deb",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
};

function host(overrides: Partial<ToolHost> = {}) {
    const calls: string[][] = [];
    let downloads = 0;
    const tools: ToolHost = {
        which: (name) => (name === "lsof" ? null : `/tools/${name}`),
        run: (args) => {
            calls.push([...args]);
            if (args[0] === "node") return { code: 0, stdout: "v24.21.0\n", stderr: "" };
            if (args[0] === "cargo")
                return { code: 0, stdout: "cargo-nextest 0.9.138\n", stderr: "" };
            if (args[0] === "ldd")
                return { code: 0, stdout: "libtirpc.so.3 => /lib/libtirpc.so.3\n", stderr: "" };
            return { code: 0, stdout: "", stderr: "lsof version information: revision: 4.95.0\n" };
        },
        download: async () => {
            downloads++;
            return abc;
        },
        platform: "linux",
        arch: "x64",
        log: () => {},
        ...overrides,
    };
    return { tools, calls, downloads: () => downloads };
}

async function scratch(body: (path: string) => Promise<void>) {
    await mkdir(join(root, "target/scratch"), { recursive: true });
    const path = await mkdtemp(join(root, "target/scratch/gate-tools-"));
    try {
        await body(path);
    } finally {
        await rm(path, { recursive: true, force: true });
    }
}

test("official lsof acquisition pins the expected Debian artifact, not its freshly computed hash", () => {
    expect(LSOF_DEB.url).toBe(
        "https://deb.debian.org/debian/pool/main/l/lsof/lsof_4.95.0-1_amd64.deb",
    );
    expect(LSOF_DEB.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => verifyDownload(abc, fixturePin.sha256)).not.toThrow();
    expect(() =>
        verifyDownload(new TextEncoder().encode("different bytes"), fixturePin.sha256),
    ).toThrow("SHA-256 mismatch");
});

test("OS prerequisites follow the selected lanes without requiring Docker-only or optional tools", () => {
    expect(requiredTools("full", "native")).toContain("cc");
    expect(requiredTools("full", "host")).toContain("pgrep");
    expect(requiredTools("full", "host")).toContain("script");
    expect(requiredTools("full", "unit")).not.toContain("which");
    expect(requiredTools("full", "unit")).not.toContain("unzip");
    for (const mode of ["full", "preflight", "smoke"])
        expect(requiredTools(mode, "all")).not.toContain("docker");
    expect(requiredTools("smoke", "all")).not.toContain("cargo");
    expect(requiredTools("preflight", "all")).not.toContain("lsof");
});

test("missing tools fail before any download or command execution", async () => {
    const fixture = host({ which: (name) => (name === "git" ? null : `/tools/${name}`) });
    await expect(prepareTestTools(root, "full", "unit", "24", "", fixture.tools)).rejects.toThrow(
        "Missing OS prerequisites: git",
    );
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.downloads()).toBe(0);
});

test("installed lsof is used without downloading or changing PATH", async () => {
    const fixture = host({ which: (name) => `/installed/${name}` });
    expect(await prepareTestTools(root, "full", "unit", "24", "", fixture.tools)).toBeUndefined();
    expect(fixture.downloads()).toBe(0);
    expect(fixture.calls).toContainEqual(["/installed/lsof", "-v"]);
});

test("an installed command must identify itself as real lsof", async () => {
    const fixture = host({ which: (name) => `/installed/${name}` });
    const previous = fixture.tools.run;
    fixture.tools.run = (args) =>
        args[0] === "/installed/lsof" ? { code: 0, stdout: "", stderr: "" } : previous(args);
    await expect(prepareTestTools(root, "full", "unit", "24", "", fixture.tools)).rejects.toThrow(
        "did not identify its version",
    );
});

test("network-less lsof acquisition fails with the missing tool named", async () => {
    const fixture = host({
        download: async () => {
            throw new Error("network disabled");
        },
    });
    await expect(prepareTestTools(root, "full", "unit", "24", "", fixture.tools)).rejects.toThrow(
        "Missing lsof",
    );
    expect(fixture.calls.some((args) => args[0] === "dpkg-deb")).toBe(false);
});

test("bad archive bytes are rejected before extraction or execution", async () => {
    const fixture = host({ download: async () => new TextEncoder().encode("tampered") });
    await expect(
        prepareTestTools(root, "full", "unit", "24", "", fixture.tools, fixturePin),
    ).rejects.toThrow("SHA-256 mismatch");
    expect(fixture.calls.some((args) => args[0] === "dpkg-deb")).toBe(false);
});

test("verified archives are extracted and runtime-tested before their bin directory is returned", async () =>
    scratch(async (path) => {
        const fixture = host();
        const prefix = await prepareTestTools(
            path,
            "full",
            "unit",
            "24",
            "",
            fixture.tools,
            fixturePin,
        );
        expect(prefix).toContain("target/scratch/lsof/job-");
        expect(prefix).toEndWith("usr/bin");
        expect(fixture.calls.some((args) => args[0] === "dpkg-deb" && args[1] === "-x")).toBe(true);
        expect(fixture.calls.some((args) => args[0] === "ldd")).toBe(true);
        expect(fixture.calls.some((args) => args[0] === `${prefix}/lsof` && args[1] === "-v")).toBe(
            true,
        );
    }));

test("missing lsof runtime libraries fail by name before running the binary", async () =>
    scratch(async (path) => {
        const fixture = host();
        const previous = fixture.tools.run;
        fixture.tools.run = (args) =>
            args[0] === "ldd"
                ? { code: 0, stdout: "libtirpc.so.3 => not found\n", stderr: "" }
                : previous(args);
        await expect(
            prepareTestTools(path, "full", "unit", "24", "", fixture.tools, fixturePin),
        ).rejects.toThrow("libtirpc.so.3");
        expect(fixture.calls.some((args) => args[0]?.endsWith("/lsof"))).toBe(false);
        expect(missingLibraries("liba.so => not found\nlibb.so => /lib/libb.so\n")).toEqual([
            "liba.so",
        ]);
    }));

test("runtime versions are read from CI rather than silently accepting a different Node or Nextest", async () => {
    const fixture = host();
    await expect(prepareTestTools(root, "full", "unit", "22", "", fixture.tools)).rejects.toThrow(
        "Node 22 required by CI",
    );
    await expect(
        prepareTestTools(root, "full", "native", "24", "0.0.1", fixture.tools),
    ).rejects.toThrow("cargo-nextest 0.0.1 required by CI");
});

test("a runtime HOME must not inherit a checkout's Git identity", async () =>
    scratch(async (path) => {
        expect(
            gitAncestor("/workspace/target/home", (candidate) => candidate === "/workspace/.git"),
        ).toBe("/workspace");
        expect(gitAncestor("/job-temp/home", () => false)).toBeUndefined();
        await expect(createTestHome(path)).rejects.toThrow("set TMPDIR outside all repositories");
    }));

test("raw replay fetches the pinned baseline without writing the source Git metadata", async () =>
    scratch(async (path) => {
        const source = join(path, "source");
        const remote = join(path, "remote.git");
        const runtime = join(path, "runtime");
        await mkdir(source);
        await mkdir(runtime);
        const git = (...args: string[]) => {
            const result = Bun.spawnSync(["git", ...args], {
                cwd: source,
                stdout: "pipe",
                stderr: "pipe",
            });
            expect(result.exitCode, result.stderr.toString()).toBe(0);
            return result.stdout.toString().trim();
        };
        git("init", "-q");
        for (const relative of [
            "crates/mc-module/src",
            "packages/plugin/src",
            "packages/retina-local-fs/src",
            "scripts",
        ])
            await mkdir(join(source, relative), { recursive: true });
        await writeFile(
            join(source, "crates/mc-module/src/baseline.rs"),
            "fn baseline_marker() {}\n",
        );
        await writeFile(
            join(source, "packages/plugin/src/baseline.ts"),
            "export const baseline = true;\n",
        );
        await writeFile(
            join(source, "packages/retina-local-fs/src/baseline.ts"),
            "export const baseline = true;\n",
        );
        for (const relative of [
            "package.json",
            "packages/plugin/package.json",
            "packages/retina-local-fs/package.json",
        ])
            await writeFile(join(source, relative), "{}\n");
        git("add", "--all");
        git(
            "-c",
            "user.name=Gate test",
            "-c",
            "user.email=gate-test@localhost",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "baseline",
        );
        const baseline = git("rev-parse", "HEAD");
        await writeFile(join(source, "crates/mc-module/src/baseline.rs"), "fn changed_tip() {}\n");
        git("add", "--all");
        git(
            "-c",
            "user.name=Gate test",
            "-c",
            "user.email=gate-test@localhost",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "different tip",
        );
        git("clone", "--bare", source, remote);
        git("remote", "add", "origin", `file://${remote}`);
        await writeFile(join(source, "scripts/rust-raw-replay-baseline.commit"), `${baseline}\n`);
        expect(existsSync(join(source, ".git/FETCH_HEAD"))).toBe(false);
        const child = Bun.spawn(
            [
                "bash",
                join(root, "scripts/ci/rust-raw-replay-review-fetch-pinned-master-baseline.sh"),
            ],
            {
                cwd: source,
                env: { ...process.env, GITHUB_WORKSPACE: source, RUNNER_TEMP: runtime },
                stdout: "pipe",
                stderr: "pipe",
            },
        );
        const error = await new Response(child.stderr).text();
        expect(await child.exited, error).toBe(0);
        expect(existsSync(join(source, ".git/FETCH_HEAD"))).toBe(false);
        const archive = Bun.spawnSync(
            [
                "tar",
                "-xOf",
                join(runtime, "rust-raw-replay-baseline.tar"),
                "crates/mc-module/src/baseline.rs",
            ],
            { stdout: "pipe", stderr: "pipe" },
        );
        expect(archive.exitCode, archive.stderr.toString()).toBe(0);
        expect(archive.stdout.toString()).toBe("fn baseline_marker() {}\n");
    }));

test("package-scoped Bun checks keep the storage-leak guard without scanning archived fixtures", async () =>
    scratch(async (path) => {
        const fixture = join(path, "archived/context.db");
        await mkdir(join(path, "archived"));
        await writeFile(fixture, "archived fixture, not a test-created package store\n");
        const file = join(path, "minimal.test.ts");
        await writeFile(
            file,
            'import { test, expect } from "bun:test"; test("scope probe", () => expect(1).toBe(1));\n',
        );
        const run = async (cwd: string) => {
            const child = Bun.spawn(
                ["bun", "test", "--preload", join(root, "packages/plugin/test-preload.ts"), file],
                { cwd, env: process.env, stdout: "pipe", stderr: "pipe" },
            );
            const [code, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            return { code, text: stdout + stderr };
        };
        const overlyBroad = await run(root);
        expect(overlyBroad.code).not.toBe(0);
        expect(overlyBroad.text).toContain("Test storage leaked into the package directory");
        expect(overlyBroad.text).toContain(fixture);
        const scoped = await run(join(root, "packages/e2e-tests"));
        expect(scoped.code, scoped.text).toBe(0);
        expect(scoped.text).toContain("1 pass");
    }));
