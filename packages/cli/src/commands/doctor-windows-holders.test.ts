import { afterEach, describe, expect, it } from "bun:test";
import type { execFileSync } from "node:child_process";
import {
    __resetRpcIdentityTestHooks,
    __setRpcIdentityTestHooks,
    inspectWindowsProcessesSync,
} from "@magic-context/core/shared/rpc-utils";
import { assertWindowsStoresClosed } from "./doctor-windows-holders";

interface ProcessRow {
    ProcessId: number;
    ParentProcessId: number;
    Name: string | null;
    CommandLine: string | null;
}

const hostPid = 7_990_001;
const launcherPid = 7_990_002;
const doctorCommand =
    'node.exe "C:\\npm\\node_modules\\@cortexkit\\magic-context\\dist\\index.js" doctor --harness opencode';

function inspect(rows: ProcessRow[], parentPid = 0) {
    const processes: ProcessRow[] = [
        {
            ProcessId: process.pid,
            ParentProcessId: parentPid,
            Name: "node.exe",
            CommandLine: doctorCommand,
        },
        ...rows,
    ];
    __setRpcIdentityTestHooks({
        platform: "win32",
        processListExecFileSync: (() => JSON.stringify(processes)) as typeof execFileSync,
    });
    return inspectWindowsProcessesSync();
}

function row(
    image: string | null,
    command: string | null,
    pid = hostPid,
    parentPid = 0,
): ProcessRow {
    return { ProcessId: pid, ParentProcessId: parentPid, Name: image, CommandLine: command };
}

afterEach(__resetRpcIdentityTestHooks);

describe("Windows doctor host identity", () => {
    it("does not count the npx doctor --harness opencode launcher chain as a host", () => {
        const processes = inspect(
            [
                row(
                    "node.exe",
                    'node.exe "C:\\npm\\node_modules\\npm\\bin\\npx-cli.js" @cortexkit/magic-context doctor --harness opencode',
                    launcherPid,
                ),
                row("node.exe", doctorCommand, hostPid, launcherPid),
            ],
            hostPid,
        );
        expect(() => assertWindowsStoresClosed([], processes)).not.toThrow();
    });

    it("does not count an unrelated tool's --path D:\\OpenCode argument as a host", () => {
        const processes = inspect([row("tool.exe", "tool.exe --path D:\\OpenCode")]);
        expect(() => assertWindowsStoresClosed([], processes)).not.toThrow();
    });

    it.each([
        ["node.exe", "node.exe C:\\tools\\tool.js --path D:\\OpenCode"],
        ["node.exe", "node.exe C:\\tools\\tool.js opencode.js"],
        ["node.exe", `${doctorCommand} --path C:\\pi-coding-agent`],
        ["bun.exe", "bun.exe C:\\tools\\tool.js --path C:\\oh-my-pi"],
        ["node.exe", "node.exe --title opencode C:\\tools\\tool.js"],
        ["node.exe", "node.exe --require opencode.js C:\\tools\\tool.js"],
        ["node.exe", 'node.exe "" opencode.js'],
        ["node.exe", "node.exe --trace-event-categories opencode C:\\tools\\tool.js"],
        ["bun.exe", "bun.exe --cwd D:\\OpenCode C:\\tools\\tool.js"],
        ["bun.exe", "bun.exe run --filter opencode C:\\tools\\tool.js"],
        ["deno.exe", "deno.exe run --config D:\\OpenCode C:\\tools\\tool.js"],
        ["node.exe", 'node.exe --eval "opencode"'],
        ["bun.exe", 'bun.exe -e "opencode"'],
        ["deno.exe", 'deno.exe eval "opencode"'],
        ["bun.exe", "bun.exe test opencode.js"],
        ["cmd.exe", "cmd.exe /c echo opencode"],
        ["npx.exe", "npx.exe @cortexkit/magic-context doctor --harness opencode"],
        ["tool.exe", "tool.exe opencode.exe"],
        ["not-opencode.exe", "not-opencode.exe"],
    ])("does not count %s running %s", (image, command) => {
        expect(() => assertWindowsStoresClosed([], inspect([row(image, command)]))).not.toThrow();
    });

    it.each([
        ["node.exe", "node.exe --test --test-name-pattern opencode C:\\tools\\tool.js"],
        ["node.exe", "node.exe --test --test-reporter opencode C:\\tools\\tool.js"],
        ["node.exe", "node.exe --experimental-policy D:\\OpenCode C:\\tools\\tool.js"],
        ["node.exe", "node.exe --run opencode"],
        ["bun.exe", "bun.exe --jsx-import-source opencode C:\\tools\\tool.jsx"],
        ["deno.exe", "deno.exe run --preload D:\\OpenCode C:\\tools\\tool.js"],
        ["deno.exe", "deno.exe run --watch-exclude D:\\OpenCode C:\\tools\\tool.js"],
    ])("ignores separately supplied runtime option values: %s %s", (image, command) => {
        expect(() => assertWindowsStoresClosed([], inspect([row(image, command)]))).not.toThrow();
    });

    it.each([
        "opencode.exe",
        "opencode2.exe",
        "ck-mc.exe",
        "pi.exe",
        "pi.cmd",
        "omp.exe",
        "oh-my-pi.exe",
        "C:\\Program Files\\OpenCode\\OPENCODE.EXE",
    ])("counts the native host image %s", (image) => {
        expect(() => assertWindowsStoresClosed([], inspect([row(image, null)]))).toThrow(
            `PID ${hostPid}`,
        );
    });

    it.each([
        ["node.exe", '"C:\\Program Files\\nodejs\\node.exe" "C:\\Open Code\\opencode.js"'],
        ["bun.exe", 'bun.exe "C:\\Open Code\\node_modules\\opencode-ai\\bin\\opencode"'],
        ["node.exe", "node.exe C:\\tools\\opencode2.mjs"],
        ["node.exe", "node.exe --require C:\\tools\\bootstrap.js C:\\tools\\opencode.js"],
        ["node.exe", "node.exe --require=C:\\tools\\bootstrap.js -- C:\\tools\\opencode.js"],
        ["node.exe", 'node.exe --title "" C:\\tools\\opencode.js'],
        ["node.exe", String.raw`node.exe --title "a\"b" C:\tools\opencode.js`],
        ["node.exe", String.raw`node.exe --title "C:\tools\\" C:\tools\opencode.js`],
        ["bun.exe", "bun.exe run --cwd C:\\tools C:\\tools\\opencode.js"],
        ["deno.exe", "deno.exe run --allow-read C:\\tools\\opencode.js"],
        ["node.exe", "node.exe C:\\tools\\ck-mc.mjs"],
        ["node.exe", "node.exe C:\\npm\\@mariozechner\\pi-coding-agent\\dist\\cli.js"],
        ["bun.exe", 'bun.exe "C:\\Pi Tools\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js"'],
        ["node.exe", "node.exe C:\\tools\\oh-my-pi\\dist\\cli.js"],
        ["node.exe", "node.exe C:\\tools\\cljs\\dist\\cli.js"],
        ["bun.exe", "bun.exe C:\\tools\\dist\\bundle\\cli.js"],
        ["deno.exe", "deno.exe run C:\\tools\\pi.mjs"],
        ["node.exe", "node.exe C:\\tools\\pi.cjs"],
    ])("counts %s running the host entry %s", (image, command) => {
        expect(() => assertWindowsStoresClosed([], inspect([row(image, command)]))).toThrow(
            `PID ${hostPid}`,
        );
    });

    it.each([
        ["opencode.exe", "opencode.exe"],
        ["node.exe", "node.exe C:\\npm\\@mariozechner\\pi-coding-agent\\dist\\cli.js"],
        ["bun.exe", "bun.exe C:\\npm\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js"],
    ])("still finds an ancestor host when doctor runs inside its terminal: %s", (image, command) => {
        const processes = inspect(
            [row(image, command), row("cmd.exe", "cmd.exe", launcherPid, hostPid)],
            launcherPid,
        );
        expect(() => assertWindowsStoresClosed([], processes)).toThrow(`PID ${hostPid}`);
    });

    it("requires a CIM snapshot even if Pi discovery reports no hosts", () => {
        const processes = inspect([]);
        processes.processSnapshot = { source: "tasklist", facts: [] };
        expect(() => assertWindowsStoresClosed([], processes)).toThrow("could not rule out");
        delete processes.processSnapshot;
        expect(() => assertWindowsStoresClosed([], processes)).toThrow("could not rule out");
    });

    it.each([
        null,
        "node.exe",
        "C:\\Program Files\\nodejs\\node.exe",
        "bun.exe",
        "deno.exe",
    ])("refuses unavailable process identity for %s", (image) => {
        const processes = inspect([row(image, null)]);
        expect(() => assertWindowsStoresClosed([], processes)).toThrow(`PID ${hostPid}`);
    });
});
