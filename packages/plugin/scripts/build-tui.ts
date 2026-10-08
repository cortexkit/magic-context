import { readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeModuleId, TUI_RUNTIME_SPECIFIERS } from "../src/shared/tui-runtime-specifiers";
import { writeIfChanged } from "./write-if-changed";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(pluginRoot, "src/tui");
const outputRoot = join(pluginRoot, "src/tui-compiled");
const runtimeSpecifiers: Set<string> = new Set(TUI_RUNTIME_SPECIFIERS);

type TransformSolidSource = (
    code: string,
    options: {
        filename: string;
        moduleName: string;
        resolvePath: (specifier: string) => string | null;
    },
) => Promise<string>;

type SolidTransformModule = {
    transformSolidSource?: TransformSolidSource;
};


/**
 * The Solid transform emits every runtime helper AND every control-flow builtin
 * (`For`, `Show`, `Index`, `Switch`, `Match`, `ErrorBoundary`, `Suspense`, ...)
 * as an import from a single `moduleName`, which we set to `@opentui/solid`.
 * But `@opentui/solid` only re-exports its own renderer helpers: the builtins
 * live in `solid-js`. An emitted `import { For } from "@opentui/solid"` therefore
 * resolves against the host's registry and throws
 *
 *     Export named 'For' not found in module 'opentui:runtime-module:@opentui/solid'
 *
 * which the host swallows, leaving no sidebar and no /ctx-* commands.
 *
 * Rather than hardcode the split (it moves between OpenTUI versions), read the
 * real export sets at build time and redirect only the names the OpenTUI runtime
 * genuinely lacks. A name missing from BOTH modules fails the build instead of
 * shipping a bundle that silently breaks the TUI.
 */
async function loadRuntimeExportSets(): Promise<{
    openTui: Set<string>;
    solid: Set<string>;
}> {
    const [openTuiModule, solidModule] = await Promise.all([
        import("@opentui/solid"),
        import("solid-js"),
    ]);
    return {
        openTui: new Set(Object.keys(openTuiModule)),
        solid: new Set(Object.keys(solidModule)),
    };
}

const OPENTUI_SOLID_RUNTIME_ID = runtimeModuleId("@opentui/solid");
const SOLID_JS_RUNTIME_ID = runtimeModuleId("solid-js");

// The transform emits one specifier per import statement, e.g.
//   import { For as _$For } from "opentui:runtime-module:%40opentui%2Fsolid";
const SINGLE_SPECIFIER_IMPORT =
    /^import \{\s*([A-Za-z_$][\w$]*)(\s+as\s+[A-Za-z_$][\w$]*)?\s*\} from "([^"]+)";$/;

function redirectBuiltinImports(
    code: string,
    exportSets: { openTui: Set<string>; solid: Set<string> },
    sourceFile: string,
): string {
    const unresolved: string[] = [];

    const rewritten = code
        .split("\n")
        .map((line) => {
            const match = SINGLE_SPECIFIER_IMPORT.exec(line);
            if (!match) return line;

            const [, importedName, alias, moduleId] = match;
            if (moduleId !== OPENTUI_SOLID_RUNTIME_ID) return line;
            if (exportSets.openTui.has(importedName)) return line;

            if (!exportSets.solid.has(importedName)) {
                unresolved.push(importedName);
                return line;
            }

            return `import {${alias ? ` ${importedName}${alias} ` : ` ${importedName} `}} from "${SOLID_JS_RUNTIME_ID}";`;
        })
        .join("\n");

    if (unresolved.length > 0) {
        throw new Error(
            `${sourceFile}: compiled TUI imports ${unresolved
                .map((name) => `'${name}'`)
                .join(", ")} which neither @opentui/solid nor solid-js exports. ` +
                "Shipping this bundle would make the host drop the sidebar silently.",
        );
    }

    return rewritten;
}

function asTransformSolidSource(mod: SolidTransformModule, from: string): TransformSolidSource {
    if (typeof mod.transformSolidSource !== "function") {
        throw new Error(`@opentui/solid transform loaded from ${from} without transformSolidSource`);
    }
    return mod.transformSolidSource;
}

async function importTransformModule(specifier: string): Promise<SolidTransformModule> {
    return (await import(specifier)) as SolidTransformModule;
}

async function resolveSolidTransformPath(): Promise<string> {
    const packageJsonSpecifier = "@opentui/solid/package.json";
    const errors: string[] = [];

    try {
        const packageJsonUrl = import.meta.resolve(packageJsonSpecifier);
        return join(dirname(fileURLToPath(packageJsonUrl)), "scripts/solid-transform.js");
    } catch (error) {
        errors.push(`import.meta.resolve: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
        const require = createRequire(import.meta.url);
        return join(dirname(require.resolve(packageJsonSpecifier)), "scripts/solid-transform.js");
    } catch (error) {
        errors.push(`require.resolve: ${error instanceof Error ? error.message : String(error)}`);
    }

    throw new Error(`Unable to resolve @opentui/solid transform (${errors.join("; ")})`);
}

async function loadTransformSolidSource(): Promise<TransformSolidSource> {
    const bareTransformSpecifier = "@opentui/solid/scripts/solid-transform.js";

    try {
        return asTransformSolidSource(
            await importTransformModule(bareTransformSpecifier),
            bareTransformSpecifier,
        );
    } catch {
        const transformPath = await resolveSolidTransformPath();
        return asTransformSolidSource(
            await importTransformModule(pathToFileURL(transformPath).href),
            transformPath,
        );
    }
}

function isShippedSourceFile(filePath: string): boolean {
    if (/\.test\.tsx?$/.test(basename(filePath))) return false;
    return filePath.endsWith(".tsx") || filePath.endsWith(".ts");
}

async function listSourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const files: string[] = [];
    for (const entry of entries) {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listSourceFiles(entryPath)));
        } else if (entry.isFile() && isShippedSourceFile(entryPath)) {
            files.push(entryPath);
        }
    }
    return files;
}

async function copyPlainTypeScript(sourceFile: string, outputFile: string): Promise<boolean> {
    return writeIfChanged(outputFile, await readFile(sourceFile));
}

async function compileTsx(
    transformSolidSource: TransformSolidSource,
    sourceFile: string,
    outputFile: string,
    exportSets: { openTui: Set<string>; solid: Set<string> },
): Promise<boolean> {
    const code = await readFile(sourceFile, "utf8");
    const compiled = await transformSolidSource(code, {
        filename: sourceFile,
        moduleName: runtimeModuleId("@opentui/solid"),
        resolvePath: (specifier: string) =>
            runtimeSpecifiers.has(specifier) ? runtimeModuleId(specifier) : null,
    });

    return writeIfChanged(outputFile, redirectBuiltinImports(compiled, exportSets, sourceFile));
}

const transformSolidSource = await loadTransformSolidSource();
const runtimeExportSets = await loadRuntimeExportSets();
const files = await listSourceFiles(sourceRoot);

// Regenerate in place rather than removing the output tree first. Consumers
// read this directory live: a Parallels VM sharing the checkout caches
// directory lookups, and an rm-then-recreate left it holding a stale negative
// entry for `index.tsx` (ENOENT in the OpenCode 2 TUI while the file existed on
// the host). Overwriting keeps the directory inode and every unchanged file's
// inode; only outputs whose source is gone are removed.
const expectedOutputs = new Set<string>();
let written = 0;

for (const sourceFile of files) {
    const relativePath = relative(sourceRoot, sourceFile);
    const outputFile = join(outputRoot, relativePath);
    expectedOutputs.add(outputFile);

    if (sourceFile.endsWith(".tsx")) {
        // OpenTUI skips the Solid compile-time transform for packages loaded from
        // node_modules. Without this precompiled copy, JSX children such as
        // signal-derived counts are evaluated once during element creation and
        // the sidebar freezes on its first paint. The virtual ids are required so
        // the compiled package binds the host process's single OpenTUI/Solid
        // runtime instead of loading a second copy from the plugin package.
        if (await compileTsx(transformSolidSource, sourceFile, outputFile, runtimeExportSets)) written++;
    } else {
        if (await copyPlainTypeScript(sourceFile, outputFile)) written++;
    }
}

let stale = 0;
for (const existing of await listSourceFiles(outputRoot)) {
    if (expectedOutputs.has(existing)) continue;
    await rm(existing, { force: true });
    stale += 1;
}

console.log(
    `build-tui: checked ${files.length} file(s), wrote ${written}, unchanged ${files.length - written} in ${relative(pluginRoot, outputRoot)}${stale ? ` (removed ${stale} stale)` : ""}`,
);
