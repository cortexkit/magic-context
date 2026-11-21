import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { TUI_RUNTIME_SPECIFIERS } from "../shared/tui-runtime-specifiers";

/**
 * Every `opentui:runtime-module:*` import in the compiled TUI bundle must name an
 * export the target module actually has.
 *
 * The Solid transform routes ALL of its emitted imports — renderer helpers and
 * control-flow builtins (`For`, `Show`, `Index`, `Switch`, `Match`, ...) alike —
 * through the single `moduleName` that `scripts/build-tui.ts` passes it, which is
 * `@opentui/solid`. But `@opentui/solid` only re-exports its own renderer
 * helpers; the builtins live in `solid-js`. So a bundle built without the
 * redirect in `build-tui.ts` contains
 *
 *     import { For as _$For } from "opentui:runtime-module:%40opentui%2Fsolid";
 *
 * and the host throws `Export named 'For' not found` while loading the plugin.
 * OpenCode swallows that error, so the only visible symptom is a missing sidebar
 * and missing /ctx-* commands — no crash and nothing on stderr.
 *
 * This test resolves each specifier against the real module export sets instead
 * of a hardcoded list, so it keeps holding when OpenTUI changes which names it
 * re-exports. It covers every specifier `build-tui.ts` rewrites (via the shared
 * `TUI_RUNTIME_SPECIFIERS` list) and fails on any runtime module id outside that
 * set, so a future import from e.g. `solid-js/store` cannot slip through
 * unverified.
 */
describe("compiled TUI runtime imports", () => {
    const COMPILED_ROOT = join(import.meta.dir, "..", "tui-compiled");
    const IMPORT_PATTERN = /import \{([^}]+)\} from "opentui:runtime-module:([^"]+)"/g;

    function compiledFiles(dir: string): string[] {
        const found: string[] = [];
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                found.push(...compiledFiles(full));
            } else if (entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".js")) {
                found.push(full);
            }
        }
        return found;
    }

    /** Export sets for EVERY specifier build-tui.ts rewrites, keyed by module id.
     *  Built from the shared list so the test cannot cover fewer modules than the
     *  build rewrites. */
    async function loadExportSets(): Promise<Record<string, Set<string>>> {
        // @opentui/core/testing subclasses a core export during module initialization;
        // warm core before the parallel imports so Bun cannot expose its TDZ.
        await import("@opentui/core");
        const entries = await Promise.all(
            TUI_RUNTIME_SPECIFIERS.map(
                async (specifier) =>
                    [specifier, new Set(Object.keys(await import(specifier)))] as const,
            ),
        );
        return Object.fromEntries(entries);
    }

    test("every runtime specifier exists in the module it is imported from", async () => {
        const exportSets = await loadExportSets();

        const unresolved: string[] = [];
        let checked = 0;

        for (const file of compiledFiles(COMPILED_ROOT)) {
            const source = readFileSync(file, "utf8");
            for (const match of source.matchAll(IMPORT_PATTERN)) {
                const moduleId = decodeURIComponent(match[2] ?? "");
                const exports = exportSets[moduleId];
                if (!exports) {
                    // A runtime module id outside the rewritten set means the build
                    // emitted something this guard does not know how to verify.
                    // Failing is the only safe answer: skipping it silently is the
                    // exact hole that let the `For` misroute ship.
                    unresolved.push(
                        `${file}: imports from unknown runtime module '${moduleId}' — ` +
                            "add it to TUI_RUNTIME_SPECIFIERS so it can be verified",
                    );
                    continue;
                }

                for (const specifier of (match[1] ?? "").split(",")) {
                    const importedName = specifier
                        .trim()
                        .split(/\s+as\s+/)[0]
                        ?.trim();
                    if (!importedName) continue;
                    checked += 1;
                    if (!exports.has(importedName)) {
                        unresolved.push(
                            `${file}: '${importedName}' is not exported by ${moduleId}`,
                        );
                    }
                }
            }
        }

        expect(checked).toBeGreaterThan(0);
        expect(unresolved).toEqual([]);
    });

    test("every rewritten specifier resolves to a non-empty module", async () => {
        // A specifier that stops resolving already fails loudly on its own: the
        // dynamic import inside loadExportSets throws and takes the test with it.
        // What that does NOT catch is a specifier that resolves to an empty module
        // (a renamed or emptied subpath export), which would make the guard above
        // report every import from it as unresolved for a misleading reason.
        const exportSets = await loadExportSets();

        const empty = TUI_RUNTIME_SPECIFIERS.filter(
            (specifier) => (exportSets[specifier]?.size ?? 0) === 0,
        );
        expect(empty).toEqual([]);
    });

    test("TUI_RUNTIME_SPECIFIERS has no duplicates", () => {
        // Object.fromEntries silently collapses duplicate keys, so a duplicated
        // entry would shrink the export-set map without any other signal.
        expect([...new Set(TUI_RUNTIME_SPECIFIERS)]).toEqual([...TUI_RUNTIME_SPECIFIERS]);
    });

    test("solid control-flow builtins are imported from solid-js, not @opentui/solid", async () => {
        const openTuiExports = new Set(Object.keys(await import("@opentui/solid")));
        const solidExports = new Set(Object.keys(await import("solid-js")));

        // The builtins that belong to solid-js alone — the exact set the
        // transform would otherwise misroute to @opentui/solid.
        const misroutable = [...solidExports].filter((name) => !openTuiExports.has(name));

        const violations: string[] = [];
        for (const file of compiledFiles(COMPILED_ROOT)) {
            const source = readFileSync(file, "utf8");
            for (const match of source.matchAll(IMPORT_PATTERN)) {
                if (decodeURIComponent(match[2] ?? "") !== "@opentui/solid") continue;
                for (const specifier of (match[1] ?? "").split(",")) {
                    const importedName = specifier
                        .trim()
                        .split(/\s+as\s+/)[0]
                        ?.trim();
                    if (importedName && misroutable.includes(importedName)) {
                        violations.push(`${file}: '${importedName}' must come from solid-js`);
                    }
                }
            }
        }

        expect(violations).toEqual([]);
    });
});
