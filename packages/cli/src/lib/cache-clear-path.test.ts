import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { checkCacheClearPath } from "./cache-clear-path";

let root: string;
let cache: string;
let install: string;
beforeEach(() => {
    root = createTestTempDirFromPath(join(tmpdir(), "mc-cache-clear-path-"));
    cache = join(root, "cache");
    install = join(cache, "scope", "package");
    mkdirSync(install, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("allows a real directory inside the cache, even below an alias above its configured base", () => {
    expect(checkCacheClearPath(cache, install)).toEqual({ allowed: true, path: install });
    const alias = join(root, "alias");
    symlinkSync(root, alias, "junction");
    const aliasedInstall = join(alias, "cache", "scope", "package");
    expect(checkCacheClearPath(join(alias, "cache"), aliasedInstall)).toEqual({
        allowed: true,
        path: aliasedInstall,
    });
});

test("refuses the root itself, an outside directory sharing its prefix, and a missing root", () => {
    const neighbour = join(root, "cache-other");
    mkdirSync(neighbour);
    expect(checkCacheClearPath(cache, cache)).toMatchObject({ allowed: false, reason: "outside" });
    expect(checkCacheClearPath(cache, neighbour)).toMatchObject({
        allowed: false,
        reason: "outside",
    });
    const missing = join(root, "missing");
    expect(checkCacheClearPath(missing, join(missing, "package"))).toMatchObject({
        allowed: false,
        reason: "missing",
    });
});

test("refuses a linked root and links inside the root even if their targets stay inside it", () => {
    const rootLink = join(root, "linked-cache");
    symlinkSync(cache, rootLink, "junction");
    expect(checkCacheClearPath(rootLink, join(rootLink, "scope", "package"))).toEqual({
        allowed: false,
        reason: "linked",
        path: rootLink,
    });

    const scopeLink = join(cache, "linked-scope");
    symlinkSync(join(cache, "scope"), scopeLink, "junction");
    expect(checkCacheClearPath(cache, join(scopeLink, "package"))).toEqual({
        allowed: false,
        reason: "linked",
        path: scopeLink,
    });

    const installLink = join(cache, "linked-package");
    symlinkSync(install, installLink, "junction");
    expect(checkCacheClearPath(cache, installLink)).toEqual({
        allowed: false,
        reason: "linked",
        path: installLink,
    });
});

test("refuses a non-directory and reports a dangling candidate as linked", () => {
    const file = join(cache, "file");
    writeFileSync(file, "keep");
    expect(checkCacheClearPath(cache, file)).toMatchObject({
        allowed: false,
        reason: "unavailable",
    });
    const dangling = join(cache, "dangling");
    symlinkSync(join(cache, "absent"), dangling, "junction");
    expect(checkCacheClearPath(cache, dangling)).toMatchObject({
        allowed: false,
        reason: "linked",
    });
});
