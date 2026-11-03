import { afterEach, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { runDoctor as runOmpDoctor } from "../commands/doctor-omp";
import { runIssueFlow } from "../commands/doctor-opencode";
import { runDoctor as runPiDoctor } from "../commands/doctor-pi";
import type { DiagnosticReport } from "./diagnostics-opencode";
import type { PiDiagnosticReport } from "./diagnostics-pi";
import { ISSUE_LOG_TEMPLATES, IssuePrivacy } from "./issue-privacy";

const roots: string[] = [];
const savedEnv = { ...process.env };
afterEach(() => {
    process.env = { ...savedEnv };
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
    mkdirSync(join(tmpdir(), "magic-context/doctor-pii"), { recursive: true });
    const root = createTestTempDirFromPath(join(tmpdir(), "magic-context/doctor-pii/report-"));
    roots.push(root);
    const env = {
        HOME: root,
        USERPROFILE: root,
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_RUNTIME_DIR: join(root, "runtime"),
        OPENCODE_DB: join(root, "host.db"),
        MAGIC_CONTEXT_STORAGE_DIR: join(root, "storage"),
        OPENCODE_CONFIG_DIR: join(root, "config/opencode"),
        PI_CODING_AGENT_DIR: join(root, ".pi/agent"),
        PI_CONFIG_DIR: ".omp",
        PI_CONFIG_FILES: "",
        PI_PACKAGE_DIR: join(root, "package"),
        MAGIC_CONTEXT_LOG_PATH: join(root, "runtime.log"),
    };
    Object.assign(process.env, env);
    for (const path of [
        env.XDG_CONFIG_HOME,
        env.MAGIC_CONTEXT_STORAGE_DIR,
        env.PI_CODING_AGENT_DIR,
        env.PI_PACKAGE_DIR,
    ])
        mkdirSync(path, { recursive: true });
    const logs = [
        "2026-09-05T10:41:03.130Z ERROR magic-context.historian: [session=opencode:ses_private700] TypeError: Customer payroll account /Users/avery/Work/acme-payroll/src/payroll-secret.ts email=avery@private.example host=avery-mbp.local token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 retry=2 durationMs=125 count=7",
        "[2026-09-05T10:41:04.130Z] [magic-context][ses_private701] historian prompt failed: tool read /home/avery/Work/secret-orchard/.env API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 tokens=4096",
        "2026-09-05T10:41:05.130Z INFO  magic-context.perf: [session=opencode:ses_private700] finished durationMs=125 count=7",
        "    at payrollCustomer (C:\\Users\\avery\\Work\\private-retina\\src\\customer-secret.ts:42:7)",
        "[2026-09-05T10:41:06.130Z] [magic-context][ses_private700] failed: project=git:1a2b3c4d5e6f7081928374655647382910abcdef project=dir:/Users/avery/Work/acme-payroll project=pj-98fedcba76543210",
        "unrecognized raw file content customer-source-marker password: colonSecret700",
        '2026-09-05T10:41:07.130Z WARN  magic-context.private-repository: [session=pi:af3c7000-1234-5678-abcd-abc012340000] tool="customer-tool-marker" payload="customer-message-marker"',
    ];
    writeFileSync(env.MAGIC_CONTEXT_LOG_PATH, logs.join("\n"));
    const flags = {
        $schema: "https://cortexkit.dev/schemas/magic-context.json",
        compaction: { enabled: true },
        historian: { model: "anthropic/claude-sonnet-4-5", max_tokens: 4096 },
        embedding: {
            provider: "openai-compatible",
            model: "text-embedding-3-small",
            api_key: "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
        },
        storage: { directory: "/Users/avery/Work/acme-payroll/private-db" },
        email: "avery@private.example",
        hostname: "avery-mbp.local",
        repository: "private-repository",
        project: "git:1a2b3c4d5e6f7081928374655647382910abcdef",
        projectId: "pj-98fedcba76543210",
        prompt: "customer-message-marker",
        otherPath: "C:\\Users\\avery\\Work\\private-retina\\src\\customer-secret.ts",
    };
    const rows = [
        {
            sessionId: "ses_private700",
            title: "private-repository customer-message-marker",
            directory: "/Users/avery/Work/acme-payroll",
            lastActiveAt: "2026-09-05T10:41:03.130Z",
        },
        {
            sessionId: "ses_private701",
            title: "customer-tool-marker",
            directory: "/home/avery/Work/secret-orchard",
            parentSessionId: "ses_private700",
            lastActiveAt: "2026-09-05T10:41:03.130Z",
        },
        {
            sessionId: "af3c7000-1234-5678-abcd-abc012340000",
            title: "customer-source-marker",
            directory: "C:\\Users\\avery\\Work\\private-retina",
            lastActiveAt: "2026-09-05T10:41:03.130Z",
        },
    ];
    const report: DiagnosticReport = {
        timestamp: "2026-09-05T10:41:03.130Z",
        platform: "linux",
        arch: "x64",
        nodeVersion: "v24.0.0",
        pluginVersion: "0.49.6",
        opencodeInstalled: true,
        opencodeVersion: "1.2.27",
        opencodeInstallKind: "cli",
        opencodeInstallations: [],
        configPaths: {
            configDir: "/Users/avery/.config/opencode",
            opencodeConfig: "/Users/avery/.config/opencode/opencode.jsonc",
            opencodeConfigFormat: "jsonc",
            magicContextConfig: "/Users/avery/Work/acme-payroll/.cortexkit/magic-context.jsonc",
            tuiConfig: "/Users/avery/.config/opencode/tui.jsonc",
            tuiConfigFormat: "jsonc",
            omoConfig: null,
        },
        opencodeConfigHasPlugin: true,
        tuiConfigHasPlugin: true,
        magicContextConfig: {
            exists: true,
            flags,
            parseError: "SyntaxError: customer-source-marker",
        },
        pluginCache: { path: "/opt/avery/private-repository/cache", cached: "0.49.6" },
        storageDir: {
            path: env.MAGIC_CONTEXT_STORAGE_DIR,
            exists: true,
            contextDbSizeBytes: 2048,
            source: "environment override",
        },
        conflicts: {
            hasConflict: false,
            reasons: [],
            compactionEnabled: true,
            nativeCompaction: { auto: false, prune: false },
        },
        logFile: { path: env.MAGIC_CONTEXT_LOG_PATH, exists: true, sizeKb: 2 },
        recentSessions: { available: true, rows },
        historianDumps: {
            byProject: rows.map((row) => ({
                directory: row.directory,
                primarySessionId: row.sessionId,
                sessionIds: [row.sessionId],
                count: 7,
                recent: [
                    {
                        name: "payroll-secret.xml",
                        ageMinutes: 3,
                        sizeKb: 7,
                        parseError: "SyntaxError: customer-source-marker",
                    },
                ],
            })),
            legacyDumps: { dir: join(root, "dumps"), count: 0, recent: [] },
        },
        historianFailures: {
            available: true,
            rows: [
                {
                    sessionId: "ses_private700",
                    failureCount: 3,
                    lastError: "TypeError: private-repository avery@private.example",
                    lastFailureAt: "2026-09-05T10:41:03.130Z",
                },
            ],
        },
        historianRuns: {
            available: true,
            rows: [
                {
                    sessionId: "ses_private700",
                    total: 7,
                    success: 4,
                    failed: 2,
                    noop: 1,
                    lastFailureReason: "TypeError: customer-message-marker",
                    lastRunAt: "2026-09-05T10:41:03.130Z",
                },
            ],
        },
    };
    return { root, env, flags, rows, report };
}

it("public issue reports remove seeded identifying strings and retain diagnostics for every host", async () => {
    const { root, env, flags, rows, report } = fixture();
    for (const host of ["opencode1", "opencode2", "pi", "omp"] as const) {
        const output = join(root, `${host}.md`);
        if (host.startsWith("opencode")) {
            report.opencodeVersion = host === "opencode1" ? "1.2.27" : "2.0.0";
            expect(
                await runIssueFlow(
                    { reportPath: output },
                    { collectDiagnostics: async () => report },
                ),
            ).toBe(0);
        } else if (host === "pi") {
            const piReport: PiDiagnosticReport = {
                ...report,
                piInstalled: true,
                piVersion: "0.60.0",
                piPath: "/Users/avery/bin/pi",
                settings: {
                    path: join(root, ".pi/agent/settings.json"),
                    exists: true,
                    hasMagicContextPackage: true,
                    packages: ["git:github.com/avery/private-repository"],
                },
                configPaths: {
                    agentDir: env.PI_CODING_AGENT_DIR,
                    userConfig: "/Users/avery/.config/cortexkit/magic-context.jsonc",
                    projectConfig: "/Users/avery/Work/acme-payroll/.cortexkit/magic-context.jsonc",
                },
                userConfig: {
                    exists: true,
                    path: "/Users/avery/.config/cortexkit/magic-context.jsonc",
                    flags,
                },
                projectConfig: {
                    exists: true,
                    path: "/Users/avery/Work/acme-payroll/.cortexkit/magic-context.jsonc",
                    flags,
                },
                loadedConfigPaths: [
                    "/Users/avery/Work/acme-payroll/.cortexkit/magic-context.jsonc",
                ],
                loadWarnings: ["SyntaxError: customer-source-marker"],
                recentSessions: rows.map((row) => ({
                    ...row,
                    path: join(root, "session.jsonl"),
                    lastUpdatedAt: row.lastActiveAt,
                })),
                historianDumps: { byProject: [], legacyDumps: { dir: root, count: 0, recent: [] } },
                conflicts: {
                    knownConflicts: [],
                    otherPiExtensions: ["git:github.com/avery/private-repository"],
                },
            };
            expect(
                await runPiDoctor({
                    issue: true,
                    report: output,
                    cwd: root,
                    deps: { collectDiagnostics: async () => piReport },
                }),
            ).toBe(0);
        } else {
            const configDir = join(env.XDG_CONFIG_HOME, "cortexkit");
            mkdirSync(configDir, { recursive: true });
            writeFileSync(join(configDir, "magic-context.jsonc"), "{}\n");
            writeFileSync(
                join(env.PI_PACKAGE_DIR, "package.json"),
                JSON.stringify({ omp: { extensions: ["./dist/index.js"] } }),
            );
            expect(
                await runOmpDoctor({
                    issue: true,
                    report: output,
                    cwd: root,
                    deps: {
                        detectOmpBinary: () => ({
                            path: "/Users/avery/Work/acme-payroll/bin/omp",
                            source: "path",
                        }),
                        getOmpVersion: () => "17.1.7",
                        listOmpPlugins: () => [
                            {
                                name: "@cortexkit/pi-magic-context",
                                version: "0.49.6",
                                enabled: true,
                                path: env.PI_PACKAGE_DIR,
                            },
                        ],
                        getOmpSetting: ((_path: string, key: string) =>
                            key === "compaction.enabled" ? false : "off") as never,
                        runOmpCommand: () => ({
                            ok: true,
                            stdout: join(root, ".omp/agent"),
                            stderr: "",
                        }),
                    },
                }),
            ).toBe(0);
        }
        const body = readFileSync(output, "utf8");
        // Each sentinel is literal so omissions cannot hide a bad sanitizer expectation.
        expect(body).not.toContain("avery");
        expect(body).not.toContain("acme-payroll");
        expect(body).not.toContain("secret-orchard");
        expect(body).not.toContain("private-retina");
        expect(body).not.toContain("private-repository");
        expect(body).not.toContain("1a2b3c4d5e6f7081928374655647382910abcdef");
        expect(body).not.toContain("pj-98fedcba76543210");
        expect(body).not.toContain("git:");
        expect(body).not.toContain("dir:");
        expect(body).not.toContain("ses_private700");
        expect(body).not.toContain("ses_private701");
        expect(body).not.toContain("af3c7000-1234-5678-abcd-abc012340000");
        expect(body).not.toContain("payroll-secret.ts");
        expect(body).not.toContain("payroll-secret.xml");
        expect(body).not.toContain("customer-secret.ts");
        expect(body).not.toContain(".env");
        expect(body).not.toContain("payrollCustomer");
        expect(body).not.toContain("avery@private.example");
        expect(body).not.toContain("avery-mbp.local");
        expect(body).not.toContain("Customer payroll account");
        expect(body).not.toContain("customer-source-marker");
        expect(body).not.toContain("customer-tool-marker");
        expect(body).not.toContain("customer-message-marker");
        expect(body).not.toContain("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
        expect(body).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
        expect(body).not.toContain("colonSecret700");
        expect(body).not.toContain("/Users/");
        expect(body).not.toContain("/home/");
        expect(body).not.toContain("C:\\Users\\");
        expect(body).not.toContain(root);
        expect(body).toContain("0.49.6");
        expect(body).toContain("## Recent errors (last 20, sanitized)");
        expect(body).toContain("## Log (last 400 lines, sanitized)");
        expect(body).toContain("ERROR magic-context.historian");
        expect(body).toContain("TypeError");
        expect(body).toContain("historian prompt failed:");
        expect(body).toContain("durationMs=125");
        expect(body).toContain("retry=2");
        expect(body).toContain("count=7");
        expect(body).toContain("tokens=4096");
        expect(body).toContain("session-1");
        expect(body).toContain("~/");
        if (host === "omp") {
            expect(body).toContain("17.1.7");
            expect(body).toContain("OMP native compaction is disabled");
        } else {
            expect(body).toContain('"$schema": "https://cortexkit.dev/schemas/magic-context.json"');
            expect(body).toContain('"enabled": true');
            expect(body).toContain("anthropic/claude-sonnet-4-5");
            expect(body).toContain("openai-compatible");
            expect(body).toContain("text-embedding-3-small");
            expect(body).toContain('"max_tokens": 4096');
            expect(body).toContain("<REDACTED:api_key>");
        }
        if (host.startsWith("opencode")) {
            expect(body).toContain(report.opencodeVersion!);
            expect(body).toContain('"failureCount": 3');
            expect(body).toContain('"total": 7');
            expect(body).toContain('"directory": "~/project-1"');
            expect(body).toContain("~/project-1/<path>");
        }
    }
});

it("correlates paths and identities within a report without reusable hashes", () => {
    const privacy = new IssuePrivacy({
        rows: [
            {
                directory: "/Users/avery/Work/acme-payroll",
                projectId: "git:abcdef0123456789abcdef0123456789abcdef01",
            },
            { directory: "/home/avery/Work/secret-orchard", projectId: "pj-private-id" },
        ],
    });
    expect(privacy.path("/Users/avery/Work/acme-payroll")).toBe("~/project-1");
    expect(privacy.path("~/Work/acme-payroll/src/private.ts")).toBe("~/project-1/<path>");
    expect(privacy.report("git:abcdef0123456789abcdef0123456789abcdef01", "projectId")).toBe(
        "project-1",
    );
    expect(privacy.report("dir:/Users/avery/Work/acme-payroll", "project")).toBe("~/project-1");
    expect(privacy.report("pj-private-id", "projectId")).toBe("project-2");
    expect(privacy.report("ses_private700", "sessionId")).toBe(
        privacy.report("ses_private700", "parentSessionId"),
    );
    expect(new IssuePrivacy({}).report("TypeError failed: customer secret", "title")).toBe(
        "<text omitted>",
    );
    expect(new IssuePrivacy({}).report("ses_other", "sessionId")).toBe("session-1");
});

it("does not trust legacy envelope text or unknown log fields", () => {
    const privacy = new IssuePrivacy({});
    expect(
        privacy.logLine(
            "[avery@private.example] [magic-context][private-session] TypeError: private-source.ts",
        ),
    ).toBe("LOG magic-context TypeError: <text omitted>");
    expect(
        privacy.logLine(
            '2026-09-05T10:41:03.130Z WARN  magic-context: payload="private-source.ts" durationMs=125',
        ),
    ).toBe("2026-09-05T10:41:03.130Z WARN magic-context <text omitted> durationMs=125");
});

it("keeps source-owned log wording while omitting interpolated content", () => {
    const privacy = new IssuePrivacy({});
    const output = [
        privacy.logLine(
            "[2026-09-05T10:41:03.130Z] [magic-context][ses_private700] historian prompt failed: read /Users/avery/Work/private-repo/.env API_KEY=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890 tool-output-secret",
        ),
        privacy.logLine(
            "[2026-09-05T10:41:04.130Z] [magic-context][ses_private700] historian: prompt attempt 2 failed: private provider message /home/avery/secret-orchard/password.txt",
        ),
        privacy.logLine(
            '[2026-09-05T10:41:05.130Z] [magic-context][ses_private700] historian failure: source=validation reason="sensitive tool output marker" chunkRange=12-18 fallbackModel=vertex-eu-google/gemini-3.8-flash twoPass=true',
        ),
        privacy.logLine(
            "[2026-09-05T10:41:06.130Z] [magic-context][ses_private700] CustomerPayrollError: private message body",
        ),
    ].join("\n");

    expect(output).toContain("historian prompt failed: <text omitted>");
    expect(output).toContain("historian: prompt attempt <text omitted> failed: <text omitted>");
    expect(output).toContain('historian failure: source=<text omitted> reason="<text omitted>"');
    expect(output).toContain("source=validation");
    expect(output).toContain("chunkRange=12-18");
    expect(output).toContain("fallbackModel=vertex-eu-google/gemini-3.8-flash");
    expect(output).toContain("twoPass=true");
    expect(output).toContain("~/path-");
    expect(output).not.toContain("private-repo");
    expect(output).not.toContain("secret-orchard");
    expect(output).not.toContain(".env");
    expect(output).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
    expect(output).not.toContain("tool-output-secret");
    expect(output).not.toContain("sensitive tool output marker");
    expect(output).not.toContain("CustomerPayrollError");
});

it("ties current log templates to source and pins historical Rust wording", () => {
    const sources = [
        {
            path: new URL(
                "../../../plugin/src/hooks/magic-context/compartment-runner-historian.ts",
                import.meta.url,
            ),
            fragments: [
                "historian prompt failed:",
                "historian: prompt attempt ",
                " failed:",
                "Historian failed while processing this session:",
                "Historian returned no assistant output.",
            ],
        },
        {
            path: new URL(
                "../../../plugin/src/hooks/magic-context/compartment-runner-incremental.ts",
                import.meta.url,
            ),
            fragments: [
                "historian failure: source=",
                ' reason="',
                '" chunkRange=',
                " fallbackModel=",
                " twoPass=",
                "historian post-publish step failed; publication stands:",
            ],
        },
    ];

    // Bundles may include logs from before the module rewrite. Keep their safe
    // template wording, but do not require the replacement module to emit it.
    const historicalRustFragments = [
        "mc-module: store open failed:",
        "mc-module: historian firing failed for ",
        ":",
    ];
    const sourceFragments = [
        ...sources.flatMap(({ fragments }) => fragments),
        ...historicalRustFragments,
    ];
    const configuredFragments = ISSUE_LOG_TEMPLATES.flatMap(({ parts }) => parts);
    expect([...configuredFragments].sort()).toEqual([...sourceFragments].sort());

    for (const { path, fragments } of sources) {
        const source = readFileSync(path, "utf8");
        for (const fragment of fragments) expect(source).toContain(fragment);
    }

    const privacy = new IssuePrivacy({});
    for (const template of ISSUE_LOG_TEMPLATES) {
        const message = template.exact
            ? template.parts[0]
            : `${template.parts
                  .join("SENSITIVE-INTERPOLATION")
                  .replace(
                      "fallbackModel=SENSITIVE-INTERPOLATION",
                      'fallbackModel="sensitive tool output"',
                  )} SENSITIVE-TAIL`;
        const line = privacy.logLine(
            `[2026-09-05T10:41:07.130Z] [magic-context][ses_private700] ${message}`,
        );
        for (const part of template.parts) expect(line).toContain(part);
        expect(line).not.toContain("SENSITIVE-INTERPOLATION");
        expect(line).not.toContain("SENSITIVE-TAIL");
    }
});

it("health check summaries retain configuration labels and measurements", () => {
    const privacy = new IssuePrivacy({});
    expect(privacy.healthMessage("Could not read OMP compaction.enabled")).toContain(
        "compaction.enabled",
    );
    expect(privacy.healthMessage("Could not read OMP memory.backend")).toContain("memory.backend");
    expect(
        privacy.healthMessage(
            "Shared storage: /Users/avery/private (source: environment override)",
        ),
    ).toContain("source=environment override");
    expect(
        privacy.healthMessage(
            "OMP runtime log read: /Users/avery/private.log (grammar=mixed, lines=7, 1 KB)",
        ),
    ).toContain("1 KB");
});
