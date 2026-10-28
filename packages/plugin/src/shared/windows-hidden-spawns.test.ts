import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../../../..");
const visibleGuiInstallers = [
    {
        path: "packages/cli/src/lib/dashboard-install.ts",
        callee: "installerPath",
        reason: "GUI installer in passive mode: its progress window must stay visible.",
    },
] as const;
const subprocessNames = new Set([
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
]);

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
    });
}

function missingHiddenOptions(path: string, text = readFileSync(path, "utf8")): string[] {
    if (!/node:child_process|Bun\.spawn/.test(text)) return [];
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const imports = new Map<string, string>();
    const promisifyImports = new Set<string>();
    const utilImports = new Set<string>();
    const variables = new Map<string, ts.Expression>();
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
            continue;
        const module = statement.moduleSpecifier.text;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
                const imported = element.propertyName?.text ?? element.name.text;
                if (module === "node:child_process" && subprocessNames.has(imported))
                    imports.set(element.name.text, imported);
                if ((module === "node:util" || module === "util") && imported === "promisify")
                    promisifyImports.add(element.name.text);
            }
        }
        if (module === "node:util" || module === "util") {
            if (bindings && ts.isNamespaceImport(bindings)) utilImports.add(bindings.name.text);
            if (statement.importClause?.name) utilImports.add(statement.importClause.name.text);
        }
    }
    function collect(node: ts.Node): void {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
            variables.set(node.name.text, node.initializer);
        ts.forEachChild(node, collect);
    }
    collect(source);
    function isUtil(node: ts.Expression, seen = new Set<string>()): boolean {
        if (ts.isParenthesizedExpression(node)) return isUtil(node.expression, seen);
        if (!ts.isIdentifier(node)) return false;
        if (utilImports.has(node.text)) return true;
        if (seen.has(node.text)) return false;
        seen.add(node.text);
        const initializer = variables.get(node.text);
        return initializer ? isUtil(initializer, seen) : false;
    }
    function isPromisify(node: ts.Expression, seen = new Set<string>()): boolean {
        if (ts.isParenthesizedExpression(node)) return isPromisify(node.expression, seen);
        if (ts.isIdentifier(node)) {
            if (promisifyImports.has(node.text)) return true;
            if (seen.has(node.text)) return false;
            seen.add(node.text);
            const initializer = variables.get(node.text);
            return initializer ? isPromisify(initializer, seen) : false;
        }
        return (
            ts.isPropertyAccessExpression(node) &&
            isUtil(node.expression) &&
            node.name.text === "promisify"
        );
    }
    function subprocess(node: ts.Expression, seen = new Set<string>()): string | undefined {
        if (ts.isParenthesizedExpression(node)) return subprocess(node.expression, seen);
        if (ts.isIdentifier(node)) {
            const imported = imports.get(node.text);
            if (imported) return imported;
            if (seen.has(node.text)) return undefined;
            seen.add(node.text);
            const initializer = variables.get(node.text);
            return initializer ? subprocess(initializer, seen) : undefined;
        }
        if (ts.isCallExpression(node) && isPromisify(node.expression) && node.arguments[0])
            return subprocess(node.arguments[0], seen);
        return undefined;
    }
    function hidden(node: ts.Expression | undefined, seen = new Set<string>()): boolean {
        if (!node) return false;
        if (ts.isIdentifier(node)) {
            if (seen.has(node.text)) return false;
            seen.add(node.text);
            return hidden(variables.get(node.text), seen);
        }
        if (!ts.isObjectLiteralExpression(node)) return false;
        // Later spreads can override an earlier flag, so inspect the effective last assignment.
        for (const property of [...node.properties].reverse()) {
            if (
                ts.isPropertyAssignment(property) &&
                property.name.getText(source) === "windowsHide"
            ) {
                return property.initializer.kind === ts.SyntaxKind.TrueKeyword;
            }
            if (ts.isSpreadAssignment(property) && hidden(property.expression, new Set(seen)))
                return true;
        }
        return false;
    }
    function explicitlyVisible(node: ts.Expression | undefined): boolean {
        if (!node || !ts.isObjectLiteralExpression(node)) return false;
        for (const property of [...node.properties].reverse()) {
            if (ts.isSpreadAssignment(property)) return false;
            if (
                ts.isPropertyAssignment(property) &&
                property.name.getText(source) === "windowsHide"
            )
                return property.initializer.kind === ts.SyntaxKind.FalseKeyword;
        }
        return false;
    }
    const failures: string[] = [];
    function visit(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
            const expression = node.expression;
            let name: string | undefined;
            // Track the original API, not the alias name: exec takes options at index 1,
            // while execFile and spawn take them at index 2, even after promisify.
            let kind = subprocess(expression);
            if (kind) name = expression.getText(source);
            if (
                !kind &&
                ts.isIdentifier(expression) &&
                ([
                    "execFileAsync",
                    "execFileSyncForIdentity",
                    "rpcIdentityExecFileSync",
                    "execFileForVerificationPaths",
                ].includes(expression.text) ||
                    (expression.text === "exec" && path.endsWith("rpc-utils.ts")))
            ) {
                name = expression.text;
                kind = "execFile";
            }
            if (ts.isPropertyAccessExpression(expression)) {
                const owner = expression.expression.getText(source);
                if (
                    owner === "Bun" &&
                    (expression.name.text === "spawn" || expression.name.text === "spawnSync")
                ) {
                    name = "Bun.spawn";
                    kind = "Bun.spawn";
                }
                if (
                    (owner === "deps" || owner === "this") &&
                    (subprocessNames.has(expression.name.text) ||
                        expression.name.text === "spawnImpl")
                ) {
                    name = expression.name.text;
                    kind = expression.name.text;
                }
            }
            if (name) {
                const index =
                    kind === "Bun.spawn"
                        ? node.arguments.length === 1
                            ? 0
                            : 1
                        : kind === "execSync" || kind === "exec"
                          ? 1
                          : 2;
                // A single-argument Bun.spawnSync({cmd, ...}) passes options as its first argument.
                const option = node.arguments[index];
                const visibleGuiInstaller =
                    name === "execFileAsync" &&
                    visibleGuiInstallers.some(
                        (entry) =>
                            relative(root, path).replaceAll("\\", "/") === entry.path &&
                            node.arguments[0]?.getText(source) === entry.callee,
                    ) &&
                    explicitlyVisible(option);
                if (!hidden(option) && !visibleGuiInstaller) {
                    const line =
                        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
                    failures.push(`${relative(root, path)}:${line} ${name}`);
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    return failures;
}

describe("Windows child processes", () => {
    test("every plugin, Pi and CLI subprocess hides its Windows console", () => {
        const failures = ["plugin", "pi-plugin", "cli"].flatMap((pkg) =>
            sourceFiles(join(root, "packages", pkg, "src")).flatMap((path) =>
                missingHiddenOptions(path),
            ),
        );
        expect(failures).toEqual([]);
    });

    test.each([
        ["execFile", "[],"],
        ["exec", ""],
        ["spawn", "[],"],
    ])("follows promisified %s aliases and checks the original options position", (api, args) => {
        const path = join(root, "packages/plugin/src/shared/promisified-fixture.ts");
        const text = `import { ${api} as childProcess } from "node:child_process";
            import { promisify as toPromise } from "node:util";
            const rawAlias = childProcess;
            const promiseAlias = toPromise;
            const exec = promiseAlias(rawAlias);
            const run = exec;
            run("git", ${args} { windowsHide: true });
            run("git", ${args} { windowsHide: false });
            run("git", ${args} {});`;
        expect(missingHiddenOptions(path, text)).toEqual([
            "packages/plugin/src/shared/promisified-fixture.ts:8 run",
            "packages/plugin/src/shared/promisified-fixture.ts:9 run",
        ]);
    });

    test.each([
        'import { promisify } from "node:util";',
        'import * as util from "node:util"; const promisify = util.promisify;',
        'import util from "util"; const promisify = util.promisify;',
        'import * as util from "node:util"; const u = util; const promisify = u.promisify;',
    ])("recognizes promisify bindings: %s", (utilImport) => {
        const path = join(root, "packages/plugin/src/shared/promisified-fixture.ts");
        const text = `import { execFile } from "node:child_process";
            ${utilImport}
            const exec = promisify(execFile);
            exec("git", [], { windowsHide: true });
            exec("git", [], {});`;
        expect(missingHiddenOptions(path, text)).toEqual([
            "packages/plugin/src/shared/promisified-fixture.ts:5 exec",
        ]);
    });

    test("recognizes direct util.promisify calls and does not trust options in the wrong slot", () => {
        const path = join(root, "packages/plugin/src/shared/promisified-fixture.ts");
        const text = `import { execFile, exec, spawn } from "node:child_process";
            import * as util from "node:util";
            const file = util.promisify(execFile);
            const shell = util.promisify(exec);
            const child = util.promisify(spawn);
            file("git", { windowsHide: true }, {});
            shell("git", {}, { windowsHide: true });
            child("git", { windowsHide: true }, {});`;
        expect(missingHiddenOptions(path, text)).toEqual([
            "packages/plugin/src/shared/promisified-fixture.ts:6 file",
            "packages/plugin/src/shared/promisified-fixture.ts:7 shell",
            "packages/plugin/src/shared/promisified-fixture.ts:8 child",
        ]);
    });

    test("another dashboard subprocess still requires windowsHide true", () => {
        const path = join(root, "packages/cli/src/lib/dashboard-install.ts");
        const text = `import { execFile } from "node:child_process";
            execFileAsync(installerPath, ["/P"], { windowsHide: false });
            execFileAsync("tar", [], { windowsHide: false });`;
        expect(missingHiddenOptions(path, text)).toEqual([
            "packages/cli/src/lib/dashboard-install.ts:3 execFileAsync",
        ]);
    });

    test("the GUI installer exemption requires explicit windowsHide false", () => {
        const path = join(root, "packages/cli/src/lib/dashboard-install.ts");
        const text = `import { execFile } from "node:child_process";
            execFileAsync(installerPath, ["/P"]);`;
        expect(missingHiddenOptions(path, text)).toEqual([
            "packages/cli/src/lib/dashboard-install.ts:2 execFileAsync",
        ]);
    });

    test("the GUI installer callee is not exempt in a different file", () => {
        const path = join(root, "packages/cli/src/lib/other-installer.ts");
        const text = `import { execFile } from "node:child_process";
            execFileAsync(installerPath, ["/P"], { windowsHide: false });`;
        expect(missingHiddenOptions(path, text)).toEqual([
            "packages/cli/src/lib/other-installer.ts:2 execFileAsync",
        ]);
    });
});
