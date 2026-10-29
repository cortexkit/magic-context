import { setTimeout as delay } from "node:timers/promises";
import { loadPluginConfigDetailed } from "../../config";
import { isCompactionEnabled, isSmartNoteSurfaceAvailable } from "../../config/agent-disable";
import { logConfigDependencyNotesOnce } from "../../config/dependency-notes";
import { withLiveDreamerOutputCap } from "../../config/live-child-output-cap";
import {
    dreamerRunConfig,
    historianRunConfig,
    pluginConfigReader,
} from "../../config/live-run-config";
import { getProtectedTokensTierOverrides } from "../../config/project-security";
import { summarizeManualDream } from "../../features/magic-context/dreamer/manual-summary";
import {
    userObservationCollectionEnabled,
    userObservationsRequested,
} from "../../features/magic-context/dreamer/task-config";
import { formatUnsupportedDreamTasks } from "../../features/magic-context/dreamer/task-registry";
import {
    type FailClosedReason,
    formatFailClosedBlockingMessage,
    formatFailClosedBlockingSummary,
    isFailClosedBlockingError,
} from "../../features/magic-context/fail-closed-block";
import {
    resolveProjectIdentityForSession,
    setHomeProjectPermission,
} from "../../features/magic-context/memory/project-identity";
import { scheduleClearAndReindex } from "../../features/magic-context/message-index-async";
import { detectOverflow } from "../../features/magic-context/overflow-detection";
import { createScheduler } from "../../features/magic-context/scheduler";
import { backfillSessionActivity } from "../../features/magic-context/session-activity";
import {
    getOrCreateSessionMeta,
    getOverflowState,
    isDatabasePersisted,
    markSessionCleanupPending,
    type openDatabase,
    recordDetectedContextLimit,
    recordOverflowDetected,
} from "../../features/magic-context/storage";
import { getPersistedCompactionMarkerState } from "../../features/magic-context/storage-meta-persisted";
import { clearSession } from "../../features/magic-context/storage-meta-session";
import { clearCachedM0 } from "../../features/magic-context/storage-meta-shared";
import { rebaseSessionCoordinatesAsync } from "../../features/magic-context/store-generation-rebase";
import { createTagger } from "../../features/magic-context/tagger";
import {
    getCurrentToolSetHash,
    recordToolDefinitionSet,
} from "../../features/magic-context/tool-definition-tokens";
import { stageOpenCodeV2TransformDecision } from "../../features/magic-context/transform-decision-log";
import {
    type HiddenCompletionExecutor,
    HiddenCompletionRefusal,
} from "../../hooks/magic-context/compartment-runner-types";
import { resolveCtxReduceAvailabilityFromMessages } from "../../hooks/magic-context/ctx-reduce-availability";
import { DegradedPassRefusalError } from "../../hooks/magic-context/degraded-pass-refusal";
import {
    deriveHistorianChunkTokens,
    resolveHistorianContextLimit,
    resolveKnownHistorianContextLimit,
} from "../../hooks/magic-context/derive-budgets";
import {
    assertExecutableToolInput,
    createDroppedInputGuard,
    recordToolParameters,
} from "../../hooks/magic-context/dropped-input-guard";
import { clearEmbedSessionState } from "../../hooks/magic-context/embed-session-state";
import { EmergencyFailClosedError } from "../../hooks/magic-context/emergency-fail-closed";
import { resolveContextLimit, resolveModelKey } from "../../hooks/magic-context/event-resolvers";
import { estimateFinalWireInputTokens } from "../../hooks/magic-context/final-wire-token-estimate";
import {
    type HistoryBoundaryRepair,
    repairMissingHistoryBoundary,
} from "../../hooks/magic-context/history-boundary-repair";
import {
    createChatMessageHook,
    createToolExecuteAfterHook,
} from "../../hooks/magic-context/hook-handlers";
import { markCoveredInstructionRow } from "../../hooks/magic-context/host-served-rows";
import { materializeM0 } from "../../hooks/magic-context/inject-compartments";
import { armLatestThinkingRecoveryFromError } from "../../hooks/magic-context/latest-thinking-recovery";
import {
    beginV2LkgRequest,
    clearLkgMeasuredRequest,
    lkgProviderInputTotal,
    noteLkgProviderResponse,
} from "../../hooks/magic-context/lkg-measured-request";
import { lkgReplayLimit, measureLkgReplay } from "../../hooks/magic-context/lkg-replay-fit";
import { getSlot } from "../../hooks/magic-context/lkg-slot";
import { createModuleToolBackends } from "../../hooks/magic-context/module-tool-backends";
import { resolveOpenCodeProtectedTailBoundary } from "../../hooks/magic-context/protected-tail-boundary";
import { setBoundedRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import {
    estimateTokens,
    preloadTokenizer,
} from "../../hooks/magic-context/read-session-formatting";
import { createM0RenderOptions } from "../../hooks/magic-context/render-options";
import { servedModuleM0Text } from "../../hooks/magic-context/rust-served-m0";
import {
    STORAGE_BUSY_MESSAGE,
    StorageBusyRefusalError,
} from "../../hooks/magic-context/storage-busy-refusal";
import { retirePendingSystemPromptDelivery } from "../../hooks/magic-context/system-prompt-delivery";
import { createSystemPromptHashHandler } from "../../hooks/magic-context/system-prompt-hash";
import { createTransform, type TransformDeps } from "../../hooks/magic-context/transform";
import { UnmanagedOverWindowError } from "../../hooks/magic-context/unmanaged-over-window";
import { UnresolvedHistoryBoundaryError } from "../../hooks/magic-context/unresolved-history-boundary";
import { scheduleAfterBootQuiet } from "../../plugin/boot-quiet";
import { createDreamTimerModuleClient } from "../../plugin/dream-timer-module-client";
import {
    createMessagesTransformHandler,
    tryMessagesTransformLkgReplay,
} from "../../plugin/messages-transform";
import { registerRpcHandlers } from "../../plugin/rpc-handlers";
import {
    hideSubagentTools,
    removePrimaryOnlyTools,
    storedSubagentMode,
} from "../../plugin/subagent-tool-policy";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { detectConflicts } from "../../shared/conflict-detector";
import { getDataDir, getMagicContextStorageDir } from "../../shared/data-path";
import { getErrorMessage } from "../../shared/error-message";
import { log, sessionLog } from "../../shared/logger";
import { resolveHistorianModel } from "../../shared/model-resolution";
import {
    isSaneLimit,
    refreshModelLimitsFromApi,
    resolveLimit,
    setOutputReserveConfig,
} from "../../shared/models-dev-cache";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import {
    ACTIVE_TOOL_IDS,
    createPromptSurfaceRuntime,
    type PromptSurfaceRuntime,
} from "../../shared/prompt-surface-runtime";
import { pushNotification } from "../../shared/rpc-notifications";
import { MagicContextRpcServer } from "../../shared/rpc-server";
import {
    type Database,
    isTransientSqliteError,
    withAsyncPrivilegedWriter,
    withoutSqliteTransformPass,
    withSqliteTransformPass,
} from "../../shared/sqlite";
import { renderUserFacingFailure, userFacingFailureCode } from "../../shared/user-facing-codes";
import { CTX_NOTE_DESCRIPTION, withoutSmartNoteText } from "../../tools/ctx-note/constants";
import { CTX_NOTE_LIGHT_DESCRIPTION } from "../../tools/light-descriptions";
import { applyJsonSchemaParameterDescriptions } from "../../tools/parameter-descriptions";
import { createV2RustCompactionMarkerStrategy, trimToRecordedBoundary } from "../fold/boundary";
import { hostMediaAsset, hostUsesMediaAssets, rememberHostMedia } from "../fold/host-media";
import { v2CompactionMarkerStrategy } from "../fold/markers";
import { nativeFoldCache } from "../fold/memory-cache";
import {
    copyNativeInput,
    forgetNativeFoldProvenance,
    isLocalCheckpoint,
    NativeFoldReplay,
    nativeRowID,
} from "../fold/native-replay";
import { FoldOwner } from "../fold/owner";
import { HostFoldPolicy } from "../fold/policy";
import { restoreRow } from "../fold/restore";
import { seedV2ForkFromParent, sessionHasMagicContextState } from "../fork-inheritance";
import { cleanupLegacyHiddenChildren } from "../hidden-child-cleanup";
import { nativeSessionRemove } from "../hidden-child-native";
import {
    createLateHiddenExecutor,
    createV2HiddenCompletionExecutor,
    type V2HiddenCompletionExecutor,
} from "../hidden-completion";
import { HiddenModelActivity } from "../hidden-model-activity";
import { V2MessageTimesCache } from "../message-times";
import { gaDatabasePath, type V2StoreReader, V2StoreReaderPool } from "../store-reader";
import {
    clearSyntheticCandidates,
    deliverPendingChannel2,
    deliverSynthetic,
    isAdmittedSynthetic,
    syntheticCandidates,
} from "./channel2";
import { registerV2Commands } from "./commands";
import { stripCopiedTagNotation } from "./copied-tag-notation";
import { DeletedSessionTombstones } from "./deleted-session-tombstones";
import { resolveManualDreamTask, runManualDreamNow } from "./dream-manual";
import { registerV2DreamScheduleTimer } from "./dream-timer";
import { startDreamTrigger } from "./dream-trigger";
import { createV2EmbeddingScope } from "./embedding-lifecycle";
import { generateReplayAnchor, V2GenerateReplay } from "./generate";
import { HiddenChildHook, hiddenToolCallRefusal, registerHiddenChildAgents } from "./hidden-child";
import { hiddenTerminalError } from "./hidden-terminal-error";
import { type V2LkgCheckpointHead, type V2LkgHostInput, V2LkgSystemReplay } from "./lkg-system";
import { modelLimitCacheWarm, warmModelLimitCacheFromCatalog } from "./model-limit-cache";
import { adaptPayload, HEAD_IDS } from "./payload";
import { interruptBeforeProvider, V2ContextRefusal } from "./refusal";
import { RestoredRowCache } from "./restore-rows";
import { createV2RpcLiveSessionState } from "./rpc-live-state";
import { createV2RustRefusalRecovery, resolveV2RustModeModuleClient } from "./rust-mode";
import { hasRequiredSessionAPI, OPENCODE2_SESSION_API_NOTICE } from "./session-api-gate";
import { runV2SessionProjectBackfill } from "./session-project-backfill";
import { createV2StorageGate, probeV2StorageAtBoot } from "./storage-gate";
import {
    dropStorageNotices,
    formatStorageRecoveryNotice,
    formatStorageRefusalNotice,
    hasStorageNoticeShape,
    STORAGE_NOTICE_PREFIX,
} from "./storage-notice";
import {
    createV2RawMessageProvider,
    createV2RawMessageReader,
    readAllV2RawMessagesForConversion,
    readV2RawMessagePagesForConversion,
    resolveV2BoundaryUserMessage,
    servedBoundaryRow,
} from "./store";
import { bindV2SystemPromptResponse } from "./system-prompt-response";
import { registerTools } from "./tools";
import { bindV2TransformDecision } from "./transform-decision-binding";
import { createV2AutoEmbedSession, createV2TransformFeatureDeps } from "./transform-features";
import type { SessionContext, V2Context, V2Message } from "./types";
import { persistV2UsageReading } from "./usage-persist";
import { resolveUsageReading } from "./usage-reading";

class V2LkgAdmissionReplay extends Error {}

/**
 * After a host fold the request starts with the host's checkpoint message in
 * place of the history head message (m[0]): the summary inside the checkpoint
 * is replaced by the head's text, and the head's other parts move to the
 * second head message. Returns whether it applied; it needs the head message
 * in the draft. `head.checkpoint` is used as the served message.
 */
function applyCheckpointHead(draft: SessionContext, head: V2LkgCheckpointHead): boolean {
    const { checkpoint, submitted } = head;
    const first = draft.messages.find((message) => message.id === HEAD_IDS[0]);
    const baseline = first?.content.find((part) => part.type === "text")?.text;
    if (typeof baseline !== "string") return false;
    for (const part of checkpoint.content)
        if (part.type === "text" && typeof part.text === "string") {
            part.text = part.text.replace(
                `<summary>\n${submitted}\n</summary>`,
                `<summary>\n${baseline}\n</summary>`,
            );
        }
    const volatile = draft.messages.find((message) => message.id === HEAD_IDS[1]);
    if (volatile && first)
        volatile.content.push(...first.content.filter((part) => part.type !== "text"));
    draft.messages.splice(
        0,
        draft.messages.length,
        checkpoint,
        ...draft.messages.filter((message) => message !== first),
    );
    return true;
}

// The event stream can trail the terminal store row by a scheduler tick; keep failure surfacing fast.
const HIDDEN_SESSION_ERROR_GRACE_MS = 50;
/**
 * How long the disposer waits for cancelled hidden runs to release the store
 * reader pool. Short, because OpenCode holds every session's new turns while a
 * plugin reloads.
 */
const STORE_POOL_DISPOSE_WAIT_MS = 1_000;

export function isBlockingV2TransformError(error: unknown): boolean {
    return (
        error instanceof EmergencyFailClosedError ||
        error instanceof UnresolvedHistoryBoundaryError ||
        error instanceof UnmanagedOverWindowError ||
        error instanceof DegradedPassRefusalError ||
        isFailClosedBlockingError(error)
    );
}

/**
 * Check the history boundary against the host store before a pass restores or
 * trims against it, and re-anchor it when the store proves it gone. Absence is
 * proven only by the store answering "no such row" for a session it holds rows
 * for; a session the store has no rows for proves nothing. A failed check never
 * blocks the turn: the pass goes on as before, and the request-size guard in
 * the transform still stops an untrimmed request that would not fit.
 */
export function checkHistoryBoundary(
    db: Database,
    reader: Pick<V2StoreReader, "earliestSequence" | "sequenceForId">,
    sessionID: string,
): HistoryBoundaryRepair | undefined {
    try {
        const storeHasSession = reader.earliestSequence(sessionID) !== undefined;
        return repairMissingHistoryBoundary({
            db,
            sessionId: sessionID,
            isInHostStore: (messageId) =>
                storeHasSession ? reader.sequenceForId(sessionID, messageId) !== undefined : null,
        });
    } catch (error) {
        sessionLog(sessionID, "history boundary check failed; continuing without repair", error);
        return undefined;
    }
}

/**
 * Cache the directory the host bound a session to, looked up once per session.
 *
 * On OpenCode 1 the shared transform asks the SDK client for this and records
 * the session-to-project binding (`session_projects`) only when the host
 * answered. OpenCode 2 gives plugins no SDK client, so without this lookup the
 * transform always fell back to the launch directory, never recorded a binding,
 * and the Dashboard found no project for any OpenCode 2 session. The session's
 * directory is fixed at creation, so one successful answer is kept for the
 * session's lifetime; a failed lookup is retried on the next pass.
 */
export async function cacheV2SessionDirectory(
    session: Pick<V2Context["session"], "get">,
    sessionID: string,
    directories: Map<string, string>,
): Promise<void> {
    if (directories.has(sessionID)) return;
    try {
        const directory = (await session.get({ sessionID }))?.location?.directory;
        if (typeof directory === "string" && directory.length > 0) {
            directories.set(sessionID, directory);
        }
    } catch (error) {
        sessionLog(
            sessionID,
            "v2 session directory lookup failed; using the launch directory:",
            error,
        );
    }
}

/**
 * Every pre-provider refusal on OpenCode 2 ends the turn with `session.interrupt`, which
 * the host records as a bare `outcome: "interrupted"` row: no error text reaches the
 * transcript, and under `opencode service` the server's stderr goes nowhere. The only
 * durable record of why a turn died is this log line, so it is written before the
 * interrupt is attempted.
 */
function refuseBeforeProvider(
    session: Pick<V2Context["session"], "interrupt">,
    sessionID: SessionContext["sessionID"],
    arm: string,
    cause?: unknown,
): Promise<void> {
    const detail =
        cause instanceof Error
            ? `${cause.name}: ${cause.message}`
            : cause === undefined
              ? ""
              : String(cause);
    sessionLog(
        sessionID,
        `v2 refusal: interrupting the turn before the provider request arm=${arm}${detail ? ` cause=${JSON.stringify(detail.slice(0, 500))}` : ""}`,
    );
    return interruptBeforeProvider(session, sessionID);
}

export function createHostSeams(
    context: V2Context,
    readAllForConversion: TransformDeps["hostRawMessages"] & {},
    reconciliationSource: NonNullable<TransformDeps["hostMessageReconciliationSource"]>,
    liveModels: NonNullable<TransformDeps["liveModelBySession"]>,
): Required<
    Pick<
        TransformDeps,
        | "hostRawMessages"
        | "hostMessageReconciliationSource"
        | "hostPrepareRawOrdinals"
        | "hostProtectedTailBoundary"
        | "hostModelFallback"
        | "getModelKey"
        | "hostRefusalNotice"
        | "hostRefuse"
    >
> {
    return {
        hostRawMessages: readAllForConversion,
        hostMessageReconciliationSource: reconciliationSource,
        // The OpenCode 2 reader already knows each message's position in the
        // session. The default warm-up indexes OpenCode 1's SQLite database,
        // which is a different store and cannot prepare this reader's messages.
        hostPrepareRawOrdinals: async () => true,
        hostProtectedTailBoundary: (args) =>
            resolveOpenCodeProtectedTailBoundary({
                ...args,
                cacheNamespace: `opencode2:${args.sessionId}`,
            }),
        // Draft-backed: v2 never reconstructs the live model from message.updated.
        hostModelFallback: (sessionID) => liveModels.get(sessionID) ?? null,
        // The shared scheduler and historian pressure bands read this callback,
        // not liveModelBySession directly. Resolve on each pass so the draft's
        // model is authoritative before any usage arrives and after a switch.
        getModelKey: (sessionID) => {
            const model = liveModels.get(sessionID);
            return resolveModelKey(model?.providerID, model?.modelID);
        },
        hostRefusalNotice: async (_client, sessionID, message) => {
            pushNotification("toast", { message, variant: "error" }, sessionID);
            await deliverSynthetic(context, sessionID, message);
        },
        hostRefuse: (_client, sessionID) =>
            refuseBeforeProvider(
                context.session,
                sessionID as SessionContext["sessionID"],
                "transform-fail-closed",
            ),
    };
}

type V2ThresholdConfig = Pick<
    ReturnType<typeof loadPluginConfigDetailed>["config"],
    "execute_threshold_percentage" | "execute_threshold_tokens"
>;

/**
 * The execute thresholds the shared transform and its scheduler read, built the way the
 * OpenCode 1 hook builds them: the percentage and the absolute token threshold, which
 * overrides the percentage when set. Like OpenCode 1, both are read once at startup.
 */
export function createV2ThresholdDeps(
    config: V2ThresholdConfig,
): Pick<TransformDeps, "scheduler" | "executeThresholdPercentage" | "executeThresholdTokens"> {
    return {
        scheduler: createScheduler({
            executeThresholdPercentage: config.execute_threshold_percentage,
            executeThresholdTokens: config.execute_threshold_tokens,
        }),
        executeThresholdPercentage: config.execute_threshold_percentage,
        executeThresholdTokens: config.execute_threshold_tokens,
    };
}

function toolResultText(result: { content?: unknown } | undefined): string {
    const content = result?.content ?? (result as { output?: unknown } | undefined)?.output;
    if (typeof content === "string") return content;
    if (content && typeof content === "object" && !Array.isArray(content)) {
        const record = content as { text?: unknown; value?: unknown };
        if (typeof record.text === "string") return record.text;
        if (typeof record.value === "string") return record.value;
        return "";
    }
    if (!Array.isArray(content)) return "";
    return content
        .map((part) => {
            if (typeof part === "string") return part;
            if (!part || typeof part !== "object") return "";
            const record = part as { type?: unknown; text?: unknown; value?: unknown };
            if (typeof record.text === "string") return record.text;
            if (typeof record.value === "string") return record.value;
            return "";
        })
        .filter(Boolean)
        .join("\n");
}

/**
 * Record why a turn is about to be refused before the model is called.
 *
 * When reading the host store or the context database fails, the turn is treated
 * as unsafe and interrupted before the provider request. The host then stores the
 * turn as interrupted and the user simply never receives a reply — there is no
 * error on screen and no assistant message. Without this line the reason exists
 * only in OpenCode's own server log, so the Magic Context log that users are
 * asked for during a support request says nothing about why their turn died
 * (issue #493, where a store the OpenCode 2 host had migrated from OpenCode 1
 * was refused by the v2 store reader and every turn ended in silence).
 */
export function reportPreProviderRefusal(sessionID: string, error: unknown): void {
    sessionLog(
        sessionID,
        `v2 refusing this turn before the model call: the context could not be read: ${getErrorMessage(error)}`,
    );
}

/** Accept both a raw model array and the 2.0.5 `{ data }` list payload. */
export function catalogModels(
    listed: unknown,
    draftModel?: SessionContext["model"],
): Array<{
    id: string;
    providerID: string;
    limit: { context: number; input?: number; output?: number };
}> {
    const rows = Array.isArray(listed)
        ? listed
        : listed && typeof listed === "object" && Array.isArray((listed as { data?: unknown }).data)
          ? (listed as { data: unknown[] }).data
          : [];
    const models = rows.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const model = row as {
            id?: unknown;
            providerID?: unknown;
            limit?: { context?: unknown; input?: number; output?: number };
        };
        if (typeof model.id !== "string" || typeof model.providerID !== "string") return [];
        const contextLimit = model.limit?.context;
        if (typeof contextLimit !== "number" || !Number.isFinite(contextLimit)) return [];
        return [
            {
                id: model.id,
                providerID: model.providerID,
                limit: { ...model.limit, context: contextLimit },
            },
        ];
    });
    const draftContextLimit = draftModel?.limit?.context;
    if (
        draftModel &&
        typeof draftContextLimit === "number" &&
        Number.isFinite(draftContextLimit) &&
        draftContextLimit > 0
    ) {
        const key = `${draftModel.providerID}/${draftModel.id}`;
        const byKey = new Map(models.map((model) => [`${model.providerID}/${model.id}`, model]));
        byKey.set(key, {
            id: draftModel.id,
            providerID: draftModel.providerID,
            limit: { ...draftModel.limit, context: draftContextLimit },
        });
        return [...byKey.values()];
    }
    return models;
}

export function removeDreamerOnlyTools(draft: SessionContext): void {
    if (draft.tools) delete draft.tools.ctx_memory_list;
}

/** Rewrite Magic Context ctx_* tool descriptions for this draft's model. */
export function applyV2PromptSurfaceTools(
    draft: SessionContext,
    runtime: PromptSurfaceRuntime,
    config: PromptSurfaceConfig | undefined,
    smartNotesEnabled = true,
): void {
    if (!draft.tools) return;
    const modelKey = `${draft.model.providerID}/${draft.model.id}`;
    const registration = runtime.resolveRegistration(config, modelKey);
    for (const id of ACTIVE_TOOL_IDS) {
        const tool = draft.tools[id];
        if (!tool) continue;
        tool.description =
            id === "ctx_note" && !smartNotesEnabled
                ? withoutSmartNoteText(
                      registration.preset === "light"
                          ? CTX_NOTE_LIGHT_DESCRIPTION
                          : CTX_NOTE_DESCRIPTION,
                  )
                : registration.descriptionFor(id, tool.description);
        applyJsonSchemaParameterDescriptions(
            id,
            tool.input,
            registration.preset,
            smartNotesEnabled,
        );
    }
}

/**
 * Measure the tool definitions this request is actually going to send.
 *
 * OpenCode 1 measures the same thing through its `tool.definition` hook; OpenCode 2 has no such
 * hook, but the request draft carries the whole tool set, so the draft is the measurement seam.
 * This runs after the per-model descriptions have been applied, so what is counted is what goes on
 * the wire, and it is keyed by the same {provider, model, agent} triple the status and sidebar
 * handlers look the measurement up by.
 *
 * The draft is the request's exact tool set, so it replaces the route's measured set and becomes
 * this session's figure: a tool an earlier request carried, or another session's request carried,
 * does not count toward this request's size.
 *
 * Measuring changes no served byte: the resulting tool-set hash is an attribution marker that the
 * m[0] materialization decision records but never folds on.
 */
export function recordV2ToolDefinitions(draft: SessionContext): void {
    if (!draft.tools) return;
    const tools: Array<{ id: string; description: string; parameters: unknown }> = [];
    for (const [id, tool] of Object.entries(draft.tools)) {
        if (!tool) continue;
        // The execute hook sees only the tool name, so keep the parameter names
        // for the dropped-input refusal to list.
        recordToolParameters(id, tool.input);
        tools.push({
            id,
            description: typeof tool.description === "string" ? tool.description : "",
            parameters: tool.input,
        });
    }
    recordToolDefinitionSet(
        draft.model.providerID,
        draft.model.id,
        draft.agent,
        tools,
        draft.sessionID,
    );
}

/**
 * Run the system-prompt handler over one context draft and write its result back.
 *
 * The handler only compares and records the system-prompt hash once the session's
 * ctx_reduce verdict is frozen, because that verdict chooses the guidance text.
 * When nothing has frozen the verdict yet in this process, the handler falls
 * back to reading the first user message from OpenCode 1's `message` table. On
 * OpenCode 2 that read never succeeds (its store has a different schema), so
 * without freezing the verdict here first, the first pass after every restart
 * left the verdict provisional and skipped the hash comparison. A restart that changed the system
 * prompt then sent the new prompt on that first pass (so the provider cache was
 * lost there anyway) and only detected the change on the second pass, whose
 * separate HARD fold rebuilt the cache a second time.
 *
 * Freeze from the host-filtered tool set before either shared handler can fall
 * back to the v1 tables. OC2 has already applied agent and session permissions
 * to draft.tools; its adapted messages carry no v1 tools map. Freezing from
 * roles alone therefore advertised a denied ctx_reduce as callable. Only the
 * first resolved user pass decides: later tool/agent changes cannot change
 * the guidance or tags mid-session. A draft with no user message remains
 * provisional, as before.
 */
export async function applyV2SystemPrompt(
    systemPrompt: Pick<ReturnType<typeof createSystemPromptHashHandler>, "handler">,
    draft: Pick<SessionContext, "sessionID" | "model" | "messages" | "system" | "tools">,
): Promise<void> {
    resolveCtxReduceAvailabilityFromMessages(
        draft.sessionID,
        draft.messages.map((message) => ({
            info: {
                role: message.role,
                tools: { ctx_reduce: Object.hasOwn(draft.tools, "ctx_reduce") },
            },
        })),
    );
    const system = { system: draft.system.map((part) => String(part.text ?? "")) };
    bindSystemDateOutput(system.system, () => {
        draft.system.splice(
            0,
            draft.system.length,
            ...system.system.map((text, index) => ({
                ...draft.system[index],
                type: "text",
                text,
            })),
        );
    });
    await systemPrompt.handler(
        {
            sessionID: draft.sessionID,
            dateRefreshRequest: draft,
            model: { providerID: draft.model.providerID, modelID: draft.model.id },
        },
        system,
    );
    const originals = [...draft.system];
    draft.system.splice(
        0,
        draft.system.length,
        ...system.system.map((text, index) => ({
            ...originals[index],
            type: "text",
            text,
        })),
    );
}

/**
 * The instruction-update rows at or before `throughSeq`, rendered the way the
 * host renders them (id-less system messages) and marked as covered by the
 * history boundary. After a host checkpoint these rows are hidden from the draft
 * like every other row before it; restoring them lets every pass, before and
 * after the checkpoint and on both sides of a boundary move, see the same
 * instruction rows (see storage-host-instruction-retention.ts).
 */
function coveredInstructionRows(
    reader: Pick<V2StoreReader, "instructionRowsThrough">,
    sessionID: string,
    throughSeq: number,
    model: SessionContext["model"],
): V2Message[] {
    if (throughSeq < 0) return [];
    return reader
        .instructionRowsThrough(sessionID, throughSeq)
        .flatMap((row) => restoreRow(row, model))
        .map((message) => markCoveredInstructionRow(message));
}

export async function registerContext(context: V2Context) {
    const directory = context.location.directory;
    const config = loadPluginConfigDetailed(directory).config;
    setHomeProjectPermission(config.allow_home_project);
    if (!config.enabled) return;
    const nativeRemove = nativeSessionRemove(context.session);
    if (!hasRequiredSessionAPI(context.session) || !nativeRemove) {
        const message = OPENCODE2_SESSION_API_NOTICE;
        console.warn(`[magic-context] v2 host API unavailable: ${message}`);
        log(`[magic-context] ${message}`);
        let noticed = false;
        const refuseUnsupportedHost = async (draft: { sessionID: string }) => {
            if (!noticed) {
                noticed = true;
                pushNotification("toast", { message, variant: "error" }, draft.sessionID);
                void context.session
                    .wait({ sessionID: draft.sessionID })
                    .then(() => deliverSynthetic(context, draft.sessionID, message))
                    .catch((error: unknown) =>
                        sessionLog(
                            draft.sessionID,
                            "host API notice could not be delivered:",
                            error,
                        ),
                    );
            }
            await refuseBeforeProvider(context.session, draft.sessionID, "unsupported-session-api");
        };
        await context.session.hook("context", refuseUnsupportedHost);
        await context.session.hook("compaction", async (draft) => {
            // Supplying a result prevents the host from calling its own summary model.
            draft.result = { summary: message };
            await refuseUnsupportedHost(draft);
        });
        return;
    }
    const liveConfigReader = pluginConfigReader(directory, config);
    const compactionOff = !isCompactionEnabled(config);
    const conflicts = detectConflicts(directory, {
        compactionEnabled: !compactionOff,
        hostGeneration: "v2",
    });
    if (conflicts.hasConflict) {
        console.warn(
            `[magic-context] v2 setup disabled by conflicting context hooks: ${conflicts.reasons.join("; ")}`,
        );
        return;
    }
    const embeddings = createV2EmbeddingScope(
        resolveProjectIdentityForSession(directory, config.allow_home_project),
    );
    const folds = new FoldOwner(context.storage);
    // Experimental and opt-in (MC_OC2_INVISIBLE_FOLD=1). After OpenCode folds the
    // history, the provider request bytes must stay identical to the ones sent
    // before the fold, so the provider's prompt cache still matches. That has not
    // yet been verified across providers and plugin restarts, so automatic host
    // folding stays off by default.
    const nativeFoldMemory =
        !compactionOff && process.env.MC_OC2_INVISIBLE_FOLD === "1"
            ? nativeFoldCache(() => storage.require())
            : undefined;
    const nativeFoldReplay = nativeFoldMemory
        ? new NativeFoldReplay(nativeFoldMemory, () => openStoreReader(), context.storage)
        : undefined;
    setOutputReserveConfig(config.output_reserve);
    const queriedModels = new Set<string>();
    const rawLimits = new Map<string, { context: number; input?: number; output?: number }>();
    const hiddenSessionErrors = new Map<string, unknown>();
    const hiddenModelActivity = new HiddenModelActivity();
    // Draft-authoritative model/variant/agent. Not the v1 event-driven map.
    const liveModels: NonNullable<TransformDeps["liveModelBySession"]> = new Map();
    const promptSurfaceRuntime = createPromptSurfaceRuntime({
        harness: "opencode2",
        directory,
        warn: (message) => log(`[magic-context] config warning: ${message}`),
    });
    // Settings that are on but inert because another section turns off what
    // they rely on (for example smart notes with the dreamer disabled).
    logConfigDependencyNotesOnce(config, log);
    // Tools are registered only when this first open succeeds: registering them
    // later would change the tool list mid-session, so they need a restart. A
    // refused open is retried on later turns through the gate, and the first
    // successful retry wires the historian and the dreamer then (see
    // recoverHiddenWork below), so those come back without a restart.
    const storage = createV2StorageGate({
        onUnavailable: (reason) => {
            const message = formatFailClosedBlockingMessage(reason);
            console.warn(`[magic-context] v2 storage unavailable: ${message}`);
            log(`[magic-context] v2 storage unavailable: ${message}`);
        },
    });
    // Let slow healthy storage finish before fixing the tool list for this host.
    // Discovery yields to HTTP while setup waits, with a bounded degraded fallback.
    let db: ReturnType<typeof openDatabase> | undefined = await probeV2StorageAtBoot(storage);
    const storageOpenedAtBoot = db !== undefined;
    let legacyCleanupStarted = false;
    const cleanupLegacyOnce = async (database: NonNullable<typeof db>) => {
        if (legacyCleanupStarted) return;
        legacyCleanupStarted = true;
        await cleanupLegacyHiddenChildren(database, nativeRemove, log);
    };
    if (db && isDatabasePersisted(db)) await cleanupLegacyOnce(db);
    let storageRecoveryAnnounced = false;
    const storageNoticeBySession = new Map<string, string>();
    /**
     * Store a storage notice in the conversation once the current turn has ended.
     * On OpenCode 2.0.18 a synthetic message sent while the turn is still running
     * is dropped when the turn is interrupted: its sequence number is used and no
     * row is kept. The notice never reaches the model: the context hook drops it
     * from every request, and a turn that the notice itself starts is ended before
     * the provider.
     */
    const storeStorageNotice = (sessionID: string, text: string, what: string): void => {
        void withoutSqliteTransformPass(() =>
            Promise.resolve()
                .then(() => context.session.wait({ sessionID }))
                .then(() => deliverSynthetic(context, sessionID, text))
                .catch((error: unknown) =>
                    sessionLog(
                        sessionID,
                        `v2 storage ${what} notice could not be delivered:`,
                        error,
                    ),
                ),
        );
    };
    /**
     * Tell the user why a turn is refused for missing storage. The host records a
     * refused turn as a bare interruption with no text, so without this the turn
     * just ends in silence. A toast reaches a connected Magic Context TUI on every
     * refusal; the stored notice reaches every client and is written once per
     * session and reason rather than on every refused turn.
     */
    const noticeStorageRefusal = (sessionID: string, reason: FailClosedReason): void => {
        const message = formatStorageRefusalNotice(reason);
        pushNotification("toast", { message, variant: "error" }, sessionID);
        if (storageNoticeBySession.get(sessionID) === message) return;
        storageNoticeBySession.set(sessionID, message);
        storeStorageNotice(sessionID, message, "refusal");
    };
    // Rust mode reaches the `ck-mc` module over the same subc client the OpenCode 1
    // lane builds. Building it is inert until a pass actually calls the module, so
    // it is safe to hold one here for the whole process. It is resolved before the
    // tools are registered because the tool facades are part of the same wiring:
    // registering `ctx_note`/`ctx_memory` without them would let an agent's write
    // land in the host read model alone, where the module never sees it.
    const rustModeModuleClient = resolveV2RustModeModuleClient(config, directory);
    const rustMemorySyncRequestedSessions = new Set<string>();
    const moduleToolBackends =
        db && isDatabasePersisted(db)
            ? createModuleToolBackends({
                  db,
                  moduleClient: rustModeModuleClient,
                  directory,
                  memorySyncRequestedSessions: rustMemorySyncRequestedSessions,
              })
            : undefined;
    const hiddenChildHook = new HiddenChildHook();
    await context.session.hook("http.request", (draft) => hiddenChildHook.cacheRequest(draft));
    const tools =
        db && isDatabasePersisted(db)
            ? await registerTools(
                  context,
                  db,
                  config,
                  moduleToolBackends?.backends,
                  (id) => hiddenChildHook.owns(id),
                  embeddings.ensureRegistered,
              )
            : undefined;
    const usage: TransformDeps["contextUsageMap"] = new Map();
    const generateReplay = new V2GenerateReplay();
    await context.session.hook("http.response", async (draft) => {
        if (!db || draft.kind !== "primary" || draft.response.ok) return;
        const detection = detectOverflow(await draft.response.clone().text());
        if (!detection.isOverflow) return;
        const modelKey = `${draft.model.providerID}/${draft.model.id}`;
        if (compactionOff) {
            if (detection.reportedLimit)
                recordDetectedContextLimit(
                    db,
                    draft.sessionID,
                    detection.reportedLimit,
                    modelKey,
                    detection.reportedLimitProvenance,
                );
        } else {
            recordOverflowDetected(
                db,
                draft.sessionID,
                detection.reportedLimit,
                modelKey,
                "provider_overflow",
                detection.reportedLimitProvenance,
                detection.reportedInputTokens,
            );
            if (detection.reportedInputTokens) {
                const provenLimit = getOverflowState(
                    db,
                    draft.sessionID,
                    modelKey,
                ).detectedContextLimit;
                usage.set(draft.sessionID, {
                    usage: {
                        inputTokens: detection.reportedInputTokens,
                        percentage:
                            provenLimit > 0
                                ? (detection.reportedInputTokens / provenLimit) * 100
                                : 100,
                    },
                    hasUsageTokens: true,
                    updatedAt: Date.now(),
                });
            }
        }
    });
    await registerHiddenChildAgents(context.agent);
    // Registered before anything can start a hidden run. A hidden child's tool
    // call is checked against that agent's fixed allowlist whatever the user's
    // permissions allow: the host appends the user's rules after the agent's
    // own, so the agent registration alone cannot keep edit or shell away.
    await context.tool.hook("execute.before", (draft) => {
        const refusal = hiddenToolCallRefusal(draft, hiddenChildHook);
        if (refusal === undefined) return;
        sessionLog(draft.sessionID, "hidden child tool call refused", {
            tool: draft.tool,
            agent: draft.agent ?? null,
        });
        throw new HiddenCompletionRefusal("hidden_prompt_unrecognized", refusal, true);
    });
    let hiddenAgentsReady: Promise<void> | undefined;
    const readerPool = new V2StoreReaderPool();
    const messageTimesCache = new V2MessageTimesCache();
    const openStoreReader = () =>
        readerPool.open(gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"));
    const createHiddenExecutor = async (database: NonNullable<typeof db>) => {
        await cleanupLegacyOnce(database);
        return createV2HiddenCompletionExecutor(
            {
                ...context.session,
                watchModelActivity: (sessionID, onOutput) =>
                    hiddenModelActivity.watch(sessionID, onOutput),
                get: async (input) => {
                    const session = await context.session.get(input);
                    const error = hiddenSessionErrors.get(input.sessionID);
                    return error === undefined ? session : { ...session, error };
                },
                terminalError: async (input) => {
                    const deadline = Date.now() + HIDDEN_SESSION_ERROR_GRACE_MS;
                    do {
                        const error = hiddenSessionErrors.get(input.sessionID);
                        if (error !== undefined) return error;
                        await new Promise((resolve) => setTimeout(resolve, 5));
                    } while (Date.now() < deadline);
                    return undefined;
                },
                prompt: async (input) => {
                    hiddenSessionErrors.delete(input.sessionID);
                    return context.session.prompt(input);
                },
                removeSession: nativeRemove,
            },
            {
                db: database,
                projectIdentity:
                    resolveProjectIdentityForSession(directory, config.allow_home_project) ?? "",
                directory,
                hook: hiddenChildHook,
                keepSubagents: config.keep_subagents === true,
                ensureAgent: () => (hiddenAgentsReady ??= context.agent.reload()),
                modelCatalog: () => Promise.resolve(context.model.list()),
                historianTemperature: () => config.historian?.temperature,
                openReader: openStoreReader,
                holdStore: () => readerPool.hold(),
            },
        );
    };
    const dreamerAtBoot = config.dreamer;
    /**
     * Whether the user's current config turns the dreamer off. `dreamer.disable`
     * is a live key: the trigger, the schedule timer and `/ctx-dream` re-read it
     * before every run, and a dreamer turned on after boot is started by the
     * next context pass (see `runManagedContext`).
     */
    const dreamerDisabledNow = (): boolean =>
        dreamerRunConfig(config, liveConfigReader.poll().effective).dreamer?.disable === true;
    const startDreamer = (executor: HiddenCompletionExecutor) => {
        const projectIdentity = resolveProjectIdentityForSession(
            directory,
            config.allow_home_project,
        );
        if (!projectIdentity || !dreamerAtBoot || dreamerDisabledNow()) return undefined;
        const cappedExecutor = withLiveDreamerOutputCap(
            executor,
            config,
            () => liveConfigReader.poll().effective,
        );
        const trigger = startDreamTrigger(context, {
            config: dreamerAtBoot,
            smartNotesEnabled: config.smart_notes.enabled,
            sample: () => {
                const current = dreamerRunConfig(config, liveConfigReader.poll().effective);
                return { config: current.dreamer ?? dreamerAtBoot, mural: current.mural };
            },
            executor: cappedExecutor,
            projectIdentity: () =>
                resolveProjectIdentityForSession(directory, config.allow_home_project) ?? "",
            projectMemoryEnabled: config.memory.enabled,
            language: config.language,
            mural: config.mural,
            memoryInjectionBudgetTokens: config.memory.injection_budget_tokens,
            retinaHandoff: config.smart_notes.retina_handoff,
            transformMode: config.transform_mode,
            moduleClient: createDreamTimerModuleClient(rustModeModuleClient),
        });
        return trigger;
    };
    // Both stay undefined after a refused start until recoverHiddenWork wires them.
    let hiddenCompletionExecutor: V2HiddenCompletionExecutor | undefined =
        db &&
        isDatabasePersisted(db) &&
        resolveProjectIdentityForSession(directory, config.allow_home_project)
            ? await createHiddenExecutor(db)
            : undefined;
    let dreamTrigger = hiddenCompletionExecutor
        ? startDreamer(hiddenCompletionExecutor)
        : undefined;
    // RPC handlers and commands are registered once at setup; after a refused
    // start they hold this stand-in, which reaches the executor recoverHiddenWork
    // wires later.
    const lateHiddenExecutor = createLateHiddenExecutor(() => hiddenCompletionExecutor);
    // Maintenance owns one process-wide timer, regardless of dreamer.disable.
    // The shared timer samples the git indexing switch separately from dream tasks.
    let maintenanceTimer: ReturnType<typeof registerV2DreamScheduleTimer> | undefined;
    const startMaintenance = () => {
        const timerProjectIdentity = resolveProjectIdentityForSession(
            directory,
            config.allow_home_project,
        );
        if (!timerProjectIdentity || maintenanceTimer) return;
        maintenanceTimer = registerV2DreamScheduleTimer({
            directory,
            projectIdentity: timerProjectIdentity,
            config,
            dreamer: dreamerAtBoot,
            liveConfig: () => liveConfigReader.poll().effective,
            executor: withLiveDreamerOutputCap(
                lateHiddenExecutor,
                config,
                () => liveConfigReader.poll().effective,
            ),
            openReader: openStoreReader,
            rustModeModuleClient,
            ensureRegistered: embeddings.ensureRegistered,
        });
    };
    if (db && isDatabasePersisted(db)) startMaintenance();
    let hiddenWorkRecovery: Promise<boolean> | undefined;
    /**
     * Wire the historian's executor and the dreamer on the first successful open
     * after a refused start, once per process. Both are internal to this plugin,
     * so unlike tools they can start mid-session. Returns whether they are wired.
     */
    const recoverHiddenWork = (database: NonNullable<typeof db>): Promise<boolean> =>
        !resolveProjectIdentityForSession(directory, config.allow_home_project)
            ? Promise.resolve(false)
            : (hiddenWorkRecovery ??= (async () => {
                  try {
                      startMaintenance();
                      hiddenCompletionExecutor ??= await createHiddenExecutor(database);
                      dreamTrigger ??= startDreamer(hiddenCompletionExecutor);
                      return true;
                  } catch (error) {
                      log(
                          "[magic-context] v2 historian and dreamer could not start after recovery:",
                          error,
                      );
                      return false;
                  }
              })());
    const sampleHistorian = () => {
        const fresh = historianRunConfig(config, liveConfigReader.poll().effective);
        const models = resolveHistorianModel(fresh, "opencode");
        return {
            model: models.primary,
            fallbackModels: models.fallbacks,
            contextLimit: resolveKnownHistorianContextLimit(models.primary?.model),
            maxOutputTokens: fresh.historian?.maxTokens,
            timeoutMs: fresh.historian_timeout_ms,
            twoPass: fresh.historian?.two_pass === true,
            expandTools: fresh.historian?.expand_tools,
            autoPromote: fresh.memory?.auto_promote ?? true,
            userMemoriesEnabled: userObservationCollectionEnabled(fresh.dreamer),
            userObservationsRequested: userObservationsRequested(fresh.dreamer),
            commitClusterTrigger: fresh.commit_cluster_trigger,
            chunkTokens: deriveHistorianChunkTokens(
                resolveHistorianContextLimit(models.primary?.model),
            ),
        };
    };
    const historianModels = resolveHistorianModel(config, "opencode");
    const channel1: NonNullable<TransformDeps["channel1StateBySession"]> = new Map();
    const variants = new Map<string, string | undefined>();
    const agents = new Map<string, string>();
    const sessionDirectories = new Map<string, string>();
    const historyRefreshSessions = new Set<string>();
    registerSystemDateRefresh(historyRefreshSessions);
    const pendingMaterializationSessions = new Set<string>();
    const lastHeuristicsTurnId = new Map<string, string>();
    const commitSeenLastPass = new Map<string, boolean>();
    const restoredRows = new RestoredRowCache();
    const rawProviders = new Map<string, () => void>();
    let passDuties: ReturnType<typeof createChatMessageHook> | undefined;
    let toolDuties: ReturnType<typeof createToolExecuteAfterHook> | undefined;
    const droppedInputGuard = createDroppedInputGuard();
    await context.tool.hook("execute.before", (draft) =>
        assertExecutableToolInput(droppedInputGuard, {
            sessionID: draft.sessionID,
            toolName: draft.tool,
            input: draft.input,
        }),
    );
    await context.tool.hook("execute.after", async (draft) => {
        if (!db) return;
        if (draft.status && draft.status !== "completed") return;
        try {
            toolDuties ??= createToolExecuteAfterHook({ db, channel1StateBySession: channel1 });
            const text = toolResultText(draft.result);
            const output = { output: text };
            await toolDuties({ ...draft, args: draft.input }, output);
            if (draft.result && output.output !== text) {
                const content = draft.result.content;
                if (typeof content === "string") draft.result.content = output.output;
                else if (Array.isArray(content) && output.output.startsWith(text))
                    content.push({ type: "text", text: output.output.slice(text.length) });
            }
            const baseline = channel1.get(draft.sessionID);
            await deliverPendingChannel2(context, db, draft.sessionID, baseline);
        } catch (error) {
            log("[magic-context] v2 Channel 2 delivery deferred", error);
        }
    });
    const pagedRead = createV2RawMessageReader(openStoreReader);
    // Commands can precede the first context pass after a restart. Their background
    // historian reads need the same durable v2 source as automatic historian work.
    const prepareHistorySession = (sessionID: string): void => {
        if (!rawProviders.has(sessionID))
            rawProviders.set(
                sessionID,
                setBoundedRawMessageProvider(
                    sessionID,
                    createV2RawMessageProvider(pagedRead, sessionID),
                ),
            );
    };
    if (db && isDatabasePersisted(db)) {
        const backfillDb = db;
        scheduleAfterBootQuiet(() => {
            runV2SessionProjectBackfill(backfillDb, openStoreReader, config.allow_home_project)
                .then(() =>
                    backfillSessionActivity(backfillDb, "opencode", (sessionId) => {
                        const reader = openStoreReader();
                        try {
                            return reader.latestMessageTime(sessionId);
                        } finally {
                            reader.close();
                        }
                    }),
                )
                .catch((error: unknown) =>
                    log("[session-project-backfill] OpenCode 2 backfill failed:", error),
                );
        });
    }
    const readAllForConversion = (sessionID: string) =>
        readAllV2RawMessagesForConversion(openStoreReader, sessionID);
    // Refusal recovery only needs to know whether a user turn followed the refused
    // one, so it reads the rows from that message onward, never the whole session.
    const readRowsFrom = (sessionID: string, messageID: string) => {
        const reader = openStoreReader();
        try {
            const seq = reader.sequenceForId(sessionID, messageID);
            if (seq === undefined) return [];
            return reader.range(sessionID, seq - 1, reader.latestSequence(sessionID));
        } finally {
            reader.close();
        }
    };
    const rustRefusalRecovery = rustModeModuleClient
        ? createV2RustRefusalRecovery({
              context,
              moduleClient: rustModeModuleClient,
              readRowsFrom,
          })
        : undefined;
    const lkgSystems = new V2LkgSystemReplay();
    let transform: ReturnType<typeof createTransform> | undefined;
    let systemPrompt: ReturnType<typeof createSystemPromptHashHandler> | undefined;
    const systemPromptRefreshSessions = new Set<string>();
    const tagger = createTagger();
    const deletedSessions = new DeletedSessionTombstones();
    // Sessions whose fork inheritance has been settled in this process (seeded,
    // declined, or not a fork), so the store is asked once per session.
    const forkSeedSettled = new Set<string>();
    /**
     * On the first pass for a session with no Magic Context state, inherit the
     * parent's state when the session is an OpenCode 2 fork. Runs before
     * anything on this pass can tag the session: a fork already tagged is
     * never copied into. A transient storage error is rethrown so the pass is
     * replayed or refused and the next one retries the seed; any other
     * failure is logged and the session goes on without inherited state.
     */
    const inheritForkState = (database: NonNullable<typeof db>, sessionID: string): void => {
        if (forkSeedSettled.has(sessionID)) return;
        if (sessionHasMagicContextState(database, sessionID)) {
            forkSeedSettled.add(sessionID);
            return;
        }
        let reader: V2StoreReader | undefined;
        try {
            reader = openStoreReader();
            const outcome = seedV2ForkFromParent({
                db: database,
                store: reader,
                sessionId: sessionID,
            });
            forkSeedSettled.add(sessionID);
            if (outcome.kind === "seeded") {
                const { result } = outcome;
                sessionLog(
                    sessionID,
                    `v2 fork inheritance: seeded from ${outcome.parentSessionID} through the fork boundary; paired rows=${outcome.pairedRows} compartments=${result.compartmentsCopied} tags=${result.tagsCopied} pending_ops=${result.pendingOpsCopied} facts=${result.factsCopied} notes=${result.notesCopied}`,
                );
            } else if (outcome.kind === "parent-missing") {
                sessionLog(
                    sessionID,
                    `v2 fork inheritance: fork of ${outcome.parentSessionID} starts without inherited state (${outcome.reason})`,
                );
            } else if (outcome.kind === "destination-not-empty") {
                sessionLog(
                    sessionID,
                    `v2 fork inheritance: fork of ${outcome.parentSessionID} already has state; not copied again`,
                );
            }
        } catch (error) {
            if (isTransientSqliteError(error)) throw error;
            forkSeedSettled.add(sessionID);
            sessionLog(sessionID, "v2 fork inheritance failed; continuing without it:", error);
        } finally {
            reader?.close();
        }
    };
    /**
     * Record the provider's usage for the session's latest reply. Returns true only
     * when that could not be done safely (the context database is not durable, or a
     * store could not be read); the usage figure itself never makes a turn unsafe.
     */
    const latestLkgResponseIds = new BoundedSessionMap<string | undefined>(1000);
    const recordUsage = async (
        draft: Pick<SessionContext, "sessionID" | "model">,
        passStarting = false,
    ): Promise<boolean> => {
        let unsafe = false;
        try {
            // A turn may await the one in-flight recovery; unlike setup it needs
            // durable state before transforming. Process discovery yields meanwhile.
            await storage.probe();
            db = storage.require();
            getOrCreateSessionMeta(db, draft.sessionID);
            const reader = openStoreReader();
            try {
                const latest = reader.latestAssistant(draft.sessionID);
                latestLkgResponseIds.set(draft.sessionID, latest?.id);
                try {
                    bindV2SystemPromptResponse(draft.sessionID, reader);
                } catch (error) {
                    sessionLog(
                        draft.sessionID,
                        "v2 response ownership unavailable; keeping system identity pending",
                        error,
                    );
                }
                // The previous pass's busting or system-change decision belongs to
                // the reply its request produced. Best-effort; never refuses a turn.
                bindV2TransformDecision({
                    db,
                    sessionId: draft.sessionID,
                    reader,
                    passStarting,
                });
                if (latest)
                    noteLkgProviderResponse({
                        sessionId: draft.sessionID,
                        responseId: latest.id,
                        modelKey:
                            latest.data.model?.providerID && latest.data.model?.id
                                ? `${latest.data.model.providerID}/${latest.data.model.id}`
                                : undefined,
                        inputTokens: lkgProviderInputTotal(latest.data.tokens),
                        completedAt: latest.data.time?.completed,
                        createdAt: latest.data.time?.created ?? latest.time_created,
                        finish: latest.data.finish,
                        error: latest.data.error,
                        v2: true,
                    });
                const draftModelKey = `${draft.model.providerID}/${draft.model.id}`;
                if (!queriedModels.has(draftModelKey)) {
                    const catalog = await Promise.resolve(context.model.list());
                    const providers = new Map<
                        string,
                        {
                            id: string;
                            models: Record<
                                string,
                                { limit: { context: number; input?: number; output?: number } }
                            >;
                        }
                    >();
                    for (const model of catalogModels(catalog, draft.model)) {
                        rawLimits.set(`${model.providerID}/${model.id}`, model.limit);
                        const provider = providers.get(model.providerID) ?? {
                            id: model.providerID,
                            models: {},
                        };
                        provider.models[model.id] = { limit: model.limit };
                        providers.set(model.providerID, provider);
                    }
                    await refreshModelLimitsFromApi({
                        config: {
                            providers: async () => ({
                                data: { providers: [...providers.values()] },
                            }),
                        },
                    });
                    queriedModels.add(draftModelKey);
                }
                const usageDb = db;
                const limitFor = (providerID: string, modelID: string) => {
                    const modelKey = `${providerID}/${modelID}`;
                    const rawLimit = rawLimits.get(modelKey);
                    // The shared catalog rejects unusually small limits, but a
                    // provider may explicitly configure a valid small context window.
                    return rawLimit && !isSaneLimit(rawLimit.context)
                        ? (resolveLimit(rawLimit, providerID, modelID) ?? 0)
                        : resolveContextLimit(providerID, modelID, {
                              db: usageDb,
                              sessionID: draft.sessionID,
                          });
                };
                const reading = resolveUsageReading({
                    rowModel: latest?.data.model,
                    draftModel: { providerID: draft.model.providerID, id: draft.model.id },
                    tokens: latest?.data.tokens,
                    // Completion is authoritative. Legacy finish-only rows use a
                    // stable stored message time, never the time of this reread.
                    completed:
                        latest?.data.time?.completed ??
                        (latest?.data.finish
                            ? (latest.data.time?.streamed ?? latest.data.time?.created)
                            : undefined),
                    finish: latest?.data.finish,
                    error: latest?.data.error,
                    limitFor,
                });
                if (reading) {
                    persistV2UsageReading({
                        db: usageDb,
                        sessionID: draft.sessionID,
                        draftModel: draft.model,
                        reading,
                        contextUsageMap: usage,
                    });
                }
            } finally {
                reader.close();
            }
        } catch (error) {
            reportPreProviderRefusal(draft.sessionID, error);
            unsafe = true;
        }
        return unsafe;
    };
    // Context runs before generation. Persist terminal usage at execution completion
    // so pressure is visible even when the user has not started another turn.
    const hostFolds =
        nativeFoldReplay && nativeFoldMemory
            ? new HostFoldPolicy({
                  session: context.session,
                  storage: nativeFoldMemory,
                  openReader: openStoreReader,
                  canReplay: (sessionID, reader) => nativeFoldReplay.canReplay(sessionID, reader),
                  threshold: Number(process.env.MC_OC2_HOST_FOLD_ROWS ?? 1000),
                  log: sessionLog,
              })
            : undefined;
    const usageController = new AbortController();
    const usageDone = (async () => {
        let retry = 0;
        while (!usageController.signal.aborted) {
            const subscribedAt = Date.now();
            try {
                for await (const value of context.event.subscribe({
                    signal: usageController.signal,
                })) {
                    if (usageController.signal.aborted) break;
                    const event = value as {
                        type?: string;
                        data?: { sessionID?: string; error?: unknown };
                    };
                    try {
                        hiddenModelActivity.observe(event);
                        // A provider or model reload can change the limit for the same
                        // model key. Drop the one-time catalog reads so the next pass
                        // re-reads the live limit.
                        if (event.type === "provider.updated" || event.type === "model.updated") {
                            queriedModels.clear();
                            continue;
                        }
                        if (!event.data?.sessionID) continue;
                        const sessionID = event.data.sessionID;
                        if (db && event.type === "session.revert.committed") {
                            // A committed revert deletes raw rows, invalidating both
                            // indexed ordinals and the cached append count/anchor.
                            const indexDb = db;
                            withoutSqliteTransformPass(() =>
                                scheduleClearAndReindex(indexDb, sessionID, pagedRead),
                            );
                        }
                        if (
                            event.type?.startsWith("session.revert.") ||
                            event.type === "session.message.content.updated"
                        ) {
                            nativeFoldReplay?.onEvent(event);
                            restoredRows.forget(sessionID);
                            messageTimesCache.delete(sessionID);
                        }
                        if (
                            event.type === "session.error" ||
                            event.type === "session.execution.failed"
                        ) {
                            const error = hiddenTerminalError(event);
                            if (error !== undefined) hiddenSessionErrors.set(sessionID, error);
                            if (error !== undefined && db && !compactionOff) {
                                const model = liveModels.get(sessionID);
                                try {
                                    armLatestThinkingRecoveryFromError({
                                        db,
                                        sessionId: sessionID,
                                        error,
                                        providerID: model?.providerID,
                                        modelID: model?.modelID,
                                    });
                                } catch (armError) {
                                    log(
                                        "[magic-context] v2 latest-thinking recovery arm failed",
                                        armError,
                                    );
                                }
                            }
                            continue;
                        }
                        if (event.type === "session.deleted") {
                            clearLkgMeasuredRequest(sessionID);
                            deletedSessions.add(sessionID);
                            // A failed store clear (a busy writer lock, say) must not skip
                            // the in-memory cleanup below: the pending-cleanup marker
                            // retries the rows later, but nothing retries this map
                            // cleanup. The store error is still rethrown and logged below.
                            const failures: unknown[] = [];
                            try {
                                transform?.clearSessionLogState(sessionID);
                                if (db) {
                                    markSessionCleanupPending(db, sessionID);
                                    clearSession(db, sessionID, false, true);
                                }
                            } catch (error) {
                                failures.push(error);
                            }
                            try {
                                rawProviders.get(sessionID)?.();
                                rawProviders.delete(sessionID);
                                usage.delete(sessionID);
                                messageTimesCache.delete(sessionID);
                                hiddenSessionErrors.delete(sessionID);
                                storageNoticeBySession.delete(sessionID);
                                liveModels.delete(sessionID);
                                variants.delete(sessionID);
                                agents.delete(sessionID);
                                channel1.delete(sessionID);
                                commitSeenLastPass.delete(sessionID);
                                clearEmbedSessionState(sessionID);
                                historyRefreshSessions.delete(sessionID);
                                clearPendingMaterialization(
                                    pendingMaterializationSessions,
                                    sessionID,
                                );
                                lastHeuristicsTurnId.delete(sessionID);
                                restoredRows.forget(sessionID);
                                if (nativeFoldReplay) await nativeFoldReplay.forget(sessionID);
                                else await forgetNativeFoldProvenance(context.storage, sessionID);
                                generateReplay.forget(sessionID);
                                systemPromptRefreshSessions.delete(sessionID);
                                systemPrompt?.clearSession(sessionID);
                                tagger.cleanup(sessionID);
                            } catch (error) {
                                failures.push(error);
                            }
                            if (failures.length === 1) throw failures[0];
                            if (failures.length > 1)
                                throw new AggregateError(
                                    failures,
                                    "session deletion failed in both the store clear and the in-memory cleanup",
                                );
                            continue;
                        }
                        if (event.type !== "session.execution.succeeded") continue;
                        const model = liveModels.get(sessionID);
                        if (model) {
                            await recordUsage({
                                sessionID,
                                model: { providerID: model.providerID, id: model.modelID },
                            });
                            // Do not block event handling while the automatic fold runs: idle()
                            // queues a compaction and then waits for OpenCode to settle it.
                            if (
                                !compactionOff &&
                                typeof (await nativeFoldReplay?.baseline(sessionID)) === "string"
                            )
                                void hostFolds?.idle(sessionID);
                        }
                    } catch (error) {
                        log(
                            `[magic-context] v2 event handler failed (type=${event.type ?? "unknown"}, session=${event.data?.sessionID ?? "none"})`,
                            error,
                        );
                    }
                }
            } catch (error) {
                if (!usageController.signal.aborted)
                    log("[magic-context] v2 usage subscription failed", error);
            }
            if (usageController.signal.aborted) break;
            // Only a stable subscription resets the backoff: a stream that ends
            // immediately, even after yielding an event, must not spin on reconnect.
            if (Date.now() - subscribedAt >= 30_000) retry = 0;
            const ceiling = Math.min(30_000, 250 * 2 ** retry);
            retry = Math.min(retry + 1, 7);
            try {
                await delay(ceiling * (0.5 + Math.random() * 0.5), undefined, {
                    signal: usageController.signal,
                });
            } catch (error) {
                if (!usageController.signal.aborted) throw error;
            }
        }
    })();
    const materialize = (draft: SessionContext) => {
        db = storage.require();
        const state = getOrCreateSessionMeta(db, draft.sessionID);
        const modelKey = `${draft.model.providerID}/${draft.model.id}`;
        const contextLimit =
            resolveContextLimit(draft.model.providerID, draft.model.id, {
                db,
                sessionID: draft.sessionID,
            }) ||
            draft.model.limit?.context ||
            (state.lastObservedModelKey === modelKey ? state.lastUsageContextLimit : undefined);
        return materializeM0({
            ...createM0RenderOptions(
                {
                    ...createV2TransformFeatureDeps(
                        config,
                        compactionOff,
                        directory,
                        embeddings.ensureRegistered,
                    ),
                    ...createV2ThresholdDeps(config),
                },
                usage.get(draft.sessionID)?.usage ?? { percentage: 0, inputTokens: 0 },
                modelKey,
                contextLimit,
                resolveProjectIdentityForSession(directory, config.allow_home_project),
            ),
            db,
            sessionId: draft.sessionID,
            state,
            projectDirectory: directory,
            hardSignals: {
                // Reuse the systemPromptHash saved by the system hook after it has
                // resolved guidance, presets and the date. Hashing the raw compaction
                // draft instead would make the next unchanged context pass rebuild the
                // cached head. Compaction can run before the system hook, so an
                // unknown identity stays empty for that hook to initialize.
                systemHash: state.systemPromptHash ?? "",
                toolSetHash: getCurrentToolSetHash(
                    draft.model.providerID,
                    draft.model.id,
                    draft.agent,
                    draft.sessionID,
                ),
                modelKey: `${draft.model.providerID}/${draft.model.id}`,
                // materializeM0 does not read cacheExpired. mustMaterialize owns
                // expiry decisions on the transform path; this fold always renders
                // fresh bytes and keys its markers from the system and model hashes.
                cacheExpired: false,
                lastResponseTime: state.lastResponseTime,
            },
        }).m0Text;
    };
    await context.session.hook("compaction", async (draft) => {
        // A hidden child is compacted by the host like any session once its own
        // sizing (its system prompt, instructions and tools, never the calibrated
        // prompt that replaces them) crosses the model's limit. Its history is not
        // a user conversation, so it never gets this session's history and memory
        // fold: it gets the marker of the run in flight, which keeps the
        // checkpoint recognizable to the hidden-child guard. This holds even with
        // Magic Context's compaction off, where the host would otherwise summarize
        // the child with a model call and lose the marker.
        const hiddenSummary = hiddenChildHook.compactionSummary(draft.sessionID, draft.agent);
        if (hiddenSummary !== undefined) {
            draft.result = { summary: hiddenSummary };
            return;
        }
        // Leaving `result` unset hands the request back to the host, exactly as if
        // no hook were registered.
        if (compactionOff) return;
        if (nativeFoldReplay) rememberHostMedia(draft.messages);
        const reader = openStoreReader();
        try {
            // Compaction may precede the first context callback. Wait for the pending
            // database open instead of refusing while its asynchronous probe is running.
            await storage.probe();
            const watermark = reader.latestSequenceForIds(
                draft.sessionID,
                draft.messages.flatMap((message) => (message.id ? [message.id] : [])),
            );
            const running = reader.latestRunningCompaction(draft.sessionID);
            // In Rust mode the module composes m[0] and the host renders none, so the
            // checkpoint has to be the module's own baseline. Composing a TypeScript one
            // here would give the session two different histories: the one the host
            // stores in its checkpoint and the one the module keeps serving.
            const moduleBaseline = rustModeModuleClient
                ? servedModuleM0Text(draft.sessionID)
                : undefined;
            // This hook ALWAYS answers, and leaving `result` unset is not an option.
            // On GA 2.0.5 an unanswered request is not a polite decline: the host
            // summarizes with its own model and, when that answer is not in the
            // template it requires, records a `compaction.failed` row and ends the
            // turn with idle outcome=failed. Measured on the real host, a session
            // whose hook declined produced a failed compaction and no provider
            // request at all on every turn after the first. When the module has
            // served nothing yet there is no module baseline to answer with, so the
            // TypeScript one is supplied instead: still Magic Context's own account
            // of the session, rather than a host-composed summary of history the
            // module never served, or a dead turn.
            const source = !rustModeModuleClient
                ? "typescript"
                : moduleBaseline === null
                  ? "typescript_fallback"
                  : "module";
            if (nativeFoldReplay) {
                try {
                    if (await nativeFoldReplay.canReplay(draft.sessionID, reader)) {
                        const state = getOrCreateSessionMeta(storage.require(), draft.sessionID);
                        const summary =
                            moduleBaseline ??
                            (await nativeFoldReplay.baseline(draft.sessionID)) ??
                            state.cachedM0Bytes?.toString("utf8") ??
                            "<session-history></session-history>";
                        if (
                            await nativeFoldReplay.supply({
                                draft,
                                reader,
                                previousCut: reader.latestCompaction(draft.sessionID),
                                summary,
                            })
                        ) {
                            draft.result = { summary };
                            return;
                        }
                    }
                } catch (error) {
                    nativeFoldReplay.invalidate(draft.sessionID, true);
                    sessionLog(
                        draft.sessionID,
                        `v2 host fold: legacy compaction reason=${JSON.stringify(String(error))}`,
                    );
                }
            }
            const fold = await folds.supply({
                sessionID: draft.sessionID,
                watermark,
                runningCut: running?.seq,
                // Kept lazy for the TypeScript lane: materializing writes cache state and
                // must only happen when the fold identity is actually new.
                materialize: () => moduleBaseline ?? materialize(draft),
            });
            // One line per request with the baseline it was answered from. The
            // host's rate and ours are separate facts, and only reading both
            // explains a session's checkpoint cadence.
            sessionLog(draft.sessionID, `v2 compaction hook: fired answered=true source=${source}`);
            draft.result = { summary: fold.submitted };
        } catch (cause) {
            await refuseBeforeProvider(context.session, draft.sessionID, "compaction-fold", cause);
            throw new V2ContextRefusal("Magic Context could not preserve the host checkpoint.", {
                cause,
            });
        } finally {
            reader.close();
        }
    });
    // Which stored message times a pass reads. With temporal awareness on, every
    // message carries its time, as before: temporal markers render from them.
    // With it off, TypeScript mode still needs a few, as OpenCode 1 messages
    // always carry them: the saved last good request finds its anchor from the
    // latest assistant message's time (and, while that message is still
    // working, the times of the user messages after it). Only the latest
    // assistant message and the messages after it are read, and their times
    // are kept out of the content digests (see adaptPayload), so the
    // saved copy and its replay compare the same bytes whichever messages the
    // rule picked. Rust mode reads times only for temporal awareness.
    const temporalTimes = config.temporal_awareness === true;
    const anchorTimesOnly = !temporalTimes && !rustModeModuleClient;
    /** The ids of the messages whose stored times this pass reads. */
    const timeIds = (messages: readonly V2Message[]): string[] => {
        if (temporalTimes) return messages.flatMap((message) => (message.id ? [message.id] : []));
        if (!anchorTimesOnly) return [];
        // From the newest message back to the latest assistant message.
        const ids: string[] = [];
        for (const message of [...messages].reverse()) {
            if (message.id) ids.push(message.id);
            if (message.role === "assistant") break;
        }
        return ids;
    };
    /**
     * The messages a pass works on after a local host checkpoint: the covered
     * instruction rows, the stored rows from the history boundary up to the
     * checkpoint, then the host's own messages without the checkpoint. Reads
     * only, so a replay can build the same transform input the managed pass
     * builds and compare the saved copy against it.
     */
    const restoreAfterCheckpoint = (args: {
        db: NonNullable<typeof db>;
        reader: V2StoreReader;
        draft: SessionContext;
        messages: V2Message[];
        cut: NonNullable<ReturnType<V2StoreReader["latestCompaction"]>>;
        incoming: V2Message;
        boundaryRepair: HistoryBoundaryRepair | undefined;
    }): V2Message[] => {
        const { db, reader, draft, cut, boundaryRepair } = args;
        // Rust mode restores against the boundary the module itself published and
        // keeps that boundary row, because the array handed to the module has to
        // begin there — exactly where an OpenCode 1 compaction row would have made
        // the host begin it. TypeScript mode restores after its own m0 baseline.
        const moduleBoundaryID = rustModeModuleClient
            ? (getPersistedCompactionMarkerState(db, draft.sessionID)?.boundaryMessageId ?? null)
            : null;
        const moduleBoundarySeq = moduleBoundaryID
            ? reader.sequenceForId(draft.sessionID, moduleBoundaryID)
            : undefined;
        // After a boundary repair the cached prefix is gone and this pass
        // rebuilds it against the anchor, so restore from the anchor: the
        // same rows every later pass restores from the rebuilt baseline.
        const boundaryID =
            (
                db
                    .prepare(
                        "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
                    )
                    .get(draft.sessionID) as { id: string | null } | null
            )?.id ??
            (boundaryRepair?.kind === "repaired" || boundaryRepair?.kind === "baseline-reset"
                ? boundaryRepair.anchorEndMessageId
                : null);
        // Restore only rows after the cached message prefix and before the host
        // checkpoint; older rows are already present in the cached messages. The
        // first fold has no cached prefix, so it starts immediately before the
        // first retained seq instead of using an unbounded seq-zero scan.
        // A boundary on a row the host never serves by id (an instruction
        // update) stands for the nearest earlier served row. Restoring from
        // that row keeps the unserved rows after it in the raw tail, the
        // same cut the transform's trim makes, so a priced pass and the
        // defers after it restore identical rows.
        const servedBoundary = boundaryID
            ? servedBoundaryRow(reader, draft.sessionID, boundaryID)
            : null;
        const boundary =
            // A changed hidden row may have lived inside the frozen
            // prefix. Make it available to the shared-path rebuild too.
            (nativeFoldReplay?.sourceChanged(draft.sessionID) && !rustModeModuleClient
                ? (reader.earliestSequence(draft.sessionID) ?? 0) - 1
                : undefined) ??
            (moduleBoundarySeq !== undefined ? moduleBoundarySeq - 1 : undefined) ??
            servedBoundary?.seq ??
            reader.sequenceForId(draft.sessionID, boundaryID) ??
            (reader.earliestSequence(draft.sessionID) ?? 0) - 1;
        if (moduleBoundarySeq !== undefined)
            sessionLog(
                draft.sessionID,
                `v2 restore: from the module boundary ${moduleBoundaryID} to the host checkpoint`,
            );
        const present = new Set(args.messages.map((message) => message.id));
        const restored = restoredRows
            .rows(reader, draft.sessionID, boundary, cut.seq)
            .filter((row) => !present.has(row.id))
            .flatMap((row) =>
                restoreRow(
                    row,
                    draft.model,
                    hostUsesMediaAssets()
                        ? {
                              asset: hostMediaAsset,
                              unavailable: (detail) =>
                                  sessionLog(
                                      draft.sessionID,
                                      `v2 restore: attachment replaced by a note row=${detail.rowID} name=${JSON.stringify(detail.name ?? null)} mediaType=${detail.mediaType} reason=${JSON.stringify(detail.reason)}`,
                                  ),
                          }
                        : undefined,
                ),
            );
        return [
            // Instruction rows the history boundary covers come first,
            // in store order; the transform decides whether they are
            // served. Rust mode's module owns its own boundary.
            ...(rustModeModuleClient
                ? []
                : coveredInstructionRows(
                      reader,
                      draft.sessionID,
                      Math.min(boundary, cut.seq),
                      draft.model,
                  )),
            ...restored,
            ...args.messages.filter((message) => message !== args.incoming),
        ];
    };
    // Construct retained callbacks outside the request scope. Even callbacks that
    // only read instance state can keep a shared closure environment alive, along
    // with replay helpers that hold the request's messages and attachments.
    const initializeTransform = (database: NonNullable<typeof db>) =>
        (transform ??= createTransform({
            ...createV2TransformFeatureDeps(
                config,
                compactionOff,
                directory,
                embeddings.ensureRegistered,
            ),
            cacheTtlConfig: config.cache_ttl,
            cacheTtlConfigured: config.cacheTtlConfigured,
            sampleCacheTtlConfig: () => liveConfigReader.poll().effective,
            db: database,
            tagger,
            ...createV2ThresholdDeps(config),
            contextUsageMap: usage,
            compactionOff,
            // OpenCode 2 reads `session_message`, which numbers the same
            // conversation differently from the v1 tables a converted store
            // still carries.
            storeGeneration: "v2",
            // The host stores copied `§N§` notation unchanged (no hook runs before
            // it writes a finished reply), so assistant text restored from a saved
            // source copy gets the same strip `adaptPayload` gives the live text.
            normalizeRestoredAssistantText: (text, providerID) =>
                stripCopiedTagNotation(text, providerID === "anthropic"),
            refreshSourceContents: (sessionID) =>
                nativeFoldReplay?.needsHeadRebuild(sessionID) ?? false,
            // OpenCode 2 owns its native checkpoints; this adapter never writes the
            // OpenCode 1 synthetic marker rows that the shared off-transition deletes.
            hostCleanupCompactionMarkers: () => ({
                verified: true,
                removedLineages: 0,
                removedRows: 0,
                retainedLineages: 0,
            }),
            protectedTokens: config.protected_tokens,
            protectedTokenTierOverrides: getProtectedTokensTierOverrides(config),
            liveModelBySession: liveModels,
            getToolSetHash: (sessionId) => {
                const model = liveModels.get(sessionId);
                if (!model) return "";
                return getCurrentToolSetHash(
                    model.providerID,
                    model.modelID,
                    agents.get(sessionId),
                    sessionId,
                );
            },
            channel1StateBySession: channel1,
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId,
            commitSeenLastPass,
            variantBySession: variants,
            keepReasoningTokens: config.keep_reasoning_tokens,
            directory,
            sessionDirectoryBySession: sessionDirectories,
            projectPath: resolveProjectIdentityForSession(directory, config.allow_home_project),
            getHistorianChunkTokens: () => sampleHistorian().chunkTokens,
            getFallbackModelId: (sessionID) => {
                const model = liveModels.get(sessionID);
                return model ? `${model.providerID}/${model.modelID}` : undefined;
            },
            maybeAutoEmbedSession: createV2AutoEmbedSession(
                {
                    db: database,
                    resolveDirectory: (sessionID) => sessionDirectories.get(sessionID) ?? directory,
                    allowHomeProject: config.allow_home_project,
                    recompProgressBySession: new Map(),
                },
                embeddings.ensureRegistered,
            ),
            hiddenCompletionExecutor,
            historianRunnable:
                !compactionOff &&
                hiddenCompletionExecutor !== undefined &&
                config.historian?.disable !== true,
            historianModel: historianModels.primary,
            historianContextLimit: sampleHistorian().contextLimit,
            fallbackModels: historianModels.fallbacks,
            resolveHistorianRun: sampleHistorian,
            historianTimeoutMs: config.historian_timeout_ms,
            // Raw config on purpose: absent means the user configured no
            // output cap, and the hidden carrier only puts a cap on the wire
            // when one was configured. The producer-window arithmetic applies
            // its own default, so no fallback belongs here.
            historianMaxOutputTokens: config.historian?.maxTokens,
            historianTwoPass: config.historian?.two_pass,
            historianExpandTools: config.historian?.expand_tools,
            historianRunner: config.historian?.runner,
            historianHostRunnerEnabled: config.historian?.host_runner?.enabled,
            // TypeScript mode folds on the host's own compaction rows, so its marker
            // carrier stays inert. Rust mode has no such row to write: the module's
            // materialized boundary is recorded in the marker columns instead, and
            // the compaction hook above answers the host from it.
            compactionMarkerStrategy: rustModeModuleClient
                ? createV2RustCompactionMarkerStrategy((sessionID, endMessageID) => {
                      const reader = openStoreReader();
                      try {
                          return resolveV2BoundaryUserMessage(reader, sessionID, endMessageID);
                      } finally {
                          reader.close();
                      }
                  })
                : v2CompactionMarkerStrategy,
            transformMode: config.transform_mode,
            rustModeModuleClient,
            rustModeProjectRoot: directory,
            rustMemorySyncRequestedSessions,
            // OpenCode 1 puts this on the host's toast surface through its SDK
            // client. This host exposes no such client to a plugin, so it goes
            // out on the notification socket the TUI already reads — the same
            // carrier a finished dream reports on. Without it a parked module
            // is invisible: the session keeps answering from the last good
            // output and nothing says why it stopped moving.
            onRustModeParked: (sessionId, message) =>
                pushNotification(
                    "toast",
                    {
                        message: `Rust Magic Context paused: ${message}`,
                        variant: "warning",
                    },
                    sessionId,
                ),
            promptSurface: config.prompt_surface,
            promptSurfaceRuntime,
            onRustEngineReconnectRefusal: (refusal) => rustRefusalRecovery?.arm(refusal),
            ...createHostSeams(context, readAllForConversion, pagedRead, liveModels),
        }));
    const runManagedContext = async (draft: SessionContext): Promise<void> => {
        // Learn the host's message and attachment classes, so attachments on rows restored
        // after a host checkpoint can be rebuilt in the host's own shape.
        rememberHostMedia(draft.messages);
        if (hiddenChildHook.apply(draft)) return;
        // A dreamer that was off at boot and has since been turned on in the
        // config starts here; startDreamer stays a no-op while it is off.
        if (dreamTrigger === undefined && hiddenCompletionExecutor !== undefined)
            dreamTrigger = startDreamer(hiddenCompletionExecutor);
        removeDreamerOnlyTools(draft);
        // A deletion that races an in-flight pass must not let that pass rebuild
        // the state just cleared by the one deletion event.
        if (deletedSessions.has(draft.sessionID)) return;
        const systemAtEntry = structuredClone(draft.system);
        const slotAtEntry = getSlot(draft.sessionID);
        // The host checkpoint message this pass's transform input was restored
        // from (null when there is none), known once that input has been built.
        // A saved request replays only for the checkpoint it was built after.
        let checkpointAtEntry: V2Message | null | undefined;
        // Set when a replay is served: the checkpoint head saved with it.
        let replayHead: V2LkgCheckpointHead | null | undefined;
        const hostInput = (): V2LkgHostInput | undefined =>
            checkpointAtEntry === undefined
                ? undefined
                : { system: systemAtEntry, checkpoint: checkpointAtEntry };
        const restoreLkgSystem = () => {
            retirePendingSystemPromptDelivery(draft.sessionID);
            const input = hostInput();
            const restored =
                input &&
                lkgSystems.restore(draft.sessionID, getSlot(draft.sessionID), input, draft.system);
            if (!restored) {
                sessionLog(draft.sessionID, "lkg_system_state_mismatch");
                throw new Error("LKG system identity is unavailable or changed");
            }
            replayHead = restored.head;
        };
        const isMagicContextSynthetic = (id: string) =>
            isAdmittedSynthetic(context, draft.sessionID, id);
        // Storing a notice in an idle OpenCode 2 session starts a turn of its own.
        // Such a turn has nothing for the model to answer, so it ends here.
        const newest = draft.messages.at(-1);
        if (
            newest &&
            hasStorageNoticeShape(newest) &&
            (await isMagicContextSynthetic(newest.id as string))
        ) {
            await refuseBeforeProvider(context.session, draft.sessionID, "storage-notice-turn");
            return;
        }
        // Storage notices are for the user and never reach the model. Dropping them
        // on every pass, from the first one that could contain them, keeps the
        // served bytes the same whether or not a session ever had one.
        await dropStorageNotices(draft.messages, isMagicContextSynthetic);
        // The host's messages as this pass received them. A replay rebuilds the
        // transform input from these, never from a draft a failed pass reshaped.
        const hostMessagesAtEntry = [...draft.messages];
        // Retries share one timing snapshot. Across passes, settled rows reuse
        // their times only after a current membership and revision check.
        const cachedTimes = messageTimesCache.pass(draft.sessionID);
        const readTimes = (reader: V2StoreReader, messages: readonly V2Message[]) => {
            return cachedTimes(reader, timeIds(messages));
        };
        liveModels.set(draft.sessionID, {
            providerID: draft.model.providerID,
            modelID: draft.model.id,
        });
        variants.set(draft.sessionID, draft.model.variant);
        if (!modelLimitCacheWarm())
            void withoutSqliteTransformPass(() => warmModelLimitCacheFromCatalog(context));
        agents.set(draft.sessionID, draft.agent);
        // Per-model descriptions are applied to this request's draft only.
        // `context.tool.transform` must never be called from here: the host keeps
        // every registration for the life of the process, so one call per pass
        // grows host state without bound and a light-preset session's shortened
        // descriptions become the baseline every later request (any session,
        // any model) starts from. Registration happens once, in tools.ts.
        applyV2PromptSurfaceTools(
            draft,
            promptSurfaceRuntime,
            config.prompt_surface,
            // A disabled dreamer cannot evaluate smart notes, so ctx_note loses
            // its smart-note text exactly as with smart_notes.enabled=false.
            isSmartNoteSurfaceAvailable(config),
        );
        const admissionDb = db ?? storage.current();
        const replayFits: NonNullable<
            Parameters<typeof tryMessagesTransformLkgReplay>[0]["replayFits"]
        > = (messages) => {
            // Every recovery path fits this draft's tools and the system paired
            // with the saved messages, never the previous turn's tool counts.
            // The pairing is looked up by the system the host sent: by the time
            // a pass fails inside the transform, draft.system already carries
            // Magic Context's own guidance and never equals the saved input.
            const system: SessionContext["system"] = [];
            const input = hostInput();
            if (
                !admissionDb ||
                !draft.tools ||
                !input ||
                !lkgSystems.restore(draft.sessionID, getSlot(draft.sessionID), input, system)
            )
                return false;
            const limit = lkgReplayLimit({
                db: admissionDb,
                sessionId: draft.sessionID,
                model: {
                    providerID: draft.model.providerID,
                    modelID: draft.model.id,
                },
                modelKey: `${draft.model.providerID}/${draft.model.id}`,
            });
            if (limit === undefined) return false;
            let toolDefinitionTokens = 0;
            for (const tool of Object.values(draft.tools)) {
                if (!tool || typeof tool.description !== "string" || !tool.input) return false;
                const schema = JSON.stringify(tool.input);
                if (!schema) return false;
                toolDefinitionTokens += estimateTokens(tool.description) + estimateTokens(schema);
            }
            return (
                measureLkgReplay({
                    messages,
                    limit,
                    estimate: () =>
                        estimateFinalWireInputTokens({
                            messages,
                            toolDefinitionTokens,
                            systemPromptTokens: estimateTokens(JSON.stringify(system)),
                            providerID: draft.model.providerID,
                            modelID: draft.model.id,
                            agentName: draft.agent,
                        }),
                }).fit === "under"
            );
        };
        /**
         * The transform input this pass would build from the host's messages,
         * built without writing anything, for a replay that runs before the
         * pass got that far or after it failed. In TypeScript mode it is the
         * input the transform saves its copy from: the rows restored after a
         * local host checkpoint, the stored message times and the admitted
         * synthetic marks, exactly as the managed pass below builds them.
         * Rust mode keeps the host's messages unchanged, as before. Undefined
         * when no replay can match (the store is unreadable, the checkpoint is
         * missing from the draft, or the experimental native fold owns it).
         */
        const buildReplayInput = async (): Promise<
            { draft: SessionContext; mapped: ReturnType<typeof adaptPayload> } | undefined
        > => {
            let messages = [...hostMessagesAtEntry];
            const admitted = new Set<string>();
            let times: ReturnType<V2StoreReader["messageTimes"]> | undefined;
            try {
                const reader = openStoreReader();
                try {
                    const cut = reader.latestCompaction(draft.sessionID);
                    const localCut = cut && isLocalCheckpoint(cut) ? cut : undefined;
                    const incoming =
                        localCut && messages.find((message) => message.id === localCut.id);
                    if ((localCut && !incoming) || (cut && nativeFoldReplay)) return undefined;
                    checkpointAtEntry = incoming || null;
                    // A replay serves the tool list a healthy pass would serve: in a
                    // subagent session that is without the primary-only tools, which
                    // the pass removes only after writer admission. Read without
                    // writing; while the session's mode is not stored yet, no replay.
                    const modeDb = db ?? storage.current();
                    const subagent = modeDb
                        ? storedSubagentMode(modeDb, draft.sessionID)
                        : undefined;
                    if (subagent === undefined) return undefined;
                    if (subagent) removePrimaryOnlyTools(draft.tools);
                    if (!rustModeModuleClient) {
                        const candidates = syntheticCandidates(
                            context,
                            draft.sessionID,
                            reader.syntheticMessageIDs(draft.sessionID),
                        );
                        for (const message of messages)
                            if (
                                message.id &&
                                candidates.has(message.id) &&
                                (await isAdmittedSynthetic(context, draft.sessionID, message.id))
                            )
                                admitted.add(message.id);
                        const replayDb = db ?? storage.current();
                        if (localCut && incoming && replayDb)
                            messages = restoreAfterCheckpoint({
                                db: replayDb,
                                reader,
                                draft,
                                messages,
                                cut: localCut,
                                incoming,
                                boundaryRepair: undefined,
                            });
                        else if (localCut) return undefined;
                        times = readTimes(reader, messages);
                    }
                } finally {
                    reader.close();
                }
            } catch (error) {
                sessionLog(draft.sessionID, "lkg replay input unavailable", error);
                return undefined;
            }
            const replayDraft = { ...draft, messages };
            return {
                draft: replayDraft,
                mapped: adaptPayload(replayDraft, admitted, times, anchorTimesOnly),
            };
        };
        /** Serve a replay committed to a draft copy, with its saved checkpoint head. */
        const adoptReplay = (replayed: SessionContext) => {
            if (replayed !== draft)
                draft.messages.splice(0, draft.messages.length, ...replayed.messages);
            if (replayHead) applyCheckpointHead(draft, replayHead);
        };
        let postFold = false;
        try {
            // Check writer admission before best-effort setup writers can each spend
            // their own busy timeout. No transform callback runs in this transaction.
            if (!compactionOff && admissionDb)
                await withAsyncPrivilegedWriter(admissionDb, () => undefined, {
                    beforeRetry: async (error) => {
                        const input = await buildReplayInput();
                        if (!input) return;
                        const { mapped } = input;
                        if (
                            tryMessagesTransformLkgReplay({
                                output: mapped as unknown as Parameters<
                                    ReturnType<typeof createMessagesTransformHandler>
                                >[1],
                                sessionId: draft.sessionID,
                                error,
                                agent: draft.agent,
                                rust: transform?.getRustReplayParticipant() ?? undefined,
                                replayFits,
                                onLkgReplay: restoreLkgSystem,
                            })
                        ) {
                            mapped.commit();
                            adoptReplay(input.draft);
                            throw new V2LkgAdmissionReplay();
                        }
                    },
                });
            // Hidden maintenance carriers returned above with their explicit
            // allow-lists. Only this request's map changes, never registrations
            // or the primary session's cached tool definitions.
            if (admissionDb) hideSubagentTools(draft, admissionDb);
            recordV2ToolDefinitions(draft);
            // Only a failure to read or record usage refuses here. A high reading is
            // left to the transform below: its force band and emergency path are what
            // reduce an over-limit session, and refusing ahead of them would refuse
            // the same stored reading again on every later turn.
            if ((await recordUsage(draft, true)) && !compactionOff) {
                const storageReason = storage.current() ? null : storage.reason();
                if (storageReason) {
                    noticeStorageRefusal(draft.sessionID, storageReason);
                    await refuseBeforeProvider(
                        context.session,
                        draft.sessionID,
                        "storage-unavailable",
                        formatFailClosedBlockingMessage(storageReason),
                    );
                    return;
                }
                await refuseBeforeProvider(context.session, draft.sessionID, "usage-unavailable");
                return;
            }
            if (!db) return;
            if (!storageOpenedAtBoot && !storageRecoveryAnnounced) {
                storageRecoveryAnnounced = true;
                const recovered = await recoverHiddenWork(db);
                const message = formatStorageRecoveryNotice(recovered);
                log(`[magic-context] v2 storage recovered: ${message}`);
                pushNotification("toast", { message, variant: "info" }, draft.sessionID);
                storeStorageNotice(draft.sessionID, message, "recovery");
            }
            // TypeScript mode only: in Rust mode the module owns the session's
            // history and this state is not what it serves.
            if (!rustModeModuleClient && !compactionOff) inheritForkState(db, draft.sessionID);
            // OpenCode 2 exposes system and message transformation through one
            // context hook, with the system handler running first below. Rebase
            // before it so a converted session initializes the new host's prompt
            // hash instead of comparing against the previous host and arming a
            // redundant follow-up fold. The shared transform sees the new stamp
            // later in this pass and treats its own rebase call as a no-op.
            // The first request of a long session last served by OpenCode 1 does
            // real work here; the async form lets the host keep serving (Stop,
            // health checks) meanwhile, and this pass still waits for the
            // commit before it builds anything.
            try {
                await rebaseSessionCoordinatesAsync({
                    db,
                    sessionId: draft.sessionID,
                    generation: "v2",
                    readMessages: readAllForConversion,
                    readMessagePages: (sessionID) =>
                        readV2RawMessagePagesForConversion(openStoreReader, sessionID),
                });
            } catch (error) {
                sessionLog(
                    draft.sessionID,
                    "store projection rebase failed before system prompt (retrying in transform):",
                    error,
                );
            }
            systemPrompt ??= createSystemPromptHashHandler({
                db,
                dreamerEnabled: config.dreamer !== undefined && !config.dreamer.disable,
                smartNotesEnabled: config.smart_notes.enabled,
                memoryEnabled:
                    config.memory.enabled &&
                    !!resolveProjectIdentityForSession(directory, config.allow_home_project),
                language: config.language,
                promptSurface: config.prompt_surface,
                promptSurfaceRuntime,
                systemPromptRefreshSessions,
                historyRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId,
                injectionEnabled: config.system_prompt_injection.enabled,
                injectionSkipSignatures: config.system_prompt_injection.skip_signatures,
            });
            let responseAfterSequence: number | undefined;
            try {
                const responseReader = openStoreReader();
                try {
                    responseAfterSequence = responseReader.latestSequence(draft.sessionID);
                } finally {
                    responseReader.close();
                }
            } catch (error) {
                sessionLog(
                    draft.sessionID,
                    "v2 response boundary unavailable; no system delivery acknowledgement",
                    error,
                );
            }
            beginV2LkgRequest(
                draft.sessionID,
                `${draft.model.providerID}/${draft.model.id}`,
                latestLkgResponseIds.get(draft.sessionID),
                responseAfterSequence,
            );
            await applyV2SystemPrompt(systemPrompt, draft);
            await preloadTokenizer();
            passDuties ??= createChatMessageHook({
                db,
                liveModelBySession: liveModels,
                variantBySession: variants,
                agentBySession: agents,
                historyRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId,
                systemPromptRefreshSessions,
                cacheTtlConfig: config.cache_ttl,
            });
            await passDuties({
                sessionID: draft.sessionID,
                agent: draft.agent,
                variant: draft.model.variant,
                model: { providerID: draft.model.providerID, modelID: draft.model.id },
            });
            await cacheV2SessionDirectory(context.session, draft.sessionID, sessionDirectories);
            // Background historian reads outlive the context callback. Keep its source
            // registered until plugin disposal, rather than falling back to the v1 store.
            prepareHistorySession(draft.sessionID);
            transform = initializeTransform(db);
            const admitted = new Set<string>();
            let messageTimes: ReturnType<V2StoreReader["messageTimes"]> | undefined;
            const reader = openStoreReader();
            let checkpoint: SessionContext["messages"][number] | undefined;
            let submitted: string | undefined;
            try {
                const candidates = syntheticCandidates(
                    context,
                    draft.sessionID,
                    reader.syntheticMessageIDs(draft.sessionID),
                );
                for (const message of draft.messages) {
                    if (
                        message.id &&
                        candidates.has(message.id) &&
                        (await isAdmittedSynthetic(context, draft.sessionID, message.id))
                    )
                        admitted.add(message.id);
                }
                const cut = reader.latestCompaction(draft.sessionID);
                if (nativeFoldReplay) await nativeFoldReplay.observeSource(draft.sessionID, reader);
                // Before anything restores or trims against the history boundary,
                // make sure the host store still has it. Only TypeScript mode keeps
                // its boundary in the compartments this checks; Rust mode's module
                // owns its own.
                const boundaryRepair =
                    !rustModeModuleClient && db && !compactionOff
                        ? checkHistoryBoundary(db, reader, draft.sessionID)
                        : undefined;
                if (
                    boundaryRepair?.kind === "repaired" ||
                    boundaryRepair?.kind === "baseline-reset"
                ) {
                    historyRefreshSessions.add(draft.sessionID);
                    requestPendingMaterialization(
                        pendingMaterializationSessions,
                        draft.sessionID,
                        "boundary_repair",
                    );
                }
                // Provider-native windows have already been selected by the host for
                // this model. They need not carry the checkpoint id and must not be
                // replaced with locally reconstructed history.
                const localCut = cut && isLocalCheckpoint(cut) ? cut : undefined;
                const incoming =
                    localCut && draft.messages.find((message) => message.id === localCut.id);
                postFold = cut !== undefined;
                if (localCut && !incoming)
                    throw new Error("The host checkpoint disappeared from the context draft");
                checkpointAtEntry = incoming || null;
                let nativeRestored: V2Message[] | undefined;
                // Validate fold provenance before the cache path or its raw-row
                // fallback can invisibly replace the checkpoint. Without a valid
                // local admission, use ordinary managed-history reconstruction instead.
                if (
                    cut &&
                    nativeFoldReplay &&
                    (await nativeFoldReplay.admits(draft.sessionID, cut, reader))
                ) {
                    try {
                        nativeRestored = await nativeFoldReplay.restore(
                            draft.sessionID,
                            cut,
                            `${draft.model.providerID}/${draft.model.id}`,
                            { bounded: !rustModeModuleClient },
                        );
                    } catch (error) {
                        nativeFoldReplay.invalidate(draft.sessionID, true);
                        sessionLog(
                            draft.sessionID,
                            "v2 host fold: cache unavailable; restoring host rows",
                            error,
                        );
                        nativeRestored = await nativeFoldReplay.restoreRead(
                            draft.sessionID,
                            cut,
                            draft.model,
                        );
                    }
                }
                if (cut && nativeFoldReplay?.sourceChanged(draft.sessionID)) {
                    // Durable provenance no longer matches the host's pre-checkpoint
                    // rows. Its cached raw prefix is obsolete even with no compartments.
                    // Expire it rather than render here: first_render must execute
                    // in the shared transform and open its normal mutation/drain gate.
                    if (
                        db &&
                        !rustModeModuleClient &&
                        nativeFoldReplay.needsHeadRebuild(draft.sessionID)
                    )
                        clearCachedM0(db, draft.sessionID);
                    if (nativeFoldReplay.needsHeadRebuild(draft.sessionID))
                        restoredRows.forget(draft.sessionID);
                    // A host edit or revert changed the restored history, so the
                    // ordinary transform may rebuild the history head (the
                    // <session-history> block in the first head message). Each rebuild
                    // changes the request prefix and invalidates the provider's prompt
                    // cache, so pending operations (queued drops and heuristic
                    // cleanup) are flagged to apply in that same pass rather than
                    // causing a second cache rebuild later.
                    historyRefreshSessions.add(draft.sessionID);
                    requestPendingMaterialization(
                        pendingMaterializationSessions,
                        draft.sessionID,
                        "host_history_change",
                    );
                }
                if (cut && incoming && nativeRestored) {
                    const present = new Set(
                        draft.messages.flatMap((message) => (message.id ? [message.id] : [])),
                    );
                    const hidden = nativeRestored.filter((message) => {
                        const id = nativeRowID(message);
                        return !id || !present.has(id);
                    });
                    draft.messages.splice(
                        0,
                        draft.messages.length,
                        ...hidden,
                        ...draft.messages.filter((message) => message !== incoming),
                    );
                } else if (localCut && cut && incoming) {
                    // A checkpoint without native replay admission still uses our
                    // ordinary host-row reconstruction below. Let the transform
                    // render or reuse the history head from our compartments, so
                    // any rebuild opens the same mutation/drain gate as other folds.
                    // Keep FoldOwner's host wrapper out of this path: its serialized
                    // raw context can already be covered by the compartments.
                    if (!nativeFoldReplay) {
                        const identity = await folds.observe({
                            sessionID: draft.sessionID,
                            cutSeq: cut.seq,
                            summary: cut.data.summary ?? "",
                            rendered: incoming,
                            onHard: (reason) => {
                                sessionLog(draft.sessionID, `HARD reason=${reason}`);
                                materialize(draft);
                                requestPendingMaterialization(
                                    pendingMaterializationSessions,
                                    draft.sessionID,
                                    "host_compaction",
                                );
                            },
                        });
                        checkpoint = structuredClone(identity.rendered ?? incoming);
                        submitted = identity.rendered
                            ? (identity.renderedSummary ?? identity.submitted)
                            : (cut.data.summary ?? "");
                    }
                    draft.messages.splice(
                        0,
                        draft.messages.length,
                        ...restoreAfterCheckpoint({
                            db,
                            reader,
                            draft,
                            messages: draft.messages,
                            cut: localCut,
                            incoming,
                            boundaryRepair,
                        }),
                    );
                }
                messageTimes = readTimes(reader, draft.messages);
            } finally {
                reader.close();
            }
            // On a turn the host did not compact, the array still starts at the top
            // of the conversation, and the module would be handed the whole history
            // again — the cost the fold exists to remove. On a turn it did compact,
            // the boundary message is already gone from the array and this is a
            // no-op. Both happen in an ordinary session.
            if (rustModeModuleClient && db) {
                const dropped = trimToRecordedBoundary(db, draft.sessionID, draft.messages);
                if (dropped > 0)
                    sessionLog(
                        draft.sessionID,
                        `v2 boundary trim: dropped ${dropped} messages before the module boundary`,
                    );
            }
            let nativeMessages: V2Message[] | undefined;
            if (nativeFoldReplay) {
                try {
                    nativeMessages = copyNativeInput(draft.messages);
                } catch {
                    nativeFoldReplay.invalidate(draft.sessionID, true);
                }
            }
            const mapped = adaptPayload(draft, admitted, messageTimes, anchorTimesOnly);
            bindSystemDateRequestIdentity(mapped, draft);
            await createMessagesTransformHandler({
                magicContext: { "experimental.chat.messages.transform": transform },
                compactionOff,
                replayFits,
                onLkgReplay: restoreLkgSystem,
                rustReplayParticipant: () => transform?.getRustReplayParticipant() ?? null,
            })(
                {},
                mapped as unknown as Parameters<
                    ReturnType<typeof createMessagesTransformHandler>
                >[1],
            );
            mapped.commit();
            // Keep the transform decision this pass staged (if any) together with
            // the store sequence captured before the request; the next pass binds it
            // to the reply written after that sequence.
            stageOpenCodeV2TransformDecision({
                sessionId: draft.sessionID,
                responseAfterSequence,
            });
            if (db) {
                await deliverPendingChannel2(
                    context,
                    db,
                    draft.sessionID,
                    channel1.get(draft.sessionID),
                );
            }
            // A replayed request gets the checkpoint head it was served with;
            // any other pass gets the one it worked out from its own checkpoint.
            const head =
                replayHead !== undefined
                    ? replayHead
                    : checkpoint && submitted !== undefined
                      ? { checkpoint, submitted }
                      : null;
            const servedHead = head && structuredClone(head);
            const headApplied = head ? applyCheckpointHead(draft, head) : false;
            if (nativeMessages && !checkpoint) {
                try {
                    await nativeFoldReplay?.capture(draft, nativeMessages);
                } catch (error) {
                    nativeFoldReplay?.invalidate(draft.sessionID, true);
                    sessionLog(
                        draft.sessionID,
                        "v2 host fold: optional capture unavailable",
                        error,
                    );
                }
            }
            const capturedSlot = getSlot(draft.sessionID);
            if (
                capturedSlot &&
                (!slotAtEntry ||
                    capturedSlot.capturedAt !== slotAtEntry.capturedAt ||
                    capturedSlot.captureSequence !== slotAtEntry.captureSequence ||
                    capturedSlot.jsonPrefix !== slotAtEntry.jsonPrefix)
            ) {
                lkgSystems.capture(
                    draft.sessionID,
                    capturedSlot,
                    { system: systemAtEntry, checkpoint: checkpointAtEntry ?? null },
                    draft.system,
                    headApplied ? servedHead : null,
                );
            }
        } catch (error) {
            if (error instanceof V2LkgAdmissionReplay) return;
            if (error instanceof V2ContextRefusal) throw error;
            if (
                !compactionOff &&
                (isTransientSqliteError(error) || error instanceof StorageBusyRefusalError)
            ) {
                if (isTransientSqliteError(error)) {
                    // Rebuild the input from the host's own messages: the failed pass
                    // may have stopped anywhere, after restoring rows or not.
                    const input = await buildReplayInput();
                    try {
                        if (!input) throw new StorageBusyRefusalError(error, "v2-context");
                        const { mapped } = input;
                        await createMessagesTransformHandler({
                            replayFits,
                            onLkgReplay: restoreLkgSystem,
                            rustReplayParticipant: () =>
                                transform?.getRustReplayParticipant() ?? null,
                            magicContext: {
                                "experimental.chat.messages.transform": async () => {
                                    throw error;
                                },
                            },
                        })(
                            {},
                            mapped as unknown as Parameters<
                                ReturnType<typeof createMessagesTransformHandler>
                            >[1],
                        );
                        mapped.commit();
                        adoptReplay(input.draft);
                        return;
                    } catch (replayError) {
                        if (!(replayError instanceof StorageBusyRefusalError)) throw replayError;
                    }
                }
                const refusal =
                    error instanceof StorageBusyRefusalError
                        ? error
                        : new StorageBusyRefusalError(error, "v2-context");
                pushNotification(
                    "toast",
                    { message: STORAGE_BUSY_MESSAGE, variant: "error" },
                    draft.sessionID,
                );
                storeStorageNotice(
                    draft.sessionID,
                    `${STORAGE_NOTICE_PREFIX}${STORAGE_BUSY_MESSAGE}`,
                    "busy",
                );
                await refuseBeforeProvider(
                    context.session,
                    draft.sessionID,
                    "storage-busy",
                    refusal,
                );
                throw new V2ContextRefusal(STORAGE_BUSY_MESSAGE, { cause: refusal });
            }
            // Failures before the shared wrapper (for example adapting host
            // history) also cannot hand the provider an unmanaged draft.
            const managedError =
                !compactionOff && !isBlockingV2TransformError(error)
                    ? new DegradedPassRefusalError("v2-context-failed", { cause: error })
                    : error;
            if (isBlockingV2TransformError(managedError)) {
                // These errors mean the shared transform cannot prove a safe prompt.
                // Native compaction owns recovery when Magic Context compaction is off.
                if (!compactionOff) {
                    // The host records an interrupted turn without its reason, so
                    // say on the TUI's notification channel what the user can do.
                    if (
                        managedError instanceof UnresolvedHistoryBoundaryError ||
                        managedError instanceof UnmanagedOverWindowError ||
                        managedError instanceof DegradedPassRefusalError
                    ) {
                        pushNotification(
                            "toast",
                            { message: managedError.message, variant: "error" },
                            draft.sessionID,
                        );
                    }
                    await refuseBeforeProvider(
                        context.session,
                        draft.sessionID,
                        "blocking-transform-error",
                        managedError,
                    );
                    throw new V2ContextRefusal("Magic Context refused to send an unsafe prompt.", {
                        cause: managedError,
                    });
                }
                log("[magic-context] compaction-off: fail-closed inert, passing through", error);
            } else if (postFold) {
                await refuseBeforeProvider(
                    context.session,
                    draft.sessionID,
                    "post-fold-restore",
                    error,
                );
                throw new V2ContextRefusal(
                    "Magic Context could not restore the unarchived host history.",
                    { cause: error },
                );
            } else {
                // Another plugin can poison the shared draft. Do not fail an otherwise viable turn.
                log("[magic-context] v2 context unavailable", error);
            }
        }
    };
    await context.session.hook("context", (draft) =>
        withSqliteTransformPass(async () => {
            const anchor = generateReplayAnchor(draft.messages);
            await runManagedContext(draft);
            // The shared last-good-request slot is saved before m[0] is replaced
            // by a host checkpoint message. Save the final message array here
            // so side questions reuse the exact history handed back to the host.
            if (!compactionOff) generateReplay.capture(draft, anchor);
            else
                sessionLog(draft.sessionID, "generate replay capture skipped: compaction-disabled");
        }),
    );
    await context.session.hook("generate", async (draft) => {
        if (!compactionOff && !deletedSessions.has(draft.sessionID)) generateReplay.apply(draft);
    });
    // Warm eagerly for cold sidebar/status reads; a failed startup warm releases
    // its latch and the context hook above retries after the host catalog settles.
    void withoutSqliteTransformPass(() => warmModelLimitCacheFromCatalog(context));
    // OpenCode 2 never runs the v1 server() lane. Start the RPC surface here so
    // the terminal TUI can read the v2 lane's draft-authoritative session state.
    const rpcLiveSessionState = createV2RpcLiveSessionState({
        liveModelBySession: liveModels,
        variantBySession: variants,
        agentBySession: agents,
        channel1StateBySession: channel1,
        historyRefreshSessions,
        pendingMaterializationSessions,
        systemPromptRefreshSessions,
        sessionDirectoryBySession: sessionDirectories,
    });
    const storageDir = getMagicContextStorageDir();
    const rpcServer = new MagicContextRpcServer(storageDir, directory);
    let rpcStopped = false;
    registerRpcHandlers(rpcServer, {
        directory,
        config,
        client: undefined,
        liveSessionState: rpcLiveSessionState,
        getDatabase: () => {
            try {
                return storage.require();
            } catch {
                return null;
            }
        },
        rustModeModuleClient,
        hiddenCompletionExecutor: storageOpenedAtBoot
            ? hiddenCompletionExecutor
            : lateHiddenExecutor,
        compactionMarkerStrategy: v2CompactionMarkerStrategy,
        prepareHistorySession,
        readSessionDirectory: async (sessionID) => {
            try {
                return (await context.session.get({ sessionID })).location?.directory ?? null;
            } catch {
                return null;
            }
        },
        storageDir,
        getDebugMemoryHolders: () => ({ generateReplay: generateReplay.stats() }),
    });
    // The v2 TUI reaches manual dreaming through RPC because this host has no
    // command-template path. The run continues in the background and reports its
    // result through the notification socket.
    rpcServer.handle("dream", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        // Read per request: `dreamer.disable` takes effect without a restart.
        const manualDreamer = config.dreamer && !dreamerDisabledNow() ? config.dreamer : undefined;
        if (!manualDreamer || !hiddenCompletionExecutor) {
            pushNotification(
                "toast",
                { message: "Dreaming is not configured for this project.", variant: "warning" },
                sessionId,
            );
            return { ok: false, error: "dreamer unavailable" };
        }
        const requested = resolveManualDreamTask(params.task);
        if (requested.error) {
            pushNotification("toast", { message: requested.error, variant: "warning" }, sessionId);
            return { ok: false, error: requested.error };
        }
        try {
            db = storage.require();
        } catch {
            const reason = storage.reason();
            pushNotification(
                "toast",
                {
                    message: `Dreaming is unavailable: ${reason ? formatFailClosedBlockingSummary(reason) : "context storage is not durable."}`,
                    variant: "error",
                },
                sessionId,
            );
            return { ok: false, error: "storage unavailable" };
        }
        const runDb = db;
        const runExecutor = hiddenCompletionExecutor;
        void runManualDreamNow({
            db: runDb,
            dreamer: manualDreamer,
            smartNotesEnabled: config.smart_notes.enabled,
            memoryEnabled: config.memory.enabled,
            projectIdentity:
                resolveProjectIdentityForSession(directory, config.allow_home_project) ?? "",
            directory,
            language: config.language,
            mural: config.mural,
            executor: runExecutor,
            sessionId,
            ...(requested.task !== undefined ? { task: requested.task } : {}),
        })
            .then(({ summary, unsupportedTasks }) => {
                // When an explicitly requested task is unsupported, omit the
                // otherwise misleading "No enabled dream tasks" empty summary.
                const hasSummaryContent =
                    summary.ran.length > 0 ||
                    summary.failed.length > 0 ||
                    summary.skippedNoWork.length > 0 ||
                    (summary.skipped?.length ?? 0) > 0 ||
                    summary.deferredBusy.length > 0 ||
                    Object.keys(summary.backlogBefore ?? {}).length > 0 ||
                    Object.keys(summary.backlogAfter ?? {}).length > 0;
                const message = [
                    hasSummaryContent || unsupportedTasks.length === 0
                        ? summarizeManualDream(summary)
                        : undefined,
                    unsupportedTasks.length > 0
                        ? [
                              renderUserFacingFailure("dream_task_needs_tool_loop", "plain"),
                              formatUnsupportedDreamTasks(
                                  unsupportedTasks,
                                  userFacingFailureCode("dream_task_needs_tool_loop"),
                              ),
                          ].join("\n")
                        : undefined,
                ]
                    .filter((line) => line !== undefined)
                    .join("\n\n");
                pushNotification(
                    "action",
                    {
                        action: "show-result-dialog",
                        title: "Magic Context dream run",
                        message,
                    },
                    sessionId,
                );
            })
            .catch((error) => {
                pushNotification(
                    "toast",
                    { message: `Dream run failed: ${getErrorMessage(error)}`, variant: "error" },
                    sessionId,
                );
            });
        return { ok: true };
    });
    // Server-side command registration: this is what makes /ctx-* reachable from
    // `opencode run`, the HTTP API and Desktop rather than only from the terminal
    // UI's own keymap.
    await registerV2Commands({
        command: context.command,
        rpc: rpcServer,
        directory,
        compactionEnabled: !compactionOff,
    });
    // Start the RPC server asynchronously after plugin construction returns so
    // Bun.serve and its discovery-file write do not consume the host's deadline.
    inRootAsyncContext(() =>
        setTimeout(() => {
            if (rpcStopped) return;
            void rpcServer
                .start()
                .catch((error) => log("[magic-context] v2 RPC server failed to start", error));
        }, 0),
    );
    return {
        async dispose() {
            messageTimesCache.clear();
            usageController.abort();
            // OpenCode 2 runs this disposer before it removes this instance's hooks
            // (scope finalizers run in reverse registration order, and the disposer
            // is added after setup has registered them), and loads the replacing
            // instance only afterwards. Cancelling hidden runs first interrupts their
            // children while this instance still shapes their turns, so no step of
            // them reaches the new instance, which has no record of their prompts.
            // The disposer cannot wait for those runs to finish instead: the host
            // holds every new session drain until the reload completes.
            await hiddenCompletionExecutor?.dispose();
            await usageDone;
            rpcStopped = true;
            rpcServer.stop();
            transform?.disposeRust();
            tools?.dispose();
            deletedSessions.clear();
            await dreamTrigger?.dispose();
            await maintenanceTimer?.dispose();
            await embeddings.dispose();
            for (const release of rawProviders.values()) release();
            rawProviders.clear();
            restoredRows.clear();
            // A cancelled run still holds the pool until its caller closes it. Wait
            // briefly so that usually completes here; otherwise the pool closes when
            // the last hold is released, and the reload is not kept waiting for it.
            if (!(await readerPool.closeWhenIdle(STORE_POOL_DISPOSE_WAIT_MS)))
                log(
                    `[magic-context] v2 store reader pool still held by ${readerPool.holdCount()} hidden run(s) at dispose; it closes when they finish`,
                );
            clearSyntheticCandidates(context);
        },
    };
}

import {
    clearPendingMaterialization,
    requestPendingMaterialization,
} from "../../hooks/magic-context/pending-materialization";
import {
    bindSystemDateOutput,
    bindSystemDateRequestIdentity,
    registerSystemDateRefresh,
} from "../../hooks/magic-context/system-date-refresh";
import { inRootAsyncContext } from "../../shared/sqlite";
