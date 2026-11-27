import ts from "typescript";

const minimumTimeout = 5000;
type SqliteModule = "bun" | "node" | "wrapper" | "storage";
type Binding =
    | { module: SqliteModule }
    | "bun-constructor"
    | "constructor"
    | "factory"
    | "boot-timeout";

function sqliteModule(specifier: ts.Expression | undefined): SqliteModule | undefined {
    if (!specifier || !ts.isStringLiteral(specifier)) return undefined;
    const path = specifier.text.replace(/\.[cm]?[jt]s$/, "");
    if (path === "bun:sqlite") return "bun";
    if (path === "node:sqlite") return "node";
    if (/(?:\/plugin\/src|^@magic-context\/core)\/shared\/sqlite$/.test(path)) return "wrapper";
    if (
        /(?:\/plugin\/src|^@magic-context\/core)\/features\/magic-context\/storage(?:-db)?$/.test(path)
    )
        return "storage";
}

function exportedBinding(module: SqliteModule, name: string): Binding | undefined {
    if (module === "bun" && ["Database", "default"].includes(name)) return "bun-constructor";
    if (module === "node" && name === "DatabaseSync") return "constructor";
    if (module === "wrapper") {
        if (name === "Database") return "constructor";
        if (["createSqliteTurnDatabase", "openImmutableDatabase"].includes(name)) return "factory";
    }
    if (module === "storage" && name === "BOOT_SQLITE_BUSY_TIMEOUT_MS") return "boot-timeout";
}

function databaseBindings(source: ts.SourceFile) {
    const bindings = new Map<string, Binding>();
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
        const module = sqliteModule(statement.moduleSpecifier);
        if (!module) continue;
        const clause = statement.importClause;
        const defaultBinding = exportedBinding(module, "default");
        if (clause?.name && defaultBinding) bindings.set(clause.name.text, defaultBinding);
        const named = clause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, { module });
        if (named && ts.isNamedImports(named)) {
            for (const specifier of named.elements) {
                if (specifier.isTypeOnly) continue;
                const binding = exportedBinding(
                    module,
                    (specifier.propertyName ?? specifier.name).text,
                );
                if (binding) bindings.set(specifier.name.text, binding);
            }
        }
    }

    function bindingOf(expression: ts.Expression): Binding | undefined {
        if (ts.isIdentifier(expression)) return bindings.get(expression.text);
        if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression))
            return bindingOf(expression.expression);
        if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
            const receiver = bindingOf(expression.expression);
            const name = ts.isPropertyAccessExpression(expression)
                ? expression.name.text
                : ts.isStringLiteral(expression.argumentExpression)
                  ? expression.argumentExpression.text
                  : undefined;
            if (typeof receiver === "object" && name) return exportedBinding(receiver.module, name);
            if (receiver === "bun-constructor" && name === "open") return "factory";
        }
        if (ts.isCallExpression(expression)) {
            const callee = expression.expression;
            const loadsModule =
                callee.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(callee) && callee.text === "require") ||
                (ts.isPropertyAccessExpression(callee) &&
                    callee.getText(source) === "process.getBuiltinModule");
            const module = loadsModule ? sqliteModule(expression.arguments[0]) : undefined;
            if (module) return { module };
        }
    }

    function collect(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && node.initializer) {
            const binding = bindingOf(node.initializer);
            if (binding && ts.isIdentifier(node.name)) bindings.set(node.name.text, binding);
            if (typeof binding === "object" && ts.isObjectBindingPattern(node.name)) {
                for (const element of node.name.elements) {
                    const exported = element.propertyName ?? element.name;
                    if (!ts.isIdentifier(element.name) || !ts.isIdentifier(exported)) continue;
                    const member = exportedBinding(binding.module, exported.text);
                    if (member) bindings.set(element.name.text, member);
                }
            }
        }
        if (ts.isClassDeclaration(node) && node.name) {
            const base = node.heritageClauses?.find(
                (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
            )?.types[0];
            if (base && isConstructor(bindingOf(base.expression)))
                bindings.set(node.name.text, "constructor");
        }
        ts.forEachChild(node, collect);
    }
    collect(source);
    return bindingOf;
}

function isConstructor(binding: Binding | undefined): boolean {
    return binding === "constructor" || binding === "bun-constructor";
}

function containingStatement(node: ts.Node): ts.Statement | undefined {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
        if (ts.isStatement(current)) return current;
    }
}

function optsOut(open: ts.Expression, source: ts.SourceFile): boolean {
    const statement = containingStatement(open);
    if (!statement) return false;
    const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line;
    return (ts.getLeadingCommentRanges(source.text, statement.getFullStart()) ?? []).some(
        (comment) =>
            comment.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
            source.getLineAndCharacterOfPosition(comment.pos).line === line - 1 &&
            /^\/\/ sqlite-busy-timeout: no-wait -- \S/.test(
                source.text.slice(comment.pos, comment.end),
            ),
    );
}

function immediateTimeout(
    open: ts.Expression,
    bindingOf: ReturnType<typeof databaseBindings>,
): number {
    let value: ts.Node = open;
    while (
        ts.isAsExpression(value.parent) ||
        ts.isNonNullExpression(value.parent) ||
        ts.isAwaitExpression(value.parent) ||
        ts.isParenthesizedExpression(value.parent) ||
        (ts.isConditionalExpression(value.parent) && value.parent.condition !== value)
    )
        value = value.parent;
    const parent = value.parent;
    let name: string;
    let statement: ts.Statement;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        const list = parent.parent;
        if (
            !ts.isVariableDeclarationList(list) ||
            list.declarations.length !== 1 ||
            !ts.isVariableStatement(list.parent)
        )
            return 0;
        name = parent.name.text;
        statement = list.parent;
    } else if (
        ts.isBinaryExpression(parent) &&
        parent.right === value &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(parent.left) &&
        ts.isExpressionStatement(parent.parent)
    ) {
        name = parent.left.text;
        statement = parent.parent;
    } else {
        return 0;
    }
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
        const access = firstUse.parent;
        if (
            !ts.isPropertyAccessExpression(access) ||
            access.expression !== firstUse ||
            !["exec", "run"].includes(access.name.text)
        )
            return 0;
        const call = access.parent;
        if (
            !ts.isCallExpression(call) ||
            call.expression !== access ||
            !ts.isExpressionStatement(call.parent)
        )
            return 0;
        // Only ordinary blocks and the try body run the setup unconditionally.
        for (let enclosing: ts.Node = call.parent; enclosing !== next; enclosing = enclosing.parent) {
            const outer = enclosing.parent;
            if (!ts.isBlock(outer) && !(ts.isTryStatement(outer) && outer.tryBlock === enclosing))
                return 0;
        }
        const sql = call.arguments[0];
        if (!sql) return 0;
        if (
            ts.isTemplateExpression(sql) &&
            sql.templateSpans.length === 1 &&
            /^\s*PRAGMA\s+busy_timeout\s*=\s*$/i.test(sql.head.text) &&
            /^\s*;?\s*$/.test(sql.templateSpans[0].literal.text) &&
            bindingOf(sql.templateSpans[0].expression) === "boot-timeout"
        )
            return minimumTimeout;
        if (!ts.isStringLiteral(sql) && !ts.isNoSubstitutionTemplateLiteral(sql)) return 0;
        const match = /^\s*PRAGMA\s+busy_timeout\s*=\s*(\d+)\s*(?:;|$)/i.exec(sql.text);
        return match ? Number(match[1]) : 0;
    }
    return 0;
}

export function databaseOpenViolations(path: string, text: string): string[] {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const bindingOf = databaseBindings(source);
    const violations: string[] = [];
    function visit(node: ts.Node) {
        // Check a test helper where it creates the handle, not at every call.
        // The production storage bootstrap already installs its own busy timeout.
        if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
            const binding = bindingOf(node.expression);
            if (
                (ts.isNewExpression(node) ? isConstructor(binding) : binding === "factory") &&
                immediateTimeout(node, bindingOf) < minimumTimeout &&
                !optsOut(node, source)
            ) {
                const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
                violations.push(
                    `${path}:${line}: use openTestDb or set PRAGMA busy_timeout = ${minimumTimeout} on this handle before first use`,
                );
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    return violations;
}
