import { existsSync } from "node:fs";
import { piHarnessKindFromExecutable } from "@magic-context/core/shared/pi-executable";
import type { AsyncProcessInspection } from "@magic-context/core/shared/rpc-utils";
import { Database } from "@magic-context/core/shared/sqlite";

function fileName(path: string): string {
    return path.toLowerCase().replaceAll("\\", "/").split("/").at(-1) ?? "";
}

const runtimes = /^(?:bun|node|deno)(?:\.exe)?$/;

function commandTokens(command: string): string[] {
    const tokens: string[] = [];
    let token = "";
    let quoted = false;
    let started = false;
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (char === "\\") {
            started = true;
            let end = index;
            while (command[end] === "\\") end += 1;
            const count = end - index;
            // Windows only treats backslashes as escapes immediately before a double quote.
            if (command[end] === '"') {
                token += "\\".repeat(Math.floor(count / 2));
                if (count % 2) token += '"';
                else quoted = !quoted;
                index = end;
            } else {
                token += "\\".repeat(count);
                index = end - 1;
            }
        } else if (char === '"') {
            started = true;
            quoted = !quoted;
        } else if (/\s/.test(char) && !quoted) {
            if (started) tokens.push(token);
            token = "";
            started = false;
        } else {
            started = true;
            token += char;
        }
    }
    if (started) tokens.push(token);
    return tokens;
}

// These runtime options consume the next token; their values are never entry scripts.
const runtimeValueOptions: Record<string, ReadonlySet<string>> = {
    node: new Set([
        "-r",
        "--require",
        "--import",
        "--loader",
        "--experimental-loader",
        "-C",
        "--conditions",
        "--title",
        "--env-file",
        "--env-file-if-exists",
        "--icu-data-dir",
        "--openssl-config",
        "--redirect-warnings",
        "--diagnostic-dir",
        "--snapshot-blob",
        "--inspect-port",
        "--experimental-config-file",
        "--experimental-policy",
        "--experimental-sea-config",
        "--input-type",
        "--run",
        "--cpu-prof-dir",
        "--cpu-prof-name",
        "--heap-prof-dir",
        "--heap-prof-name",
        "--report-dir",
        "--report-directory",
        "--report-filename",
        "--heapsnapshot-signal",
        "--trace-event-categories",
        "--trace-event-file-pattern",
        "--watch-path",
        "--watch-kill-signal",
        "--test-name-pattern",
        "--test-skip-pattern",
        "--test-reporter",
        "--test-reporter-destination",
        "--test-global-setup",
    ]),
    bun: new Set([
        "-r",
        "--require",
        "--preload",
        "--cwd",
        "--env-file",
        "-c",
        "--config",
        "--tsconfig-override",
        "--define",
        "--loader",
        "--origin",
        "--port",
        "--conditions",
        "--external",
        "--use",
        "-F",
        "--filter",
        "--shell",
        "--main-fields",
        "--extension-order",
        "--jsx-factory",
        "--jsx-fragment",
        "--jsx-import-source",
    ]),
    deno: new Set([
        "-c",
        "--config",
        "--import-map",
        "--cert",
        "--location",
        "--lock",
        "--seed",
        "--v8-flags",
        "--preload",
        "--watch-exclude",
        "--strace-ops",
    ]),
};

function runtimeScript(runtime: string, tokens: string[]): string | undefined {
    let allowRun = runtime !== "node";
    for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === "--") return tokens[index + 1];
        // Eval/print execute source text rather than the script named by a later argument.
        if (/^(?:--eval|--print)(?:=|$)|^-[ep]/.test(token)) return undefined;
        if (token.startsWith("-")) {
            if (runtimeValueOptions[runtime].has(token)) index += 1;
            continue;
        }
        if (allowRun && token === "run") {
            allowRun = false;
            continue;
        }
        return token;
    }
    return undefined;
}

function isHostScript(script: string): boolean {
    const path = script.toLowerCase().replaceAll("\\", "/");
    return (
        /^(?:ck-mc|opencode2?)(?:\.exe|\.js|\.mjs)?$/.test(fileName(path)) ||
        piHarnessKindFromExecutable(path.replace(/\.(?:js|mjs|cjs)$/, "")) !== undefined ||
        /(?:^|\/)(?:pi-coding-agent|@?oh-my-pi)(?:\/|$)/.test(path) ||
        /(?:^|\/)(?:cljs\/dist|dist\/bundle\/cli)(?:[/.]|$)/.test(path)
    );
}

function isHostProcess(imageName: string | null, commandLine: string | null): boolean {
    const tokens = commandTokens(commandLine ?? "");
    const image = fileName(imageName ?? tokens[0] ?? "");
    if (
        /^(?:opencode|opencode2|ck-mc)(?:\.exe)?$/.test(image) ||
        piHarnessKindFromExecutable(image) !== undefined
    ) {
        return true;
    }
    if (!runtimes.test(image)) return false;
    const script = runtimeScript(image.replace(/\.exe$/, ""), tokens);
    return script !== undefined && isHostScript(script);
}

/** Windows cannot use lsof: rule out host processes and check SQLite locks without waiting. */
export function assertWindowsStoresClosed(
    paths: string[],
    processes: AsyncProcessInspection,
): void {
    if (processes.processSnapshot?.source !== "cim") {
        throw new Error("Windows process probe could not rule out OpenCode, Pi or ck-mc holders");
    }
    // The shared processes.pi scan skips ancestors and searches argument text. To rule out
    // database holders, inspect all CIM rows by executable or entry script instead.
    const facts = processes.processSnapshot.facts.filter(({ pid }) => pid !== process.pid);
    const unknown = facts.filter(
        ({ imageName, commandLine }) =>
            (!imageName && !commandLine) ||
            (runtimes.test(fileName(imageName ?? "")) && !commandLine?.trim()),
    );
    if (unknown.length)
        throw new Error(
            `Windows process identity is unavailable (PID ${unknown.map(({ pid }) => pid).join(", ")})`,
        );
    const blockers = facts.filter(({ imageName, commandLine }) =>
        isHostProcess(imageName, commandLine),
    );
    if (blockers.length)
        throw new Error(
            `OpenCode, Pi or ck-mc process is running (${blockers.map(({ pid, imageName, commandLine }) => `${imageName ?? commandLine} PID ${pid}`).join(", ")})`,
        );
    for (const path of [...new Set(paths)]) {
        if (!existsSync(path)) continue;
        let db: Database | undefined;
        let locked = false;
        try {
            db = new Database(path);
            db.exec("PRAGMA busy_timeout = 0");
            db.exec("BEGIN EXCLUSIVE");
            locked = true;
        } catch (error) {
            throw new Error(
                `Cannot acquire exclusive locks on ${path}: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            if (locked) db?.exec("ROLLBACK");
            db?.close();
        }
    }
}
