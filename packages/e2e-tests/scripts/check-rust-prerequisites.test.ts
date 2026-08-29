import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRustPrerequisites } from "./check-rust-prerequisites";

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Rust release prerequisite detector", () => {
    it("turns a PATH-hidden ck-mc into a red named prerequisite", () => {
        const parent = mkdtempSync(join(tmpdir(), "mc-rust-prereq-"));
        const root = join(parent, "repo");
        temporaryRoots.push(parent);
        mkdirSync(root, { recursive: true });
        mkdirSync(join(parent, "commons"), { recursive: true });
        mkdirSync(join(parent, "subconscious"), { recursive: true });
        writeFileSync(join(root, "Cargo.toml"), "[workspace]\nmembers = []\n");
        writeFileSync(join(parent, "commons/Cargo.toml"), "[workspace]\nmembers = []\n");
        writeFileSync(join(parent, "subconscious/Cargo.toml"), "[workspace]\nmembers = []\n");

        const bin = join(root, "bin");
        const cargoOnly = join(root, "cargo-only");
        mkdirSync(bin);
        mkdirSync(cargoOnly);
        const ckMc = join(bin, "ck-mc");
        writeFileSync(ckMc, "#!/bin/sh\nexit 0\n");
        chmodSync(ckMc, 0o755);

        const resolved = detectRustPrerequisites({
            repoRoot: root,
            env: { PATH: bin },
        });
        expect(resolved.ok).toBe(false);
        expect(resolved.ckMcBin).toBe(ckMc);
        expect(resolved.missing.join("\n")).not.toContain("ck-mc binary");

        const hidden = detectRustPrerequisites({
            repoRoot: root,
            env: { PATH: cargoOnly },
        });
        expect(hidden.ok).toBe(false);
        expect(hidden.missing.join("\n")).toContain("ck-mc binary");

        const hermetic = detectRustPrerequisites({
            repoRoot: root,
            requireCkMc: false,
            env: { PATH: cargoOnly },
        });
        expect(hermetic.ok).toBe(false);
        expect(hermetic.missing.join("\n")).not.toContain("ck-mc binary");
    });
});
