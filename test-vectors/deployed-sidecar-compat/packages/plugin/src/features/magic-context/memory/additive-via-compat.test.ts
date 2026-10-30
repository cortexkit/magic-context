
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRememberedProjectIdentity, readRememberedGitIdentity, findPinnedIdentityByGitCommonDir, projectDirectoryKey } from "./project-identity-cache";

test("deployed plugin reader accepts additive via", () => {
    const root = mkdtempSync(join(tmpdir(), "deployed-plugin-via-"));
    try {
        const directory = projectDirectoryKey(join(root, "folder"));
        const sidecars = join(root, "project-identities");
        mkdirSync(sidecars);
        const file = join(sidecars, `${createHash("sha256").update(directory).digest("hex")}.json`);
        writeFileSync(file, JSON.stringify({ directory, identity: "pj-registered", gitCommonDir: "/fixture/common", via: "root" }));
        expect(readRememberedProjectIdentity(directory, root)).toEqual({ directory, identity: "pj-registered", gitCommonDir: "/fixture/common" });
        expect(findPinnedIdentityByGitCommonDir("/fixture/common", root)).toBe("pj-registered");
        expect(readRememberedGitIdentity(directory, root)).toBeUndefined();
    } finally { rmSync(root, { recursive: true }); }
});
