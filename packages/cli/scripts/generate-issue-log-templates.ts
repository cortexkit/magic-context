import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const OUTPUT = "packages/cli/src/lib/issue-log-templates.generated.ts";
type Template = { parts: string[]; slots: string[] };
const hole = (hint = "value"): Template => ({
    parts: ["", ""],
    slots: [
        /path|directory|\bdir\b|backup/i.test(hint)
            ? "path"
            : /session_?ids?\b|\b(?:parentSessionId|agentSessionId|childSessionId)\b/i.test(hint)
              ? "session"
              : /message_?id\b/i.test(hint)
                ? "message"
                : /project_?id\b|projectKey\b|rootCommit/i.test(hint)
                  ? "project"
                  : /\b(?:[A-Za-z]*[Mm]odel(?:ID|Id|Key|Ref)?|providerID|providerId|fallback_provider|fallback_model)\b/.test(
                          hint,
                      )
                    ? "model"
                    : "value",
    ],
});
const literal = (text: string): Template => ({ parts: [text], slots: [] });
const MAX_VARIANTS = 128;

function files(directory: string, extension: string): string[] {
    return readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            if (/^(?:tests|__tests__|fixtures|__fixtures__)$/.test(entry.name)) return [];
            const path = join(directory, entry.name);
            if (entry.isDirectory()) return files(path, extension);
            return path.endsWith(extension) && !/\.(?:test|fixture|spec)\./.test(path)
                ? [path]
                : [];
        })
        .sort();
}

function concatenate(a: Template, b: Template): Template {
    return {
        parts: [...a.parts.slice(0, -1), a.parts.at(-1)! + b.parts[0], ...b.parts.slice(1)],
        slots: [...a.slots, ...b.slots],
    };
}

function product(a: Template[], b: Template[]): Template[] {
    if (a.length * b.length > MAX_VARIANTS) return [hole()];
    return a.flatMap((left) => b.map((right) => concatenate(left, right)));
}

function rustMessages(source: string): string[] {
    const messages: string[] = [];
    for (const macro of source.matchAll(/tracing::(?:trace|debug|info|warn|error)!\s*\(/g)) {
        let depth = 0;
        let start = macro.index! + macro[0].length;
        for (let cursor = start; cursor < source.length; cursor++) {
            const char = source[cursor];
            if (char === '"') {
                cursor++;
                while (cursor < source.length && source[cursor] !== '"') {
                    if (source[cursor] === "\\") cursor++;
                    cursor++;
                }
            } else if ("([{".includes(char)) depth++;
            else if (")]}".includes(char)) {
                if (depth === 0) {
                    const argument = source.slice(start, cursor).trim();
                    if (/^"(?:\\.|[^"\\])*"$/.test(argument)) messages.push(argument.slice(1, -1));
                    break;
                }
                depth--;
            } else if (char === "," && depth === 0) {
                const argument = source.slice(start, cursor).trim();
                if (/^"(?:\\.|[^"\\])*"$/.test(argument)) {
                    messages.push(argument.slice(1, -1));
                    break;
                }
                start = cursor + 1;
            }
        }
    }
    return messages;
}

const SLOT_CODES: Record<string, string> = {
    model: "m",
    session: "s",
    message: "i",
    project: "r",
    path: "p",
};

function sourceString(value: string): string {
    // Short JavaScript escapes save bytes without changing literal source backslashes.
    return JSON.stringify(value).replace(
        /(\\+)u000([12])/g,
        (match, slashes: string, code: string) =>
            slashes.length % 2 ? `${slashes.slice(0, -1)}\\x0${code}` : match,
    );
}

function compactTemplate({ parts, slots }: Template): string {
    if (parts.some((part) => /[\x01\x02]/.test(part)))
        throw new Error("Log template contains a reserved encoding separator");
    const kinds = slots.flatMap((kind, index) => {
        if (kind === "value") return [];
        const code = SLOT_CODES[kind];
        if (!code) throw new Error(`Unknown log slot kind: ${kind}`);
        return [`${index.toString(36)}${code}`];
    });
    return parts.join("\x01") + (kinds.length ? `\x02${kinds.join(",")}` : "");
}

function compactSourceFiles(paths: Set<string>): string[] {
    let previousPath = "";
    return [...paths].sort().map((path) => {
        let common = 0;
        while (common < previousPath.length && previousPath[common] === path[common]) common++;
        previousPath = path;
        return `${common.toString(36)}:${path.slice(common)}`;
    });
}

/** Extract only source literals, never evaluated runtime values or private log data. */
export function generateIssueLogTemplates(root = ROOT): string {
    const paths = ["packages/plugin/src", "packages/pi-plugin/src"].flatMap((path) =>
        files(join(root, path), ".ts"),
    );
    const program = ts.createProgram(paths, {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.Preserve,
        noResolve: true,
        noLib: true,
        types: [],
        baseUrl: root,
        paths: { "@magic-context/core/*": ["packages/plugin/src/*"] },
    });
    const checker = program.getTypeChecker();
    const sources = paths.map((path) => program.getSourceFile(path)!);
    const templates = new Map<string, Template>();
    const vocabulary = new Set<string>();
    const sourceFiles = new Set<string>();
    const variantCache = new Map<ts.Node, Template[]>();
    const declarationCache = new Map<ts.Node, ts.Declaration | undefined>();

    function declaration(node: ts.Node): ts.Declaration | undefined {
        if (declarationCache.has(node)) return declarationCache.get(node);
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias)
            symbol = checker.getAliasedSymbol(symbol);
        const result = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        declarationCache.set(node, result);
        return result;
    }

    function variants(
        node: ts.Expression,
        seen = new Set<ts.Node>(),
        bindings = new Map<ts.Node, ts.Expression>(),
    ): Template[] {
        if (seen.has(node)) return [hole(node.getText().slice(0, 80))];
        if (bindings.size === 0 && variantCache.has(node)) return variantCache.get(node)!;
        const result = computeVariants(node, seen, bindings);
        if (bindings.size === 0) variantCache.set(node, result);
        return result;
    }

    function computeVariants(
        node: ts.Expression,
        seen: Set<ts.Node>,
        bindings: Map<ts.Node, ts.Expression>,
    ): Template[] {
        if (seen.has(node)) return [hole(node.getText().slice(0, 80))];
        seen = new Set(seen).add(node);
        const expand = (expression: ts.Expression) => variants(expression, seen, bindings);
        if (ts.isStringLiteralLike(node)) return [literal(node.text)];
        if (
            ts.isParenthesizedExpression(node) ||
            ts.isAsExpression(node) ||
            ts.isNonNullExpression(node)
        )
            return expand(node.expression);
        if (ts.isTemplateExpression(node)) {
            let result = [literal(node.head.text)];
            for (const span of node.templateSpans)
                result = product(product(result, expand(span.expression)), [
                    literal(span.literal.text),
                ]);
            return result;
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
            return product(expand(node.left), expand(node.right));
        if (ts.isConditionalExpression(node))
            return [...expand(node.whenTrue), ...expand(node.whenFalse)];
        if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
            const decl = declaration(ts.isPropertyAccessExpression(node) ? node.name : node);
            if (decl && bindings.has(decl)) return expand(bindings.get(decl)!);
            if (decl && ts.isVariableDeclaration(decl) && decl.initializer)
                return expand(decl.initializer);
        }
        if (ts.isCallExpression(node)) {
            const decl = declaration(
                ts.isPropertyAccessExpression(node.expression)
                    ? node.expression.name
                    : node.expression,
            );
            if (
                decl &&
                (ts.isFunctionDeclaration(decl) ||
                    ts.isArrowFunction(decl) ||
                    ts.isFunctionExpression(decl)) &&
                decl.body &&
                paths.includes(decl.getSourceFile().fileName)
            ) {
                const returned: Template[] = [];
                if (!ts.isBlock(decl.body)) return expand(decl.body);
                const visit = (child: ts.Node) => {
                    if (ts.isReturnStatement(child) && child.expression)
                        returned.push(...expand(child.expression));
                    else if (!ts.isFunctionLike(child)) ts.forEachChild(child, visit);
                };
                ts.forEachChild(decl.body, visit);
                if (returned.length && returned.length <= MAX_VARIANTS) return returned;
            }
        }
        return [hole(node.getText().slice(0, 80))];
    }

    function add(template: Template): void {
        const multiline = template.parts.findIndex((part) => part.includes("\n"));
        if (multiline >= 0) {
            const [first, ...rest] = template.parts[multiline].split("\n");
            add({
                parts: [...template.parts.slice(0, multiline), first],
                slots: template.slots.slice(0, multiline),
            });
            add({
                parts: [rest.join("\n"), ...template.parts.slice(multiline + 1)],
                slots: template.slots.slice(multiline),
            });
            return;
        }
        // Logger envelopes are transport, not message wording. sessionLog adds its own.
        const copy = { parts: [...template.parts], slots: [...template.slots] };
        if (copy.parts[0].startsWith("[magic-context][")) {
            if (copy.parts[0].includes("] ", 16))
                copy.parts[0] = copy.parts[0].replace(/^\[magic-context\]\[[^\]]*\] /, "");
            else if (
                copy.slots.length &&
                copy.parts[0] === "[magic-context][" &&
                copy.parts[1].startsWith("] ")
            ) {
                copy.parts.shift();
                copy.slots.shift();
                copy.parts[0] = copy.parts[0].slice(2);
            }
        }
        // Adjacent unknown expressions are one opaque value, not a boundary we can recover.
        for (let i = copy.parts.length - 2; i > 0; i--) {
            if (copy.parts[i] === "") {
                copy.parts.splice(i, 1);
                copy.slots.splice(i, 1);
            }
        }
        if (!/[A-Za-z]{2}/.test(copy.parts.join(""))) return;
        templates.set(JSON.stringify(copy), copy);
    }

    // Discover forwarding wrappers by following parameters passed to known logging sinks.
    const sinks = new Map<string, number>([
        ["log", 0],
        ["sessionLog", 1],
        ["logger", 0],
    ]);
    const wrappers = new Map<
        string,
        { parameters: ts.NodeArray<ts.ParameterDeclaration>; expression: ts.Expression }
    >();
    const calls: ts.CallExpression[] = [];
    for (const source of sources) {
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node)) calls.push(node);
            if (
                (ts.isTypeAliasDeclaration(node) && /reason|kind/i.test(node.name.text)) ||
                ((ts.isPropertySignature(node) ||
                    ts.isPropertyAssignment(node) ||
                    ts.isVariableDeclaration(node)) &&
                    /reason|kind/i.test(node.name.getText()))
            ) {
                const collect = (child: ts.Node) => {
                    if (ts.isStringLiteral(child) && /^[a-z][a-z0-9_-]{0,63}$/.test(child.text))
                        vocabulary.add(child.text);
                    ts.forEachChild(child, collect);
                };
                collect(node);
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    const nameOf = (call: ts.CallExpression) => {
        const target = ts.isPropertyAccessExpression(call.expression)
            ? call.expression.name
            : call.expression;
        const decl = declaration(target);
        return decl && "name" in decl && decl.name && ts.isIdentifier(decl.name as ts.Node)
            ? (decl.name as ts.Identifier).text
            : target.getText();
    };
    for (let round = 0; round < 10; round++) {
        let added = false;
        for (const call of calls) {
            const index = sinks.get(nameOf(call));
            const arg = index === undefined ? undefined : call.arguments[index];
            if (!arg) continue;
            let owner: ts.Node | undefined = call.parent;
            while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
            if (!owner || !ts.isFunctionLike(owner)) continue;
            for (const [position, parameter] of owner.parameters.entries()) {
                if (!ts.isIdentifier(parameter.name)) continue;
                let forwarded = false;
                const check = (node: ts.Node) => {
                    if (ts.isIdentifier(node) && declaration(node) === parameter) forwarded = true;
                    ts.forEachChild(node, check);
                };
                check(arg);
                const parent = owner.parent;
                const name =
                    owner.name?.getText() ??
                    (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)
                        ? parent.name.getText()
                        : undefined);
                if (forwarded && name && !sinks.has(name)) {
                    sinks.set(name, position);
                    wrappers.set(name, { parameters: owner.parameters, expression: arg });
                    added = true;
                }
            }
        }
        if (!added) break;
    }
    for (const call of calls) {
        const name = nameOf(call);
        const index =
            sinks.get(name) ??
            (/^(?:warn|error|info|debug|trace|safeLog|writeLog)$/.test(name) ? 0 : undefined);
        const argument = index === undefined ? undefined : call.arguments[index];
        if (!argument) continue;
        const source = call.getSourceFile();
        sourceFiles.add(relative(root, source.fileName));
        const wrapper = wrappers.get(name);
        const bindings = new Map<ts.Node, ts.Expression>();
        if (wrapper)
            for (const [position, parameter] of wrapper.parameters.entries()) {
                if (call.arguments[position]) bindings.set(parameter, call.arguments[position]);
            }
        for (const template of variants(wrapper?.expression ?? argument, new Set(), bindings)) {
            // The optional data argument is serialized after the message by the logger.
            add(template);
            if (
                /^(?:log|sessionLog|logger|warn|error|info|debug|trace|safeLog|writeLog)$/.test(
                    name,
                ) &&
                call.arguments.length > index! + 1
            )
                add(concatenate(concatenate(template, literal(" ")), hole("data")));
        }
    }

    // Rust messages can be forwarded into the same host logs by the module adapters.
    for (const path of files(join(root, "crates/mc-module/src"), ".rs")) {
        const source = readFileSync(path, "utf8");
        for (const message of rustMessages(source)) {
            sourceFiles.add(relative(root, path));
            const text = message.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
            const parts: string[] = [];
            const slots: string[] = [];
            let cursor = 0;
            for (const slot of text.matchAll(/(?<!\{)\{([^{}]*)\}(?!\})/g)) {
                parts.push(text.slice(cursor, slot.index));
                slots.push(hole(slot[1]).slots[0]);
                cursor = slot.index! + slot[0].length;
            }
            parts.push(text.slice(cursor).replaceAll("{{", "{").replaceAll("}}", "}"));
            add({ parts, slots });
        }
    }
    // The privacy matcher takes the first match: retain specificity precedence,
    // then order by wording and slot kinds independently of source traversal.
    const sorted = [...templates.values()].sort((a, b) => {
        const aKey = JSON.stringify(a);
        const bKey = JSON.stringify(b);
        return (
            b.parts.join("").length - a.parts.join("").length ||
            b.parts.at(-1)!.length - a.parts.at(-1)!.length ||
            aKey.localeCompare(bKey, "en") ||
            (aKey < bKey ? -1 : aKey > bKey ? 1 : 0)
        );
    });
    return `// biome-ignore-all format: Preserve deterministic generator output.
// Generated by packages/cli/scripts/generate-issue-log-templates.ts; do not edit.
// Static source text is public; every slot is independently privacy-filtered.
// Each string joins parts with U+0001. An optional U+0002 suffix lists base-36
// slot indices and kind codes; absent entries are ordinary private values.
export type SourceLogTemplate = { parts: readonly string[]; slots: readonly string[] };
const SLOT_KINDS: Record<string, string> = { m: "model", s: "session", i: "message", r: "project", p: "path" };
const TEMPLATE_DATA = [
${sorted.map((template) => sourceString(compactTemplate(template))).join(",\n")}
];
export const ISSUE_LOG_TEMPLATES: readonly SourceLogTemplate[] = /* @__PURE__ */ TEMPLATE_DATA.map((encoded) => {
    const suffix = encoded.indexOf("\\x02");
    const parts = (suffix < 0 ? encoded : encoded.slice(0, suffix)).split("\\x01");
    const slots: string[] = Array(parts.length - 1).fill("value");
    if (suffix >= 0) for (const entry of encoded.slice(suffix + 1).split(",")) {
        slots[Number.parseInt(entry.slice(0, -1), 36)] = SLOT_KINDS[entry.slice(-1)];
    }
    return { parts, slots };
});

export const ISSUE_LOG_IDENTIFIERS: readonly string[] = ${vocabulary.size ? `${sourceString([...vocabulary].sort().join(","))}.split(",")` : "[]"};

// Sorted, unique files containing logging calls, without per-call positions.
// Each entry stores a base-36 shared-prefix length and the remaining path.
const SOURCE_FILE_DATA = [
${compactSourceFiles(sourceFiles).map(sourceString).join(",\n")}
];
export const ISSUE_LOG_SOURCE_FILES: readonly string[] = /* @__PURE__ */ (() => {
    let previousPath = "";
    return SOURCE_FILE_DATA.map((entry) => {
        const colon = entry.indexOf(":");
        const path = previousPath.slice(0, Number.parseInt(entry.slice(0, colon), 36)) + entry.slice(colon + 1);
        previousPath = path;
        return path;
    });
})();
`;
}

if (import.meta.main) {
    writeFileSync(join(ROOT, OUTPUT), generateIssueLogTemplates());
    console.log(`Generated ${OUTPUT}`);
}
