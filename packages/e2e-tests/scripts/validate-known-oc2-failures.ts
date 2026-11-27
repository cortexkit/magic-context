import ts from "typescript";

export interface KnownOpenCode2Failure {
    hostVersions: string[];
    tests: string[];
    class: "defect" | "host";
    reason: string;
}

const uniqueStrings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length > 0 &&
    value.every((item: unknown) => typeof item === "string" && item.trim() === item && item.length > 0) &&
    new Set(value).size === value.length;

/** The runtime also matches the validated test names against the test cases in Bun's report. */
export function validateKnownOpenCode2Failures(
    raw: unknown,
    path: string,
    source: string,
    matrixVersions: readonly string[],
): KnownOpenCode2Failure[] {
    if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${path}: knownFailures must be a nonempty list`);
    const names = registeredTestNames(path, source);
    const seen = new Set<string>();
    return raw.map((entry: unknown) => {
        if (!entry || typeof entry !== "object" || Object.keys(entry).sort().join(",") !== "class,hostVersions,reason,tests") {
            throw new Error(`${path}: known failure requires hostVersions, tests, class and reason`);
        }
        const { hostVersions, tests, class: kind, reason } = entry as Record<string, unknown>;
        if (!uniqueStrings(hostVersions) || hostVersions.some((version) =>
            !/^2\.\d+\.\d+$/.test(version) || !matrixVersions.includes(version) || version === "2.0.22" || version === "2.1.0")) {
            throw new Error(`${path}: known failure must name exact, current OpenCode 2 matrix versions`);
        }
        if (!uniqueStrings(tests) || tests.some((name) => !names.has(name))) {
            throw new Error(`${path}: known failure references a test name not declared in the file: ${JSON.stringify(tests)}`);
        }
        if (kind !== "defect" && kind !== "host") throw new Error(`${path}: known failure class must be defect or host`);
        if (typeof reason !== "string" || reason.trim() === "" || /[\r\n]/.test(reason)) {
            throw new Error(`${path}: known failure requires a nonempty one-line reason`);
        }
        for (const version of hostVersions) {
            for (const name of tests) {
                const key = JSON.stringify([version, name]);
                if (seen.has(key)) throw new Error(`${path}: duplicate known failure for ${version}: ${name}`);
                seen.add(key);
            }
        }
        return { hostVersions, tests, class: kind, reason: reason.trim() };
    });
}

function calleeName(value: ts.Expression): string | undefined {
    if (ts.isIdentifier(value)) return value.text;
    if (ts.isCallExpression(value) || ts.isPropertyAccessExpression(value)) return calleeName(value.expression);
    return undefined;
}

function literalName(expression: ts.Expression | undefined): string | undefined {
    return expression && ts.isStringLiteralLike(expression) ? expression.text : undefined;
}

function caseNames(expression: ts.Expression | undefined, host?: string): string[] {
    const direct = literalName(expression);
    if (direct !== undefined) return [direct];
    // forEachHost registers separate test names for cases with host-specific behavior.
    if (expression && ts.isConditionalExpression(expression) && host) {
        const test = expression.condition;
        if (ts.isBinaryExpression(test) && test.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
            ts.isIdentifier(test.left) && test.left.text === host) {
            const name = literalName(test.right);
            if (name !== undefined) return caseNames(name === "opencode2" ? expression.whenTrue : expression.whenFalse, host);
        }
    }
    return [];
}

/** Only statically named cases can be adjudicated; a computed name cannot waive a failure. */
function registeredTestNames(path: string, source: string): Set<string> {
    const names = new Set<string>();
    function visit(node: ts.Node, suite: string[], host?: string): void {
        if (ts.isCallExpression(node)) {
            const callee = calleeName(node.expression);
            if (callee === "it" || callee === "test") {
                for (const name of caseNames(node.arguments[0], host)) names.add([...suite, name].join(" > "));
                return;
            }
            if (callee === "describe") {
                const label = literalName(node.arguments[0]);
                if (label !== undefined && node.arguments[1]) visit(node.arguments[1], [...suite, label], host);
                return;
            }
            if (callee === "forEachHost") {
                const label = literalName(node.arguments[1]);
                const register = node.arguments[2];
                if (register && (ts.isArrowFunction(register) || ts.isFunctionExpression(register))) {
                    const hostParameter = register.parameters[0]?.name;
                    visit(register.body, [...suite, label ? `${label} [opencode2]` : "[opencode2]"],
                        hostParameter && ts.isIdentifier(hostParameter) ? hostParameter.text : undefined);
                }
                return;
            }
        }
        ts.forEachChild(node, (child) => visit(child, suite, host));
    }
    visit(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true), []);
    return names;
}
