import { COMPACTION_ENABLED_PATH } from "../../config/agent-disable";
import type { DreamerConfig, MagicContextConfig } from "../../config/schema/magic-context";
import { summarizeManualDream } from "../../features/magic-context/dreamer/manual-summary";
import {
    getFailingDreamTasks,
    getSkippedDreamTasks,
} from "../../features/magic-context/dreamer/storage-task-schedule";
import { getDreamTaskBacklogs } from "../../features/magic-context/dreamer/task-gates";
import {
    CANONICAL_DREAM_TASKS,
    type DreamTaskFailureState,
    type DreamTaskName,
    formatDreamTaskBacklogs,
    isCanonicalDreamTask,
} from "../../features/magic-context/dreamer/task-registry";
import type { ManualRunResult } from "../../features/magic-context/dreamer/task-scheduler";
import { parseRescoreCommand } from "../../features/magic-context/rescore-service";
import { getCompartments, getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { sessionLog } from "../../shared";
import type { MagicContextBuiltinCommandName } from "../../shared/builtin-commands";
import type { ConfigParseFailure } from "../../shared/config-diagnostics";
import { isTuiConnected, pushNotification } from "../../shared/rpc-notifications";
import type { StatusDetail } from "../../shared/rpc-types";
import type { Database } from "../../shared/sqlite";
import { formatStatusDetailMarkdown } from "../../shared/status-detail-text";
import { resolveTailHygieneStatus } from "../../shared/tail-hygiene-status";
import { renderUserFacingFailure, userFacingFailureCode } from "../../shared/user-facing-codes";
import {
    type PartialRecompRange,
    snapRangeToCompartments,
} from "./compartment-runner-partial-recomp";
import { resolveContextWindowGeometry } from "./event-resolvers";
import { executeFlush } from "./execute-flush";
import { executeStatus } from "./execute-status";
import { rescoreCommandErrorText } from "./rescore-command";
import type { NotificationParams } from "./send-session-notification";

/**
 * Track per-session recomp confirmation for Desktop (no dialog available).
 * Stores the timestamp of the first tap and the normalized range argument
 * so switching ranges between taps counts as a new intent requiring fresh
 * confirmation.
 */
interface RecompConfirmation {
    timestamp: number;
    /** Normalized range arg or "" for full recomp. */
    argsKey: string;
}
const recompConfirmationBySession = new Map<string, RecompConfirmation>();
const RECOMP_CONFIRMATION_WINDOW_MS = 60_000;

function isSubagentSession(db: Database, sessionId: string): boolean {
    const meta = getOrCreateSessionMeta(db, sessionId);
    if (meta.isSubagent) return true;
    try {
        const row = db
            .prepare("SELECT is_subagent FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { is_subagent?: unknown } | null;
        return row?.is_subagent === 1 || row?.is_subagent === true;
    } catch {
        return false;
    }
}

const RECOMP_USAGE = [
    "Usage:",
    "- `/ctx-recomp` — full rebuild from message 1 to the protected tail",
    "- `/ctx-recomp <start>-<end>` — partial rebuild of a message range (e.g. `/ctx-recomp 1-11322`)",
    "- `/ctx-recomp --upgrade` — upgrade legacy v1 compartments to v2 layout (Wave 3 runner)",
].join("\n");

/** Parse `/ctx-recomp` arguments.
 *
 *  Accepted forms:
 *  - empty / whitespace-only → full recomp
 *  - `<start>-<end>`         → partial recomp with explicit inclusive range
 *  - `--upgrade`            → upgrade legacy compartments (dispatch stub until Wave 3)
 *
 *  Returns an error object for unparseable or nonsensical inputs. */
export function parseRecompArgs(
    raw: string,
):
    | { kind: "full" }
    | { kind: "partial"; range: PartialRecompRange }
    | { kind: "upgrade" }
    | { kind: "error"; message: string } {
    const trimmed = raw.trim();
    if (trimmed === "") return { kind: "full" };
    if (trimmed === "--upgrade") return { kind: "upgrade" };

    const match = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!match) {
        return {
            kind: "error",
            message: `Invalid /ctx-recomp arguments: \`${trimmed}\`.\n\n${RECOMP_USAGE}`,
        };
    }

    const start = Number.parseInt(match[1], 10);
    const end = Number.parseInt(match[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return { kind: "error", message: "Range values must be finite integers." };
    }
    if (start < 1) {
        return { kind: "error", message: `Start must be >= 1 (got ${start}).` };
    }
    if (end < start) {
        return {
            kind: "error",
            message: `End must be >= start (got ${start}-${end}).`,
        };
    }

    return { kind: "partial", range: { start, end } };
}

export function parseWrapupArgs(
    raw: string,
): { ok: true; messagesToKeep: number } | { ok: false; message: string } {
    const trimmed = raw.trim();
    if (trimmed === "") return { ok: true, messagesToKeep: 20 };
    if (!/^\d+$/.test(trimmed)) {
        return {
            ok: false,
            message:
                "Usage: `/ctx-wrapup [messages_to_keep]` where messages_to_keep is a positive integer.",
        };
    }
    const messagesToKeep = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(messagesToKeep) || messagesToKeep <= 0) {
        return { ok: false, message: "messages_to_keep must be a positive integer." };
    }
    return { ok: true, messagesToKeep };
}

const commandArgumentValidators: Record<MagicContextBuiltinCommandName, (raw: string) => boolean> =
    {
        "ctx-status": (raw) => {
            const mode = raw.trim().toLowerCase();
            return mode === "" || mode === "diagnostics";
        },
        "ctx-recomp": (raw) => parseRecompArgs(raw).kind !== "error",
        "ctx-rescore": (raw) => {
            try {
                parseRescoreCommand(raw);
                return true;
            } catch {
                return false;
            }
        },
        "ctx-wrapup": (raw) => parseWrapupArgs(raw).ok,
        "ctx-flush": (raw) => raw.trim() === "",
        "ctx-dream": (raw) => {
            const requested = raw.trim();
            return requested === "" || isCanonicalDreamTask(requested);
        },
        "ctx-embed": (raw) => {
            const subcommand = raw.trim().toLowerCase();
            return subcommand === "" || subcommand === "start" || subcommand === "pause";
        },
    };

/**
 * Conservative pre-dispatch gate for Desktop prompts that lost their slash.
 * The actual command handler still parses the accepted text, so intercepted and
 * native slash commands share one execution path and one argument interpretation.
 */
export function acceptsMagicContextCommandArguments(
    command: MagicContextBuiltinCommandName,
    raw: string,
): boolean {
    return commandArgumentValidators[command](raw);
}

export interface CommandExecuteInput {
    command: string;
    sessionID: string;
    arguments: string;
}

export interface CommandExecuteOutput {
    parts: Array<{ type: string; text?: string }>;
}

const SENTINEL_PREFIX = "__CONTEXT_MANAGEMENT_";

// Effect HTTP plain-string TypeIds (NOT Symbols), verified against effect 4.x
// source. Because the guards are `key in obj` checks on string keys, a hand-built
// object carries them with NO effect import and NO version/realm coupling — it
// works on the compiled OpenCode binary where effect is unreachable from an
// external plugin's module resolution.
const HTTP_SERVER_RESPONSE_TYPE_ID = "~effect/http/HttpServerResponse";
const HTTP_COOKIES_TYPE_ID = "~effect/http/Cookies";
const HTTP_BODY_TYPE_ID = "~effect/http/HttpBody";
const ERROR_REPORTER_IGNORE = "~effect/ErrorReporter/ignore";

/** Prevent OpenCode from forwarding the handled command to the LLM.
 *
 *  We throw a normal `Error` (so on any host that does NOT recognize the Effect
 *  HTTP tags it behaves EXACTLY like the prior string sentinel — keeps
 *  .message/.stack, no regression) that ALSO duck-types an Effect
 *  `HttpServerResponse.empty({ status: 204 })`. On OpenCode 1.17.x the HTTP error
 *  boundary recognizes it via the plain-string TypeId
 *  (`isHttpServerResponse` = `"~effect/http/HttpServerResponse" in defect`),
 *  skips the JSON-500 logging path (PR #31551 had un-silenced our old throw), and
 *  writes it as a real 204 — so the handled command neither reaches the LLM nor
 *  leaks an error into the TUI/log.
 *
 *  Field shape is the minimal set `Response.toWeb` dereferences on the empty-body
 *  path (status / statusText / headers / cookies.cookies / body._tag), traced
 *  through effect 4.x. No effect import — all string keys + primitives.
 *
 *  An official `command.execute.before` handled/cancel/noReply contract remains
 *  the real fix; this is a duck-typed shim until then. */
function throwSentinel(command: string): never {
    const sentinel = new Error(`${SENTINEL_PREFIX}${command.toUpperCase()}_HANDLED__`) as Error &
        Record<string, unknown>;
    sentinel[HTTP_SERVER_RESPONSE_TYPE_ID] = HTTP_SERVER_RESPONSE_TYPE_ID;
    // effect 4 rc declares this key on the global Error interface as readonly, so
    // any program that also loads those typings (the e2e OpenCode 2 harness does)
    // rejects a direct write. The sentinel is the producer of the flag, so write it
    // through the plain record view; the runtime object and key are unchanged.
    (sentinel as Record<string, unknown>)[ERROR_REPORTER_IGNORE] = true;
    sentinel.status = 204;
    sentinel.statusText = undefined;
    sentinel.headers = {};
    sentinel.cookies = { [HTTP_COOKIES_TYPE_ID]: HTTP_COOKIES_TYPE_ID, cookies: {} };
    sentinel.body = { [HTTP_BODY_TYPE_ID]: HTTP_BODY_TYPE_ID, _tag: "Empty" };
    throw sentinel;
}

function getLegacyCompartmentCount(db: Database, sessionId: string): number {
    try {
        const row = db
            .prepare(
                "SELECT COUNT(*) AS count FROM compartments WHERE session_id = ? AND legacy = 1",
            )
            .get(sessionId) as { count?: number } | undefined;
        return typeof row?.count === "number" ? row.count : 0;
    } catch {
        // Older test/upgrade schemas may not have the v22 legacy column yet.
        return 0;
    }
}

function executeRecompUpgradeStub(db: Database, sessionId: string): string {
    const legacyCount = getLegacyCompartmentCount(db, sessionId);
    if (legacyCount === 0) {
        return "## Magic Recomp Upgrade\n\nNothing to upgrade: this session has no legacy compartments.";
    }

    // The legacy --upgrade flag no longer has a separate runner: a plain recomp
    // rebuilds legacy compartments into the current format.
    return [
        "## Magic Recomp Upgrade",
        "",
        `Found ${legacyCount} legacy compartment${legacyCount === 1 ? "" : "s"} for this session.`,
        "The `--upgrade` flag is deprecated. Run `/ctx-recomp` to rebuild them in the current format.",
    ].join("\n");
}

export type ManualDreamSummary = ManualRunResult;

function readDreamTaskBacklogsSafely(
    db: Database,
    projectPath: string,
    tasks: readonly DreamTaskName[],
) {
    try {
        return getDreamTaskBacklogs(db, projectPath, tasks);
    } catch {
        // Command handling must remain available while an older/empty database is migrating.
        return {};
    }
}

function readFailingDreamTasksSafely(db: Database, projectPath: string): DreamTaskFailureState[] {
    try {
        return getFailingDreamTasks(db, projectPath);
    } catch {
        // Same reason as the backlog read: status must survive an older/empty database.
        return [];
    }
}

function readSkippedDreamTasksSafely(db: Database, projectPath: string): string[] {
    try {
        return getSkippedDreamTasks(db, projectPath);
    } catch {
        // Status must remain available before the task schedule tables exist.
        return [];
    }
}

async function executeDreaming(
    deps: {
        db: Database;
        sendNotification: (
            sessionId: string,
            text: string,
            params: NotificationParams,
        ) => Promise<void>;
        toastDurationMs?: number;
        sampleToastDurationMs?: () => number | undefined;
        dreamer?: {
            config: DreamerConfig;
            projectPath: string;
            /** Run dream tasks NOW (Dreamer v2 per-task scheduler manual path).
             *  `task` forces one task ignoring its gate; omitted runs all enabled. */
            runManual: (task?: DreamTaskName) => Promise<ManualDreamSummary>;
        };
    },
    sessionId: string,
    argText?: string,
): Promise<never> {
    const dreamNotificationParams: NotificationParams = {
        toastDurationMs: deps.sampleToastDurationMs?.() ?? deps.toastDurationMs ?? 5000,
    };

    if (!deps.dreamer) {
        await deps.sendNotification(
            sessionId,
            "## /ctx-dream\n\nDreaming is not configured for this project.",
            dreamNotificationParams,
        );
        throwSentinel("CTX-DREAM");
    }

    // Optional single-task arg: `/ctx-dream verify`.
    const requested = argText?.trim();
    let task: DreamTaskName | undefined;
    if (requested) {
        if (!isCanonicalDreamTask(requested)) {
            await deps.sendNotification(
                sessionId,
                `## /ctx-dream\n\nUnknown task "${requested}". Valid tasks: ${CANONICAL_DREAM_TASKS.join(", ")}.`,
                dreamNotificationParams,
            );
            throwSentinel("CTX-DREAM");
        }
        task = requested;
    }

    const backlogTasks = task ? [task] : CANONICAL_DREAM_TASKS;
    const backlogBefore = readDreamTaskBacklogsSafely(
        deps.db,
        deps.dreamer.projectPath,
        backlogTasks,
    );
    await deps.sendNotification(
        sessionId,
        [
            "## /ctx-dream",
            "",
            task ? `Running dream task "${task}"...` : "Starting dream run...",
            "",
            "Backlog before starting:",
            formatDreamTaskBacklogs(backlogBefore, backlogTasks),
        ].join("\n"),
        dreamNotificationParams,
    );

    try {
        const summary = await deps.dreamer.runManual(task);
        // The starting backlog was already sent before the run, over the same task list.
        // Re-read the end backlog over that list too, so both panels show the same tasks
        // (the runner only reports the tasks it selected).
        await deps.sendNotification(
            sessionId,
            summarizeManualDream({
                ...summary,
                // An empty map suppresses the summary's own start panel.
                backlogBefore: {},
                backlogAfter: readDreamTaskBacklogsSafely(
                    deps.db,
                    deps.dreamer.projectPath,
                    backlogTasks,
                ),
            }),
            dreamNotificationParams,
        );
    } catch (error) {
        sessionLog(
            sessionId,
            `ctx-dream failed code=${userFacingFailureCode("dream_unknown")}`,
            error,
        );
        await deps.sendNotification(
            sessionId,
            `## /ctx-dream\n\n${renderUserFacingFailure("dream_unknown")}`,
            dreamNotificationParams,
        );
    }
    throwSentinel("CTX-DREAM");
}

export function createMagicContextCommandHandler(deps: {
    db: Database;
    /** Boot-resolved mode; command paths must not re-read configuration. */
    compactionOff?: boolean;
    signedThinkingHold?: "off" | "on";
    smartNotesEnabled?: boolean;
    executeThresholdPercentage?: number | { default: number; [modelKey: string]: number };
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined };
    historyBudgetPercentage?: number;
    commitClusterTrigger?: { enabled: boolean; min_clusters: number };
    sampleCommitClusterTrigger?: () => { enabled: boolean; min_clusters: number } | undefined;
    getLiveModelKey?: (sessionId: string) => string | undefined;
    cacheTtlConfig?: MagicContextConfig["cache_ttl"];
    cacheTtlConfigured?: boolean;
    configParseFailures?: ConfigParseFailure[];
    /** Builds the status payload shared with the TUI dialog for a chat-only fallback. */
    getStatusDetail?: (sessionId: string) => StatusDetail;
    /** Optional live context limit resolver — used for tokens-based threshold display. */
    getContextLimit?: (sessionId: string) => number | undefined;
    getDreamerProgress?: () =>
        | import("../../features/magic-context/dreamer/task-registry").DreamTaskProgress
        | null;
    /** Cached U/T token measurement of the final rendered conversation tail, shared by both nudge mechanisms. */
    getTailHygiene?: (sessionId: string) => import("./ctx-reduce-nudge").Channel1State | undefined;
    onFlush?: (sessionId: string) => void;
    /** Runs /ctx-recomp. When `range` is provided, runs partial recomp over
     *  that range (snapped to enclosing compartment boundaries). When omitted,
     *  runs full recomp from message 1 to the protected tail. */
    executeRecomp?: (
        sessionId: string,
        options?: { range?: PartialRecompRange },
    ) => Promise<string>;
    executeRescore?: (sessionId: string, args: string) => Promise<string>;
    /** Runs /ctx-wrapup over the live raw tail, keeping the newest N raw messages. */
    executeWrapup?: (sessionId: string, options: { messagesToKeep: number }) => Promise<string>;
    /** `/ctx-embed start` — backfill this session's compartment embeddings. */
    executeEmbedHistory?: (
        sessionId: string,
        options?: { signal?: AbortSignal; silent?: boolean },
    ) => Promise<string>;
    pauseEmbedDrain?: (sessionId: string) => string;
    getEmbedStatusText?: (sessionId: string) => string;
    sendNotification: (
        sessionId: string,
        text: string,
        params: NotificationParams,
    ) => Promise<void>;
    /** Configured toast lifetime (ms) forwarded into diagnostics logs. */
    toastDurationMs?: number;
    sampleToastDurationMs?: () => number | undefined;
    dreamer?: {
        config: DreamerConfig;
        projectPath: string;
        /** Dreamer v2 manual `/ctx-dream` entry — runs tasks now via the per-task
         *  scheduler (one forced task, or all enabled). Wired in hook.ts. */
        runManual: (task?: DreamTaskName) => Promise<ManualRunResult>;
    };
}) {
    // Notification delivery MUST NOT bypass the sentinel. Every command path
    // ends in throwSentinel() (the 204 that suppresses the error-log leak and
    // stops the command reaching the LLM). If sendNotification throws — RPC down,
    // client gone, transient post failure — that throw would skip the pending
    // throwSentinel and the raw command would be forwarded to the model (and a
    // real error logged). Wrap it once so a delivery failure is logged and
    // swallowed, never preempting the sentinel. Reassigning the deps method
    // covers the handler and the standalone executeDreaming helper,
    // which receive this same deps reference.
    const rawSendNotification = deps.sendNotification;
    deps.sendNotification = async (sessionId, text, params) => {
        try {
            await rawSendNotification(sessionId, text, params);
        } catch (err) {
            sessionLog(
                sessionId,
                `command notification delivery failed (continuing to sentinel): ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    };

    const isStatusCommand = (command: string): boolean => command === "ctx-status";
    const isFlushCommand = (command: string): boolean => command === "ctx-flush";
    const isRecompCommand = (command: string): boolean => command === "ctx-recomp";
    const isWrapupCommand = (command: string): boolean => command === "ctx-wrapup";
    const isDreamCommand = (command: string): boolean => command === "ctx-dream";
    const isEmbedCommand = (command: string): boolean => command === "ctx-embed";

    return {
        "command.execute.before": async (
            input: CommandExecuteInput,
            _output: CommandExecuteOutput,
            _params: NotificationParams,
        ): Promise<void> => {
            const isStatus = isStatusCommand(input.command);
            const isFlush = isFlushCommand(input.command);
            const isRecomp = isRecompCommand(input.command);
            const isWrapup = isWrapupCommand(input.command);
            const isDream = isDreamCommand(input.command);
            const isEmbed = isEmbedCommand(input.command);
            const isRescore = input.command === "ctx-rescore";

            if (
                !isStatus &&
                !isFlush &&
                !isRecomp &&
                !isWrapup &&
                !isDream &&
                !isEmbed &&
                !isRescore
            ) {
                return;
            }

            const sessionId = input.sessionID;
            let result = "";

            if (isRescore) {
                try {
                    parseRescoreCommand(input.arguments);
                    result = deps.executeRescore
                        ? await deps.executeRescore(sessionId, input.arguments)
                        : "Rescoring is unavailable in this host.";
                } catch (error) {
                    result = rescoreCommandErrorText(error);
                }
                await deps.sendNotification(sessionId, result, {});
                throwSentinel(input.command);
            }

            if (deps.compactionOff && (isFlush || isRecomp || isWrapup)) {
                const command = `/${input.command}`;
                await deps.sendNotification(
                    sessionId,
                    `Magic Context compaction is disabled (${COMPACTION_ENABLED_PATH}: false) — ${command} manages compacted history and has no effect in this mode.`,
                    {},
                );
                throwSentinel(input.command);
            }

            if (isDream) {
                await executeDreaming(deps, sessionId, input.arguments);
                return;
            }

            if (isEmbed) {
                const sub = input.arguments.trim().toLowerCase();
                if (sub === "pause") {
                    const summary = deps.pauseEmbedDrain
                        ? deps.pauseEmbedDrain(sessionId)
                        : "Embedding pause is unavailable.";
                    if (isTuiConnected(sessionId)) {
                        // Dialog (not a scrollback message) so the sentinel-throw
                        // stderr leak repaints away, mirroring /ctx-status & /ctx-flush.
                        pushNotification(
                            "action",
                            { action: "show-result-dialog", title: "Embed", message: summary },
                            sessionId,
                        );
                    } else {
                        await deps.sendNotification(sessionId, summary, {});
                    }
                    throwSentinel(input.command);
                }
                if (sub === "start") {
                    const summary = deps.executeEmbedHistory
                        ? await deps.executeEmbedHistory(sessionId)
                        : "Semantic embedding is not configured for this project, so there is nothing to embed.";
                    if (isTuiConnected(sessionId)) {
                        pushNotification(
                            "action",
                            { action: "show-result-dialog", title: "Embed", message: summary },
                            sessionId,
                        );
                    } else {
                        await deps.sendNotification(sessionId, summary, {});
                    }
                    throwSentinel(input.command);
                }
                if (sub !== "") {
                    await deps.sendNotification(
                        sessionId,
                        "Usage: `/ctx-embed` (status), `/ctx-embed start`, or `/ctx-embed pause`.",
                        {},
                    );
                    throwSentinel(input.command);
                }
                if (isTuiConnected(sessionId)) {
                    pushNotification("action", { action: "show-embed-dialog" }, sessionId);
                    sessionLog(sessionId, "command ctx-embed: pushed show-embed-dialog to TUI");
                    throwSentinel(input.command);
                }
                result = deps.getEmbedStatusText
                    ? `## Embedding Status\n\n${deps.getEmbedStatusText(sessionId)}`
                    : "## Embedding Status\n\nEmbedding status is unavailable.";
            }

            if (isFlush) {
                result = executeFlush(deps.db, sessionId, deps.signedThinkingHold === "on");
                deps.onFlush?.(sessionId);
                if (isTuiConnected(sessionId)) {
                    pushNotification(
                        "action",
                        { action: "show-flush-dialog", message: result },
                        sessionId,
                    );
                    sessionLog(sessionId, "command ctx-flush: pushed show-flush-dialog to TUI");
                    throwSentinel(input.command);
                }
            }

            if (isStatus) {
                if (isTuiConnected(sessionId)) {
                    // In TUI, push an RPC action so the TUI poller shows a native dialog
                    pushNotification("action", { action: "show-status-dialog" }, sessionId);
                    sessionLog(sessionId, "command ctx-status: pushed show-status-dialog to TUI");
                    throwSentinel(input.command);
                }
                let combinedStatus: string;
                try {
                    const detail = deps.getStatusDetail?.(sessionId);
                    if (detail) {
                        combinedStatus = formatStatusDetailMarkdown(detail);
                    } else {
                        // Compatibility for isolated handler consumers that have not yet
                        // supplied the shared TUI status builder.
                        const liveModelKey = deps.getLiveModelKey?.(sessionId);
                        const liveContextLimit = deps.getContextLimit?.(sessionId);
                        const modelSlash = liveModelKey?.indexOf("/") ?? -1;
                        const windowGeometry =
                            liveModelKey && modelSlash > 0
                                ? resolveContextWindowGeometry(
                                      liveModelKey.slice(0, modelSlash),
                                      liveModelKey.slice(modelSlash + 1),
                                      { db: deps.db, sessionID: sessionId },
                                  )
                                : undefined;
                        const tailHygiene = resolveTailHygieneStatus(
                            deps.getTailHygiene?.(sessionId),
                        );
                        const statusOutput = executeStatus(
                            deps.db,
                            sessionId,
                            deps.executeThresholdPercentage,
                            liveModelKey,
                            deps.historyBudgetPercentage,
                            deps.sampleCommitClusterTrigger?.() ?? deps.commitClusterTrigger,
                            deps.executeThresholdTokens,
                            liveContextLimit,
                            deps.dreamer
                                ? {
                                      backlog: readDreamTaskBacklogsSafely(
                                          deps.db,
                                          deps.dreamer.projectPath,
                                          CANONICAL_DREAM_TASKS.filter(
                                              (task) =>
                                                  deps.smartNotesEnabled !== false ||
                                                  task !== "evaluate-smart-notes",
                                          ),
                                      ),
                                      progress: deps.getDreamerProgress?.() ?? null,
                                      skipped: readSkippedDreamTasksSafely(
                                          deps.db,
                                          deps.dreamer.projectPath,
                                      ).filter(
                                          (task) =>
                                              deps.smartNotesEnabled !== false ||
                                              task !== "evaluate-smart-notes",
                                      ),
                                      failures: readFailingDreamTasksSafely(
                                          deps.db,
                                          deps.dreamer.projectPath,
                                      ).filter(
                                          (state) =>
                                              deps.smartNotesEnabled !== false ||
                                              state.task !== "evaluate-smart-notes",
                                      ),
                                  }
                                : undefined,
                            windowGeometry,
                            tailHygiene,
                            undefined,
                            {
                                cacheTtlConfig: deps.cacheTtlConfig ?? "5m",
                                cacheTtlConfigured: deps.cacheTtlConfigured === true,
                                configParseFailures: deps.configParseFailures ?? [],
                                diagnostics: false,
                                compactionEnabled: !deps.compactionOff,
                            },
                        );
                        combinedStatus = statusOutput;
                    }
                } catch (error) {
                    sessionLog(
                        sessionId,
                        "shared ctx-status detail failed; using compatibility text:",
                        error,
                    );
                    combinedStatus = executeStatus(deps.db, sessionId);
                }
                result += result ? `\n\n${combinedStatus}` : combinedStatus;
            }

            if (isWrapup) {
                const parsed = parseWrapupArgs(input.arguments);
                if (isSubagentSession(deps.db, sessionId)) {
                    result =
                        "## Magic Wrapup — Skipped\n\n/ctx-wrapup is only available in primary sessions.";
                } else if (!parsed.ok) {
                    result = `## Magic Wrapup — Invalid Arguments\n\n${parsed.message}`;
                } else if (!deps.executeWrapup) {
                    result =
                        "## Magic Wrapup\n\n/ctx-wrapup is unavailable because the historian handler is not configured.";
                } else {
                    result = await deps.executeWrapup(sessionId, {
                        messagesToKeep: parsed.messagesToKeep,
                    });
                }
            }

            if (isRecomp) {
                const parsedArgs = parseRecompArgs(input.arguments);
                if (parsedArgs.kind === "error") {
                    result = `## Magic Recomp — Invalid Arguments\n\n${parsedArgs.message}`;
                } else if (parsedArgs.kind === "upgrade") {
                    result = executeRecompUpgradeStub(deps.db, sessionId);
                } else if (isTuiConnected(sessionId)) {
                    // In TUI, push an RPC action so the TUI poller shows a confirmation dialog.
                    // Partial-range args fall through to the full-recomp dialog for now — TUI
                    // range UI is tracked as a phase-2 enhancement; typed args are ignored here.
                    pushNotification("action", { action: "show-recomp-dialog" }, sessionId);
                    sessionLog(sessionId, "command ctx-recomp: pushed show-recomp-dialog to TUI");
                    throwSentinel(input.command);
                } else if (!deps.executeRecomp) {
                    result =
                        "## Magic Recomp\n\n/ctx-recomp is unavailable because the recomp handler is not configured.";
                } else {
                    // Desktop double-tap confirmation (no native dialog available).
                    const argsKey =
                        parsedArgs.kind === "partial"
                            ? `${parsedArgs.range.start}-${parsedArgs.range.end}`
                            : "";
                    const lastConfirmation = recompConfirmationBySession.get(sessionId);
                    const now = Date.now();
                    const confirmationValid =
                        lastConfirmation &&
                        now - lastConfirmation.timestamp < RECOMP_CONFIRMATION_WINDOW_MS &&
                        lastConfirmation.argsKey === argsKey;

                    if (confirmationValid) {
                        // Confirmed — second /ctx-recomp within 60s with same args
                        recompConfirmationBySession.delete(sessionId);
                        if (parsedArgs.kind === "partial") {
                            await deps.sendNotification(
                                sessionId,
                                `## Magic Recomp\n\nPartial recomp started for range ${parsedArgs.range.start}-${parsedArgs.range.end}. Rebuilding the matching compartments now (facts unchanged).`,
                                {},
                            );
                            result = await deps.executeRecomp(sessionId, {
                                range: parsedArgs.range,
                            });
                        } else {
                            await deps.sendNotification(
                                sessionId,
                                "## Magic Recomp\n\nRecomp started. Rebuilding the compressed history from raw session history now; saved memories are kept as they are.",
                                {},
                            );
                            result = await deps.executeRecomp(sessionId);
                        }
                    } else {
                        // First attempt — show warning
                        recompConfirmationBySession.set(sessionId, {
                            timestamp: now,
                            argsKey,
                        });
                        const compartments = getCompartments(deps.db, sessionId);
                        const compartmentCount = compartments.length;

                        if (parsedArgs.kind === "partial") {
                            // Compute snap preview so the user sees what will actually be replaced.
                            const snap = snapRangeToCompartments(compartments, parsedArgs.range);
                            if ("error" in snap) {
                                // Clear stale confirmation — a snap error is not a pending intent.
                                recompConfirmationBySession.delete(sessionId);
                                result = `## Magic Recomp — Failed\n\n${snap.error}`;
                            } else {
                                const replaced = snap.rangeCompartments.length;
                                const preserved =
                                    snap.priorCompartments.length + snap.tailCompartments.length;
                                const warningLines = [
                                    "## ⚠️ Partial Recomp Confirmation Required",
                                    "",
                                    `Requested range: \`${parsedArgs.range.start}-${parsedArgs.range.end}\``,
                                    `Snapped to compartment boundaries: **messages ${snap.snapStart}-${snap.snapEnd}**`,
                                    "",
                                    `This will **rebuild ${replaced} compartment(s)** in the snapped range.`,
                                    `**${preserved} compartment(s)** outside the range will be preserved unchanged.`,
                                    "Facts will not be re-extracted.",
                                    "",
                                    "This operation:",
                                    "- May take several minutes to tens of minutes depending on range size",
                                    "- Will consume historian-model tokens for each chunk",
                                    "- Is resumable if interrupted (staging preserved on failure)",
                                    "",
                                    `**To confirm, run \`/ctx-recomp ${parsedArgs.range.start}-${parsedArgs.range.end}\` again within 60 seconds.**`,
                                ];
                                result = warningLines.join("\n");
                            }
                        } else {
                            const warningLines = [
                                "## ⚠️ Recomp Confirmation Required",
                                "",
                                `You currently have **${compartmentCount}** compartments.`,
                                "Running /ctx-recomp will **rebuild the compressed history** from raw session history. Saved memories are not changed.",
                                "",
                                "This operation:",
                                "- May take a long time (minutes to hours for long sessions)",
                                "- Will consume significant tokens on your historian model",
                                "- Cannot be interrupted cleanly once started",
                                "",
                                "Tip: to rebuild only a specific message range, use `/ctx-recomp <start>-<end>` (e.g. `/ctx-recomp 1-11322`).",
                                "",
                                "**To confirm, run `/ctx-recomp` again within 60 seconds.**",
                            ];
                            result = warningLines.join("\n");
                        }
                    }
                }
            }

            await deps.sendNotification(sessionId, result, {});
            sessionLog(sessionId, `command ${input.command} handled via command.execute.before`);

            throwSentinel(input.command);
        },
    };
}
