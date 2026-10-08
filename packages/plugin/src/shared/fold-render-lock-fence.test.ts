import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../../../../");

for (const [host, path, functions] of [
    [
        "OpenCode",
        "packages/plugin/src/hooks/magic-context/inject-compartments.ts",
        ["materializeM0", "softRefreshCachedM1"],
    ],
    [
        "Pi",
        "packages/pi-plugin/src/inject-compartments-pi.ts",
        ["materializeM0Pi", "softRefreshCachedM1Pi"],
    ],
] as const) {
    test(`${host} fold and refresh render m[1] inside their writer section`, () => {
        const source = ts.createSourceFile(
            path,
            readFileSync(resolve(root, path), "utf8"),
            ts.ScriptTarget.Latest,
            true,
        );
        const inspected: string[] = [];
        const violations: string[] = [];
        function visit(node: ts.Node): void {
            if (
                ts.isFunctionDeclaration(node) &&
                node.name &&
                functions.some((name) => name === node.name?.text)
            ) {
                inspected.push(node.name.text);
                const calls: ts.CallExpression[] = [];
                function collect(child: ts.Node): void {
                    if (ts.isCallExpression(child)) calls.push(child);
                    ts.forEachChild(child, collect);
                }
                collect(node);
                const admission = calls.find(
                    (call) =>
                        call.expression.getText(source).endsWith(".exec") &&
                        call.arguments[0]?.getText(source) === '"BEGIN IMMEDIATE"',
                );
                expect(admission).toBeDefined();
                const commit = calls.find(
                    (call) =>
                        admission &&
                        call.pos > admission.pos &&
                        call.expression.getText(source).endsWith(".exec") &&
                        call.arguments[0]?.getText(source) === '"COMMIT"',
                );
                expect(commit).toBeDefined();
                const renders = calls.filter((call) =>
                    /^renderM1(?:Pi)?WithMetadata$/.test(call.expression.getText(source)),
                );
                expect(renders).toHaveLength(1);
                for (const render of renders) {
                    if (
                        !admission ||
                        !commit ||
                        render.pos < admission.pos ||
                        render.pos > commit.pos
                    )
                        violations.push(`${node.name.text}: m[1] render outside writer`);
                }
                for (const call of calls) {
                    if (
                        call.expression.getText(source).endsWith("onFoldPrepare") &&
                        admission &&
                        call.pos > admission.pos
                    )
                        violations.push(`${node.name.text}: wire preparation inside writer`);
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
        expect(inspected.sort()).toEqual([...functions].sort());
        expect(violations).toEqual([]);
    });
}
