import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const packagesRoot = resolve(import.meta.dir, "../../..");
const reason =
    "node:sqlite on Node 22.16 to 22.19 and 24.0 to 24.6 rejects positional arguments for numbered placeholders; use plain ? and pass the value again";
const sqlStart =
    /^\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|EXPLAIN)\b/i;

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (["node_modules", "dist", "target", ".git"].includes(entry.name)) return [];
        const path = join(directory, entry.name);
        return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
    });
}

function numberedSqlPlaceholders(path: string, text = readFileSync(path, "utf8")): string[] {
    if (!/\?[0-9]/.test(text)) return [];
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const violations = new Set<number>();
    function checkLiterals(node: ts.Node): void {
        if (
            (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) &&
            /\?[0-9]/.test(node.text)
        ) {
            violations.add(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
        }
        ts.forEachChild(node, checkLiterals);
    }
    function visit(node: ts.Node): void {
        // The AST excludes comments and regex literals. Inspect whole SQL expressions
        // so a numbered placeholder inside a template interpolation is caught too.
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const name = ts.isPropertyAccessExpression(callee)
                ? callee.name.text
                : ts.isIdentifier(callee)
                  ? callee.text
                  : "";
            if (["prepare", "exec", "query"].includes(name) && node.arguments[0])
                checkLiterals(node.arguments[0]);
        }
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            /sql/i.test(node.name.text) &&
            node.initializer
        ) {
            checkLiterals(node.initializer);
        }
        const head = ts.isTemplateExpression(node)
            ? node.head.text
            : ts.isStringLiteralLike(node)
              ? node.text
              : "";
        if (sqlStart.test(head)) checkLiterals(node);
        ts.forEachChild(node, visit);
    }
    visit(source);
    return [...violations]
        .sort((a, b) => a - b)
        .map((line) => `${relative(packagesRoot, path)}:${line}`);
}

describe("SQLite positional placeholders", () => {
    test("rejects numbered SQL placeholders across every package", () => {
        const violations = sourceFiles(packagesRoot).flatMap((path) =>
            numberedSqlPlaceholders(path),
        );
        expect(violations, reason).toEqual([]);
    });

    test("finds SQL calls, named fragments, returned SQL and interpolated placeholders", () => {
        const fixtures = [
            'db.prepare("SELECT ?1").get(value)',
            "db.query(`SELECT ${flag ? '?1' : '?'}`).get(value)",
            'db.exec("INSERT INTO t VALUES (?2)")',
            'const MESSAGE_FILTER_SQL = " AND session_id = ?1"',
            'function select() { return "SELECT ?3"; }',
            'db.prepare<{ x: string }>("SELECT ?1")',
        ];
        for (const fixture of fixtures)
            expect(numberedSqlPlaceholders("fixture.ts", fixture)).toHaveLength(1);
    });

    test("ignores comments, regexes, prose and anonymous SQL bindings", () => {
        expect(
            numberedSqlPlaceholders(
                "fixture.ts",
                [
                    "// SELECT ?1",
                    "/* db.prepare('SELECT ?2') */",
                    "const model = /[-_.]?5[-_.]1/;",
                    'const prose = "Did you mean ?1 or ?2?";',
                    'db.prepare("SELECT ?, ?").get(x, x);',
                ].join("\n"),
            ),
        ).toEqual([]);
    });
});
