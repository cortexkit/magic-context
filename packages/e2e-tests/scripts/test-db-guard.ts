import ts from "typescript";

// These tests need more than openTestDb's five seconds. Each constructor must
// still set a timeout on its own handle before using it; no file is exempt.
const longerTimeoutFiles = new Set([
    "src/rust-harness.ts",
    "src/repro/incomplete-user-real-host.ts",
    "src/repro/reasoning-removal-real-host.ts",
    "tests/rust-classify-host-runner.test.ts",
    "tests/rust-classify-producer.test.ts",
    "tests/rust-compaction-marker-byte-identity.test.ts",
    "tests/rust-compaction-marker-catchup.test.ts",
    "tests/opencode2/active-thinking-prefix-hold.test.ts",
    "tests/opencode2/dreamer-task-context.test.ts",
    "tests/opencode2/hidden-mapping-transcript.test.ts",
    "tests/opencode2/latest-turn-thinking-recovery.test.ts",
    "tests/opencode2/signed-drop-rebuild.test.ts",
    "tests/opencode2/store-generation-conversion.test.ts",
    "tests/opencode2/tool-definition-cache-loss.test.ts",
]);

function directDatabaseOpens(path: string, text: string) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const constructors = new Set<string>();
    const namespaces = new Set<string>();
    for (const statement of source.statements) {
        if (
            !ts.isImportDeclaration(statement) ||
            !ts.isStringLiteral(statement.moduleSpecifier) ||
            statement.moduleSpecifier.text !== "bun:sqlite" ||
            statement.importClause?.isTypeOnly
        )
            continue;
        const clause = statement.importClause;
        if (clause?.name) constructors.add(clause.name.text);
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) {
            for (const binding of bindings.elements) {
                if (
                    !binding.isTypeOnly &&
                    (binding.propertyName ?? binding.name).text === "Database"
                ) {
                    constructors.add(binding.name.text);
                }
            }
        }
    }

    const opens: Array<{ line: number; timeout: number }> = [];
    function visit(node: ts.Node) {
        if (
            ts.isNewExpression(node) &&
            ((ts.isIdentifier(node.expression) && constructors.has(node.expression.text)) ||
                (ts.isPropertyAccessExpression(node.expression) &&
                    ts.isIdentifier(node.expression.expression) &&
                    namespaces.has(node.expression.expression.text) &&
                    node.expression.name.text === "Database"))
        ) {
            opens.push({
                line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
                timeout: immediateTimeout(node),
            });
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    return opens;
}

function immediateTimeout(open: ts.NewExpression): number {
    let value: ts.Node = open;
    while (ts.isAsExpression(value.parent) || ts.isParenthesizedExpression(value.parent))
        value = value.parent;
    const declaration = value.parent;
    if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return 0;
    if (
        !ts.isVariableDeclarationList(declaration.parent) ||
        declaration.parent.declarations.length !== 1
    )
        return 0;
    const name = declaration.name.text;
    const statement = declaration.parent.parent;
    if (!ts.isVariableStatement(statement)) return 0;
    const block = statement.parent;
    if (!ts.isBlock(block) && !ts.isSourceFile(block)) return 0;
    // Look for the first use of this handle, including inside a try/finally.
    // Unrelated declarations between the open and the PRAGMA are harmless.
    for (const next of block.statements.slice(block.statements.indexOf(statement) + 1)) {
        let firstUse: ts.Identifier | undefined;
        function visit(node: ts.Node) {
            if (firstUse) return;
            if (ts.isIdentifier(node) && node.text === name) firstUse = node;
            else ts.forEachChild(node, visit);
        }
        visit(next);
        if (!firstUse) continue;
        // A deferred callback or conditional branch does not configure the
        // freshly opened handle before the following statements can use it.
        for (
            let ancestor: ts.Node = firstUse;
            ancestor !== next.parent;
            ancestor = ancestor.parent
        ) {
            if (
                ts.isFunctionLike(ancestor) ||
                ts.isIfStatement(ancestor) ||
                ts.isConditionalExpression(ancestor) ||
                ts.isBinaryExpression(ancestor) ||
                ts.isIterationStatement(ancestor, false)
            )
                return 0;
        }
        const access = firstUse.parent;
        if (
            !ts.isPropertyAccessExpression(access) ||
            access.expression !== firstUse ||
            !["exec", "run"].includes(access.name.text)
        )
            return 0;
        const call = access.parent;
        if (!ts.isCallExpression(call) || call.expression !== access) return 0;
        const sql = call.arguments[0];
        if (!sql || (!ts.isStringLiteral(sql) && !ts.isNoSubstitutionTemplateLiteral(sql)))
            return 0;
        const match = /^\s*PRAGMA\s+busy_timeout\s*=\s*(\d+)\s*(?:;|$)/i.exec(sql.text);
        return match ? Number(match[1]) : 0;
    }
    return 0;
}

export function databaseOpenViolations(path: string, text: string): string[] {
    if (path === "src/test-db.ts") return [];
    return directDatabaseOpens(path, text)
        .filter((open) => !longerTimeoutFiles.has(path) || open.timeout <= 5000)
        .map(
            (open) =>
                `${path}:${open.line}: use openTestDb from src/test-db.ts instead of a direct bun:sqlite Database constructor`,
        );
}
