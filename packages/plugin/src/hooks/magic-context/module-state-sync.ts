import { createHmac, randomUUID } from "node:crypto";

import type { Compartment } from "../../features/magic-context/compartment-storage";
import {
    buildWorkspaceMemorySqlFilter,
    getMaxMemoryIdForProjects,
    getMemoriesByProject,
    getMemoriesByProjects,
    getMemoryEvidence,
    readNewMemoriesForM1Union,
} from "../../features/magic-context/memory/storage-memory";
import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getCompartments,
    getOrCreateSessionMeta,
    getProcessedImageStrippedIds,
    getStaleReduceStrippedIds,
    getStrippedPlaceholderIds,
} from "../../features/magic-context/storage";
import {
    getMaxMemoryMutationIdForProjects,
    getMemoryMutationsForRenderByProjects,
} from "../../features/magic-context/storage-memory-mutation-log";
import {
    getAutoSearchHintDecisions,
    getChannel2NudgeState,
    getEmergencyInputSample,
    getNoteNudgeAnchors,
    getPendingCompactionMarkerState,
    getPersistedTodoSyntheticAnchor,
    peekDeferredExecutePending,
} from "../../features/magic-context/storage-meta-persisted";
import { getPendingOps } from "../../features/magic-context/storage-ops";
import {
    GLOBAL_USER_PROFILE_PROJECT_PATH,
    getProjectState,
} from "../../features/magic-context/storage-project-state";
import {
    getDroppedTagsBySession,
    getTagsByNumbers,
} from "../../features/magic-context/storage-tags";
import type { TagEntry } from "../../features/magic-context/types";
import { getActiveUserMemories } from "../../features/magic-context/user-memory/storage-user-memory";
import {
    computeWorkspaceEpochFingerprint,
    expandWorkspaceIdentitySetWithAliases,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
} from "../../features/magic-context/workspaces";
import { getHarness } from "../../shared/harness";
import { sessionLog } from "../../shared/logger";
import { isRecord } from "../../shared/record-type-guard";
import { resolveTodowriteAvailability } from "./ctx-reduce-availability";
import { isModuleTransportGenerationChangedResult } from "./module-transport";
import { MODULE_PAGE_MAX_BYTES, moduleRawBlockMappings, moduleWireBodyBytes } from "./module-wire";
import {
    readRawSessionMessageOrdinalById,
    readRawSessionMessagePartsById,
} from "./read-session-chunk";
import type { RawMessageParts } from "./read-session-raw";
import { formatDate } from "./temporal-awareness";

export interface ModuleWatermarks {
    compartment_sequence: number;
    memory_id: number;
    m0_mutation_id: number;
    memory_mutation_id: number;
    last_todo_state_hash: string;
    project_memory_epoch: number;
    project_user_profile_version: number;
    /** Fingerprint of the current workspace epoch, used to determine whether cached
     * state-sync markers are still valid. */
    workspace_fingerprint?: string | null;
    reasoning_cleared_through_tag?: number;
}

export interface ModuleWorkspacePayload {
    fingerprint: string;
    members: Array<{ project_path: string; share_categories: string[] }>;
}

export type ModuleDropMode = "full" | "truncated" | "edit_marker";

export interface ModuleDropSeed {
    block_id: string;
    /** Paired result blocks for a tool tag; they use the module's drop kind. */
    related_block_ids?: string[];
    drop_mode: ModuleDropMode;
    /** Canonical edit-marker input, when the source tool carries one. */
    payload?: string;
}

export interface ModulePendingDropSeed {
    block_id: string;
    queued_at_ms: number;
}

export interface ModuleNoteNudgeAnchorSeed {
    message_id: string;
    text: string;
}

export interface ModuleAutoSearchHintSeed {
    block_id: string;
    /** Empty text is a durable no-hint decision. */
    hint_text: string;
}

export interface ModuleTodoSyntheticAnchorSeed {
    call_id: string;
    message_id: string;
    state_json: string;
}

export interface ModuleEmergencyLatchSeed {
    last_input_sample: number;
    has_prior_drop: boolean;
    last_execute_ordinal: number;
}

export interface ModulePendingCompactionMarkerSeed {
    ordinal: number;
    end_message_id: string;
    published_at: number;
}

export interface ModuleDeferredExecuteSeed {
    id: string;
    reason: string;
    recorded_at: number;
}

export type ModuleStripKind =
    | "placeholder"
    | "system_injected"
    | "stale_reduce"
    | "processed_image";

/** TypeScript-owned message strips to replay while the module warms up. */
export interface ModuleStripSeed {
    message_id: string;
    strip_kind: ModuleStripKind;
}

export interface ModuleStateSyncPayload {
    method: "state_sync";
    params: {
        session_id?: string;
        shadow_generation: number;
        expected_shadow_seq: number;
        seed_id?: string;
        seed_generation?: number;
        seed_batch_index?: number;
        seed_batch_total?: number;
        seed_complete?: boolean;
        seed_boundary_id?: string | null;
        compartments: unknown[];
        memories?: unknown[];
        memory_mutations?: unknown[];
        user_profile?: string[];
        workspace?: ModuleWorkspacePayload | null;
        last_todo_state?: string;
        project_memory_epoch?: number;
        user_profile_version?: number;
        acked_watermarks?: ModuleWatermarks;
        drop_seeds?: ModuleDropSeed[];
        drop_seed_skipped?: number;
        pending_agent_drops?: ModulePendingDropSeed[];
        pending_agent_drops_skipped?: number;
        note_nudge_anchors?: ModuleNoteNudgeAnchorSeed[];
        auto_search_hint_decisions?: ModuleAutoSearchHintSeed[];
        auto_search_hint_skipped?: number;
        todo_synthetic_anchor?: ModuleTodoSyntheticAnchorSeed | null;
        emergency_latches?: ModuleEmergencyLatchSeed;
        pending_compaction_marker?: ModulePendingCompactionMarkerSeed | null;
        deferred_execute_state?: ModuleDeferredExecuteSeed | null;
        channel2_nudge_state?: string;
        strip_seeds?: ModuleStripSeed[];
        strip_seed_skipped?: number;
        reasoning_cleared_through_tag?: number;
    };
    watermarks: ModuleWatermarks;
    wireBatches?: ModuleStateSyncPayload[];
}

/** The subset of sender state needed to serialize a state-sync payload. */
export interface ModuleStateSyncState {
    moduleGeneration: number;
    lastAckedSeq: number;
    lastAckedWatermarks: ModuleWatermarks | null;
    idOrdinalMemoGeneration: number;
    idOrdinalMemo: Map<string, number>;
    seedPassPending?: boolean;
    authorityMemorySyncSkipLogged?: boolean;
}

export interface ModuleStateSyncPass {
    db: ContextDatabase;
    sessionId: string;
    projectPath?: string;
    nowMs: number;
}

export interface ModuleStateSyncOptions {
    beforeSerializeCompartment?: () => void;
    yieldEveryCompartments?: number;
    shouldAbortSeed?: () => boolean;
    /** Cached authority state used only to avoid sending rows the module already owns. */
    authorityState?: "TS" | "PREPARING" | "MODULE" | "DRAINING";
    /** Enable the authority sender's one-time durable-sequence adoption. */
    authority?: boolean;
    /** Set only after the module status/hello advertises state_sync_deltas. */
    stateSyncDeltas?: boolean;
    /** Share adoption state across every authority sync attempt in one transform pass. */
    authoritySeqAdoption?: { used: boolean };
}

export interface ModuleCompartmentMirrorRow {
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string;
    end_message_id: string;
    title: string;
    content: string;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    episode_type?: string | null;
    legacy?: number | null;
    created_at?: number;
}

export interface ModuleCompartmentMirrorResponse {
    max_sequence: number;
    compartments: ModuleCompartmentMirrorRow[];
    /** Present on session.status; a count of 0 after a non-empty cursor is a set wipe. */
    compartment_count?: number;
    /** Incremented when the published set is rebuilt, recomputed, or restored. Those rewrites can replace existing rows without advancing max_sequence. */
    revert_epoch?: number;
    /** Optional flag that the published set was rewritten in place. Older responses omit it. */
    set_changed?: boolean;
}

/**
 * The module owns its SQLite file, so TS cannot read rows directly. This narrow
 * reader is the seam for the module's future `session.status` compartment page.
 * It deliberately returns typed rows instead of pretending the TS database is
 * authoritative for module-published content.
 */
export interface ModuleCompartmentReader {
    getCompartmentsAfter(
        sessionId: string,
        afterSequence: number,
    ): Promise<ModuleCompartmentMirrorResponse>;
}

interface CompartmentMirrorCursor {
    lastMaxSequence: number;
    lastCompartmentCount?: number;
    lastRevertEpoch?: number;
}

const compartmentMirrorCursors = new Map<string, CompartmentMirrorCursor>();

export function clearCompartmentMirrorCursor(sessionId: string): void {
    compartmentMirrorCursors.delete(sessionId);
}

export function resetCompartmentMirrorCursorsForTest(): void {
    compartmentMirrorCursors.clear();
}

function validateMirrorRow(
    compartment: ModuleCompartmentMirrorRow,
    afterSequence: number,
    maxSequence: number,
): void {
    if (
        !Number.isSafeInteger(compartment.sequence) ||
        compartment.sequence <= afterSequence ||
        compartment.sequence > maxSequence ||
        !Number.isSafeInteger(compartment.start_message) ||
        !Number.isSafeInteger(compartment.end_message) ||
        typeof compartment.start_message_id !== "string" ||
        typeof compartment.end_message_id !== "string" ||
        typeof compartment.title !== "string" ||
        typeof compartment.content !== "string"
    ) {
        throw new Error("module compartment mirror returned an invalid authoritative row");
    }
}

function validateMirrorPage(
    published: ModuleCompartmentMirrorResponse,
    maxSequence: number | null,
): void {
    if (
        !Number.isSafeInteger(published.max_sequence) ||
        published.max_sequence < -1 ||
        (maxSequence !== null && published.max_sequence !== maxSequence)
    ) {
        throw new Error("module compartment mirror changed while its authoritative set was read");
    }
}

function compartmentMirrorSetChanged(
    published: ModuleCompartmentMirrorResponse,
    cursor: CompartmentMirrorCursor,
): boolean {
    if (published.set_changed === true) return true;
    if (
        published.revert_epoch !== undefined &&
        cursor.lastRevertEpoch !== undefined &&
        published.revert_epoch !== cursor.lastRevertEpoch
    ) {
        return true;
    }
    // session.status reports max_sequence = after_sequence when the table is empty,
    // so a wipe is invisible to the sequence cursor. A zero count is the set change.
    if (
        published.compartment_count === 0 &&
        cursor.lastMaxSequence >= 0 &&
        published.compartments.length === 0
    ) {
        return true;
    }
    if (
        published.compartment_count !== undefined &&
        published.compartments.length === 0 &&
        published.max_sequence === cursor.lastMaxSequence &&
        published.compartment_count !== (cursor.lastCompartmentCount ?? cursor.lastMaxSequence)
    ) {
        return true;
    }
    return false;
}

function rememberCompartmentMirrorCursor(
    sessionId: string,
    maxSequence: number,
    published: ModuleCompartmentMirrorResponse,
    authoritativeCount: number,
): void {
    compartmentMirrorCursors.set(sessionId, {
        lastMaxSequence: maxSequence,
        lastCompartmentCount: published.compartment_count ?? authoritativeCount,
        lastRevertEpoch: published.revert_epoch,
    });
}

async function resyncModuleCompartmentsFromAuthoritative(args: {
    db: ContextDatabase;
    sessionId: string;
    reader: ModuleCompartmentReader;
}): Promise<number> {
    const authoritative: ModuleCompartmentMirrorRow[] = [];
    let afterSequence = -1;
    let maxSequence: number | null = null;
    let lastPublished: ModuleCompartmentMirrorResponse | undefined;

    for (;;) {
        const published = await args.reader.getCompartmentsAfter(args.sessionId, afterSequence);
        validateMirrorPage(published, maxSequence);
        maxSequence ??= published.max_sequence;
        lastPublished = published;

        let pageAdvanced = false;
        for (const compartment of published.compartments) {
            validateMirrorRow(compartment, afterSequence, maxSequence);
            authoritative.push(compartment);
            afterSequence = compartment.sequence;
            pageAdvanced = true;
        }

        if (afterSequence >= maxSequence) break;
        if (!pageAdvanced) {
            throw new Error("module compartment mirror returned an incomplete authoritative set");
        }
    }

    const local = args.db
        .prepare(
            "SELECT sequence, end_message FROM compartments WHERE session_id = ? ORDER BY sequence ASC",
        )
        .all(args.sessionId) as Array<{ sequence: number; end_message: number }>;
    let firstDifference = 0;
    while (
        firstDifference < local.length &&
        firstDifference < authoritative.length &&
        local[firstDifference]?.sequence === authoritative[firstDifference]?.sequence &&
        local[firstDifference]?.end_message === authoritative[firstDifference]?.end_message
    ) {
        firstDifference += 1;
    }
    const localDifference = local[firstDifference]?.sequence;
    const authoritativeDifference = authoritative[firstDifference]?.sequence;
    const divergentSequence =
        localDifference === undefined
            ? authoritativeDifference
            : authoritativeDifference === undefined
              ? localDifference
              : Math.min(localDifference, authoritativeDifference);

    const upsert = args.db.prepare(
        `INSERT INTO compartments
            (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
             title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, sequence) DO UPDATE SET
             start_message = excluded.start_message,
             end_message = excluded.end_message,
             start_message_id = excluded.start_message_id,
             end_message_id = excluded.end_message_id,
             title = excluded.title,
             content = excluded.content,
             p1 = excluded.p1,
             p2 = excluded.p2,
             p3 = excluded.p3,
             p4 = excluded.p4,
             importance = excluded.importance,
             episode_type = excluded.episode_type,
             legacy = excluded.legacy,
             created_at = excluded.created_at,
             harness = excluded.harness`,
    );
    const now = Date.now();
    args.db.transaction(() => {
        if (divergentSequence !== undefined) {
            args.db
                .prepare("DELETE FROM compartments WHERE session_id = ? AND sequence >= ?")
                .run(args.sessionId, divergentSequence);
        }
        for (const compartment of authoritative) {
            upsert.run(
                args.sessionId,
                compartment.sequence,
                compartment.start_message,
                compartment.end_message,
                compartment.start_message_id,
                compartment.end_message_id,
                compartment.title,
                compartment.content,
                compartment.p1 ?? null,
                compartment.p2 ?? null,
                compartment.p3 ?? null,
                compartment.p4 ?? null,
                compartment.importance ?? 50,
                compartment.episode_type ?? null,
                compartment.legacy ?? (compartment.p1 ? 0 : 1),
                compartment.created_at ?? now,
                getHarness(),
            );
        }
    })();
    rememberCompartmentMirrorCursor(
        args.sessionId,
        maxSequence,
        lastPublished ?? { max_sequence: maxSequence, compartments: [] },
        authoritative.length,
    );
    return maxSequence;
}

export async function mirrorModuleCompartments(args: {
    db: ContextDatabase;
    sessionId: string;
    reader: ModuleCompartmentReader;
}): Promise<number> {
    // A process-local cursor avoids re-reading the full authoritative set on every
    // pass. The first call, a max_sequence regression, a sequence gap, or a set
    // change the cursor cannot express still walks from -1.
    const cursor = compartmentMirrorCursors.get(args.sessionId);
    if (cursor !== undefined) {
        const published = await args.reader.getCompartmentsAfter(
            args.sessionId,
            cursor.lastMaxSequence,
        );
        validateMirrorPage(published, null);
        for (const compartment of published.compartments) {
            validateMirrorRow(compartment, cursor.lastMaxSequence, published.max_sequence);
        }
        const firstNew = published.compartments[0];
        const hasGap = firstNew !== undefined && firstNew.sequence !== cursor.lastMaxSequence + 1;
        const regressed = published.max_sequence < cursor.lastMaxSequence;
        const setChanged = compartmentMirrorSetChanged(published, cursor);
        if (
            !regressed &&
            !hasGap &&
            !setChanged &&
            published.compartments.length === 0 &&
            published.max_sequence === cursor.lastMaxSequence
        ) {
            return published.max_sequence;
        }
    }

    return resyncModuleCompartmentsFromAuthoritative(args);
}

interface ModuleWorkspaceContext {
    workspace: ModuleWorkspacePayload | null;
    expandedIdentities: string[];
    ownIdentities: string[];
    shareCategories: string[] | null;
}

function stableHash(value: string): string {
    return createHmac("sha256", "magic-context-shadow-watermark").update(value).digest("hex");
}

/**
 * The todo state we report to the Rust module for a session.
 *
 * When the session's tools map filters the native todowrite tool out (frozen
 * "unavailable" verdict), we report an EMPTY state instead of the persisted
 * one. The module's existing content-change handling then drops the synthetic
 * todo pair on its next cache-busting render. Reporting empty here (rather than
 * the stale persisted state) keeps a disabled tool from being replayed into the
 * module's wire content. The watermark hash is computed from this same value so
 * the flip to empty registers as a content change and actually triggers a
 * re-sync. A provisional verdict fails open and reports the real state.
 */
function effectiveLastTodoState(
    sessionId: string,
    sessionMeta: { lastTodoState?: string | null },
): string {
    const verdict = resolveTodowriteAvailability(sessionId);
    if (verdict.frozen && !verdict.callable) return "";
    return sessionMeta.lastTodoState ?? "";
}

function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function resolveModuleWorkspaceContext(
    db: ContextDatabase,
    projectPath?: string,
): ModuleWorkspaceContext {
    if (!projectPath) {
        return {
            workspace: null,
            expandedIdentities: [],
            ownIdentities: [],
            shareCategories: null,
        };
    }
    const identitySet = resolveWorkspaceIdentitySet(db, projectPath);
    if (identitySet.identities.length <= 1) {
        return {
            workspace: null,
            expandedIdentities: [projectPath],
            ownIdentities: [projectPath],
            shareCategories: null,
        };
    }
    const expanded = expandWorkspaceIdentitySetWithAliases(db, identitySet.identities);
    const ownIdentities = expanded.expandedIdentities.filter(
        (identity) => expanded.canonicalIdentityByStoredPath.get(identity) === projectPath,
    );
    if (ownIdentities.length === 0) ownIdentities.push(projectPath);
    const shareCategories = resolveWorkspaceShareCategories(db, projectPath) ?? [];
    const members = [
        projectPath,
        ...expanded.expandedIdentities
            .filter((identity) => identity !== projectPath)
            .sort((left, right) => left.localeCompare(right)),
    ];
    return {
        workspace: {
            fingerprint: computeWorkspaceEpochFingerprint(db, identitySet.identities),
            members: members.map((member) => ({
                project_path: member,
                share_categories: [...shareCategories],
            })),
        },
        expandedIdentities: members,
        ownIdentities,
        shareCategories,
    };
}

export function loadModuleWatermarks(args: {
    db: ContextDatabase;
    sessionId: string;
    projectPath?: string;
    /** Reuse the workspace resolved by the enclosing payload build. */
    workspace?: ModuleWorkspaceContext;
}): ModuleWatermarks {
    const workspace = args.workspace ?? resolveModuleWorkspaceContext(args.db, args.projectPath);
    const sessionMeta = getOrCreateSessionMeta(args.db, args.sessionId);
    const compartmentRow = args.db
        .prepare(
            "SELECT COALESCE(MAX(sequence), -1) AS max_sequence FROM compartments WHERE session_id = ?",
        )
        .get(args.sessionId) as { max_sequence?: number } | undefined;
    const memoryId = args.projectPath
        ? getMaxMemoryIdForProjects(
              args.db,
              workspace.expandedIdentities,
              workspace.ownIdentities,
              workspace.shareCategories,
          )
        : 0;
    const m0Row = args.db
        .prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM m0_mutation_log WHERE session_id = ?")
        .get(args.sessionId) as { max_id?: number } | undefined;
    const memoryMutationId = args.projectPath
        ? (getMaxMemoryMutationIdForProjects(args.db, workspace.expandedIdentities) ?? 0)
        : 0;
    return {
        compartment_sequence: compartmentRow?.max_sequence ?? -1,
        memory_id: memoryId,
        m0_mutation_id: m0Row?.max_id ?? 0,
        memory_mutation_id: memoryMutationId,
        last_todo_state_hash: stableHash(effectiveLastTodoState(args.sessionId, sessionMeta)),
        project_memory_epoch: args.projectPath
            ? (getProjectState(args.db, args.projectPath)?.projectMemoryEpoch ?? 0)
            : 0,
        project_user_profile_version:
            getProjectState(args.db, GLOBAL_USER_PROFILE_PROJECT_PATH)?.projectUserProfileVersion ??
            0,
        workspace_fingerprint: workspace.workspace?.fingerprint ?? null,
        reasoning_cleared_through_tag: sessionMeta.clearedReasoningThroughTag ?? 0,
    };
}

export function moduleWatermarksEqual(
    left: ModuleWatermarks | null,
    right: ModuleWatermarks,
): boolean {
    return (
        left !== null &&
        left.compartment_sequence === right.compartment_sequence &&
        left.memory_id === right.memory_id &&
        left.m0_mutation_id === right.m0_mutation_id &&
        left.memory_mutation_id === right.memory_mutation_id &&
        left.last_todo_state_hash === right.last_todo_state_hash &&
        left.project_memory_epoch === right.project_memory_epoch &&
        left.project_user_profile_version === right.project_user_profile_version &&
        (left.workspace_fingerprint ?? null) === (right.workspace_fingerprint ?? null) &&
        (left.reasoning_cleared_through_tag ?? 0) === (right.reasoning_cleared_through_tag ?? 0)
    );
}

function flatBlockIdForRawMessage(
    messageId: string,
    raw: RawMessageParts | null,
    edge: "start" | "end",
): string {
    const mappings = moduleRawBlockMappings(raw);
    const blockIndex = edge === "start" ? 0 : (mappings.at(-1)?.blockIndex ?? 0);
    return `${messageId}#${blockIndex}`;
}

/**
 * Compartment rows retain ordinals from the TS storage basis, which can include
 * synthetic summary rows. Resolve module boundaries from the summary-excluding
 * basis so the shared memo compares one canonical value everywhere.
 */
export function canonicalOrdinalForMessageId(args: {
    sessionId: string;
    raw: RawMessageParts | null;
    messageId: string;
    generation: number;
    state: ModuleStateSyncState;
}): number | null | "mismatch" {
    if (args.state.idOrdinalMemoGeneration !== args.generation) {
        args.state.idOrdinalMemo.clear();
        args.state.idOrdinalMemoGeneration = args.generation;
    }
    if (!args.raw || args.raw.id !== args.messageId) return null;
    const prior = args.state.idOrdinalMemo.get(args.messageId);
    if (prior !== undefined) return prior;
    const canonical = readRawSessionMessageOrdinalById(args.sessionId, args.messageId);
    if (canonical === null || canonical < 1) return null;
    args.state.idOrdinalMemo.set(args.messageId, canonical);
    return canonical;
}

function serializeCompartment(args: {
    compartment: ReturnType<typeof getCompartments>[number];
    sessionId: string;
    readRawById: (messageId: string) => RawMessageParts | null;
    state: ModuleStateSyncState;
}): unknown | null | "mismatch" {
    const startRaw = args.readRawById(args.compartment.startMessageId);
    const endRaw = args.readRawById(args.compartment.endMessageId);
    const startOrdinal = canonicalOrdinalForMessageId({
        sessionId: args.sessionId,
        raw: startRaw,
        messageId: args.compartment.startMessageId,
        generation: args.state.moduleGeneration,
        state: args.state,
    });
    const endOrdinal = canonicalOrdinalForMessageId({
        sessionId: args.sessionId,
        raw: endRaw,
        messageId: args.compartment.endMessageId,
        generation: args.state.moduleGeneration,
        state: args.state,
    });
    if (startOrdinal === "mismatch" || endOrdinal === "mismatch") return "mismatch";
    if (startOrdinal === null || endOrdinal === null) return null;
    const startCreatedAt = startRaw?.createdAt;
    const endCreatedAt = endRaw?.createdAt;
    const dateRange =
        typeof startCreatedAt === "number" && typeof endCreatedAt === "number"
            ? { start_date: formatDate(startCreatedAt), end_date: formatDate(endCreatedAt) }
            : {};
    return {
        sequence: args.compartment.sequence,
        start_message: startOrdinal,
        end_message: endOrdinal,
        start_message_id: flatBlockIdForRawMessage(
            args.compartment.startMessageId,
            startRaw,
            "start",
        ),
        end_message_id: flatBlockIdForRawMessage(args.compartment.endMessageId, endRaw, "end"),
        ...dateRange,
        title: args.compartment.title,
        content: args.compartment.content,
        p1: args.compartment.p1,
        p2: args.compartment.p2,
        p3: args.compartment.p3,
        p4: args.compartment.p4,
        importance: args.compartment.importance,
        episode_type: args.compartment.episodeType,
        legacy: args.compartment.legacy,
        created_at: args.compartment.createdAt,
    };
}

function seedBoundaryFromSerializedCompartments(compartments: unknown[]): string | null {
    const serialized = compartments
        .filter(isRecord)
        .filter(
            (compartment) =>
                typeof compartment.sequence === "number" &&
                typeof compartment.end_message_id === "string",
        );
    serialized.sort((left, right) => (left.sequence as number) - (right.sequence as number));
    const tail = serialized.at(-1);
    return typeof tail?.end_message_id === "string" ? tail.end_message_id : null;
}

function canonicalSeedJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalSeedJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalSeedJson(record[key])}`)
            .join(",")}}`;
    }
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
}

function editMarkerSeedPayload(input: unknown): string | undefined {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
    const copy = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    const pathKeys = new Set(["filePath", "file_path", "path"]);
    const diffKeys = new Set(["oldString", "newString", "content", "old_string", "new_string"]);
    for (const [key, value] of Object.entries(copy)) {
        if (pathKeys.has(key) || !diffKeys.has(key) || typeof value !== "string") continue;
        if (value.endsWith("...[truncated]")) continue;
        if (value.length > 40) {
            const end = value.charCodeAt(39) >= 0xd800 && value.charCodeAt(39) <= 0xdbff ? 39 : 40;
            copy[key] = `${value.slice(0, end)}...[truncated]`;
        }
    }
    return canonicalSeedJson(copy);
}

function dropSeedAddress(tag: TagEntry): { messageId: string; partIndex: number | null } | null {
    const match = /^(.*):(p|file)(\d+)$/.exec(tag.messageId);
    if (!match) return { messageId: tag.messageId, partIndex: null };
    return { messageId: match[1], partIndex: Number(match[3]) };
}

function dropSeedForTag(args: {
    tag: TagEntry;
    readRawById: (messageId: string) => RawMessageParts | null;
}): { seed: ModuleDropSeed } | { reason: string } {
    const tag = args.tag;
    if (tag.type === "tool") {
        if (!tag.toolOwnerMessageId) return { reason: "tool owner message is missing" };
        const raw = args.readRawById(tag.toolOwnerMessageId);
        const mappings = moduleRawBlockMappings(raw);
        const call = mappings.find(
            (mapping) => mapping.kind === "tool_call" && mapping.callId === tag.messageId,
        );
        if (!call) return { reason: "tool call no longer maps to a module block" };
        const related = mappings
            .filter((mapping) => mapping.kind === "tool_result" && mapping.callId === tag.messageId)
            .map((mapping) => `${tag.toolOwnerMessageId}#${mapping.blockIndex}`)
            .sort();
        return {
            seed: {
                block_id: `${tag.toolOwnerMessageId}#${call.blockIndex}`,
                ...(related.length > 0 ? { related_block_ids: related } : {}),
                drop_mode: tag.dropMode,
                ...(tag.dropMode === "edit_marker"
                    ? { payload: editMarkerSeedPayload(call.toolInput) }
                    : {}),
            },
        };
    }
    if (tag.messageId.length === 0) return { reason: "message tag identity is empty" };
    const address = dropSeedAddress(tag);
    if (!address) return { reason: "message tag identity is empty" };
    const mappings = moduleRawBlockMappings(args.readRawById(address.messageId));
    const mapping = mappings.find(
        (candidate) =>
            (address.partIndex === null || candidate.partIndex === address.partIndex) &&
            (tag.type === "file" ? candidate.kind === "file" : candidate.kind === "text"),
    );
    if (!mapping) return { reason: "message part no longer maps to a module block" };
    return {
        seed: {
            block_id: `${address.messageId}#${mapping.blockIndex}`,
            drop_mode: tag.dropMode,
        },
    };
}

function buildDropSeeds(args: {
    db: ContextDatabase;
    sessionId: string;
    readRawById: (messageId: string) => RawMessageParts | null;
}): { seeds: ModuleDropSeed[]; skipped: number } {
    const byBlock = new Map<string, ModuleDropSeed>();
    let skipped = 0;
    for (const tag of getDroppedTagsBySession(args.db, args.sessionId)) {
        if (tag.status !== "dropped") continue;
        const result = dropSeedForTag({ tag, readRawById: args.readRawById });
        if (!("seed" in result)) {
            skipped += 1;
            sessionLog(
                args.sessionId,
                `module drop seed skipped tag ${tag.tagNumber}: ${result.reason}`,
            );
            continue;
        }
        const existing = byBlock.get(result.seed.block_id);
        if (!existing || canonicalSeedJson(result.seed) < canonicalSeedJson(existing)) {
            byBlock.set(result.seed.block_id, result.seed);
        }
    }
    return {
        seeds: [...byBlock.values()].sort((left, right) =>
            canonicalSeedJson(left).localeCompare(canonicalSeedJson(right)),
        ),
        skipped,
    };
}

function buildPendingDropSeeds(args: {
    db: ContextDatabase;
    sessionId: string;
    readRawById: (messageId: string) => RawMessageParts | null;
}): { seeds: ModulePendingDropSeed[]; skipped: number } {
    const pendingOps = getPendingOps(args.db, args.sessionId);
    const tagsByNumber = new Map(
        getTagsByNumbers(
            args.db,
            args.sessionId,
            pendingOps.map((op) => op.tagId),
        ).map((tag) => [tag.tagNumber, tag] as const),
    );
    const byBlock = new Map<string, ModulePendingDropSeed>();
    let skipped = 0;
    for (const op of pendingOps) {
        const tag = tagsByNumber.get(op.tagId);
        if (!tag) {
            skipped += 1;
            sessionLog(
                args.sessionId,
                `module pending drop seed skipped tag ${op.tagId}: tag is missing`,
            );
            continue;
        }
        const result = dropSeedForTag({ tag, readRawById: args.readRawById });
        if (!("seed" in result)) {
            skipped += 1;
            sessionLog(
                args.sessionId,
                `module pending drop seed skipped tag ${tag.tagNumber}: ${result.reason}`,
            );
            continue;
        }
        const seed = { block_id: result.seed.block_id, queued_at_ms: op.queuedAt };
        const existing = byBlock.get(seed.block_id);
        if (!existing || seed.queued_at_ms < existing.queued_at_ms)
            byBlock.set(seed.block_id, seed);
    }
    return {
        seeds: [...byBlock.values()].sort((left, right) =>
            canonicalSeedJson(left).localeCompare(canonicalSeedJson(right)),
        ),
        skipped,
    };
}

function buildAutoSearchHintSeeds(args: {
    db: ContextDatabase;
    sessionId: string;
    readRawById: (messageId: string) => RawMessageParts | null;
}): { seeds: ModuleAutoSearchHintSeed[]; skipped: number } {
    const byBlock = new Map<string, ModuleAutoSearchHintSeed>();
    let skipped = 0;
    for (const value of getAutoSearchHintDecisions(args.db, args.sessionId)) {
        if (typeof value.messageId !== "string") {
            skipped += 1;
            continue;
        }
        const mapping = moduleRawBlockMappings(args.readRawById(value.messageId)).find(
            (candidate) => candidate.kind === "text",
        );
        if (!mapping) {
            skipped += 1;
            sessionLog(
                args.sessionId,
                `module auto-search decision seed skipped message ${value.messageId}: text block is missing`,
            );
            continue;
        }
        const hintText = value.decision === "hint" ? value.text : "";
        byBlock.set(`${value.messageId}#${mapping.blockIndex}`, {
            block_id: `${value.messageId}#${mapping.blockIndex}`,
            hint_text: hintText,
        });
    }
    return {
        seeds: [...byBlock.values()].sort((left, right) =>
            canonicalSeedJson(left).localeCompare(canonicalSeedJson(right)),
        ),
        skipped,
    };
}

function buildStripSeeds(args: { db: ContextDatabase; sessionId: string }): ModuleStripSeed[] {
    const byKey = new Map<string, ModuleStripSeed>();
    const add = (messageId: string, stripKind: ModuleStripKind): void => {
        if (messageId.length === 0) return;
        const seed = { message_id: messageId, strip_kind: stripKind } satisfies ModuleStripSeed;
        byKey.set(`${stripKind}:${messageId}`, seed);
    };
    // The placeholder table intentionally includes both dropped shells and internal
    // notifications; both are whole-message neutralization decisions on the wire.
    for (const messageId of getStrippedPlaceholderIds(args.db, args.sessionId)) {
        add(messageId, "placeholder");
    }
    for (const messageId of getStaleReduceStrippedIds(args.db, args.sessionId)) {
        add(messageId, "stale_reduce");
    }
    for (const messageId of getProcessedImageStrippedIds(args.db, args.sessionId)) {
        add(messageId, "processed_image");
    }
    return [...byKey.values()].sort((left, right) =>
        canonicalSeedJson(left).localeCompare(canonicalSeedJson(right)),
    );
}

type SeedItem =
    | { kind: "compartment"; value: unknown }
    | { kind: "memory"; value: unknown }
    | { kind: "memory_mutation"; value: unknown }
    | { kind: "drop_seed"; value: ModuleDropSeed }
    | { kind: "pending_agent_drop"; value: ModulePendingDropSeed }
    | { kind: "note_nudge_anchor"; value: ModuleNoteNudgeAnchorSeed }
    | { kind: "auto_search_hint"; value: ModuleAutoSearchHintSeed }
    | { kind: "strip_seed"; value: ModuleStripSeed }
    | { kind: "user_profile"; value: string };

function readCompartmentsAfterSequence(
    db: ContextDatabase,
    sessionId: string,
    afterSequence: number,
): Compartment[] {
    const rows = db
        .prepare(
            `SELECT id, session_id, sequence, start_message, end_message,
                    start_message_id, end_message_id, title, content,
                    p1, p2, p3, p4, importance, episode_type, legacy, created_at
               FROM compartments
              WHERE session_id = ? AND sequence > ?
              ORDER BY sequence ASC`,
        )
        .all(sessionId, afterSequence) as Array<Record<string, unknown>>;
    return rows
        .filter(
            (row) =>
                typeof row.id === "number" &&
                typeof row.session_id === "string" &&
                typeof row.sequence === "number" &&
                typeof row.start_message === "number" &&
                typeof row.end_message === "number" &&
                typeof row.start_message_id === "string" &&
                typeof row.end_message_id === "string" &&
                typeof row.title === "string" &&
                typeof row.content === "string" &&
                typeof row.created_at === "number",
        )
        .map((row) => ({
            id: row.id as number,
            sessionId: row.session_id as string,
            sequence: row.sequence as number,
            startMessage: row.start_message as number,
            endMessage: row.end_message as number,
            startMessageId: row.start_message_id as string,
            endMessageId: row.end_message_id as string,
            title: row.title as string,
            content: row.content as string,
            p1: typeof row.p1 === "string" ? row.p1 : null,
            p2: typeof row.p2 === "string" ? row.p2 : null,
            p3: typeof row.p3 === "string" ? row.p3 : null,
            p4: typeof row.p4 === "string" ? row.p4 : null,
            importance: typeof row.importance === "number" ? row.importance : 50,
            episodeType: typeof row.episode_type === "string" ? row.episode_type : null,
            legacy: typeof row.legacy === "number" ? row.legacy : 0,
            createdAt: row.created_at as number,
        }));
}

function readRenderedMemoryIds(args: {
    db: ContextDatabase;
    projectPath?: string;
    workspace: ModuleWorkspaceContext;
    nowMs: number;
}): number[] {
    if (!args.projectPath) return [];
    const identities =
        args.workspace.expandedIdentities.length > 0
            ? args.workspace.expandedIdentities
            : [args.projectPath];
    const filter = buildWorkspaceMemorySqlFilter({
        identities,
        ownIdentities: args.workspace.ownIdentities,
        shareCategories: args.workspace.shareCategories,
        tableName: "m",
    });
    const placeholders = identities.map(() => "?").join(", ");
    const rows = args.db
        .prepare(
            `SELECT m.id
               FROM memories AS m
              WHERE m.project_path IN (${placeholders})
                AND m.status IN ('active', 'permanent')
                AND (m.expires_at IS NULL OR m.expires_at > ?)
                ${filter.clause}
              ORDER BY m.id ASC`,
        )
        .all(...identities, args.nowMs, ...filter.params) as Array<{ id?: unknown }>;
    return rows.flatMap((row) => (typeof row.id === "number" ? [row.id] : []));
}

function encodedSeedItemBytes(item: SeedItem): number {
    const encoded = JSON.stringify(item.value);
    return Buffer.byteLength(encoded === undefined ? "null" : encoded);
}

export function buildPagedModuleStateSyncPayloads(args: {
    moduleGeneration: number;
    expectedShadowSeq: number;
    seedId: string;
    seedBoundaryId: string | null;
    compartments: unknown[];
    memories: unknown[];
    memoryMutations: unknown[];
    dropSeeds?: ModuleDropSeed[];
    dropSeedSkipped?: number;
    pendingDropSeeds?: ModulePendingDropSeed[];
    pendingDropSkipped?: number;
    noteNudgeAnchors?: ModuleNoteNudgeAnchorSeed[];
    autoSearchHintSeeds?: ModuleAutoSearchHintSeed[];
    autoSearchHintSkipped?: number;
    todoSyntheticAnchor?: ModuleTodoSyntheticAnchorSeed | null;
    emergencyLatches?: ModuleEmergencyLatchSeed;
    pendingCompactionMarker?: ModulePendingCompactionMarkerSeed | null;
    deferredExecuteState?: ModuleDeferredExecuteSeed | null;
    channel2NudgeState?: string;
    stripSeeds?: ModuleStripSeed[];
    stripSeedSkipped?: number;
    reasoningClearedThroughTag?: number;
    userProfile: string[];
    workspace: ModuleWorkspacePayload | null;
    lastTodoState: string;
    watermarks: ModuleWatermarks;
    omitAuthorityMemorySections?: boolean;
}): ModuleStateSyncPayload[] {
    const items: SeedItem[] = [
        ...args.compartments.map((value) => ({ kind: "compartment", value }) as const),
        ...(args.omitAuthorityMemorySections
            ? []
            : args.memories.map((value) => ({ kind: "memory", value }) as const)),
        ...(args.omitAuthorityMemorySections
            ? []
            : args.memoryMutations.map((value) => ({ kind: "memory_mutation", value }) as const)),
        ...(args.dropSeeds ?? []).map((value) => ({ kind: "drop_seed", value }) as const),
        ...(args.pendingDropSeeds ?? []).map(
            (value) => ({ kind: "pending_agent_drop", value }) as const,
        ),
        ...(args.noteNudgeAnchors ?? []).map(
            (value) => ({ kind: "note_nudge_anchor", value }) as const,
        ),
        ...(args.autoSearchHintSeeds ?? []).map(
            (value) => ({ kind: "auto_search_hint", value }) as const,
        ),
        ...(args.stripSeeds ?? []).map((value) => ({ kind: "strip_seed", value }) as const),
        ...args.userProfile.map((value) => ({ kind: "user_profile", value }) as const),
    ];

    type SeedBatch = {
        compartments: unknown[];
        memories: unknown[];
        memoryMutations: unknown[];
        dropSeeds: ModuleDropSeed[];
        pendingAgentDrops: ModulePendingDropSeed[];
        noteNudgeAnchors: ModuleNoteNudgeAnchorSeed[];
        autoSearchHintDecisions: ModuleAutoSearchHintSeed[];
        stripSeeds: ModuleStripSeed[];
        userProfile: string[];
    };

    const emptyBatch = (): SeedBatch => ({
        compartments: [],
        memories: [],
        memoryMutations: [],
        dropSeeds: [],
        pendingAgentDrops: [],
        noteNudgeAnchors: [],
        autoSearchHintDecisions: [],
        stripSeeds: [],
        userProfile: [],
    });

    const appendItem = (batch: SeedBatch, item: SeedItem): void => {
        if (item.kind === "compartment") batch.compartments.push(item.value);
        else if (item.kind === "memory") batch.memories.push(item.value);
        else if (item.kind === "memory_mutation") batch.memoryMutations.push(item.value);
        else if (item.kind === "drop_seed") batch.dropSeeds.push(item.value);
        else if (item.kind === "pending_agent_drop") batch.pendingAgentDrops.push(item.value);
        else if (item.kind === "note_nudge_anchor") batch.noteNudgeAnchors.push(item.value);
        else if (item.kind === "auto_search_hint") batch.autoSearchHintDecisions.push(item.value);
        else if (item.kind === "strip_seed") batch.stripSeeds.push(item.value);
        else batch.userProfile.push(item.value);
    };

    const makePayload = (input: {
        index: number;
        total: number;
        complete: boolean;
        compartments: unknown[];
        memories: unknown[];
        memoryMutations: unknown[];
        dropSeeds?: ModuleDropSeed[];
        pendingAgentDrops: ModulePendingDropSeed[];
        noteNudgeAnchors: ModuleNoteNudgeAnchorSeed[];
        autoSearchHintDecisions: ModuleAutoSearchHintSeed[];
        userProfile: string[];
        dropSeedSkipped?: number;
        pendingDropSkipped?: number;
        autoSearchHintSkipped?: number;
        stripSeeds?: ModuleStripSeed[];
        stripSeedSkipped?: number;
        pendingCompactionMarker?: ModulePendingCompactionMarkerSeed | null;
        deferredExecuteState?: ModuleDeferredExecuteSeed | null;
        channel2NudgeState?: string;
    }): ModuleStateSyncPayload => ({
        method: "state_sync",
        params: {
            shadow_generation: args.moduleGeneration,
            expected_shadow_seq: args.expectedShadowSeq,
            seed_id: args.seedId,
            seed_generation: args.moduleGeneration,
            seed_batch_index: input.index,
            seed_batch_total: input.total,
            seed_complete: input.complete,
            compartments: input.compartments,
            ...(args.omitAuthorityMemorySections
                ? {}
                : {
                      memories: input.memories,
                      memory_mutations: input.memoryMutations,
                  }),
            user_profile: input.userProfile,
            ...(args.dropSeeds !== undefined ? { drop_seeds: input.dropSeeds } : {}),
            ...(args.pendingDropSeeds !== undefined
                ? { pending_agent_drops: input.pendingAgentDrops }
                : {}),
            ...(args.noteNudgeAnchors !== undefined
                ? { note_nudge_anchors: input.noteNudgeAnchors }
                : {}),
            ...(args.autoSearchHintSeeds !== undefined
                ? { auto_search_hint_decisions: input.autoSearchHintDecisions }
                : {}),
            ...(args.stripSeeds !== undefined ? { strip_seeds: input.stripSeeds } : {}),
            ...(input.complete
                ? {
                      seed_boundary_id: args.seedBoundaryId,
                      workspace: args.workspace,
                      last_todo_state: args.lastTodoState,
                      project_memory_epoch: args.watermarks.project_memory_epoch,
                      user_profile_version: args.watermarks.project_user_profile_version,
                      acked_watermarks: args.watermarks,
                      ...(args.dropSeedSkipped !== undefined
                          ? { drop_seed_skipped: args.dropSeedSkipped }
                          : {}),
                      ...(args.pendingDropSkipped !== undefined
                          ? { pending_agent_drops_skipped: args.pendingDropSkipped }
                          : {}),
                      ...(args.autoSearchHintSkipped !== undefined
                          ? { auto_search_hint_skipped: args.autoSearchHintSkipped }
                          : {}),
                      ...(args.todoSyntheticAnchor !== undefined
                          ? { todo_synthetic_anchor: args.todoSyntheticAnchor }
                          : {}),
                      ...(args.emergencyLatches !== undefined
                          ? { emergency_latches: args.emergencyLatches }
                          : {}),
                      ...(args.pendingCompactionMarker !== undefined
                          ? { pending_compaction_marker: args.pendingCompactionMarker }
                          : {}),
                      ...(args.deferredExecuteState !== undefined
                          ? { deferred_execute_state: args.deferredExecuteState }
                          : {}),
                      ...(args.channel2NudgeState !== undefined
                          ? { channel2_nudge_state: args.channel2NudgeState }
                          : {}),
                      ...(args.stripSeedSkipped !== undefined
                          ? { strip_seed_skipped: args.stripSeedSkipped }
                          : {}),
                      ...(args.reasoningClearedThroughTag !== undefined
                          ? {
                                reasoning_cleared_through_tag: args.reasoningClearedThroughTag,
                            }
                          : {}),
                  }
                : {}),
        },
        watermarks: args.watermarks,
    });

    // The envelope is fixed for all pages; use the largest safe sequence numbers so
    // page estimates cannot undercount metadata. Empty arrays are intentionally left
    // in this margin, making the estimate conservative by a few bytes per field.
    const sizingEnvelope = makePayload({
        index: Number.MAX_SAFE_INTEGER,
        total: Number.MAX_SAFE_INTEGER,
        complete: true,
        ...emptyBatch(),
        dropSeedSkipped: args.dropSeedSkipped,
        pendingDropSkipped: args.pendingDropSkipped,
        autoSearchHintSkipped: args.autoSearchHintSkipped,
        pendingCompactionMarker: args.pendingCompactionMarker,
        deferredExecuteState: args.deferredExecuteState,
        channel2NudgeState: args.channel2NudgeState,
    });
    const envelopeMarginBytes = moduleWireBodyBytes({
        method: "state_sync",
        params: sizingEnvelope.params,
    });

    const pageBatches: SeedBatch[] = [];
    let current = emptyBatch();
    let currentEncodedBytes = 0;
    let currentItemCount = 0;
    for (const item of items) {
        // Encode each item once for the linear packing estimate. The final page
        // serialization below remains the sole exact wire-size assertion.
        const itemBytes = encodedSeedItemBytes(item);
        const itemContribution = itemBytes + 1; // value bytes plus a conservative comma.
        const candidateBytes = envelopeMarginBytes + currentEncodedBytes + itemContribution;
        if (currentItemCount > 0 && candidateBytes > MODULE_PAGE_MAX_BYTES) {
            pageBatches.push(current);
            current = emptyBatch();
            currentEncodedBytes = 0;
            currentItemCount = 0;
        }
        if (envelopeMarginBytes + itemContribution > MODULE_PAGE_MAX_BYTES) {
            throw new Error("module seed item exceeds the 512 KiB batch limit");
        }
        appendItem(current, item);
        currentEncodedBytes += itemContribution;
        currentItemCount += 1;
    }
    if (currentItemCount > 0 || pageBatches.length === 0) pageBatches.push(current);

    const total = pageBatches.length;
    const batches = pageBatches.map((batch, index) => {
        const payload = makePayload({
            index,
            total,
            complete: index + 1 === total,
            dropSeedSkipped: args.dropSeedSkipped,
            pendingDropSkipped: args.pendingDropSkipped,
            autoSearchHintSkipped: args.autoSearchHintSkipped,
            pendingCompactionMarker: args.pendingCompactionMarker,
            deferredExecuteState: args.deferredExecuteState,
            channel2NudgeState: args.channel2NudgeState,
            ...batch,
        });
        // An estimate may choose a different split point than an exact wire-size
        // check. This is safe because the module reassembler concatenates pages in
        // order, preserving every item.
        if (
            moduleWireBodyBytes({ method: "state_sync", params: payload.params }) >
            MODULE_PAGE_MAX_BYTES
        ) {
            throw new Error("module seed batch exceeds the 512 KiB batch limit");
        }
        return payload;
    });
    return batches;
}

export async function buildModuleStateSyncPayload(args: {
    state: ModuleStateSyncState;
    pass: ModuleStateSyncPass;
    force: boolean;
    options?: ModuleStateSyncOptions;
    seedId?: string;
}): Promise<
    ModuleStateSyncPayload | null | "m0_mutation" | "mismatch" | "unresolved" | "seed_budget"
> {
    const workspace = resolveModuleWorkspaceContext(args.pass.db, args.pass.projectPath);
    // One authority pool has one writer. While MODULE owns memories, this sender only mirrors
    // module changes back to TypeScript and must not send the TypeScript view in the other direction.
    const omitAuthorityMemorySections = args.options?.authorityState === "MODULE";
    const currentWatermarks = loadModuleWatermarks({
        db: args.pass.db,
        sessionId: args.pass.sessionId,
        projectPath: args.pass.projectPath,
        workspace,
    });
    if (
        !args.force &&
        args.state.lastAckedWatermarks &&
        currentWatermarks.m0_mutation_id > args.state.lastAckedWatermarks.m0_mutation_id
    ) {
        return "m0_mutation";
    }
    if (!args.force && moduleWatermarksEqual(args.state.lastAckedWatermarks, currentWatermarks)) {
        return null;
    }
    const acked = args.force
        ? {
              compartment_sequence: -1,
              memory_id: 0,
              m0_mutation_id: 0,
              memory_mutation_id: 0,
              last_todo_state_hash: "",
              project_memory_epoch: 0,
              project_user_profile_version: 0,
              workspace_fingerprint: null,
              reasoning_cleared_through_tag: 0,
          }
        : (args.state.lastAckedWatermarks ?? {
              compartment_sequence: -1,
              memory_id: 0,
              m0_mutation_id: 0,
              memory_mutation_id: 0,
              last_todo_state_hash: "",
              project_memory_epoch: 0,
              project_user_profile_version: 0,
              workspace_fingerprint: null,
              reasoning_cleared_through_tag: 0,
          });
    const rawById = new Map<string, RawMessageParts | null>();
    const readRawById = (messageId: string): RawMessageParts | null => {
        if (!rawById.has(messageId)) {
            rawById.set(messageId, readRawSessionMessagePartsById(args.pass.sessionId, messageId));
        }
        return rawById.get(messageId) ?? null;
    };
    const compartmentsChanged =
        args.force || currentWatermarks.compartment_sequence > acked.compartment_sequence;
    const memoryChanged =
        !omitAuthorityMemorySections &&
        (args.force ||
            currentWatermarks.memory_id > acked.memory_id ||
            currentWatermarks.project_memory_epoch !== acked.project_memory_epoch);
    const memoryMutationsChanged =
        !omitAuthorityMemorySections &&
        (args.force || currentWatermarks.memory_mutation_id > acked.memory_mutation_id);
    const profileChanged =
        args.force ||
        currentWatermarks.project_user_profile_version !== acked.project_user_profile_version;
    const workspaceFingerprintChanged =
        args.force ||
        !Object.hasOwn(acked, "workspace_fingerprint") ||
        (currentWatermarks.workspace_fingerprint ?? null) !== (acked.workspace_fingerprint ?? null);
    const useStateSyncDeltas = args.options?.stateSyncDeltas === true;
    const includeUserProfile = !useStateSyncDeltas || profileChanged;
    const includeWorkspace = !useStateSyncDeltas || workspaceFingerprintChanged;

    const compartments: unknown[] = [];
    let serializedCount = 0;
    const compartmentsToSerialize = compartmentsChanged
        ? args.force
            ? getCompartments(args.pass.db, args.pass.sessionId)
            : readCompartmentsAfterSequence(
                  args.pass.db,
                  args.pass.sessionId,
                  acked.compartment_sequence,
              )
        : [];
    for (const compartment of compartmentsToSerialize) {
        args.options?.beforeSerializeCompartment?.();
        if (args.options?.shouldAbortSeed?.()) return "seed_budget";
        const serialized = serializeCompartment({
            compartment,
            sessionId: args.pass.sessionId,
            readRawById,
            state: args.state,
        });
        if (serialized === "mismatch") return "mismatch";
        if (serialized === null) return "unresolved";
        compartments.push(serialized);
        serializedCount += 1;
        const yieldEvery = Math.max(1, args.options?.yieldEveryCompartments ?? 10);
        if (serializedCount % yieldEvery === 0) {
            await yieldToEventLoop();
            if (args.options?.shouldAbortSeed?.()) return "seed_budget";
        }
    }

    const allMemories =
        args.force && !omitAuthorityMemorySections && args.pass.projectPath
            ? workspace.workspace
                ? getMemoriesByProjects(
                      args.pass.db,
                      workspace.expandedIdentities,
                      ["active", "permanent"],
                      args.pass.nowMs,
                      workspace.ownIdentities,
                      workspace.shareCategories,
                  )
                : getMemoriesByProject(
                      args.pass.db,
                      args.pass.projectPath,
                      ["active", "permanent"],
                      args.pass.nowMs,
                  )
            : [];
    const incrementalMemories =
        memoryChanged && !args.force && args.pass.projectPath
            ? readNewMemoriesForM1Union(
                  args.pass.db,
                  workspace.expandedIdentities,
                  acked.memory_id,
                  args.pass.nowMs,
                  workspace.ownIdentities,
                  workspace.shareCategories,
              )
            : [];
    const memoryRows = args.force ? allMemories : incrementalMemories;
    const memories = memoryRows.map((memory) => ({
        id: memory.id,
        project_path: memory.projectPath,
        category: memory.category,
        content: memory.content,
        normalized_hash: memory.normalizedHash,
        importance: memory.importance,
        scope: memory.scope,
        shareable: memory.shareable,
        source_session_id: memory.sourceSessionId,
        source_type: memory.sourceType,
        seen_count: memory.seenCount,
        retrieval_count: memory.retrievalCount,
        first_seen_at: memory.firstSeenAt,
        created_at: memory.createdAt,
        updated_at: memory.updatedAt,
        last_seen_at: memory.lastSeenAt,
        last_retrieved_at: memory.lastRetrievedAt,
        status: memory.status,
        expires_at: memory.expiresAt,
        verification_status: memory.verificationStatus,
        verified_at: memory.verifiedAt,
        superseded_by_memory_id: memory.supersededByMemoryId,
        merged_from: memory.mergedFrom,
        metadata_json: memory.metadataJson,
        evidence: getMemoryEvidence(args.pass.db, memory.id),
    }));
    const renderedMemoryIds = memoryMutationsChanged
        ? args.force
            ? allMemories.map((memory) => memory.id)
            : readRenderedMemoryIds({
                  db: args.pass.db,
                  projectPath: args.pass.projectPath,
                  workspace,
                  nowMs: args.pass.nowMs,
              })
        : [];
    const userProfile = includeUserProfile
        ? getActiveUserMemories(args.pass.db).map((memory) => memory.content)
        : [];
    const memoryMutations =
        memoryMutationsChanged && args.pass.projectPath
            ? getMemoryMutationsForRenderByProjects(
                  args.pass.db,
                  workspace.expandedIdentities,
                  acked.memory_mutation_id,
                  renderedMemoryIds,
              ).map((row) => ({
                  id: row.id,
                  project_path: row.projectPath,
                  mutation_type: row.mutationType,
                  target_memory_id: row.targetMemoryId,
                  superseded_by_id: row.supersededById,
                  category: row.category,
                  new_content: row.newContent,
                  queued_at: row.queuedAt,
              }))
            : [];
    const sessionMeta = getOrCreateSessionMeta(args.pass.db, args.pass.sessionId);
    const pendingDropSeedState = args.force
        ? buildPendingDropSeeds({ db: args.pass.db, sessionId: args.pass.sessionId, readRawById })
        : null;
    const noteNudgeAnchors = args.force
        ? getNoteNudgeAnchors(args.pass.db, args.pass.sessionId).map((anchor) => ({
              message_id: anchor.messageId,
              text: anchor.text,
          }))
        : undefined;
    const autoSearchHintSeedState = args.force
        ? buildAutoSearchHintSeeds({
              db: args.pass.db,
              sessionId: args.pass.sessionId,
              readRawById,
          })
        : null;
    const persistedTodoAnchor = args.force
        ? getPersistedTodoSyntheticAnchor(args.pass.db, args.pass.sessionId)
        : null;
    const todoSyntheticAnchor =
        persistedTodoAnchor === null
            ? args.force
                ? null
                : undefined
            : {
                  call_id: persistedTodoAnchor.callId,
                  message_id: persistedTodoAnchor.messageId,
                  state_json: persistedTodoAnchor.stateJson,
              };
    const emergencyLatches = args.force
        ? {
              last_input_sample: getEmergencyInputSample(args.pass.db, args.pass.sessionId),
              has_prior_drop: getEmergencyInputSample(args.pass.db, args.pass.sessionId) > 0,
              last_execute_ordinal: Math.max(0, sessionMeta.toolReclaimWatermark),
          }
        : undefined;
    // When starting a module from an existing session, include all TypeScript
    // units already dropped before the first transform. Otherwise the transform
    // reads older raw data and needs another cache invalidation to process them.
    const dropSeedState = args.force
        ? buildDropSeeds({ db: args.pass.db, sessionId: args.pass.sessionId, readRawById })
        : null;
    const stripSeeds = args.force
        ? buildStripSeeds({ db: args.pass.db, sessionId: args.pass.sessionId })
        : undefined;
    const pendingMarker = args.force
        ? getPendingCompactionMarkerState(args.pass.db, args.pass.sessionId)
        : undefined;
    const pendingCompactionMarker =
        pendingMarker === undefined
            ? undefined
            : pendingMarker === null
              ? null
              : {
                    ordinal: pendingMarker.ordinal,
                    end_message_id: pendingMarker.endMessageId,
                    published_at: pendingMarker.publishedAt,
                };
    const deferredPending = args.force
        ? peekDeferredExecutePending(args.pass.db, args.pass.sessionId)
        : undefined;
    const deferredExecuteState =
        deferredPending === undefined
            ? undefined
            : deferredPending === null
              ? null
              : {
                    id: deferredPending.id,
                    reason: deferredPending.reason,
                    recorded_at: deferredPending.recordedAt,
                };
    const channel2NudgeState = args.force
        ? getChannel2NudgeState(args.pass.db, args.pass.sessionId)
        : undefined;
    const payloadArgs = {
        moduleGeneration: args.state.moduleGeneration,
        expectedShadowSeq: args.state.lastAckedSeq,
        seedId: args.seedId ?? randomUUID(),
        seedBoundaryId:
            args.state.seedPassPending === true
                ? seedBoundaryFromSerializedCompartments(compartments)
                : null,
        compartments,
        memories,
        memoryMutations,
        dropSeeds:
            dropSeedState && dropSeedState.seeds.length > 0 ? dropSeedState.seeds : undefined,
        dropSeedSkipped:
            dropSeedState && dropSeedState.skipped > 0 ? dropSeedState.skipped : undefined,
        pendingDropSeeds:
            pendingDropSeedState && pendingDropSeedState.seeds.length > 0
                ? pendingDropSeedState.seeds
                : args.force
                  ? []
                  : undefined,
        pendingDropSkipped:
            pendingDropSeedState && pendingDropSeedState.skipped > 0
                ? pendingDropSeedState.skipped
                : undefined,
        noteNudgeAnchors,
        autoSearchHintSeeds:
            autoSearchHintSeedState && autoSearchHintSeedState.seeds.length > 0
                ? autoSearchHintSeedState.seeds
                : args.force
                  ? []
                  : undefined,
        autoSearchHintSkipped:
            autoSearchHintSeedState && autoSearchHintSeedState.skipped > 0
                ? autoSearchHintSeedState.skipped
                : undefined,
        todoSyntheticAnchor,
        emergencyLatches,
        pendingCompactionMarker,
        deferredExecuteState,
        channel2NudgeState,
        stripSeeds: stripSeeds && stripSeeds.length > 0 ? stripSeeds : undefined,
        stripSeedSkipped: undefined,
        reasoningClearedThroughTag: sessionMeta.clearedReasoningThroughTag,
        userProfile,
        workspace: workspace.workspace,
        lastTodoState: effectiveLastTodoState(args.pass.sessionId, sessionMeta),
        watermarks: currentWatermarks,
        omitAuthorityMemorySections,
    };
    if (args.force) {
        const wireBatches = buildPagedModuleStateSyncPayloads(payloadArgs);
        return { ...wireBatches[0], wireBatches };
    }
    return {
        method: "state_sync",
        params: {
            shadow_generation: args.state.moduleGeneration,
            expected_shadow_seq: args.state.lastAckedSeq,
            compartments,
            ...(omitAuthorityMemorySections ? {} : { memories, memory_mutations: memoryMutations }),
            ...(includeUserProfile ? { user_profile: userProfile } : {}),
            ...(includeWorkspace ? { workspace: workspace.workspace } : {}),
            last_todo_state: effectiveLastTodoState(args.pass.sessionId, sessionMeta),
            project_memory_epoch: currentWatermarks.project_memory_epoch,
            user_profile_version: currentWatermarks.project_user_profile_version,
            acked_watermarks: currentWatermarks,
            ...(pendingCompactionMarker !== undefined
                ? { pending_compaction_marker: pendingCompactionMarker }
                : {}),
            ...(deferredExecuteState !== undefined
                ? { deferred_execute_state: deferredExecuteState }
                : {}),
            ...(channel2NudgeState !== undefined
                ? { channel2_nudge_state: channel2NudgeState }
                : {}),
        },
        watermarks: currentWatermarks,
    };
}

export interface ModuleStateSyncClient {
    /** Synchronously exposes capabilities cached for the transport's live connection generation. */
    getCachedStateSyncCapabilities?(): { state_sync_deltas?: boolean } | undefined;
    /** Clears a capability snapshot when the module reports a restart-like signal. */
    invalidateStateSyncCapabilities?(): void;
    /** Capability probe is optional so older/test transports retain legacy wire semantics. */
    stateSyncCapabilities?(args: {
        sessionId: string;
        projectRoot: string;
    }): Promise<{ state_sync_deltas?: boolean }>;
    call(args: {
        sessionId: string;
        projectRoot: string;
        method:
            | "state_sync"
            | "transform"
            | "session.status"
            | "session.delete"
            | "session.flush"
            | "session.recomp"
            | "session.wrapup"
            | "todo_state.set"
            | "agent_drops.append"
            | "ctx_note"
            | "ctx_memory"
            | "note.evaluate"
            | "transform.ack"
            | "transform.nack";
        body: unknown;
        signal?: AbortSignal;
        generationSensitive?: boolean;
    }): Promise<unknown>;
}

function responseMemoriesSkipped(response: unknown): boolean {
    const value = isRecord(response) && isRecord(response.result) ? response.result : response;
    return isRecord(value) && value.memories_skipped === true;
}

function isHistorianCompartmentSyncBusy(error: unknown): boolean {
    let current = error;
    const seen = new Set<unknown>();
    while (isRecord(current) && !seen.has(current)) {
        seen.add(current);
        if (current.code === "historian_compartment_sync_busy") return true;
        current = current.cause;
    }
    return false;
}

function readAuthoritySeqMismatch(error: unknown): number | null {
    let current = error;
    const seen = new Set<unknown>();
    while (isRecord(current) && !seen.has(current)) {
        seen.add(current);
        if (current.code === "authority_seq_mismatch") {
            const direct = current.durable_authority_seq;
            if (typeof direct === "number" && Number.isSafeInteger(direct) && direct >= 0) {
                return direct;
            }
            if (typeof current.message === "string") {
                try {
                    const details: unknown = JSON.parse(current.message);
                    if (isRecord(details) && details.code === "authority_seq_mismatch") {
                        const durable = details.durable_authority_seq;
                        if (
                            typeof durable === "number" &&
                            Number.isSafeInteger(durable) &&
                            durable >= 0
                        ) {
                            return durable;
                        }
                    }
                } catch {
                    // Older transports only expose the typed code and human message.
                }
            }
        }
        current = current.cause;
    }
    return null;
}

/**
 * Mode-neutral state synchronization: the same watermark-triggered assembly is
 * used by the mirror sender and the Rust authority path. Callers own retries and
 * lineage handling because shadow and authority have different failure policy.
 */
export type ModuleStateSyncResult =
    | { status: "acked"; watermarks: ModuleWatermarks }
    | { status: "no_change" }
    | { status: "retry_busy" };

export async function syncModuleState(args: {
    client: ModuleStateSyncClient;
    state: ModuleStateSyncState;
    pass: ModuleStateSyncPass;
    projectRoot: string;
    force: boolean;
    options?: ModuleStateSyncOptions;
}): Promise<ModuleStateSyncResult> {
    let force = args.force;
    const adoption = args.options?.authoritySeqAdoption ?? { used: false };
    const resolveStateSyncDeltas = async (afterGenerationChange = false): Promise<boolean> => {
        let capability = afterGenerationChange ? undefined : args.options?.stateSyncDeltas;
        capability ??= args.client.getCachedStateSyncCapabilities?.()?.state_sync_deltas;
        if (capability === undefined && args.client.stateSyncCapabilities) {
            try {
                capability = (
                    await args.client.stateSyncCapabilities({
                        sessionId: args.pass.sessionId,
                        projectRoot: args.projectRoot,
                    })
                ).state_sync_deltas;
            } catch {
                // If the capability check fails, assume the module does not support
                // state_sync_deltas and send the older payload format with its state-sync
                // fields always present.
                capability = false;
            }
        }
        return capability === true;
    };
    let stateSyncDeltas = await resolveStateSyncDeltas();
    syncLoop: for (;;) {
        const payload = await buildModuleStateSyncPayload({
            state: args.state,
            pass: args.pass,
            force,
            options: { ...args.options, stateSyncDeltas },
        });
        if (payload === null) return { status: "no_change" };
        if (
            payload === "m0_mutation" ||
            payload === "mismatch" ||
            payload === "unresolved" ||
            payload === "seed_budget"
        ) {
            throw new Error(`module state sync ${payload}`);
        }
        try {
            const batches = payload.wireBatches ?? [payload];
            for (const batch of batches) {
                const response = await args.client.call({
                    sessionId: args.pass.sessionId,
                    projectRoot: args.projectRoot,
                    method: "state_sync",
                    body: {
                        method: batch.method,
                        ...batch.params,
                    },
                    generationSensitive: stateSyncDeltas,
                });
                if (isModuleTransportGenerationChangedResult(response)) {
                    // The payload used the previous connection's capabilities. Re-probe the new
                    // connection and rebuild before retrying because it may not support deltas.
                    stateSyncDeltas = await resolveStateSyncDeltas(true);
                    continue syncLoop;
                }
                if (
                    args.options?.authority === true &&
                    responseMemoriesSkipped(response) &&
                    !args.state.authorityMemorySyncSkipLogged
                ) {
                    args.state.authorityMemorySyncSkipLogged = true;
                    sessionLog(
                        args.pass.sessionId,
                        "authority state sync skipped module-owned memory sections",
                    );
                }
            }
        } catch (error) {
            if (isHistorianCompartmentSyncBusy(error)) {
                // Return a distinct retry result when the snapshot-owning historian rejects
                // compartment updates, preserving any forced initialization seed obligation.
                return { status: "retry_busy" };
            }
            const durableSeq = args.options?.authority ? readAuthoritySeqMismatch(error) : null;
            if (durableSeq === null || adoption.used) throw error;
            adoption.used = true;
            args.state.lastAckedSeq = durableSeq;
            // A fresh authority process only knows its in-memory sequence. After adopting the
            // durable sequence, discard sender watermarks and force a full rebuild because it
            // cannot know which durable rows the sequence covers.
            args.state.lastAckedWatermarks = null;
            force = true;
            continue;
        }
        args.state.lastAckedWatermarks = payload.watermarks;
        args.state.lastAckedSeq += 1;
        return { status: "acked", watermarks: payload.watermarks };
    }
}

export const __moduleStateSyncTest = {
    buildModuleStateSyncPayload,
    buildPagedModuleStateSyncPayloads,
    canonicalOrdinalForMessageId,
    loadModuleWatermarks,
    moduleWatermarksEqual,
    syncModuleState,
};
