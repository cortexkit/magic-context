/**
 * Loud fail-closed blocking when Magic Context cannot operate on a session the
 * user enabled it for (schema fence, storage open/migration failure).
 *
 * Motivation: a schema-fence refusal used to unregister hooks and silently fall
 * through to native compaction — the user saw a 136%+ overflow with zero signal.
 * When blocking is armed, the harness transform throws an actionable error every
 * primary-session pass instead of degrading quietly.
 *
 * Transient SQLite contention (BUSY/LOCKED) is intentionally NOT handled here —
 * those stay fail-open pass-through in the outer transform wrappers.
 */

import { sanitizeDiagnosticText } from "../../shared/redaction";
import type { ProcessKind, ProcessProbeEvidence } from "../../shared/rpc-utils";

export const FAIL_CLOSED_DOCTOR_COMMAND = "npx @cortexkit/magic-context@latest doctor";

/** How often a blocked transform pass re-attempts storage open (1 = every pass). */
export const FAIL_CLOSED_REPROBE_EVERY_N = 5;

export type FailClosedProcessKind = ProcessKind;

export interface FailClosedBlockingProcess {
    /** The detected kind of process holding the shared database. */
    kind?: FailClosedProcessKind;
    /** Legacy callers may still provide the old display label. */
    harness?: string;
    pid: number;
    /** Epoch milliseconds from the process identity probe, when available. */
    startTime?: number | null;
    /** Raw command line from the process probe, when available. */
    commandLine?: string | null;
}

/**
 * Preserve the old enumerable blocker shape while carrying fresh probe details
 * to the diagnostic formatter. This keeps legacy reason snapshots stable while
 * still making the evidence available through normal property access.
 */
export function attachFailClosedBlockingProcessEvidence(
    process: FailClosedBlockingProcess,
    evidence: ProcessProbeEvidence,
): FailClosedBlockingProcess {
    Object.defineProperties(process, {
        startTime: { configurable: true, value: evidence.startTime },
        commandLine: { configurable: true, value: evidence.commandLine },
    });
    return process;
}

export type FailClosedReason =
    | {
          kind: "migration_guard";
          persistedVersion: number;
          supportedVersion: number;
          blockingProcesses: readonly FailClosedBlockingProcess[];
          unreadableFile?: string;
          unreadableArm?: "parse" | "io";
      }
    | {
          kind: "schema_fence";
          persistedVersion: number;
          supportedVersion: number;
      }
    | {
          kind: "storage_failure";
          cause: string;
      };

export class FailClosedBlockingError extends Error {
    readonly code = "FAIL_CLOSED_BLOCKING";
    readonly reason: FailClosedReason;

    constructor(message: string, reason: FailClosedReason, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "FailClosedBlockingError";
        this.reason = reason;
    }
}

/** OpenCode native hidden agents that must never be blocked by the gate. */
const OPENCODE_INTERNAL_AGENT_NAMES = new Set(["title", "summary", "compaction"]);

/**
 * Magic Context hidden-child agent ids (and stable prefixes). These sessions are
 * single-shot / bounded jobs that must keep running even when the primary
 * session is blocked — otherwise recovery work and background maintenance stall.
 */
function isMagicContextHiddenAgentName(agent: string): boolean {
    if (agent === "rescore") return true;
    if (agent === "smart-note-compiler" || agent.startsWith("smart-note-")) {
        return true;
    }
    if (agent === "historian" || agent.startsWith("historian-")) return true;
    if (agent === "dreamer" || agent.startsWith("dreamer-")) return true;
    return false;
}

const MAX_FORMATTED_BLOCKING_PROCESSES = 8;
const MAX_FORMATTED_COMMAND_LINE_LENGTH = 80;

function normalizeFailClosedProcessKind(process: FailClosedBlockingProcess): FailClosedProcessKind {
    switch (process.kind) {
        case "OpenCode server":
        case "OpenCode instance (TUI/CLI)":
        case "Pi":
        case "process":
            return process.kind;
    }
    switch (process.harness?.trim().toLowerCase()) {
        case "opencode server":
            return "OpenCode server";
        case "opencode instance (tui/cli)":
        case "opencode instance":
            return "OpenCode instance (TUI/CLI)";
        case "pi":
        case "pi harness":
        case "omp":
            return "Pi";
        default:
            return "process";
    }
}

function formatFailClosedProcessStartTime(startTime: number | null | undefined): string {
    if (!Number.isFinite(startTime) || (startTime as number) <= 0) return "unverified";
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            month: "short",
            hour12: false,
        }).formatToParts(new Date(startTime as number));
        const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
        if (!values.month || !values.day || !values.hour || !values.minute) return "unverified";
        return `${values.month} ${values.day} ${values.hour}:${values.minute}`;
    } catch {
        return "unverified";
    }
}

function formatFailClosedCommandLine(commandLine: string | null | undefined): string {
    if (typeof commandLine !== "string" || commandLine.trim().length === 0) return "unverified";
    try {
        const normalized = commandLine.replaceAll("\u0000", " ").replace(/\s+/g, " ").trim();
        if (normalized.length === 0) return "unverified";
        const sanitized = sanitizeDiagnosticText(normalized).trim();
        if (sanitized.length === 0) return "unverified";
        return sanitized.length > MAX_FORMATTED_COMMAND_LINE_LENGTH
            ? `${sanitized.slice(0, MAX_FORMATTED_COMMAND_LINE_LENGTH - 3)}...`
            : sanitized;
    } catch {
        // A diagnostic probe or sanitizer must never hide the fail-closed error.
        return "unverified";
    }
}

interface FormattedBlockingProcess {
    kind: FailClosedProcessKind;
    pid: number;
    startTime?: number | null;
    commandLine?: string | null;
}

export function formatFailClosedBlockingProcesses(
    processes: readonly FailClosedBlockingProcess[],
): string {
    const uniqueProcesses = new Map<number, FormattedBlockingProcess>();
    for (const process of processes) {
        if (!Number.isInteger(process.pid) || process.pid <= 0) continue;
        const candidate: FormattedBlockingProcess = {
            kind: normalizeFailClosedProcessKind(process),
            pid: process.pid,
            startTime: process.startTime,
            commandLine: process.commandLine,
        };
        const previous = uniqueProcesses.get(process.pid);
        if (!previous || (previous.kind === "process" && candidate.kind !== "process")) {
            uniqueProcesses.set(process.pid, candidate);
        } else {
            uniqueProcesses.set(process.pid, {
                ...previous,
                startTime: previous.startTime ?? candidate.startTime,
                commandLine: previous.commandLine ?? candidate.commandLine,
            });
        }
    }
    const entries = [...uniqueProcesses.values()];
    const visible = entries.slice(0, MAX_FORMATTED_BLOCKING_PROCESSES);
    const rendered = visible.map(({ kind, pid }) => `${kind} (PID ${pid})`);
    const omitted = entries.length - visible.length;
    if (omitted > 0) rendered.push(`${omitted} more blocking process(es)`);
    if (rendered.length === 0) return "a live process";

    const summary =
        rendered.length === 1
            ? rendered[0]
            : `${rendered.slice(0, -1).join(", ")}, and ${rendered.at(-1)}`;
    const evidence = entries
        .map(
            ({ kind, pid, startTime, commandLine }) =>
                `- PID ${pid}: ${kind}, started ${formatFailClosedProcessStartTime(startTime)}, cmd: ${formatFailClosedCommandLine(commandLine)}`,
        )
        .join("\n");
    return `${summary}\nBlocking process evidence:\n${evidence}`;
}

export function formatFailClosedBlockingMessage(reason: FailClosedReason): string {
    if (reason.kind === "migration_guard") {
        if (reason.unreadableFile) {
            const arm = reason.unreadableArm ?? "io";
            const recovery =
                arm === "io"
                    ? `If none of these processes are running, it is safe to delete ${reason.unreadableFile} and retry.`
                    : `The file may be a recent incomplete write; retry after the file is older than the ten-minute grace window, or stop the relevant process before deleting it.`;
            return [
                `Magic Context cannot migrate the shared database because RPC discovery file ${reason.unreadableFile} is uncertain (${arm} arm), so the absence of a live process cannot be proven.`,
                recovery,
                `Recovery: ${FAIL_CLOSED_DOCTOR_COMMAND}`,
            ].join(" ");
        }
        return [
            `Magic Context cannot migrate the shared database (one database serves every project on this machine) because ${formatFailClosedBlockingProcesses(reason.blockingProcesses)} may be running an older Magic Context build that would fail against the migrated database.`,
            `The database is at upstream migration v${reason.persistedVersion}; this build needs v${reason.supportedVersion}.`,
            "Restart the blocking process — even one from a different project — and it will pick up the new build and migrate on start; or shut it down and retry.",
            "If that host loads a pinned or cached older Magic Context build, a restart alone is not enough: stop it or update its Magic Context build, then start this host once so it migrates the database with nothing older attached.",
            `Recovery: ${FAIL_CLOSED_DOCTOR_COMMAND}`,
        ].join(" ");
    }
    if (reason.kind === "schema_fence") {
        return [
            `Magic Context cannot operate: this Magic Context build is older than the database; upgrade/restart this harness (upstream migration lane v${reason.persistedVersion}, build supports through v${reason.supportedVersion}).`,
            `Recovery: ${FAIL_CLOSED_DOCTOR_COMMAND}`,
        ].join(" ");
    }
    const cause = reason.cause.trim().length > 0 ? reason.cause.trim() : "unknown storage error";
    return [
        `Magic Context cannot operate: persistent storage failed (${cause}).`,
        "The plugin will not silently degrade to native compaction while enabled.",
        `Recovery: ${FAIL_CLOSED_DOCTOR_COMMAND}`,
    ].join(" ");
}

/**
 * One-line form of {@link formatFailClosedBlockingMessage} for surfaces that
 * must stay short or that leave the machine (a toast, a notice stored in the
 * conversation): it names each blocking process by kind and PID but leaves out
 * their command lines, which only the log and doctor need.
 */
export function formatFailClosedBlockingSummary(reason: FailClosedReason): string {
    if (reason.kind === "migration_guard") {
        if (reason.unreadableFile) {
            return `Magic Context cannot migrate the shared database from v${reason.persistedVersion} to v${reason.supportedVersion}: RPC discovery file ${reason.unreadableFile} could not be read, so an older host may still be attached.`;
        }
        const blockers = reason.blockingProcesses
            .filter((process) => Number.isInteger(process.pid) && process.pid > 0)
            .map((process) => `${normalizeFailClosedProcessKind(process)} (PID ${process.pid})`);
        const named = blockers.length > 0 ? blockers.join(", ") : "a live process";
        return `Magic Context cannot migrate the shared database from v${reason.persistedVersion} to v${reason.supportedVersion} while ${named} may still run an older Magic Context build. Stop or update that host, then start this one once.`;
    }
    if (reason.kind === "schema_fence") {
        return `Magic Context cannot operate: the shared database is at v${reason.persistedVersion}, newer than this build supports (v${reason.supportedVersion}). Update and restart this host.`;
    }
    const cause = reason.cause.trim().length > 0 ? reason.cause.trim() : "unknown storage error";
    return `Magic Context cannot operate: persistent storage failed (${cause}).`;
}

export function createFailClosedBlockingError(
    reason: FailClosedReason,
    options?: { cause?: unknown },
): FailClosedBlockingError {
    return new FailClosedBlockingError(formatFailClosedBlockingMessage(reason), reason, options);
}

export function isFailClosedBlockingError(error: unknown): error is FailClosedBlockingError {
    return (
        error instanceof FailClosedBlockingError ||
        (typeof error === "object" &&
            error !== null &&
            (error as { name?: string }).name === "FailClosedBlockingError" &&
            (error as { code?: string }).code === "FAIL_CLOSED_BLOCKING")
    );
}

/**
 * Whether this transform/context pass should skip the loud block.
 * Primary user sessions are never exempt; internal OpenCode agents, Magic
 * Context hidden children, and Pi subagent processes are.
 */
export function shouldBypassFailClosedBlock(input: {
    agent?: string | null;
    isInternalChildSession?: boolean;
    isPiSubagentEnv?: boolean;
}): boolean {
    if (input.isPiSubagentEnv === true) return true;
    if (input.isInternalChildSession === true) return true;
    const agent = typeof input.agent === "string" ? input.agent.trim() : "";
    if (agent.length === 0) return false;
    if (OPENCODE_INTERNAL_AGENT_NAMES.has(agent)) return true;
    if (isMagicContextHiddenAgentName(agent)) return true;
    return false;
}

export function resolveAgentNameFromMessages(
    messages: ReadonlyArray<{ info?: unknown } | null | undefined>,
): string | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const info = messages[i]?.info;
        if (!info || typeof info !== "object") continue;
        const agent = (info as { agent?: unknown }).agent;
        if (typeof agent === "string" && agent.length > 0) return agent;
    }
    return undefined;
}

export interface FailClosedController {
    arm(reason: FailClosedReason): void;
    clear(): void;
    isArmed(): boolean;
    getReason(): FailClosedReason | null;
    /**
     * Enforce the gate for one transform/context pass.
     * - No-op when unarmed, when blocking is disabled, or when the pass is exempt.
     * - Periodically re-probes storage; clears and returns when reopen succeeds.
     * - Otherwise throws {@link FailClosedBlockingError}.
     */
    enforce(input: {
        blockingEnabled: boolean;
        exempt: boolean;
        tryReopen?: () => boolean | Promise<boolean>;
    }): void | Promise<void>;
}

/**
 * Process-local controller shared by the boot path (arms on deterministic
 * inoperability) and the per-turn transform (enforces / re-probes).
 */
export function createFailClosedController(options?: {
    reprobeEveryN?: number;
}): FailClosedController {
    const reprobeEveryN = Math.max(1, options?.reprobeEveryN ?? FAIL_CLOSED_REPROBE_EVERY_N);
    let reason: FailClosedReason | null = null;
    let blockedPassCount = 0;

    return {
        arm(next: FailClosedReason): void {
            reason = next;
            blockedPassCount = 0;
        },
        clear(): void {
            reason = null;
            blockedPassCount = 0;
        },
        isArmed(): boolean {
            return reason !== null;
        },
        getReason(): FailClosedReason | null {
            return reason;
        },
        async enforce(input): Promise<void> {
            if (!reason) return;
            if (!input.blockingEnabled) return;
            if (input.exempt) return;

            blockedPassCount += 1;
            const shouldReprobe =
                typeof input.tryReopen === "function" &&
                (blockedPassCount === 1 || blockedPassCount % reprobeEveryN === 0);
            if (shouldReprobe) {
                try {
                    const healed = await input.tryReopen?.();
                    if (healed) {
                        reason = null;
                        blockedPassCount = 0;
                        return;
                    }
                } catch {
                    // Re-probe failed — keep blocking with the original reason.
                }
            }

            // Local capture: reason may be cleared by a concurrent heal path.
            const blockedReason = reason;
            if (!blockedReason) return;
            throw createFailClosedBlockingError(blockedReason);
        },
    };
}

/** Hook-init classification so boot can arm the gate only for storage failures. */
export type HookInitFailure =
    | { type: "storage"; reason: FailClosedReason }
    | { type: "no_project" };

let lastHookInitFailure: HookInitFailure | null = null;

export function recordHookInitFailure(failure: HookInitFailure): void {
    lastHookInitFailure = failure;
}

export function clearHookInitFailure(): void {
    lastHookInitFailure = null;
}

export function getLastHookInitFailure(): HookInitFailure | null {
    return lastHookInitFailure;
}
