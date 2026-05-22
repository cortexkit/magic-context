import type { DreamerConfig, SidekickConfig } from "../../config/schema/magic-context";
import {
    type DreamRunResult,
    enqueueDream,
    processDreamQueue,
} from "../../features/magic-context/dreamer";
import { runSidekick } from "../../features/magic-context/sidekick/agent";
import { getCompartments } from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import { sessionLog } from "../../shared";
import { isTuiConnected, pushNotification } from "../../shared/rpc-notifications";
import type { Database } from "../../shared/sqlite";
import {
    type PartialRecompRange,
    snapRangeToCompartments,
} from "./compartment-runner-partial-recomp";
import { executeFlush } from "./execute-flush";
import { executeStatus } from "./execute-status";
import type { NotificationParams } from "./send-session-notification";
import { sendUserPrompt } from "./send-session-notification";

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

export interface CommandExecuteInput {
    command: string;
    sessionID: string;
    arguments: string;
}

export interface CommandExecuteOutput {
    parts: Array<{ type: string; text?: string }>;
}

const SENTINEL_PREFIX = "__CONTEXT_MANAGEMENT_";

/** Throw sentinel error to prevent OpenCode from forwarding the command to the LLM.
 *  This works in TUI and Desktop. In web mode, the error surfaces as a failure in the
 *  browser UI — that's an OpenCode limitation (no "handled" return path from
 *  command.execute.before). Filed as a known issue. */
function throwSentinel(command: string): never {
    throw new Error(`${SENTINEL_PREFIX}${command.toUpperCase()}_HANDLED__`);
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

    // Legacy --upgrade flag is superseded by the /ctx-session-upgrade command.
    return [
        "## Magic Recomp Upgrade",
        "",
        `Found ${legacyCount} legacy compartment${legacyCount === 1 ? "" : "s"} for this session.`,
        "The `--upgrade` flag is deprecated. Run `/ctx-session-upgrade` to upgrade this session.",
    ].join("\n");
}

/**
 * Execute /ctx-session-upgrade: upgrade THIS session to the v2 history format.
 *
 * Two halves (locked design):
 *  1. Compartment upgrade — run a full recomp, which rebuilds every legacy v1
 *     compartment into the v2 tiered/scored shape (legacy=0). This is just the
 *     normal full-recomp path; recomp already produces v2 compartments.
 *  2. Memory migration (E3.2) — re-evaluate project memories into the 5-category
 *     taxonomy via a transient historian-model prompt, once per project. Wired
 *     in a follow-up; this command runs the compartment upgrade today and notes
 *     the pending migration step.
 *
 * Session-scoped: recomp rebuilds THIS session's compartments. The memory
 * migration is project-scoped and idempotent (guarded once-per-project).
 */
async function executeSessionUpgrade(
    deps: {
        /** Runs the full session upgrade (compartment recomp → once-per-project
         *  memory migration) via the shared orchestrator. Optional: unavailable
         *  when no historian model is configured. The orchestrator gives the
         *  command path identical model fallback + live progress + terminal
         *  state as the RPC dialog path (dogfood 2026-05-30 unification). */
        runUpgrade?: (sessionId: string) => Promise<string>;
    },
    sessionId: string,
): Promise<string> {
    if (!deps.runUpgrade) {
        return "## Session Upgrade\n\nUpgrade is unavailable because the recomp handler is not configured.";
    }
    return deps.runUpgrade(sessionId);
}

/**
 * Execute /ctx-aug: run sidekick to augment the user's prompt with relevant memories,
 * then send the augmented prompt as a real user message.
 */
async function executeAugmentation(
    deps: {
        db: Database;
        sendNotification: (
            sessionId: string,
            text: string,
            params: NotificationParams,
        ) => Promise<void>;
        sidekick?: {
            config: SidekickConfig;
            projectPath: string;
            sessionDirectory?: string;
            client: PluginContext["client"];
        };
    },
    sessionId: string,
    userPrompt: string,
): Promise<never> {
    if (!deps.sidekick?.config) {
        await deps.sendNotification(
            sessionId,
            "## /ctx-aug\n\nSidekick is not configured. Add sidekick settings to `magic-context.jsonc` to use /ctx-aug.",
            {},
        );
        throwSentinel("CTX-AUG");
    }

    const prompt = userPrompt.trim();
    if (prompt.length === 0) {
        await deps.sendNotification(
            sessionId,
            "## /ctx-aug\n\nUsage: `/ctx-aug <your prompt>`\n\nProvide a prompt to augment with project memory context.",
            {},
        );
        throwSentinel("CTX-AUG");
    }

    // Step 1: Show "preparing" notification (hidden from LLM)
    await deps.sendNotification(
        sessionId,
        "🔍 Preparing augmentation… this may take 2-10s depending on your sidekick provider.",
        {},
    );

    // Step 2: Run sidekick
    sessionLog(sessionId, "/ctx-aug: running sidekick");
    const sidekickResult = await runSidekick({
        client: deps.sidekick.client,
        sessionId,
        projectPath: deps.sidekick.projectPath,
        sessionDirectory: deps.sidekick.sessionDirectory,
        userMessage: prompt,
        config: deps.sidekick.config,
    });

    // Step 3: Build augmented prompt
    let augmentedPrompt: string;
    if (sidekickResult) {
        augmentedPrompt = `${prompt}\n\n<sidekick-augmentation>\n${sidekickResult}\n</sidekick-augmentation>`;
        sessionLog(sessionId, `/ctx-aug: sidekick returned ${sidekickResult.length} chars`);
    } else {
        // Sidekick returned nothing — send the prompt as-is with a note
        augmentedPrompt = prompt;
        sessionLog(sessionId, "/ctx-aug: sidekick returned no result, sending prompt as-is");
    }

    // Step 4: Send as a real user prompt (will be processed by the model)
    await sendUserPrompt(deps.sidekick.client, sessionId, augmentedPrompt);

    throwSentinel("CTX-AUG");
}

function summarizeDreamResult(result: DreamRunResult): string {
    const taskLines = result.tasks.map((task: DreamRunResult["tasks"][number]) => {
        const seconds = (task.durationMs / 1000).toFixed(1);
        return task.error
            ? `- ${task.name}: failed after ${seconds}s — ${task.error}`
            : `- ${task.name}: completed in ${seconds}s`;
    });

    return [
        "## /ctx-dream",
        "",
        `Started: ${new Date(result.startedAt).toISOString()}`,
        `Finished: ${new Date(result.finishedAt).toISOString()}`,
        `Lease holder: ${result.holderId}`,
        "",
        "### Tasks",
        ...(taskLines.length > 0 ? taskLines : ["- No tasks ran."]),
    ].join("\n");
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
        dreamer?: {
            config: DreamerConfig;
            projectPath: string;
            client: unknown;
            directory: string;
            executeDream?: (sessionId: string) => Promise<DreamRunResult | null>;
            experimentalUserMemories?: { enabled: boolean; promotionThreshold: number };
            experimentalPinKeyFiles?: {
                enabled: boolean;
                token_budget: number;
                min_reads: number;
            };
            /** Resolved dreamer fallback chain (forwarded to processDreamQueue). */
            fallbackModels?: readonly string[];
        };
    },
    sessionId: string,
): Promise<never> {
    const dreamNotificationParams: NotificationParams = {
        toastDurationMs: deps.toastDurationMs ?? 5000,
    };

    if (!deps.dreamer?.config?.tasks?.length) {
        await deps.sendNotification(
            sessionId,
            "## /ctx-dream\n\nDreaming is not configured for this project.",
            dreamNotificationParams,
        );
        throwSentinel("CTX-DREAM");
    }

    // dream_queue table is created in initializeDatabase() — no ensureDreamQueueTable needed.
    // force=true uses the lease-aware stale cleanup path in enqueueDream: a crashed or
    // restarted runner can be recovered after the lease TTL, but a healthy in-flight
    // runner with an unexpired lease is never deleted just because it is older than 2m.
    const entry = enqueueDream(deps.db, deps.dreamer.projectPath, "manual", true);
    if (!entry) {
        await deps.sendNotification(
            sessionId,
            "Dream already queued for this project",
            dreamNotificationParams,
        );
        throwSentinel("CTX-DREAM");
    }

    await deps.sendNotification(sessionId, "Starting dream run...", dreamNotificationParams);

    const result = deps.dreamer.executeDream
        ? await deps.dreamer.executeDream(sessionId)
        : await processDreamQueue({
              db: deps.db,
              client: deps.dreamer.client as never,
              tasks: deps.dreamer.config.tasks,
              taskTimeoutMinutes: deps.dreamer.config.task_timeout_minutes,
              maxRuntimeMinutes: deps.dreamer.config.max_runtime_minutes,
              experimentalUserMemories: deps.dreamer.experimentalUserMemories,
              experimentalPinKeyFiles: deps.dreamer.experimentalPinKeyFiles,
              // /ctx-dream is project-scoped: it should only ever drain THIS
              // project's queue entry, never accidentally pick up another
              // host's enqueued work that is sitting at the queue head.
              projectIdentity: deps.dreamer.projectPath,
              // Run in this command's own checkout, not a stale sibling
              // worktree resolved from the shared git:<sha> identity map.
              sessionDirectoryOverride: deps.dreamer.directory,
              fallbackModels: deps.dreamer.fallbackModels,
          });

    await deps.sendNotification(
        sessionId,
        result
            ? summarizeDreamResult(result)
            : "Dream queued, but another worker is already processing the queue.",
        dreamNotificationParams,
    );
    throwSentinel("CTX-DREAM");
}

export function createMagicContextCommandHandler(deps: {
    db: Database;
    protectedTags: number;
    executeThresholdPercentage?: number | { default: number; [modelKey: string]: number };
    executeThresholdTokens?: { default?: number; [modelKey: string]: number | undefined };
    historyBudgetPercentage?: number;
    commitClusterTrigger?: { enabled: boolean; min_clusters: number };
    getLiveModelKey?: (sessionId: string) => string | undefined;
    /** Optional live context limit resolver — used for tokens-based threshold display. */
    getContextLimit?: (sessionId: string) => number | undefined;
    onFlush?: (sessionId: string) => void;
    /** Runs /ctx-recomp. When `range` is provided, runs partial recomp over
     *  that range (snapped to enclosing compartment boundaries). When omitted,
     *  runs full recomp from message 1 to the protected tail. */
    executeRecomp?: (
        sessionId: string,
        options?: { range?: PartialRecompRange },
    ) => Promise<string>;
    /** Runs the once-per-project 5-cat memory migration for /ctx-session-upgrade.
     *  Optional: when unavailable, /ctx-session-upgrade still upgrades compartments
     *  via recomp and skips the memory re-evaluation. */
    runUpgrade?: (sessionId: string) => Promise<string>;
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
    sidekick?: {
        config: SidekickConfig;
        projectPath: string;
        sessionDirectory?: string;
        client: PluginContext["client"];
    };
    dreamer?: {
        config: DreamerConfig;
        projectPath: string;
        client: unknown;
        directory: string;
        executeDream?: (sessionId: string) => Promise<DreamRunResult | null>;
        experimentalUserMemories?: { enabled: boolean; promotionThreshold: number };
        experimentalPinKeyFiles?: {
            enabled: boolean;
            token_budget: number;
            min_reads: number;
        };
        /** Resolved dreamer fallback chain (forwarded to processDreamQueue). */
        fallbackModels?: readonly string[];
    };
}) {
    const isStatusCommand = (command: string): boolean => command === "ctx-status";
    const isFlushCommand = (command: string): boolean => command === "ctx-flush";
    const isRecompCommand = (command: string): boolean => command === "ctx-recomp";
    const isAugCommand = (command: string): boolean => command === "ctx-aug";
    const isDreamCommand = (command: string): boolean => command === "ctx-dream";
    const isSessionUpgradeCommand = (command: string): boolean => command === "ctx-session-upgrade";
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
            const isAug = isAugCommand(input.command);
            const isDream = isDreamCommand(input.command);
            const isSessionUpgrade = isSessionUpgradeCommand(input.command);
            const isEmbed = isEmbedCommand(input.command);

            if (
                !isStatus &&
                !isFlush &&
                !isRecomp &&
                !isAug &&
                !isDream &&
                !isSessionUpgrade &&
                !isEmbed
            ) {
                return;
            }

            const sessionId = input.sessionID;
            let result = "";

            if (isAug) {
                await executeAugmentation(deps, sessionId, input.arguments);
                return; // executeAugmentation throws sentinel internally
            }

            if (isDream) {
                await executeDreaming(deps, sessionId);
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
                result = executeFlush(deps.db, sessionId);
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
                const liveModelKey = deps.getLiveModelKey?.(sessionId);
                const liveContextLimit = deps.getContextLimit?.(sessionId);
                const statusOutput = executeStatus(
                    deps.db,
                    sessionId,
                    deps.protectedTags,
                    deps.executeThresholdPercentage,
                    liveModelKey,
                    deps.historyBudgetPercentage,
                    deps.commitClusterTrigger,
                    deps.executeThresholdTokens,
                    liveContextLimit,
                );
                result += result ? `\n\n${statusOutput}` : statusOutput;
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
                                "## Magic Recomp\n\nHistorian recomp started. Rebuilding compartments and facts from raw session history now.",
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
                                "Running /ctx-recomp will **regenerate all compartments and facts** from raw session history.",
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

            if (isSessionUpgrade) {
                // TUI-no-session edge: before the first message, the prompt may
                // not be bound to a session. Resolve defensively — nothing to
                // upgrade without a session id.
                if (!sessionId) {
                    result =
                        "## Session Upgrade\n\nThis prompt is not attached to a session yet — send a message first, then run `/ctx-session-upgrade`.";
                } else {
                    result = await executeSessionUpgrade(deps, sessionId);
                }
            }

            await deps.sendNotification(sessionId, result, {});
            sessionLog(sessionId, `command ${input.command} handled via command.execute.before`);

            throwSentinel(input.command);
        },
    };
}
