import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const LSOF_DEB = {
    url: "https://deb.debian.org/debian/pool/main/l/lsof/lsof_4.95.0-1_amd64.deb",
    // Verified against Debian bookworm's official Packages index over HTTPS.
    sha256: "e4b15cf8d0b9051cf7957e7ab29a67ca7d21f42ea1b2b7dad1b52e65d02d1408",
};

type Result = { code: number; stdout: string; stderr: string };
export type ToolHost = {
    which: (name: string) => string | null;
    run: (args: string[]) => Result;
    download: (url: string) => Promise<Uint8Array>;
    platform: string;
    arch: string;
    log?: (message: string) => void;
};
const system: ToolHost = {
    which: (name) => Bun.which(name),
    run: (args) => {
        const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
        return {
            code: result.exitCode,
            stdout: result.stdout.toString(),
            stderr: result.stderr.toString(),
        };
    },
    download: async (url) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
        return new Uint8Array(await response.arrayBuffer());
    },
    platform: process.platform,
    arch: process.arch,
};

export function gitAncestor(
    path: string,
    exists: (path: string) => boolean = existsSync,
): string | undefined {
    let cursor = resolve(path);
    for (;;) {
        if (exists(join(cursor, ".git"))) return cursor;
        const parent = dirname(cursor);
        if (parent === cursor) return undefined;
        cursor = parent;
    }
}

export async function createTestHome(base = tmpdir()): Promise<string> {
    const home = await realpath(await mkdtemp(join(base, "mc-gate-home-")));
    const repository = gitAncestor(home);
    if (repository)
        throw new Error(
            `Temporary HOME has Git ancestor ${repository}; set TMPDIR outside all repositories`,
        );
    return home;
}

export function verifyDownload(bytes: Uint8Array, expected: string): void {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected)
        throw new Error(`lsof package SHA-256 mismatch: expected ${expected}, got ${actual}`);
}

export function missingLibraries(output: string): string[] {
    return [...output.matchAll(/(\S+)\s+=>\s+not found/g)].map((match) => match[1]!);
}

export function requiredTools(mode: string, part: string): string[] {
    if (mode === "smoke")
        return [
            "bash",
            "bun",
            "git",
            "curl",
            "which",
            "mktemp",
            "sleep",
            "seq",
            "grep",
            "cat",
            "uname",
            "rm",
        ];
    if (mode === "preflight")
        return [
            "bash",
            "sh",
            "git",
            "bun",
            "node",
            "python3",
            "cargo",
            "rustc",
            "rustfmt",
            "timeout",
            "tar",
            "diff",
        ];
    const tools = [
        "bash",
        "sh",
        "git",
        "bun",
        "node",
        "npm",
        "python3",
        "cargo",
        "rustc",
        "rustfmt",
        "tar",
        "sha256sum",
        "timeout",
        "curl",
        "ps",
        "diff",
        "cp",
        "chmod",
        "mktemp",
        "tr",
        "sleep",
        "seq",
        "uname",
        "grep",
        "dirname",
        "mkdir",
        "ln",
        "rm",
        "find",
        "touch",
    ];
    if (part === "all" || part === "native") tools.push("cc", "make", "pkg-config");
    if (part === "all" || part === "host") tools.push("pgrep", "script", "stty");
    return tools;
}

export async function prepareTestTools(
    root: string,
    mode: string,
    part: string,
    nodeMajor: string,
    nextestVersion: string,
    host: ToolHost = system,
    packagePin = LSOF_DEB,
): Promise<string | undefined> {
    const print = host.log ?? console.log;
    const missing = requiredTools(mode, part).filter((name) => !host.which(name));
    if (missing.length) throw new Error(`Missing OS prerequisites: ${missing.join(", ")}`);
    if (mode !== "smoke") {
        const node = host.run(["node", "--version"]);
        if (node.code || !node.stdout.trim().startsWith(`v${nodeMajor}.`))
            throw new Error(
                `Node ${nodeMajor} required by CI; found ${node.stdout.trim() || node.stderr}`,
            );
        print(`PASS Node prerequisite: ${node.stdout.trim()} (CI major ${nodeMajor})`);
        if (mode === "full" && (part === "all" || part === "native")) {
            const nextest = host.run(["cargo", "nextest", "--version"]);
            if (
                nextest.code ||
                nextest.stdout.trim().split(/\s+/).slice(0, 2).join(" ") !==
                    `cargo-nextest ${nextestVersion}`
            )
                throw new Error(
                    `cargo-nextest ${nextestVersion} required by CI: ${nextest.stdout}${nextest.stderr}`,
                );
        }
    }
    print(`PASS OS prerequisites: ${requiredTools(mode, part).join(", ")}`);
    if (mode !== "full") return undefined;
    for (const optional of ["sqlite3", "mkfifo", "expect"])
        print(
            `Conditional test tool ${optional}: ${host.which(optional) ?? "not installed; recovery, FIFO, or key-capture scenarios may require it"}`,
        );
    const available = host.which("lsof");
    if (available) {
        const version = host.run([available, "-v"]);
        if (version.code)
            throw new Error(
                `lsof runtime failed at ${available}: ${version.stdout}${version.stderr}`,
            );
        if (
            !/lsof version information|revision:\s*\d/i.test(`${version.stdout}\n${version.stderr}`)
        )
            throw new Error(`lsof at ${available} did not identify its version`);
        print(`PASS test prerequisite lsof: ${available} (installed)`);
        return undefined;
    }
    if (host.platform !== "linux" || host.arch !== "x64")
        throw new Error("Missing lsof; automatic Debian bootstrap supports Linux x64 only");
    for (const tool of ["dpkg-deb", "ldd"])
        if (!host.which(tool)) throw new Error(`Missing ${tool}, required to bootstrap real lsof`);
    let bytes: Uint8Array;
    try {
        bytes = await host.download(packagePin.url);
    } catch (error) {
        throw new Error(
            `Missing lsof and its pinned package could not be fetched; use a networked job or install lsof: ${error}`,
        );
    }
    verifyDownload(bytes, packagePin.sha256);
    const parent = join(root, "target/scratch/lsof");
    await mkdir(parent, { recursive: true });
    const dir = await mkdtemp(join(parent, "job-"));
    const archive = join(dir, "lsof.deb");
    await writeFile(archive, bytes);
    const extracted = host.run(["dpkg-deb", "-x", archive, dir]);
    if (extracted.code)
        throw new Error(`lsof extraction failed: ${extracted.stdout}${extracted.stderr}`);
    const binary = join(dir, "usr/bin/lsof");
    const libraries = host.run(["ldd", binary]);
    const absent = missingLibraries(`${libraries.stdout}\n${libraries.stderr}`);
    if (absent.length) throw new Error(`lsof runtime libraries missing: ${absent.join(", ")}`);
    if (libraries.code)
        throw new Error(`lsof dependency check failed: ${libraries.stdout}${libraries.stderr}`);
    const version = host.run([binary, "-v"]);
    if (version.code)
        throw new Error(`lsof runtime failed at ${binary}: ${version.stdout}${version.stderr}`);
    if (!/lsof version information|revision:\s*\d/i.test(`${version.stdout}\n${version.stderr}`))
        throw new Error(`lsof at ${binary} did not identify its version`);
    print(
        `PASS test prerequisite lsof: ${binary} (verified ${packagePin.url}, SHA-256 ${packagePin.sha256})`,
    );
    return join(dir, "usr/bin");
}
