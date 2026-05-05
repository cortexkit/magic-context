/**
 * Pi-side heuristic cleanup — mirrors OpenCode's `applyHeuristicCleanup`
 * (packages/plugin/src/hooks/magic-context/heuristic-cleanup.ts).
 *
 * Same four passes, in the same order, with the same DB persistence
 * semantics. The only Pi-specific pieces are:
 *
 *   - Tool fingerprinting walks Pi `AgentMessage[]` instead of
 *     OpenCode `MessageLike[]`. Pi assistant messages carry tool calls
 *     as parts of type `"toolCall"` with `{ id, name, arguments }`.
 *     OpenCode's `extractToolInfo` checks `"tool" | "tool_use" |
 *     "tool-invocation"` shapes that don't exist in Pi.
 *   - Stale `ctx_reduce` removal also walks Pi shape directly. OpenCode
 *     mutates message parts to sentinels; Pi persists `tags.status='dropped'`
 *     and lets `applyFlushedStatuses` replay the existing drop path on
 *     every pass, which is the cache-stable mechanism Pi already uses.
 *
 *   - Everything else (drop aged tools, strip system injections from
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

import {
	type ContextDatabase,
	getActiveTagsBySession,
	getMaxTagNumberBySession,
	replaceSourceContent,
	updateTagDropMode,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import {
	applyCavemanCleanup,
	type CavemanCleanupConfig,
} from "@magic-context/core/hooks/magic-context/caveman-cleanup";
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
	autoDropToolAge: number;
	dropToolStructure: boolean;
	protectedTags: number;
	/**
	 * Emergency override: when true, drops ALL tool tags outside the
	 * protected tail regardless of age. Mirrors OpenCode's
	 * forceMaterialization @ 85% behavior. Caller decides when to set.
	 */
	dropAllTools?: boolean;
	/**
	 * Age-tier caveman text compression settings. Caller is responsible
	 * for only forwarding this when `ctx_reduce_enabled === false` (the
	 * feature replaces manual ctx_reduce text dropping).
	 */
	caveman?: CavemanCleanupConfig;
}

export interface PiHeuristicCleanupResult {
	droppedTools: number;
	deduplicatedTools: number;
	droppedInjections: number;
	droppedStaleReduceCalls: number;
	compressedTextTags: number;
}

/**
 * Pi `AgentMessage[]` walker for tool-dedup fingerprinting.
 *
 * Returns one entry per assistant `toolCall` part whose tool name is
 * in DEDUP_SAFE_TOOLS, keyed by callId so the dedup pass can match
 * fingerprints to tool tags (which carry callId as `messageId`).
 *
 * Mirrors OpenCode's `buildToolFingerprints` semantics, just with Pi
 * shape: assistant `content: PiToolCall[]` instead of OpenCode
 * `parts: [{ type: "tool_use" | "tool" | "tool-invocation", ... }]`.
 */
function buildPiToolFingerprints(
	messages: readonly unknown[],
): Map<string, string> {
	const fingerprints = new Map<string, string>();
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const msg = message as { role?: unknown; content?: unknown };
		if (msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;
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
			fingerprints.set(p.id, `${p.name}:${serialized}`);
		}
	}
	return fingerprints;
}

function collectStaleReduceCallIds(
	messages: readonly unknown[],
	messageIdToMaxTag: Map<string, number>,
	toolAgeCutoff: number,
): Set<string> {
	const staleCallIds = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const raw = messages[i];
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as {
			role?: unknown;
			content?: unknown;
			timestamp?: number;
		};
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

		const stableId =
			typeof msg.timestamp === "number"
				? `pi-msg-${i}-${msg.timestamp}-assistant`
				: `pi-msg-${i}-assistant`;
		const maxTag = messageIdToMaxTag.get(stableId) ?? 0;
		if (maxTag === 0 || maxTag > toolAgeCutoff) continue;

		for (const part of msg.content) {
			if (!part || typeof part !== "object") continue;
			const p = part as { type?: unknown; name?: unknown; id?: unknown };
			if (p.type !== "toolCall") continue;
			if (p.name !== "ctx_reduce") continue;
			if (typeof p.id !== "string" || p.id.length === 0) continue;
			staleCallIds.add(p.id);
		}
	}
	return staleCallIds;
}

/**
 * Apply heuristic cleanup to a Pi session. Mirrors OpenCode's
 * `applyHeuristicCleanup` 1:1 in semantics; differences are limited
 * to message-shape walking for tool fingerprinting (everything else
 * goes through `TagTarget` and shared helpers).
 *
 * Run order matches OpenCode:
 *   1. Drop aged tools (or all tools when `dropAllTools=true`).
 *   2. Strip system injections from message tags.
 *   3. Tool dedup (drop older identical calls of read-only tools).
 *   4. Age-tier caveman text compression (when enabled).
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
): PiHeuristicCleanupResult {
	// All work in this function short-circuits on `tag.status !== "active"`.
	// See OpenCode `applyHeuristicCleanup` for the full P0 perf rationale.
	const tags = preloadedTags ?? getActiveTagsBySession(db, sessionId);
	// `maxTag` must reflect the true session max (including dropped/compacted)
	// so the protected-cutoff window is anchored to the most recent tag
	// regardless of status. `getMaxTagNumberBySession` resolves with a
	// single backward index seek (O(log N)).
	const maxTag = getMaxTagNumberBySession(db, sessionId);
	const toolAgeCutoff = maxTag - config.autoDropToolAge;
	const protectedCutoff = maxTag - config.protectedTags;

	let droppedTools = 0;
	let deduplicatedTools = 0;
	let droppedInjections = 0;
	let droppedStaleReduceCalls = 0;

	// ── Pass 1: drop aged tool tags ───────────────────────────────────
	db.transaction(() => {
		for (const tag of tags) {
			if (tag.status !== "active") continue;
			if (tag.tagNumber > protectedCutoff) continue;

			const shouldDropTool =
				tag.type === "tool" &&
				(config.dropAllTools === true || tag.tagNumber <= toolAgeCutoff);
			if (!shouldDropTool) continue;

			const target = targets.get(tag.tagNumber);
			const useFullDrop =
				config.dropToolStructure || config.dropAllTools === true;
			const result = useFullDrop
				? (target?.drop?.() ?? "absent")
				: (target?.truncate?.() ?? "absent");
			if (
				result === "removed" ||
				result === "truncated" ||
				result === "absent"
			) {
				updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
				updateTagDropMode(
					db,
					sessionId,
					tag.tagNumber,
					useFullDrop ? "full" : "truncated",
				);
				droppedTools++;
			}
		}
	})();

	// ── Pass 1b: stale ctx_reduce calls (Pi persisted-drop replay) ──────
	const staleReduceCallIds = collectStaleReduceCallIds(
		piMessages,
		buildMessageIdToMaxTagFromTargets(targets),
		toolAgeCutoff,
	);
	if (staleReduceCallIds.size > 0) {
		db.transaction(() => {
			for (const tag of tags) {
				if (tag.status !== "active") continue;
				if (tag.type !== "tool") continue;
				if (!tag.messageId || !staleReduceCallIds.has(tag.messageId)) continue;
				const target = targets.get(tag.tagNumber);
				target?.drop?.();
				updateTagDropMode(db, sessionId, tag.tagNumber, "full");
				updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
				droppedStaleReduceCalls++;
			}
		})();
	}

	// ── Pass 2: strip system injections from message tags ─────────────
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

	// ── Pass 3: tool dedup (Pi-shape fingerprinter) ───────────────────
	const toolFingerprints = buildPiToolFingerprints(piMessages);
	if (toolFingerprints.size > 0) {
		const tagsByMessageId = new Map<string, TagEntry>();
		for (const tag of tags) {
			if (tag.type === "tool" && tag.status === "active" && tag.messageId) {
				tagsByMessageId.set(tag.messageId, tag);
			}
		}

		const fingerprintGroups = new Map<string, TagEntry[]>();
		for (const [callId, fingerprint] of toolFingerprints) {
			const tag = tagsByMessageId.get(callId);
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
					const result = config.dropToolStructure
						? (target?.drop?.() ?? "absent")
						: (target?.truncate?.() ?? "absent");
					if (result === "incomplete") continue;
					updateTagDropMode(
						db,
						sessionId,
						tag.tagNumber,
						config.dropToolStructure ? "full" : "truncated",
					);
					updateTagStatus(db, sessionId, tag.tagNumber, "dropped");
					deduplicatedTools++;
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
			`pi heuristic cleanup: dropped ${droppedTools} tool tags, stale ctx_reduce=${droppedStaleReduceCalls}, deduplicated ${deduplicatedTools} tool calls, dropped ${droppedInjections} system injections`,
		);
	}

	// ── Pass 4: age-tier caveman text compression ─────────────────────
	let compressedTextTags = 0;
	if (config.caveman?.enabled) {
		const cavemanResult = applyCavemanCleanup(sessionId, db, targets, tags, {
			enabled: true,
			minChars: config.caveman.minChars,
			protectedTags: config.protectedTags,
		});
		compressedTextTags =
			cavemanResult.compressedToLite +
			cavemanResult.compressedToFull +
			cavemanResult.compressedToUltra;
	}

	return {
		droppedTools,
		deduplicatedTools,
		droppedInjections,
		droppedStaleReduceCalls,
		compressedTextTags,
	};
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
