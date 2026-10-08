import type { HiddenRunIdentity } from "../hooks/magic-context/compartment-runner-types";
import {
    HIDDEN_CURATE_AGENT,
    HIDDEN_DREAMER_AGENT,
    HIDDEN_HISTORIAN_AGENT,
    type HiddenPermissionRule,
    hiddenAgentFor,
    hiddenChildPermissions,
    hiddenToolLoop,
} from "./hooks/hidden-child";
import type { StoreRow } from "./store-reader";

/** Session carrier shared by the native hidden-run executor and lifecycle. */

export interface HiddenChildModel {
    providerID: string;
    modelID: string;
    variant?: string;
}

export type HiddenChildRole = "historian" | "dreamer" | "dreamer-curate";

export interface PersistedHiddenChild {
    id: string;
    role: HiddenChildRole;
    generation: string;
    title: string;
    model: HiddenChildModel;
    created_at: number;
    /** Directory passed to the host when creating this session, independent of later caller cwd. */
    directory?: string;
    /**
     * True once the child has completed with a settled reply, for keep_subagents retention.
     */
    ever_settled?: boolean;
}

/** The parts of a retired child that the `keep_subagents` retention rule looks at. */
export type RetentionFacts = Pick<PersistedHiddenChild, "role" | "ever_settled">;

export interface HiddenChildHost {
    create(input: {
        title: string;
        agent: string;
        model: { providerID: string; id: string; variant?: string };
        location?: { directory: string };
        metadata: { magic_context: "hidden-run"; role: HiddenChildRole };
        /** A child inherits this parent's location. */
        parentID?: string;
        /** Session rules; the host evaluates them after every rule of the agent. */
        permissions?: HiddenPermissionRule[];
    }): Promise<{ id: string }>;
    get(input: { sessionID: string }): Promise<{
        model?: { providerID: string; id: string; variant?: string };
        /** Returned only when the host exposes an error for the terminal session. */
        error?: unknown;
        /** The parent the host stored for the session, on hosts that keep one. */
        parentID?: string;
        /** The location the host bound the session to; a child takes its parent's. */
        location?: { directory?: string; workspaceID?: string };
    }>;
    /** Optional event-backed error lookup for hosts that do not retain the reason on session.get. */
    terminalError?(input: { sessionID: string }): Promise<unknown>;
    switchModel(input: {
        sessionID: string;
        model: { providerID: string; id: string; variant?: string };
    }): Promise<void>;
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    wait(input: { sessionID: string }): Promise<void>;
    interrupt(input: { sessionID: string }): Promise<{ interrupted: boolean }>;
    update(input: { sessionID: string; title: string }): Promise<void>;
    /**
     * The host's own session.remove. Startup refuses hosts without this capability.
     */
    removeSession?(input: { sessionID: string }): Promise<void>;
}

export interface HiddenChildRows {
    latestSequence(sessionID: string): number;
    latestAssistant(sessionID: string): StoreRow<"assistant"> | undefined;
    assistantSince?(sessionID: string, afterSeq: number): StoreRow<"assistant">[];
    latestIdle(sessionID: string): StoreRow<"idle"> | undefined;
}

/**
 * Where a hidden run's child comes from and where it goes. The executor drives the run itself
 * (prompting, waiting, reading the reply) independently of session cleanup.
 */
export interface HiddenChildLifecycle {
    /** A fresh child for the new run. */
    open(
        identity: HiddenRunIdentity,
        role: HiddenChildRole,
        model: HiddenChildModel,
    ): Promise<PersistedHiddenChild>;
    /** Always a new child; used when a retry finds its run's child already retired. */
    create(
        identity: HiddenRunIdentity,
        role: HiddenChildRole,
        model: HiddenChildModel,
    ): Promise<PersistedHiddenChild>;
    /** The child must never carry another run. Returns at once; cleanup happens off the run. */
    retire(child: PersistedHiddenChild, reason: string): void;
    /**
     * The run holding this child has ended. `retired` says whether `retire` already ran for it.
     * Resolves once any cleanup this lifecycle does for a finished run is over; never rejects.
     */
    finish(child: PersistedHiddenChild, retired: boolean): Promise<void>;
    updateModel(child: PersistedHiddenChild, model: HiddenChildModel): PersistedHiddenChild;
    markEverSettled(child: PersistedHiddenChild): PersistedHiddenChild;
}

/**
 * The `keep_subagents` rule of the OpenCode 1 lane, applied to a retired child. There, a child
 * whose prompt settled is kept, and an unsettled one is left to the age-gated orphan sweep,
 * which under `keep_subagents` still retains historian children but deletes the
 * privacy-sensitive dreamer ones. Without the setting every finished child is deleted.
 */
export function keptUnderRetention(keepSubagents: boolean, child: RetentionFacts): boolean {
    return keepSubagents && (child.ever_settled === true || child.role === "historian");
}

export function roleTitle(role: HiddenChildRole): string {
    return role === "historian" ? "Magic Context historian" : "Magic Context dreamer";
}

function roleAgent(role: HiddenChildRole): string {
    if (role === "historian") return HIDDEN_HISTORIAN_AGENT;
    return role === "dreamer-curate" ? HIDDEN_CURATE_AGENT : HIDDEN_DREAMER_AGENT;
}

/** The session.create input before adding a parent and inheriting its location. */
export function childCreateInput(
    identity: HiddenRunIdentity,
    role: HiddenChildRole,
    model: HiddenChildModel,
): Parameters<HiddenChildHost["create"]>[0] {
    const agent = hiddenToolLoop(identity) ? hiddenAgentFor(identity) : roleAgent(role);
    return {
        title: roleTitle(role),
        agent,
        model: {
            providerID: model.providerID,
            id: model.modelID,
            ...(model.variant ? { variant: model.variant } : {}),
        },
        location: { directory: identity.directory },
        metadata: { magic_context: "hidden-run", role },
        // The agent's own allowlist again, as session rules: the host evaluates
        // these after the agent's rules (which end with the user's global ones),
        // so here the allowlist is the last word on what the child may call.
        permissions: hiddenChildPermissions(agent),
    };
}

export function assistantOutcome(
    row: StoreRow<"assistant"> | undefined,
): "succeeded" | "failed" | "interrupted" | undefined {
    const outcome = row?.data.outcome;
    return outcome === "succeeded" || outcome === "failed" || outcome === "interrupted"
        ? outcome
        : undefined;
}

export function withReader<T>(
    openReader: () => HiddenChildRows & { close?: () => void },
    read: (reader: HiddenChildRows) => T,
): T {
    const reader = openReader();
    try {
        return read(reader);
    } finally {
        reader.close?.();
    }
}

export function errorText(value: unknown): string {
    if (value instanceof Error) return value.message;
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
