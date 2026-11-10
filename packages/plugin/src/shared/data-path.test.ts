import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    ensureCortexKitArtifactGitignore,
    getCacheDir,
    getDataDir,
    getLegacyOpenCodeMagicContextStorageDir,
    getMagicContextLogPath,
    getMagicContextStorageDir,
    getMagicContextStorageResolution,
    getOpenCodeCacheDir,
    getOpenCodeStorageDir,
    getProjectMagicContextDir,
    getProjectMagicContextHistorianDir,
    isMagicContextStorageOutsideEngram,
} from "./data-path";
import * as logger from "./logger";
import { createTestTempDirFromPath } from "./test-temp-dir";

const savedEnv = {
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    MAGIC_CONTEXT_STORAGE_DIR: process.env.MAGIC_CONTEXT_STORAGE_DIR,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    MAGIC_CONTEXT_LOG_PATH: process.env.MAGIC_CONTEXT_LOG_PATH,
    MAGIC_CONTEXT_TEST_DATA_DIR: process.env.MAGIC_CONTEXT_TEST_DATA_DIR,
    NODE_ENV: process.env.NODE_ENV,
};

describe("data-path", () => {
    beforeEach(() => {
        process.env.XDG_CACHE_HOME = undefined;
        process.env.XDG_DATA_HOME = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        delete process.env.NODE_ENV;
        process.env.LOCALAPPDATA = undefined;
        process.env.MAGIC_CONTEXT_LOG_PATH = undefined;
        // Bun's env handling: explicit delete for unset
        delete process.env.XDG_CACHE_HOME;
        delete process.env.XDG_DATA_HOME;
        delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
        delete process.env.LOCALAPPDATA;
        delete process.env.MAGIC_CONTEXT_LOG_PATH;
    });

    afterEach(() => {
        // Restore-or-delete every var this suite touches. Several tests lift a
        // guard (NODE_ENV, MAGIC_CONTEXT_TEST_DATA_DIR) to assert production
        // shape, so a restore that skips the unset case would leak state into
        // the next test and make results order-dependent.
        for (const [key, value] of Object.entries(savedEnv)) {
            if (value !== undefined) process.env[key] = value;
            else delete process.env[key];
        }
    });

    test("getCacheDir falls back to <homedir>/.cache when XDG_CACHE_HOME is unset (all platforms)", () => {
        // Matches OpenCode's xdg-basedir behavior on every platform, including
        // Windows. A previous bug mapped Windows to %LOCALAPPDATA% and caused
        // doctor --force to target a non-existent cache directory.
        expect(getCacheDir()).toBe(path.join(os.homedir(), ".cache"));
    });

    test("getCacheDir honors XDG_CACHE_HOME when set", () => {
        process.env.XDG_CACHE_HOME = "/tmp/custom-cache";
        expect(getCacheDir()).toBe("/tmp/custom-cache");
    });

    test("getCacheDir ignores LOCALAPPDATA on Windows (must match OpenCode's xdg-basedir)", () => {
        // Even with LOCALAPPDATA set, cache must go to ~/.cache to match
        // OpenCode's own resolution. Otherwise doctor --force clears the
        // wrong directory on Windows.
        process.env.LOCALAPPDATA = "C:\\Users\\Test\\AppData\\Local";
        expect(getCacheDir()).toBe(path.join(os.homedir(), ".cache"));
    });

    test("getOpenCodeCacheDir appends 'opencode' to the cache base", () => {
        expect(getOpenCodeCacheDir()).toBe(path.join(os.homedir(), ".cache", "opencode"));
    });

    test("getOpenCodeCacheDir with XDG_CACHE_HOME set", () => {
        process.env.XDG_CACHE_HOME = "/tmp/custom-cache";
        expect(getOpenCodeCacheDir()).toBe(path.join("/tmp/custom-cache", "opencode"));
    });

    test("getDataDir falls back to <homedir>/.local/share when XDG_DATA_HOME is unset", () => {
        expect(getDataDir()).toBe(path.join(os.homedir(), ".local", "share"));
    });

    test("getOpenCodeStorageDir composes correctly", () => {
        expect(getOpenCodeStorageDir()).toBe(
            path.join(os.homedir(), ".local", "share", "opencode", "storage"),
        );
    });

    test("getMagicContextStorageDir uses cortexkit/magic-context layout", () => {
        // Cross-harness shared path: both OpenCode and Pi plugins read/write here,
        // unlike the legacy opencode/storage/plugin/magic-context location which
        // was OpenCode-specific. See ARCHITECTURE_DECISIONS memory for rationale.
        // Production shape, so both test-isolation guards (the preload's data
        // dir and the NODE_ENV backstop bun sets for every `bun test`) are
        // lifted for the duration of this assertion.
        const savedTestDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        const savedNodeEnv = process.env.NODE_ENV;
        delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        delete process.env.NODE_ENV;
        try {
            expect(getMagicContextStorageDir()).toBe(
                path.join(os.homedir(), ".local", "share", "cortexkit", "magic-context"),
            );
            expect(isMagicContextStorageOutsideEngram()).toBe(false);
        } finally {
            if (savedTestDir !== undefined) process.env.MAGIC_CONTEXT_TEST_DATA_DIR = savedTestDir;
            if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
        }
    });

    test("an external storage override is outside the Engram backup folder", () => {
        const root = createTestTempDirFromPath(path.join(os.tmpdir(), "mc-storage-backup-"));
        process.env.MAGIC_CONTEXT_STORAGE_DIR = path.join(root, "external-store");

        expect(isMagicContextStorageOutsideEngram()).toBe(true);
    });

    test("storage below the Engram backup folder is considered inside it", () => {
        const root = createTestTempDirFromPath(path.join(os.tmpdir(), "mc-storage-backup-"));
        const backupDir = path.join(root, "default", "magic-context");

        expect(isMagicContextStorageOutsideEngram(path.join(backupDir, "nested"), backupDir)).toBe(
            false,
        );
    });

    test("a storage symlink into the default folder is considered inside it", () => {
        const root = createTestTempDirFromPath(path.join(os.tmpdir(), "mc-storage-backup-"));
        const backupDir = path.join(root, "default", "magic-context");
        const storageLink = path.join(root, "storage-link");
        mkdirSync(backupDir, { recursive: true });
        symlinkSync(backupDir, storageLink, "dir");

        expect(isMagicContextStorageOutsideEngram(storageLink, backupDir)).toBe(false);
    });

    test("an unset storage override keeps the platform default inside the backup folder", () => {
        expect(process.env.MAGIC_CONTEXT_STORAGE_DIR).toBeUndefined();
        expect(process.env.XDG_DATA_HOME).toBeUndefined();
        expect(isMagicContextStorageOutsideEngram()).toBe(false);
    });

    test("getMagicContextStorageDir backstops to a temp dir under NODE_ENV=test with no guard set", () => {
        // CWD-independent backstop: a `bun test` from a dir whose bunfig has no
        // `[test] preload` runs every suite with neither guard env var set. The
        // DB resolver used to own this branch, so direct callers of this helper
        // (the CLI doctors' own PRAGMA integrity_check) still reached the real
        // shared DB. Memoized, so repeated calls must agree — openDatabase()
        // caches by path.
        const savedTestDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        process.env.NODE_ENV = "test";
        try {
            const resolved = getMagicContextStorageDir();
            expect(resolved).not.toContain(path.join(os.homedir(), ".local", "share"));
            expect(resolved.endsWith(path.join("cortexkit", "magic-context"))).toBe(true);
            expect(getMagicContextStorageDir()).toBe(resolved);
        } finally {
            if (savedTestDir !== undefined) process.env.MAGIC_CONTEXT_TEST_DATA_DIR = savedTestDir;
        }
    });

    test("getMagicContextStorageDir honors MAGIC_CONTEXT_TEST_DATA_DIR when XDG_DATA_HOME is unset", () => {
        // The hole this closes: a test that deletes XDG_DATA_HOME to exercise
        // path fallbacks used to resolve to the user's REAL shared storage,
        // because bun caches os.homedir() and a mutated process.env.HOME cannot
        // move getDataDir(). Callers that build their own context.db path (the
        // CLI doctors) then ran integrity checks against production data.
        process.env.MAGIC_CONTEXT_TEST_DATA_DIR = "/tmp/mc-test-isolation";
        expect(getMagicContextStorageDir()).toBe(
            path.join("/tmp/mc-test-isolation", "cortexkit", "magic-context"),
        );
    });

    test("test storage isolation takes precedence over MAGIC_CONTEXT_STORAGE_DIR", () => {
        process.env.MAGIC_CONTEXT_TEST_DATA_DIR = "/tmp/mc-test-isolation";
        process.env.MAGIC_CONTEXT_STORAGE_DIR = "/tmp/production-shared-data";
        expect(getMagicContextStorageDir()).toBe(
            path.join("/tmp/mc-test-isolation", "cortexkit", "magic-context"),
        );
    });

    test("a per-test XDG_DATA_HOME overrides the preload root without escaping test isolation", () => {
        process.env.MAGIC_CONTEXT_TEST_DATA_DIR = "/tmp/mc-test-isolation";
        process.env.XDG_DATA_HOME = "/tmp/custom-test-data";
        process.env.MAGIC_CONTEXT_STORAGE_DIR = "/tmp/production-shared-data";
        expect(getMagicContextStorageResolution()).toEqual({
            path: path.join("/tmp/custom-test-data", "cortexkit", "magic-context"),
            source: "test isolation",
        });
    });

    test("getMagicContextStorageDir honors XDG_DATA_HOME", () => {
        process.env.XDG_DATA_HOME = "/tmp/custom-data";
        expect(getMagicContextStorageDir()).toBe(
            path.join("/tmp/custom-data", "cortexkit", "magic-context"),
        );
    });

    test("getMagicContextStorageDir honors MAGIC_CONTEXT_STORAGE_DIR", () => {
        process.env.XDG_DATA_HOME = "/tmp/private-agent-data";
        process.env.MAGIC_CONTEXT_STORAGE_DIR = "/tmp/shared-magic-context";
        expect(getMagicContextStorageDir()).toBe("/tmp/shared-magic-context");
    });

    test("MAGIC_CONTEXT_STORAGE_DIR takes precedence over XDG_DATA_HOME", () => {
        process.env.XDG_DATA_HOME = "/tmp/private-agent-data";
        process.env.MAGIC_CONTEXT_STORAGE_DIR = "/tmp/shared-magic-context";
        expect(getMagicContextStorageDir()).toBe("/tmp/shared-magic-context");
    });

    test("relative MAGIC_CONTEXT_STORAGE_DIR is rejected", () => {
        process.env.MAGIC_CONTEXT_STORAGE_DIR = "./shared-magic-context";
        expect(() => getMagicContextStorageDir()).toThrow(
            "MAGIC_CONTEXT_STORAGE_DIR must be an absolute path",
        );
    });

    test("blank MAGIC_CONTEXT_STORAGE_DIR falls back to XDG_DATA_HOME", () => {
        process.env.MAGIC_CONTEXT_STORAGE_DIR = "   ";
        process.env.XDG_DATA_HOME = "/tmp/custom-data";
        expect(getMagicContextStorageDir()).toBe(
            path.join("/tmp/custom-data", "cortexkit", "magic-context"),
        );
    });

    test("getLegacyOpenCodeMagicContextStorageDir points at the pre-cortexkit OpenCode path", () => {
        // Used only for one-time migration of pre-shared-storage data into the new
        // location. Must remain stable so users with legacy installs can still
        // have their data migrated forward across multiple plugin upgrades.
        expect(getLegacyOpenCodeMagicContextStorageDir()).toBe(
            path.join(
                os.homedir(),
                ".local",
                "share",
                "opencode",
                "storage",
                "plugin",
                "magic-context",
            ),
        );
    });

    test("legacy storage dir distinct from new shared dir even with same XDG override", () => {
        // Sanity check: even when XDG_DATA_HOME points the same place, the two
        // resolvers must return different paths so the migration copy doesn't
        // self-overwrite.
        process.env.XDG_DATA_HOME = "/tmp/test-xdg";
        const legacy = getLegacyOpenCodeMagicContextStorageDir();
        const shared = getMagicContextStorageDir();
        expect(legacy).not.toBe(shared);
        expect(legacy).toContain("opencode");
        expect(shared).toContain("cortexkit");
    });

    test("getProjectMagicContextDir composes <project>/.cortexkit/magic-context", () => {
        // Project-local artifacts (historian state file, failure dumps) live
        // inside the project so OpenCode's external_directory permission system
        // treats them as project-internal. Without this, historian's Read tool
        // would trigger a permission prompt on every run when artifacts lived
        // under os.tmpdir(). Moved from .opencode/ to the shared .cortexkit/.
        expect(getProjectMagicContextDir("/Users/me/Work/proj")).toBe(
            path.join("/Users/me/Work/proj", ".cortexkit", "magic-context"),
        );
    });

    test("getProjectMagicContextHistorianDir appends historian/", () => {
        expect(getProjectMagicContextHistorianDir("/Users/me/Work/proj")).toBe(
            path.join("/Users/me/Work/proj", ".cortexkit", "magic-context", "historian"),
        );
    });

    test("getProjectMagicContextDir is unaffected by XDG_DATA_HOME", () => {
        // Project-local paths anchor to the project directory the caller
        // passes in, NOT to any user-config env var. Setting XDG_DATA_HOME
        // (which changes the shared storage dir) must not change the
        // project-local historian dir.
        process.env.XDG_DATA_HOME = "/tmp/custom-data";
        expect(getProjectMagicContextDir("/some/project")).toBe(
            path.join("/some/project", ".cortexkit", "magic-context"),
        );
    });

    test("getProjectMagicContextDir handles trailing slashes via path.join", () => {
        // path.join normalizes redundant separators so callers don't need to
        // worry about how the project directory was constructed.
        expect(getProjectMagicContextDir("/some/project/")).toBe(
            path.join("/some/project/", ".cortexkit", "magic-context"),
        );
    });

    test("getMagicContextLogPath falls back to the harness temp dir when the env override is unset", () => {
        expect(getMagicContextLogPath("opencode")).toBe(
            path.join(os.tmpdir(), "opencode", "magic-context", "magic-context.log"),
        );
        expect(getMagicContextLogPath("pi")).toBe(
            path.join(os.tmpdir(), "pi", "magic-context", "magic-context.log"),
        );
    });

    test("getMagicContextLogPath honors MAGIC_CONTEXT_LOG_PATH", () => {
        process.env.MAGIC_CONTEXT_LOG_PATH = "/tmp/custom/magic-context.log";
        expect(getMagicContextLogPath("pi")).toBe("/tmp/custom/magic-context.log");
    });

    test("getMagicContextLogPath ignores a blank MAGIC_CONTEXT_LOG_PATH", () => {
        process.env.MAGIC_CONTEXT_LOG_PATH = "   ";
        expect(getMagicContextLogPath("pi")).toBe(
            path.join(os.tmpdir(), "pi", "magic-context", "magic-context.log"),
        );
    });
});

describe("ensureCortexKitArtifactGitignore", () => {
    const dirs: string[] = [];
    const legacy = "# >>> cortexkit:magic-context\nmagic-context/\n# <<< cortexkit:magic-context\n";
    function fixture() {
        const dir = createTestTempDirFromPath(path.join(os.tmpdir(), "mc-gi-"));
        dirs.push(dir);
        mkdirSync(path.join(dir, ".cortexkit"), { recursive: true });
        return {
            dir,
            shared: path.join(dir, ".cortexkit/.gitignore"),
            nested: path.join(dir, ".cortexkit/magic-context/.gitignore"),
        };
    }
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    test("creates only the self-ignoring nested file and does not rewrite matching bytes", () => {
        const { dir, nested, shared } = fixture();
        ensureCortexKitArtifactGitignore(dir);
        expect(readFileSync(nested, "utf8")).toBe("*\n");
        const before = statSync(nested).mtimeMs;
        ensureCortexKitArtifactGitignore(dir);
        expect(statSync(nested).mtimeMs).toBe(before);
        expect(existsSync(shared)).toBe(false);
    });

    test.each([
        "",
        "*",
        "*\r\n",
        "artifacts/\n",
    ])("repairs differing nested bytes %j", (existing) => {
        const { dir, nested } = fixture();
        mkdirSync(path.dirname(nested), { recursive: true });
        writeFileSync(nested, existing);
        ensureCortexKitArtifactGitignore(dir);
        expect(readFileSync(nested, "utf8")).toBe("*\n");
    });

    test.each([
        legacy,
        ` \r\n\t\n${legacy}\n `,
        legacy.replaceAll("\n", "\r\n"),
        legacy.trimEnd(),
    ])("deletes the old shared file when only our block and whitespace remain %j", (existing) => {
        const { dir, nested, shared } = fixture();
        writeFileSync(shared, existing);
        ensureCortexKitArtifactGitignore(dir);
        expect(readFileSync(nested, "utf8")).toBe("*\n");
        expect(existsSync(shared)).toBe(false);
    });

    test("removes our complete blocks while preserving every other byte", () => {
        const { dir, shared } = fixture();
        const prefix = "# café\r\n# >>> cortexkit:aft\r\naft/scratch/\r\n# <<< cortexkit:aft\r\n\n";
        const suffix = "# >>> cortexkit:other\nother/\n# <<< cortexkit:other\nlast-without-newline";
        writeFileSync(shared, prefix + legacy.replaceAll("\n", "\r\n") + legacy + suffix);
        ensureCortexKitArtifactGitignore(dir);
        ensureCortexKitArtifactGitignore(dir);
        expect(readFileSync(shared)).toEqual(Buffer.from(prefix + suffix));
    });

    test("shared cleanup preserves non-UTF8 bytes outside our block", () => {
        const { dir, shared } = fixture();
        const prefix = Buffer.from([0xff, 0x80, 0x0a]);
        const suffix = Buffer.from("# >>> cortexkit:aft\naft/\n# <<< cortexkit:aft\n");
        writeFileSync(shared, Buffer.concat([prefix, Buffer.from(legacy), suffix]));
        ensureCortexKitArtifactGitignore(dir);
        expect(readFileSync(shared)).toEqual(Buffer.concat([prefix, suffix]));
    });

    test.each([
        "# >>> cortexkit:aft\naft/scratch/\n# <<< cortexkit:aft\n",
        "# >>> cortexkit:magic-context\nmagic-context/\n# >>> cortexkit:aft\naft/\n# <<< cortexkit:aft\n# <<< cortexkit:magic-context\n",
        "prefix # >>> cortexkit:magic-context\nmagic-context/\n# <<< cortexkit:magic-context\n",
    ])("leaves unowned or incomplete shared blocks unchanged %j", (existing) => {
        const { dir, shared } = fixture();
        writeFileSync(shared, existing);
        ensureCortexKitArtifactGitignore(dir);
        expect(readFileSync(shared)).toEqual(Buffer.from(existing));
    });

    test("logs a nested write failure without throwing or retiring the shared rule", () => {
        const { dir, nested, shared } = fixture();
        mkdirSync(nested, { recursive: true });
        writeFileSync(shared, legacy);
        const logged = spyOn(logger, "log").mockImplementation(() => {});
        try {
            expect(() => ensureCortexKitArtifactGitignore(dir)).not.toThrow();
            expect(readFileSync(shared, "utf8")).toBe(legacy);
            expect(logged).toHaveBeenCalledWith("Failed to ensure project artifact gitignore", {
                directory: dir,
                error: expect.any(String),
            });
        } finally {
            logged.mockRestore();
        }
    });
});
