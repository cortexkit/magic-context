import { createHmac, randomUUID } from "node:crypto";

import { getMaxMemoryIdForProjects } from "../../features/magic-context/memory/storage-memory";
import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getOrCreateSessionMeta,
    getProcessedImageStrippedIds,
    getStaleReduceStrippedIds,
    getStrippedPlaceholderIds,
} from "../../features/magic-context/storage";
import { getMaxMemoryMutationIdForProjects } from "../../features/magic-context/storage-memory-mutation-log";
import {
    getAutoSearchHintDecisions,
    getChannel2NudgeState,
    getEmergencyInputSample,
    getNoteNudgeAnchors,
    getPendingCompactionMarkerState,
    getPersistedCompactionMarkerState,
    getPersistedTodoSyntheticAnchor,
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
import {
    computeWorkspaceEpochFingerprint,
    expandWorkspaceIdentitySetWithAliases,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
} from "../../features/magic-context/workspaces";
import { sessionLog } from "../../shared/logger";
import { isRecord } from "../../shared/record-type-guard";
import { resolveTodowriteAvailability } from "./ctx-reduce-availability";
import { StateSyncTiming, timedStateSyncDatabase } from "./module-state-sync-timing";
import { isModuleTransportGenerationChangedResult } from "./module-transport";
import { MODULE_PAGE_MAX_BYTES, moduleRawBlockMappings, moduleWireBodyBytes } from "./module-wire";
import {
    readRawSessionMessageOrdinalById,
    readRawSessionMessagePartsById,
    readRawSessionSeedTail,
} from "./read-session-chunk";
import type { RawMessageParts } from "./read-session-raw";
import {
    type ResolvedContextBoundary,
    resolveSharedCompartmentBoundaries,
} from "./shared-compartment-boundaries";

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
    note_evaluation_available?: boolean;
    historian_model_chain_hash?: string;
}

export interface ModuleWorkspacePayload {
    fingerprint: string;
    members: Array<{ project_path: string; share_categories: string[] }>;
}

export type ModuleDropMode =
    | "full"
    | "truncated"
    | "skeleton_real"
    | "skeleton_stripped"
    | "edit_marker"
    | "edit_marker_stripped";

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
        historian_model_chain?: readonly string[];
        pass_complete?: true;
        note_evaluation_available?: boolean;
        shadow_generation: number;
        expected_shadow_seq: number;
        seed_id?: string;
        seed_generation?: number;
        seed_batch_index?: number;
        seed_batch_total?: number;
        seed_complete?: boolean;
        seed_boundary_id?: string | null;
        resolved_compartment_boundaries?: ResolvedContextBoundary[];
        last_todo_state?: string;
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
}

export interface ModuleStateSyncPass {
    db: ContextDatabase;
    sessionId: string;
    projectPath?: string;
    nowMs: number;
    /** Host-resolved chain; absent preserves the full-request sender's wire. */
    historianModelChain?: readonly string[];
    /** Only new runner-record entries, reusing their admitted ingest. No estimator lives here. */
    providerPass?: ModuleProviderPass;
}

export interface ModuleProviderPass {
    lineage_id: string;
    pass_id: string;
    descends_from?: { lineage_id: string; through_ordinal: number };
    appended: readonly { ordinal: number; mid: string; message: unknown }[];
    physical_tail: { ordinal: number; mid: string } | null;
    /** Exact shared engine plan only, never a conservative preflight candidate. */
    exact_pass_plan?: "hard" | "migrate_hard" | "soft" | "defer" | "reject";
    marker_hard_serves_frozen_prefix?: boolean;
}

/** Internal pass metadata is paged independently of reusable seed data. */
export function providerPassPages(
    pass: ModuleProviderPass,
    sessionId: string,
    complete: boolean,
    maxBytes = MODULE_PAGE_MAX_BYTES,
): Record<string, unknown>[] {
    const common = { ...pass, ordered_ids: pass.appended.map((entry) => entry.mid), appended: [] };
    const body = (appended: ModuleProviderPass["appended"], last: boolean) => ({
        method: "state_sync",
        session_id: sessionId,
        provider_pass: { ...common, appended },
        ...(last && complete ? { pass_complete: true } : {}),
    });
    const encodedBytes = (value: ReturnType<typeof body>): number => {
        const { method, ...params } = value;
        return moduleWireBodyBytes({ method, params });
    };
    const pages: Record<string, unknown>[] = [];
    if (encodedBytes(body([], true)) > maxBytes)
        throw Object.assign(new Error("provider pass metadata exceeds state-sync encoded cap"), {
            code: "provider_message_too_large",
        });
    let batch: ModuleProviderPass["appended"] = [];
    for (const entry of pass.appended) {
        if (encodedBytes(body([entry], true)) > maxBytes)
            throw Object.assign(new Error("provider message exceeds state-sync encoded cap"), {
                code: "provider_message_too_large",
            });
        if (batch.length && encodedBytes(body([...batch, entry], true)) > maxBytes) {
            pages.push(body(batch, false));
            batch = [];
        }
        batch = [...batch, entry];
    }
    pages.push(body(batch, true));
    return pages;
}

export interface ModuleStateSyncOptions {
    timing?: StateSyncTiming;
    seedInventory?: {
        maxCompartmentSequence: number;
        boundaryId: string | null;
        contextBoundariesResolved?: boolean;
    };
    shouldAbortSeed?: () => boolean;
    /** Enable the authority sender's one-time durable-sequence adoption. */
    authority?: boolean;
    /** Set only after the module status/hello advertises state_sync_deltas. */
    stateSyncDeltas?: boolean;
    /** Share adoption state across every authority sync attempt in one transform pass. */
    authoritySeqAdoption?: { used: boolean };
    /**
     * The adapter observed no event capable of changing an acknowledged watermark.
     * This bypasses both capability and own-store reads; force/restart seeds ignore it.
     */
    knownWatermarksUnchanged?: boolean;
    /** A no-append provider pass still closes its ingest barrier. */
    passComplete?: boolean;
    noteEvaluationProjectPath?: string;
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
    /** Reuse the enclosing pass's session_meta projection. */
    sessionMeta?: ReturnType<typeof getOrCreateSessionMeta>;
    noteEvaluationProjectPath?: string;
    historianModelChain?: readonly string[];
}): ModuleWatermarks {
    const workspace = args.workspace ?? resolveModuleWorkspaceContext(args.db, args.projectPath);
    const sessionMeta = args.sessionMeta ?? getOrCreateSessionMeta(args.db, args.sessionId);
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
    const _evaluationProject = args.noteEvaluationProjectPath ?? args.projectPath;
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
        note_evaluation_available: true,
        ...(args.historianModelChain !== undefined
            ? { historian_model_chain_hash: stableHash(JSON.stringify(args.historianModelChain)) }
            : {}),
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
        (left.reasoning_cleared_through_tag ?? 0) === (right.reasoning_cleared_through_tag ?? 0) &&
        (left.note_evaluation_available ?? false) === (right.note_evaluation_available ?? false) &&
        (left.historian_model_chain_hash ?? null) === (right.historian_model_chain_hash ?? null)
    );
}

function _flatBlockIdForRawMessage(
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

function sortCanonicalSeeds<T>(seeds: T[]): T[] {
    // A seed's canonical bytes do not depend on its position. Compute them
    // once, retaining the existing locale comparison and stable tie ordering.
    return seeds
        .map((seed) => ({ seed, key: canonicalSeedJson(seed) }))
        .sort((left, right) => left.key.localeCompare(right.key))
        .map(({ seed }) => seed);
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
    mappingsById?: Map<string, ReturnType<typeof moduleRawBlockMappings>>;
}): { seed: ModuleDropSeed } | { reason: string } {
    const tag = args.tag;
    const mappingsFor = (messageId: string) => {
        const cached = args.mappingsById?.get(messageId);
        if (cached) return cached;
        const mappings = moduleRawBlockMappings(args.readRawById(messageId));
        args.mappingsById?.set(messageId, mappings);
        return mappings;
    };
    if (tag.type === "tool") {
        if (!tag.toolOwnerMessageId) return { reason: "tool owner message is missing" };
        const mappings = mappingsFor(tag.toolOwnerMessageId);
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
                ...(tag.dropMode === "edit_marker" || tag.dropMode === "edit_marker_stripped"
                    ? { payload: editMarkerSeedPayload(call.toolInput) }
                    : {}),
            },
        };
    }
    if (tag.messageId.length === 0) return { reason: "message tag identity is empty" };
    const address = dropSeedAddress(tag);
    if (!address) return { reason: "message tag identity is empty" };
    const mappings = mappingsFor(address.messageId);
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
    eligibleTagAddresses?: string[];
    eligibleMessageIds?: ReadonlySet<string>;
    db: ContextDatabase;
    sessionId: string;
    readRawById: (messageId: string) => RawMessageParts | null;
}): { seeds: ModuleDropSeed[]; skipped: number } {
    const byBlock = new Map<string, { seed: ModuleDropSeed; canonical: string }>();
    const mappingsById = new Map<string, ReturnType<typeof moduleRawBlockMappings>>();
    let skipped = 0;
    for (const tag of getDroppedTagsBySession(
        args.db,
        args.sessionId,
        args.eligibleMessageIds && args.eligibleTagAddresses
            ? {
                  ownerIds: [...args.eligibleMessageIds],
                  messageAddresses: args.eligibleTagAddresses,
              }
            : undefined,
    )) {
        if (tag.status !== "dropped") continue;
        const ownerId =
            tag.type === "tool" ? tag.toolOwnerMessageId : dropSeedAddress(tag)?.messageId;
        if (args.eligibleMessageIds && (!ownerId || !args.eligibleMessageIds.has(ownerId)))
            continue;
        const result = dropSeedForTag({ tag, readRawById: args.readRawById, mappingsById });
        if (!("seed" in result)) {
            skipped += 1;
            sessionLog(
                args.sessionId,
                `module drop seed skipped tag ${tag.tagNumber}: ${result.reason}`,
            );
            continue;
        }
        const canonical = canonicalSeedJson(result.seed);
        const existing = byBlock.get(result.seed.block_id);
        if (!existing || canonical < existing.canonical) {
            byBlock.set(result.seed.block_id, { seed: result.seed, canonical });
        }
    }
    return {
        seeds: [...byBlock.values()]
            .sort((left, right) => left.canonical.localeCompare(right.canonical))
            .map(({ seed }) => seed),
        skipped,
    };
}

function buildPendingDropSeeds(args: {
    eligibleMessageIds?: ReadonlySet<string>;
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
        const ownerId =
            tag.type === "tool" ? tag.toolOwnerMessageId : dropSeedAddress(tag)?.messageId;
        if (args.eligibleMessageIds && (!ownerId || !args.eligibleMessageIds.has(ownerId)))
            continue;
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
        seeds: sortCanonicalSeeds([...byBlock.values()]),
        skipped,
    };
}

function buildAutoSearchHintSeeds(args: {
    eligibleMessageIds?: ReadonlySet<string>;
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
        if (args.eligibleMessageIds && !args.eligibleMessageIds.has(value.messageId)) continue;
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
        seeds: sortCanonicalSeeds([...byBlock.values()]),
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
    return sortCanonicalSeeds([...byKey.values()]);
}

type SeedItem =
    | { kind: "context_boundary"; value: ResolvedContextBoundary }
    | { kind: "drop_seed"; value: ModuleDropSeed }
    | { kind: "pending_agent_drop"; value: ModulePendingDropSeed }
    | { kind: "note_nudge_anchor"; value: ModuleNoteNudgeAnchorSeed }
    | { kind: "auto_search_hint"; value: ModuleAutoSearchHintSeed }
    | { kind: "strip_seed"; value: ModuleStripSeed };

function encodedSeedItemBytes(item: SeedItem): number {
    const encoded = JSON.stringify(item.value);
    return Buffer.byteLength(encoded === undefined ? "null" : encoded);
}

export function buildPagedModuleStateSyncPayloads(
    args: {
        moduleGeneration: number;
        expectedShadowSeq: number;
        seedId: string;
        seedBoundaryId: string | null;
        resolvedBoundaries?: ResolvedContextBoundary[];
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
        channel2NudgeState?: string;
        stripSeeds?: ModuleStripSeed[];
        stripSeedSkipped?: number;
        reasoningClearedThroughTag?: number;
        lastTodoState: string;
        watermarks: ModuleWatermarks;
        historianModelChain?: readonly string[];
        passComplete?: boolean;
    },
    maxPageBytes = MODULE_PAGE_MAX_BYTES,
): ModuleStateSyncPayload[] {
    const items: SeedItem[] = [
        ...(args.resolvedBoundaries ?? []).map(
            (value) => ({ kind: "context_boundary", value }) as const,
        ),
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
    ];

    type SeedBatch = {
        resolvedBoundaries: ResolvedContextBoundary[];
        dropSeeds: ModuleDropSeed[];
        pendingAgentDrops: ModulePendingDropSeed[];
        noteNudgeAnchors: ModuleNoteNudgeAnchorSeed[];
        autoSearchHintDecisions: ModuleAutoSearchHintSeed[];
        stripSeeds: ModuleStripSeed[];
    };

    const emptyBatch = (): SeedBatch => ({
        resolvedBoundaries: [],
        dropSeeds: [],
        pendingAgentDrops: [],
        noteNudgeAnchors: [],
        autoSearchHintDecisions: [],
        stripSeeds: [],
    });

    const appendItem = (batch: SeedBatch, item: SeedItem): void => {
        if (item.kind === "context_boundary") batch.resolvedBoundaries.push(item.value);
        else if (item.kind === "drop_seed") batch.dropSeeds.push(item.value);
        else if (item.kind === "pending_agent_drop") batch.pendingAgentDrops.push(item.value);
        else if (item.kind === "note_nudge_anchor") batch.noteNudgeAnchors.push(item.value);
        else if (item.kind === "auto_search_hint") batch.autoSearchHintDecisions.push(item.value);
        else if (item.kind === "strip_seed") batch.stripSeeds.push(item.value);
    };

    const makePayload = (input: {
        index: number;
        total: number;
        complete: boolean;
        resolvedBoundaries: ResolvedContextBoundary[];
        dropSeeds?: ModuleDropSeed[];
        pendingAgentDrops: ModulePendingDropSeed[];
        noteNudgeAnchors: ModuleNoteNudgeAnchorSeed[];
        autoSearchHintDecisions: ModuleAutoSearchHintSeed[];
        dropSeedSkipped?: number;
        pendingDropSkipped?: number;
        autoSearchHintSkipped?: number;
        stripSeeds?: ModuleStripSeed[];
        stripSeedSkipped?: number;
        pendingCompactionMarker?: ModulePendingCompactionMarkerSeed | null;
        channel2NudgeState?: string;
    }): ModuleStateSyncPayload => ({
        method: "state_sync",
        params: {
            shadow_generation: args.moduleGeneration,
            ...(input.complete && args.historianModelChain !== undefined
                ? { historian_model_chain: args.historianModelChain }
                : {}),
            ...(input.complete && args.passComplete ? { pass_complete: true as const } : {}),
            expected_shadow_seq: args.expectedShadowSeq,
            seed_id: args.seedId,
            seed_generation: args.moduleGeneration,
            seed_batch_index: input.index,
            seed_batch_total: input.total,
            seed_complete: input.complete,
            ...(args.resolvedBoundaries !== undefined
                ? { resolved_compartment_boundaries: input.resolvedBoundaries }
                : {}),
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
                      last_todo_state: args.lastTodoState,
                      acked_watermarks: args.watermarks,
                      note_evaluation_available: args.watermarks.note_evaluation_available ?? false,
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
        if (currentItemCount > 0 && candidateBytes > maxPageBytes) {
            pageBatches.push(current);
            current = emptyBatch();
            currentEncodedBytes = 0;
            currentItemCount = 0;
        }
        if (envelopeMarginBytes + itemContribution > maxPageBytes) {
            throw new Error("module seed item exceeds the configured batch limit");
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
            channel2NudgeState: args.channel2NudgeState,
            ...batch,
        });
        // An estimate may choose a different split point than an exact wire-size
        // check. This is safe because the module reassembler concatenates pages in
        // order, preserving every item.
        if (moduleWireBodyBytes({ method: "state_sync", params: payload.params }) > maxPageBytes) {
            throw new Error("module seed batch exceeds the configured batch limit");
        }
        return payload;
    });
    return batches;
}

export async function buildModuleStateSyncPayload(
    args: Parameters<typeof collectModuleStateSyncPayload>[0],
): ReturnType<typeof collectModuleStateSyncPayload> {
    const timing = args.options?.timing ?? (args.force ? new StateSyncTiming() : undefined);
    try {
        return await collectModuleStateSyncPayload({
            ...args,
            options: { ...args.options, timing },
        });
    } finally {
        // Log seed cost before transport, including assembly failures.
        if (args.force) timing?.log(args.pass.sessionId, "seed");
    }
}

async function collectModuleStateSyncPayload(args: {
    state: ModuleStateSyncState;
    pass: ModuleStateSyncPass;
    force: boolean;
    options?: ModuleStateSyncOptions;
    seedId?: string;
}): Promise<
    ModuleStateSyncPayload | null | "m0_mutation" | "mismatch" | "unresolved" | "seed_budget"
> {
    if (args.options?.timing)
        args = {
            ...args,
            pass: { ...args.pass, db: timedStateSyncDatabase(args.pass.db, args.options.timing) },
        };
    const workspace = resolveModuleWorkspaceContext(args.pass.db, args.pass.projectPath);
    const sessionMeta = getOrCreateSessionMeta(args.pass.db, args.pass.sessionId);
    const currentWatermarks = loadModuleWatermarks({
        db: args.pass.db,
        sessionId: args.pass.sessionId,
        projectPath: args.pass.projectPath,
        workspace,
        sessionMeta,
        noteEvaluationProjectPath: args.options?.noteEvaluationProjectPath,
        historianModelChain: args.pass.historianModelChain,
    });
    if (!args.force && moduleWatermarksEqual(args.state.lastAckedWatermarks, currentWatermarks)) {
        return null;
    }
    const _acked = args.force
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
    const timing = args.options?.timing;
    const inventory = args.options?.seedInventory;
    const resolvedBoundaries =
        inventory?.contextBoundariesResolved === true
            ? []
            : resolveSharedCompartmentBoundaries(args.pass.db, args.pass.sessionId);
    const tailBoundary = resolvedBoundaries.at(-1);
    // A summary covering whole messages establishes a safe host-message trim
    // boundary. Summaries covering individual blocks may still need the module
    // to rebuild its cached prefix before older host messages can be removed.
    const hostBoundary =
        tailBoundary && tailBoundary.source_end_block_index === null
            ? tailBoundary.end_message_id
            : null;
    const seedBoundaryId = hostBoundary ?? inventory?.boundaryId ?? null;
    // After a module reset its inventory can lack a boundary. OpenCode's
    // persisted compaction marker still hides messages before the marker row
    // from the model. Seed only that visible tail, including the marker row;
    // the summary's target can be later and must not exclude visible messages.
    const rawSeedBoundaryId =
        seedBoundaryId ??
        (args.force
            ? getPersistedCompactionMarkerState(args.pass.db, args.pass.sessionId)
                  ?.boundaryMessageId
            : null) ??
        null;
    const rawStart = performance.now();
    const tail =
        args.force && (inventory || rawSeedBoundaryId)
            ? readRawSessionSeedTail(
                  args.pass.sessionId,
                  rawSeedBoundaryId?.replace(/#\d+$/, "") ?? null,
                  () => {
                      if (timing) timing.rawReads += 1;
                  },
              )
            : null;
    if (tail && timing) {
        timing.collect += performance.now() - rawStart;
        timing.rawMessages += tail.size;
    }
    if (tail) {
        if (args.state.idOrdinalMemoGeneration !== args.state.moduleGeneration) {
            args.state.idOrdinalMemo.clear();
            args.state.idOrdinalMemoGeneration = args.state.moduleGeneration;
        }
        for (const raw of tail.values()) {
            const prior = args.state.idOrdinalMemo.get(raw.id);
            if (prior !== undefined && prior !== raw.ordinal) return "mismatch";
            args.state.idOrdinalMemo.set(raw.id, raw.ordinal);
        }
    }
    const eligibleMessageIds = tail ? new Set(tail.keys()) : undefined;
    const eligibleTagAddresses = tail
        ? [...tail.values()].flatMap((raw) => [
              raw.id,
              ...raw.parts.flatMap((_part, index) => [
                  `${raw.id}:p${index}`,
                  `${raw.id}:file${index}`,
              ]),
          ])
        : undefined;
    const rawById = new Map<string, RawMessageParts | null>(tail);
    const readRawById = (messageId: string): RawMessageParts | null => {
        if (!rawById.has(messageId)) {
            rawById.set(
                messageId,
                timing
                    ? timing.collectRead(() =>
                          readRawSessionMessagePartsById(args.pass.sessionId, messageId, () => {
                              timing.rawReads += 1;
                          }),
                      )
                    : readRawSessionMessagePartsById(args.pass.sessionId, messageId),
            );
            if (timing && rawById.get(messageId)) timing.rawMessages += 1;
        }
        return rawById.get(messageId) ?? null;
    };
    const pendingDropSeedState = args.force
        ? buildPendingDropSeeds({
              db: args.pass.db,
              sessionId: args.pass.sessionId,
              readRawById,
              eligibleMessageIds,
          })
        : null;
    const noteNudgeAnchors = args.force
        ? getNoteNudgeAnchors(args.pass.db, args.pass.sessionId)
              .filter((anchor) => !eligibleMessageIds || eligibleMessageIds.has(anchor.messageId))
              .map((anchor) => ({
                  message_id: anchor.messageId,
                  text: anchor.text,
              }))
        : undefined;
    const autoSearchHintSeedState = args.force
        ? buildAutoSearchHintSeeds({
              db: args.pass.db,
              sessionId: args.pass.sessionId,
              readRawById,
              eligibleMessageIds,
          })
        : null;
    const persistedTodoAnchor = args.force
        ? getPersistedTodoSyntheticAnchor(args.pass.db, args.pass.sessionId)
        : null;
    const todoSyntheticAnchor =
        persistedTodoAnchor === null ||
        (eligibleMessageIds &&
            persistedTodoAnchor.messageId !== "__magic_context_todo_head__" &&
            !eligibleMessageIds.has(persistedTodoAnchor.messageId))
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
    // A mode switch is a rebuilding pass; temporal decisions remain engine-owned and first-writer-wins after that rebuild.
    const dropSeedState = args.force
        ? buildDropSeeds({
              db: args.pass.db,
              sessionId: args.pass.sessionId,
              readRawById,
              eligibleMessageIds,
              eligibleTagAddresses,
          })
        : null;
    const stripSeeds = args.force
        ? buildStripSeeds({ db: args.pass.db, sessionId: args.pass.sessionId }).filter(
              (seed) => !eligibleMessageIds || eligibleMessageIds.has(seed.message_id),
          )
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
    const channel2NudgeState = args.force
        ? getChannel2NudgeState(args.pass.db, args.pass.sessionId)
        : undefined;
    const payloadArgs = {
        resolvedBoundaries,
        moduleGeneration: args.state.moduleGeneration,
        expectedShadowSeq: args.state.lastAckedSeq,
        seedId: args.seedId ?? randomUUID(),
        seedBoundaryId,
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
        channel2NudgeState,
        stripSeeds: stripSeeds && stripSeeds.length > 0 ? stripSeeds : undefined,
        stripSeedSkipped: undefined,
        reasoningClearedThroughTag: sessionMeta.clearedReasoningThroughTag,
        lastTodoState: effectiveLastTodoState(args.pass.sessionId, sessionMeta),
        watermarks: currentWatermarks,
        historianModelChain: args.pass.historianModelChain,
        passComplete: args.options?.passComplete,
    };
    if (args.force) {
        const pageStarted = performance.now();
        const wireBatches = buildPagedModuleStateSyncPayloads(payloadArgs);
        if (timing) timing.pageBuild += performance.now() - pageStarted;
        return { ...wireBatches[0], wireBatches };
    }
    return {
        method: "state_sync",
        params: {
            shadow_generation: args.state.moduleGeneration,
            ...(args.pass.historianModelChain !== undefined
                ? { historian_model_chain: args.pass.historianModelChain }
                : {}),
            ...(args.options?.passComplete ? { pass_complete: true as const } : {}),
            expected_shadow_seq: args.state.lastAckedSeq,
            last_todo_state: effectiveLastTodoState(args.pass.sessionId, sessionMeta),
            acked_watermarks: currentWatermarks,
            note_evaluation_available: currentWatermarks.note_evaluation_available ?? false,
            ...(pendingCompactionMarker !== undefined
                ? { pending_compaction_marker: pendingCompactionMarker }
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
    getCachedStateSyncCapabilities?():
        | { state_sync_deltas?: boolean; state_sync_resume?: boolean }
        | undefined;
    /** Clears a capability snapshot when the module reports a restart-like signal. */
    invalidateStateSyncCapabilities?(): void;
    /** Capability probe is optional so older/test transports retain legacy wire semantics. */
    stateSyncCapabilities?(args: {
        sessionId: string;
        projectRoot: string;
    }): Promise<{ state_sync_deltas?: boolean; state_sync_resume?: boolean }>;
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
            | "historian.pending"
            | "historian.claim"
            | "historian.heartbeat"
            | "historian.complete";
        body: unknown;
        signal?: AbortSignal;
        generationSensitive?: boolean;
        attemptClass?: "transform_page_upload" | "transform_series_execute";
        /** Health probes and content-addressed resend attempts must not queue behind the silent request they diagnose. */
        bypassSessionLane?: boolean;
        timeoutMs?: number;
    }): Promise<unknown>;
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

/** Reconnects one state-sync pass tolerates before it fails instead of rebuilding again. */
const MAX_STATE_SYNC_GENERATION_CHANGES = 2;

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
    const timing = args.options?.timing ?? new StateSyncTiming();
    args = { ...args, options: { ...args.options, timing } };
    try {
        let force = args.force;
        const closePass = async (): Promise<boolean> => {
            if (args.pass.providerPass) {
                for (const body of providerPassPages(
                    args.pass.providerPass,
                    args.pass.sessionId,
                    args.options?.passComplete === true,
                )) {
                    const result = await args.client.call({
                        sessionId: args.pass.sessionId,
                        projectRoot: args.projectRoot,
                        method: "state_sync",
                        generationSensitive: true,
                        body,
                    });
                    if (isModuleTransportGenerationChangedResult(result)) return true;
                }
            } else if (args.options?.passComplete) {
                const result = await args.client.call({
                    sessionId: args.pass.sessionId,
                    projectRoot: args.projectRoot,
                    method: "state_sync",
                    generationSensitive: true,
                    body: {
                        method: "state_sync",
                        session_id: args.pass.sessionId,
                        pass_complete: true,
                    },
                });
                return isModuleTransportGenerationChangedResult(result);
            }
            return false;
        };
        const probe = async (body: Record<string, unknown>): Promise<unknown> => {
            const started = performance.now();
            try {
                return await args.client.call({
                    sessionId: args.pass.sessionId,
                    projectRoot: args.projectRoot,
                    method: "session.status",
                    body: {
                        method: "session.status",
                        v: 1,
                        session_id: args.pass.sessionId,
                        ...body,
                    },
                    generationSensitive: true,
                });
            } finally {
                timing.status += performance.now() - started;
            }
        };
        let restartedOnBarrier = false;
        if (
            !force &&
            args.options?.knownWatermarksUnchanged === true &&
            args.state.lastAckedWatermarks !== null &&
            args.state.lastAckedWatermarks.note_evaluation_available === true &&
            (args.pass.historianModelChain === undefined ||
                args.state.lastAckedWatermarks.historian_model_chain_hash ===
                    stableHash(JSON.stringify(args.pass.historianModelChain)))
        ) {
            if (!(await closePass())) return { status: "no_change" };
            restartedOnBarrier = true;
            force = true;
            args.state.lastAckedWatermarks = null;
        }
        const adoption = args.options?.authoritySeqAdoption ?? { used: false };
        let resumable = false;
        const resolveStateSyncDeltas = async (afterGenerationChange = false): Promise<boolean> => {
            let capability = afterGenerationChange ? undefined : args.options?.stateSyncDeltas;
            const cached = args.client.getCachedStateSyncCapabilities?.();
            resumable = cached?.state_sync_resume === true;
            capability ??= cached?.state_sync_deltas;
            if (capability === undefined && args.client.stateSyncCapabilities) {
                try {
                    const probed = await args.client.stateSyncCapabilities({
                        sessionId: args.pass.sessionId,
                        projectRoot: args.projectRoot,
                    });
                    capability = probed.state_sync_deltas;
                    resumable = probed.state_sync_resume === true;
                } catch {
                    // If the capability check fails, assume the module does not support
                    // state_sync_deltas and send the older payload format with its state-sync
                    // fields always present.
                    capability = false;
                }
            }
            return capability === true;
        };
        let stateSyncDeltas = await resolveStateSyncDeltas(restartedOnBarrier);
        // Each connection-generation change rebuilds the whole payload and re-probes the
        // module. A module that drops the connection on every attempt (a crash-and-restart
        // loop, or a payload it cannot survive) would otherwise keep this pass rebuilding
        // forever. Two reconnects cover an ordinary module restart; a third fails the
        // pass, and the caller's failure ladder (last-known-good replay, then refusal)
        // decides what is served.
        let generationChanges = restartedOnBarrier ? 1 : 0;
        const afterGenerationChange = async (): Promise<void> => {
            generationChanges += 1;
            if (generationChanges > MAX_STATE_SYNC_GENERATION_CHANGES) {
                throw Object.assign(
                    new Error(
                        `module state sync abandoned: the module connection changed ${generationChanges} times during one pass`,
                    ),
                    { code: "state_sync_connection_unstable" },
                );
            }
            stateSyncDeltas = await resolveStateSyncDeltas(true);
        };
        syncLoop: for (;;) {
            if (force) args.options = { ...args.options, seedInventory: undefined };
            if (force && resumable) {
                const rawInventory = await probe({ state_sync_inventory: true });
                if (isModuleTransportGenerationChangedResult(rawInventory)) {
                    await afterGenerationChange();
                    continue;
                }
                const inventoryEnvelope =
                    isRecord(rawInventory) && isRecord(rawInventory.result)
                        ? rawInventory.result
                        : rawInventory;
                const inventory =
                    isRecord(inventoryEnvelope) && isRecord(inventoryEnvelope.state_sync_inventory)
                        ? inventoryEnvelope.state_sync_inventory
                        : null;
                if (
                    inventory &&
                    inventory.generation === args.state.moduleGeneration &&
                    Number.isSafeInteger(inventory.max_compartment_sequence) &&
                    (inventory.max_compartment_sequence as number) >= -1 &&
                    (inventory.boundary_id === null || typeof inventory.boundary_id === "string")
                ) {
                    args.options = {
                        ...args.options,
                        seedInventory: {
                            maxCompartmentSequence: inventory.max_compartment_sequence as number,
                            contextBoundariesResolved:
                                inventory.context_boundaries_resolved === true,
                            boundaryId: inventory.boundary_id as string | null,
                        },
                    };
                }
            }
            const buildStarted = performance.now();
            const collectBefore = timing.collect;
            const pagesBefore = timing.pageBuild;
            const payload = await buildModuleStateSyncPayload({
                state: args.state,
                pass: args.pass,
                force,
                options: {
                    ...args.options,
                    stateSyncDeltas,
                    passComplete: args.pass.providerPass ? false : args.options?.passComplete,
                    noteEvaluationProjectPath: args.projectRoot,
                },
            });
            timing.serialize += Math.max(
                0,
                performance.now() -
                    buildStarted -
                    (timing.collect - collectBefore) -
                    (timing.pageBuild - pagesBefore),
            );
            if (payload === null) {
                if (!(await closePass())) return { status: "no_change" };
                await afterGenerationChange();
                force = true;
                args.state.lastAckedWatermarks = null;
                continue;
            }
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
                let nextIndex = 0;
                if (resumable && payload.wireBatches) {
                    const identityStarted = performance.now();
                    // Content identity excludes transport sequence and the random attempt ID. A
                    // restarted adapter can discover the same committed series without re-uploading.
                    const identity: Record<string, unknown> = { watermarks: payload.watermarks };
                    const transportFields = new Set([
                        "seed_id",
                        "expected_shadow_seq",
                        "seed_batch_index",
                        "seed_batch_total",
                        "seed_complete",
                        "seed_boundary_id",
                        "compartments",
                        "pass_complete",
                    ]);
                    for (const batch of batches) {
                        for (const [key, value] of Object.entries(batch.params)) {
                            if (transportFields.has(key)) continue;
                            if (Array.isArray(value))
                                identity[key] = [
                                    ...(Array.isArray(identity[key])
                                        ? (identity[key] as unknown[])
                                        : []),
                                    ...value,
                                ];
                            else identity[key] = value;
                        }
                    }
                    // Compartment identity is its sequence + mutation watermark, not the delta's
                    // page split: inventory can grow when a final response was lost.
                    const seedId = stableHash(canonicalSeedJson(identity));
                    timing.serialize += performance.now() - identityStarted;
                    for (const batch of batches) batch.params.seed_id = seedId;
                    const raw = await probe({ state_sync_seed_id: seedId });
                    if (isModuleTransportGenerationChangedResult(raw)) {
                        await afterGenerationChange();
                        continue;
                    }
                    const envelope = isRecord(raw) && isRecord(raw.result) ? raw.result : raw;
                    const receipt =
                        isRecord(envelope) && isRecord(envelope.state_sync)
                            ? envelope.state_sync
                            : null;
                    if (
                        receipt?.seed_id === seedId &&
                        receipt.generation === args.state.moduleGeneration
                    ) {
                        if (
                            receipt.completed === true &&
                            Number.isSafeInteger(receipt.shadow_seq) &&
                            (receipt.shadow_seq as number) >= args.state.lastAckedSeq
                        ) {
                            args.state.lastAckedWatermarks = payload.watermarks;
                            args.state.lastAckedSeq = receipt.shadow_seq as number;
                            if (await closePass()) {
                                await afterGenerationChange();
                                force = true;
                                args.state.lastAckedWatermarks = null;
                                continue;
                            }
                            return { status: "acked", watermarks: payload.watermarks };
                        }
                        if (receipt.applying === true) return { status: "retry_busy" };
                        if (
                            receipt.shadow_seq === args.state.lastAckedSeq &&
                            Number.isSafeInteger(receipt.next_expected_index) &&
                            (receipt.next_expected_index as number) >= 0 &&
                            (receipt.next_expected_index as number) < batches.length
                        ) {
                            nextIndex = receipt.next_expected_index as number;
                        }
                    }
                }
                const itemCount = batches.reduce(
                    (count, batch) =>
                        count +
                        Object.values(batch.params).reduce<number>(
                            (sum, value) => sum + (Array.isArray(value) ? value.length : 0),
                            0,
                        ),
                    0,
                );
                const budgetMs = Math.min(90_000, 15_000 + 2 * (itemCount + timing.rawMessages));
                for (const batch of batches.slice(nextIndex)) {
                    const encodeStarted = performance.now();
                    const pageBytes = Buffer.byteLength(
                        JSON.stringify({ method: batch.method, ...batch.params }),
                    );
                    timing.serialize += performance.now() - encodeStarted;
                    timing.bytes += pageBytes;
                    timing.pages += 1;

                    timing.tags += batch.params.drop_seeds?.length ?? 0;
                    const transportStarted = performance.now();
                    const response = await args.client
                        .call({
                            sessionId: args.pass.sessionId,
                            projectRoot: args.projectRoot,
                            method: "state_sync",
                            body: {
                                method: batch.method,
                                ...batch.params,
                            },
                            generationSensitive: stateSyncDeltas,
                            timeoutMs: budgetMs,
                        })
                        .finally(() => {
                            const elapsed = performance.now() - transportStarted;
                            timing.transport += elapsed;
                            if (batch.params.seed_complete !== false) timing.moduleAck += elapsed;
                            sessionLog(
                                args.pass.sessionId,
                                `transform stage: stage=rust.state_sync_page page=${batch.params.seed_batch_index ?? 0} pages=${batches.length} bytes=${pageBytes} elapsed=${elapsed.toFixed(3)}ms`,
                            );
                        });
                    if (isModuleTransportGenerationChangedResult(response)) {
                        // The payload used the previous connection's capabilities. Re-probe the new
                        // connection and rebuild before retrying because it may not support deltas.
                        await afterGenerationChange();
                        continue syncLoop;
                    }
                }
                if (args.pass.providerPass && (await closePass())) {
                    await afterGenerationChange();
                    force = true;
                    args.state.lastAckedWatermarks = null;
                    continue;
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
    } finally {
        timing.log(args.pass.sessionId);
    }
}

export const __moduleStateSyncTest = {
    sortCanonicalSeeds,
    buildModuleStateSyncPayload,
    buildPagedModuleStateSyncPayloads,
    canonicalOrdinalForMessageId,
    loadModuleWatermarks,
    moduleWatermarksEqual,
    syncModuleState,
};
