import { afterEach, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "../../shared/sqlite";
import { closeDatabase, openDatabase, updateSessionMeta } from "./storage";
import {
    __resetWindowReportLedgerDiagnosticsForTests,
    appendWindowReport,
    buildWindowReport,
    captureWindowReport,
    getWindowReportLedgerDiagnostics,
    getWindowReportsPath,
    WINDOW_REPORTS_ROTATION_BYTES,
} from "./window-report-ledger";

const temporaryPaths: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;

afterEach(() => {
    closeDatabase();
    __resetWindowReportLedgerDiagnosticsForTests();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
    for (const temporaryPath of temporaryPaths.splice(0)) {
        rmSync(temporaryPath, { recursive: true, force: true });
    }
});

function useTemporaryDataHome(): void {
    const directory = mkdtempSync(join(tmpdir(), "mc-window-report-"));
    temporaryPaths.push(directory);
    process.env.XDG_DATA_HOME = directory;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = directory;
}

describe("window report ledger", () => {
    it("preserves only observed capture facts and records per-model largest success", () => {
        useTemporaryDataHome();
        const db = openDatabase();
        updateSessionMeta(db, "session-a", {
            lastObservedModelKey: "openrouter/anthropic/claude-sonnet-4-5",
            observedSafeInputTokens: 199_500,
        });

        const report = buildWindowReport({
            db,
            sessionID: "session-a",
            providerID: "openrouter",
            modelID: "anthropic/claude-sonnet-4-5",
            matchedPattern: "maximum context length is \\d+ tokens",
            reportedLimit: 200_000,
            reportedLimitProvenance: "combined",
            attemptedTokens: 214_311,
            error: { status: 400 },
            observedAtMs: 123,
        });

        expect(report).toEqual({
            provider_id: "openrouter",
            model_id: "anthropic/claude-sonnet-4-5",
            access_path: "api",
            status: 400,
            matched_pattern: "maximum context length is \\d+ tokens",
            extracted_limit: 200_000,
            extracted_limit_units: "provider",
            attempted_tokens: 214_311,
            attempted_tokens_units: "estimate",
            geometry: "combined",
            observed_at_ms: 123,
            largest_success: 199_500,
            largest_success_units: "estimate",
            path_may_forward: true,
            served_by_hint: "anthropic",
        });
    });

    it("keeps provider and routing fields absent when the capture site did not observe them", () => {
        useTemporaryDataHome();
        const report = buildWindowReport({
            db: openDatabase(),
            sessionID: "session-with-stale-model",
            matchedPattern: "prompt is too long",
            reportedLimitProvenance: "unknown",
            observedAtMs: 456,
        });

        expect(report).toEqual({
            access_path: "api",
            matched_pattern: "prompt is too long",
            geometry: "unknown",
            observed_at_ms: 456,
        });
        // Absent = unknown routing (refuses promotion); this reporter never
        // asserts false — see the schema pin in the ledger module.
        expect("path_may_forward" in report).toBe(false);
        expect("provider_id" in report).toBe(false);
        expect("model_id" in report).toBe(false);
        expect("served_by_hint" in report).toBe(false);
    });

    it("does not derive a served-by hint from a forwarding provider alone", () => {
        useTemporaryDataHome();
        const report = buildWindowReport({
            db: openDatabase(),
            providerID: "openrouter",
            modelID: "claude-sonnet-4-5",
            observedAtMs: 700,
        });

        expect(report.path_may_forward).toBe(true);
        expect("served_by_hint" in report).toBe(false);
    });

    it("marks only known forwarding providers and appends one JSON line", () => {
        useTemporaryDataHome();
        appendWindowReport({
            provider_id: "github-copilot",
            model_id: "gpt-5",
            access_path: "api",
            geometry: "prompt_only",
            observed_at_ms: 789,
            path_may_forward: true,
        });
        const lines = readFileSync(getWindowReportsPath(), "utf8").trim().split("\n");
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0] ?? "")).toMatchObject({
            provider_id: "github-copilot",
            path_may_forward: true,
        });
        expect(
            buildWindowReport({
                db: openDatabase(),
                providerID: "anthropic",
                modelID: "claude-sonnet-4-5",
                observedAtMs: 790,
            }),
        ).not.toHaveProperty("path_may_forward");
    });

    it("rotates only after the ledger exceeds 16 MiB", () => {
        useTemporaryDataHome();
        const reportPath = getWindowReportsPath();
        mkdirSync(reportPath.slice(0, reportPath.lastIndexOf("/")), { recursive: true });
        appendWindowReport({
            access_path: "api",
            geometry: "unknown",
            observed_at_ms: 1,
        });
        writeFileSync(reportPath, Buffer.alloc(WINDOW_REPORTS_ROTATION_BYTES));
        appendWindowReport({
            access_path: "api",
            geometry: "unknown",
            observed_at_ms: 2,
        });
        expect(existsSync(`${reportPath}.1`)).toBe(false);

        writeFileSync(reportPath, Buffer.alloc(WINDOW_REPORTS_ROTATION_BYTES + 1));
        appendWindowReport({
            access_path: "api",
            geometry: "unknown",
            observed_at_ms: 3,
        });
        expect(statSync(`${reportPath}.1`).size).toBe(WINDOW_REPORTS_ROTATION_BYTES + 1);
        expect(readFileSync(reportPath, "utf8")).toContain('"observed_at_ms":3');
    });

    it("swallows ledger write failures and records diagnostics", () => {
        const filePath = mkdtempSync(join(tmpdir(), "mc-window-report-file-"));
        temporaryPaths.push(filePath);
        process.env.XDG_DATA_HOME = join(filePath, "not-a-directory");
        writeFileSync(process.env.XDG_DATA_HOME, "file");

        expect(() =>
            captureWindowReport({
                db: {} as Database,
            }),
        ).not.toThrow();
        expect(getWindowReportLedgerDiagnostics().swallowedWriteCount).toBeGreaterThan(0);
    });
});
