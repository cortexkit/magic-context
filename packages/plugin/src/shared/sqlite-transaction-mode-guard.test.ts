import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * An explicitly deferred transaction starts with no writer lock. If it reads before it writes, the write must upgrade a read
 * snapshot to a write lock, and SQLite never runs the busy handler for that
 * upgrade: under another process's write it fails at once with SQLITE_BUSY, or
 * with SQLITE_BUSY_SNAPSHOT when another commit landed after the read, and
 * busy_timeout never applies. Many OpenCode and Pi processes share one context.db,
 * so writing transactions must acquire at BEGIN. The shared runtime defaults
 * writable handles to IMMEDIATE; plugin/Pi call sites keep their explicit
 * `.immediate()` / `.exclusive()` declarations as an additional intent fence.
 *
 * Only read-only transactions may stay deferred. Each one is listed here, keyed
 * by file and the nearest named enclosing function, with the reason it never
 * writes. A read-only snapshot must not take the write lock, because that would
 * block every writer for the length of the read.
 */
const READ_ONLY_DEFERRED_TRANSACTIONS: Record<string, string> = {
    "packages/plugin/src/hooks/magic-context/lkg-served-marker.ts#checkLkgDurability":
        "reads the served marker and durable slot id in one snapshot; never hydrates, repairs or writes",
    "packages/plugin/src/v2/store-reader.ts#window":
        "reads the latest compaction and the rows after it as one consistent snapshot of the OpenCode 2 store; never writes",
    "packages/pi-plugin/src/inject-compartments-pi.ts#readFrozenM0InputsPi":
        "reads the m[0] render sources and their watermarks as one consistent snapshot; never writes",
    "packages/plugin/src/features/magic-context/message-fts-session-filter.ts#withMessageFtsSessionFilter":
        "pins one read snapshot so the session's rowid coverage proof and the filtered message search see the same rows; never writes (read-only connections use it too)",
    "packages/plugin/src/hooks/magic-context/lkg-persist.ts#loadPersistedLkgSlot":
        "reads an LKG slot row and its prefix slices as one consistent snapshot; never writes (a failed verification clears the slot afterwards, outside this transaction)",
};

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");
const SOURCE_ROOTS = ["packages/plugin/src", "packages/pi-plugin/src", "packages/cli/src"];
const LOCKING_MODES = new Set(["immediate", "exclusive"]);

function sourceFiles(directory: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules") continue;
            result.push(...sourceFiles(path));
        } else if (
            /\.tsx?$/.test(entry.name) &&
            !/\.test\.tsx?$/.test(entry.name) &&
            !/\.d\.ts$/.test(entry.name)
        ) {
            result.push(path);
        }
    }
    return result;
}

function isTransactionCall(node: ts.Node): node is ts.CallExpression {
    return (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "transaction"
    );
}

/** True when `node` is the receiver of a called `.immediate()` / `.exclusive()`. */
function isCalledWithLockingMode(
    node: ts.Node,
    modes: ReadonlySet<string> = LOCKING_MODES,
): boolean {
    const access = node.parent;
    return (
        access !== undefined &&
        ts.isPropertyAccessExpression(access) &&
        access.expression === node &&
        modes.has(access.name.text) &&
        access.parent !== undefined &&
        ts.isCallExpression(access.parent) &&
        access.parent.expression === access
    );
}

function enclosingFunctionName(node: ts.Node): string {
    for (let current = node.parent; current; current = current.parent) {
        if (
            (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
            current.name
        ) {
            return current.name.getText();
        }
        if (
            (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
            current.parent &&
            (ts.isVariableDeclaration(current.parent) || ts.isPropertyAssignment(current.parent))
        ) {
            return current.parent.name.getText();
        }
    }
    return "<module>";
}

/**
 * A transaction stored in a variable is locking only when every use of that
 * variable calls `.immediate()` or `.exclusive()` on it.
 */
function storedTransactionLocks(
    call: ts.CallExpression,
    source: ts.SourceFile,
    modes: ReadonlySet<string> = LOCKING_MODES,
): boolean {
    const declaration = call.parent;
    if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return false;
    const name = declaration.name.text;
    let scope: ts.Node = source;
    for (let current: ts.Node | undefined = declaration.parent; current; current = current.parent) {
        if (ts.isBlock(current)) {
            scope = current;
            break;
        }
    }
    const uses: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === name && node !== declaration.name) {
            uses.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(scope);
    return uses.length > 0 && uses.every((use) => isCalledWithLockingMode(use, modes));
}

interface TransactionScan {
    deferredSites: Map<string, string[]>;
    lockingSites: number;
}

function scanTransactionModes(files: Array<{ path: string; text: string }>): TransactionScan {
    const deferredSites = new Map<string, string[]>();
    let lockingSites = 0;
    for (const file of files) {
        if (!file.text.includes(".transaction(")) continue;
        const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node): void => {
            if (isTransactionCall(node)) {
                if (isCalledWithLockingMode(node) || storedTransactionLocks(node, source)) {
                    lockingSites += 1;
                } else {
                    const key = `${file.path}#${enclosingFunctionName(node)}`;
                    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
                    const locations = deferredSites.get(key) ?? [];
                    locations.push(`${file.path}:${line + 1}`);
                    deferredSites.set(key, locations);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return { deferredSites, lockingSites };
}

function repositorySources(): Array<{ path: string; text: string }> {
    return SOURCE_ROOTS.flatMap((root) =>
        sourceFiles(resolve(REPOSITORY_ROOT, root)).map((path) => ({
            path: relative(REPOSITORY_ROOT, path),
            text: readFileSync(path, "utf8"),
        })),
    );
}

describe("SQLite transaction lock mode", () => {
    it("declares every audited read-only transaction explicitly deferred", () => {
        const candidates: string[] = [];
        for (const file of repositorySources()) {
            const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
            const visit = (node: ts.Node): void => {
                if (isTransactionCall(node)) {
                    const key = `${file.path}#${enclosingFunctionName(node)}`;
                    if (key in READ_ONLY_DEFERRED_TRANSACTIONS) {
                        const deferred = new Set(["deferred"]);
                        if (
                            !isCalledWithLockingMode(node, deferred) &&
                            !storedTransactionLocks(node, source, deferred)
                        )
                            candidates.push(key);
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(source);
        }
        expect(candidates.sort()).toEqual([]);
    });

    it("starts every writing transaction with .immediate() or .exclusive()", () => {
        const { deferredSites, lockingSites } = scanTransactionModes(
            repositorySources().filter((file) => !file.path.startsWith("packages/cli/")),
        );
        // The scan must actually see the codebase's transactions.
        expect(lockingSites).toBeGreaterThan(50);

        const unlisted = [...deferredSites]
            .filter(([key]) => !(key in READ_ONLY_DEFERRED_TRANSACTIONS))
            .flatMap(([, locations]) => locations);
        expect(unlisted).toEqual([]);

        // One deferred transaction per listed function, so a second one added
        // beside a read-only snapshot is not waved through by the same entry.
        const repeated = [...deferredSites].filter(([, locations]) => locations.length > 1);
        expect(repeated).toEqual([]);

        // A listed entry whose transaction is gone or now locks must be removed.
        const stale = Object.keys(READ_ONLY_DEFERRED_TRANSACTIONS).filter(
            (key) => !deferredSites.has(key),
        );
        expect(stale).toEqual([]);
    });

    it("recognises each deferred and locking shape", () => {
        const text = `
            function plainCall(db) { db.transaction(() => write())(); }
            function explicitDeferred(db) { db.transaction(() => write()).deferred(); }
            function stored(db) { const tx = db.transaction(() => write()); tx(); }
            function storedMixed(db) { const tx = db.transaction(() => write()); tx.immediate(); tx(); }
            function immediate(db) { db.transaction(() => write()).immediate(); }
            function chained(db) { return db\n.transaction(() => write())\n.exclusive(); }
            function storedImmediate(db) { const tx = db.transaction(() => write()); return tx.immediate(); }
        `;
        const { deferredSites, lockingSites } = scanTransactionModes([{ path: "x.ts", text }]);
        expect([...deferredSites.keys()].sort()).toEqual([
            "x.ts#explicitDeferred",
            "x.ts#plainCall",
            "x.ts#stored",
            "x.ts#storedMixed",
        ]);
        expect(lockingSites).toBe(3);
    });
});
