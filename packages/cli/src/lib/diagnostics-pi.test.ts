import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { projectPathToPiDirSlug } from "../commands/migrate";
import {
    collectDiagnostics,
    collectPiHistorianDumps,
    renderDiagnosticsMarkdown,
    sanitizeValue,
} from "./diagnostics-pi";

setDefaultTimeout(15_000);

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalPiDir = process.env.PI_CODING_AGENT_DIR;
const originalDataHome = process.env.XDG_DATA_HOME;
const originalStorageDir = process.env.MAGIC_CONTEXT_STORAGE_DIR;
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
const originalNodeEnv = process.env.NODE_ENV;
const originalCacheHome = process.env.XDG_CACHE_HOME;
const originalConfigHome = process.env.XDG_CONFIG_HOME;

function makeTempRoot(prefix = "mc-pi-diagnostics-"): string {
    const root = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
}

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalPiDir;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalStorageDir === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    else process.env.MAGIC_CONTEXT_STORAGE_DIR = originalStorageDir;
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalCacheHome;
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;

    for (const root of tempRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe("sanitizeValue Pi diagnostics redaction", () => {
    it("preserves numeric thresholds while redacting string secrets", () => {
        expect(
            sanitizeValue({
                execute_threshold_tokens: 200000,
                api_key: "sk-x",
            }),
        ).toEqual({
            execute_threshold_tokens: 200000,
            api_key: "<REDACTED:api_key>",
        });
    });

    it("uses the shared key classifier for token budgets and secret classes", () => {
        expect(
            sanitizeValue({
                execute_threshold_tokens: { default: 200000 },
                injection_budget_tokens: 4000,
                access_token: "high-entropy-access-token",
                hasUsageTokens: true,
            }),
        ).toEqual({
            execute_threshold_tokens: { default: 200000 },
            injection_budget_tokens: 4000,
            access_token: "<REDACTED:access_token>",
            hasUsageTokens: true,
        });
    });
});

describe("collectDiagnostics Pi path resolution", () => {
    it("reports the explicit shared storage directory and its source", async () => {
        const root = makeTempRoot();
        const cwd = join(root, "workspace");
        const home = join(root, "home");
        const storageDir = join(home, "shared-magic-context");
        process.env.HOME = home;
        process.env.XDG_DATA_HOME = join(root, "private-data");
        process.env.XDG_CACHE_HOME = join(root, "cache");
        process.env.XDG_CONFIG_HOME = join(root, "config");
        process.env.MAGIC_CONTEXT_STORAGE_DIR = storageDir;
        delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
        process.env.NODE_ENV = "development";

        mkdirSync(cwd, { recursive: true });
        const report = await collectDiagnostics(cwd);

        expect(report.storageDir.path).toBe(storageDir);
        expect(report.storageDir.source).toBe("environment override");
        const markdown = renderDiagnosticsMarkdown(report);
        expect(markdown).toContain(
            "Magic Context storage is at ~/shared-magic-context, outside the folder Engram backs up (~/.local/share/cortexkit/magic-context). It is not included in CortexKit backups.",
        );
        expect(markdown).not.toContain(storageDir);
    });

    it("reads recent sessions from PI_CODING_AGENT_DIR instead of HOME/.pi/agent", async () => {
        const root = makeTempRoot();
        const home = join(root, "home");
        const cwd = join(root, "workspace");
        const agentDir = join(root, "isolated", "agent");
        process.env.HOME = home;
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.env.XDG_DATA_HOME = join(root, "data");
        process.env.XDG_CACHE_HOME = join(root, "cache");
        process.env.XDG_CONFIG_HOME = join(root, "config");

        mkdirSync(cwd, { recursive: true });
        mkdirSync(join(cwd, ".cortexkit"), { recursive: true });
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(join(process.env.XDG_CONFIG_HOME, "cortexkit"), { recursive: true });

        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
        writeFileSync(
            join(process.env.XDG_CONFIG_HOME, "cortexkit", "magic-context.jsonc"),
            JSON.stringify({ embedding: { provider: "local" } }),
        );
        writeFileSync(join(cwd, ".cortexkit", "magic-context.jsonc"), JSON.stringify({}));

        const customProject = "/tmp/mcdiagnosticproject";
        const customSessionId = "2026-07-07T12-00-00-000Z_customsession";
        const customSlugDir = join(agentDir, "sessions", projectPathToPiDirSlug(customProject));
        mkdirSync(customSlugDir, { recursive: true });
        writeFileSync(join(customSlugDir, `${customSessionId}.jsonl`), '{"type":"session"}\n');

        const homeFallbackSlugDir = join(
            home,
            ".pi",
            "agent",
            "sessions",
            projectPathToPiDirSlug("/tmp/homefallbackproject"),
        );
        mkdirSync(homeFallbackSlugDir, { recursive: true });
        writeFileSync(
            join(homeFallbackSlugDir, "2026-07-07T12-00-00-000Z_homesession.jsonl"),
            '{"type":"session"}\n',
        );

        const report = await collectDiagnostics(cwd);

        expect(report.configPaths.agentDir).toBe(agentDir);
        expect(report.recentSessions).toEqual([
            {
                sessionId: customSessionId,
                directory: customProject,
                lastActiveAt: report.recentSessions[0]?.lastActiveAt,
            },
        ]);
    });
});

// Current plugins write historian dumps into per-session temp dirs; plugins up
// to 0.49.57 wrote them into project directories. Pi doctor lists both.
describe("Pi historian dump collection", () => {
    it("lists per-session temp dumps beside old project dumps", () => {
        const root = makeTempRoot("mc-pi-dumps-");
        const historianRoot = join(root, "tmp", "pi", "magic-context", "historian");
        const project = join(root, "project");
        const writeDump = (dir: string, name: string, ageMinutes: number) => {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, name), "<output></output>\n");
            const when = new Date(Date.now() - ageMinutes * 60_000);
            utimesSync(join(dir, name), when, when);
        };
        writeDump(join(historianRoot, "pi-session-b"), "historian-initial-2.xml", 1);
        writeDump(join(historianRoot, "pi-session-a"), "historian-initial-1.xml", 10);
        writeDump(join(historianRoot, "pi-session-a"), "historian-repair-1.xml", 5);
        writeDump(
            join(project, ".cortexkit", "magic-context", "historian"),
            "old-project-dump.xml",
            60,
        );

        const dumps = collectPiHistorianDumps(
            [{ sessionId: "pi-session-a", directory: project, lastActiveAt: "2026-11-16T20:00:00.000Z" }],
            historianRoot,
        );

        expect(dumps.sessionDumps).toMatchObject({ dir: historianRoot, count: 3, sessionCount: 2 });
        expect(
            dumps.sessionDumps.sessions.map((session) => [
                session.sessionId,
                session.recent.map((dump) => dump.name),
            ]),
        ).toEqual([
            ["pi-session-b", ["historian-initial-2.xml"]],
            ["pi-session-a", ["historian-repair-1.xml", "historian-initial-1.xml"]],
        ]);
        expect(dumps.byProject.map((bucket) => [bucket.directory, bucket.count])).toEqual([
            [project, 1],
        ]);
        expect(dumps.legacyDumps.count).toBe(0);
    });
});
