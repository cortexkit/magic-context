import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import {
    __resetStoragePrivatePermissionEnforcementForTests,
    ensurePrivateStorageDirectorySync,
    setStoragePrivatePermissionEnforcement,
    tightenStorageTreeSync,
} from "./storage-permissions";
import { cleanupTestTempDir, createTestTempDirFromPath } from "./test-temp-dir";

const roots: string[] = [];
const markerName = ".storage-permissions-v1";

function fixture(): string {
    fs.mkdirSync("/tmp/opencode/mc-walk-pr", { recursive: true, mode: 0o700 });
    const root = createTestTempDirFromPath("/tmp/opencode/mc-walk-pr/startup-");
    roots.push(root);
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
        fs.writeFileSync(join(root, markerName), "1\n", { mode: 0o600 });
        const directory = join(root, "lkg-recovery-fences");
        fs.chmodSync(directory, 0o755);
        ensurePrivateStorageDirectorySync(directory);
        expect(fs.existsSync(join(root, markerName))).toBe(false);
        expect(fs.lstatSync(directory).mode & 0o777).toBe(0o700);
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
});
