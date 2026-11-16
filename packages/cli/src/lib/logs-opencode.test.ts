/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import type { DiagnosticReport } from "./diagnostics-opencode";
import {
    bundleIssueReport,
    extractHistorianFailureLines,
    sanitizeLogContent,
} from "./logs-opencode";

const tempDirs: string[] = [];

afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("sanitizeLogContent — secret token redaction (council finding #9)", () => {
    describe("Anthropic API keys", () => {
        it("redacts sk-ant-api03-* tokens", () => {
            const log =
                "Using key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCd to call API";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("<ANTHROPIC_API_KEY_REDACTED>");
            expect(sanitized).not.toContain("sk-ant-api03-AbCdEf");
        });

        it("redacts sk-ant-* legacy form", () => {
            const log = "key=sk-ant-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCd";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("<REDACTED:key>");
        });
    });

    describe("OpenAI API keys", () => {
        it("redacts sk-proj-* project keys", () => {
            const log = "OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
            const sanitized = sanitizeLogContent(log);
            // The env-var assignment redactor wins first (more specific
            // semantics — keeps the variable name visible). The specific
            // sk-proj- pattern won't trigger because the value is already
            // replaced with a key-typed redaction marker.
            expect(sanitized).toBe("OPENAI_API_KEY=<REDACTED:openai_api_key>");
        });

        it("redacts standalone sk-* tokens (legacy OpenAI shape)", () => {
            const log = "calling with sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABcd then continuing";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("<OPENAI_API_KEY_REDACTED>");
            expect(sanitized).not.toContain("sk-AbCdEfGhIjKlMn");
        });
    });

    describe("GitHub tokens", () => {
        it("redacts github_pat_* fine-grained PATs", () => {
            const log = "Sending github_pat_11ABCDEFG0_supersecrettokencharactershere to API";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("<GITHUB_PAT_REDACTED>");
            expect(sanitized).not.toContain("github_pat_11ABC");
        });

        it("redacts ghp_* (classic personal access)", () => {
            const log = "Authorization: token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("<GITHUB_TOKEN_REDACTED>");
            expect(sanitized).not.toContain("ghp_AbCd");
        });

        it("redacts gho_* (OAuth) and ghs_* (server-to-server) and ghu_* (user-to-server)", () => {
            const tokens = [
                "gho_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
                "ghs_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
                "ghu_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
                "ghr_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
            ];
            for (const token of tokens) {
                const sanitized = sanitizeLogContent(`Token: ${token}`);
                expect(sanitized).toContain("<GITHUB_TOKEN_REDACTED>");
                expect(sanitized).not.toContain(token.slice(0, 12));
            }
        });
    });

    describe("HuggingFace tokens", () => {
        it("redacts hf_* tokens", () => {
            const log = "HF_TOKEN=hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
            const sanitized = sanitizeLogContent(log);
            // env-var redactor wins (more semantic context preserved)
            expect(sanitized).toBe("HF_TOKEN=<REDACTED:hf_token>");
        });

        it("redacts standalone hf_* tokens not in assignment form", () => {
            const log = "Using model with hf_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 for download";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("<HUGGINGFACE_TOKEN_REDACTED>");
            expect(sanitized).not.toContain("hf_AbCd");
        });
    });

    describe("AWS credentials", () => {
        it("redacts AKIA access key IDs", () => {
            const log = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toBe("AWS_ACCESS_KEY_ID=<REDACTED:aws_access_key_id>");
        });

        it("redacts standalone AKIA in log narration", () => {
            const log = "Found credentials with id AKIAIOSFODNN7EXAMPLE in env";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("<AWS_ACCESS_KEY_ID_REDACTED>");
            expect(sanitized).not.toContain("AKIAIOSFODNN");
        });

        it("redacts ASIA temporary credentials", () => {
            const log = "Using temp creds ASIAIOSFODNN7EXAMPLE for STS";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("<AWS_ACCESS_KEY_ID_REDACTED>");
        });

        it("redacts AWS secret access keys in assignment context", () => {
            const log = "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("<REDACTED:aws_secret_access_key>");
            expect(sanitized).not.toContain("wJalrXUtnFEMI");
            // key name preserved
            expect(sanitized).toContain("aws_secret_access_key");
        });
    });

    describe("Slack tokens", () => {
        it("redacts xoxb (bot) tokens", () => {
            const log = "SLACK_BOT_TOKEN=xoxb-1234567890-abcdefghij-ABCDEFG12345";
            const sanitized = sanitizeLogContent(log);
            // env-var wins
            expect(sanitized).toBe("SLACK_BOT_TOKEN=<REDACTED:slack_bot_token>");
        });

        it("redacts standalone xoxp/xoxr/xoxs", () => {
            for (const prefix of ["xoxp", "xoxr", "xoxs", "xoxa"]) {
                const log = `using ${prefix}-1234567890-abcdefghij-ABCDEFG12345 for slack`;
                const sanitized = sanitizeLogContent(log);
                expect(sanitized).toContain("<SLACK_TOKEN_REDACTED>");
                expect(sanitized).not.toContain(`${prefix}-1234`);
            }
        });
    });

    describe("Google API keys", () => {
        it("redacts AIza* keys", () => {
            // Real Google API keys are 39 chars total (AIza + 35 char body).
            // Body counts: SyD-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456 = 35 chars.
            const log = "Calling Maps API with AIzaSyD-aBcDeFgHiJkLmNoPqRsTuVwXyZ01234 then done";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("<GOOGLE_API_KEY_REDACTED>");
            expect(sanitized).not.toContain("AIzaSyD-aB");
        });
    });

    describe("Generic env-var assignments", () => {
        it("redacts FOO_API_KEY=value", () => {
            const sanitized = sanitizeLogContent("MY_CUSTOM_API_KEY=abcdef12345");
            expect(sanitized).toBe("MY_CUSTOM_API_KEY=<REDACTED:my_custom_api_key>");
        });

        it("redacts BAR_TOKEN=value", () => {
            const sanitized = sanitizeLogContent("DATABASE_TOKEN=tokenvaluehere");
            expect(sanitized).toBe("DATABASE_TOKEN=<REDACTED:database_token>");
        });

        it("redacts BAZ_SECRET=value", () => {
            const sanitized = sanitizeLogContent("MY_SECRET=mysecretvalue");
            expect(sanitized).toBe("MY_SECRET=<REDACTED:my_secret>");
        });

        it("redacts QUX_PASSWORD=value", () => {
            const sanitized = sanitizeLogContent("DB_PASSWORD=hunter2");
            expect(sanitized).toBe("DB_PASSWORD=<REDACTED:db_password>");
        });

        it("redacts COMPOUND_CREDENTIAL=value", () => {
            const sanitized = sanitizeLogContent("AUTH_CREDENTIAL=abcdef");
            expect(sanitized).toBe("AUTH_CREDENTIAL=<REDACTED:auth_credential>");
        });

        it("redacts PRIVATE_KEY assignments", () => {
            const sanitized = sanitizeLogContent("MY_PRIVATE_KEY=mykey-data");
            expect(sanitized).toBe("MY_PRIVATE_KEY=<REDACTED:my_private_key>");
        });

        it("does NOT redact non-secret env vars", () => {
            const sanitized = sanitizeLogContent("OPENCODE_VERSION=1.4.0\nNODE_ENV=production");
            expect(sanitized).toContain("OPENCODE_VERSION=1.4.0");
            expect(sanitized).toContain("NODE_ENV=production");
        });
    });

    describe("JSON-style secret assignments", () => {
        it('redacts "api_key": "value"', () => {
            const log = '{"api_key": "abc123secret"}';
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain('"api_key": "<REDACTED:api_key>"');
            expect(sanitized).not.toContain("abc123secret");
        });

        it('redacts "access_token": "value"', () => {
            const log = '{"access_token": "supersecret"}';
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain('"access_token": "<REDACTED:access_token>"');
        });

        it('redacts "client_secret": "value"', () => {
            const log = '{"client_secret":"abc"}';
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain('"client_secret":"<REDACTED:client_secret>"');
        });

        it('redacts "password": "value" case-insensitively', () => {
            const log = '{"Password": "hunter2"}';
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain('"<REDACTED:password>"');
            expect(sanitized).not.toContain("hunter2");
        });
    });

    describe("Bearer tokens in HTTP headers", () => {
        it("redacts Authorization: Bearer * keeping the prefix", () => {
            const log = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.signature";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("Authorization:");
            expect(sanitized).toContain("Bearer");
            expect(sanitized).toContain("<REDACTED:bearer>");
            expect(sanitized).not.toContain("eyJhbGciOiJIUzI1NiJ9.signature");
        });

        it("handles case-insensitive header name", () => {
            const log = "authorization: bearer abcdefghij1234567890";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("<REDACTED:bearer>");
        });
    });

    describe("JWT tokens", () => {
        it("redacts a three-segment JWT", () => {
            const log =
                "Got JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.dozjgNryP4J3jVmNHl0w5N_XgL1JxXYbXvpvYTByA in response";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("<JWT_REDACTED>");
            expect(sanitized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
        });

        it("does not redact arbitrary base64 strings without JWT prefix", () => {
            const log = "computed digest: abcdefgh.ijklmnop.qrstuvwx";
            const sanitized = sanitizeLogContent(log);
            // No `eyJ` prefix → should not match JWT pattern
            expect(sanitized).toContain("abcdefgh.ijklmnop.qrstuvwx");
            expect(sanitized).not.toContain("<JWT_REDACTED>");
        });
    });

    describe("Path and username redaction (existing behavior preserved)", () => {
        it("still redacts /Users/<name>/ paths", () => {
            const sanitized = sanitizeLogContent("File at /Users/alice/code/file.ts");
            expect(sanitized).toContain("/Users/<USER>/");
            expect(sanitized).not.toContain("/Users/alice/");
        });

        it("still redacts /home/<name>/ paths on Linux-style logs", () => {
            const sanitized = sanitizeLogContent("File at /home/bob/code/file.ts");
            expect(sanitized).toContain("/home/<USER>/");
        });

        it("still redacts C:\\Users\\<name>\\ paths on Windows-style logs", () => {
            const sanitized = sanitizeLogContent("File at C:\\Users\\charlie\\code");
            expect(sanitized).toContain("C:\\Users\\<USER>\\");
        });
    });

    describe("Combined sanitization (paths + secrets)", () => {
        it("handles a realistic log line with both path and token", () => {
            const log =
                "[2026-04-28] /Users/alice/.config/opencode using sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYzZ12345678901234567890";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("/Users/<USER>/");
            expect(sanitized).toContain("<ANTHROPIC_API_KEY_REDACTED>");
            expect(sanitized).not.toContain("alice");
            expect(sanitized).not.toContain("sk-ant-api03-AbCd");
        });

        it("handles multiline log content", () => {
            const log = [
                "Loading config from /Users/alice/.config/cortexkit/magic-context.jsonc",
                "ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYzZ12345678901234567890",
                'Spawning subagent with {"api_key":"superdupersecret"}',
                "Done.",
            ].join("\n");
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("/Users/<USER>/");
            expect(sanitized).toContain("ANTHROPIC_API_KEY=<REDACTED:anthropic_api_key>");
            expect(sanitized).toContain('"api_key":"<REDACTED:api_key>"');
            expect(sanitized).toContain("Done.");
        });
    });

    describe("Empty/safe inputs", () => {
        it("returns empty string unchanged", () => {
            expect(sanitizeLogContent("")).toBe("");
        });

        it("returns plain text without secrets unchanged", () => {
            const log = "This is a normal log line with no secrets in it.";
            expect(sanitizeLogContent(log)).toBe(log);
        });

        it("does not over-redact a legitimate model name", () => {
            // Model identifiers like `anthropic/claude-haiku-4-5` should pass through
            const log = "Using model anthropic/claude-haiku-4-5 for historian";
            const sanitized = sanitizeLogContent(log);
            expect(sanitized).toContain("anthropic/claude-haiku-4-5");
        });
    });
});

describe("extractHistorianFailureLines", () => {
    it("matches historian messages in both log grammars", () => {
        const fleet =
            "2026-09-05T10:41:03.130Z WARN  magic-context tag=hist historian prompt failed: timeout retry=2";
        const legacy =
            "[2026-09-05T10:41:04.130Z] [magic-context][ses_abc] historian alert suppressed during cooldown";
        const unrelated =
            "2026-09-05T10:41:05.130Z INFO  magic-context transform complete historian_failure=false";

        expect(extractHistorianFailureLines([fleet, legacy, unrelated].join("\n"))).toEqual([
            fleet,
            legacy,
        ]);
    });
});

describe("bundleIssueReport secret redaction", () => {
    it("redacts secret-looking config keys before writing the issue bundle", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-issue-redaction-"));
        tempDirs.push(root);
        const originalCwd = process.cwd();
        process.chdir(root);
        try {
            const report: DiagnosticReport = {
                timestamp: "2026-05-11T12:00:00.000Z",
                platform: "darwin",
                arch: "arm64",
                nodeVersion: "v24.0.0",
                pluginVersion: "0.18.0",
                opencodeInstalled: true,
                opencodeVersion: "1.0.0",
                opencodeInstallKind: "cli",
                opencodeInstallations: [
                    {
                        path: join(root, "opencode"),
                        source: "PATH",
                        kind: "cli",
                        version: "1.0.0",
                        active: true,
                    },
                ],
                configPaths: {
                    configDir: join(root, ".config", "opencode"),
                    opencodeConfig: join(root, ".config", "opencode", "opencode.jsonc"),
                    opencodeConfigFormat: "jsonc",
                    magicContextConfig: join(root, ".config", "cortexkit", "magic-context.jsonc"),
                    tuiConfig: join(root, ".config", "opencode", "tui.jsonc"),
                    tuiConfigFormat: "jsonc",
                    omoConfig: null,
                },
                opencodeConfigHasPlugin: true,
                tuiConfigHasPlugin: true,
                magicContextConfig: {
                    exists: true,
                    flags: {
                        embedding: {
                            provider: "openai-compatible",
                            api_key: "emb-secret-value",
                            headers: {
                                Authorization: "Bearer header-secret-value",
                                "X-Api-Key": "custom-header-secret",
                            },
                        },
                        historian: { api_key: "historian-secret-value" },
                    },
                },
                pluginCache: { path: join(root, "cache") },
                storageDir: { path: join(root, "storage"), exists: true, contextDbSizeBytes: 0 },
                conflicts: {
                    hasConflict: false,
                    reasons: [],
                    compactionEnabled: true,
                    nativeCompaction: { auto: false, prune: false },
                },
                logFile: { path: join(root, "missing.log"), exists: false, sizeKb: 0 },
                recentSessions: { available: true, rows: [] },
                historianDumps: {
                    sessionDumps: {
                        dir: join(root, "dumps"),
                        count: 0,
                        sessionCount: 0,
                        sessions: [],
                    },
                    byProject: [],
                    legacyDumps: { dir: join(root, "dumps"), count: 0, recent: [] },
                },
                historianFailures: {
                    available: true,
                    rows: [
                        {
                            sessionId: "ses_1",
                            failureCount: 1,
                            lastError: "Authorization: Bearer historian-last-error-secret",
                            lastFailureAt: "2026-05-11T12:00:00.000Z",
                        },
                    ],
                },
                historianRuns: { available: true, rows: [] },
            };

            const bundled = await bundleIssueReport(report, "description", "title");
            expect(existsSync(bundled.path)).toBe(true);
            const body = readFileSync(bundled.path, "utf-8");

            expect(body).toContain('"api_key": "<REDACTED:api_key>"');
            expect(body).toContain('"Authorization": "<REDACTED:authorization>"');
            expect(body).toContain('"X-Api-Key": "<REDACTED:x-api-key>"');
            expect(body).not.toContain("emb-secret-value");
            expect(body).not.toContain("historian-secret-value");
            expect(body).not.toContain("header-secret-value");
            expect(body).not.toContain("custom-header-secret");
            expect(body).not.toContain("historian-last-error-secret");
            expect(body).not.toContain("### OpenCode installations");
            expect(body).toContain("- OpenCode installed: true [cli] (1.0.0)");
            expect(body).toContain("No historian runs recorded.");

            report.historianRuns = { available: false, reason: "schema too old" };
            report.historianFailures = { available: false, reason: "query error" };
            report.recentSessions = { available: false, reason: "path missing" };
            const unavailable = await bundleIssueReport(report, "description", "unavailable");
            const unavailableBody = readFileSync(unavailable.path, "utf-8");
            expect(unavailableBody).toContain("Historian runs: unavailable (schema too old)");
            expect(unavailableBody).toContain("Historian failures: unavailable (query error)");
            expect(unavailableBody).toContain("Recent sessions: unavailable (path missing)");
            expect(unavailableBody).not.toContain("No historian runs recorded");
        } finally {
            process.chdir(originalCwd);
        }
    });

    it("keeps user-entered title and description while sanitizing private report fields", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-issue-sanitize-"));
        tempDirs.push(root);
        const originalCwd = process.cwd();
        process.chdir(root);
        try {
            const report: DiagnosticReport = {
                timestamp: "2026-05-11T12:00:00.000Z",
                platform: "darwin",
                arch: "arm64",
                nodeVersion: "v24.0.0",
                pluginVersion: "0.18.0",
                opencodeInstalled: true,
                opencodeVersion: "1.0.0",
                opencodeInstallKind: "cli",
                opencodeInstallations: [
                    {
                        path: "/Users/alice/.opencode/bin/opencode",
                        source: "PATH",
                        kind: "cli",
                        version: "1.18.0",
                        active: true,
                    },
                    {
                        path: "/Users/alice/Applications/OpenCode.app",
                        source: "app",
                        kind: "desktop",
                        version: "unknown",
                        active: false,
                    },
                ],
                configPaths: {
                    configDir: "/Users/alice/.config/opencode",
                    opencodeConfig: "/Users/alice/.config/opencode/opencode.jsonc",
                    opencodeConfigFormat: "jsonc",
                    magicContextConfig: "/Users/alice/.config/cortexkit/magic-context.jsonc",
                    tuiConfig: "/Users/alice/.config/opencode/tui.jsonc",
                    tuiConfigFormat: "jsonc",
                    omoConfig: null,
                },
                opencodeConfigHasPlugin: true,
                tuiConfigHasPlugin: true,
                magicContextConfig: {
                    exists: true,
                    flags: {},
                },
                pluginCache: { path: join(root, "cache") },
                storageDir: { path: join(root, "storage"), exists: true, contextDbSizeBytes: 0 },
                conflicts: {
                    hasConflict: false,
                    reasons: [],
                    compactionEnabled: true,
                    nativeCompaction: { auto: false, prune: false },
                },
                logFile: { path: join(root, "missing.log"), exists: false, sizeKb: 0 },
                recentSessions: {
                    available: true,
                    rows: [
                        {
                            sessionId: "ses_1",
                            title: "Problem at /Users/alice/private token=abc123",
                            directory: "/Users/alice/project",
                            lastActiveAt: "2026-05-11T12:00:00.000Z",
                        },
                    ],
                },
                historianDumps: {
                    sessionDumps: {
                        dir: join(root, "dumps"),
                        count: 0,
                        sessionCount: 0,
                        sessions: [],
                    },
                    byProject: [],
                    legacyDumps: { dir: join(root, "dumps"), count: 0, recent: [] },
                },
                historianFailures: { available: true, rows: [] },
                historianRuns: { available: true, rows: [] },
            };

            const bundled = await bundleIssueReport(
                report,
                "The issue happens after restart. Reproduction: run the command twice.",
                "Repeated command loses its tool result",
            );
            const body = readFileSync(bundled.path, "utf-8");

            expect(body).toContain("## Title");
            expect(body).toContain("## Title\nRepeated command loses its tool result");
            expect(body).toContain(
                "## Description\nThe issue happens after restart. Reproduction: run the command twice.",
            );
            expect(body).toContain("Config from `~/path-5`:");
            expect(body).toContain('"title": "<text omitted>"');
            expect(body).toContain('"directory": "~/project-1"');
            expect(body).toContain("### OpenCode installations");
            expect(body).toContain("| [active] | `~/path-1` | 1.18.0 | PATH |");
            expect(body).toContain("|  | `~/path-2` | unknown | app |");
            expect(body).not.toContain("alice");
            expect(body).not.toContain("abc123");
        } finally {
            process.chdir(originalCwd);
        }
    });
});

describe("bundleIssueReport size and session fallbacks", () => {
    it("writes the full sanitized bundle beside the capped body and records child linkage", async () => {
        const root = createTestTempDirFromPath(join(tmpdir(), "mc-issue-full-bundle-"));
        tempDirs.push(root);
        const logPath = join(root, "opencode.log");
        writeFileSync(
            logPath,
            Array.from(
                { length: 400 },
                (_, index) =>
                    `2026-09-05T10:41:03.130Z INFO  magic-context.perf: count=${index} tokens=${"9".repeat(400)}`,
            ).join("\n"),
        );
        const report: DiagnosticReport = {
            timestamp: "2026-05-11T12:00:00.000Z",
            platform: "darwin",
            arch: "arm64",
            nodeVersion: "v24.0.0",
            pluginVersion: "0.39.0",
            opencodeInstalled: true,
            opencodeVersion: "1.0.0",
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
            logFile: { path: logPath, exists: true, sizeKb: 200 },
            recentSessions: {
                available: true,
                rows: [
                    {
                        sessionId: "ses_parent001",
                        title: "Parent session",
                        directory: root,
                        lastActiveAt: "2026-05-11T12:00:00.000Z",
                        parentSessionId: null,
                    },
                    {
                        sessionId: "ses_child001",
                        title: "Child session",
                        directory: root,
                        lastActiveAt: "2026-05-11T12:01:00.000Z",
                        parentSessionId: "ses_parent001",
                    },
                ],
            },
            historianDumps: {
                sessionDumps: { dir: root, count: 0, sessionCount: 0, sessions: [] },
                byProject: [],
                legacyDumps: { dir: root, count: 0, recent: [] },
            },
            historianFailures: { available: true, rows: [] },
            historianRuns: { available: true, rows: [] },
        };
        const originalCwd = process.cwd();
        process.chdir(root);
        try {
            const bundled = await bundleIssueReport(
                report,
                "child report",
                "diagnostic issue",
                "ses_child001",
            );
            expect(bundled.truncated).toBe(true);
            expect(bundled.fullPath).toBeDefined();
            if (!bundled.fullPath) throw new Error("expected full fallback path");
            expect(existsSync(bundled.fullPath)).toBe(true);
            expect(Buffer.byteLength(bundled.bodyMarkdown, "utf8")).toBeLessThanOrEqual(60_000);
            expect(readFileSync(bundled.fullPath, "utf8")).toContain("## Session context");
            expect(readFileSync(bundled.fullPath, "utf8")).toContain("- Parent session: session-1");
            expect(readFileSync(bundled.fullPath, "utf8")).not.toContain("ses_parent001");
            expect(readFileSync(bundled.fullPath, "utf8")).not.toContain(root);
        } finally {
            process.chdir(originalCwd);
        }
    });
});
