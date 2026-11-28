import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { isolatedTestGitEnv } from "@magic-context/core/shared/test-git-env";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { resolveReadOnly } from "./doctor-identity-splits";

const tempDirs: string[] = [];
let savedGitEnv: NodeJS.ProcessEnv;

function replaceGitEnv(env: NodeJS.ProcessEnv): void {
    for (const key of Object.keys(process.env))
        if (key.toUpperCase().startsWith("GIT_")) delete process.env[key];
    for (const [key, value] of Object.entries(env))
        if (key.toUpperCase().startsWith("GIT_") && value !== undefined) process.env[key] = value;
}

beforeEach(() => {
    savedGitEnv = { ...process.env };
    replaceGitEnv(isolatedTestGitEnv());
});

afterEach(() => {
    replaceGitEnv(savedGitEnv);
    if (savedGitEnv.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = savedGitEnv.PATH;
    for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(directory: string, ...args: string[]): string {
    return execFileSync("git", ["-C", directory, ...args], {
        env: isolatedTestGitEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    }).trim();
}

function commit(directory: string, name: string): string {
    git(
        directory,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        name,
    );
    return git(directory, "rev-parse", "HEAD");
}

function repository(name: string): string {
    const directory = realpathSync(
        createTestTempDirFromPath(join(tmpdir(), "doctor-identity-git-")),
    );
    tempDirs.push(directory);
    git(directory, "init", "-q");
    commit(directory, name);
    return directory;
}

test("the read-only identity probe ignores GIT_DIR pointing at another checkout", () => {
    const directory = repository("requested checkout");
    const other = repository("other checkout");
    const expectedRoot = git(directory, "rev-parse", "HEAD");
    expect(git(other, "rev-parse", "HEAD")).not.toBe(expectedRoot);
    process.env.GIT_DIR = join(other, ".git");

    expect(resolveReadOnly(directory)).toBe(`git:${expectedRoot}`);
});

test("the read-only identity probe never runs a promisor remote helper to fetch a missing commit", () => {
    const directory = repository("promised history");
    const tip = commit(directory, "local tip");
    // A remote helper is a program the repository's configuration chooses. This one only
    // records that git started it; a probe that fetched would leave the marker behind.
    const helperDirectory = realpathSync(
        createTestTempDirFromPath(join(tmpdir(), "doctor-identity-helper-")),
    );
    tempDirs.push(helperDirectory);
    const marker = join(helperDirectory, "helper-ran");
    const helper = join(helperDirectory, "git-remote-fixture");
    writeFileSync(helper, `#!/bin/sh\necho called >> '${marker}'\nexit 1\n`);
    chmodSync(helper, 0o755);
    process.env.PATH = `${helperDirectory}${delimiter}${savedGitEnv.PATH ?? ""}`;
    git(directory, "config", "core.repositoryformatversion", "1");
    git(directory, "config", "extensions.partialClone", "origin");
    git(directory, "config", "remote.origin.url", "fixture::unused");
    git(directory, "config", "remote.origin.promisor", "true");
    // Repository configuration that would let the helper through a protocol.allow=never.
    git(directory, "config", "protocol.fixture.allow", "always");
    rmSync(join(directory, ".git", "objects", tip.slice(0, 2), tip.slice(2)));

    const identity = resolveReadOnly(directory);
    expect(existsSync(marker)).toBe(false);
    // Without the commit the root cannot be read; the probe must not guess one.
    expect(identity).toBeUndefined();
});
