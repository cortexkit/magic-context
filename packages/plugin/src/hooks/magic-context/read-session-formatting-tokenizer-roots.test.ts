import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tokenizerPackageRoots } from "./read-session-formatting";

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
 * `preloadTokenizer()` tries the synchronous `createRequire(import.meta.url)`
 * loader first and only falls back to `tokenizerPackageRoots()` ->
 * `loadTokenizerFromInstalledPackage()` when that first loader throws. So an
 * in-process test that imports this real module can never exercise the
 * fallback: ai-tokenizer is a declared dev dependency of the package, so the
 * primary loader resolves it from the repo tree regardless of cwd/argv[1].
 * The loader tests therefore run a COPY of the module inside an isolated
 * fixture whose entire ancestor `node_modules` chain carries no ai-tokenizer,
 * which forces the initial loader to throw and proves the fallback binds the
 * sanctioned plugin-tree copy.
 */
const NEUTRAL_CWD = join(homedir(), ".cache", "magic-context-tests", "tokenizer-roots-cwd");
const TESTS_ROOT = join(homedir(), ".cache", "magic-context-tests");

const SRC_HOOK_DIR = dirname(
    fileURLToPath(new URL("./read-session-formatting.ts", import.meta.url)),
);
const SRC_HOOK = join(SRC_HOOK_DIR, "read-session-formatting.ts");
// The fixture tree mirrors `packages/plugin/src`, so every relative specifier
// inside the copied closure resolves against the same layout as the original.
const SRC_PKG = join(SRC_HOOK_DIR, "..", "..");

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

/**
 * A planted `ai-tokenizer` whose `encode` returns an array of length
 * `text.length + marker`, so a token count identifies exactly which copy the
 * loader bound (the real ai-tokenizer never produces those lengths, and two
 * planted copies carry different markers).
 */
function plantAiTokenizer(packageDir: string, marker: number): void {
    mkdirSync(join(packageDir, "encoding"), { recursive: true });
    writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
            name: "ai-tokenizer",
            version: `0.0.0-planted-${marker}`,
            type: "module",
            exports: {
                ".": { import: "./index.js" },
                "./encoding/claude": { import: "./encoding/claude.js" },
            },
        }),
    );
    writeFileSync(
        join(packageDir, "index.js"),
        `export class Tokenizer {\n` +
            `    constructor(encoding) { this.encoding = encoding; }\n` +
            `    encode(text, _allowedSpecial) { return new Array(text.length + ${marker}).fill(1); }\n` +
            `}\n` +
            `export default Tokenizer;\n`,
    );
    writeFileSync(
        join(packageDir, "encoding", "claude.js"),
        `const claude = { marker: ${marker}, specialTokens: { "<EOT>": 100256 } };\n` +
            `export default claude;\n` +
            `export { claude };\n`,
    );
}

interface LoaderResult {
    ok?: boolean;
    loaded?: boolean;
    tablePath?: string | null;
    count?: number | null;
    encErr?: string | null;
    error?: string;
}

/**
 * Run `preloadTokenizer()` for a copied module inside an isolated fixture
 * (fresh `$HOME`, neutral cwd, controllable `argv[1]`) so the synchronous
 * primary loader is forced to fail and only `tokenizerPackageRoots()` can
 * satisfy the load. Returns the loader's reported identity.
 */
function runIsolatedLoader(opts: {
    fakeHome: string;
    moduleDir: string;
    cwd: string;
    argv1: string;
    sample: string;
}): LoaderResult {
    const modulePath = join(
        opts.moduleDir,
        "src",
        "hooks",
        "magic-context",
        "read-session-formatting.ts",
    );
    const moduleUrl = pathToFileURL(modulePath).href;
    // The fixture module lives at a runtime-generated absolute path, so this
    // import inside the child cannot be a static import (test-loading boundary).
    const script =
        `(async () => {\n` +
        `    process.argv[1] = ${JSON.stringify(opts.argv1)};\n` +
        `    process.chdir(${JSON.stringify(opts.cwd)});\n` +
        `    const mod = await import(${JSON.stringify(moduleUrl)}); // fixture path is runtime-generated\n` +
        `    const ok = await mod.preloadTokenizer();\n` +
        `    const stats = mod.getTokenizerNativeMemoryStats();\n` +
        `    let count = null; let encErr = null;\n` +
        `    try { count = mod.estimateTokens(${JSON.stringify(opts.sample)}); } ` +
        `    catch (e) { encErr = String((e && e.stack) || e); }\n` +
        `    process.stdout.write(JSON.stringify({ ok, loaded: stats.loaded, tablePath: stats.tablePath, count, encErr }));\n` +
        `})().catch((e) => process.stdout.write(JSON.stringify({ error: String((e && e.stack) || e) })));\n`;

    // `--no-install` (plus fresh BUN_INSTALL / XDG_CACHE_HOME) stops Bun's
    // auto-install from fetching ai-tokenizer to satisfy the bare specifier in
    // the primary `createRequire(import.meta.url)` loader. Without it the
    // copied module's ancestor chain is empty, Bun downloads ai-tokenizer on
    // demand, the primary loader succeeds, and the fallback stays unexercised --
    // the opposite of what this fixture proves. With it the bare resolve throws
    // exactly as it does on the offline compiled host, forcing path B.
    const child = spawnSync(process.execPath, ["--no-install", "-e", script], {
        cwd: opts.cwd,
        env: {
            ...process.env,
            HOME: opts.fakeHome,
            BUN_INSTALL: opts.fakeHome,
            XDG_CACHE_HOME: join(opts.fakeHome, ".cache"),
        },
        encoding: "utf8",
        windowsHide: true,
    });
    if (child.error) {
        throw new Error(`failed to spawn loader fixture: ${String(child.error)}`);
    }
    const out = (child.stdout ?? "").trim();
    if (child.status !== 0 || out === "") {
        throw new Error(
            `loader fixture exited ${String(child.status)}: stdout=${JSON.stringify(out)} stderr=${JSON.stringify(child.stderr)}`,
        );
    }
    return JSON.parse(out) as LoaderResult;
}

/**
 * Resolution candidates for a relative specifier, kept identical to the
 * maintained pack-graph walker (`scripts/tui-pack-graph.ts`) so the fixture's
 * closure and the packaged-graph closure agree on what an import means.
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"];

/**
 * The transitive closure of literal relative imports of `entry`, discovered
 * the way `scripts/tui-pack-graph.ts` walks the packed graph: per-file
 * `Bun.Transpiler.scanImports` (type-only imports are erased, lazy and
 * `import()` branches are followed) resolved through `SOURCE_EXTENSIONS` and
 * `index.*` candidates. Bare specifiers (`ai-tokenizer`) are skipped by
 * design: the fixture must carry no `node_modules` subtree, and the isolated
 * loader proves the fallback exactly because the bare primary resolve throws.
 */
function runtimeImportClosure(entry: string): string[] {
    const visited = new Set<string>();
    const pending = [entry];
    while (pending.length > 0) {
        const file = pending.pop();
        if (!file || visited.has(file)) continue;
        visited.add(file);
        const ext = extname(file);
        if (ext === ".json") continue;
        const loader = ext === ".tsx" || ext === ".jsx" ? "tsx" : "ts";
        const imports = new Bun.Transpiler({ loader }).scanImports(readFileSync(file, "utf8"));
        for (const { path: specifier } of imports) {
            if (!specifier.startsWith(".")) continue;
            const base = resolve(dirname(file), specifier);
            const candidates = [
                base,
                ...SOURCE_EXTENSIONS.map((extension) => base + extension),
                ...SOURCE_EXTENSIONS.map((extension) => resolve(base, `index${extension}`)),
            ];
            const target = candidates.find(
                (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
            );
            if (!target) {
                throw new Error(
                    `loader fixture: ${relative(SRC_PKG, file)} imports missing ${specifier}`,
                );
            }
            pending.push(target);
        }
    }
    return [...visited];
}

/**
 * Copy the module plus its full recursive relative-import closure into an
 * isolated tree under `base`, mirroring the `packages/plugin/src` layout, and
 * assert nothing under that tree already carries ai-tokenizer (which would let
 * the primary loader succeed and leave the fallback unexercised).
 *
 * The closure is walked from the module itself instead of copying a fixed
 * folder list: `read-session-formatting.ts` reaches outside `shared/` (its
 * sibling `./token-count-exact`), and a hand-maintained folder copy goes
 * silently stale the next time the module gains an import elsewhere — the
 * isolated child then dies on the missing file rather than on the bare
 * ai-tokenizer resolve, and the fallback is never exercised. Test files cannot
 * leak in: runtime modules never import them, so no filter is needed.
 */
function buildLoaderFixture(base: string): { moduleDir: string } {
    const moduleDir = join(base, "mod");
    for (const file of runtimeImportClosure(SRC_HOOK)) {
        const dest = join(moduleDir, "src", relative(SRC_PKG, file));
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(file, dest);
    }
    for (const dir of [moduleDir, join(moduleDir, "src"), base]) {
        expect(existsSync(join(dir, "node_modules"))).toBe(false);
    }
    return { moduleDir };
}

const SAMPLE_TEXT = "Coverage check: naïve café 日本語 <EOT> const x = 1; // 3.14159";

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
        const hostPlugins = resolve(
            join(homedir(), ".omp", "plugins", "node_modules", "ai-tokenizer"),
        );
        expect(roots).toContain(hostPlugins);
        // Precedence contract: `findTokenizerImportPaths` binds the first
        // resolvable candidate, so the host-wide ~/.omp/plugins copy -- a
        // long-lived global tree that may hold a stale or foreign ai-tokenizer --
        // must be probed strictly AFTER every one of the plugin's own-tree
        // ancestors, keeping the declared version authoritative.
        const hostIndex = roots.indexOf(hostPlugins);
        expect(hostIndex).toBeGreaterThan(-1);
        for (const ancestor of moduleAncestors().map((root) => resolve(root))) {
            expect(roots.indexOf(ancestor)).toBeLessThan(hostIndex);
        }
    } finally {
        process.chdir(originalCwd);
        process.argv[1] = originalArgv1;
    }
});

test("the fallback loads from the plugin tree when the primary loader fails", () => {
    // Forces the initial `loadTokenizer()` (createRequire from import.meta.url)
    // to throw, because the copied module's ancestor chain carries no
    // ai-tokenizer. The only sanctioned copy is planted under the host plugin
    // root, so a pass proves the `tokenizerPackageRoots()` fallback ran and
    // bound it.
    mkdirSync(NEUTRAL_CWD, { recursive: true });
    const base = join(TESTS_ROOT, `tokenizer-fallback-${process.pid}-${Date.now()}`);
    const fakeHome = join(base, "home");
    const neutral = join(base, "neutral");
    mkdirSync(neutral, { recursive: true });
    try {
        const { moduleDir } = buildLoaderFixture(base);
        const hostPkg = join(fakeHome, ".omp", "plugins", "node_modules", "ai-tokenizer");
        // Precondition: the neutral cwd and the fake home bring nothing to the
        // table before this copy is planted, so a pass can only come from it.
        expect(existsSync(join(neutral, "node_modules", "ai-tokenizer"))).toBe(false);
        expect(existsSync(hostPkg)).toBe(false);
        plantAiTokenizer(hostPkg, 991);

        const result = runIsolatedLoader({
            fakeHome,
            moduleDir,
            cwd: neutral,
            argv1: "-p", // what the compiled host actually holds
            sample: SAMPLE_TEXT,
        });

        expect(result.error).toBeUndefined();
        expect(result.ok).toBe(true);
        expect(result.loaded).toBe(true);
        expect(result.tablePath).not.toBeNull();
        expect(result.encErr).toBeNull();
        // The fallback bound the planted host plugin-tree copy: its table lives
        // under that package, and its token count carries the planted marker --
        // neither the real repo dependency nor the launch cwd could produce it.
        const hostPkgReal = realpathSync(hostPkg);
        expect(result.tablePath?.startsWith(hostPkgReal + sep)).toBe(true);
        expect(result.tablePath?.startsWith(resolve(neutral) + sep)).toBe(false);
        expect(result.tablePath?.startsWith(resolve(moduleDir) + sep)).toBe(false);
        expect(result.count).toBe(SAMPLE_TEXT.length + 991);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
}, 30_000);

test("the plugin's own tree outranks the host-wide ~/.omp/plugins copy", () => {
    // Regression for the probe-order precedence fix: two sanctioned copies exist,
    // the plugin's own install tree and the host-wide ~/.omp/plugins global.
    // Because the initial loader fails for the copied module, the result is
    // decided purely by `tokenizerPackageRoots()` probe order feeding
    // `findTokenizerImportPaths` (first resolvable candidate wins). The own-tree
    // copy must bind; if ~/.omp/plugins were probed before the own-tree ancestors
    // the stale host copy would win instead.
    mkdirSync(NEUTRAL_CWD, { recursive: true });
    const base = join(TESTS_ROOT, `tokenizer-precedence-${process.pid}-${Date.now()}`);
    const fakeHome = join(base, "home");
    const neutral = join(base, "neutral");
    mkdirSync(neutral, { recursive: true });
    try {
        const { moduleDir } = buildLoaderFixture(base);
        const hostPkg = join(fakeHome, ".omp", "plugins", "node_modules", "ai-tokenizer");
        // The own-tree copy is reached by pushAncestors(argv[1]): argv[1] points
        // into <base>/launcher/deep, so <base>/launcher/node_modules is an
        // ancestor probed before the host-wide tree.
        const ownTreePkg = join(base, "launcher", "node_modules", "ai-tokenizer");
        expect(existsSync(hostPkg)).toBe(false);
        expect(existsSync(ownTreePkg)).toBe(false);
        plantAiTokenizer(hostPkg, 555); // stale host copy -- must NOT win
        plantAiTokenizer(ownTreePkg, 33); // the authoritative copy

        const result = runIsolatedLoader({
            fakeHome,
            moduleDir,
            cwd: neutral,
            argv1: join(base, "launcher", "deep", "bin.ts"),
            sample: SAMPLE_TEXT,
        });

        expect(result.error).toBeUndefined();
        expect(result.ok).toBe(true);
        expect(result.loaded).toBe(true);
        expect(result.tablePath).not.toBeNull();
        expect(result.encErr).toBeNull();
        // The authoritative own-tree copy (marker 33) won, not the host copy (555).
        expect(result.count).toBe(SAMPLE_TEXT.length + 33);
        expect(result.tablePath?.startsWith(realpathSync(ownTreePkg) + sep)).toBe(true);
        expect(result.tablePath?.startsWith(realpathSync(hostPkg) + sep)).toBe(false);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
}, 30_000);
