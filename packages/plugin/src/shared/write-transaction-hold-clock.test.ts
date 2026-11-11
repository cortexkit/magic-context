import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
    callback(node);
    ts.forEachChild(node, (child) => visit(child, callback));
}
function acquires(statement: ts.Statement): boolean {
    const direct = (expression: ts.Expression): boolean => {
        if (
            ts.isBinaryExpression(expression) &&
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        )
            return direct(expression.right);
        if (!ts.isCallExpression(expression)) return false;
        // Pi's prefix helper completes either an inline BEGIN or a savepoint
        // under an already-admitted paired writer. Its clock starts afterwards.
        if (expression.expression.getText() === "beginPrefixWrite") return true;
        // The OpenCode fold's write-section helper (inject-compartments.ts) runs
        // the BEGIN IMMEDIATE it is handed when no transaction is open, and
        // otherwise takes the write lock under a savepoint; either way it
        // returns holding the writer. It counts only when handed a literal
        // writer BEGIN, like a direct exec.
        if (expression.expression.getText() === "beginFoldWriter") {
            const begin = expression.arguments[1];
            return (
                !!begin &&
                ts.isArrowFunction(begin) &&
                !ts.isBlock(begin.body) &&
                direct(begin.body)
            );
        }
        if (
            ts.isPropertyAccessExpression(expression.expression) &&
            expression.expression.name.text === "exec"
        ) {
            const sql = expression.arguments[0];
            return (
                !!sql && ts.isStringLiteral(sql) && /^BEGIN (?:IMMEDIATE|EXCLUSIVE)$/.test(sql.text)
            );
        }
        if (
            ["withSqliteBackgroundWriter", "withoutSqliteTransformPass"].includes(
                expression.expression.getText(),
            )
        ) {
            const callback = expression.arguments[0];
            return (
                !!callback &&
                ts.isArrowFunction(callback) &&
                !ts.isBlock(callback.body) &&
                direct(callback.body)
            );
        }
        return false;
    };
    if (ts.isExpressionStatement(statement)) return direct(statement.expression);
    if (ts.isVariableStatement(statement))
        return statement.declarationList.declarations.some(
            (declaration) => !!declaration.initializer && direct(declaration.initializer),
        );
    if (ts.isTryStatement(statement)) {
        const last = statement.catchClause?.block.statements.at(-1);
        return (
            !!last &&
            (ts.isReturnStatement(last) || ts.isThrowStatement(last)) &&
            statement.tryBlock.statements.some(acquires)
        );
    }
    return false;
}
function afterAdmission(clock: ts.Node): boolean {
    for (let node: ts.Node | undefined = clock; node; node = node.parent) {
        if (ts.isBlock(node.parent) && ts.isStatement(node)) {
            const preceding = node.parent.statements.slice(0, node.parent.statements.indexOf(node));
            if (preceding.some(acquires)) return true;
        }
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
            const call = node.parent;
            if (
                ts.isCallExpression(call) &&
                ts.isPropertyAccessExpression(call.expression) &&
                call.expression.name.text === "transaction"
            ) {
                const mode = call.parent;
                if (
                    ts.isPropertyAccessExpression(mode) &&
                    ["immediate", "exclusive"].includes(mode.name.text)
                )
                    return true;
            }
            return false;
        }
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return false;
    }
    return false;
}
function violations(text: string, path: string): string[] {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const result: string[] = [];
    visit(source, (node) => {
        if (!ts.isCallExpression(node) || node.expression.getText() !== "logSlowWriteTransaction")
            return;
        const clockName = node.arguments[1]?.getText();
        let scope: ts.Node = node;
        while (scope.parent && !ts.isFunctionLike(scope)) scope = scope.parent;
        const clocks: ts.Node[] = [];
        let asyncAdmission = false;
        visit(scope, (candidate) => {
            const rhs =
                ts.isVariableDeclaration(candidate) && candidate.name.getText() === clockName
                    ? candidate.initializer
                    : ts.isBinaryExpression(candidate) &&
                        candidate.left.getText() === clockName &&
                        candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken
                      ? candidate.right
                      : undefined;
            if (!rhs) return;
            if (rhs.getText().includes("performance.now()")) clocks.push(candidate);
            if (
                ts.isAwaitExpression(rhs) &&
                ts.isCallExpression(rhs.expression) &&
                rhs.expression.expression.getText() === "beginSqliteWriterAsync"
            )
                asyncAdmission = true;
        });
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if ((!clocks.length && !asyncAdmission) || clocks.some((clock) => !afterAdmission(clock)))
            result.push(
                `${path}:${line} ${node.arguments[0]?.getText()} starts its hold clock before writer admission`,
            );
    });
    return result;
}

test("hold-clock fence distinguishes wait time from transaction callback time", () => {
    expect(
        violations(
            'function f(db) { const writer=beginPrefixWrite(db,true); const clock=performance.now(); logSlowWriteTransaction("good",clock); }',
            "fixture.ts",
        ),
    ).toEqual([]);
    expect(
        violations(
            'function f(db) { const clock=performance.now(); const writer=beginPrefixWrite(db,true); logSlowWriteTransaction("bad",clock); }',
            "fixture.ts",
        ),
    ).toHaveLength(1);
    expect(
        violations(
            'function f(db) { const clock=performance.now(); db.exec("BEGIN IMMEDIATE"); logSlowWriteTransaction("bad",clock); }',
            "fixture.ts",
        ),
    ).toHaveLength(1);
    expect(
        violations(
            'function f(db) { db.exec("BEGIN IMMEDIATE"); const clock=performance.now(); logSlowWriteTransaction("good",clock); }',
            "fixture.ts",
        ),
    ).toEqual([]);
    expect(
        violations(
            'function f(db) { withoutSqliteTransformPass(()=>withSqliteBackgroundWriter(()=>db.exec("BEGIN IMMEDIATE"))); const clock=performance.now(); logSlowWriteTransaction("good",clock); }',
            "fixture.ts",
        ),
    ).toEqual([]);
    expect(
        violations(
            'function f(db) { let clock=0; db.transaction(()=>{clock=performance.now();}).immediate(); logSlowWriteTransaction("good",clock); }',
            "fixture.ts",
        ),
    ).toEqual([]);
    expect(
        violations(
            'function f(db) { const clock=performance.now(); db.transaction(()=>{}).immediate(); logSlowWriteTransaction("bad",clock); }',
            "fixture.ts",
        ),
    ).toHaveLength(1);
    expect(
        violations(
            'function f(db) { const writer=beginFoldWriter(db,()=>db.exec("BEGIN IMMEDIATE")); const clock=performance.now(); logSlowWriteTransaction("good",clock); }',
            "fixture.ts",
        ),
    ).toEqual([]);
    for (const bad of [
        'function f(db) { const clock=performance.now(); const writer=beginFoldWriter(db,()=>db.exec("BEGIN IMMEDIATE")); logSlowWriteTransaction("bad",clock); }',
        'function f(db) { const writer=beginFoldWriter(db,()=>db.exec("BEGIN")); const clock=performance.now(); logSlowWriteTransaction("bad",clock); }',
        'function f(db) { const reader=beginFoldRead(db,()=>db.exec("BEGIN IMMEDIATE")); const clock=performance.now(); logSlowWriteTransaction("bad",clock); }',
    ])
        expect(violations(bad, "fixture.ts")).toHaveLength(1);
});

test("every slow-write hold clock starts after writer admission", () => {
    const root = resolve(import.meta.dir, "../../../../");
    const failures: string[] = [];
    let sources = 0;
    for (const pattern of ["packages/plugin/src/**/*.ts", "packages/pi-plugin/src/**/*.ts"]) {
        for (const path of new Bun.Glob(pattern).scanSync({ cwd: root })) {
            if (path.endsWith(".test.ts")) continue;
            const text = readFileSync(resolve(root, path), "utf8");
            if (!text.includes("logSlowWriteTransaction(")) continue;
            sources++;
            failures.push(...violations(text, path));
        }
    }
    expect(sources).toBeGreaterThan(20);
    expect(failures).toEqual([]);
});
