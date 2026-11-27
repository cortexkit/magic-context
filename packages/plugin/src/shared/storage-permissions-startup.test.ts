import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
const { join } = path;

function linkedFixture(name: string): { parent: string; root: string; alias: string } {
    const { dir } = createTestTempDir(`mc-storage-link-${name}-`);
    roots.push(dir);
    const parent = fs.realpathSync(dir);
    const root = join(parent, "storage");
    const alias = join(parent, "alias");
    fs.mkdirSync(root);
    fs.chmodSync(root, 0o755);
    fs.symlinkSync(root, alias);
    return { parent, root, alias };
}

function mode(file: string): number {
    return fs.lstatSync(file).mode & 0o777;
}

function writeLooseOwnedTree(root: string): void {
    const models = join(root, "models");
    fs.mkdirSync(models);
    fs.writeFileSync(join(root, "context.db"), "");
    fs.writeFileSync(join(models, "weights"), "cache fixture");
    for (const [file, permissions] of [
        [root, 0o755],
        [models, 0o755],
        [join(root, "context.db"), 0o644],
        [join(models, "weights"), 0o755],
    ] as const)
        fs.chmodSync(file, permissions);
}

function ownedTreeModes(root: string): number[] {
    return [".", "context.db", "models", "models/weights"].map((name) => mode(join(root, name)));
}

function fixture(): string {
    const { dir: parent } = createTestTempDir("mc-storage-startup-");
    roots.push(parent);
    const root = join(fs.realpathSync(parent), "storage");
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

    it("tightens and certifies the target of a linked storage root", () => {
        const root = fixture();
        const alias = join(root, "..", "alias");
        fs.symlinkSync("storage", alias);
        const before = fs.lstatSync(alias);
        const db = join(root, "context.db");
        const fence = join(root, "lkg-recovery-fences", "5.json");
        fs.chmodSync(root, 0o755);
        fs.chmodSync(db, 0o644);
        fs.chmodSync(fence, 0o644);

        tightenStorageTreeSync(alias);

        expect(fs.lstatSync(root).mode & 0o777).toBe(0o700);
        expect(fs.lstatSync(db).mode & 0o777).toBe(0o600);
        expect(fs.lstatSync(fence).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(join(root, markerName), "utf8")).toBe("1\n");
        expect(fs.lstatSync(join(root, markerName)).mode & 0o777).toBe(0o600);
        const after = fs.lstatSync(alias);
        expect(after.isSymbolicLink()).toBe(true);
        expect(after.ino).toBe(before.ino);
        expect(after.mode).toBe(before.mode);
        expect(fs.readlinkSync(alias)).toBe("storage");
    });

    it("uses the bounded check on the target of a certified root link chain", () => {
        const root = fixture();
        const alias = join(root, "..", "alias");
        const intermediate = join(root, "..", "intermediate");
        fs.symlinkSync(intermediate, alias);
        fs.symlinkSync(root, intermediate);
        expect(tightenStorageTreeSync(alias).failures).toBe(0);

        const lstat = spyOn(fs, "lstatSync");
        try {
            expect(tightenStorageTreeSync(alias, join(alias, "context.db")).failures).toBe(0);
            expect(lstat.mock.calls.map(([path]) => path)).toContain(join(root, "context.db"));
            expect(lstat.mock.calls.length).toBeLessThanOrEqual(10);
        } finally {
            lstat.mockRestore();
        }
    });

    it("retarget between starts: new target fully walked, old untouched", () => {
        const { root, alias } = linkedFixture("retarget-between");
        const { root: next } = linkedFixture("retarget-next");
        writeLooseOwnedTree(root);
        writeLooseOwnedTree(next);
        expect(tightenStorageTreeSync(alias).failures).toBe(0);
        const before = ownedTreeModes(root);
        const oldMarker = fs.lstatSync(join(root, markerName));
        fs.unlinkSync(alias);
        fs.symlinkSync(next, alias);

        expect(tightenStorageTreeSync(alias).failures).toBe(0);
        expect(ownedTreeModes(next)).toEqual([0o700, 0o600, 0o700, 0o600]);
        expect(fs.existsSync(join(next, markerName))).toBe(true);
        expect(ownedTreeModes(root)).toEqual(before);
        expect(fs.lstatSync(join(root, markerName))).toMatchObject({
            ino: oldMarker.ino,
            mtimeMs: oldMarker.mtimeMs,
        });
    });

    it("retarget during the walk: marker and every chmod stay in the first target", () => {
        const { root, alias } = linkedFixture("retarget-during");
        const { root: next } = linkedFixture("retarget-during-next");
        writeLooseOwnedTree(root);
        writeLooseOwnedTree(next);
        const before = ownedTreeModes(next);
        const realReaddir = fs.readdirSync;
        let swapped = false;
        const readdir = spyOn(fs, "readdirSync").mockImplementation((...args) => {
            // The top-level eligibility probe is read-only. Redirect from inside the walk.
            if (!swapped && args[0] === join(root, "models")) {
                swapped = true;
                fs.unlinkSync(alias);
                fs.symlinkSync(next, alias);
            }
            return realReaddir(...args);
        });
        const chmod = spyOn(fs, "chmodSync");
        try {
            expect(tightenStorageTreeSync(alias, join(alias, "context.db")).failures).toBe(0);
            expect(swapped).toBe(true);
            expect(chmod.mock.calls.length).toBeGreaterThan(1);
            expect(
                chmod.mock.calls.every(
                    ([file]) => file === root || String(file).startsWith(`${root}/`),
                ),
            ).toBe(true);
        } finally {
            readdir.mockRestore();
            chmod.mockRestore();
        }
        expect(fs.existsSync(join(root, markerName))).toBe(true);
        expect(fs.existsSync(join(next, markerName))).toBe(false);
        expect(ownedTreeModes(next)).toEqual(before);
    });

    it("does not follow an interior link to a loose directory outside storage", () => {
        const root = fixture();
        const outside = join(root, "..", "outside");
        const outsideFile = join(outside, "private.json");
        const link = join(root, "models");
        fs.mkdirSync(outside);
        fs.writeFileSync(outsideFile, "{}");
        fs.chmodSync(outside, 0o755);
        fs.chmodSync(outsideFile, 0o644);
        fs.symlinkSync(outside, link);
        const linkMode = fs.lstatSync(link).mode;

        for (let start = 0; start < 2; start++) {
            expect(tightenStorageTreeSync(root).failures).toBe(0);
            expect(fs.lstatSync(link).mode).toBe(linkMode);
            expect(fs.readlinkSync(link)).toBe(outside);
            expect(fs.lstatSync(outside).mode & 0o777).toBe(0o755);
            expect(fs.lstatSync(outsideFile).mode & 0o777).toBe(0o644);
        }
    });

    it("does not tighten through a root link with enforcement off", () => {
        const root = fixture();
        const alias = join(root, "..", "alias");
        const file = join(root, "context.db");
        fs.symlinkSync(root, alias);
        fs.chmodSync(root, 0o755);
        fs.chmodSync(file, 0o644);
        fs.writeFileSync(join(root, markerName), "1\n", { mode: 0o600 });
        setStoragePrivatePermissionEnforcement(false);

        expect(tightenStorageTreeSync(alias)).toMatchObject({ tightened: 0, failures: 0 });
        expect(fs.lstatSync(root).mode & 0o777).toBe(0o755);
        expect(fs.lstatSync(file).mode & 0o777).toBe(0o644);
        expect(fs.existsSync(join(root, markerName))).toBe(false);
    });

    it("does not tighten a linked filesystem root", () => {
        const { root, alias } = linkedFixture("filesystem-root");
        const realDirname = path.dirname;
        // Model the root predicate without pointing the link at a real filesystem root.
        const dirname = spyOn(path, "dirname").mockImplementation((file) =>
            file === root ? root : realDirname(file),
        );
        try {
            expect(tightenStorageTreeSync(alias)).toMatchObject({ tightened: 0, failures: 0 });
        } finally {
            dirname.mockRestore();
        }
        expect(mode(root)).toBe(0o755);
        expect(fs.existsSync(join(root, markerName))).toBe(false);
    });

    it("does not tighten a linked target that resolves to the user's home folder", () => {
        const { parent, root, alias } = linkedFixture("home");
        const homePath = join(parent, "home-link");
        fs.symlinkSync(root, homePath);
        const home = spyOn(os, "homedir").mockReturnValue(homePath);
        try {
            expect(tightenStorageTreeSync(alias)).toMatchObject({ tightened: 0, failures: 0 });
        } finally {
            home.mockRestore();
        }
        expect(mode(root)).toBe(0o755);
        expect(fs.existsSync(join(root, markerName))).toBe(false);
    });

    it("does not tighten a linked mount point on a different device from its parent", () => {
        const { parent, root, alias } = linkedFixture("mount");
        const realLstat = fs.lstatSync;
        const lstat = spyOn(fs, "lstatSync").mockImplementation((...args) => {
            const stat = realLstat(...args);
            if (args[0] === parent) stat.dev = realLstat(root).dev + 1;
            return stat;
        });
        try {
            expect(tightenStorageTreeSync(alias)).toMatchObject({ tightened: 0, failures: 0 });
        } finally {
            lstat.mockRestore();
        }
        expect(mode(root)).toBe(0o755);
        expect(fs.existsSync(join(root, markerName))).toBe(false);
    });

    it("leaves a linked target with only foreign entries alone", () => {
        const { root, alias } = linkedFixture("foreign-only");
        const foreign = join(root, "other-executable");
        fs.writeFileSync(foreign, "other");
        fs.chmodSync(foreign, 0o755);

        expect(tightenStorageTreeSync(alias)).toMatchObject({ tightened: 0, failures: 0 });
        expect(mode(foreign)).toBe(0o755);
        expect(mode(root)).toBe(0o755);
        expect(fs.existsSync(join(root, markerName))).toBe(false);
    });

    it("rechecks a linked target even with a marker and rejects lookalike entries", () => {
        const { root, alias } = linkedFixture("foreign-with-marker");
        writeLooseOwnedTree(root);
        expect(tightenStorageTreeSync(alias).failures).toBe(0);
        const marker = join(root, markerName);
        const oldMarker = fs.lstatSync(marker);
        const foreign = [
            "context.db-wal-unrelated",
            "context.db.corrupt-backup-20260811T123656789Z-not-a-backup",
            "last_announced_version.123.not-hex-temp.tmp",
            "identity-merge-backup-too-long",
            "opencode.db",
            "run-index.db",
        ];
        for (const name of foreign) fs.writeFileSync(join(root, name), "unrelated");
        fs.chmodSync(root, 0o755);

        expect(tightenStorageTreeSync(alias)).toMatchObject({
            tightened: 0,
            failures: 0,
            rootLink: { skipped: foreign.length },
        });
        expect(mode(root)).toBe(0o755);
        expect(fs.lstatSync(marker)).toMatchObject({
            ino: oldMarker.ino,
            mtimeMs: oldMarker.mtimeMs,
        });
    });

    it("tightens a linked target containing only Finder's .DS_Store", () => {
        const { root, alias } = linkedFixture("finder");
        fs.writeFileSync(join(root, ".DS_Store"), "Finder fixture");
        fs.chmodSync(join(root, ".DS_Store"), 0o600);
        expect(tightenStorageTreeSync(alias)).toMatchObject({ tightened: 1, failures: 0 });
        expect(mode(root)).toBe(0o700);
        expect(fs.existsSync(join(root, markerName))).toBe(true);
    });

    it("does not count unresolved linked roots when enforcement is off", () => {
        const { parent, alias } = linkedFixture("broken-off");
        fs.unlinkSync(alias);
        fs.symlinkSync(join(parent, "missing"), alias);
        setStoragePrivatePermissionEnforcement(false);
        expect(tightenStorageTreeSync(alias)).toEqual({ tightened: 0, failures: 0 });
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
            else {
                fs.writeFileSync(marker, "1\n", { mode: 0o600 });
                fs.chmodSync(marker, 0o644);
            }
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

    it("stops marker invalidation at the linked storage boundary", () => {
        const root = fixture();
        const alias = join(root, "..", "alias");
        const decoy = join(root, "..", markerName);
        fs.symlinkSync(root, alias);
        expect(tightenStorageTreeSync(alias).failures).toBe(0);
        expect(fs.existsSync(join(root, markerName))).toBe(true);
        fs.writeFileSync(decoy, "1\n", { mode: 0o600 });

        const directory = join(alias, "lkg-recovery-fences");
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
