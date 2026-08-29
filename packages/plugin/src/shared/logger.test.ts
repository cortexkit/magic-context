import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type LoggerScenarioResult = {
    exists: boolean;
    content: string;
    healthyDiagnostics: {
        swallowedWriteCount: number;
        lastErrorMessage: string | null;
        lastErrorTime: string | null;
    };
    failedDiagnostics: {
        swallowedWriteCount: number;
        lastErrorMessage: string | null;
        lastErrorTime: string | null;
    };
};

const loggerScenario = `
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const root = process.env.LOGGER_SCENARIO_ROOT;
const loggerModuleUrl = process.env.LOGGER_MODULE_URL;
if (!root || !loggerModuleUrl) throw new Error("logger scenario environment is incomplete");

const logger = await import(loggerModuleUrl);
const logPath = path.join(root, "nested", "magic-context.log");
process.env.MAGIC_CONTEXT_LOG_PATH = logPath;
logger.log("first");
logger.log(
    "tokens.input=45000 api_key=sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGH",
    { authorization: "Bearer abcdefghijklmnop", totalInputTokens: 132000 },
);
logger.flushLogger();
const healthyDiagnostics = logger.getLoggerDiagnostics();

const logDirectory = path.dirname(logPath);
if (process.env.LOGGER_SCENARIO === "recovery") {
    const { rmSync } = await import("node:fs");
    rmSync(logDirectory, { recursive: true, force: true });
    logger.log("second");
    logger.flushLogger();
}

// A directory used as the file target makes append fail deterministically on every platform.
const failedPath = path.join(root, "unwritable-log-target");
const { mkdirSync } = await import("node:fs");
mkdirSync(failedPath, { recursive: true });
process.env.MAGIC_CONTEXT_LOG_PATH = failedPath;
logger.log("failed write");
logger.flushLogger();
const failedDiagnostics = logger.getLoggerDiagnostics();

const content = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
console.log(JSON.stringify({
    exists: existsSync(logPath),
    content,
    healthyDiagnostics,
    failedDiagnostics,
}));
`;

const scenarioRoots: string[] = [];

afterEach(() => {
    for (const root of scenarioRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

async function runLoggerScenario(
    scenario: "recovery" | "diagnostics",
): Promise<LoggerScenarioResult> {
    const root = mkdtempSync(path.join(os.tmpdir(), "magic-context-logger-test-"));
    scenarioRoots.push(root);
    const child = Bun.spawn({
        cmd: ["bun", "--eval", loggerScenario],
        cwd: import.meta.dir,
        env: {
            ...process.env,
            NODE_ENV: "production",
            LOGGER_MODULE_URL: new URL("./logger.ts", import.meta.url).href,
            LOGGER_SCENARIO: scenario,
            LOGGER_SCENARIO_ROOT: root,
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout.trim()) as LoggerScenarioResult;
}

describe("logger", () => {
    test("recreates a log directory removed while the process is running", async () => {
        const result = await runLoggerScenario("recovery");

        expect(result.exists).toBe(true);
        expect(result.content).toContain("second");
    });

    test("redacts secrets while preserving numeric diagnostics", async () => {
        const result = await runLoggerScenario("diagnostics");

        expect(result.content).toContain("tokens.input=45000");
        expect(result.content).toContain('"totalInputTokens":132000');
        expect(result.content).toContain("<REDACTED:api_key>");
        expect(result.content).toContain("<REDACTED:authorization>");
        expect(result.content).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEFGH");
        expect(result.content).not.toContain("abcdefghijklmnop");
    });

    test("reports swallowed writes while healthy writes leave the counter at zero", async () => {
        const result = await runLoggerScenario("diagnostics");

        expect(result.healthyDiagnostics).toEqual({
            swallowedWriteCount: 0,
            lastErrorMessage: null,
            lastErrorTime: null,
        });
        expect(result.failedDiagnostics.swallowedWriteCount).toBe(1);
        expect(result.failedDiagnostics.lastErrorMessage).toBeTruthy();
        expect(result.failedDiagnostics.lastErrorTime).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );
    });
});
