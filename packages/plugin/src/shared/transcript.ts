/**
 * Harness-agnostic transcript interface.
 *
 * Magic Context's transform pipeline operates on messages in a specific
 * shape: ordered messages with role-tagged parts (text, tool, reasoning,
 * tool_result, image), where tagging, sentinel stripping, and queued-drop
 * application MUTATE part content in-place. OpenCode's plugin transform
 * receives a `{ info, parts: unknown[] }[]` array and the AI SDK reads
 * those mutations directly. Pi's `pi.on("context", ...)` event delivers a
 * `AgentMessage[]` and accepts a fully-replaced array as the result.
 *
 * Rather than building a bidirectional `MessageLike[] ↔ AgentMessage[]`
 * adapter (Oracle's rejected Q1 alternative — too much round-trip
 * complexity, double-conversion bugs), this module defines a small
 * adapter contract that:
 *
 *   1. Exposes ordered messages with a *uniform* part-level mutation
 *      surface, regardless of underlying shape.
 *   2. Is owned by the harness — OpenCode's adapter mutates `parts[]`
 *      directly (zero copies), Pi's adapter rebuilds an `AgentMessage[]`
 *      from the mutated transcript only at commit time.
 *   3. Lets the shared transform code (tagging, stripping, drops)
 *      operate on `TranscriptPart` interface instances without caring
 *      whether they're wrapping `Part` from `@opencode-ai/sdk` or
 *      `TextContent | ToolCall | ThinkingContent` from `@mariozechner/pi-ai`.
 *
 * What this interface deliberately does NOT do:
 *
 * - **No data round-trip.** The transcript is a *view* over harness data;
 *   it doesn't define a third canonical message shape. There's no JSON
 *   serialization, no normalization to a common DTO. Round-trip-free
 *   adapters are 10x simpler and faster.
 *
 * - **No mutation semantics divergence.** Both adapters expose the same
 *   in-place mutation API (`setText`, `setOutput`, `replaceWithSentinel`).
 *   Whether mutation flushes to the source array immediately (OpenCode)
 *   or accumulates until `commit()` (Pi) is the adapter's concern.
 *
 * - **No session-storage abstraction.** Compartment storage, ordinals,
 *   raw-history reads — those live in feature modules, not here. The
 *   transcript only models the *current turn's* live message buffer.
 *
 * Step 4b.1 ships ONLY the interface and OpenCode adapter migration.
 * Pi adapter implementation lands in 4b.2 alongside the Pi context-event
 * wire-up, since the two are co-designed (the Pi adapter has to satisfy
 * the same operations the tagging code calls). 4b.3 wires the Pi
 * compartment trigger and historian invocation. 4b.4 nudges + auto-search.
 */

/** Categorical kind of a transcript part, useful for filter predicates. */
export type TranscriptPartKind =
    | "text"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "image"
    | "file"
    | "structural"
    | "unknown";

/**
 * A single content fragment within a transcript message.
 *
 * The interface is intentionally narrow: it exposes the operations Magic
 * Context's transform code performs (read kind, read text, mutate text,
 * mutate tool output, drop, replace with sentinel) and nothing more. Each
 * harness adapter implements these against its native part type.
 *
 * IMPORTANT: implementations are stateful proxies over the live source
 * data. Calling `setText("...")` on an OpenCode part mutates the
 * underlying `Part.text`; calling it on a Pi part flips a dirty flag and
 * the adapter's `commit()` rebuilds the affected `AgentMessage`. Either
 * way, the transcript code reads back consistent values via `getText()`.
 */
export interface TranscriptPart {
    /** Discriminator for filter logic. Stable across mutations. */
    readonly kind: TranscriptPartKind;

    /**
     * Best-effort identifier for cross-pass tracking. May be:
     * - OpenCode part ID (e.g. "prt_..."), stable across passes.
     * - Pi tool-call ID for tool_use/tool_result parts.
     * - undefined for synthetic/structural parts.
     *
     * Pure parts without a stable ID return undefined and are tracked
     * positionally within their containing message instead.
     */
    readonly id: string | undefined;

    /**
     * The user-/agent-visible text payload, if this part has one. Returns
     * undefined for parts that have no text representation (image, file,
     * structural-only). For thinking parts returns the thinking text. For
     * tool_use returns the JSON-stringified arguments (so size accounting
     * reflects what the model sees). For tool_result returns the
     * concatenated text content of the result.
     */
    getText(): string | undefined;

    /**
     * Replace the visible text payload. Applies only to text and thinking
     * parts; throws for kinds where mutation isn't meaningful (the caller
     * should check `kind` first).
     *
     * Returns true if the underlying source data actually changed (so
     * deduplication helpers can short-circuit). Returns false when the
     * new text equals the existing text byte-for-byte.
     */
    setText(newText: string): boolean;

    /**
     * For tool_result parts: replace the text content of the result.
     * For tool_use parts: replace JSON-serialized arguments.
     * For everything else: throws — caller should check `kind` first.
     */
    setToolOutput(newText: string): boolean;

    /**
     * Tool-specific metadata exposed for tagging/drop accounting:
     * - toolName: tool identifier (e.g. "bash", "ctx_search"). undefined
     *   for non-tool parts.
     * - inputByteSize: serialized argument size; used by historian
     *   pressure projection to estimate post-drop savings.
     *
     * For non-tool parts both fields are undefined.
     */
    getToolMetadata(): { toolName: string | undefined; inputByteSize: number };

    /**
     * Replace this part with a sentinel placeholder. Sentinels look like
     * `[dropped §N§]` or `[truncated §N§]` and survive cache-busting
     * cycles by carrying their original tag number. Used by the
     * apply-operations flow when a queued drop fires.
     *
     * Implementations replace the part *in place* in the parent message's
     * part array. The replaced part's `kind` shifts to "structural" so
     * subsequent transform passes don't double-process it.
     *
     * Returns true on success; returns false if the part can't be
     * replaced (e.g. it's already a sentinel, or it's an image part).
     */
    replaceWithSentinel(sentinelText: string): boolean;
}

/**
 * A single message in the transcript, exposing role + ordered parts.
 *
 * Lifetime: a TranscriptMessage is valid only within a single transform
 * pass. Adapters do not guarantee identity across passes — callers must
 * use `info.id` for cross-pass correlation, never the message reference.
 */
export interface TranscriptMessage {
    /**
     * Lightweight metadata exposed for tagging, sentinel persistence, and
     * cross-pass correlation. Adapters fill these from harness-native
     * fields:
     *
     * - id: provider-stable message ID (OpenCode `msg_...`, Pi entryId).
     * - role: "user" | "assistant" | "system" | "tool" | other custom roles.
     * - sessionId: session identifier, used to scope DB writes.
     *
     * IMPORTANT for Pi: Pi's `ToolResultMessage` has role "toolResult"
     * which the OpenCode-derived transform code expects to NOT be present
     * (OpenCode folds tool results into the next user message's parts).
     * The Pi adapter therefore exposes tool-result messages as parts of a
     * synthetic "user" message in the transcript view, even though the
     * underlying Pi storage has them as separate top-level entries. This
     * is the *only* shape normalization the adapter performs.
     */
    readonly info: { id?: string; role: string; sessionId?: string };

    /** Ordered parts. Same ordering invariants as the underlying source. */
    readonly parts: TranscriptPart[];
}

/**
 * Adapter contract: everything the transform pipeline calls on a
 * harness-specific transcript implementation.
 *
 * Adapters are owned by the harness adapter layer (OpenCode's
 * messages-transform.ts, Pi's context-event handler). The shared
 * transform code receives a Transcript and operates only through this
 * interface — it never imports from `@opencode-ai/sdk` or
 * `@mariozechner/pi-ai`.
 */
export interface Transcript {
    /** Ordered messages in the current pass. */
    readonly messages: TranscriptMessage[];

    /**
     * Adapter identification. Useful for:
     * - Logging (`magic-context[opencode]` vs `magic-context[pi]`).
     * - Per-harness behaviors gated at adapter level (e.g. opencode-only
     *   compaction marker injection).
     * - Test assertions confirming the right adapter ran.
     */
    readonly harness: "opencode" | "pi";

    /**
     * Commit accumulated mutations to the underlying source array.
     *
     * For OpenCode: no-op — parts are mutated directly in `Part.text`/
     * `Part.state.output` and OpenCode reads them back from the same
     * array, so changes are already visible.
     *
     * For Pi: rebuilds a new `AgentMessage[]` from the dirty messages
     * and stores it on the adapter so `pi.on("context", ...)` can return
     * `{ messages }` to Pi. Idempotent: calling twice is safe.
     *
     * Always called exactly once per pass, after the transform pipeline
     * finishes. Adapters that don't need it implement it as a no-op.
     */
    commit(): void;
}

/**
 * Sentinel marker for transcript parts that should be ignored by all
 * downstream transform stages (tagging, drops, indexing). Adapters set
 * this on parts that exist only as structural artifacts (e.g. OpenCode's
 * `step-start`/`step-finish`).
 *
 * Exported so harness adapters can stamp it on synthetic parts they
 * create internally and so test fixtures can construct synthetic
 * transcripts without needing real OpenCode/Pi structures.
 */
export const STRUCTURAL_SENTINEL_KIND: TranscriptPartKind = "structural";
