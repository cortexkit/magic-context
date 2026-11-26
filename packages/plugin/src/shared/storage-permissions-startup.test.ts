import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { withStorageFileMutex } from "./storage-file-mutex";
import {
    __resetStoragePrivatePermissionEnforcementForTests,
    ensurePrivateStorageDirectorySync,
    setStoragePrivatePermissionEnforcement,
    tightenStorageTreeSync,
    writeStorageFileDurableAtomicSync,
} from "./storage-permissions";
import { cleanupTestTempDir, createTestTempDir } from "./test-temp-dir";

const roots: string[] = [];
const markerName = ".storage-permissions-v1";

function fixture(): string {
    const { dir: parent } = createTestTempDir("mc-storage-startup-");
    roots.push(parent);
    const root = join(parent, "storage");
    fs.mkdirSync(root, { mode: 0o700 });
    fs.mkdirSync(join(root, "lkg-recovery-fences"), { mode: 0o700 });
    for (let i = 0; i < 2000; i++) {
        fs.writeFileSync(join(root, "lkg-recovery-fences", `${i}.json`), "{}", { mode: 0o600 });
    }
    fs.writeFileSync(join(root, "context.db"), "", { mode: 0o600 });
    return root;
}

afterEach(() => {
    __resetStoragePrivatePermissionEnforcementForTests();
    for (const root of roots.splice(0)) cleanupTestTempDir(root);
});

describe.skipIf(process.platform === "win32")("startup permission certificate", () => {
    it("keeps fresh legacy fence temp files and removes only ones older than ten minutes", () => {
        const root = fixture();
        const fences = join(root, "lkg-recovery-fences");
        const fresh = join(fences, "fresh.json.publisher.tmp");
        const old = join(fences, "old.json.publisher.tmp");
        const unrelated = join(fences, "unrelated.tmp");
        const fixed = join(fences, "fixed.json.tmp");
        const now = Date.now();
        for (const path of [fresh, old, unrelated, fixed]) {
            fs.writeFileSync(path, "keep", { mode: 0o600 });
            const age = path === fresh ? 9 * 60_000 : 11 * 60_000;
            fs.utimesSync(path, new Date(now - age), new Date(now - age));
        }
        expect(tightenStorageTreeSync(root).failures).toBe(0);
        expect(fs.existsSync(fresh)).toBe(true);
        expect(fs.existsSync(old)).toBe(false);
        expect(fs.readFileSync(unrelated, "utf8")).toBe("keep");
        expect(fs.readFileSync(fixed, "utf8")).toBe("keep");
    });

    it("does not unlink an old legacy temp before its live publisher renames it", () => {
        const root = fixture();
        const fence = join(root, "lkg-recovery-fences", "pending.json");
        const temp = `${fence}.${process.pid}.${"a".repeat(24)}.tmp`;
        const old = new Date(Date.now() - 11 * 60_000);
        withStorageFileMutex(`${fence}.locks`, () => {
            writeStorageFileDurableAtomicSync(
                fence,
                "published",
                () => {
                    fs.utimesSync(temp, old, old);
                    expect(tightenStorageTreeSync(root).failures).toBe(0);
                },
                temp,
            );
        });
        expect(fs.readFileSync(fence, "utf8")).toBe("published");
        expect(fs.existsSync(join(root, markerName))).toBe(false);
    });

    it("sweeps only empty orphan fence lock directories during the full pass", () => {
        const root = fixture();
        const fences = join(root, "lkg-recovery-fences");
        for (const name of ["orphan.json.locks", "held.json.locks", "0.json.locks", "other.locks"])
            fs.mkdirSync(join(fences, name), { mode: 0o700 });
        fs.writeFileSync(join(fences, "held.json.locks", "ticket"), "held", { mode: 0o600 });
        fs.symlinkSync("orphan.json.locks", join(fences, "link.json.locks"));
        expect(tightenStorageTreeSync(root).failures).toBe(0);
        expect(fs.existsSync(join(fences, "orphan.json.locks"))).toBe(false);
        for (const name of ["held.json.locks", "0.json.locks", "other.locks"])
            expect(fs.existsSync(join(fences, name))).toBe(true);
        expect(fs.lstatSync(join(fences, "link.json.locks")).isSymbolicLink()).toBe(true);
        fs.mkdirSync(join(fences, "later.json.locks"), { mode: 0o700 });
        tightenStorageTreeSync(root);
        expect(fs.existsSync(join(fences, "later.json.locks"))).toBe(true);
    });

    it("checks only startup entries after a certified walk, not 2000 recovery fences", () => {
        const root = fixture();
        fs.writeFileSync(join(root, markerName), "1\n", { mode: 0o600 });
        const lstat = spyOn(fs, "lstatSync");
        try {
            expect(tightenStorageTreeSync(root).failures).toBe(0);
            expect(lstat.mock.calls.length).toBeLessThanOrEqual(8);
            console.log(`CERTIFIED_LSTAT calls=${lstat.mock.calls.length} fences=2000`);
        } finally {
            lstat.mockRestore();
        }
    });

    it("certifies the first full walk only after all entries succeed", () => {
        const root = fixture();
        const lstat = spyOn(fs, "lstatSync");
        try {
            expect(tightenStorageTreeSync(root).failures).toBe(0);
            expect(lstat.mock.calls.length).toBeGreaterThan(2000);
            expect(fs.lstatSync(join(root, markerName)).mode & 0o777).toBe(0o600);
        } finally {
            lstat.mockRestore();
        }
    });

    it("repairs the root and files when the marker is a directory", () => {
        const root = fixture();
        const marker = join(root, markerName);
        const loose = join(root, "loose.json");
        fs.mkdirSync(marker, { mode: 0o700 });
        fs.writeFileSync(join(marker, "keep"), "keep", { mode: 0o600 });
        fs.writeFileSync(loose, "{}");
        fs.chmodSync(loose, 0o644);
        fs.chmodSync(root, 0o755);

        tightenStorageTreeSync(root);

        expect(fs.lstatSync(root).mode & 0o777).toBe(0o700);
        expect(fs.lstatSync(loose).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(join(marker, "keep"), "utf8")).toBe("keep");
    });

    const runningAsRoot = process.getuid?.() === 0;
    if (runningAsRoot) console.warn("Skipping the non-searchable storage test as root.");
    it.skipIf(runningAsRoot)("repairs a non-searchable root before walking its files", () => {
        const root = fixture();
        expect(tightenStorageTreeSync(root).failures).toBe(0);
        const loose = join(root, "loose.json");
        fs.writeFileSync(loose, "{}");
        fs.chmodSync(loose, 0o644);
        fs.chmodSync(root, 0o600);
        try {
            tightenStorageTreeSync(root);

            expect(fs.lstatSync(root).mode & 0o777).toBe(0o700);
            expect(fs.lstatSync(loose).mode & 0o777).toBe(0o600);
        } finally {
            fs.chmodSync(root, 0o700);
        }
    });

    it("repairs new files outside the startup paths after 24 hours", () => {
        const root = fixture();
        const marker = join(root, markerName);
        expect(tightenStorageTreeSync(root).failures).toBe(0);
        const loose = join(root, "lkg-recovery-fences", "later.json");
        fs.writeFileSync(loose, "{}");
        fs.chmodSync(loose, 0o644);

        const fresh = new Date(Date.now() - 23 * 60 * 60_000);
        fs.utimesSync(marker, fresh, fresh);
        for (let i = 0; i < 3; i++) {
            expect(tightenStorageTreeSync(root).failures).toBe(0);
            expect(fs.lstatSync(loose).mode & 0o777).toBe(0o644);
        }
        const expired = new Date(Date.now() - 25 * 60 * 60_000);
        fs.utimesSync(marker, expired, expired);

        expect(tightenStorageTreeSync(root).failures).toBe(0);
        expect(fs.lstatSync(loose).mode & 0o777).toBe(0o600);
        expect(fs.lstatSync(marker).mtimeMs).toBeGreaterThan(fresh.getTime());
    });

    it("repairs a peer's loose git identity sidecar after the certificate expires", () => {
        const root = fixture();
        const directory = join(root, "project-identities");
        fs.mkdirSync(directory, { mode: 0o700 });
        expect(tightenStorageTreeSync(root).failures).toBe(0);

        const sidecar = join(directory, `${"a".repeat(64)}.json`);
        fs.writeFileSync(sidecar, JSON.stringify({ directory: root, identity: "git:abcdef0" }));
        fs.chmodSync(sidecar, 0o644);
        const expired = new Date(Date.now() - 25 * 60 * 60_000);
        fs.utimesSync(join(root, markerName), expired, expired);

        expect(tightenStorageTreeSync(root).failures).toBe(0);
        expect(fs.lstatSync(sidecar).mode & 0o777).toBe(0o600);
    });

    it("does not trust a certificate with a future modification time", () => {
        const root = fixture();
        const marker = join(root, markerName);
        expect(tightenStorageTreeSync(root).failures).toBe(0);
        const loose = join(root, "lkg-recovery-fences", "later.json");
        fs.writeFileSync(loose, "{}");
        fs.chmodSync(loose, 0o644);
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(marker, future, future);

        expect(tightenStorageTreeSync(root).failures).toBe(0);
        expect(fs.lstatSync(loose).mode & 0o777).toBe(0o600);
    });

    it("does not certify a storage root that is a symbolic link", () => {
        const root = fixture();
        const alias = join(root, "alias");
        fs.symlinkSync(root, alias);
        expect(tightenStorageTreeSync(alias).failures).toBe(1);
        expect(fs.existsSync(join(root, markerName))).toBe(false);
    });

    for (const target of ["context.db", ".", "context.db-wal", "context.db-shm"]) {
        it(`invalidates after repairing ${target}, then walks fully on the next open`, () => {
            const root = fixture();
            fs.writeFileSync(join(root, markerName), "1\n", { mode: 0o600 });
            if (target.endsWith("-wal") || target.endsWith("-shm")) {
                fs.writeFileSync(join(root, target), "");
            }
            fs.chmodSync(join(root, target), target === "." ? 0o755 : 0o644);
            expect(tightenStorageTreeSync(root)).toMatchObject({ tightened: 1, failures: 0 });
            expect(fs.lstatSync(join(root, target)).mode & 0o777).toBe(
                target === "." ? 0o700 : 0o600,
            );
            expect(fs.existsSync(join(root, markerName))).toBe(false);
            const lstat = spyOn(fs, "lstatSync");
            try {
                tightenStorageTreeSync(root);
                expect(lstat.mock.calls.length).toBeGreaterThan(2000);
            } finally {
                lstat.mockRestore();
            }
        });
    }

    it("does not trust a symlink or a permissive certificate", () => {
        for (const kind of ["symlink", "mode"]) {
            const root = fixture();
            const marker = join(root, markerName);
            if (kind === "symlink") fs.symlinkSync("context.db", marker);
            else fs.writeFileSync(marker, "1\n", { mode: 0o644 });
            const lstat = spyOn(fs, "lstatSync");
            try {
                tightenStorageTreeSync(root);
                expect(lstat.mock.calls.length).toBeGreaterThan(2000);
            } finally {
                lstat.mockRestore();
            }
            expect(fs.lstatSync(marker).isSymbolicLink()).toBe(false);
            expect(fs.lstatSync(marker).mode & 0o777).toBe(0o600);
        }
    });

    it("never certifies a failed walk or enforcement-off storage", () => {
        const root = fixture();
        const realLstat = fs.lstatSync;
        const lstat = spyOn(fs, "lstatSync").mockImplementation((...args) => {
            if (String(args[0]).endsWith("/12.json")) throw new Error("injected lstat failure");
            return realLstat(...args);
        });
        try {
            expect(tightenStorageTreeSync(root).failures).toBe(1);
            expect(fs.existsSync(join(root, markerName))).toBe(false);
        } finally {
            lstat.mockRestore();
        }
        setStoragePrivatePermissionEnforcement(false);
        expect(tightenStorageTreeSync(root)).toEqual({ tightened: 0, failures: 0 });
        expect(fs.existsSync(join(root, markerName))).toBe(false);
    });

    it("invalidates certification when a bounded entry cannot be checked", () => {
        const root = fixture();
        fs.writeFileSync(join(root, markerName), "1\n", { mode: 0o600 });
        const realLstat = fs.lstatSync;
        const lstat = spyOn(fs, "lstatSync").mockImplementation((...args) => {
            if (String(args[0]) === join(root, "context.db")) {
                throw Object.assign(new Error("injected permission failure"), { code: "EACCES" });
            }
            return realLstat(...args);
        });
        try {
            expect(tightenStorageTreeSync(root)).toMatchObject({ failures: 1 });
            expect(fs.existsSync(join(root, markerName))).toBe(false);
        } finally {
            lstat.mockRestore();
        }
    });

    for (const subtree of ["models", "logs"]) {
        it(`still tightens third-party ${subtree} entries after certification`, () => {
            const root = fixture();
            fs.writeFileSync(join(root, markerName), "1\n", { mode: 0o600 });
            fs.mkdirSync(join(root, subtree), { mode: 0o755 });
            fs.writeFileSync(join(root, subtree, "entry"), "fixture", { mode: 0o644 });
            fs.chmodSync(join(root, subtree), 0o755);
            fs.chmodSync(join(root, subtree, "entry"), 0o644);
            expect(tightenStorageTreeSync(root)).toMatchObject({ tightened: 2, failures: 0 });
            expect(fs.lstatSync(join(root, subtree)).mode & 0o777).toBe(0o700);
            expect(fs.lstatSync(join(root, subtree, "entry")).mode & 0o777).toBe(0o600);
            expect(fs.existsSync(join(root, markerName))).toBe(false);
        });
    }

    it("invalidates when the existing private-directory check finds a wrong mode", () => {
        const root = fixture();
        expect(tightenStorageTreeSync(root).failures).toBe(0);
        expect(fs.existsSync(join(root, markerName))).toBe(true);
        const directory = join(root, "lkg-recovery-fences");
        fs.chmodSync(directory, 0o755);
        ensurePrivateStorageDirectorySync(directory);
        expect(fs.existsSync(join(root, markerName))).toBe(false);
        expect(fs.lstatSync(directory).mode & 0o777).toBe(0o700);
    });

    it("repairs a loose private directory when the marker is a directory", () => {
        const { dir: root } = createTestTempDir("mc-marker-directory-");
        roots.push(root);
        expect(tightenStorageTreeSync(root).failures).toBe(0);
        const marker = join(root, markerName);
        fs.unlinkSync(marker);
        fs.mkdirSync(marker);
        const sentinel = join(marker, "keep");
        fs.writeFileSync(sentinel, "keep");
        const directory = join(root, "some.json.locks");
        fs.mkdirSync(directory);
        fs.chmodSync(directory, 0o755);

        expect(() => ensurePrivateStorageDirectorySync(directory)).not.toThrow();
        expect(fs.lstatSync(directory).mode & 0o777).toBe(0o700);
        expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
    });

    it("repairs an unchecked directory when unlink fails on a read-only ancestor", () => {
        const { dir: parent } = createTestTempDir("mc-read-only-ancestor-");
        roots.push(parent);
        const root = join(parent, "storage");
        const directory = join(root, "lkg-recovery-fences");
        const marker = join(root, markerName);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.chmodSync(directory, 0o755);
        fs.writeFileSync(marker, "1\n", { mode: 0o600 });

        const rmSync = fs.rmSync;
        const remove = spyOn(fs, "rmSync").mockImplementation((path, options) => {
            if (path === join(parent, markerName)) {
                throw Object.assign(new Error("injected read-only ancestor"), { code: "EROFS" });
            }
            return rmSync(path, options);
        });
        try {
            ensurePrivateStorageDirectorySync(directory);
            expect(fs.lstatSync(directory).mode & 0o777).toBe(0o700);
            expect(fs.existsSync(marker)).toBe(false);
        } finally {
            remove.mockRestore();
        }
    });

    it("walks the full tree in the same call when a certified start finds a loose root", () => {
        const root = fixture();
        fs.writeFileSync(join(root, markerName), "1\n", { mode: 0o600 });
        const deep = join(root, "lkg-recovery-fences", "5.json");
        fs.chmodSync(deep, 0o644);
        fs.chmodSync(root, 0o755);
        expect(tightenStorageTreeSync(root)).toMatchObject({ tightened: 2, failures: 0 });
        expect(fs.lstatSync(root).mode & 0o777).toBe(0o700);
        expect(fs.lstatSync(deep).mode & 0o777).toBe(0o600);
        expect(fs.existsSync(join(root, markerName))).toBe(false);
    });

    it("invalidates the certificate before a repair can hide the loose root", () => {
        const root = fixture();
        const marker = join(root, markerName);
        fs.writeFileSync(marker, "1\n", { mode: 0o600 });
        fs.chmodSync(root, 0o755);
        const chmodSync = fs.chmodSync;
        const markerDuringRepair: boolean[] = [];
        const chmod = spyOn(fs, "chmodSync").mockImplementation((path, mode) => {
            if (path === root) markerDuringRepair.push(fs.existsSync(marker));
            return chmodSync(path, mode);
        });
        try {
            expect(tightenStorageTreeSync(root)).toEqual({ tightened: 1, failures: 0 });
            expect(markerDuringRepair).toEqual([false]);
        } finally {
            chmod.mockRestore();
        }
    });

    it("stops marker invalidation at the storage root", () => {
        const root = fixture();
        const parent = join(root, "..");
        const decoy = join(parent, markerName);
        expect(tightenStorageTreeSync(root).failures).toBe(0);
        expect(fs.existsSync(join(root, markerName))).toBe(true);
        fs.writeFileSync(decoy, "1\n", { mode: 0o600 });
        const directory = join(root, "lkg-recovery-fences");
        fs.chmodSync(directory, 0o755);
        ensurePrivateStorageDirectorySync(directory);
        expect(fs.existsSync(join(root, markerName))).toBe(false);
        expect(fs.existsSync(decoy)).toBe(true);
    });

    it("removes certification while enforcement is off before a later private open", () => {
        const root = fixture();
        fs.writeFileSync(join(root, markerName), "1\n", { mode: 0o600 });
        setStoragePrivatePermissionEnforcement(false);
        expect(tightenStorageTreeSync(root)).toEqual({ tightened: 0, failures: 0 });
        expect(fs.existsSync(join(root, markerName))).toBe(false);
        setStoragePrivatePermissionEnforcement(true);
        const lstat = spyOn(fs, "lstatSync");
        try {
            tightenStorageTreeSync(root);
            expect(lstat.mock.calls.length).toBeGreaterThan(2000);
        } finally {
            lstat.mockRestore();
        }
    });

    it("clears the certificate of a checked root when enforcement turns off", () => {
        const root = fixture();
        expect(tightenStorageTreeSync(root).failures).toBe(0);
        expect(fs.existsSync(join(root, markerName))).toBe(true);
        setStoragePrivatePermissionEnforcement(false);
        expect(fs.existsSync(join(root, markerName))).toBe(false);
    });

    it("does not trust a certificate with unexpected contents", () => {
        for (const content of ["", "1", "2\n", "1\nextra\n"]) {
            const root = fixture();
            const marker = join(root, markerName);
            fs.writeFileSync(marker, content, { mode: 0o600 });
            const lstat = spyOn(fs, "lstatSync");
            try {
                tightenStorageTreeSync(root);
                expect(lstat.mock.calls.length).toBeGreaterThan(2000);
            } finally {
                lstat.mockRestore();
            }
            expect(fs.readFileSync(marker, "utf8")).toBe("1\n");
        }
    });

    it("rejects an oversized certificate without a whole-file read", () => {
        const root = fixture();
        const marker = join(root, markerName);
        const deep = join(root, "lkg-recovery-fences", "5.json");
        fs.writeFileSync(marker, "1\n", { mode: 0o600 });
        fs.truncateSync(marker, 1024 * 1024);
        fs.chmodSync(deep, 0o644);
        const readFile = spyOn(fs, "readFileSync");
        try {
            expect(tightenStorageTreeSync(root)).toEqual({ tightened: 1, failures: 0 });
            expect(readFile.mock.calls.some(([path]) => path === marker)).toBe(false);
        } finally {
            readFile.mockRestore();
        }
        expect(fs.readFileSync(marker, "utf8")).toBe("1\n");
    });

    it("does not certify a full pass that keeps a fresh legacy fence temp", () => {
        const root = fixture();
        const fresh = join(root, "lkg-recovery-fences", "fresh.json.publisher.tmp");
        fs.writeFileSync(fresh, "keep", { mode: 0o600 });
        expect(tightenStorageTreeSync(root).failures).toBe(0);
        expect(fs.existsSync(fresh)).toBe(true);
        expect(fs.existsSync(join(root, markerName))).toBe(false);
        const old = new Date(Date.now() - 11 * 60_000);
        fs.utimesSync(fresh, old, old);
        expect(tightenStorageTreeSync(root).failures).toBe(0);
        expect(fs.existsSync(fresh)).toBe(false);
        expect(fs.existsSync(join(root, markerName))).toBe(true);
    });
});
