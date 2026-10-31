import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import resolveVectors from "../../../../../../test-vectors/project-resolve-v1/resolve.json";
import * as logger from "../../../shared/logger";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import {
    findPinnedIdentityByGitCommonDir,
    projectDirectoryKey,
    pruneMissingProjectIdentities,
    readRememberedGitIdentity,
    readRememberedProjectIdentity,
    rememberGitIdentity,
    rememberPinnedProjectIdentity,
} from "./project-identity-cache";
import {
    __setProjectPinWriterForTests,
    flushProjectPinWrites,
    ProjectPinWriter,
} from "./project-pin-writer";

let storageDir: string;
let testRoot: string;
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
const originalDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    testRoot = createTestTempDirFromPath(join(tmpdir(), "mc-identity-cache-"));
    storageDir = join(testRoot, "cortexkit", "magic-context");
    fs.mkdirSync(storageDir, { recursive: true });
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = testRoot;
    process.env.XDG_DATA_HOME = testRoot;
});

afterEach(async () => {
    await __setProjectPinWriterForTests();
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    fs.rmSync(testRoot, { recursive: true, force: true });
});

function writeRecord(directory: string, identity: unknown, gitCommonDir?: string): string {
    const hash = createHash("sha256").update(projectDirectoryKey(directory)).digest("hex");
    const file = join(storageDir, "project-identities", `${hash}.json`);
    fs.mkdirSync(join(storageDir, "project-identities"), { recursive: true });
    fs.writeFileSync(
        file,
        JSON.stringify({ directory: projectDirectoryKey(directory), identity, gitCommonDir }),
    );
    return file;
}

describe("project identity sidecars", () => {
    test.each([
        "pj-A",
        "pj-abc_123-XYZ",
    ])("accepts an exact-directory %s pin with optional common dir", (identity) => {
        const directory = join(storageDir, "project");
        writeRecord(directory, identity, "/metadata/repo.git");
        expect(readRememberedProjectIdentity(directory, storageDir)).toEqual({
            directory,
            identity,
            gitCommonDir: "/metadata/repo.git",
        });
        expect(readRememberedGitIdentity(directory, storageDir)).toBeUndefined();
        expect(readRememberedProjectIdentity(join(directory, "sub"), storageDir)).toBeUndefined();
        writeRecord(directory, identity);
        expect(readRememberedProjectIdentity(directory, storageDir)).toEqual({
            directory,
            identity,
        });
    });

    test.each([
        "pj-",
        "pj-spaces not allowed",
        "pj-a.b",
        "pj-a/b",
        "pj-a\n",
        42,
        null,
    ])("rejects invalid identity %j", (identity) => {
        const directory = join(storageDir, "project");
        writeRecord(directory, identity);
        expect(readRememberedProjectIdentity(directory, storageDir)).toBeUndefined();
    });

    test("ignores an implicit sidecar and logs once across exact reads and scans", () => {
        const log = spyOn(logger, "log").mockImplementation(() => {});
        try {
            const directory = join(storageDir, "project");
            const commonDir = join(storageDir, "metadata");
            writeRecord(directory, "pj-implicit1-30f9d5fcd6aa4ef2", commonDir);
            expect(readRememberedProjectIdentity(directory)).toBeUndefined();
            expect(readRememberedProjectIdentity(directory)).toBeUndefined();
            expect(findPinnedIdentityByGitCommonDir(commonDir)).toBeUndefined();
            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0]?.[0]).toContain("ignoring implicit project identity sidecar");
        } finally {
            log.mockRestore();
        }
    });

    test("keeps legacy git validation and exact directory checks", () => {
        const directory = join(storageDir, "project");
        rememberGitIdentity(directory, "git:abc1234");
        expect(readRememberedGitIdentity(directory)).toBe("git:abc1234");
        const file = writeRecord(directory, "git:ABC1234");
        expect(readRememberedGitIdentity(directory)).toBeUndefined();
        fs.writeFileSync(
            file,
            JSON.stringify({ directory: `${directory}/other`, identity: "pj-A" }),
        );
        expect(readRememberedProjectIdentity(directory)).toBeUndefined();
        fs.writeFileSync(file, "{broken");
        expect(readRememberedProjectIdentity(directory)).toBeUndefined();
    });

    test("a legacy git write never replaces a pj pin's bytes", () => {
        const directory = join(storageDir, "project");
        const file = writeRecord(directory, "pj-A", "/metadata/repo.git");
        const before = fs.readFileSync(file, "utf8");
        rememberGitIdentity(directory, "git:abc1234");
        expect(fs.readFileSync(file, "utf8")).toBe(before);
    });

    test("a live pin replaces a legacy git record but never another pin", async () => {
        const directory = join(storageDir, "project");
        const file = writeRecord(directory, "git:abc1234");
        rememberPinnedProjectIdentity(directory, "pj-A", "/metadata/repo.git");
        expect(readRememberedProjectIdentity(directory)?.identity).toBe("pj-A");
        expect(await flushProjectPinWrites(2_000)).toBe(true);
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
            directory: projectDirectoryKey(directory),
            identity: "pj-A",
            gitCommonDir: "/metadata/repo.git",
        });
        const before = fs.readFileSync(file, "utf8");
        rememberPinnedProjectIdentity(directory, "pj-B", "/metadata/other.git");
        expect(await flushProjectPinWrites(2_000)).toBe(true);
        expect(fs.readFileSync(file, "utf8")).toBe(before);
    });

    test("pending process pins override disk records but completed publications yield to durable replacements", async () => {
        let finish!: () => void;
        const writer = new ProjectPinWriter(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        await __setProjectPinWriterForTests(writer);
        const directory = join(storageDir, "project");
        writeRecord(directory, "git:abc1234", "/metadata/repo.git");
        rememberPinnedProjectIdentity(directory, "pj-A", "/metadata/repo.git");
        expect(readRememberedProjectIdentity(directory)?.identity).toBe("pj-A");
        expect(findPinnedIdentityByGitCommonDir("/metadata/repo.git")).toBe("pj-A");
        await Promise.resolve();
        await Promise.resolve();
        finish();
        expect(await writer.flush(100)).toBe(true);
        writeRecord(directory, "pj-STALE", "/metadata/repo.git");
        rememberGitIdentity(directory, "git:fffffff");
        // Once the write completes, another process's durable replacement is authoritative.
        expect(readRememberedProjectIdentity(directory)?.identity).toBe("pj-STALE");
        expect(findPinnedIdentityByGitCommonDir("/metadata/repo.git")).toBe("pj-STALE");
    });

    test("neither sidecar writer persists an implicit id or an invalid identity", () => {
        const directory = join(storageDir, "project");
        const implicit = resolveVectors[3].reply.result;
        if (!implicit) throw new Error("Missing implicit resolve vector");
        for (const identity of [implicit.projectId, "pj-a/b", "dir:abc1234"]) {
            rememberPinnedProjectIdentity(directory, identity);
            rememberGitIdentity(directory, identity);
        }
        expect(fs.existsSync(join(storageDir, "project-identities"))).toBe(false);
    });
});

describe("common-dir pin matching", () => {
    test("scans every json once, returns one distinct pin, and writes nothing", () => {
        const commonDir = join(storageDir, "metadata", "repo.git");
        writeRecord(join(storageDir, "unrelated-checkout-name"), "pj-A", commonDir);
        writeRecord(join(storageDir, "duplicate"), "pj-A", commonDir);
        writeRecord(join(storageDir, "legacy"), "git:abc1234", commonDir);
        writeRecord(join(storageDir, "different"), "pj-B", `${commonDir}-other`);
        const dir = join(storageDir, "project-identities");
        fs.writeFileSync(join(dir, "broken.json"), "{broken");
        fs.writeFileSync(
            join(dir, "ignored.txt"),
            JSON.stringify({ directory: "/ignored", identity: "pj-C", gitCommonDir: commonDir }),
        );
        const before = new Map(
            fs.readdirSync(dir).map((file) => [file, fs.readFileSync(join(dir, file), "utf8")]),
        );
        const reads = spyOn(fs, "readFileSync");
        const scans = spyOn(fs, "readdirSync");
        try {
            expect(findPinnedIdentityByGitCommonDir(commonDir, storageDir)).toBe("pj-A");
            expect(scans).toHaveBeenCalledTimes(1);
            const paths = reads.mock.calls.map(([file]) => String(file));
            expect(paths.sort()).toEqual(
                [...before.keys()]
                    .filter((file) => file.endsWith(".json"))
                    .map((file) => join(dir, file))
                    .sort(),
            );
        } finally {
            reads.mockRestore();
            scans.mockRestore();
        }
        expect(
            new Map(
                fs.readdirSync(dir).map((file) => [file, fs.readFileSync(join(dir, file), "utf8")]),
            ),
        ).toEqual(before);
    });

    test("conflicting distinct pins return no match and log only once", () => {
        const commonDir = join(storageDir, "metadata");
        writeRecord(join(storageDir, "a"), "pj-A", commonDir);
        writeRecord(join(storageDir, "b"), "pj-B", commonDir);
        const log = spyOn(logger, "log").mockImplementation(() => {});
        try {
            expect(findPinnedIdentityByGitCommonDir(commonDir)).toBeUndefined();
            expect(findPinnedIdentityByGitCommonDir(commonDir)).toBeUndefined();
            expect(log).toHaveBeenCalledTimes(1);
            expect(log.mock.calls[0]?.[0]).toContain("conflicting project pins");
        } finally {
            log.mockRestore();
        }
    });

    test("missing sidecar directory and nonmatching canonical spelling give no match", () => {
        expect(findPinnedIdentityByGitCommonDir("/missing", storageDir)).toBeUndefined();
        writeRecord(join(storageDir, "a"), "pj-A", "/metadata/repo.git");
        expect(findPinnedIdentityByGitCommonDir("/metadata/repo.git/", storageDir)).toBeUndefined();
    });
});

test("maintenance prunes only identity records whose directory is definitely ENOENT", async () => {
    const root = testRoot;
    const projects = ["gone", "live", "denied", "io-error", "not-directory"].map((name) =>
        join(root, name),
    );
    const stat = fs.promises.stat.bind(fs);
    let probe: ReturnType<typeof spyOn> | undefined;
    try {
        for (const directory of projects) {
            fs.mkdirSync(directory);
            rememberGitIdentity(directory, "git:abcdef1234");
        }
        fs.rmSync(projects[0]!, { recursive: true });
        const records = await fs.promises.readdir(join(storageDir, "project-identities"));
        const goneRecord = records
            .map((name) => join(storageDir, "project-identities", name))
            .find((file) => JSON.parse(fs.readFileSync(file, "utf8")).directory === projects[0]);
        probe = spyOn(fs.promises, "stat").mockImplementation(((directory: string) => {
            const code =
                directory === projects[2]
                    ? "EACCES"
                    : directory === projects[3]
                      ? "EIO"
                      : directory === projects[4]
                        ? "ENOTDIR"
                        : undefined;
            if (code) return Promise.reject(Object.assign(new Error(code), { code }));
            return stat(directory);
        }) as typeof fs.promises.stat);
        const removed = await pruneMissingProjectIdentities();
        expect(removed).toBe(1);
        expect(fs.existsSync(goneRecord!)).toBe(false);
        for (const directory of projects.slice(1))
            expect(readRememberedGitIdentity(directory)).toBe("git:abcdef1234");
    } finally {
        probe?.mockRestore();
    }
});
