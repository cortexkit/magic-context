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
    pendingOpsCount: 2,
    historianRunning: true,
    compartmentInProgress: true,
    sessionNoteCount: 1,
    readySmartNoteCount: 2,
    cacheTtl: "5m",
    lastTransformError: null,
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
    storage_versions: {
        context_db_schema_version: 79,
        plugin_supported_version: 79,
    },
};

describe("formatStatusDetailMarkdown", () => {
    test("renders the fixed TUI status payload as compact markdown", () => {
        expect(formatStatusDetailMarkdown(STATUS_FIXTURE)).toBe(`## Magic Context Status

- **Mode:** Magic Context compaction
- **Active profile:** work
- **Usage:** 75.0% (96,000 / 128,000 usable tokens)
- **Cache lane:** live (42s remaining); TTL 5m
- **Historian:** running; boundary present; coverage 12
- **Memory:** 8 active; 3 injected
- **Tags:** 4 active, 1 dropped; 2 pending drops
- **Execute threshold:** 65.0%`);
    });
});
