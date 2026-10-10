import { expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
    getTokenizerNativeMemoryStats,
    preloadTokenizer,
    tokenizerPackageRoots,
} from "./read-session-formatting";

/**
 * Runtime coverage for where the tokenizer is allowed to come from.
 *
 * A compiled host (OMP ships as a `bun build --compile` executable) launches
 * the extension with `process.argv[1]` holding a user CLI argument rather than
 * a module path, and the plugin's own install tree is the only place
 * ai-tokenizer is guaranteed to live, because the plugin declares it. That is
 * precisely the state in which Magic Context logged "ai-tokenizer is
 * unavailable; using approximate character-based token counts" on a host whose
 * ~/.omp/plugins/node_modules/ai-tokenizer was installed and working: every
 * probe root was derived from cwd or argv[1], and neither reaches the plugin.
 *
 * The tests therefore run against the real loader with cwd and argv[1] both
 * pointing away from any node_modules tree, so the only candidates that can
 * succeed are the extension's own ancestor chain and the host plugin root.
 */
const NEUTRAL_CWD = join(homedir(), ".cache", "magic-context-tests", "tokenizer-roots-cwd");

function moduleAncestors(): string[] {
    const ownDir = dirname(fileURLToPath(new URL(import.meta.url)));
    const ancestors: string[] = [];
    let dir = ownDir;
    while (true) {
        ancestors.push(join(dir, "node_modules", "ai-tokenizer"));
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return ancestors;
}

test("tokenizer probe roots include the extension's own install tree", () => {
    // The compiled-host condition: neither the launch cwd nor argv[1] reaches a
    // node_modules tree, so the only chain that can still locate the declared
    // dependency is the tree the plugin was loaded from. Without it every
    // candidate is a dead end and the loader reports "ai-tokenizer was not
    // found under the project, runtime, or OpenCode cache node_modules roots".
    mkdirSync(NEUTRAL_CWD, { recursive: true });
    const originalCwd = process.cwd();
    const originalArgv1 = process.argv[1];
    try {
        process.chdir(NEUTRAL_CWD);
        process.argv[1] = "-p"; // what the compiled host actually holds
        const roots = tokenizerPackageRoots().map((root) => resolve(root));
        for (const root of roots) {
            expect(root.endsWith(join("node_modules", "ai-tokenizer"))).toBe(true);
        }
        for (const ancestor of moduleAncestors().map((root) => resolve(root))) {
            expect(roots).toContain(ancestor);
        }
        // A linked install (`omp plugin install <dir>`) loads the module from
        // the linked source while its hoisted dependencies live in OMP's own
        // plugin tree, so that root has to be probed too.
        expect(roots).toContain(
            resolve(join(homedir(), ".omp", "plugins", "node_modules", "ai-tokenizer")),
        );
    } finally {
        process.chdir(originalCwd);
        process.argv[1] = originalArgv1;
    }
});

test("the tokenizer loads with cwd and argv[1] pointing at no node_modules tree", async () => {
    mkdirSync(NEUTRAL_CWD, { recursive: true });
    const originalCwd = process.cwd();
    const originalArgv1 = process.argv[1];
    try {
        // Precondition: the neutral cwd brings nothing to the table, so a pass
        // here can only come from a tree the plugin itself owns or the host
        // plugin root it is installed under.
        expect(existsSync(join(NEUTRAL_CWD, "node_modules", "ai-tokenizer"))).toBe(false);
        process.chdir(NEUTRAL_CWD);
        process.argv[1] = "-p"; // what the compiled host actually holds

        expect(await preloadTokenizer()).toBe(true);
        const stats = getTokenizerNativeMemoryStats();
        expect(stats.loaded).toBe(true);
        expect(stats.tablePath).not.toBeNull();
        // bun's isolated install symlinks node_modules/ai-tokenizer into
        // node_modules/.bun/..., and the loader realpaths what it imports, so
        // the comparison has to be made on resolved directories.
        const sanctioned = [
            ...moduleAncestors(),
            join(homedir(), ".omp", "plugins", "node_modules", "ai-tokenizer"),
        ]
            .filter((root) => existsSync(root))
            .map((root) => realpathSync(root));
        expect(sanctioned.some((root) => stats.tablePath?.startsWith(root + sep))).toBe(true);
        // The launch cwd and argv[1] contributed nothing: neither is under it.
        expect(stats.tablePath?.startsWith(NEUTRAL_CWD + sep)).toBe(false);
    } finally {
        process.chdir(originalCwd);
        process.argv[1] = originalArgv1;
    }
}, 30_000);
