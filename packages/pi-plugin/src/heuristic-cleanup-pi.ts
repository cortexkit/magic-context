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
 * Cache safety: every mutation persists to the DB (`tags.status`,
 * `tags.drop_mode`, `source_contents`, `tags.caveman_depth`). Subsequent
 * defer passes read these durable signals via `applyFlushedStatuses` +
 * `replayCavemanCompression` so the visible message bytes stay stable
 * across passes.
 */

import { getProtectionWindowForSession } from "@magic-context/core/features/magic-context/protection-window";
import {
	type ContextDatabase,
	getActiveTagsBySession,
	getMaxTagNumberBySession,
	replaceSourceContent,
	updateTagDropMode,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import {
	getEmergencyInputSample,
	setEmergencyDropSample,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import {
	applyCavemanCleanup,
	type CavemanCleanupConfig,
} from "@magic-context/core/hooks/magic-context/caveman-cleanup";
import {
	type EmergencyDropTag,
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
 */
export const PI_CTX_REDUCE_KEEP = 3;

const DEDUP_SAFE_TOOLS = new Set([
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
	protectedTags?: number;
	cutoff?: number | null;
	floor?: number;
	protectedTokens?: number;
	/** Run age-sensitive cleanup; emergency selection remains independent. */
	routine?: boolean;
	/**
	 * Whether this pass may discover NEW stale ctx_reduce strips. Existing dropped
	 * tags still replay through applyFlushedStatuses on every provider.
	 */
	staleReduceStripEnabled: boolean;
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
	const protectedComposite = new Set(
		newestFirst.slice(0, PI_CTX_REDUCE_KEEP).map((call) => call.composite),
	);
	const composite = new Set<string>();
	const bareCallIds = new Set<string>();
	for (const call of newestFirst) {
		if (call.maxTag > toolAgeCutoff || protectedComposite.has(call.composite))
			continue;
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
	const tags = preloadedTags ?? getActiveTagsBySession(db, sessionId);
	// `maxTag` must reflect the true session max (including dropped/compacted)
	// so the protected-cutoff window is anchored to the most recent tag
	// regardless of status. `getMaxTagNumberBySession` resolves with a
	// single backward index seek (O(log N)).
	const maxTag = getMaxTagNumberBySession(db, sessionId);
	const windowResult = getProtectionWindowForSession(db, sessionId);
	// Coordinate space: tag-number
	// Empty-window behaviour: absent cutoff branch (cutoff is null)
	const resolvedCutoff =
		config.cutoff !== undefined
			? config.cutoff
			: typeof config.protectedTags === "number"
				? null
				: windowResult.ordinalCutoff.cutoff;
	const protectedCutoff =
		resolvedCutoff !== null
			? resolvedCutoff - 1
			: typeof config.protectedTags === "number"
				? maxTag - config.protectedTags
				: windowResult.ordinalCutoff.cutoff !== null
					? windowResult.ordinalCutoff.cutoff - 1
					: maxTag;
	const routine = config.routine !== false;
	// Stale ctx_reduce removal uses the protected-tail window after first retaining
	// the newest housekeeping exemplars; only older calls can become stale.
	const toolAgeCutoff = protectedCutoff;

	let droppedTools = 0;
	let emergencyDroppedTools = 0;
	let deduplicatedTools = 0;
	let droppedInjections = 0;
	let droppedStaleReduceCalls = 0;

	// ── Pass 1: tiered target-headroom emergency drop ─────────────────
	// Replaces the old need-blind aged-drop + dropAllTools nuke. Runs only when
	// the caller supplies `emergency` (derived force-band cache-busting pass). Selection is
	// pure (`planEmergencyDrop`); we apply it and advance the persisted watermark
	// so each tag drops once. Mirrors OpenCode `applyHeuristicCleanup`.
	if (config.emergency) {
		const emergency = config.emergency;
		const priorInputSample = getEmergencyInputSample(db, sessionId);
		// Plan ONLY over tags in the live window that would ACTUALLY reclaim
		// bytes (canDrop, not mere drop() presence) — keeps the floor math equal
		// to the on-wire tail and avoids phantom under-evict. Mirrors OpenCode.
		const droppableTags = tags.filter(
			(t) =>
				t.status === "active" &&
				t.type === "tool" &&
				targets.get(t.tagNumber)?.canDrop?.(),
		);
		// Floor accounting needs the FULL active live-window set (all types) —
		// narrowing it to the droppable subset folds real conversation/
		// reasoning tail into the "irreducible prefix" and under-evicts.
		const activeTags = tags.filter((t) => t.status === "active");
		const plan = planEmergencyDrop({
			tags: droppableTags as readonly EmergencyDropTag[],
			floorTags: activeTags as readonly EmergencyDropTag[],
			maxTag,
			protectedTags:
				resolvedCutoff !== null
					? Math.max(0, maxTag - (resolvedCutoff - 1))
					: (config.protectedTags ?? 0),
			currentTotalInputTokens: emergency.currentTotalInputTokens,
			ceilingTokens: emergency.ceilingTokens,
			usagePercentage: emergency.usagePercentage,
			priorInputSample,
			hasPriorDrop: priorInputSample > 0,
		});
		if (plan.shouldDrop) {
			const toDrop = new Set(plan.tagNumbers);
			const newestEmergencyTags = new Set(
				droppableTags
					.slice()
					.sort((left, right) => right.tagNumber - left.tagNumber)
					.slice(0, 20)
					.map((tag) => tag.tagNumber),
			);
			db.transaction(() => {
				for (const tag of tags) {
					if (!toDrop.has(tag.tagNumber)) continue;
					if (tag.status !== "active" || tag.type !== "tool") continue;
					const target = targets.get(tag.tagNumber);
					const recent =
						(emergency.usagePercentage ?? 0) < 95 &&
						newestEmergencyTags.has(tag.tagNumber);
					// Removing the result separator beside native reasoning lets Anthropic
					// merge signed assistant turns, so this safety case always keeps the pair.
					const reasoningSafeSkeleton =
						target?.requiresToolArcSkeleton === true;
					const skeleton = recent || reasoningSafeSkeleton;
					const result = reasoningSafeSkeleton
						? (target?.truncate?.() ?? "absent")
						: recent
							? (target?.truncate?.() ?? target?.drop?.() ?? "absent")
							: (target?.drop?.() ?? "absent");
					if (result === "removed" || result === "truncated") {
						updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
						updateTagDropMode(
							db,
							sessionId,
							tag.tagNumber,
							skeleton ? "truncated" : "full",
						);
						droppedTools++;
						emergencyDroppedTools++;
					}
				}
			})();
			sessionLog(sessionId, `emergency tiered drop: ${plan.reason}`);
		} else {
			sessionLog(sessionId, `emergency tiered drop skipped: ${plan.reason}`);
		}
		// A no-op spent no cache rewrite and must not consume the episode's batch.
		if (emergencyDroppedTools > 0) {
			setEmergencyDropSample(db, sessionId, emergency.currentTotalInputTokens);
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
				const result = target?.drop?.() ?? "absent";
				if (result === "incomplete") continue;
				updateTagDropMode(db, sessionId, tag.tagNumber, "full");
				updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
				if (result === "removed" || result === "truncated") {
					droppedStaleReduceCalls++;
				}
			}
		})();
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
					const dropResult = target.drop?.() ?? "absent";
					const didReplace =
						dropResult === "absent"
							? target.setContent(`[dropped §${tag.tagNumber}§]`)
							: false;
					if (dropResult === "removed" || dropResult === "absent") {
						replaceSourceContent(db, sessionId, tag.tagNumber, "");
						updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
						if (dropResult === "removed" || didReplace) {
							droppedInjections++;
						}
					}
				} else {
					const didSet = target.setContent(stripped);
					if (didSet) {
						replaceSourceContent(db, sessionId, tag.tagNumber, strippedSource);
						droppedInjections++;
					}
				}
			}
		})();
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

		const fingerprintGroups = new Map<string, TagEntry[]>();
		for (const [compositeKey, fingerprint] of toolFingerprints) {
			const tag = tagsByCompositeKey.get(compositeKey);
			if (!tag || tag.tagNumber > protectedCutoff) continue;
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
					const target = targets.get(tag.tagNumber);
					// Deduplication stays full-drop; only emergency recent arcs keep skeletons.
					const result = target?.drop?.() ?? "absent";
					if (result === "incomplete") continue;
					updateTagDropMode(db, sessionId, tag.tagNumber, "full");
					updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
					if (result === "removed" || result === "truncated") {
						deduplicatedTools++;
					}
				}
			}
		})();
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
		const cavemanResult = applyCavemanCleanup(sessionId, db, targets, tags, {
			enabled: true,
			minChars: config.caveman.minChars,
			protectedTags: config.protectedTags ?? 20,
		});
		compressedTextTags =
			cavemanResult.compressedToLite +
			cavemanResult.compressedToFull +
			cavemanResult.compressedToUltra;
		mutatedTextTags = cavemanResult.mutatedTextTags;
	}

	return {
		droppedTools,
		deduplicatedTools,
		droppedInjections,
		droppedStaleReduceCalls,
		emergencyDroppedTools,
		compressedTextTags,
		mutatedTextTags,
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
