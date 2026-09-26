import { describe, expect, test } from "bun:test";
import type { StatusDetail } from "./rpc-types";
import { formatStatusDetailMarkdown } from "./status-detail-text";

const STATUS_FIXTURE: StatusDetail = {
    sessionId: "ses_status",
    activeProfile: "work",
    usagePercentage: 75,
    inputTokens: 96_000,
    contextLimit: 128_000,
    systemPromptTokens: 4_000,
    compartmentCount: 12,
    memoryCount: 8,
    memoryBlockCount: 3,
    memoryImportanceHistogram: {
        total: 7_986,
        unclassified: 1_181,
        bands: {
            "0-19": 101,
            "20-39": 202,
            "40-59": 6_303,
            "60-79": 707,
            "80-100": 673,
        },
    },
    pendingOpsCount: 2,
    historianRunning: true,
    compartmentInProgress: true,
    sessionNoteCount: 1,
    readySmartNoteCount: 2,
    cacheTtl: "1h",
    cacheTtlSource: "config",
    cacheTtlModelKey: "anthropic/claude-opus-5",
    lastTransformError: null,
    historianFailureCount: 0,
    lastDreamerRunAt: null,
    projectIdentity: "/repo",
    compartmentTokens: 22_000,
    factTokens: 0,
    memoryTokens: 1_200,
    docsTokens: 500,
    profileTokens: 100,
    conversationTokens: 62_000,
    toolCallTokens: 3_000,
    toolDefinitionTokens: 3_200,
    executeThreshold: 65,
    executeThresholdClamped: false,
    boundaryPresent: true,
    coverageOrdinal: 12,
    newWorkTokens: 1_000,
    totalInputTokens: 96_000,
    recompProgress: null,
    tagCounter: 5,
    activeTags: 4,
    droppedTags: 1,
    totalTags: 5,
    activeBytes: 2_048,
    lastResponseTime: 1,
    lastNudgeTokens: 80_000,
    pendingOps: [],
    cacheTtlMs: 300_000,
    cacheRemainingMs: 42_000,
    cacheExpired: false,
    cacheNeverExpires: false,
    executeThresholdMode: "percentage",
    protectedTagCount: 20,
    historyBudgetPercentage: 0.15,
    historyBlockTokens: 22_000,
    compressionBudget: 12_480,
    compressionUsage: "176%",
    toastDurationMs: 5_000,
    loggerDiagnostics: {
        swallowedWriteCount: 0,
        lastErrorMessage: null,
        lastErrorTime: null,
    },
    tailHygiene: {
        u: 14_400,
        t: 48_000,
        severity: 0.3,
        evaluable: true,
        generationInvalidated: false,
        baselineGeneration: 3,
        computedAt: 1_730_000_000_000,
        reclaimableToolOutputCount: 3,
    },
    embedding: {
        state: "running",
        indexed: 9,
        total: 12,
    },
    storage_versions: {
        context_db_schema_version: 79,
        plugin_supported_version: 79,
    },
};

describe("status detail text", () => {
    test("renders the OpenCode summary golden", () => {
        expect(formatStatusDetailMarkdown(STATUS_FIXTURE)).toBe(`## Magic Context Status

- **Context:** 75.0% of usable context (96,000 / 128,000 tokens)
- **Cache lifetime:** 1h (config for anthropic/claude-opus-5)
- **Automatic compression:** at 65.0% of usable context
- **History compression:** Compressing history · 12 history blocks
- **Reclaimable:** 3 spent tool outputs (~14k tokens)
- **Memory:** 8 memories · 3 notes
- **Search indexing:** Running · 9 / 12 history blocks indexed`);
    });

    test("renders disabled automatic compression and an empty reclaimable set without a gauge", () => {
        const rendered = formatStatusDetailMarkdown({
            ...STATUS_FIXTURE,
            compaction_enabled: false,
            tailHygiene: {
                ...STATUS_FIXTURE.tailHygiene!,
                u: 0,
                reclaimableToolOutputCount: 0,
            },
        });
        expect(rendered).toContain("- **Automatic compression:** Off");
        expect(rendered).toContain("- **Reclaimable:** none");
        expect(rendered).not.toContain("Reclaimable: 0");
    });

    test("surfaces a failing scheduled dreamer task in the summary", () => {
        // The whole point: a task failing on every slot must not be visible only as a
        // backlog count that never falls.
        const detail: StatusDetail = {
            ...STATUS_FIXTURE,
            dreamerFailures: [
                {
                    task: "classify-memories",
                    error: "Rust classify module failed: producer session busy",
                    lastSucceededAt: Date.now() - 6 * 24 * 3_600_000,
                    retryCount: 3,
                },
            ],
        };
        const summary = formatStatusDetailMarkdown(detail);
        expect(summary).toContain("A background maintenance task keeps failing");
        expect(summary).toContain("MC-S05");
    });

    test("says nothing about the dreamer while every scheduled task is healthy", () => {
        expect(
            formatStatusDetailMarkdown({ ...STATUS_FIXTURE, dreamerFailures: [] }),
        ).not.toContain("MC-S05");
    });

    test("keeps internal vocabulary and identifiers out of the summary", () => {
        const summary = formatStatusDetailMarkdown({
            ...STATUS_FIXTURE,
            sessionId: "session-secret",
            projectIdentity: "/Users/example/secret-project",
            hostBackendsModuleSide: true,
            lastTransformError: "facade MODULE drain failed in mc-store /tmp/private",
            historianFailureCount: 2,
        });
        for (const forbidden of [
            "session-secret",
            "/Users/",
            "tag counter",
            "protection",
            "formula",
            "MODULE",
            "mc-store",
            "harness",
            "compartment",
            "facade",
            "changefeed",
            "drain",
        ]) {
            expect(summary.toLowerCase()).not.toContain(forbidden.toLowerCase());
        }
        expect(summary).toContain("(MC-S02)");
        expect(summary).toContain("(MC-H01)");
    });

    test("shows stalled mirror and authority mismatch codes in the summary", () => {
        const detail = {
            ...STATUS_FIXTURE,
            hostBackendsModuleSide: true,
            memoryMirror: {
                cursor: 3726,
                cursorUpdatedAt: 1,
                cursorAgeMs: 40_000,
                liveRows: 275,
                feedHead: 4850,
                pendingRows: 1124,
                stalled: true,
                code: "MC-M01" as const,
            },
            memoryAuthorityMismatch: true,
        };
        const summary = formatStatusDetailMarkdown(detail);

        expect(summary).toContain("(MC-M01)");
        expect(summary).toContain("(MC-M02)");
    });

    test("renders historian refusal stage and received runner text", () => {
        const detail =
            "historian refusal stage=credential provider=google model=google/model-a received=\"open_failed: no apikey credential for provider 'google'\"";
        const status = formatStatusDetailMarkdown({
            ...STATUS_FIXTURE,
            historianRefusal: {
                stage: "credential",
                canonicalCause: "credential_unavailable",
                detail,
            },
        });

        expect(status).toContain("Historian refusal:** credential (credential_unavailable)");
        expect(status).toContain(
            "received=\"open_failed: no apikey credential for provider 'google'\"",
        );
    });

    test("says which runner ran the session's completions and why", () => {
        const status = formatStatusDetailMarkdown({
            ...STATUS_FIXTURE,
            historianRunner: {
                runner: "host",
                source: "default_for_harness",
                harness: "opencode",
                observed: "last_completion",
            },
            dreamerRunner: {
                runner: "broca",
                source: "configured",
                harness: "opencode",
                observed: "resolved_for_route",
            },
        });

        expect(status).toMatch(
            /^- \*\*Historian runner:\*\* host \(default for harness opencode\)$/m,
        );
        expect(status).toContain("- **Dreamer runner:** broca (configured) · no completion yet");
    });

    test("does not expose module routing in the summary", () => {
        const rustStatus = formatStatusDetailMarkdown({
            ...STATUS_FIXTURE,
            hostBackendsModuleSide: true,
        });
        expect(rustStatus).not.toContain("MODULE");
        expect(rustStatus).not.toContain("mc-store");
    });
});
