/**
 * Pi-side `<session-history>` injection — mirrors OpenCode's
 * `prepareCompartmentInjection` + `renderCompartmentInjection`
 * (packages/plugin/src/hooks/magic-context/inject-compartments.ts).
 *
 * Pi differences:
 *   - Pi messages have `content: string | (TextContent | ImageContent)[]`,
 *     not OpenCode's `parts: unknown[]`. We project Pi messages into a
 *     minimal MessageLike-shaped view so the shared
 *     `prepareCompartmentInjection` can do its DB read + cache lookup +
 *     boundary trim. The actual render writes back to Pi shape.
 *   - Pi messages don't have a stable per-message id at the AgentMessage
 *     layer. We synthesize one using the same `pi-msg-${index}-${ts}-${role}`
 *     scheme `transcript-pi.ts` uses, so the boundary-trim cutoff comparison
 *     stays consistent across passes.
 *
 * Cache safety:
 *   - `prepareCompartmentInjection` honors its own injection cache. On
 *     defer passes (`isCacheBusting=false`) the cached prepared block is
 *     replayed, the boundary trim is re-applied, and we just re-write the
 *     cached block into Pi message[0]. Provider prompt cache stays stable.
 *   - On cache-busting passes (historian/compressor publish, /ctx-flush)
 *     the cache is rebuilt and the new block is written. Caller is
 *     responsible for setting `isCacheBusting` correctly via the shared
 *     historyRefreshSessions signal.
 */

import {
	getMaxMemoryIdForProjects,
	getMemoriesByProject,
	getMemoriesByProjects,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import type { Memory } from "@magic-context/core/features/magic-context/memory/types";
import { resolveMuralWire } from "@magic-context/core/features/magic-context/mural/render-trigger";
import type { MuralWireOptions } from "@magic-context/core/features/magic-context/mural/resolve-mural";
import {
	type ContextDatabase,
	clearCachedM0M1,
	escapeXmlContent,
	GLOBAL_USER_PROFILE_PROJECT_PATH,
	getCompartments,
	getMaxM0MutationId,
	getMaxMemoryMutationId,
	getMaxMemoryMutationIdForProjects,
	getMemoryMutationsForRender,
	getMemoryMutationsForRenderByProjects,
	getOrCreateSessionMeta,
	getProjectState,
	persistCachedM0,
	readProjectDocsCanonical,
} from "@magic-context/core/features/magic-context/storage";
import {
	getActiveUserMemories,
	type UserMemory,
} from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import {
	computeWorkspaceEpochFingerprint,
	expandWorkspaceIdentitySetWithAliases,
	resolveWorkspaceIdentitySet,
	resolveWorkspaceShareCategories,
	sourceNameForMemory,
} from "@magic-context/core/features/magic-context/workspaces";
import {
	COMPARTMENT_RENDER_EPOCH,
	decodeCachedM0UpgradeIdentity,
	encodeCachedM0UpgradeIdentity,
} from "@magic-context/core/hooks/magic-context/compartment-render-epoch";
import {
	DEFAULT_HISTORY_BUDGET_TOKENS,
	extractM0Block,
	renderCompartmentAtTier,
	renderDecayedCompartments,
} from "@magic-context/core/hooks/magic-context/decay-render";
import {
	DEFAULT_MEMORY_BUDGET_TOKENS,
	DEFAULT_USER_PROFILE_BUDGET_TOKENS,
	type MemoryRenderOptions,
	renderMemoryBlockV2,
	stripMemoryMuralBlock,
	trimMemoriesToBudgetV2,
	trimUserMemoriesToBudget,
	trimWorkspaceMemoriesToBudgetV2,
	type WorkspaceRenderContext,
} from "@magic-context/core/hooks/magic-context/inject-compartments";

import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { sessionLog as logSession } from "@magic-context/core/shared/logger";
import { resolvePiStableId, SYNTH_USER_ID_PREFIX } from "./read-session-pi";

/**
 * Pi message shapes — kept structurally compatible with
 * `@earendil-works/pi-coding-agent`'s `AgentMessage` union. Same minimal
 * subset transcript-pi.ts uses.
 */
type PiTextContent = { type: "text"; text: string; textSignature?: string };
type PiImageContent = { type: "image"; data: string; mimeType: string };
type PiUserMessage = {
	role: "user";
	content: string | (PiTextContent | PiImageContent)[];
	timestamp?: number;
};
type PiAssistantMessage = {
	role: "assistant";
	content: unknown[];
	timestamp?: number;
};
type PiToolResultMessage = {
	role: "toolResult";
	content: unknown[];
	timestamp?: number;
};
type PiAgentMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

/** Resolve a live Pi message to the stable ID stored with its compartment boundary. */
function resolveStableId(
	msg: PiAgentMessage,
	index: number,
	entryIds: readonly (string | undefined)[] | undefined,
): string {
	return resolvePiStableId(msg, index, entryIds) ?? "";
}

/**
 * Mutate `piMessages` in place: remove every message whose synthesized
 * id appears at or before the cutoff. Preserves the rest of the array.
 *
 * Mirrors the `messages.splice(0, cutoffIndex+1)` behavior the shared
 * `prepareCompartmentInjection` does on its (OpenCode) MessageLike[].
 *
 * # Synthetic-user (folded toolResult) cutoffs
 *
 * A compartment's `endMessageId` comes from `convertEntriesToRawMessages`,
 * which folds a run of `toolResult` entries into a synthetic-user RawMessage
 * with id `${SYNTH_USER_ID_PREFIX}<firstFoldedToolResultEntryId>`. The LIVE Pi
 * message array does NOT contain that synthetic id — folding is a historian-
 * chunking artifact only; the underlying toolResult messages are present as
 * real entries. So a raw `resolveStableId(msg) === cutoffMessageId` comparison
 * can never match a synth-user cutoff, `cutoffIndex` stays -1, and the
 * summarized prefix is never trimmed → duplicate content + overflow in
 * tool-heavy sessions. When the cutoff is synthetic, strip the prefix and match
 * against the underlying real toolResult entry id instead (the suffix is, by
 * construction, the real entry id of the first folded toolResult, which IS a
 * visible message). Trimming through that toolResult covers the whole folded
 * run because the bidirectional orphan sweep below removes the rest of the run.
 *
 * Returns the count of messages removed — used for log parity.
 */
function trimPiMessagesToBoundary(
	piMessages: PiAgentMessage[],
	entryIds: readonly (string | undefined)[] | undefined,
	cutoffMessageId: string,
	trimMutableEntryIds = false,
): number {
	if (cutoffMessageId.length === 0) return 0;
	// Resolve a synthetic-user (folded toolResult) cutoff to the real entry id
	// of the underlying toolResult, which is what the live message carries.
	const effectiveCutoffId = cutoffMessageId.startsWith(SYNTH_USER_ID_PREFIX)
		? cutoffMessageId.slice(SYNTH_USER_ID_PREFIX.length)
		: cutoffMessageId;
	if (effectiveCutoffId.length === 0) return 0;
	let cutoffIndex = -1;
	for (let i = 0; i < piMessages.length; i++) {
		const msg = piMessages[i];
		if (msg && resolveStableId(msg, i, entryIds) === effectiveCutoffId) {
			cutoffIndex = i;
			break;
		}
	}
	if (cutoffIndex < 0) return 0;

	// Start with the same prefix trim as the shared OpenCode projection, then
	// repeatedly sweep both directions across Pi's split tool-call shape. The
	// sweep is intentionally scoped by the owning assistant message index, not by
	// bare callId: Pi/OpenCode may reuse callIds across turns, and a global callId
	// match can delete a valid kept-tail pair from a later turn. Pair ownership is
	// inferred from the nearest assistant carrying that callId (backward first,
	// then forward for legacy/test shapes where a result precedes its call). This
	// preserves the non-contiguous same-turn cleanup while avoiding cross-turn
	// over-removal.
	const remove = new Set<number>();
	for (let i = 0; i <= cutoffIndex; i++) remove.add(i);

	let changed = true;
	while (changed) {
		changed = false;
		const removedCallKeys = new Set<string>();
		const removedResultKeys = new Set<string>();

		for (const index of remove) {
			const msg = piMessages[index];
			if (!msg) continue;
			if (msg.role === "assistant") {
				for (const callId of getPiToolCallIds(msg)) {
					removedCallKeys.add(toolPairKey(callId, index));
				}
			} else if (msg.role === "toolResult") {
				const callId = getPiToolResultCallId(msg);
				const ownerIndex = callId
					? findToolResultOwnerAssistantIndex(piMessages, index, callId)
					: null;
				if (callId && ownerIndex !== null) {
					removedResultKeys.add(toolPairKey(callId, ownerIndex));
				}
			}
		}

		for (let i = 0; i < piMessages.length; i++) {
			if (remove.has(i)) continue;
			const msg = piMessages[i];
			if (!msg) continue;
			if (msg.role === "toolResult") {
				const callId = getPiToolResultCallId(msg);
				const ownerIndex = callId
					? findToolResultOwnerAssistantIndex(piMessages, i, callId)
					: null;
				if (
					callId &&
					ownerIndex !== null &&
					removedCallKeys.has(toolPairKey(callId, ownerIndex))
				) {
					remove.add(i);
					changed = true;
				}
				continue;
			}
			if (msg.role === "assistant") {
				const callIds = getPiToolCallIds(msg);
				if (
					callIds.some((callId) =>
						removedResultKeys.has(toolPairKey(callId, i)),
					)
				) {
					remove.add(i);
					changed = true;
				}
			}
		}
	}

	const kept = piMessages.filter((_, index) => !remove.has(index));
	const removed = piMessages.length - kept.length;
	piMessages.splice(0, piMessages.length, ...kept);
	if (trimMutableEntryIds && Array.isArray(entryIds)) {
		const keptIds = entryIds.filter((_, index) => !remove.has(index));
		entryIds.splice(0, entryIds.length, ...keptIds);
	}
	return removed;
}

function toolPairKey(callId: string, assistantIndex: number): string {
	return `${callId}\0${assistantIndex}`;
}

function findToolResultOwnerAssistantIndex(
	messages: readonly PiAgentMessage[],
	resultIndex: number,
	callId: string,
): number | null {
	for (let i = resultIndex - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant" && getPiToolCallIds(msg).includes(callId)) {
			return i;
		}
	}
	for (let i = resultIndex + 1; i < messages.length; i++) {
		const msg = messages[i];
		if (msg?.role === "assistant" && getPiToolCallIds(msg).includes(callId)) {
			return i;
		}
	}
	return null;
}

function getPiToolCallIds(message: PiAssistantMessage): string[] {
	if (!Array.isArray(message.content)) return [];
	const ids: string[] = [];
	for (const part of message.content) {
		if (
			part &&
			typeof part === "object" &&
			(part as Record<string, unknown>).type === "toolCall" &&
			typeof (part as Record<string, unknown>).id === "string"
		) {
			ids.push((part as Record<string, unknown>).id as string);
		}
	}
	return ids;
}

function getPiToolResultCallId(message: PiToolResultMessage): string | null {
	const callId = (message as Record<string, unknown>).toolCallId;
	return typeof callId === "string" && callId.length > 0 ? callId : null;
}

export const __test = {
	trimPiMessagesToBoundary,
	renderFreshM0PiNonPersisted,
	clearPiMuralProcessCache,
};

const PI_M1_PLACEHOLDER =
	"<session-history-since>(no new content since last materialization)</session-history-since>";
const MAX_FORCED_MEMORIES_PER_DELTA = 10;
// Pi uses a STATIC upgrade-state marker, intentionally diverging from OpenCode's
// dynamic getUpgradeState(db, sessionId). OpenCode flips this per-session when a
// `/ctx-session-upgrade` recomp transitions legacy→v2, forcing an m[0] refold.
// Pi has no equivalent per-session upgrade-state transition wired into the m[0]
// markers yet, so a static const is internally consistent (stored marker and
// current marker always match → never falsely triggers, never misses a real Pi
// transition because there is none). Revisit if Pi gains a session-upgrade flow
// that must invalidate m[0].
const PI_M0_UPGRADE_STATE = "pi-m0m1-v2";
const EMPTY_MAX_COMPARTMENT_SEQ = -1;

type PiCompartment = ReturnType<typeof getCompartments>[number];

type PiProjectDocsRender = ReturnType<typeof readProjectDocsCanonical>;

interface FrozenM0Inputs {
	docs: PiProjectDocsRender;
	markers: PiM0SnapshotMarkers;
	compartments: PiCompartment[];
	memories: Memory[];
	userProfile: UserMemory[];
	workspace: WorkspaceRenderContext;
}

/**
 * Real-tokenizer size of ONLY the <session-history> slice of a rendered m[0]
 * (parity with OpenCode's historySliceTokens). The over-budget tightening loop
 * must measure the history block against the history budget, not the whole m[0]
 * — m[0] also carries <project-docs>/<user-profile>/<project-memory>, each with
 * its own budget. Charging those against the history budget over-tightens decay
 * and starves session-history. Returns 0 when there's no history slice.
 */
function historySliceTokensPi(m0Text: string): number {
	const slice = extractM0Block(m0Text, "session-history");
	return slice ? estimateTokens(slice) : 0;
}

/**
 * Fail-open wrapper around getActiveUserMemories (parity with OpenCode's
 * safeGetActiveUserMemories). On a DB that predates the user_memories table
 * (unmigrated / partially-initialized), the raw call throws "no such table:
 * user_memories"; OpenCode degrades to an empty profile, so Pi must too —
 * otherwise m[0] materialization crashes the whole transform on such DBs.
 */
function safeGetActiveUserMemoriesPi(db: ContextDatabase): UserMemory[] {
	try {
		return getActiveUserMemories(db);
	} catch (error) {
		if (String(error).includes("no such table: user_memories")) return [];
		throw error;
	}
}

export interface PiM0M1State {
	sessionId: string;
	projectIdentity: string;
	projectDirectory: string;
	/** When false, every memory-derived surface is omitted from m[0]/m[1]
	 *  (config `memory.enabled=false`): project memory, user profile, deltas, and
	 *  the memory mural. Docs are controlled independently by injectDocs.
	 *  Unset/true keeps memory on. */
	memoryEnabled?: boolean;
	/** Defaults true. When false, m[0] omits the <project-docs> block and docs hash. */
	injectDocs?: boolean;
	/** Memory-block trim budget (~4K). Bounds the <project-memory> block. */
	injectionBudgetTokens?: number;
	/** v2 decay-render history budget (~60K). Drives compartment tier demotion.
	 *  Distinct from injectionBudgetTokens — using the memory budget here would
	 *  over-demote every compartment. */
	historyBudgetTokens?: number;
	/** User-profile block budget (~4K). The m[1] new-user-profile delta is
	 *  trimmed to 25% of this (matches OpenCode renderM1). Defaults when unset. */
	userProfileBudgetTokens?: number;
	/** Provider-side cache-eviction signals for HARD-bust detection. */
	hardSignals?: PiM0HardSignals;
	/** Mural feature switch (`mural.enabled`). When
	 *  true and the fold's model accepts images, HARD materialization resolves
	 *  + renders the deterministic mural on demand and folds its image into the
	 *  cached baseline. Defer passes replay the baked-in bytes without re-render. */
	muralEnabled?: boolean;
	/** Explicit mural wire options for tests. When set, skips on-demand resolve
	 * during HARD materialization (mirrors OpenCode `M0M1RenderOptions.mural`). */
	mural?: MuralWireOptions;
	/** Keeps memory/docs injection while suppressing compartment history rendering and trimming. */
	compactionOff?: boolean;
}

const EMPTY_PI_PROJECT_DOCS: PiProjectDocsRender = {
	renderedBlock: "",
	canonicalHash: "",
};

function getRenderableCompartmentsPi(
	db: ContextDatabase,
	state: PiM0M1State,
): PiCompartment[] {
	return state.compactionOff ? [] : getCompartments(db, state.sessionId);
}

function readProjectDocsForPiM0(state: PiM0M1State): PiProjectDocsRender {
	return state.injectDocs !== false
		? readProjectDocsCanonical(state.projectDirectory)
		: EMPTY_PI_PROJECT_DOCS;
}

/**
 * The project path used for MEMORY reads only. Returns undefined when
 * `memory.enabled=false`, so every memory read short-circuits to its empty
 * value (mirrors OpenCode passing `projectPath: undefined`). Project docs use
 * the independent injectDocs flag.
 */
function memoryProjectPath(state: PiM0M1State): string | undefined {
	return state.memoryEnabled === false ? undefined : state.projectIdentity;
}

function resolveWorkspaceRenderContextPi(
	state: PiM0M1State,
	db: ContextDatabase,
): WorkspaceRenderContext {
	const memPath = memoryProjectPath(state);
	if (!memPath) {
		return {
			identities: [],
			expandedIdentities: [],
			ownIdentities: [],
			shareCategories: null,
			namesByIdentity: new Map(),
			canonicalIdentityByStoredPath: new Map(),
			isWorkspaced: false,
		};
	}
	const identitySet = resolveWorkspaceIdentitySet(db, memPath);
	const isWorkspaced = identitySet.identities.length > 1;
	const expanded = expandWorkspaceIdentitySetWithAliases(
		db,
		identitySet.identities,
	);
	const expandedIdentities = isWorkspaced
		? expanded.expandedIdentities
		: identitySet.identities;
	const canonicalIdentityByStoredPath = isWorkspaced
		? expanded.canonicalIdentityByStoredPath
		: new Map(identitySet.identities.map((identity) => [identity, identity]));
	let ownIdentities = expandedIdentities.filter(
		(identity) => canonicalIdentityByStoredPath.get(identity) === memPath,
	);
	if (ownIdentities.length === 0 && expandedIdentities.includes(memPath)) {
		ownIdentities = [memPath];
	}
	return {
		identities: identitySet.identities,
		expandedIdentities,
		ownIdentities,
		shareCategories: isWorkspaced
			? resolveWorkspaceShareCategories(db, memPath)
			: null,
		namesByIdentity: identitySet.namesByIdentity,
		canonicalIdentityByStoredPath,
		isWorkspaced,
	};
}

function sourceNamesForPiMemories(args: {
	memories: readonly Memory[];
	projectPath?: string;
	workspace: WorkspaceRenderContext;
}): Map<number, string> | undefined {
	if (!args.projectPath || !args.workspace.isWorkspaced) return undefined;
	const names = new Map<number, string>();
	for (const memory of args.memories) {
		const source = sourceNameForMemory(
			memory.projectPath,
			args.projectPath,
			args.workspace.identities,
			args.workspace.namesByIdentity,
			args.workspace.canonicalIdentityByStoredPath,
		);
		if (source) names.set(memory.id, source);
	}
	return names.size > 0 ? names : undefined;
}

export interface PiM0SnapshotMarkers {
	maxCompartmentSeq: number;
	maxMemoryId: number;
	maxMutationId: number;
	maxMemoryMutationId: number;
	projectMemoryEpoch: number;
	workspaceFingerprint: string | null;
	projectUserProfileVersion: number;
	projectDocsHash: string;
	sessionFactsVersion: number;
	materializedAt: number;
	upgradeState: string;
	compartmentRenderEpoch: string | null;
	lastBaselineEndMessageId: string | null;
	// HARD-bust markers (parity with OpenCode M0SnapshotMarkers): provider-side
	// cache-eviction signals. systemHash/modelKey come from runtime; Pi has no
	// Captured from PiM0HardSignals at the injection call site.
	systemHash: string;
	modelKey: string;
	// Pi sessions can switch projects in-process (`/cd`). NULL on legacy cached
	// rows means unknown/lazy-adopted and must not force a HARD fold by itself.
	projectIdentity: string | null;
	muralEnabled: boolean;
	renderBudgetIdentity: string;
}

/**
 * Runtime cache-eviction signals threaded into Pi's materialization decision
 * (parity with OpenCode M0HardSignals). systemHash + cacheExpired derive from
 * session_meta; modelKey comes from the volatile liveModelBySession map in
 * context-handler. toolSetHash is always "" on Pi (no tool.definition hook).
 */
export interface PiM0HardSignals {
	systemHash: string;
	modelKey: string;
	cacheExpired: boolean;
	lastResponseTime: number;
}

const EMPTY_PI_HARD_SIGNALS: PiM0HardSignals = {
	systemHash: "",
	modelKey: "",
	cacheExpired: false,
	lastResponseTime: 0,
};

function renderBudgetIdentityPi(state: PiM0M1State): string {
	return `m${state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS}-h${state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS}`;
}

export interface PiMaterializeMismatch {
	signal: string;
	cached: string | number | boolean | null;
	current: string | number | boolean | null;
}

export interface PiMaterializeDecision {
	value: boolean;
	reason: string | null;
	/** The exact compared values for the signal that fired. */
	mismatch?: PiMaterializeMismatch;
}

function piMaterializeMismatch(
	reason: string,
	signal: string,
	cached: PiMaterializeMismatch["cached"],
	current: PiMaterializeMismatch["current"],
): PiMaterializeDecision {
	return { value: true, reason, mismatch: { signal, cached, current } };
}

interface PiInjectionTokenCountCache {
	m0: string;
	m0Tokens: number;
	m1: string;
	m1Tokens: number;
}

const injectionTokenCountsBySession = new Map<
	string,
	PiInjectionTokenCountCache
>();

/** Process-local mirror of the mural payload persisted with the cached m0 row. */
interface CachedPiMural {
	dataUrl: string | null;
	contentHash: string | null;
}

const cachedMuralBySession = new Map<string, CachedPiMural>();

function clearPiMuralProcessCache(sessionId?: string): void {
	if (sessionId) cachedMuralBySession.delete(sessionId);
	else cachedMuralBySession.clear();
}

function rememberPiMuralPayload(
	sessionId: string,
	dataUrl: string | null | undefined,
	contentHash: string | null | undefined,
): void {
	cachedMuralBySession.set(sessionId, {
		dataUrl: dataUrl ?? null,
		contentHash: contentHash ?? null,
	});
}

function rememberPiMural(
	sessionId: string,
	mural: MuralWireOptions | undefined,
): void {
	rememberPiMuralPayload(
		sessionId,
		mural?.enabled && mural.supportsVision ? mural.dataUrl : null,
		mural?.enabled && mural.supportsVision ? mural.contentHash : null,
	);
}

function muralForWire(sessionId: string): MuralWireOptions | undefined {
	const cached = cachedMuralBySession.get(sessionId);
	if (!cached?.dataUrl) return undefined;
	return {
		enabled: true,
		supportsVision: true,
		dataUrl: cached.dataUrl,
		contentHash: cached.contentHash ?? undefined,
	};
}

/** Convert a PNG data URL into Pi's native image content block (raw base64). */
function piImageFromDataUrl(dataUrl: string): PiImageContent | null {
	const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl);
	if (!match) return null;
	return { type: "image", mimeType: match[1], data: match[2] };
}

/**
 * Resolve mural wire options for a HARD fold. Explicit test `state.mural` wins;
 * otherwise gate on `muralEnabled` + vision capability via resolveMuralWire.
 * Returns undefined when the feature is off so renderM0Pi skips the block.
 */
function resolveMuralForM0Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	modelKey: string,
	budgetTokens: number,
): MuralWireOptions | undefined {
	if (state.memoryEnabled === false) return undefined;
	if (state.mural) return state.mural;
	if (!state.muralEnabled) return undefined;
	return resolveMuralWire(
		db,
		memoryProjectPath(state),
		modelKey,
		true,
		budgetTokens,
	);
}

function cachedInjectionTokenCounts(
	sessionId: string,
	m0: string,
	m1: string,
): { m0Tokens: number; m1Tokens: number } {
	const cached = injectionTokenCountsBySession.get(sessionId);
	if (cached?.m0 === m0 && cached.m1 === m1) return cached;
	const counts = {
		m0,
		m0Tokens: estimateTokens(m0),
		m1,
		m1Tokens: m1 === PI_M1_PLACEHOLDER ? 0 : estimateTokens(m1),
	};
	injectionTokenCountsBySession.set(sessionId, counts);
	return counts;
}

export function clearPiInjectionTokenCountCache(sessionId: string): void {
	injectionTokenCountsBySession.delete(sessionId);
}

export interface PiRenderedCompartmentBoundary {
	endMessageId: string | null;
	ordinal: number | null;
}

export interface PiM0M1InjectionResult extends PiInjectionResult {
	m0Materialized: boolean;
	m0Reason: string | null;
	m0Bytes: number;
	m1Bytes: number;
	/**
	 * True when this pass lost the materialization retry race and used temporary
	 * fallback content instead of a freshly persisted session-history cache. Keep
	 * deferred marker signals armed in that case because the rendered boundary may
	 * not match the latest saved compartment snapshot.
	 */
	contentionExhausted: boolean;
	/** The compartment boundary actually represented by the m[0]/m[1] pair sent. */
	renderedBoundary: PiRenderedCompartmentBoundary;
	/**
	 * Watermark of the compartment coverage rendered into the m[1] delta THIS
	 * pass (max end ordinal / end message id of the compartments included in
	 * the m[1] render), derived from the SAME compartment snapshot the render
	 * used. NULL unless m[1] was freshly recomputed this pass without a
	 * contention fallback: the soft-refresh sibling-fallback serves a sibling's
	 * stale cached m[1] (recomputed=false while contentionExhausted stays
	 * false) and the pure-replay branch serves bytes rendered by an earlier
	 * pass — neither may certify coverage for compartments those bytes never
	 * contained, so the deferred-marker drain keeps its signal armed and
	 * retries on the next fresh render. Per-pass in-memory ONLY (never
	 * persisted): the drain reads it solely on busting passes that freshly
	 * recomputed m[1]; replay passes never evaluate the m[1] coverage arm.
	 */
	m1RenderedCoverage: PiRenderedCompartmentBoundary | null;
	/**
	 * Number of synthetic, id-less messages prepended at the FRONT of the array
	 * by this injection (the m[0] + m[1] pair). These never resolve to a real
	 * SessionEntry id, so downstream anchor-GC must exclude them from its
	 * "all messages resolved" denominator or pruning never runs.
	 */
	syntheticLeadingCount: number;
}

function decodeCachedM0(value: Buffer | Uint8Array | null): string | null {
	if (!value) return null;
	return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
		"utf8",
	);
}

// v2: session_facts is retired as a render source (facts = promoted memories).
// The m[0] snapshot still carries a sessionFactsVersion field for shape
// stability, but it is pinned to 0 so it never drives re-materialization —
// fact changes no longer affect rendered bytes.
function getSessionFactsVersion(
	_db: ContextDatabase,
	_sessionId: string,
): number {
	return 0;
}

function normalizeCachedMaxCompartmentSeq(
	stored: number,
	compartments: readonly PiCompartment[],
): number {
	// Backward compatibility for legacy empty snapshots persisted with 0: only
	// reinterpret 0 as empty against the exact compartment snapshot used for the
	// cache-validity decision. If a seq-0 compartment exists, 0 is a real
	// watermark and must remain publishable; only a truly empty session upgrades
	// the legacy sentinel to EMPTY_MAX_COMPARTMENT_SEQ.
	if (stored === 0 && compartments.length === 0) {
		return EMPTY_MAX_COMPARTMENT_SEQ;
	}
	return stored;
}

function getCachedBoundary(
	db: ContextDatabase,
	sessionId: string,
): string | null {
	const row = db
		.prepare(
			"SELECT cached_m0_last_baseline_end_message_id AS boundary FROM session_meta WHERE session_id = ?",
		)
		.get(sessionId) as { boundary?: unknown } | undefined;
	return typeof row?.boundary === "string" && row.boundary.length > 0
		? row.boundary
		: null;
}

export function trimPiMessagesToCachedBoundary(
	db: ContextDatabase,
	sessionId: string,
	piMessages: PiAgentMessage[],
	entryIds: (string | undefined)[] | undefined,
): number {
	const row = db
		.prepare(
			`SELECT cached_m0_bytes AS m0, cached_m1_bytes AS m1,
			        cached_m0_last_baseline_end_message_id AS boundary
			 FROM session_meta WHERE session_id = ?`,
		)
		.get(sessionId) as
		| { m0?: unknown; m1?: unknown; boundary?: unknown }
		| undefined;
	if (!row?.m0 || !row.m1 || typeof row.boundary !== "string") return 0;
	const boundary = row.boundary;
	if (boundary.length === 0) return 0;
	const boundaryIsLive = getCompartments(db, sessionId).some(
		(compartment) => compartment.endMessageId === boundary,
	);
	if (!boundaryIsLive) return 0;
	return trimPiMessagesToBoundary(piMessages, entryIds, boundary, true);
}

function setCachedBoundary(
	db: ContextDatabase,
	sessionId: string,
	boundary: string | null,
): void {
	db.prepare(
		"UPDATE session_meta SET cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
	).run(boundary, sessionId);
}

function getCachedMarkers(
	db: ContextDatabase,
	state: PiM0M1State,
	compartmentsForNormalization?: readonly PiCompartment[],
): PiM0SnapshotMarkers | null {
	const meta = getOrCreateSessionMeta(db, state.sessionId);
	if (!meta.cachedM0Bytes) return null;
	if (
		meta.cachedM0MaxCompartmentSeq === null ||
		meta.cachedM0MaxMemoryId === null ||
		meta.cachedM0MaxMutationId === null ||
		meta.cachedM0MaxMemoryMutationId === null ||
		meta.cachedM0ProjectMemoryEpoch === null ||
		meta.cachedM0ProjectUserProfileVersion === null ||
		meta.cachedM0ProjectDocsHash === null ||
		meta.cachedM0SessionFactsVersion === null ||
		meta.cachedM0MaterializedAt === null ||
		meta.cachedM0UpgradeState === null
	) {
		return null;
	}
	const compartments =
		compartmentsForNormalization ?? getRenderableCompartmentsPi(db, state);
	const cachedUpgradeIdentity = decodeCachedM0UpgradeIdentity(
		meta.cachedM0UpgradeState,
	);
	const maxCompartmentSeq = normalizeCachedMaxCompartmentSeq(
		meta.cachedM0MaxCompartmentSeq,
		compartments,
	);
	const cachedBoundary = getCachedBoundary(db, state.sessionId);
	// Invalidate a null cached boundary ONLY when the live snapshot actually has
	// a usable boundary — i.e. the cache is genuinely stale (a boundary appeared
	// since it was written). An empty `end_message_id` on the latest compartment
	// is a LEGITIMATE state (schema default ''; OpenCode degrades to "inject
	// without visible-prefix trimming"), so a materialize can correctly persist a
	// null boundary. Rejecting that every pass caused a re-materialize loop for
	// legacy / partially-upgraded sessions. When the live snapshot also has no
	// usable boundary, reuse the cache and let findCompartmentBoundaryForSnapshot
	// degrade to no-trim.
	const liveBoundary = lastBaselineEndMessageId(compartments);
	if (
		maxCompartmentSeq >= 0 &&
		cachedBoundary === null &&
		liveBoundary !== null
	) {
		return null;
	}
	return {
		maxCompartmentSeq,
		maxMemoryId: meta.cachedM0MaxMemoryId,
		maxMutationId: meta.cachedM0MaxMutationId,
		maxMemoryMutationId: meta.cachedM0MaxMemoryMutationId,
		projectMemoryEpoch: meta.cachedM0ProjectMemoryEpoch,
		workspaceFingerprint: meta.cachedM0WorkspaceFingerprint,
		projectUserProfileVersion: meta.cachedM0ProjectUserProfileVersion,
		projectDocsHash: meta.cachedM0ProjectDocsHash,
		sessionFactsVersion: meta.cachedM0SessionFactsVersion,
		materializedAt: meta.cachedM0MaterializedAt,
		upgradeState: cachedUpgradeIdentity.upgradeState ?? "",
		compartmentRenderEpoch: cachedUpgradeIdentity.compartmentRenderEpoch,
		// The boundary that was persisted WITH these cached m[0] bytes (may be
		// null for a legitimately-boundaryless baseline — see the guard above).
		lastBaselineEndMessageId: cachedBoundary,
		systemHash: meta.cachedM0SystemHash ?? "",
		modelKey: meta.cachedM0ModelKey ?? "",
		projectIdentity: meta.cachedM0ProjectIdentity ?? null,
		muralEnabled: cachedUpgradeIdentity.muralEnabled ?? false,
		renderBudgetIdentity: cachedUpgradeIdentity.renderBudgetIdentity ?? "",
	};
}

function lastBaselineEndMessageId(
	compartments: readonly PiCompartment[],
): string | null {
	const last = compartments.at(-1);
	return last?.endMessageId && last.endMessageId.length > 0
		? last.endMessageId
		: null;
}

function readCurrentMarkers(
	db: ContextDatabase,
	state: PiM0M1State,
	projectDocsHash?: string,
): PiM0SnapshotMarkers {
	return readCurrentMarkersFromCompartments(
		db,
		state,
		getRenderableCompartmentsPi(db, state),
		projectDocsHash,
	);
}

function readCurrentMarkersFromCompartments(
	db: ContextDatabase,
	state: PiM0M1State,
	compartments: readonly PiCompartment[],
	projectDocsHash?: string,
): PiM0SnapshotMarkers {
	const memPath = memoryProjectPath(state);
	const workspace = resolveWorkspaceRenderContextPi(state, db);
	const maxMemoryId = memPath
		? workspace.isWorkspaced
			? getMaxMemoryIdForProjects(
					db,
					workspace.expandedIdentities,
					workspace.ownIdentities,
					workspace.shareCategories,
				)
			: getMaxMemoryIdForProjects(db, [memPath])
		: 0;
	const projectState = memPath ? getProjectState(db, memPath) : undefined;
	const globalState = getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH);
	return {
		// reduce, not Math.max(...spread): a project with very many
		// compartments/memories (100K+) blows the call-stack arg limit and
		// throws RangeError, breaking m[0]/m[1] rendering for that session.
		// OpenCode uses SQL COALESCE(MAX(id),0) with no such limit.
		maxCompartmentSeq:
			compartments.length > 0
				? compartments.reduce(
						(max, compartment) =>
							compartment.sequence > max ? compartment.sequence : max,
						EMPTY_MAX_COMPARTMENT_SEQ,
					)
				: EMPTY_MAX_COMPARTMENT_SEQ,
		maxMemoryId,
		maxMutationId: getMaxM0MutationId(db, state.sessionId) ?? 0,
		maxMemoryMutationId: memPath
			? workspace.isWorkspaced
				? (getMaxMemoryMutationIdForProjects(
						db,
						workspace.expandedIdentities,
					) ?? 0)
				: (getMaxMemoryMutationId(db, memPath) ?? 0)
			: 0,
		projectMemoryEpoch: projectState?.projectMemoryEpoch ?? 0,
		workspaceFingerprint: workspace.isWorkspaced
			? computeWorkspaceEpochFingerprint(db, workspace.identities)
			: null,
		projectUserProfileVersion: globalState?.projectUserProfileVersion ?? 0,
		projectDocsHash:
			projectDocsHash ?? readProjectDocsForPiM0(state).canonicalHash,
		sessionFactsVersion: getSessionFactsVersion(db, state.sessionId),
		materializedAt: Date.now(),
		// Dynamic upgrade state (parity with OpenCode getUpgradeState): suffix
		// "legacy" when any legacy=1 compartment remains, else "ready". This makes
		// `/ctx-session-upgrade` (legacy→v2 conversion) flip the marker so m[0]
		// re-materializes with the upgraded tiered content. A static const would
		// leave Pi serving stale legacy-rendered m[0] after an upgrade.
		upgradeState: `${PI_M0_UPGRADE_STATE}:${
			compartments.some((c) => c.legacy === 1) ? "legacy" : "ready"
		}`,
		compartmentRenderEpoch: COMPARTMENT_RENDER_EPOCH,
		lastBaselineEndMessageId: lastBaselineEndMessageId(compartments),
		systemHash: (state.hardSignals ?? EMPTY_PI_HARD_SIGNALS).systemHash,
		modelKey: piModelRefToCanonical(
			(state.hardSignals ?? EMPTY_PI_HARD_SIGNALS).modelKey,
		),
		projectIdentity: state.projectIdentity,
		muralEnabled: state.muralEnabled === true,
		renderBudgetIdentity: renderBudgetIdentityPi(state),
	};
}

export function mustMaterializePi(
	state: PiM0M1State,
	db: ContextDatabase,
	currentCompartmentsOverride?: readonly PiCompartment[],
): PiMaterializeDecision {
	const meta = getOrCreateSessionMeta(db, state.sessionId);
	// Accept a caller-provided snapshot so the materialize decision and the
	// subsequent cached-marker reload in injectM0M1Pi normalize against the SAME
	// compartment set. Re-reading here (when the caller already read) opened a
	// TOCTOU where a count change between the decision and the reload could flip
	// markers to null and escape to the unguarded re-materialize path.
	const currentCompartments =
		currentCompartmentsOverride ?? getRenderableCompartmentsPi(db, state);
	const current = readCurrentMarkersFromCompartments(
		db,
		state,
		currentCompartments,
		// Project-doc edits are deliberately soft: they ride the next natural HARD
		// fold. Reuse the persisted hash for the cache decision so defer passes do
		// not synchronously read and fingerprint docs they cannot materialize.
		meta.cachedM0ProjectDocsHash ?? undefined,
	);
	if (!meta.cachedM0Bytes) return { value: true, reason: "first_render" };
	if (!meta.cachedM1Bytes) return { value: true, reason: "cached_m1_missing" };
	// Keep invalid cached baselines on the guarded materialize path. The
	// cache_invalid branch below does not have its own contention fallback, so
	// detecting missing required markers / empty decoded bytes here prevents a
	// lease-contention false negative from dropping m[0]/m[1] entirely.
	if (!decodeCachedM0(meta.cachedM0Bytes)) {
		return { value: true, reason: "cache_invalid" };
	}
	const cached = getCachedMarkers(db, state, currentCompartments);
	if (cached === null) {
		return { value: true, reason: "cache_invalid" };
	}
	// A renderer-format change must fold cached m[0] exactly once. The fold
	// persists this component with the rendered bytes, consuming the trigger.
	if (cached.compartmentRenderEpoch !== current.compartmentRenderEpoch) {
		return piMaterializeMismatch(
			"compartment_render_epoch",
			"compartmentRenderEpoch",
			cached.compartmentRenderEpoch,
			current.compartmentRenderEpoch,
		);
	}
	if (cached.muralEnabled !== current.muralEnabled) {
		return piMaterializeMismatch(
			"render_config",
			"muralEnabled",
			cached.muralEnabled,
			current.muralEnabled,
		);
	}
	if (cached.renderBudgetIdentity !== current.renderBudgetIdentity) {
		return piMaterializeMismatch(
			"render_config",
			"renderBudgetIdentity",
			cached.renderBudgetIdentity,
			current.renderBudgetIdentity,
		);
	}
	// ── HARD: provider-side cache eviction (the cache was already dead) ──
	// Parity with OpenCode mustMaterialize. An empty current signal means
	// "unknown this pass" and is never treated as a change. Pi never produces a
	// toolSetHash (no tool.definition hook), so that branch is effectively inert
	// on Pi — kept for structural parity. See PARITY.md.
	const hard = state.hardSignals ?? EMPTY_PI_HARD_SIGNALS;
	const canonicalHardModelKey = piModelRefToCanonical(hard.modelKey);
	const canonicalCachedModelKey = piModelRefToCanonical(
		meta.cachedM0ModelKey ?? "",
	);
	if (
		canonicalHardModelKey !== "" &&
		canonicalHardModelKey !== canonicalCachedModelKey
	) {
		return piMaterializeMismatch(
			"model_change",
			"modelKey",
			canonicalCachedModelKey,
			canonicalHardModelKey,
		);
	}
	if (
		hard.systemHash !== "" &&
		hard.systemHash !== (meta.cachedM0SystemHash ?? "")
	) {
		return piMaterializeMismatch(
			"system_hash",
			"systemHash",
			meta.cachedM0SystemHash ?? "",
			hard.systemHash,
		);
	}
	// Pi can switch projects within the same session (`/cd`). Legacy cached rows
	// have a NULL marker: treat that as unknown/MATCH for lazy adoption so the
	// first post-upgrade no-switch pass does not HARD-fold existing sessions.
	if (
		meta.cachedM0ProjectIdentity !== null &&
		meta.cachedM0ProjectIdentity !== state.projectIdentity
	) {
		return piMaterializeMismatch(
			"project_change",
			"projectIdentity",
			meta.cachedM0ProjectIdentity,
			state.projectIdentity,
		);
	}
	// Idle > TTL: self-consuming guard via cachedM0MaterializedAt (parity with
	// OpenCode). cacheExpired stays true every pass until lastResponseTime
	// updates, so fold only when the last response is newer than the last
	// materialization; the fold sets materializedAt = now, so the rest of the
	// turn skips. Next idle-after-response re-arms.
	if (
		hard.cacheExpired &&
		hard.lastResponseTime > 0 &&
		hard.lastResponseTime > (meta.cachedM0MaterializedAt ?? 0)
	) {
		return piMaterializeMismatch(
			"ttl_idle",
			"lastResponseTimeAfterMaterialization",
			meta.cachedM0MaterializedAt ?? 0,
			hard.lastResponseTime,
		);
	}

	// ── HARD: genuine m[0] CONTENT change ──
	if (cached.upgradeState !== current.upgradeState) {
		return piMaterializeMismatch(
			"renderer_upgrade",
			"upgradeState",
			cached.upgradeState,
			current.upgradeState,
		);
	}
	if (
		current.workspaceFingerprint !== null ||
		(meta.cachedM0WorkspaceFingerprint ?? null) !== null
	) {
		if (
			current.workspaceFingerprint !==
			(meta.cachedM0WorkspaceFingerprint ?? null)
		) {
			return piMaterializeMismatch(
				"project_memory_change",
				"workspaceFingerprint",
				meta.cachedM0WorkspaceFingerprint ?? null,
				current.workspaceFingerprint,
			);
		}
	} else if (
		current.projectMemoryEpoch !== (meta.cachedM0ProjectMemoryEpoch ?? 0)
	) {
		return piMaterializeMismatch(
			"project_memory_change",
			"projectMemoryEpoch",
			meta.cachedM0ProjectMemoryEpoch ?? 0,
			current.projectMemoryEpoch,
		);
	}
	// Use !== (not >), matching OpenCode mustMaterialize: a max-id that DECREASES
	// (revert / message.removed shrinking the compartment or mutation set) must
	// still invalidate m[0]. A '>' comparison would miss a decrease and serve a
	// stale cached baseline.
	if (current.maxMutationId !== (meta.cachedM0MaxMutationId ?? 0)) {
		return piMaterializeMismatch(
			"pending_mutations",
			"maxMutationId",
			meta.cachedM0MaxMutationId ?? 0,
			current.maxMutationId,
		);
	}
	// new_compartment is NOT a trigger (parity with OpenCode — Bug 1 fix): new
	// compartments are an m[1] delta (renderM1Pi readNewCompartments WHERE
	// sequence > cachedM0Seq, normalized via normalizeCachedMaxCompartmentSeq in
	// the render path), folded into m[0] only on a HARD bust.
	// project_user_profile_version is also NOT a trigger: additive user-profile
	// rides the m[1] <new-user-profile> delta.
	// maxMemoryId is deliberately NOT a materialization trigger (parity with
	// OpenCode): new memories are additive and surface in m[1] via the
	// maxMemoryId watermark, so they must not bust the m[0] cache. Memory
	// mutations use cachedM0MaxMemoryMutationId as an m[1] reconcile cursor,
	// not as a materialization trigger; keep it out of this trigger set.
	// projectDocsHash is also NOT a trigger: docs-only edits ride along until a
	// natural HARD fold, which reads fresh docs and persists the hash matching the
	// bytes it rendered.
	// session_facts is retired as a render source (facts = promoted memories),
	// so its version is pinned to 0 and never triggers either.
	return { value: false, reason: null };
}

function renderUserProfileBlock(
	db: ContextDatabase,
	wrapper = "user-profile",
	memoriesOverride?: UserMemory[],
): string {
	const memories = memoriesOverride ?? safeGetActiveUserMemoriesPi(db);
	if (memories.length === 0) return "";
	return `<${wrapper}>\n${memories
		.map((memory) => `- ${escapeXmlContent(memory.content)}`)
		.join("\n")}\n</${wrapper}>`;
}

export function renderM0Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	projectDocs = readProjectDocsForPiM0(state).renderedBlock,
	decayPressureMultiplier = 1,
	// Atomic-snapshot override: when materializeM0Pi reads markers + memories in
	// one transaction, it passes the SAME memory set here so the rendered m[0]
	// can't include a memory whose id is above the persisted maxMemoryId watermark
	// (which would duplicate it across the m[0]/m[1] split). Mirrors OpenCode,
	// where renderM0 takes memories as a parameter rather than re-reading.
	memoriesOverride?: Memory[],
	compartmentsOverride?: PiCompartment[],
	userProfileOverride?: UserMemory[],
	workspaceOverride?: WorkspaceRenderContext,
	/** Optional mural wire options (HARD fold only). When vision-capable, emits
	 *  the `<memory-mural>` marker block; the PNG rides as a separate image part. */
	mural?: { enabled: boolean; supportsVision: boolean; dataUrl?: string },
): string {
	const memPath = memoryProjectPath(state);
	const workspace =
		workspaceOverride ?? resolveWorkspaceRenderContextPi(state, db);
	const allMemories =
		memoriesOverride ??
		(memPath
			? workspace.isWorkspaced
				? getMemoriesByProjects(
						db,
						workspace.expandedIdentities,
						["active", "permanent"],
						Date.now(),
						workspace.ownIdentities,
						workspace.shareCategories,
					)
				: getMemoriesByProject(db, memPath, ["active", "permanent"])
			: []);
	// Use the V2 trim + render helpers (shared with OpenCode) so both harnesses
	// emit the same category-grouped `#id: fact` bytes and use the same
	// permanent-first / importance-DESC selection. A divergent shape here would
	// put different bytes on the wire between OpenCode and Pi.
	// Always trim with the default memory-budget fallback (matching OpenCode),
	// not gated on a truthy injectionBudgetTokens — an unset budget must NOT mean
	// "render every memory untrimmed", which would grow m[0] without bound.
	const memoryRenderOptions: MemoryRenderOptions = {
		sourceNameByMemoryId: sourceNamesForPiMemories({
			memories: allMemories,
			projectPath: memPath,
			workspace,
		}),
	};
	const memories =
		allMemories.length > 0
			? workspace.isWorkspaced
				? trimWorkspaceMemoriesToBudgetV2(
						state.sessionId,
						allMemories,
						state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
						workspace,
						memoryRenderOptions,
					).renderOrder
				: trimMemoriesToBudgetV2(
						state.sessionId,
						allMemories,
						state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
					).renderOrder
			: allMemories;
	const memoryBlock =
		memories.length > 0
			? renderMemoryBlockV2(memories, "project-memory", memoryRenderOptions)
			: undefined;
	// v2: decay-render compartments via the shared module (same validated curve
	// as OpenCode). Facts are NOT rendered (v2 faithful: facts = promoted
	// memories, surfaced via memoryBlock / <project-memory>).
	// The decay-pressure multiplier maps to a proportionally tighter effective
	// budget (lower budget → higher curve pressure → more demotion), keeping the
	// shared decay-curve as the single source of pressure math — same approach as
	// OpenCode renderM0. The materialize loop escalates it when m[0] is over budget.
	const baseHistoryBudget =
		state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
	const decayed = renderDecayedCompartments({
		compartments:
			compartmentsOverride ?? getRenderableCompartmentsPi(db, state),
		// v2: use the HISTORY budget (~60K), not the memory injection budget (~4K).
		// Falling back to the memory budget would over-demote every compartment.
		historyBudgetTokens:
			baseHistoryBudget / Math.max(1, decayPressureMultiplier),
	});
	// Sibling-block layout MUST match OpenCode renderM0 exactly (otherwise the
	// two harnesses put different bytes on the wire for the same state):
	//   <project-docs>   — sibling
	//   <user-profile>   — sibling
	//   <session-history>…decayed COMPARTMENTS ONLY…</session-history>
	//   <project-memory> — sibling
	// The <session-history> wrapper contains ONLY the decayed compartments — it
	// does NOT envelope project-docs / user-profile / project-memory. Sections
	// joined by "\n\n".
	const sections: string[] = [];
	if (projectDocs.length > 0) sections.push(projectDocs);
	// Baseline user-profile MUST be trimmed to budget, matching OpenCode renderM0.
	// Rendering all active user memories untrimmed would put different (larger)
	// bytes on the wire than OpenCode for the same state, and let m[0] grow
	// without bound as the global user-profile accumulates.
	const trimmedProfile = trimUserMemoriesToBudget(
		state.memoryEnabled === false
			? []
			: (userProfileOverride ?? safeGetActiveUserMemoriesPi(db)),
		state.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS,
	);
	const userProfile = renderUserProfileBlock(
		db,
		"user-profile",
		trimmedProfile,
	);
	if (userProfile.length > 0) sections.push(userProfile);
	if (!state.compactionOff) {
		sections.push(
			decayed.length > 0
				? `<session-history>\n${decayed}\n</session-history>`
				: "<session-history></session-history>",
		);
	}
	if (memoryBlock) sections.push(memoryBlock);
	// Sibling layout parity with OpenCode renderM0: mural marker after memories.
	if (mural?.enabled && mural.supportsVision && mural.dataUrl) {
		sections.push(
			"<memory-mural>\nThe project memory mural image follows.\n</memory-mural>",
		);
	}
	return sections.join("\n\n").trim();
}

function renderedMemoryIdsForPi(
	state: PiM0M1State,
	memories: readonly Memory[],
	workspace?: WorkspaceRenderContext,
	db?: ContextDatabase,
): number[] {
	if (memories.length === 0) return [];
	const resolvedWorkspace =
		workspace ?? (db ? resolveWorkspaceRenderContextPi(state, db) : undefined);
	const renderOptions: MemoryRenderOptions = resolvedWorkspace
		? {
				sourceNameByMemoryId: sourceNamesForPiMemories({
					memories,
					projectPath: memoryProjectPath(state),
					workspace: resolvedWorkspace,
				}),
			}
		: {};
	const trimmed = resolvedWorkspace?.isWorkspaced
		? trimWorkspaceMemoriesToBudgetV2(
				state.sessionId,
				[...memories],
				state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
				resolvedWorkspace,
				renderOptions,
			)
		: trimMemoriesToBudgetV2(
				state.sessionId,
				[...memories],
				state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
			);
	return trimmed.renderOrder.map((memory) => memory.id);
}

/** Raised when the m[0] snapshot changed between the read-markers phase and the
 *  persist phase (a concurrent writer — sibling Pi/OpenCode process sharing the
 *  same SQLite DB, or the historian — mutated state mid-materialization). Caught
 *  by the retry wrapper so we never cache m[0] bytes that no longer match the
 *  markers they were rendered from. */
function isTransientSqliteLockError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const { code, message } = error as { code?: unknown; message?: unknown };
	if (typeof code === "string") {
		if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
	}
	if (typeof message === "string") {
		return (
			/database is locked/i.test(message) ||
			/sqlite_(busy|locked)/i.test(message)
		);
	}
	return false;
}

export class PiMaterializeContentionError extends Error {
	constructor(reason: string) {
		super(`pi m[0] materialization contention: ${reason}`);
		this.name = "PiMaterializeContentionError";
	}
}

function readFrozenM0InputsPi(
	state: PiM0M1State,
	db: ContextDatabase,
	docs = readProjectDocsForPiM0(state),
	memoryCutoff?: number,
): FrozenM0Inputs {
	// Read every render source and its corresponding watermark as one short DB
	// transaction. Rendering happens later, but m[0] bytes and m[1] watermarks now
	// share the same frozen compartments/memories/user-profile set; a concurrent
	// writer cannot make m[0] include rows that m[1] still considers "new".
	const memPath = memoryProjectPath(state);
	const read = db.transaction(() => {
		const workspace = resolveWorkspaceRenderContextPi(state, db);
		const compartments = getRenderableCompartmentsPi(db, state);
		const memories = memPath
			? workspace.isWorkspaced
				? getMemoriesByProjects(
						db,
						workspace.expandedIdentities,
						["active", "permanent"],
						memoryCutoff,
						workspace.ownIdentities,
						workspace.shareCategories,
					)
				: getMemoriesByProject(
						db,
						memPath,
						["active", "permanent"],
						memoryCutoff,
					)
			: [];
		const userProfile =
			state.memoryEnabled === false ? [] : safeGetActiveUserMemoriesPi(db);
		const projectState = memPath ? getProjectState(db, memPath) : undefined;
		const globalState = getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH);
		const markers: PiM0SnapshotMarkers = {
			maxCompartmentSeq: compartments.reduce(
				(max, compartment) =>
					compartment.sequence > max ? compartment.sequence : max,
				EMPTY_MAX_COMPARTMENT_SEQ,
			),
			maxMemoryId: memPath
				? workspace.isWorkspaced
					? getMaxMemoryIdForProjects(
							db,
							workspace.expandedIdentities,
							workspace.ownIdentities,
							workspace.shareCategories,
						)
					: getMaxMemoryIdForProjects(db, [memPath])
				: 0,
			maxMutationId: getMaxM0MutationId(db, state.sessionId) ?? 0,
			maxMemoryMutationId: memPath
				? workspace.isWorkspaced
					? (getMaxMemoryMutationIdForProjects(
							db,
							workspace.expandedIdentities,
						) ?? 0)
					: (getMaxMemoryMutationId(db, memPath) ?? 0)
				: 0,
			projectMemoryEpoch: projectState?.projectMemoryEpoch ?? 0,
			workspaceFingerprint: workspace.isWorkspaced
				? computeWorkspaceEpochFingerprint(db, workspace.identities)
				: null,
			projectUserProfileVersion: globalState?.projectUserProfileVersion ?? 0,
			projectDocsHash: docs.canonicalHash,
			sessionFactsVersion: getSessionFactsVersion(db, state.sessionId),
			materializedAt: memoryCutoff ?? Date.now(),
			upgradeState: `${PI_M0_UPGRADE_STATE}:${
				compartments.some((c) => c.legacy === 1) ? "legacy" : "ready"
			}`,
			compartmentRenderEpoch: COMPARTMENT_RENDER_EPOCH,
			lastBaselineEndMessageId: lastBaselineEndMessageId(compartments),
			systemHash: (state.hardSignals ?? EMPTY_PI_HARD_SIGNALS).systemHash,
			modelKey: piModelRefToCanonical(
				(state.hardSignals ?? EMPTY_PI_HARD_SIGNALS).modelKey,
			),
			projectIdentity: state.projectIdentity,
			muralEnabled:
				state.memoryEnabled !== false && state.muralEnabled === true,
			renderBudgetIdentity: renderBudgetIdentityPi(state),
		};
		return { docs, markers, compartments, memories, userProfile, workspace };
	});
	return read();
}

function renderFreshM0PiNonPersisted(
	state: PiM0M1State,
	db: ContextDatabase,
): {
	m0: string;
	snapshotMarkers: PiM0SnapshotMarkers;
	renderedMemoryIds: number[];
} {
	const docs = readProjectDocsForPiM0(state);
	const cachedMaterializedAt =
		getOrCreateSessionMeta(db, state.sessionId).cachedM0MaterializedAt ?? 0;
	const frozen = readFrozenM0InputsPi(state, db, docs, cachedMaterializedAt);
	// CACHE STABILITY: materializedAt feeds the m[1] expiry cutoff. It must be
	// stable across consecutive fallback passes, so reuse the last persisted value
	// (or 0 when no cached baseline exists) rather than live Date.now().
	frozen.markers.materializedAt = cachedMaterializedAt;
	const historyBudget =
		state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
	const memoryBudget =
		state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
	// Fresh fallback is a last-resort HARD-equivalent render: resolve mural once
	// so the non-persisted pair still carries the image when the feature is on.
	const mural = resolveMuralForM0Pi(
		state,
		db,
		frozen.markers.modelKey,
		memoryBudget,
	);
	rememberPiMural(state.sessionId, mural);
	let dpm = 1;
	let m0 = renderM0Pi(
		state,
		db,
		docs.renderedBlock,
		dpm,
		frozen.memories,
		frozen.compartments,
		frozen.userProfile,
		frozen.workspace,
		mural,
	);
	let attempts = 0;
	while (
		historyBudget > 0 &&
		historySliceTokensPi(m0) > historyBudget * 1.05 &&
		attempts < 3
	) {
		dpm *= 1.15;
		m0 = renderM0Pi(
			state,
			db,
			docs.renderedBlock,
			dpm,
			frozen.memories,
			frozen.compartments,
			frozen.userProfile,
			frozen.workspace,
			mural,
		);
		attempts += 1;
	}
	return {
		m0,
		snapshotMarkers: frozen.markers,
		renderedMemoryIds: renderedMemoryIdsForPi(
			state,
			frozen.memories,
			frozen.workspace,
			db,
		),
	};
}

export function materializeM0Pi(
	state: PiM0M1State,
	db: ContextDatabase,
): {
	m0: string;
	m1: string;
	snapshotMarkers: PiM0SnapshotMarkers;
	renderedMemoryIds: number[];
} {
	// Phase 1 (no lock): read markers + render. Rendering can be slow, so we do
	// it OUTSIDE the write lock to keep the BEGIN IMMEDIATE critical section tiny.
	const docs = readProjectDocsForPiM0(state);
	const foldMaterializedAt = Date.now();
	const frozen = readFrozenM0InputsPi(state, db, docs, foldMaterializedAt);
	const snapshotMarkers = frozen.markers;

	const snapshotMemories = frozen.memories;
	const snapshotCompartments = frozen.compartments;
	const snapshotUserProfile = frozen.userProfile;
	const renderedMemoryIds = renderedMemoryIdsForPi(
		state,
		snapshotMemories,
		frozen.workspace,
		db,
	);
	// On-demand mural: runs INSIDE the HARD fold only (not on defers). Explicit
	// test-supplied `state.mural` wins; otherwise resolve from muralEnabled +
	// this fold's model key. Baked-in cachedMuralBySession replays on defer.
	const memoryBudget =
		state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
	const mural = resolveMuralForM0Pi(
		state,
		db,
		snapshotMarkers.modelKey,
		memoryBudget,
	);
	const frozenMuralDataUrl =
		mural?.enabled && mural.supportsVision ? (mural.dataUrl ?? null) : null;
	const frozenMuralHash =
		mural?.enabled && mural.supportsVision ? (mural.contentHash ?? null) : null;
	// Over-budget tightening loop (matches OpenCode materializeM0): if the
	// rendered m[0] exceeds the history budget, escalate the decay pressure and
	// re-render up to 3x so tight budgets demote more aggressively. Without this,
	// Pi would select different (looser) tiers than OpenCode under budget pressure.
	let decayPressureMultiplier = 1;
	let m0 = renderM0Pi(
		state,
		db,
		docs.renderedBlock,
		decayPressureMultiplier,
		snapshotMemories,
		snapshotCompartments,
		snapshotUserProfile,
		frozen.workspace,
		mural,
	);
	const historyBudget =
		state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
	let attempts = 0;
	while (
		historyBudget > 0 &&
		historySliceTokensPi(m0) > historyBudget * 1.05 &&
		attempts < 3
	) {
		decayPressureMultiplier *= 1.15;
		m0 = renderM0Pi(
			state,
			db,
			docs.renderedBlock,
			decayPressureMultiplier,
			snapshotMemories,
			snapshotCompartments,
			snapshotUserProfile,
			frozen.workspace,
			mural,
		);
		attempts += 1;
	}
	const m0Bytes = Buffer.from(m0, "utf8");
	const phase3ProjectDocsHash = readProjectDocsForPiM0(state).canonicalHash;

	// Phase 2 + 3 (locked): re-read markers under BEGIN IMMEDIATE; if anything
	// changed since Phase 1, the rendered bytes are stale — roll back and let the
	// caller retry. m[1] is rendered and persisted INSIDE the same transaction as
	// m[0] so cached_m0_bytes/cached_m1_bytes/markers/memory_block_ids stay paired.
	try {
		db.exec("BEGIN IMMEDIATE");
	} catch (error) {
		if (isTransientSqliteLockError(error)) {
			throw new PiMaterializeContentionError("begin immediate locked");
		}
		throw error;
	}
	try {
		const current = readCurrentMarkers(db, state, phase3ProjectDocsHash);
		// maxMemoryId deliberately EXCLUDED (parity with OpenCode materializeM0):
		// additive memory writes don't bump projectMemoryEpoch and must NOT bust
		// m[0] — they surface in m[1] via the persisted maxMemoryId watermark. The
		// memory-mutation cursor IS included because a materialization pass must
		// reconcile every non-additive memory change up to its persisted cursor.
		const memoryEpochStale =
			current.workspaceFingerprint !== null ||
			snapshotMarkers.workspaceFingerprint !== null
				? current.workspaceFingerprint !== snapshotMarkers.workspaceFingerprint
				: current.projectMemoryEpoch !== snapshotMarkers.projectMemoryEpoch;
		const stale =
			memoryEpochStale ||
			current.projectUserProfileVersion !==
				snapshotMarkers.projectUserProfileVersion ||
			current.maxCompartmentSeq !== snapshotMarkers.maxCompartmentSeq ||
			current.maxMutationId !== snapshotMarkers.maxMutationId ||
			current.maxMemoryMutationId !== snapshotMarkers.maxMemoryMutationId ||
			current.projectIdentity !== snapshotMarkers.projectIdentity ||
			// Inert today (both harnesses pin sessionFactsVersion to 0 — facts are
			// retired in v2), but kept for structural parity with OpenCode
			// materializeM0 so the two stale checks can't silently drift if either
			// harness ever revives the field.
			current.sessionFactsVersion !== snapshotMarkers.sessionFactsVersion ||
			current.upgradeState !== snapshotMarkers.upgradeState;
		if (stale) {
			db.exec("ROLLBACK");
			throw new PiMaterializeContentionError("snapshot changed before persist");
		}
		snapshotMarkers.materializedAt = foldMaterializedAt;

		const m1Render = renderM1PiWithMetadata(
			state,
			db,
			snapshotMarkers,
			renderedMemoryIds,
		);
		const m1Bytes = Buffer.from(m1Render.text, "utf8");

		persistCachedM0(db, state.sessionId, {
			m0Bytes,
			muralDataUrl: frozenMuralDataUrl,
			muralHash: frozenMuralHash,
			projectMemoryEpoch: snapshotMarkers.projectMemoryEpoch,
			workspaceFingerprint: snapshotMarkers.workspaceFingerprint,
			projectUserProfileVersion: snapshotMarkers.projectUserProfileVersion,
			maxCompartmentSeq: snapshotMarkers.maxCompartmentSeq,
			maxMemoryId: snapshotMarkers.maxMemoryId,
			maxMutationId: snapshotMarkers.maxMutationId,
			maxMemoryMutationId: snapshotMarkers.maxMemoryMutationId,
			m1Bytes,
			projectDocsHash: snapshotMarkers.projectDocsHash,
			materializedAt: snapshotMarkers.materializedAt,
			sessionFactsVersion: snapshotMarkers.sessionFactsVersion,
			upgradeState: encodeCachedM0UpgradeIdentity(
				snapshotMarkers.upgradeState,
				snapshotMarkers.compartmentRenderEpoch,
				snapshotMarkers.muralEnabled,
				snapshotMarkers.renderBudgetIdentity,
			),
			systemHash: snapshotMarkers.systemHash,
			modelKey: snapshotMarkers.modelKey,
			projectIdentity: snapshotMarkers.projectIdentity,
		});
		// Persist the rendered-memory identity in the SAME transaction as the m[0]
		// snapshot (parity with OpenCode materializeM0). `memory_block_ids` /
		// `memory_block_count` are otherwise written only by the dead legacy v1
		// path, so they'd stay frozen at the last legacy value — wrong sidebar
		// "Injected" count AND a stale ctx_search hide-already-visible filter after
		// any memory change (e.g. migration delete+reinserts with new ids).
		db.prepare(
			"UPDATE session_meta SET memory_block_count = ?, memory_block_ids = ? WHERE session_id = ?",
		).run(
			renderedMemoryIds.length,
			JSON.stringify(renderedMemoryIds),
			state.sessionId,
		);

		// Persist the frozen trim boundary INSIDE the materialize transaction,
		// BEFORE COMMIT. If written after COMMIT, a crash in the window leaves a
		// fresh m[0]/maxCompartmentSeq paired with a stale (or null) boundary, so
		// the next pass trims against the wrong point (under/over-trim). Atomic
		// with the m[0] bytes + markers + m[1] bytes is the only correct placement.
		setCachedBoundary(
			db,
			state.sessionId,
			snapshotMarkers.lastBaselineEndMessageId,
		);

		db.exec("COMMIT");
		rememberPiMuralPayload(
			state.sessionId,
			frozenMuralDataUrl,
			frozenMuralHash,
		);
		return {
			m0,
			m1: m1Render.text,
			snapshotMarkers,
			renderedMemoryIds,
		};
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// already rolled back
		}
		throw error;
	}
}

/** Retry materializeM0Pi on contention (parity with OpenCode materializeWithRetry). */
export function materializeM0PiWithRetry(
	state: PiM0M1State,
	db: ContextDatabase,
	maxRetries = 3,
): {
	m0: string;
	m1: string;
	snapshotMarkers: PiM0SnapshotMarkers;
	renderedMemoryIds: number[];
} {
	let lastError: PiMaterializeContentionError | null = null;
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			return materializeM0Pi(state, db);
		} catch (error) {
			if (!(error instanceof PiMaterializeContentionError)) throw error;
			lastError = error;
		}
	}
	throw (
		lastError ??
		new PiMaterializeContentionError("materialization contention exhausted")
	);
}

function renderMemoryUpdatesBlockPi(args: {
	db: ContextDatabase;
	projectPath: string;
	workspace: WorkspaceRenderContext;
	afterId: number;
	renderedMemoryIds: readonly number[];
	eligibleMemoryIds: ReadonlySet<number>;
}): { block: string; count: number; forcedMemoryIds: number[] } {
	const renderedIds = new Set(args.renderedMemoryIds);
	const mutations = args.workspace.isWorkspaced
		? getMemoryMutationsForRenderByProjects(
				args.db,
				args.workspace.expandedIdentities,
				args.afterId,
				args.renderedMemoryIds,
			)
		: getMemoryMutationsForRender(
				args.db,
				args.projectPath,
				args.afterId,
				args.renderedMemoryIds,
			);
	if (mutations.length === 0) {
		return { block: "", count: 0, forcedMemoryIds: [] };
	}

	const forcedIds = new Set<number>();
	const lines = [
		"These memories changed since the snapshot below — trust these:",
	];
	for (const mutation of mutations) {
		if (mutation.mutationType === "superseded") {
			const replacementId = mutation.supersededById;
			if (
				replacementId !== null &&
				!renderedIds.has(replacementId) &&
				args.eligibleMemoryIds.has(replacementId)
			) {
				forcedIds.add(replacementId);
			}
			if (!renderedIds.has(mutation.targetMemoryId)) continue;
			if (replacementId !== null && args.eligibleMemoryIds.has(replacementId)) {
				lines.push(
					`  <superseded id="${mutation.targetMemoryId}" by="${replacementId}"/>`,
				);
			} else {
				lines.push(`  <removed id="${mutation.targetMemoryId}"/>`);
			}
			continue;
		}

		if (!renderedIds.has(mutation.targetMemoryId)) {
			if (
				mutation.visibilityChanged &&
				args.eligibleMemoryIds.has(mutation.targetMemoryId)
			) {
				forcedIds.add(mutation.targetMemoryId);
			}
			continue;
		}
		if (!args.eligibleMemoryIds.has(mutation.targetMemoryId)) {
			lines.push(`  <removed id="${mutation.targetMemoryId}"/>`);
			continue;
		}
		if (mutation.visibilityChanged && mutation.newContent === null) continue;
		if (mutation.mutationType === "update") {
			lines.push(
				`  <updated id="${mutation.targetMemoryId}">${escapeXmlContent(mutation.newContent ?? "")}</updated>`,
			);
			continue;
		}
		lines.push(`  <removed id="${mutation.targetMemoryId}"/>`);
	}

	const forcedMemoryIds = [...forcedIds]
		.sort((left, right) => left - right)
		.slice(0, MAX_FORCED_MEMORIES_PER_DELTA);
	if (lines.length === 1) return { block: "", count: 0, forcedMemoryIds };
	return {
		block: `<memory-updates>\n${lines.join("\n")}\n</memory-updates>`,
		count: lines.length - 1,
		forcedMemoryIds,
	};
}

interface RenderM1PiResult {
	text: string;
	memoryUpdateCount: number;
}

function renderM1PiWithMetadata(
	state: PiM0M1State,
	db: ContextDatabase,
	markers: PiM0SnapshotMarkers,
	renderedMemoryIds: readonly number[],
	// The compartment set the CALLER will use to advance the persisted trim
	// boundary. When provided, the new-compartments filter renders from this
	// exact set instead of a fresh live read — so a compartment can never be
	// rendered into m[1] while the boundary advances from a different (older)
	// snapshot, which would leave its raw messages in the tail too (duplication).
	// Omitted by callers that don't advance the boundary (e.g. renderM1Pi probe).
	compartmentsOverride?: readonly PiCompartment[],
): RenderM1PiResult {
	const sections: string[] = [];
	const workspace = resolveWorkspaceRenderContextPi(state, db);

	const memPath = memoryProjectPath(state);
	const eligibleMemories = memPath
		? workspace.isWorkspaced
			? getMemoriesByProjects(
					db,
					workspace.expandedIdentities,
					["active", "permanent"],
					markers.materializedAt,
					workspace.ownIdentities,
					workspace.shareCategories,
				)
			: getMemoriesByProject(
					db,
					memPath,
					["active", "permanent"],
					markers.materializedAt,
				)
		: [];
	const eligibleMemoryIds = new Set(
		eligibleMemories.map((memory) => memory.id),
	);
	const memoryUpdates = memPath
		? renderMemoryUpdatesBlockPi({
				db,
				projectPath: memPath,
				workspace,
				afterId: markers.maxMemoryMutationId,
				renderedMemoryIds,
				eligibleMemoryIds,
			})
		: { block: undefined as string | undefined, count: 0, forcedMemoryIds: [] };
	if (memoryUpdates.block) sections.push(memoryUpdates.block);

	const newCompartments = (
		compartmentsOverride ?? getRenderableCompartmentsPi(db, state)
	).filter((compartment) => compartment.sequence > markers.maxCompartmentSeq);
	if (newCompartments.length > 0) {
		// New compartments are newest deltas → always render at P1 (full fidelity).
		const body = newCompartments
			.map((compartment) => renderCompartmentAtTier(compartment, 1))
			.join("\n\n");
		sections.push(`<new-compartments>\n${body}\n</new-compartments>`);
	}

	const forcedMemoryIds = new Set(memoryUpdates.forcedMemoryIds);
	const newMemories = eligibleMemories.filter(
		(memory) =>
			memory.id > markers.maxMemoryId && !forcedMemoryIds.has(memory.id),
	);
	// Trim ordinary new memories to 25% of the budget, but always include eligible
	// memories referenced by a supersede operation. Such a replacement may have an
	// ID at or below the first marker's maximum while still not appearing in the
	// memories already rendered.
	const memoryBudget =
		state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
	const memoryRenderOptions: MemoryRenderOptions = {
		sourceNameByMemoryId: sourceNamesForPiMemories({
			memories: eligibleMemories,
			projectPath: memPath,
			workspace,
		}),
	};
	const trimmedNewMemories = trimMemoriesToBudgetV2(
		state.sessionId,
		newMemories,
		Math.max(1, Math.floor(memoryBudget * 0.25)),
		memoryRenderOptions,
	).renderOrder;
	const deltaMemories = [
		...trimmedNewMemories,
		...eligibleMemories.filter((memory) => forcedMemoryIds.has(memory.id)),
	];
	const newMemoriesBlock = renderMemoryBlockV2(
		deltaMemories,
		"new-memories",
		memoryRenderOptions,
	);
	if (newMemoriesBlock) sections.push(newMemoriesBlock);

	// new-user-profile delta: when the global user-profile version advanced since
	// this m[0] baseline was materialized, surface the current profile under a
	// <new-user-profile> wrapper so freshly promoted user memories reach the agent
	// in m[1] before the next m[0] materialization folds them into the baseline.
	// Trimmed to 25% of the user-profile budget (matches OpenCode renderM1).
	const currentUserProfileVersion =
		getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH)
			?.projectUserProfileVersion ?? 0;
	if (
		state.memoryEnabled !== false &&
		currentUserProfileVersion !== markers.projectUserProfileVersion
	) {
		const profileBudget =
			state.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS;
		const trimmedProfile = trimUserMemoriesToBudget(
			safeGetActiveUserMemoriesPi(db),
			Math.max(1, Math.floor(profileBudget * 0.25)),
		);
		const profileBlock = renderUserProfileBlock(
			db,
			"new-user-profile",
			trimmedProfile,
		);
		if (profileBlock) sections.push(profileBlock);
	}

	if (sections.length === 0) {
		return {
			text: PI_M1_PLACEHOLDER,
			memoryUpdateCount: memoryUpdates.count,
		};
	}
	// Join with "\n" (single newline) to match OpenCode renderM1 exactly — the
	// m[1] delta bytes must be identical across harnesses.
	return {
		text: state.compactionOff
			? `<knowledge-updates>\n${sections.join("\n")}\n</knowledge-updates>`
			: `<session-history-since>\n${sections.join("\n")}\n</session-history-since>`,
		memoryUpdateCount: memoryUpdates.count,
	};
}

export function renderM1Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	markers: PiM0SnapshotMarkers,
	renderedMemoryIds: readonly number[] = [],
): string {
	return renderM1PiWithMetadata(state, db, markers, renderedMemoryIds).text;
}

interface CachedPiM0M1Row {
	cached_m0_bytes: Buffer | Uint8Array | null;
	cached_m0_mural_data_url: string | null;
	cached_m0_mural_hash: string | null;
	cached_m1_bytes: Buffer | Uint8Array | null;
	cached_m0_project_memory_epoch: number | null;
	cached_m0_workspace_fingerprint: string | null;
	cached_m0_project_user_profile_version: number | null;
	cached_m0_max_compartment_seq: number | null;
	cached_m0_max_memory_id: number | null;
	cached_m0_max_mutation_id: number | null;
	cached_m0_max_memory_mutation_id: number | null;
	cached_m0_project_docs_hash: string | null;
	cached_m0_materialized_at: number | null;
	cached_m0_session_facts_version: number | null;
	cached_m0_upgrade_state: string | null;
	cached_m0_system_hash: string | null;
	cached_m0_model_key: string | null;
	cached_m0_project_identity: string | null;
	cached_m0_last_baseline_end_message_id: string | null;
	memory_block_ids: string | null;
}

function toCachedBuffer(value: Buffer | Uint8Array): Buffer {
	return Buffer.isBuffer(value)
		? value
		: Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function bufferEqualsNullable(
	left: Buffer | Uint8Array | null,
	right: Buffer | Uint8Array | null,
): boolean {
	if (left === null || right === null) return left === right;
	return toCachedBuffer(left).equals(toCachedBuffer(right));
}

function parseMemoryBlockIds(raw: string | null): number[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((value): value is number => typeof value === "number");
	} catch {
		return [];
	}
}

function readCachedPiM0M1Row(
	db: ContextDatabase,
	sessionId: string,
): CachedPiM0M1Row | null {
	return db
		.prepare(
			`SELECT cached_m0_bytes, cached_m0_mural_data_url,
					cached_m0_mural_hash, cached_m1_bytes,
					cached_m0_project_memory_epoch,
					cached_m0_workspace_fingerprint,
					cached_m0_project_user_profile_version,
					cached_m0_max_compartment_seq,
					cached_m0_max_memory_id,
					cached_m0_max_mutation_id,
					cached_m0_max_memory_mutation_id,
					cached_m0_project_docs_hash,
					cached_m0_materialized_at,
					cached_m0_session_facts_version,
					cached_m0_upgrade_state,
					cached_m0_system_hash,
					cached_m0_model_key,
					cached_m0_project_identity,
					cached_m0_last_baseline_end_message_id,
					memory_block_ids
			   FROM session_meta
			  WHERE session_id = ?`,
		)
		.get(sessionId) as CachedPiM0M1Row | null;
}

function markersFromCachedPiRow(
	row: CachedPiM0M1Row,
	compartmentsForNormalization: readonly PiCompartment[],
): PiM0SnapshotMarkers | null {
	if (!row.cached_m0_bytes) return null;
	const cachedUpgradeIdentity = decodeCachedM0UpgradeIdentity(
		row.cached_m0_upgrade_state,
	);
	if (row.cached_m0_project_memory_epoch === null) return null;
	if (row.cached_m0_project_user_profile_version === null) return null;
	if (row.cached_m0_max_compartment_seq === null) return null;
	if (row.cached_m0_max_memory_id === null) return null;
	if (row.cached_m0_max_mutation_id === null) return null;
	if (row.cached_m0_max_memory_mutation_id === null) return null;
	if (row.cached_m0_session_facts_version === null) return null;
	if (row.cached_m0_materialized_at === null) return null;
	if (row.cached_m0_upgrade_state === null) return null;
	return {
		maxCompartmentSeq: normalizeCachedMaxCompartmentSeq(
			row.cached_m0_max_compartment_seq,
			compartmentsForNormalization,
		),
		maxMemoryId: row.cached_m0_max_memory_id,
		maxMutationId: row.cached_m0_max_mutation_id,
		maxMemoryMutationId: row.cached_m0_max_memory_mutation_id,
		projectMemoryEpoch: row.cached_m0_project_memory_epoch,
		workspaceFingerprint: row.cached_m0_workspace_fingerprint,
		projectUserProfileVersion: row.cached_m0_project_user_profile_version,
		projectDocsHash: row.cached_m0_project_docs_hash ?? "",
		materializedAt: row.cached_m0_materialized_at,
		sessionFactsVersion: row.cached_m0_session_facts_version,
		upgradeState: cachedUpgradeIdentity.upgradeState ?? "",
		compartmentRenderEpoch: cachedUpgradeIdentity.compartmentRenderEpoch,
		lastBaselineEndMessageId:
			typeof row.cached_m0_last_baseline_end_message_id === "string" &&
			row.cached_m0_last_baseline_end_message_id.length > 0
				? row.cached_m0_last_baseline_end_message_id
				: null,
		systemHash: row.cached_m0_system_hash ?? "",
		modelKey: row.cached_m0_model_key ?? "",
		projectIdentity: row.cached_m0_project_identity ?? null,
		muralEnabled: cachedUpgradeIdentity.muralEnabled ?? false,
		renderBudgetIdentity: cachedUpgradeIdentity.renderBudgetIdentity ?? "",
	};
}

function cachedPiRowMatchesSnapshot(args: {
	row: CachedPiM0M1Row;
	m0Bytes: Buffer;
	markers: PiM0SnapshotMarkers;
	compartmentsForNormalization: readonly PiCompartment[];
}): boolean {
	const rowMarkers = markersFromCachedPiRow(
		args.row,
		args.compartmentsForNormalization,
	);
	if (!rowMarkers) return false;
	return (
		bufferEqualsNullable(args.row.cached_m0_bytes, args.m0Bytes) &&
		rowMarkers.projectMemoryEpoch === args.markers.projectMemoryEpoch &&
		rowMarkers.projectUserProfileVersion ===
			args.markers.projectUserProfileVersion &&
		rowMarkers.maxCompartmentSeq === args.markers.maxCompartmentSeq &&
		rowMarkers.maxMemoryId === args.markers.maxMemoryId &&
		rowMarkers.maxMutationId === args.markers.maxMutationId &&
		rowMarkers.maxMemoryMutationId === args.markers.maxMemoryMutationId &&
		// Project-docs hash is inert for CAS decisions: byte-different m[0] rows
		// fail the buffer compare above, while hash-only drift with identical bytes
		// must still refresh m[1] against the current cached prefix.
		rowMarkers.materializedAt === args.markers.materializedAt &&
		rowMarkers.sessionFactsVersion === args.markers.sessionFactsVersion &&
		(rowMarkers.upgradeState ?? null) === (args.markers.upgradeState ?? null) &&
		rowMarkers.compartmentRenderEpoch === args.markers.compartmentRenderEpoch &&
		// HARD-bust markers (parity with OpenCode cachedRowMatchesState): a sibling
		// that re-materialized under a new system/tool/model identity must invalidate
		// this process's cached row so the soft-refresh CAS adopts the sibling's m[0].
		(rowMarkers.systemHash ?? "") === (args.markers.systemHash ?? "") &&
		piModelRefToCanonical(rowMarkers.modelKey ?? "") ===
			piModelRefToCanonical(args.markers.modelKey ?? "") &&
		(rowMarkers.projectIdentity ?? null) ===
			(args.markers.projectIdentity ?? null) &&
		// Workspace fingerprint (parity with OpenCode cachedRowMatchesState):
		// projectMemoryEpoch above only tracks THIS session's own project, but a
		// FOREIGN member's epoch bump changes the workspace fingerprint without
		// touching this session's epoch. Without this compare, a sibling row
		// materialized under different workspace membership would pass the CAS and
		// be adopted with the wrong union baseline.
		(rowMarkers.workspaceFingerprint ?? null) ===
			(args.markers.workspaceFingerprint ?? null)
	);
}

function adoptCachedPiProjectIdentity(
	db: ContextDatabase,
	state: PiM0M1State,
): void {
	db.prepare(
		"UPDATE session_meta SET cached_m0_project_identity = ? WHERE session_id = ? AND cached_m0_project_identity IS NULL",
	).run(state.projectIdentity, state.sessionId);
}

function decodeCachedM1(row: CachedPiM0M1Row, sessionId: string): string {
	if (!row.cached_m1_bytes) {
		throw new PiMaterializeContentionError(
			`missing cached m[1] for ${sessionId}`,
		);
	}
	return decodeCachedM0(row.cached_m1_bytes) ?? PI_M1_PLACEHOLDER;
}

function applyCachedPiRow(args: {
	row: CachedPiM0M1Row;
	state: PiM0M1State;
	compartmentsForNormalization: readonly PiCompartment[];
}): { m0: string; m1: string; markers: PiM0SnapshotMarkers } {
	const markers = markersFromCachedPiRow(
		args.row,
		args.compartmentsForNormalization,
	);
	const m0 = decodeCachedM0(args.row.cached_m0_bytes);
	if (!m0 || !markers || !args.row.cached_m1_bytes) {
		throw new PiMaterializeContentionError(
			`invalid cached m[0]/m[1] for ${args.state.sessionId}`,
		);
	}
	rememberPiMuralPayload(
		args.state.sessionId,
		args.row.cached_m0_mural_data_url,
		args.row.cached_m0_mural_hash,
	);
	return {
		m0,
		m1: decodeCachedM1(args.row, args.state.sessionId),
		markers,
	};
}

function replayCachedM1Pi(
	db: ContextDatabase,
	state: PiM0M1State,
	compartmentsForNormalization: readonly PiCompartment[],
): { m0: string; m1: string; markers: PiM0SnapshotMarkers } {
	const row = readCachedPiM0M1Row(db, state.sessionId);
	if (!row) {
		throw new PiMaterializeContentionError(
			`missing cached m[0]/m[1] for ${state.sessionId}`,
		);
	}
	return applyCachedPiRow({ row, state, compartmentsForNormalization });
}

function softRefreshCachedM1Pi(args: {
	state: PiM0M1State;
	db: ContextDatabase;
	m0Bytes: Buffer;
	markers: PiM0SnapshotMarkers;
	compartmentsForNormalization: readonly PiCompartment[];
}): {
	m0: string;
	m1: string;
	markers: PiM0SnapshotMarkers;
	memoryUpdateCount: number;
	recomputed: boolean;
} {
	args.db.exec("BEGIN IMMEDIATE");
	try {
		const row = readCachedPiM0M1Row(args.db, args.state.sessionId);
		if (
			!row ||
			!cachedPiRowMatchesSnapshot({
				row,
				m0Bytes: args.m0Bytes,
				markers: args.markers,
				compartmentsForNormalization: args.compartmentsForNormalization,
			})
		) {
			args.db.exec("ROLLBACK");
			const sibling = readCachedPiM0M1Row(args.db, args.state.sessionId);
			if (!sibling) {
				throw new PiMaterializeContentionError(
					`missing sibling cached m[0]/m[1] for ${args.state.sessionId}`,
				);
			}
			const siblingCompartments = getRenderableCompartmentsPi(
				args.db,
				args.state,
			);
			return {
				...applyCachedPiRow({
					row: sibling,
					state: args.state,
					compartmentsForNormalization: siblingCompartments,
				}),
				memoryUpdateCount: 0,
				recomputed: false,
			};
		}

		const markers = markersFromCachedPiRow(
			row,
			args.compartmentsForNormalization,
		);
		if (!markers) {
			throw new PiMaterializeContentionError(
				`invalid cached m[0] markers for ${args.state.sessionId}`,
			);
		}
		const rendered = renderM1PiWithMetadata(
			args.state,
			args.db,
			markers,
			parseMemoryBlockIds(row.memory_block_ids),
			// Render new compartments from the SAME snapshot the boundary advances
			// from below, so a concurrent sibling publish can't put a compartment
			// in m[1] while its raw messages stay in the tail.
			args.compartmentsForNormalization,
		);
		const m1Bytes = Buffer.from(rendered.text, "utf8");
		// Advance the persisted trim boundary to the latest compartment now rendered
		// in m[1]. renderM1 covers compartments seq > cachedM0Seq up to the current
		// latest, so the visible-message trim must move with it — otherwise the newly
		// summarized compartment's raw messages stay in the tail (duplication) on
		// this and every subsequent replay pass. Persisted in the SAME transaction as
		// cached_m1_bytes so replay passes (which read the boundary from this row)
		// trim consistently. Mirrors OpenCode caching prepared.compartmentEndMessageId
		// on each cache-busting pass. Boundary is NOT part of the m[0] CAS identity
		// (cachedPiRowMatchesSnapshot excludes it), so advancing it cannot spuriously
		// invalidate a sibling's cached m[0].
		const latestCompartment = args.compartmentsForNormalization.at(-1);
		const advancedBoundary =
			latestCompartment?.endMessageId &&
			latestCompartment.endMessageId.length > 0
				? latestCompartment.endMessageId
				: markers.lastBaselineEndMessageId;
		args.db
			.prepare(
				"UPDATE session_meta SET cached_m1_bytes = ?, cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
			)
			.run(m1Bytes, advancedBoundary, args.state.sessionId);
		args.db.exec("COMMIT");
		return {
			m0: decodeCachedM0(row.cached_m0_bytes) ?? "",
			m1: rendered.text,
			markers: { ...markers, lastBaselineEndMessageId: advancedBoundary },
			memoryUpdateCount: rendered.memoryUpdateCount,
			recomputed: true,
		};
	} catch (error) {
		try {
			args.db.exec("ROLLBACK");
		} catch {
			// already rolled back
		}
		throw error;
	}
}

function findCompartmentBoundaryForSnapshot(
	markers: PiM0SnapshotMarkers,
): string | null {
	if (markers.maxCompartmentSeq < 0) return null;
	return markers.lastBaselineEndMessageId;
}

function resolveRenderedCompartmentBoundary(
	compartments: readonly PiCompartment[],
	boundaryId: string | null,
): PiRenderedCompartmentBoundary {
	if (!boundaryId) return { endMessageId: null, ordinal: null };
	const boundary = compartments.find(
		(compartment) => compartment.endMessageId === boundaryId,
	);
	return {
		endMessageId: boundaryId,
		ordinal:
			typeof boundary?.endMessage === "number" ? boundary.endMessage : null,
	};
}

function prependM0M1Messages(
	piMessages: PiAgentMessage[],
	m0: string,
	m1: string,
	mural?: { enabled: boolean; supportsVision: boolean; dataUrl?: string },
): void {
	const firstTimestamp = piMessages[0]?.timestamp;
	const baseTimestamp =
		typeof firstTimestamp === "number" ? firstTimestamp : Date.now();
	// Pi's native image part is `{ type: "image", data: base64, mimeType }` —
	// serializers rebuild `data:…;base64,…` for providers. OpenCode uses a
	// file-part with a data URL; same PNG bytes, different envelope.
	const muralImage =
		mural?.enabled && mural.supportsVision && mural.dataUrl
			? piImageFromDataUrl(mural.dataUrl)
			: null;
	const m0Content: (PiTextContent | PiImageContent)[] = [
		{ type: "text", text: m0 },
		...(muralImage ? [muralImage] : []),
	];
	piMessages.unshift(
		{
			role: "user",
			content: m0Content,
			timestamp: baseTimestamp - 2,
		},
		{
			role: "user",
			content: [{ type: "text", text: m1 }],
			timestamp: baseTimestamp - 1,
		},
	);
}

export function injectM0M1Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	piMessages: PiAgentMessage[],
	entryIds?: readonly (string | undefined)[],
	recomputeM1ThisPass = false,
): PiM0M1InjectionResult {
	// One compartment snapshot for the WHOLE decision: the materialize decision
	// and every cached-marker reload below normalize against this same set, so a
	// concurrent count change can't flip markers to null mid-decision and escape
	// the guarded fallback (TOCTOU).
	const currentCompartments = getRenderableCompartmentsPi(db, state);
	let decision = mustMaterializePi(state, db, currentCompartments);
	if (decision.value) {
		const mismatch = decision.mismatch
			? ` mismatch=${JSON.stringify(decision.mismatch)}`
			: "";
		logSession(
			state.sessionId,
			`pi m[0] HARD fold firing: reason=${decision.reason ?? "unknown"}${mismatch}`,
		);
	}
	let m0 = "";
	let m1 = PI_M1_PLACEHOLDER;
	let markers: PiM0SnapshotMarkers | null = null;
	let materialized = false;
	let contentionExhausted = false;
	let memoryUpdateCount = 0;
	let m1Recomputed = false;
	let freshFallbackRenderedMemoryIds: number[] | null = null;

	if (decision.value) {
		// On contention exhaustion, reuse the cached m[0]/m[1] pair rather than
		// throwing (matches OpenCode injectM0M1). A sibling process mutated state
		// mid-materialization; serving the slightly-stale cached pair this pass is
		// correct and the next pass retries — dropping injection entirely would lose
		// the whole history block.
		try {
			const result = materializeM0PiWithRetry(state, db);
			m0 = result.m0;
			m1 = result.m1;
			markers = result.snapshotMarkers;
			materialized = true;
			m1Recomputed = true;
		} catch (error) {
			if (!(error instanceof PiMaterializeContentionError)) throw error;
			try {
				const cached = replayCachedM1Pi(db, state, currentCompartments);
				contentionExhausted = true;
				m0 = cached.m0;
				m1 = cached.m1;
				markers = cached.markers;
				logSession(
					state.sessionId,
					"pi m[0] materialization contention exhausted; reusing cached m[0]/m[1]",
				);
			} catch {
				// No cached baseline to fall back to — this happens when the cache was
				// deliberately cleared THIS pass (cache-bust) and then hit contention.
				// Dropping injection would lose the entire history block, so render a
				// fresh (non-persisted) m[0]/m[1] pair as a last resort. It is not cached
				// because we couldn't win the materialize lock; the next pass
				// re-materializes and persists.
				const fresh = renderFreshM0PiNonPersisted(state, db);
				m0 = fresh.m0;
				markers = fresh.snapshotMarkers;
				freshFallbackRenderedMemoryIds = fresh.renderedMemoryIds;
				contentionExhausted = true;
				logSession(
					state.sessionId,
					"pi m[0] materialization contention exhausted with no cached fallback; rendered fresh non-persisted m[0]/m[1]",
				);
			}
		}
	} else {
		const meta = getOrCreateSessionMeta(db, state.sessionId);
		m0 = decodeCachedM0(meta.cachedM0Bytes) ?? "";
		rememberPiMuralPayload(
			state.sessionId,
			meta.cachedM0MuralDataUrl,
			meta.cachedM0MuralHash,
		);
		markers = getCachedMarkers(db, state, currentCompartments);
		if (!m0 || !markers) {
			decision = { value: true, reason: "cache_invalid" };
			try {
				const result = materializeM0PiWithRetry(state, db);
				m0 = result.m0;
				m1 = result.m1;
				markers = result.snapshotMarkers;
				materialized = true;
				m1Recomputed = true;
			} catch (error) {
				if (!(error instanceof PiMaterializeContentionError)) throw error;
				// Cache was already invalid (no usable cached m[0]/markers to reuse) AND
				// we lost the materialize lock to a sibling process. Dropping injection
				// would lose the whole history block, so render a fresh non-persisted
				// m[0]/m[1] as a last resort — the next pass re-materializes and persists.
				const fresh = renderFreshM0PiNonPersisted(state, db);
				m0 = fresh.m0;
				markers = fresh.snapshotMarkers;
				freshFallbackRenderedMemoryIds = fresh.renderedMemoryIds;
				contentionExhausted = true;
				logSession(
					state.sessionId,
					"pi m[0] cache_invalid materialization contention exhausted; rendered fresh non-persisted m[0]/m[1]",
				);
			}
		}
	}

	if (!markers) {
		throw new PiMaterializeContentionError(
			`missing m[0] markers for ${state.sessionId}`,
		);
	}
	if (!materialized && markers.projectIdentity === null) {
		adoptCachedPiProjectIdentity(db, state);
		markers = { ...markers, projectIdentity: state.projectIdentity };
	}

	if (materialized) {
		// m[1] was rendered and persisted atomically inside materializeM0Pi.
	} else if (contentionExhausted && freshFallbackRenderedMemoryIds) {
		const freshM1 = renderM1PiWithMetadata(
			state,
			db,
			markers,
			freshFallbackRenderedMemoryIds,
		);
		m1 = freshM1.text;
		memoryUpdateCount = freshM1.memoryUpdateCount;
		m1Recomputed = true;
	} else if (contentionExhausted) {
		// m[1] was replayed with the cached m[0] pair above.
	} else if (recomputeM1ThisPass) {
		const refreshed = softRefreshCachedM1Pi({
			state,
			db,
			m0Bytes: Buffer.from(m0, "utf8"),
			markers,
			compartmentsForNormalization: currentCompartments,
		});
		m0 = refreshed.m0;
		m1 = refreshed.m1;
		markers = refreshed.markers;
		memoryUpdateCount = refreshed.memoryUpdateCount;
		m1Recomputed = refreshed.recomputed;
	} else {
		const replayed = replayCachedM1Pi(db, state, currentCompartments);
		m0 = replayed.m0;
		m1 = replayed.m1;
		markers = replayed.markers;
	}

	// Pressure backstop refold (parity with OpenCode) — only on Pi's cache-busting
	// recompute gate (`executedWorkThisPass`) where m[1] was freshly recomputed;
	// defer passes replay persisted bytes and must never live-read/refold. Three
	// independent triggers (any one folds):
	//   1. memoryUpdateCount > 40 — supersede-delta drift (size-independent).
	//   2. m[1]/m[0] SIZE RATIO — gated by M0_DRIFT_RATIO_FLOOR so a tiny early
	//      m[0] doesn't make 15% trivially exceeded and refold every pass.
	//   3. m[1] ABSOLUTE CAP — when m[0] is small the ratio test is suppressed, so
	//      m[1] could otherwise grow unbounded after the new_compartment trigger
	//      was removed. Fold once m[1] exceeds a fixed share of the history budget.
	// Token counts (NOT char lengths) on both sides of the ratio — parity with
	// OpenCode. The documented intent is "m[1] exceeds ~15% of m[0] tokens";
	// char length diverges from token count on XML-heavy / non-Latin content.
	const M0_DRIFT_RATIO_FLOOR_TOKENS = 500;
	const M1_DRIFT_RATIO = 0.15;
	const M1_ABSOLUTE_CAP_RATIO = 0.2;
	const m1AbsoluteBudget =
		(state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS) *
		M1_ABSOLUTE_CAP_RATIO;
	const m1HasContent = m1 !== PI_M1_PLACEHOLDER;
	const { m0Tokens, m1Tokens } = cachedInjectionTokenCounts(
		state.sessionId,
		m0,
		m1,
	);
	const m1OverAbsoluteCap = m1HasContent && m1Tokens > m1AbsoluteBudget;
	if (
		!materialized &&
		!contentionExhausted &&
		m1Recomputed &&
		recomputeM1ThisPass &&
		(memoryUpdateCount > 40 ||
			m1OverAbsoluteCap ||
			(m1HasContent &&
				m0Tokens >= M0_DRIFT_RATIO_FLOOR_TOKENS &&
				m1Tokens > m0Tokens * M1_DRIFT_RATIO))
	) {
		decision = { value: true, reason: "drift" };
		try {
			const result = materializeM0PiWithRetry(state, db);
			m0 = result.m0;
			m1 = result.m1;
			markers = result.snapshotMarkers;
			materialized = true;
		} catch (error) {
			if (!(error instanceof PiMaterializeContentionError)) throw error;
			// Keep the un-refolded m[0]/m[1]; next pass retries the fold.
		}
	}

	const boundaryId = findCompartmentBoundaryForSnapshot(markers);
	const renderedBoundary = resolveRenderedCompartmentBoundary(
		currentCompartments,
		boundaryId,
	);
	// m[1]-side coverage watermark for the deferred-marker drain (liveness
	// fix): fresh publications render their compartment into the m[1] delta —
	// m[0] folds new compartments only on a HARD bust — so the m[0] snapshot
	// boundary above stays behind the pending marker until an unrelated HARD
	// fold. The drain may apply once the marker is covered by a compartment
	// THIS pass actually rendered into m[1]. Derived from the SAME compartment
	// snapshot the m[1] render used (TOCTOU: the drain gate must never
	// re-derive this from live DB rows), and only when m[1] was freshly
	// recomputed this pass without a contention fallback — the sibling-
	// fallback (stale bytes, recomputed=false) and pure-replay branches leave
	// it null so the drain preserves the deferred signal. Compartments at or
	// below markers.maxCompartmentSeq are m[0] content already certified by
	// renderedBoundary; only compartments beyond that watermark are m[1]
	// content, so the latest snapshot compartment qualifies exactly when the
	// m[1] delta carried it.
	let m1RenderedCoverage: PiRenderedCompartmentBoundary | null = null;
	if (m1Recomputed && !contentionExhausted) {
		const latestM1Compartment = currentCompartments.at(-1);
		if (
			latestM1Compartment &&
			latestM1Compartment.sequence > markers.maxCompartmentSeq &&
			latestM1Compartment.endMessageId.length > 0
		) {
			m1RenderedCoverage = {
				endMessageId: latestM1Compartment.endMessageId,
				ordinal:
					typeof latestM1Compartment.endMessage === "number"
						? latestM1Compartment.endMessage
						: null,
			};
		}
	}
	const skippedVisibleMessages = boundaryId
		? trimPiMessagesToBoundary(piMessages, entryIds, boundaryId)
		: 0;
	const muralWire = m0.includes("<memory-mural>")
		? muralForWire(state.sessionId)
		: undefined;
	// A legacy row with no paired payload cannot replay its old image part. Since
	// that omission already changes provider-visible bytes, remove the false text
	// claiming an image follows and keep the fallback internally consistent.
	if (!muralWire) m0 = stripMemoryMuralBlock(m0);
	prependM0M1Messages(piMessages, m0, m1, muralWire);
	logSession(
		state.sessionId,
		`injected m[0]/m[1] into Pi messages (${m0.length} + ${m1.length} bytes, materialized=${materialized}${decision.reason ? ` reason=${decision.reason}` : ""})`,
	);
	const comparison = decision.mismatch;
	const systemHashPrev =
		comparison?.signal === "systemHash" && typeof comparison.cached === "string"
			? comparison.cached
			: null;
	const systemHashNew =
		comparison?.signal === "systemHash" &&
		typeof comparison.current === "string"
			? comparison.current
			: null;
	const m0ModelKeyPrev =
		comparison?.signal === "modelKey" && typeof comparison.cached === "string"
			? comparison.cached
			: null;
	const m0ModelKeyNew =
		comparison?.signal === "modelKey" && typeof comparison.current === "string"
			? comparison.current
			: null;
	const memPath = memoryProjectPath(state);
	const workspace = resolveWorkspaceRenderContextPi(state, db);
	const memoryCount = memPath
		? workspace.isWorkspaced
			? getMemoriesByProjects(
					db,
					workspace.expandedIdentities,
					["active", "permanent"],
					Date.now(),
					workspace.ownIdentities,
					workspace.shareCategories,
				).length
			: getMemoriesByProject(db, memPath, ["active", "permanent"]).length
		: 0;
	return {
		injected: true,
		compartmentCount: currentCompartments.length,
		factCount: 0, // v2: facts retired as a render source (facts = promoted memories)
		memoryCount,
		skippedVisibleMessages,
		m0Materialized: materialized,
		m0Reason: decision.reason,
		systemHashPrev: materialized ? systemHashPrev : null,
		systemHashNew: materialized ? systemHashNew : null,
		m0ModelKeyPrev: materialized ? m0ModelKeyPrev : null,
		m0ModelKeyNew: materialized ? m0ModelKeyNew : null,
		m0Bytes: m0.length,
		m1Bytes: m1.length,
		contentionExhausted,
		renderedBoundary,
		m1RenderedCoverage,
		// prependM0M1Messages always unshifts exactly the m[0] + m[1] pair.
		syntheticLeadingCount: 2,
	};
}

export function clearM0M1PiCache(
	db: ContextDatabase,
	sessionId: string,
	reason: string,
): void {
	clearCachedM0M1(db, sessionId);
	setCachedBoundary(db, sessionId, null);
	cachedMuralBySession.delete(sessionId);
	logSession(sessionId, `cleared cached m[0] (${reason})`);
}

export interface PiInjectionResult {
	injected: boolean;
	compartmentCount: number;
	factCount: number;
	memoryCount: number;
	skippedVisibleMessages: number;
	/** Exact system-hash operands when that comparison caused materialization. */
	systemHashPrev?: string | null;
	systemHashNew?: string | null;
	/** Exact canonical model-key operands when that comparison caused materialization. */
	m0ModelKeyPrev?: string | null;
	m0ModelKeyNew?: string | null;
}
