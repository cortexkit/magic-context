/**
 * Pi-side heuristic cleanup — mirrors OpenCode's `applyHeuristicCleanup`
 * (packages/plugin/src/hooks/magic-context/heuristic-cleanup.ts).
 *
 * Applies emergency reclaim before routine stale-call removal, injection stripping,
 * deduplication, and caveman compression. The Pi-specific pieces are:
 *
 *   - Tool fingerprinting walks Pi `AgentMessage[]` instead of
 *     OpenCode `MessageLike[]`. Pi assistant messages carry tool calls
 *     as parts of type `"toolCall"` with `{ id, name, arguments }`.
 *     OpenCode's `extractToolInfo` checks `"tool" | "tool_use" |
 *     "tool-invocation"` shapes that don't exist in Pi.
 *   - Stale `ctx_reduce` removal also walks Pi shape directly. New discovery is
 *     gated to providers that can safely drop empty sentinels; Pi persists
 *     `tags.status='dropped'` and lets `applyFlushedStatuses` replay existing
 *     drops on every provider, which is the cache-stable mechanism Pi already uses.
 *
 *   - Everything else (tiered emergency reclaim, strip system injections from
 *     message tags, age-tier caveman compression) is tag-driven and
 *     uses the shared `TagTarget` interface produced by `tagTranscript`,
 *     so the OpenCode helpers `applyCavemanCleanup` and
 *     `stripSystemInjection` are called as-is — they don't know about
 *     the harness shape.
 *
 * Runs behind the same scheduler-execute / explicit-flush /
 * force-materialization gating as OpenCode (gating is the caller's
 * responsibility — this function unconditionally executes when called).
 *
 * Cache safety: mutations persist as tag drop/compression state or namespaced
 * Pi content decisions in session_meta. The context handler replays reminder
 * strips after caveman restores its source, including on defer passes. Original
 * source_contents remain intact for expansion.
 */

import { freezePiContentDecision } from "@magic-context/core/features/magic-context/pi-content-decisions";
import {
	CTX_REDUCE_KEEP,
	protectedToolTagNumbers,
} from "@magic-context/core/features/magic-context/reclaim-protection";
import { sessionDecisionCalibration } from "@magic-context/core/features/magic-context/session-decision-calibration";
import {
	type ContextDatabase,
	getActiveTagsBySession,
	getMaxTagNumberBySession,
	updateTagDropMode,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import { getEmergencyInputSample } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import {
	applyNewToolDrop,
	hasSmallToolInput,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import {
	applyCavemanCleanup,
	type CavemanCleanupConfig,
} from "@magic-context/core/hooks/magic-context/caveman-cleanup";
import type { DroppedTokenReduction } from "@magic-context/core/hooks/magic-context/dropped-token-estimate";
import {
	type EmergencyDropTag,
	measureEmergencyTag,
	planEmergencyDrop,
} from "@magic-context/core/hooks/magic-context/emergency-drop";
import { stripSystemInjection } from "@magic-context/core/hooks/magic-context/system-injection-stripper";
import type { TagTarget } from "@magic-context/core/hooks/magic-context/tag-messages";
import { stripTagPrefix } from "@magic-context/core/hooks/magic-context/tag-part-guards";
import { sessionLog } from "@magic-context/core/shared/logger";

/**
 * Same DEDUP_SAFE_TOOLS list OpenCode uses. Read-only tools whose
 * outputs are deterministic given the same input — duplicate calls
 * are wasted context. Anything mutating (write/edit/bash/etc.) is
 * intentionally excluded because two identical calls may have
 * different semantics in different positions of the conversation.
 * Pi names its built-in tools bare (`read`, `grep`), so the bare names
 * are what match; the `mcp_` forms cover MCP servers using that prefix.
 */
export const PI_CTX_REDUCE_KEEP = CTX_REDUCE_KEEP;

const DEDUP_SAFE_TOOLS = new Set([
	"grep",
	"read",
	"glob",
	"ast_grep_search",
	"lsp_diagnostics",
	"lsp_symbols",
	"lsp_find_references",
	"lsp_goto_definition",
	"lsp_prepare_rename",
	"mcp_grep",
	"mcp_read",
	"mcp_glob",
	"mcp_ast_grep_search",
	"mcp_lsp_diagnostics",
	"mcp_lsp_symbols",
	"mcp_lsp_find_references",
	"mcp_lsp_goto_definition",
	"mcp_lsp_prepare_rename",
]);

export interface PiHeuristicCleanupConfig {
	/** Bulk-freeze native removal decisions before measuring the active wire tools. */
	prepareToolRemovalMeasurements?: (callIds: readonly string[]) => void;
	protectedTools?: Readonly<Record<string, number>>;
	protectedToolTags?: ReadonlySet<number>;
	protectedTags: number;
	/** Token-window cutoff; null means no tool-backed protection window exists. */
	protectedCutoff?: number | null;
	/** Run age-sensitive cleanup; emergency selection remains independent. */
	routine?: boolean;
	/**
	 * Whether this pass may discover NEW stale ctx_reduce strips. Existing dropped
	 * tags still replay through applyFlushedStatuses on every provider.
	 */
	staleReduceStripEnabled: boolean;
	/** Reports actual new stale-arc edits, not dropped-status replay. */
	onStaleReduceEdit?: (tag: TagEntry) => void;
	/**
	 * Tiered target-headroom emergency drop (Phase 2). Provided only on the
	 * derived force-band materialize (cache-busting) pass; undefined on routine execute
	 * passes (routine age-based tool drops were removed). Mirrors OpenCode's
	 * `applyHeuristicCleanup` emergency config.
	 */
	emergency?: {
		currentTotalInputTokens: number;
		ceilingTokens: number;
		usagePercentage?: number;
		/** Another mutation already rewrites the cached prefix on this pass. */
		passAlreadyPriced?: boolean;
	};
	/**
	 * Age-tier caveman text compression settings. Caller is responsible
	 * for forwarding this only for primary sessions where caveman is enabled.
	 */
	caveman?: CavemanCleanupConfig;
}

export interface PiHeuristicCleanupResult {
	droppedTools: number;
	deduplicatedTools: number;
	droppedInjections: number;
	droppedStaleReduceCalls: number;
	emergencyDroppedTools: number;
	compressedTextTags: number;
	mutatedTextTags: number;
	droppedTokenReductions: DroppedTokenReduction[];
}

/**
 * Pi `AgentMessage[]` walker for tool-dedup fingerprinting.
 *
 * Returns one entry per assistant `toolCall` part whose tool name is
 * in DEDUP_SAFE_TOOLS, keyed by composite `<ownerMsgId>\x00<callId>` so
 * the dedup pass can match fingerprints to tool tags without collapsing
 * cross-owner reused call IDs.
 *
 * Mirrors OpenCode's `buildToolFingerprints` semantics, just with Pi
 * shape: assistant `content: PiToolCall[]` instead of OpenCode
 * `parts: [{ type: "tool_use" | "tool" | "tool-invocation", ... }]`.
 */
function buildPiToolFingerprints(
	messages: readonly unknown[],
	resolveStableId: (msg: unknown, index: number) => string | undefined,
): Map<string, string> {
	const fingerprints = new Map<string, string>();
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const msg = message as {
			role?: unknown;
			content?: unknown;
			timestamp?: number;
		};
		if (msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;
		// ownerMsgId MUST match the id the transcript tagged this message with
		// (resolvePiStableId) — real entry id when resolvable, index fallback else.
		const ownerMsgId = resolveStableId(message, i);
		if (!ownerMsgId) continue;
		for (const part of msg.content) {
			if (!part || typeof part !== "object") continue;
			const p = part as {
				type?: unknown;
				id?: unknown;
				name?: unknown;
				arguments?: unknown;
			};
			if (p.type !== "toolCall") continue;
			if (typeof p.name !== "string") continue;
			if (!DEDUP_SAFE_TOOLS.has(p.name)) continue;
			if (typeof p.id !== "string" || p.id.length === 0) continue;
			// Skip sentinel toolCalls — these are already-dropped tool
			// shells we keep around to preserve `id` ↔ `toolCallId`
			// pairing for the provider serializer (see transcript-pi.ts
			// `replaceWithSentinel` for assistant toolCall parts). Their
			// `arguments` carry the `__magic_context_dropped__` marker
			// instead of real input; including them in dedup
			// fingerprints would collapse all dropped tools onto one
			// fingerprint and is a no-op anyway since tags are already
			// persisted as dropped.
			const args = p.arguments;
			if (
				args &&
				typeof args === "object" &&
				"__magic_context_dropped__" in (args as Record<string, unknown>)
			) {
				continue;
			}
			let serialized: string;
			try {
				serialized = JSON.stringify(args ?? {});
			} catch {
				continue; // unrepresentable args — skip dedup for this call
			}
			// Owner in BOTH key AND value: cross-owner identical read tools
			// are distinct invocations, while same-owner parallel duplicates
			// still share a fingerprint and can be deduplicated.
			const fingerprint = `${ownerMsgId}:${p.name}:${serialized}`;
			const compositeKey = `${ownerMsgId}\x00${p.id}`;
			fingerprints.set(compositeKey, fingerprint);
		}
	}
	return fingerprints;
}

/**
 * Identify stale `ctx_reduce` tool calls by COMPOSITE (owner, callId) identity.
 *
 * A bare-callId match is unsafe: Pi/OpenCode can reuse a tool callId across
 * assistant turns (the reason tool tags carry tool_owner_message_id), so a stale
 * ctx_reduce call in an OLD assistant message must NOT cause a FRESH ctx_reduce
 * reusing the same callId in a recent turn to be dropped. We key by
 * `${ownerStableId}\x00${callId}` — the owner being the assistant message that
 * holds the toolCall part (resolveStableId of that message), which is exactly
 * what the tag row's tool_owner_message_id records.
 *
 * The newest ctx_reduce arcs are selected before the age cutoff is applied and
 * remain visible as housekeeping exemplars. Returns both a composite set (for
 * tags carrying an owner) and a bare-callId set (legacy NULL-owner rows written
 * before composite identity, matched by callId alone — same lazy-adoption
 * fallback the rest of the tag pipeline uses).
 */
function collectStaleReduceCallIds(
	messages: readonly unknown[],
	messageIdToMaxTag: Map<string, number>,
	ctxReduceTagNumbers: ReadonlyMap<string, number>,
	toolAgeCutoff: number,
	resolveStableId: (msg: unknown, index: number) => string | undefined,
): { composite: Set<string>; bareCallIds: Set<string> } {
	const reduceCalls = new Map<
		string,
		{ composite: string; callId: string; maxTag: number; messageIndex: number }
	>();
	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as {
			role?: unknown;
			content?: unknown;
			timestamp?: number;
		};
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const stableId = resolveStableId(raw, i);
		if (!stableId) continue;
		const ownerMaxTag = messageIdToMaxTag.get(stableId) ?? 0;

		for (const part of msg.content) {
			if (!part || typeof part !== "object") continue;
			const p = part as { type?: unknown; name?: unknown; id?: unknown };
			if (p.type !== "toolCall") continue;
			if (p.name !== "ctx_reduce") continue;
			if (typeof p.id !== "string" || p.id.length === 0) continue;
			const composite = `${stableId}\x00${p.id}`;
			const maxTag = ctxReduceTagNumbers.get(composite) ?? ownerMaxTag;
			if (maxTag === 0) continue;
			reduceCalls.set(composite, {
				composite,
				callId: p.id,
				maxTag,
				messageIndex: i,
			});
		}
	}

	const newestFirst = [...reduceCalls.values()].sort((left, right) => {
		const byPosition =
			right.maxTag - left.maxTag || right.messageIndex - left.messageIndex;
		if (byPosition !== 0) return byPosition;
		if (left.composite === right.composite) return 0;
		return left.composite < right.composite ? 1 : -1;
	});
	const composite = new Set<string>();
	const bareCallIds = new Set<string>();
	for (const call of newestFirst) {
		if (call.maxTag > toolAgeCutoff) continue;
		composite.add(call.composite);
		bareCallIds.add(call.callId);
	}
	return { composite, bareCallIds };
}

/**
 * Apply heuristic cleanup to a Pi session. Mirrors OpenCode's
 * `applyHeuristicCleanup` 1:1 in semantics; differences are limited
 * to message-shape walking for tool fingerprinting (everything else
 * goes through `TagTarget` and shared helpers).
 *
 * Run order matches OpenCode:
 *   1. Apply the emergency batch when supplied.
 *   2. Strip stale ctx_reduce calls and system injections when routine cleanup is enabled.
 *   3. Deduplicate tools when routine cleanup is enabled.
 *   4. Apply age-tier caveman compression when routine cleanup is enabled.
 *
 * Each pass commits within its own `db.transaction` so partial
 * progress survives mid-pass failures.
 */
export function applyPiHeuristicCleanup(
	sessionId: string,
	db: ContextDatabase,
	targets: Map<number, TagTarget>,
	piMessages: readonly unknown[],
	config: PiHeuristicCleanupConfig,
	preloadedTags?: TagEntry[],
	// Stable-id resolver — MUST be the same one the transcript tagged with, so the
	// owner ids built here match `target.message.info.id` in messageIdToMaxTag.
	// When omitted (older tests), falls back to the legacy index-based pi-msg-* id.
	resolveId?: (msg: unknown, index: number) => string | undefined,
): PiHeuristicCleanupResult {
	const logStep = (stage: string, start: number, extra = "") =>
		sessionLog(
			sessionId,
			`heuristic cleanup stage: stage=${stage} elapsed=${(performance.now() - start).toFixed(1)}ms${extra ? ` ${extra}` : ""}`,
		);
	// Resolve owner/stable ids the same way the transcript tagged messages, so the
	// ids built here key into messageIdToMaxTag (= target.message.info.id) correctly.
	// Legacy fallback (no resolver) keeps the old index-based pi-msg-* scheme.
	const resolveStableId = (msg: unknown, index: number): string | undefined => {
		if (resolveId) return resolveId(msg, index);
		if (!msg || typeof msg !== "object") return undefined;
		const m = msg as { role?: unknown; timestamp?: number };
		const role = typeof m.role === "string" ? m.role : "unknown";
		return typeof m.timestamp === "number"
			? `pi-msg-${index}-${m.timestamp}-${role}`
			: `pi-msg-${index}-${role}`;
	};

	// All work in this function short-circuits on `tag.status !== "active"`.
	// See OpenCode `applyHeuristicCleanup` for the full P0 perf rationale.
	const tTags = performance.now();
	const tags = preloadedTags ?? getActiveTagsBySession(db, sessionId);
	logStep(
		"tagLoad",
		tTags,
		`tags=${tags.length} preloaded=${preloadedTags !== undefined}`,
	);
	const protectedTools =
		config.protectedToolTags ??
		protectedToolTagNumbers(tags, config.protectedTools);
	// `maxTag` must reflect the true session max (including dropped/compacted)
	// so the protected-cutoff window is anchored to the most recent tag
	// regardless of status. `getMaxTagNumberBySession` resolves with a
	// single backward index seek (O(log N)).
	const maxTag = getMaxTagNumberBySession(db, sessionId);
	const protectedCutoff =
		config.protectedCutoff === null
			? maxTag + 1
			: (config.protectedCutoff ?? maxTag - config.protectedTags);
	const routine = config.routine !== false;
	// Stale-result detection uses the same protected-tool cutoff as the other result-handling paths.
	const toolAgeCutoff = protectedCutoff;

	let droppedTools = 0;
	let emergencyDroppedTools = 0;
	let deduplicatedTools = 0;
	let droppedInjections = 0;
	let droppedStaleReduceCalls = 0;
	const droppedTokenReductions: DroppedTokenReduction[] = [];

	// ── Pass 1: tiered target-headroom emergency drop ─────────────────
	// Replaces the old need-blind aged-drop + dropAllTools nuke. Runs only when
	// the caller supplies `emergency` (derived force-band cache-busting pass). Selection is
	// pure (`planEmergencyDrop`); we persist the tag mutations and return their count.
	// The context handler consumes the shared episode after all reclaim lanes finish.
	if (config.emergency) {
		const emergency = config.emergency;
		const priorInputSample = getEmergencyInputSample(db, sessionId);
		// Plan ONLY over tags in the live window that would ACTUALLY reclaim
		// bytes (canDrop, not mere drop() presence) — keeps the floor math equal
		// to the on-wire tail and avoids phantom under-evict. Mirrors OpenCode.
		const candidateTags = tags.filter(
			(t) =>
				t.status === "active" &&
				t.type === "tool" &&
				targets.get(t.tagNumber)?.canDrop?.(),
		);
		// Floor accounting needs the FULL active live-window set (all types) —
		// narrowing it to the droppable subset folds real conversation/
		// reasoning tail into the "irreducible prefix" and under-evicts.
		const recentTags = new Set(
			candidateTags
				.slice()
				.sort((a, b) => b.tagNumber - a.tagNumber)
				.slice(0, 20)
				.map((tag) => tag.tagNumber),
		);
		const calibration = sessionDecisionCalibration(db, sessionId);
		const tPrepare = performance.now();
		// Measurement requests removal authorization even for retained skeletons.
		// Prepare precisely those active, visible calls, preserving tag order and
		// the existing freeze-before-wire-edit rule without per-call envelope CAS.
		config.prepareToolRemovalMeasurements?.(
			tags.flatMap((tag) =>
				tag.status === "active" &&
				tag.type === "tool" &&
				tag.messageId &&
				targets.get(tag.tagNumber)?.measureReclaim
					? [tag.messageId]
					: [],
			),
		);
		logStep("prepareNativeRemovals", tPrepare);
		const tMeasure = performance.now();
		const activeTags = tags
			.filter((t) => t.status === "active")
			.map((tag) =>
				measureEmergencyTag(
					tag,
					targets.get(tag.tagNumber),
					calibration,
					targets.get(tag.tagNumber)?.requiresToolArcSkeleton === true ||
						((emergency.usagePercentage ?? 0) < 95 &&
							recentTags.has(tag.tagNumber) &&
							hasSmallToolInput(targets.get(tag.tagNumber))),
				),
			);
		const byTag = new Map(activeTags.map((tag) => [tag.tagNumber, tag]));
		const droppableTags = candidateTags
			.flatMap((tag) => {
				const measured = byTag.get(tag.tagNumber);
				return measured ? [measured] : [];
			})
			.filter((tag) => (tag.reclaimableTokens ?? 0) > 0);
		logStep(
			"measureEmergencyTags",
			tMeasure,
			`active=${activeTags.length} candidates=${droppableTags.length}`,
		);
		sessionLog(
			sessionId,
			`emergency candidates: loaded=${tags.length} active=${activeTags.length} activeTools=${activeTags.filter((tag) => tag.type === "tool").length} visibleCompleteTools=${droppableTags.length} windowYields=${(emergency.usagePercentage ?? 0) >= 95} cutoff=${protectedCutoff}`,
		);
		const tPlan = performance.now();
		const plan = planEmergencyDrop({
			tags: droppableTags as readonly EmergencyDropTag[],
			floorTags: activeTags as readonly EmergencyDropTag[],
			maxTag,
			protectedCutoff,
			currentTotalInputTokens: emergency.currentTotalInputTokens,
			ceilingTokens: emergency.ceilingTokens,
			usagePercentage: emergency.usagePercentage,
			priorInputSample,
			hasPriorDrop: priorInputSample > 0,
			passAlreadyPriced: emergency.passAlreadyPriced === true,
			protectedToolTags: protectedTools,
		});
		logStep("planEmergencyDrop", tPlan);
		if (plan.shouldDrop) {
			const tPersist = performance.now();
			const toDrop = new Set(plan.tagNumbers);
			const newestEmergencyTags = recentTags;
			db.transaction(() => {
				for (const tag of tags) {
					if (!toDrop.has(tag.tagNumber)) continue;
					if (tag.status !== "active" || tag.type !== "tool") continue;
					const target = targets.get(tag.tagNumber);
					const recent =
						(emergency.usagePercentage ?? 0) < 95 &&
						newestEmergencyTags.has(tag.tagNumber);
					// Removing the result separator beside native reasoning lets Anthropic
					// merge signed assistant turns, so this safety case always keeps the
					// pair, with its real arguments.
					const { result, mode } = applyNewToolDrop(target, {
						inWindow: recent,
						keepSkeleton: target?.requiresToolArcSkeleton === true,
					});
					if (result === "removed" || result === "truncated") {
						// Persist the mode applied (including drop() keeping the
						// call whose result ends the request) so replays match.
						updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
						updateTagDropMode(db, sessionId, tag.tagNumber, mode);
						droppedTools++;
						emergencyDroppedTools++;
						droppedTokenReductions.push({
							tagNumber: tag.tagNumber,
							mode: mode === "full" ? "full" : "truncated",
						});
					}
				}
			}).immediate();
			logStep(
				"applyEmergencyDrops",
				tPersist,
				`dropped=${emergencyDroppedTools}`,
			);
			sessionLog(sessionId, `emergency tiered drop: ${plan.reason}`);
		} else {
			sessionLog(sessionId, `emergency tiered drop skipped: ${plan.reason}`);
		}
	}

	// ── Pass 1b: stale ctx_reduce calls (Pi persisted-drop replay) ──────
	const staleReduce =
		routine && config.staleReduceStripEnabled
			? collectStaleReduceCallIds(
					piMessages,
					buildMessageIdToMaxTagFromTargets(targets),
					buildCtxReduceTagNumbers(tags),
					toolAgeCutoff,
					resolveStableId,
				)
			: { composite: new Set<string>(), bareCallIds: new Set<string>() };
	if (
		routine &&
		config.staleReduceStripEnabled &&
		(staleReduce.composite.size > 0 || staleReduce.bareCallIds.size > 0)
	) {
		db.transaction(() => {
			for (const tag of tags) {
				if (tag.status !== "active") continue;
				if (tag.type !== "tool") continue;
				if (protectedTools.has(tag.tagNumber)) continue;
				if (!tag.messageId) continue;
				// Composite match for tags carrying an owner — prevents a reused
				// callId in a fresh turn from being dropped by a stale call in an
				// old turn. Legacy NULL-owner rows fall back to bare callId match
				// (lazy adoption: they predate composite identity).
				const matched = tag.toolOwnerMessageId
					? staleReduce.composite.has(
							`${tag.toolOwnerMessageId}\x00${tag.messageId}`,
						)
					: staleReduce.bareCallIds.has(tag.messageId);
				if (!matched) continue;
				const target = targets.get(tag.tagNumber);
				if (target?.canDrop?.() === false) continue;
				const { result, mode } = applyNewToolDrop(target, { inWindow: false });
				if (result === "incomplete") continue;
				updateTagDropMode(db, sessionId, tag.tagNumber, mode);
				updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
				if (result === "removed" || result === "truncated") {
					droppedStaleReduceCalls++;
					config.onStaleReduceEdit?.(tag);
				}
			}
		}).immediate();
	}

	// ── Pass 2: strip system injections from message tags ─────────────
	if (routine) {
		db.transaction(() => {
			for (const tag of tags) {
				if (tag.status !== "active") continue;
				if (tag.tagNumber > protectedCutoff) continue;
				if (tag.type !== "message") continue;

				const target = targets.get(tag.tagNumber);
				if (!target) continue;

				const content = target.getContent?.();
				if (!content) continue;

				const stripped = stripSystemInjection(content);
				if (stripped === null) continue;
				const strippedSource = stripTagPrefix(stripped);

				if (strippedSource.trim().length === 0) {
					if (target.thinkingDropProtected) continue;
					const dropResult = target.drop?.() ?? "absent";
					const didReplace =
						dropResult === "absent"
							? target.setContent(`[dropped §${tag.tagNumber}§]`)
							: false;
					if (dropResult === "removed" || dropResult === "absent") {
						updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
						if (dropResult === "removed" || didReplace) {
							droppedInjections++;
							droppedTokenReductions.push({
								tagNumber: tag.tagNumber,
								mode: "full",
							});
						}
					}
				} else {
					if (
						freezePiContentDecision(
							db,
							sessionId,
							"reminder-strip",
							tag.messageId,
						)
					) {
						if (target.setContent(stripped, { keepReasoning: true })) {
							droppedInjections++;
							droppedTokenReductions.push({
								tagNumber: tag.tagNumber,
								mode: "partial",
								removedCharacters: Math.max(
									0,
									content.length - stripped.length,
								),
							});
						}
					}
				}
			}
		}).immediate();
	}

	// ── Pass 3: tool dedup (Pi-shape fingerprinter) ───────────────────
	const toolFingerprints = routine
		? buildPiToolFingerprints(piMessages, resolveStableId)
		: new Map<string, string>();
	if (toolFingerprints.size > 0) {
		const tagsByCompositeKey = new Map<string, TagEntry>();
		for (const tag of tags) {
			if (tag.type === "tool" && tag.status === "active" && tag.messageId) {
				const key = tag.toolOwnerMessageId
					? `${tag.toolOwnerMessageId}\x00${tag.messageId}`
					: tag.messageId; // legacy NULL-owner fallback
				tagsByCompositeKey.set(key, tag);
			}
		}

		// Protected tags join their group so a protected newest copy still anchors
		// it; they are never dropped themselves (below). Leaving them out kept one
		// unprotected copy alive beside the protected one.
		const fingerprintGroups = new Map<string, TagEntry[]>();
		for (const [compositeKey, fingerprint] of toolFingerprints) {
			const tag = tagsByCompositeKey.get(compositeKey);
			if (!tag) continue;
			const group = fingerprintGroups.get(fingerprint) ?? [];
			group.push(tag);
			fingerprintGroups.set(fingerprint, group);
		}

		db.transaction(() => {
			for (const [, group] of fingerprintGroups) {
				if (group.length <= 1) continue;
				group.sort((a, b) => a.tagNumber - b.tagNumber);
				// Keep the newest, drop the rest.
				for (let i = 0; i < group.length - 1; i++) {
					const tag = group[i];
					if (tag.tagNumber > protectedCutoff) continue;
					const target = targets.get(tag.tagNumber);
					if (protectedTools.has(tag.tagNumber)) continue;
					if (target?.canDrop?.() === false) continue;
					// Deduplication stays full-drop; only emergency recent arcs keep
					// skeletons. A call that cannot be removed keeps real arguments.
					const { result, mode } = applyNewToolDrop(target, {
						inWindow: false,
					});
					if (result === "incomplete") continue;
					updateTagDropMode(db, sessionId, tag.tagNumber, mode);
					updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
					if (result === "removed" || result === "truncated") {
						deduplicatedTools++;
						droppedTokenReductions.push({
							tagNumber: tag.tagNumber,
							mode: mode === "full" ? "full" : "truncated",
						});
					}
				}
			}
		}).immediate();
	}

	if (
		droppedTools > 0 ||
		deduplicatedTools > 0 ||
		droppedInjections > 0 ||
		droppedStaleReduceCalls > 0
	) {
		sessionLog(
			sessionId,
			`heuristic cleanup: dropped ${droppedTools} tool tags, stale ctx_reduce=${droppedStaleReduceCalls}, deduplicated ${deduplicatedTools} tool calls, dropped ${droppedInjections} system injections`,
		);
	}

	// ── Pass 4: age-tier caveman text compression ─────────────────────
	let compressedTextTags = 0;
	let mutatedTextTags = 0;
	if (routine && config.caveman?.enabled) {
		// System-injection cleanup above drops tags but keeps their pristine source.
		// Reload active rows so compression skips tags dropped during this request.
		// Otherwise compression restores a dropped injection now, and the persisted
		// drop takes effect only on the next request, causing a second cache rebuild.
		const cavemanTags = getActiveTagsBySession(db, sessionId);
		const cavemanResult = applyCavemanCleanup(
			sessionId,
			db,
			targets,
			cavemanTags,
			{
				enabled: true,
				minChars: config.caveman.minChars,
				wordRules: config.caveman.wordRules,
				protectedCutoff,
			},
		);
		compressedTextTags =
			cavemanResult.compressedToLite +
			cavemanResult.compressedToFull +
			cavemanResult.compressedToUltra;
		mutatedTextTags = cavemanResult.mutatedTextTags;
		if (cavemanResult.textReductions) {
			for (const r of cavemanResult.textReductions) {
				droppedTokenReductions.push({
					tagNumber: r.tagNumber,
					mode: "partial",
					removedCharacters: r.removedCharacters,
				});
			}
		}
	}

	return {
		droppedTools,
		deduplicatedTools,
		droppedInjections,
		droppedStaleReduceCalls,
		emergencyDroppedTools,
		compressedTextTags,
		mutatedTextTags,
		droppedTokenReductions,
	};
}

function buildCtxReduceTagNumbers(
	tags: readonly TagEntry[],
): Map<string, number> {
	const byComposite = new Map<string, number>();
	for (const tag of tags) {
		if (
			tag.status !== "active" ||
			tag.type !== "tool" ||
			tag.toolName !== "ctx_reduce" ||
			!tag.toolOwnerMessageId
		) {
			continue;
		}
		byComposite.set(
			`${tag.toolOwnerMessageId}\x00${tag.messageId}`,
			tag.tagNumber,
		);
	}
	return byComposite;
}

function buildMessageIdToMaxTagFromTargets(
	targets: Map<number, TagTarget>,
): Map<string, number> {
	const byMessage = new Map<string, number>();
	for (const [tagNumber, target] of targets) {
		const id = target.message?.info?.id;
		if (typeof id !== "string" || id.length === 0) continue;
		if (tagNumber > (byMessage.get(id) ?? 0)) byMessage.set(id, tagNumber);
	}
	return byMessage;
}
