import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import type { HarnessAdapter } from "../adapters/types";
import {
    collectOpenCodePluginCacheReport,
    type DiagnosticReport,
} from "../lib/diagnostics-opencode";
import * as githubIssue from "../lib/github-issue";
import { MAX_GITHUB_BODY_BYTES } from "../lib/issue-body";
import { getOpenCodeV2PluginCacheSlot, OPENCODE_PLUGIN_NAME } from "../lib/opencode-plugin-cache";
import type { PromptIO, PromptSpinner } from "../lib/prompts";
import * as prompts from "../lib/prompts";
import { dispatchDoctor } from "./doctor";
import * as ompDoctor from "./doctor-omp";
import * as openCodeDoctor from "./doctor-opencode";
import * as piDoctor from "./doctor-pi";

const roots: string[] = [];
const restores: Array<() => void> = [];

afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-doctor-report-"));
    roots.push(root);
    return root;
}

function failOnPrompt(name: string): () => never {
    return () => {
        throw new Error(`--report must not prompt (${name})`);
    };
}

describe("doctor --issue --report dispatch", () => {
    it("forwards the report path to every harness doctor", async () => {
        const seen: Record<string, unknown> = {};
        const openCode = spyOn(openCodeDoctor, "runDoctor").mockImplementation(async (options) => {
            seen.opencode = options;
            return 0;
        });
        const omp = spyOn(ompDoctor, "runDoctor").mockImplementation(async (options) => {
            seen.omp = options;
            return 0;
        });
        const pi = spyOn(piDoctor, "doctor").mockImplementation(async (args) => {
            seen.pi = args;
            return 0;
        });
        restores.push(
            () => openCode.mockRestore(),
            () => omp.mockRestore(),
            () => pi.mockRestore(),
        );

        for (const kind of ["opencode", "omp", "pi"] as const) {
            await dispatchDoctor({ kind } as HarnessAdapter, {
                issue: true,
                report: "out/diagnostics.md",
            });
        }

        expect(seen.opencode).toMatchObject({ issue: true, report: "out/diagnostics.md" });
        expect(seen.omp).toMatchObject({ issue: true, report: "out/diagnostics.md" });
        expect(seen.pi).toEqual(["--issue", "--report", "out/diagnostics.md"]);
    });
});

function fakeReport(root: string, opencodeVersion = "1.0.0"): DiagnosticReport {
    const logPath = join(root, "opencode.log");
    writeFileSync(logPath, "INFO started\n");
    return {
        timestamp: "2026-05-11T12:00:00.000Z",
        platform: "darwin",
        arch: "arm64",
        nodeVersion: "v24.0.0",
        pluginVersion: "0.39.0",
        opencodeInstalled: true,
        opencodeVersion,
        opencodeInstallKind: "cli",
        opencodeInstallations: [],
        configPaths: {
            configDir: join(root, "config"),
            opencodeConfig: join(root, "config", "opencode.jsonc"),
            opencodeConfigFormat: "jsonc",
            magicContextConfig: join(root, "config", "magic-context.jsonc"),
            tuiConfig: join(root, "config", "tui.jsonc"),
            tuiConfigFormat: "jsonc",
            omoConfig: null,
        },
        opencodeConfigHasPlugin: true,
        tuiConfigHasPlugin: true,
        magicContextConfig: { exists: true, flags: {} },
        pluginCache: { path: join(root, "cache") },
        storageDir: { path: join(root, "storage"), exists: true, contextDbSizeBytes: 0 },
        conflicts: {
            hasConflict: false,
            reasons: [],
            compactionEnabled: true,
            nativeCompaction: { auto: false, prune: false },
        },
        logFile: { path: logPath, exists: true, sizeKb: 1 },
        recentSessions: { available: true, rows: [] },
        historianDumps: { byProject: [], legacyDumps: { dir: root, count: 0, recent: [] } },
        historianFailures: { available: true, rows: [] },
        historianRuns: { available: true, rows: [] },
    };
}

/** No npm lookup and no config read: the report as filed when the version check is unavailable. */
const noFreshness = async () => ({ npmVersions: {} });

describe("OpenCode doctor --issue --report", () => {
    it("writes the report to the given path without prompting", async () => {
        const root = tempRoot();
        for (const name of ["text", "confirm", "selectOne"] as const) {
            const spy = spyOn(prompts, name).mockImplementation(failOnPrompt(name));
            restores.push(() => spy.mockRestore());
        }
        const originalCwd = process.cwd();
        process.chdir(root);
        restores.push(() => process.chdir(originalCwd));

        const code = await openCodeDoctor.runIssueFlow(
            { reportPath: join("out", "diagnostics.md") },
            { collectDiagnostics: async () => fakeReport(root), checkPluginFreshness: noFreshness },
        );

        expect(code).toBe(0);
        const written = join(root, "out", "diagnostics.md");
        expect(existsSync(written)).toBe(true);
        expect(readFileSync(written, "utf-8")).toContain("## Diagnostics");
    });

    it("shows the sanitized backup warning for OpenCode 1 and OpenCode 2", async () => {
        const root = tempRoot();
        const originalHome = process.env.HOME;
        process.env.HOME = root;
        restores.push(() => {
            if (originalHome === undefined) delete process.env.HOME;
            else process.env.HOME = originalHome;
        });
        const originalCwd = process.cwd();
        process.chdir(root);
        restores.push(() => process.chdir(originalCwd));

        for (const version of ["1.0.0", "2.0.0"]) {
            const reportPath = join(root, `opencode-${version}-diagnostics.md`);
            const code = await openCodeDoctor.runIssueFlow(
                { reportPath },
                {
                    collectDiagnostics: async () => fakeReport(root, version),
                    checkPluginFreshness: noFreshness,
                },
            );

            expect(code).toBe(0);
            const body = readFileSync(reportPath, "utf-8");
            expect(body).toContain(
                "Magic Context storage is at ~/project-1/<path>, outside the folder Engram backs up (~/.local/share/cortexkit/magic-context). It is not included in CortexKit backups.",
            );
            expect(body).not.toContain(root);
        }
    });
});

describe("OpenCode doctor --issue on an outdated plugin", () => {
    const INSTALLED = "0.49.34";
    const NEWEST = "0.49.52";
    const STALE_WARNING = `warn OpenCode 2 is running an outdated Magic Context (cached: ${INSTALLED}, latest: ${NEWEST}); OpenCode does not install new releases on its own`;
    const UPDATE_ADVICE =
        "info   To upgrade, update it from OpenCode: open /plugins, select Magic Context and press ctrl+u (ctrl+r only re-checks), or run `opencode plugin update`,";
    const FIX_ADVICE =
        "info   or quit OpenCode (including `opencode service stop`) and run `magic-context doctor --fix`.";
    const QUESTION = "Continue filing the issue? No stops here so you can update first.";

    function useEnv(values: Record<string, string>): void {
        const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
        Object.assign(process.env, values);
        restores.push(() => {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
    }

    /** An OpenCode 2 cache holding `installed`, loaded through an `@latest` config entry. */
    function installedPlugin(installed = INSTALLED) {
        const root = tempRoot();
        const configDir = join(root, "config", "opencode");
        useEnv({ HOME: root, XDG_CACHE_HOME: join(root, "cache"), OPENCODE_CONFIG_DIR: configDir });
        const config = { plugin: [`${OPENCODE_PLUGIN_NAME}@latest`] };
        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, "opencode.jsonc"), JSON.stringify(config));
        const slot = getOpenCodeV2PluginCacheSlot(undefined, "latest");
        const generation = join(slot, "1790000000000");
        const packageDir = join(generation, "node_modules", ...OPENCODE_PLUGIN_NAME.split("/"));
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(
            join(packageDir, "package.json"),
            JSON.stringify({ name: OPENCODE_PLUGIN_NAME, version: installed }),
        );
        writeFileSync(join(generation, "package.json"), JSON.stringify({ dependencies: {} }));
        const originalCwd = process.cwd();
        process.chdir(root);
        restores.push(() => process.chdir(originalCwd));
        return { root, config, slot };
    }

    /** Real check and report wiring, with the npm lookup faked to return `newest`. */
    function issueDeps(
        fixture: ReturnType<typeof installedPlugin>,
        options: { newest: string | null; platform?: NodeJS.Platform; interactive?: boolean },
    ) {
        const lookups: string[] = [];
        const deps: openCodeDoctor.IssueFlowDeps = {
            collectDiagnostics: async (collect) => ({
                ...fakeReport(fixture.root, "2.0.0"),
                pluginCache: collectOpenCodePluginCacheReport(
                    "v2",
                    fixture.config,
                    collect?.npmVersions,
                ),
            }),
            checkPluginFreshness: () =>
                openCodeDoctor.checkPluginFreshnessForIssue({
                    fetchNpmLatest: async (_pkg, distTag = "latest") => {
                        lookups.push(distTag);
                        return options.newest;
                    },
                }),
            platform: options.platform ?? "linux",
            isInteractive: () => options.interactive ?? true,
        };
        return { deps, lookups };
    }

    /** Records what the flow prints and asks; `fileAnyway` answers the outdated-plugin question. */
    function capturePrompts(fileAnyway: boolean) {
        const output: string[] = [];
        const questions: string[] = [];
        const filed: string[] = [];
        const spies = [
            spyOn(prompts.log, "warn").mockImplementation((m) => void output.push(`warn ${m}`)),
            spyOn(prompts.log, "info").mockImplementation((m) => void output.push(`info ${m}`)),
            spyOn(prompts.log, "success").mockImplementation((m) => void output.push(`pass ${m}`)),
            spyOn(prompts.log, "error").mockImplementation((m) => void output.push(`error ${m}`)),
            spyOn(prompts, "intro").mockImplementation(() => {}),
            spyOn(prompts, "outro").mockImplementation((m) => void output.push(`outro ${m}`)),
            spyOn(prompts, "spinner").mockImplementation(() => ({
                start: () => {},
                stop: () => {},
                message: () => {},
            })),
            spyOn(prompts, "confirm").mockImplementation(async (message) => {
                questions.push(message);
                return message === QUESTION ? fileAnyway : true;
            }),
            spyOn(prompts, "text").mockImplementation(async (message) =>
                message === "Issue title" ? "Old bug" : "It broke",
            ),
            spyOn(prompts, "selectOne").mockImplementation(failOnPrompt("selectOne")),
            spyOn(githubIssue, "submitGithubIssue").mockImplementation((_title, path) => {
                filed.push(path);
                return { ok: true, output: "https://github.com/cortexkit/magic-context/issues/1" };
            }),
        ];
        for (const spy of spies) restores.push(() => spy.mockRestore());
        return { output, questions, filed };
    }

    function issueFilesIn(root: string): string[] {
        return readdirSync(root).filter((name) => name.startsWith("magic-context-issue-"));
    }

    it("warns, prints the update advice and asks before filing; stop files nothing", async () => {
        const fixture = installedPlugin();
        const { deps, lookups } = issueDeps(fixture, { newest: NEWEST });
        const { output, questions, filed } = capturePrompts(false);

        expect(await openCodeDoctor.runIssueFlow({}, deps)).toBe(0);

        expect(output.slice(0, 3)).toEqual([STALE_WARNING, UPDATE_ADVICE, FIX_ADVICE]);
        expect(questions).toEqual([QUESTION]);
        expect(output.at(-1)).toBe(
            "outro Issue not filed. Update the plugin, then run `magic-context doctor --issue` again if the problem remains.",
        );
        expect(filed).toEqual([]);
        expect(issueFilesIn(fixture.root)).toEqual([]);
        expect(lookups).toEqual(["latest"]);
    });

    it("files the issue with the outdated line and npm's newest version when the user continues", async () => {
        const fixture = installedPlugin();
        const { deps, lookups } = issueDeps(fixture, { newest: NEWEST });
        const { output, questions, filed } = capturePrompts(true);

        expect(await openCodeDoctor.runIssueFlow({}, deps)).toBe(0);

        expect(output.slice(0, 3)).toEqual([STALE_WARNING, UPDATE_ADVICE, FIX_ADVICE]);
        expect(questions).toEqual([QUESTION, "Submit this issue on GitHub now?"]);
        expect(filed).toHaveLength(1);
        const body = readFileSync(filed[0]!, "utf-8");
        expect(body).toContain(
            [
                "## Environment",
                `- Plugin is outdated: installed ${INSTALLED}, newest ${NEWEST}.`,
                `- magic-context CLI: v0.39.0 (installed plugin: v${INSTALLED})`,
            ].join("\n"),
        );
        expect(body).toContain(`"latest": "${NEWEST}",\n  "latest_source": "npm"`);
        // The version fetched for the warning is reused for the body: one lookup in all.
        expect(lookups).toEqual(["latest"]);
    });

    it("files an up-to-date install as before, apart from the relabelled CLI line", async () => {
        const fixture = installedPlugin(NEWEST);
        const { deps } = issueDeps(fixture, { newest: NEWEST });
        const { output, questions } = capturePrompts(false);
        const reportPath = join(fixture.root, "report.md");

        expect(await openCodeDoctor.runIssueFlow({ reportPath }, deps)).toBe(0);

        expect(output).toEqual([`info Report written to ${reportPath}`]);
        expect(questions).toEqual([]);
        const body = readFileSync(reportPath, "utf-8");
        expect(body).toContain(
            `## Environment\n- magic-context CLI: v0.39.0 (installed plugin: v${NEWEST})\n- OS: `,
        );
        expect(body).not.toContain("Plugin is outdated");
        expect(body).not.toContain("- Plugin: v");
        expect(body).toContain(`"latest": "${NEWEST}",\n  "latest_source": "npm"`);
    });

    it("warns and continues without asking when no one can answer", async () => {
        const fixture = installedPlugin();
        const { deps } = issueDeps(fixture, { newest: NEWEST, interactive: false });
        const { output, questions, filed } = capturePrompts(false);

        expect(await openCodeDoctor.runIssueFlow({}, deps)).toBe(0);

        expect(output.slice(0, 3)).toEqual([STALE_WARNING, UPDATE_ADVICE, FIX_ADVICE]);
        expect(questions).toEqual(["Submit this issue on GitHub now?"]);
        expect(filed).toHaveLength(1);
        expect(readFileSync(filed[0]!, "utf-8")).toContain(
            `- Plugin is outdated: installed ${INSTALLED}, newest ${NEWEST}.`,
        );
    });

    it("warns and writes the report under --report without asking", async () => {
        const fixture = installedPlugin();
        const { deps } = issueDeps(fixture, { newest: NEWEST });
        const { output, questions } = capturePrompts(false);
        const reportPath = join(fixture.root, "report.md");

        expect(await openCodeDoctor.runIssueFlow({ reportPath }, deps)).toBe(0);

        expect(output).toEqual([
            STALE_WARNING,
            UPDATE_ADVICE,
            FIX_ADVICE,
            `info Report written to ${reportPath}`,
        ]);
        expect(questions).toEqual([]);
        expect(readFileSync(reportPath, "utf-8")).toContain(
            `- Plugin is outdated: installed ${INSTALLED}, newest ${NEWEST}.`,
        );
    });

    it("files as before when the newest version cannot be fetched", async () => {
        const fixture = installedPlugin();
        const { deps, lookups } = issueDeps(fixture, { newest: null });
        const { output, questions } = capturePrompts(false);
        const reportPath = join(fixture.root, "report.md");

        expect(await openCodeDoctor.runIssueFlow({ reportPath }, deps)).toBe(0);

        expect(lookups).toEqual(["latest"]);
        expect(output).toEqual([`info Report written to ${reportPath}`]);
        expect(questions).toEqual([]);
        const body = readFileSync(reportPath, "utf-8");
        expect(body).not.toContain("Plugin is outdated");
        expect(body).toContain(`- magic-context CLI: v0.39.0 (installed plugin: v${INSTALLED})`);
        // `latest` falls back to the CLI's own version and says so.
        expect(body).toContain('"latest_source": "cli"');
    });

    it("gives Windows the Windows advice instead of doctor --fix", async () => {
        const fixture = installedPlugin();
        const { deps } = issueDeps(fixture, { newest: NEWEST, platform: "win32" });
        const { output } = capturePrompts(false);

        expect(await openCodeDoctor.runIssueFlow({}, deps)).toBe(0);

        expect(output.slice(0, 3)).toEqual([
            STALE_WARNING,
            UPDATE_ADVICE,
            `info   or quit OpenCode and delete ${fixture.slot}; the next start installs the current release.`,
        ]);
        expect(output.join("\n")).not.toContain("doctor --fix");
    });
});

class NoPrompts implements PromptIO {
    readonly messages: string[] = [];
    readonly log = {
        info: (message: string) => this.messages.push(`info:${message}`),
        success: (message: string) => this.messages.push(`success:${message}`),
        warn: (message: string) => this.messages.push(`warn:${message}`),
        error: (message: string) => this.messages.push(`error:${message}`),
        message: (message: string) => this.messages.push(`message:${message}`),
        step: (message: string) => this.messages.push(`step:${message}`),
    };
    intro(): void {}
    outro(): void {}
    note(): void {}
    spinner(): PromptSpinner {
        return { start: () => {}, stop: () => {}, message: () => {} };
    }
    confirm = failOnPrompt("confirm");
    text = failOnPrompt("text");
    selectOne = failOnPrompt("selectOne");
    selectMany = failOnPrompt("selectMany");
    selectAutocomplete = failOnPrompt("selectAutocomplete");
}

function prepareOmpIssueFixture(root: string, logContent: string) {
    const agentDir = join(root, ".omp", "agent");
    const pluginDir = join(root, "plugin");
    const configDir = join(root, ".config", "cortexkit");
    const logPath = join(root, "runtime.log");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({ omp: { extensions: ["./dist/index.js"] } }),
    );
    writeFileSync(join(configDir, "magic-context.jsonc"), "{}\n");
    writeFileSync(logPath, logContent);
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.XDG_CONFIG_HOME = join(root, ".config");
    process.env.XDG_DATA_HOME = join(root, ".local", "share");
    process.env.MAGIC_CONTEXT_LOG_PATH = logPath;

    return {
        logPath,
        deps: {
            detectOmpBinary: () => ({ path: "/fake/omp", source: "path" as const }),
            getOmpVersion: () => "17.1.7",
            listOmpPlugins: () => [
                {
                    name: "@cortexkit/pi-magic-context",
                    version: "0.49.2",
                    enabled: true,
                    path: pluginDir,
                },
            ],
            getOmpSetting: ((_path: string, key: string) =>
                key === "compaction.enabled" ? false : "off") as never,
            runOmpCommand: () => ({ ok: true, stdout: agentDir, stderr: "" }),
        },
    };
}

describe("OMP doctor --issue --report", () => {
    const savedEnv = {
        HOME: process.env.HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
        MAGIC_CONTEXT_LOG_PATH: process.env.MAGIC_CONTEXT_LOG_PATH,
    };

    it("writes the report to the given path without prompting", async () => {
        const root = tempRoot();
        restores.push(() => {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
        process.env.HOME = root;
        process.env.PI_CODING_AGENT_DIR = join(root, ".omp", "agent");
        process.env.XDG_CONFIG_HOME = join(root, ".config");
        process.env.XDG_DATA_HOME = join(root, ".local", "share");

        const code = await ompDoctor.runDoctor({
            issue: true,
            report: "omp-diagnostics.md",
            cwd: root,
            prompts: new NoPrompts(),
            deps: {
                detectOmpBinary: () => null,
                listOmpPlugins: () => [],
            },
        });

        expect(code).toBe(0);
        const written = join(root, "omp-diagnostics.md");
        expect(existsSync(written)).toBe(true);
        expect(readFileSync(written, "utf-8")).toContain("## OMP diagnostics");
    });

    it("includes OMP environment, checks, recent errors and sanitized log tail", async () => {
        const root = tempRoot();
        restores.push(() => {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
        const logLine =
            "[2026-09-05T10:41:03.130Z] [magic-context][ses_omp] could not safely prepare this turn: protected source";
        const { deps } = prepareOmpIssueFixture(
            root,
            `${logLine}\n[2026-09-05T10:41:04.130Z] [magic-context][ses_omp] runtime continued\n`,
        );

        const code = await ompDoctor.runDoctor({
            issue: true,
            report: "omp-diagnostics.md",
            cwd: root,
            prompts: new NoPrompts(),
            deps,
        });

        expect(code).toBe(0);
        const body = readFileSync(join(root, "omp-diagnostics.md"), "utf-8");
        expect(body).toContain("## Environment");
        expect(body).toContain("Magic Context plugin: v0.49.2");
        expect(body).toContain("Oh My Pi: 17.1.7");
        expect(body).toContain(`OS: ${process.platform} ${process.arch}`);
        expect(body).toContain(`Runtime: Node.js ${process.version}`);
        expect(body).toContain("## OMP diagnostics");
        expect(body).toContain("Magic Context storage ~/project-1/<path>");
        expect(body).not.toContain(root);
        expect(body).toContain("## Recent errors (last 20, sanitized)");
        expect(body).toContain("refused: <text omitted>");
        expect(body).not.toContain("protected source");
        expect(body).toContain("## Log (last 400 lines, sanitized)");
        expect(body).toContain("magic-context [session-1]");
        expect(body).not.toContain("runtime continued");
    });

    it("keeps a refusal visible when a large OMP log is capped", async () => {
        const root = tempRoot();
        restores.push(() => {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
        const lines = Array.from(
            { length: 4_600 },
            (_, index) =>
                `[2026-09-05T10:41:03.130Z] [magic-context][ses_omp] tail count=${index} tokens=${"9".repeat(200)}`,
        );
        const refusal =
            "[2026-09-05T10:41:03.130Z] [magic-context][ses_omp] refused (unsafe turn preparation)";
        lines[1_000] = refusal;
        const { deps } = prepareOmpIssueFixture(root, lines.join("\n"));

        const code = await ompDoctor.runDoctor({
            issue: true,
            report: "omp-diagnostics.md",
            cwd: root,
            prompts: new NoPrompts(),
            deps,
        });

        expect(code).toBe(0);
        const outputPath = join(root, "omp-diagnostics.md");
        const body = readFileSync(outputPath, "utf-8");
        expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_GITHUB_BODY_BYTES);
        expect(body).toContain("[truncated for GitHub 64KB limit");
        expect(body).toContain("## Recent errors (last 20, sanitized)");
        expect(body).toContain("refused: <text omitted>");
        expect(body).not.toContain(refusal);
        expect(existsSync(`${outputPath}.full.md`)).toBe(true);
        expect(readFileSync(`${outputPath}.full.md`, "utf-8")).toContain("refused: <text omitted>");
        expect(readFileSync(`${outputPath}.full.md`, "utf-8")).not.toContain("ses_omp");
    });

    it("filters the interactive OMP report to the selected session", async () => {
        const root = tempRoot();
        restores.push(() => {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
        const logLines = [
            "[2026-09-05T10:41:03.130Z] [magic-context][ses_keep] selected-session detail count=17",
            "[2026-09-05T10:41:04.130Z] [magic-context][ses_other] unrelated-session detail count=29",
        ];
        const { deps } = prepareOmpIssueFixture(root, logLines.join("\n"));
        const prompts = new NoPrompts();
        prompts.text = (async (message: string) =>
            message === "Issue title" ? "OMP issue" : "description") as never;
        prompts.selectOne = (async (_message: string, choices: Array<{ value: string }>) => {
            expect(choices.map((choice) => choice.value)).toContain("ses_keep");
            expect(choices.map((choice) => choice.value)).toContain("__all__");
            return "ses_keep";
        }) as never;
        prompts.confirm = (async () => false) as never;

        const code = await ompDoctor.runDoctor({
            issue: true,
            cwd: root,
            prompts,
            deps: { ...deps, now: () => new Date("2026-09-21T09:15:00.000Z") },
        });

        expect(code).toBe(0);
        const reportMessage = prompts.messages.find((message) =>
            message.startsWith("success:Sanitized report written to "),
        );
        const outputPath = reportMessage?.split(" ").at(-1);
        expect(outputPath).toBeDefined();
        const body = readFileSync(outputPath!, "utf-8");
        expect(body).toContain("count=17");
        expect(body).not.toContain("count=29");
        expect(body).not.toContain("selected-session detail");
        expect(body).not.toContain("unrelated-session detail");
    });

    it("redacts a secret-looking value from an OMP runtime log", async () => {
        const root = tempRoot();
        restores.push(() => {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
        const secret = "eyJhbGciOiJIUzI1NiJ9.signature";
        const { deps } = prepareOmpIssueFixture(
            root,
            `[2026-09-05T10:41:03.130Z] [magic-context][ses_omp] Authorization: Bearer ${secret}\n`,
        );

        const code = await ompDoctor.runDoctor({
            issue: true,
            report: "omp-diagnostics.md",
            cwd: root,
            prompts: new NoPrompts(),
            deps,
        });

        expect(code).toBe(0);
        const body = readFileSync(join(root, "omp-diagnostics.md"), "utf-8");
        expect(body).not.toContain(secret);
    });

    it("reports the Hide Secrets check as a readable line without paths", async () => {
        const parent = join(tmpdir(), "magic-context", "omp-hide-secrets");
        mkdirSync(parent, { recursive: true });
        const root = createTestTempDirFromPath(join(parent, "issue-"));
        roots.push(root);
        restores.push(() => {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
        const { deps } = prepareOmpIssueFixture(root, "");
        const agentDir = join(root, ".omp", "agent");
        writeFileSync(join(agentDir, "config.yml"), "secrets:\n  enabled: true\n");
        writeFileSync(
            join(agentDir, "secrets.yml"),
            "- type: plain\n  content: sk-fixture-SECRET\n",
        );

        const code = await ompDoctor.runDoctor({
            issue: true,
            report: "omp-diagnostics.md",
            cwd: root,
            prompts: new NoPrompts(),
            deps,
        });

        expect(code).toBe(0);
        const body = readFileSync(join(root, "omp-diagnostics.md"), "utf-8");
        const line = body.split("\n").find((entry) => entry.includes("Hide Secrets"));
        expect(line).toStartWith(
            "- WARN: OMP Hide Secrets (secrets.enabled) is on in OMP user settings: ",
        );
        expect(line).toContain(
            "https://docs.cortexkit.io/magic-context/help/compatibility/#omp-hide-secrets",
        );
        expect(line).not.toContain(agentDir);
        expect(body).not.toContain("sk-fixture-SECRET");
    });
});
