import { createHash } from "node:crypto";
import {
    DREAMER_AGENT,
    DREAMER_DOCS_AGENT,
    DREAMER_MEMORY_MAPPER_AGENT,
    DREAMER_MEMORY_MAPPER_ALLOWED_TOOLS,
    DREAMER_PRIMER_INVESTIGATOR_AGENT,
    DREAMER_RETROSPECTIVE_AGENT,
} from "../../agents/dreamer";
import { DREAMER_PRIMER_INVESTIGATOR_ALLOWED_TOOLS } from "../../agents/permissions";
import {
    createDreamTokenBudget,
    TOKEN_BUDGET_FINALIZE_MESSAGE,
} from "../../features/magic-context/dreamer/token-budget";
import {
    HiddenCompletionRefusal,
    type HiddenRunIdentity,
} from "../../hooks/magic-context/compartment-runner-types";
import { stripWellFormedLeadingTagPrefix } from "../../hooks/magic-context/tag-content-primitives";
import {
    needsBlockedRead,
    TOOL_USE_DISABLED,
    withBlockedReadInstruction,
} from "../../shared/hidden-zen-read";
import { withoutHistorianTailCache } from "../../shared/historian-cache";
import { log } from "../../shared/logger";
import type { PromptArgs } from "../../shared/model-suggestion-retry";
import { isHiddenRunHolder } from "../hidden-run-holder";
import {
    claudeAgentInstructionsText,
    deliversInstructionsInUserMessage,
} from "./claude-agent-instructions";
import type { SessionContext, V2AgentDomain } from "./types";

export const HIDDEN_HISTORIAN_AGENT = "historian";
export const HIDDEN_DREAMER_AGENT = "dreamer-classifier";
export const HIDDEN_CURATE_AGENT = DREAMER_AGENT;

const AGENT_TOOLS: Record<string, readonly string[]> = {
    [HIDDEN_HISTORIAN_AGENT]: [],
    [HIDDEN_DREAMER_AGENT]: [],
    [HIDDEN_CURATE_AGENT]: ["ctx_memory"],
    [DREAMER_MEMORY_MAPPER_AGENT]: DREAMER_MEMORY_MAPPER_ALLOWED_TOOLS,
    [DREAMER_PRIMER_INVESTIGATOR_AGENT]: DREAMER_PRIMER_INVESTIGATOR_ALLOWED_TOOLS,
    [DREAMER_RETROSPECTIVE_AGENT]: ["ctx_search"],
};
const AGENT_STEPS: Record<string, number> = {
    [HIDDEN_CURATE_AGENT]: 150,
    [DREAMER_MEMORY_MAPPER_AGENT]: 60,
    [DREAMER_DOCS_AGENT]: 60,
    [DREAMER_PRIMER_INVESTIGATOR_AGENT]: 40,
    [DREAMER_RETROSPECTIVE_AGENT]: 40,
};

export function hiddenAgentFor(identity: HiddenRunIdentity): string {
    if (identity.kind === "dreamer-task" && identity.agent === DREAMER_DOCS_AGENT)
        return DREAMER_MEMORY_MAPPER_AGENT;
    return identity.kind === "dreamer-task" && AGENT_TOOLS[identity.agent]
        ? identity.agent
        : identity.kind === "dreamer-task"
          ? HIDDEN_DREAMER_AGENT
          : HIDDEN_HISTORIAN_AGENT;
}

export function hiddenToolLoop(identity: HiddenRunIdentity): boolean {
    return identity.kind === "dreamer-task" && AGENT_STEPS[identity.agent] !== undefined;
}

/**
 * The tools a Magic Context hidden agent may call, or undefined when `agent` is
 * not one of the hidden agents this plugin registers. Every id registered by
 * `registerHiddenChildAgents` is a Magic Context carrier: the registration
 * overwrites any agent of the same name, so a session running one of these ids
 * is always running this plugin's carrier.
 */
export function hiddenAgentAllowedTools(agent: string | undefined): readonly string[] | undefined {
    return agent !== undefined && Object.hasOwn(AGENT_TOOLS, agent)
        ? AGENT_TOOLS[agent]
        : undefined;
}

/**
 * Why a hidden run ends when its plugin instance is disposed. OpenCode 2 disposes
 * a plugin instance when it reloads the plugin (`/plugins` then ctrl+u, a
 * rewritten config, a location reinitialising) and loads a fresh instance in the
 * same process. The disposed instance cancels its in-flight hidden runs and the
 * run's error carries this text; the instance that replaces it refuses any turn
 * of such a child with the same text, so both sides of a reload name one cause.
 */
export const HIDDEN_RUN_DISPOSED_REASON =
    "the Magic Context plugin instance that started this hidden run was disposed (OpenCode reloaded the plugin), so the run was cancelled; the work is retried on a later run";

/**
 * Children of disposed instances, shared by every Magic Context instance in this
 * process. A reloaded plugin is a new module instance, so module state is not
 * shared; `globalThis` is. Only used to give a refusal its reason: a session in
 * this set is refused exactly as any other unregistered hidden child is.
 */
const DISPOSED_CHILDREN_KEY = Symbol.for("@cortexkit/magic-context/v2/disposed-hidden-children");
const DISPOSED_CHILDREN_LIMIT = 512;

function disposedChildren(): Set<string> {
    const store = globalThis as { [DISPOSED_CHILDREN_KEY]?: Set<string> };
    store[DISPOSED_CHILDREN_KEY] ??= new Set<string>();
    return store[DISPOSED_CHILDREN_KEY];
}

/** Record that `sessionID` belonged to a plugin instance that has been disposed. */
export function noteChildOfDisposedInstance(sessionID: string): void {
    const children = disposedChildren();
    children.delete(sessionID);
    children.add(sessionID);
    // Oldest first: a Set iterates in insertion order.
    while (children.size > DISPOSED_CHILDREN_LIMIT) {
        const oldest = children.values().next().value;
        if (oldest === undefined) break;
        children.delete(oldest);
    }
}

/** Whether `sessionID` is a hidden child whose plugin instance was disposed. */
export function isChildOfDisposedInstance(sessionID: string): boolean {
    return disposedChildren().has(sessionID);
}

/** Clears the process-wide record, for tests. */
export function __resetDisposedChildrenForTests(): void {
    disposedChildren().clear();
}

/** One OpenCode 2 permission rule: the action is the tool id, the resource a pattern. */
export interface HiddenPermissionRule {
    action: string;
    resource: string;
    effect: "allow" | "deny";
}

/**
 * Deny everything, then expose the agent's model-specific tool surface.
 *
 * OpenCode 2 evaluates a tool call against the agent's rules followed by the
 * session's rules, and the LAST matching rule wins. Its config loader appends
 * the user's global `permissions` to every agent after plugins have set theirs,
 * so on the agent alone a user's `edit: allow` lands after this deny and wins.
 * The same list is therefore also written onto each hidden child session when
 * it is created: session rules come after every agent rule, which is the one
 * place where these rules are guaranteed to be evaluated last.
 */
export function hiddenChildPermissions(agent: string, providerID?: string): HiddenPermissionRule[] {
    // Read must survive host filtering before the context hook can select it for
    // Zen. It stays off the executable allowlist and is removed for other providers.
    const tools = AGENT_TOOLS[agent] ?? [];
    const visible = tools.length === 0 && needsBlockedRead(agent, providerID) ? ["read"] : tools;
    return [
        { action: "*", resource: "*", effect: "deny" },
        ...visible.map((tool) => ({
            action: tool,
            resource: "*",
            effect: "allow" as const,
        })),
    ];
}

export async function registerHiddenChildAgents(
    agent: Pick<V2AgentDomain, "transform">,
): Promise<void> {
    await agent.transform((editor) => {
        for (const id of Object.keys(AGENT_TOOLS)) {
            editor.update(id, (config) => {
                config.system = "Magic Context hidden completion carrier.";
                config.description = "Internal Magic Context hidden completion carrier.";
                config.mode = "primary";
                config.hidden = true;
                config.request.settings = {};
                config.request.headers = {};
                config.request.body = {};
                config.steps = AGENT_STEPS[id];
                // OpenCode 2.0.15's tool permission action is the tool id, not "tool".
                // See @opencode/schema/dist/permission.d.ts (Request.action/resources)
                // and the host's session request tool filtering; resource is "*".
                // The host appends the user's own rules after these; see
                // hiddenChildPermissions for where they are made to win.
                config.permissions = hiddenChildPermissions(id, "opencode");
            });
        }
    });
}

/**
 * Why a tool call must not run, or undefined when it may. A call is refused
 * when it comes from a Magic Context hidden child (a session this instance
 * registered, or any session running one of the hidden agent ids) and the tool
 * is not on that agent's allowlist. The user's own permission settings do not
 * enter into it: these agents are unattended and their allowlists are fixed.
 */
export function hiddenToolCallRefusal(
    call: { tool: string; sessionID: string; agent?: string },
    hook: Pick<HiddenChildHook, "owns" | "agentFor">,
): string | undefined {
    const owned = hook.owns(call.sessionID);
    // A child of a disposed instance has no run left to serve: its instance
    // cancelled the run, so none of its tool calls may execute here.
    if (!owned && isChildOfDisposedInstance(call.sessionID))
        return `Magic Context hidden child ${call.sessionID} refused: ${HIDDEN_RUN_DISPOSED_REASON}; ${call.tool} refused`;
    const agent = owned ? (hook.agentFor(call.sessionID) ?? call.agent) : call.agent;
    const allowed = hiddenAgentAllowedTools(agent);
    if (allowed === undefined) {
        // A session this instance registered whose agent cannot be resolved has
        // no known allowlist; nothing is allowed rather than everything.
        return owned
            ? `Magic Context hidden child ${call.sessionID} has no tool allowlist; ${call.tool} refused`
            : undefined;
    }
    if (allowed.includes(call.tool)) return undefined;
    if (owned && allowed.length === 0) return `${TOOL_USE_DISABLED}; ${call.tool} refused`;
    return `Magic Context hidden agent ${agent} may only use ${allowed.length > 0 ? allowed.join(", ") : "no tools"}; ${call.tool} refused`;
}

export class HiddenAgentStepLimit extends Error {
    readonly agent: string;
    readonly cap: number;

    constructor(agent: string, cap: number) {
        super(`Hidden agent ${agent} exceeded its ${cap}-step limit`);
        this.name = "HiddenAgentStepLimit";
        this.agent = agent;
        this.cap = cap;
    }
}

export interface HiddenChildAttempt {
    childSessionId: string;
    identity: HiddenRunIdentity;
    request: PromptArgs;
    shaped: boolean;
    steps?: number;
    stepLimit?: HiddenAgentStepLimit;
    refusal?: HiddenCompletionRefusal;
    budgetExceeded?: Error;
    budget?: ReturnType<typeof createDreamTokenBudget>;
    observedMessages?: SessionContext["messages"];
    marker?: string;
    wireRequests?: number;
}

/**
 * Every non-empty text of a user message, in order: its string body, or each of
 * its text parts. OpenCode 2.0.5 may use a string body, extra parts, or
 * input_text. A message with another role has none.
 */
function userTexts(message: SessionContext["messages"][number] | undefined): string[] {
    if (!message || (message.role !== undefined && message.role !== "user")) return [];
    const content: unknown = message.content;
    if (typeof content === "string" && content.length > 0) return [content];
    const parts = Array.isArray(content)
        ? content
        : Array.isArray(message.parts)
          ? message.parts
          : [];
    const texts: string[] = [];
    for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const record = part as { type?: unknown; text?: unknown };
        if (typeof record.text !== "string" || record.text.length === 0) continue;
        if (record.type === undefined || record.type === "text" || record.type === "input_text") {
            texts.push(record.text);
        }
    }
    return texts;
}

/** First text of the last message on a context draft, when that message is a user message. */
export function newestUserText(draft: SessionContext): string | undefined {
    return userTexts(draft.messages.at(-1))[0];
}

/**
 * Generation options for one hidden prompt, carrying only what the user asked
 * for. An output cap is sent under both of OpenCode's names for the same
 * budget: the public option is `maxOutputTokens`, while its GA
 * GenerationOptions carrier serializes the value from `maxTokens`.
 *
 * Nothing is sent by default. A fixed cap used to go out on every hidden
 * prompt, which made every run fail on backends that reject the parameter
 * outright — an OpenAI subscription login answers "Unsupported parameter:
 * max_output_tokens" — and the cap was never load-bearing here. Reserving room
 * for the producer's output is arithmetic done before the run (see
 * `producerInputTokenLimit`), and a producer that runs away is caught
 * afterwards by the length-capped output check.
 *
 * `identity.maxOutputTokens` and `request.body.temperature` are authored
 * values: absent means the user configured nothing, so neither may be filled
 * in with a fallback on the way here.
 */
function authoredOptions(attempt: HiddenChildAttempt): Record<string, number> {
    const cap = attempt.identity.maxOutputTokens;
    const temperature = attempt.request.body.temperature;
    return {
        ...(typeof cap === "number" && Number.isFinite(cap) && cap > 0
            ? { maxOutputTokens: cap, maxTokens: cap }
            : {}),
        ...(typeof temperature === "number" && Number.isFinite(temperature) ? { temperature } : {}),
    };
}

/** The registered prompt as text parts, or undefined when it is not text-only. */
function calibratedParts(
    attempt: HiddenChildAttempt,
): Array<{ type: "text"; text: string }> | undefined {
    const parts = attempt.request.body.parts;
    if (
        !Array.isArray(parts) ||
        parts.length === 0 ||
        parts.some(
            (part) =>
                !part ||
                typeof part !== "object" ||
                (part as { type?: unknown }).type !== "text" ||
                typeof (part as { text?: unknown }).text !== "string",
        )
    ) {
        return undefined;
    }
    return parts.map((part) => ({ type: "text", text: (part as { text: string }).text }));
}

/**
 * Replaces a compacted history in OpenCode 2's context: one user message wrapping
 * the compaction summary (and, when the host kept any, the newest messages as
 * serialized text). Source: `toLLMMessage`, case "compaction", in
 * packages/core/src/session/runner/to-llm-message.ts. Every line is fixed by the
 * host except the summary, the recent text, and the one explanatory sentence:
 *
 *   <conversation-checkpoint>
 *   The following is a summary and serialized record of earlier conversation. ...
 *   (empty line)
 *   <summary>
 *   {summary}
 *   </summary>
 *   (empty line)            \
 *   <recent-context>         | 2.0.15 always writes this block, even when empty;
 *   {recent}                 | 2.0.21 writes it only when there is recent text.
 *   </recent-context>       /
 *   </conversation-checkpoint>
 */
const CHECKPOINT_OPEN = "<conversation-checkpoint>";
const CHECKPOINT_CLOSE = "</conversation-checkpoint>";

/**
 * The one-line summary of a host compaction checkpoint, or undefined when
 * `text` is not a checkpoint in exactly the shape documented above. Only a
 * single-line summary is returned, because the only summary the hidden-child
 * bridge accepts is a run marker, which never spans lines.
 */
export function hostCheckpointSummary(text: string): string | undefined {
    const lines = text.split("\n");
    if (
        lines.length < 7 ||
        lines[0] !== CHECKPOINT_OPEN ||
        lines[1]?.trim() === "" ||
        lines[2] !== "" ||
        lines[3] !== "<summary>" ||
        lines[5] !== "</summary>" ||
        lines.at(-1) !== CHECKPOINT_CLOSE
    ) {
        return undefined;
    }
    const rest = lines.slice(6, -1);
    const recentBlock =
        rest.length >= 3 &&
        rest[0] === "" &&
        rest[1] === "<recent-context>" &&
        rest.at(-1) === "</recent-context>";
    if (rest.length !== 0 && !recentBlock) return undefined;
    return lines[4];
}

/**
 * The texts a hidden child's user message may legitimately carry for a run
 * marker: the marker itself, the marker behind Magic Context's own leading tag
 * prefix, or a host compaction checkpoint whose summary is the marker. The
 * last one exists because OpenCode 2 can compact a hidden child before its
 * first step (the host sizes the child by its own system prompt, instructions
 * and tools, never by the calibrated prompt that replaces them), and that
 * compaction folds the marker's message into a checkpoint. Magic Context's
 * compaction hook answers a hidden child's compaction with exactly the marker
 * of the run in flight (see `HiddenChildHook.compactionSummary`), so the
 * checkpoint still names the run it belongs to.
 */
function markerCandidates(text: string): string[] {
    const stripped = stripWellFormedLeadingTagPrefix(text);
    const summary = hostCheckpointSummary(text);
    return [text, stripped, ...(summary === undefined ? [] : [summary])];
}

/**
 * Whether any of a message's texts carries `marker` in a form `markerCandidates`
 * accepts. Another plugin may put its own text parts ahead of the marker's part
 * (Superpowers prepends its bootstrap to the first user message of every
 * session without a parent, which includes every hidden run). The message that
 * carries the marker is replaced wholesale by the registered prompt, so text
 * another plugin added to it never reaches the hidden model.
 */
function carriesMarker(texts: readonly string[], marker: string): boolean {
    return texts.some((text) => markerCandidates(text).includes(marker));
}

/** Number of leading bytes `a` and `b` share. */
function sharedPrefixBytes(a: Buffer, b: Buffer): number {
    let offset = 0;
    while (offset < a.length && offset < b.length && a[offset] === b[offset]) offset++;
    return offset;
}

/**
 * The text a refusal reports as received: of the message's texts, the one
 * whose marker forms share the longest leading bytes with one of `markers`, or
 * the first text when none shares any. A message that only lacks the marker
 * because another plugin's text came first is then reported by the part that
 * resembles the marker, not by the other plugin's text.
 */
function closestText(texts: readonly string[], markers: readonly string[]): string | undefined {
    let closest = texts[0];
    let best = 0;
    for (const text of texts) {
        for (const candidate of markerCandidates(text)) {
            const bytes = Buffer.from(candidate, "utf8");
            for (const marker of markers) {
                const shared = sharedPrefixBytes(bytes, Buffer.from(marker, "utf8"));
                if (shared > best) {
                    best = shared;
                    closest = text;
                }
            }
        }
    }
    return closest;
}

/** Most text parts a refusal lists digests for, so one odd message cannot flood the log. */
const REFUSAL_PART_DIGESTS = 8;

function textDigest(text: string): { length: number; sha256: string } {
    return {
        length: text.length,
        sha256: createHash("sha256").update(text).digest("hex").slice(0, 16),
    };
}

/** Byte offset and up to eight bytes from each side where `a` and `b` first differ. */
function firstDifference(
    a: string,
    b: string,
): { offset: number; received: string; registered: string } | undefined {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    const offset = sharedPrefixBytes(left, right);
    if (offset === left.length && offset === right.length) return undefined;
    return {
        offset,
        received: left.subarray(offset, offset + 8).toString("hex"),
        registered: right.subarray(offset, offset + 8).toString("hex"),
    };
}

/**
 * Owns the fail-closed bridge between a child prompt marker and the exact
 * calibrated request. Hidden children can still be selected by a user in OpenCode 2,
 * so a user-selected or otherwise unregistered prompt must never inherit the
 * child's privileged internal identity.
 */
export class HiddenChildHook {
    /** Each child this instance created, with the agent it was created to run. */
    private readonly childIDs = new Map<string, string | undefined>();
    private readonly attempts = new Map<string, HiddenChildAttempt>();
    private readonly active = new Map<string, HiddenChildAttempt>();
    private readonly cacheWarnings = new Set<string>();

    constructor(private readonly note: (message: string) => void = log) {}

    registerChild(sessionID: string, agent?: string): void {
        if (agent !== undefined || !this.childIDs.has(sessionID))
            this.childIDs.set(sessionID, agent ?? this.childIDs.get(sessionID));
    }

    /** The agent a registered child was created to run, when it is known. */
    agentFor(sessionID: string): string | undefined {
        return this.childIDs.get(sessionID);
    }

    registerAttempt(marker: string, attempt: HiddenChildAttempt): void {
        this.registerChild(attempt.childSessionId);
        attempt.marker = marker;
        this.attempts.set(marker, attempt);
    }

    releaseAttempt(marker: string): void {
        const attempt = this.attempts.get(marker);
        this.attempts.delete(marker);
        if (attempt && this.active.get(attempt.childSessionId) === attempt) {
            this.active.delete(attempt.childSessionId);
        }
    }

    owns(sessionID: string): boolean {
        // A holder has no registered attempt, even after a restart, so the existing
        // hidden-run guard refuses a prompt on it rather than handing it to the transform.
        return this.childIDs.has(sessionID) || isHiddenRunHolder(sessionID);
    }

    /** Runs on the final outbound HTTP request, after the SDK inserts automatic cache markers. */
    async cacheRequest(draft: {
        sessionID: string;
        kind: string;
        request: Request;
    }): Promise<void> {
        const attempt = this.active.get(draft.sessionID);
        if (
            !this.owns(draft.sessionID) ||
            !attempt ||
            attempt.identity.kind !== "historian" ||
            draft.kind !== "primary" ||
            attempt.request.cacheTail !== "skip"
        )
            return;
        // Leave subsequent transport requests unchanged so retries keep their cache markers.
        if ((attempt.wireRequests ?? 0) > 0) return;
        attempt.wireRequests = 1;
        try {
            const original = await draft.request.clone().text();
            const body = withoutHistorianTailCache(original);
            if (body === original) return;
            const headers = new Headers(draft.request.headers);
            headers.delete("content-length");
            draft.request = new Request(draft.request, { body, headers });
        } catch (error) {
            if (!this.cacheWarnings.has(draft.sessionID)) {
                this.cacheWarnings.add(draft.sessionID);
                try {
                    this.note(
                        `Historian cache optimization skipped for ${draft.sessionID}: ${String(error)}`,
                    );
                } catch {
                    // Diagnostic failures must not prevent the original request.
                }
            }
        }
    }

    /**
     * The summary Magic Context gives the host when it compacts a hidden child:
     * the marker of the run in flight on that child, or undefined for a session
     * this bridge does not own. A hidden child's history is never worth
     * summarizing, since the first step replaces it wholesale and later steps
     * keep only this run's own messages, but the host cannot be told not to
     * compact. Answering with the marker keeps the checkpoint recognizable as
     * this run's start, and keeps the host from summarizing with a model call.
     * An owned child with no run in flight, or with more than one, is refused
     * here exactly as the context guard would refuse its prompt.
     */
    compactionSummary(sessionID: string, agent?: string): string | undefined {
        if (!this.owns(sessionID)) {
            // Another instance's hidden child: refused here exactly as `apply`
            // refuses its turn, rather than summarized as a user conversation.
            if (isChildOfDisposedInstance(sessionID)) {
                this.refuse(
                    `Refusing to compact a Magic Context hidden child of a disposed plugin instance: ${HIDDEN_RUN_DISPOSED_REASON}`,
                    { sessionID, messages: [] },
                    undefined,
                    undefined,
                    "hidden_instance_disposed",
                );
            }
            if (hiddenAgentAllowedTools(agent) !== undefined) {
                this.refuse(
                    "Refusing to compact a Magic Context hidden-agent session this instance did not register",
                    { sessionID, messages: [] },
                    undefined,
                );
            }
            return undefined;
        }
        const active = this.active.get(sessionID);
        const pending = [...this.attempts.values()].filter(
            (attempt) => attempt.childSessionId === sessionID && !attempt.shaped,
        );
        const inFlight = active ? [active] : pending;
        const marker = inFlight.length === 1 ? inFlight[0]?.marker : undefined;
        if (marker === undefined) {
            this.refuse(
                "Refusing to compact a Magic Context hidden-run session with no single run in flight",
                { sessionID, messages: [] },
                undefined,
                inFlight.length,
            );
        }
        return marker;
    }

    /**
     * Log what the guard saw against what it expected, then throw. Only lengths,
     * short hashes and the first differing bytes are written, so a mismatch can
     * be diagnosed from the log without copying either prompt into it.
     *
     * `texts` are the newest user message's texts. The one reported as
     * received, and compared with each registered marker, is the one closest
     * to a registered marker (see `closestText`). A message with more than one
     * text also lists every text's digest, up to `REFUSAL_PART_DIGESTS`, so
     * text another plugin added to the message can be told apart.
     */
    private refuse(
        reason: string,
        draft: Pick<SessionContext, "sessionID" | "messages">,
        texts: readonly string[] | undefined,
        inFlight?: number,
        code: HiddenCompletionRefusal["code"] = "hidden_prompt_unrecognized",
    ): never {
        const markers = [...this.attempts.values()]
            .filter((attempt) => attempt.childSessionId === draft.sessionID && attempt.marker)
            .map((attempt) => ({ attempt, marker: attempt.marker as string }));
        const raw =
            texts === undefined
                ? undefined
                : closestText(
                      texts,
                      markers.map(({ marker }) => marker),
                  );
        const registered = markers.map(({ attempt, marker }) => ({
            ...textDigest(marker),
            shaped: attempt.shaped,
            ...(raw === undefined ? {} : { first_difference: firstDifference(raw, marker) }),
        }));
        const newest = draft.messages.at(-1);
        const summary = raw === undefined ? undefined : hostCheckpointSummary(raw);
        this.note(
            `[magic-context] hidden child refused: ${reason} ${JSON.stringify({
                session: draft.sessionID,
                messages: draft.messages.length,
                newest_role: newest?.role ?? null,
                received: raw === undefined ? null : textDigest(raw),
                ...(texts !== undefined && texts.length > 1
                    ? { received_parts: texts.slice(0, REFUSAL_PART_DIGESTS).map(textDigest) }
                    : {}),
                checkpoint_summary: summary === undefined ? null : textDigest(summary),
                registered,
                active: this.active.has(draft.sessionID),
                ...(inFlight === undefined ? {} : { in_flight: inFlight }),
            })}`,
        );
        const refusal = new HiddenCompletionRefusal(code, reason, true);
        // The host serializes hook failures as an unknown session error. Retain
        // the typed local cause on this child's attempt, never infer it from a
        // provider's arbitrary error text or assign it to another child's run.
        for (const attempt of this.attempts.values()) {
            if (attempt.childSessionId === draft.sessionID) attempt.refusal = refusal;
        }
        throw refusal;
    }

    /**
     * The run's first user message: its registered prompt, preceded on the
     * Claude Agent provider by the task's system text, which that provider
     * would otherwise never send (see `deliversInstructionsInUserMessage`).
     * Every step and retry rebuilds it from the same inputs, so its bytes stay
     * identical for the whole run.
     */
    private firstMessageParts(
        attempt: HiddenChildAttempt,
        draft: SessionContext,
        texts: readonly string[],
        system: string,
    ): Array<{ type: "text"; text: string }> {
        const parts = calibratedParts(attempt);
        if (!parts)
            this.refuse("Hidden completion accepts text-only calibrated prompts", draft, texts);
        if (!deliversInstructionsInUserMessage(draft.model.providerID)) return parts;
        return [{ type: "text", text: claudeAgentInstructionsText(system) }, ...parts];
    }

    /**
     * Returns false only for an ordinary user session that this bridge does not own.
     *
     * A session running one of the hidden agent ids that this instance did not
     * register is refused, not passed through. OpenCode 2 runs each session's
     * hooks in the plugin instance of that session's location, so a hidden child
     * created by another instance (another directory, or this directory before a
     * restart) arrives here unshaped: its user message is a bare run marker, and
     * passing it on would send the marker to the model with whatever tools the
     * user's own permissions allow.
     *
     * A child whose instance was disposed by a plugin reload is refused with that
     * reason, whatever agent the host reports for it: its instance has cancelled
     * the run, and this instance has no record of the prompt it was sent.
     */
    apply(draft: SessionContext): boolean {
        if (!this.owns(draft.sessionID)) {
            if (isChildOfDisposedInstance(draft.sessionID)) {
                this.refuse(
                    `Refusing a turn of a Magic Context hidden child of a disposed plugin instance: ${HIDDEN_RUN_DISPOSED_REASON}`,
                    draft,
                    userTexts(draft.messages.at(-1)),
                    undefined,
                    "hidden_instance_disposed",
                );
            }
            if (hiddenAgentAllowedTools(draft.agent) !== undefined) {
                this.refuse(
                    "Refusing a Magic Context hidden-agent turn this instance did not register",
                    draft,
                    userTexts(draft.messages.at(-1)),
                );
            }
            return false;
        }

        // The run is recognized by its marker in any text of the newest user
        // message, not only the first (see `carriesMarker`). A message naming
        // more than one registered run does not identify a single run, so it
        // is refused rather than credited to whichever marker comes first.
        const texts = userTexts(draft.messages.at(-1));
        const named = new Set<HiddenChildAttempt>();
        for (const text of texts) {
            for (const candidate of markerCandidates(text)) {
                const registered = this.attempts.get(candidate);
                if (registered) {
                    named.add(registered);
                    break;
                }
            }
        }
        if (named.size > 1) {
            this.refuse(
                "Refusing a prompt that names more than one Magic Context hidden run",
                draft,
                texts,
            );
        }
        const attempt: HiddenChildAttempt | undefined = [...named][0];
        const current = this.active.get(draft.sessionID);
        const selected = attempt ?? current;
        if (
            !selected ||
            selected.childSessionId !== draft.sessionID ||
            (attempt && current && current !== attempt)
        ) {
            this.refuse(
                "Refusing an unregistered prompt on a Magic Context hidden-run session",
                draft,
                texts,
            );
        }
        if (selected.request.signal?.aborted) {
            throw new Error("Hidden completion prompt aborted");
        }

        if (!selected.shaped) {
            if (!attempt)
                this.refuse("Hidden child first step requires a registered marker", draft, texts);
            this.active.set(draft.sessionID, selected);
        }
        const steps = (selected.steps ?? 0) + 1;
        const cap = AGENT_STEPS[selected.identity.agent];
        if (cap !== undefined && steps > cap) {
            selected.stepLimit = new HiddenAgentStepLimit(selected.identity.agent, cap);
            throw selected.stepLimit;
        }
        selected.steps = steps;
        const system =
            typeof selected.request.body.system === "string"
                ? selected.request.body.system
                : selected.identity.system;
        const blockedRead =
            needsBlockedRead(selected.identity.agent, draft.model.providerID) &&
            draft.tools.read !== undefined;
        const systemText = blockedRead
            ? withBlockedReadInstruction(system, selected.identity)
            : system;
        draft.system = [{ type: "text", text: systemText }];
        if (!selected.shaped) {
            draft.messages = [
                {
                    role: "user",
                    content: this.firstMessageParts(selected, draft, texts, systemText),
                },
            ];
        } else {
            // Later steps preserve this run's tool history, starting at its marker or
            // the host checkpoint that replaced it during compaction. Provider retries
            // must use the same calibrated prompt rather than the carrier placeholder.
            // Another plugin may add its own text to the marker's message on every
            // step (Superpowers adds its bootstrap to each request of a session
            // without a parent); replacing that message drops the text again.
            let start = -1;
            draft.messages.forEach((message, index) => {
                if (
                    selected.marker !== undefined &&
                    carriesMarker(userTexts(message), selected.marker)
                )
                    start = index;
            });
            const first = draft.messages[start];
            if (!first) {
                this.refuse(
                    "Hidden child history does not contain this run's registered marker",
                    draft,
                    texts,
                );
            }
            // The host saves the placeholder user prompt rather than the calibrated
            // text sent on step one. Replace only that placeholder, preserving all
            // assistant tool calls and tool results after it.
            draft.messages = [
                { ...first, content: this.firstMessageParts(selected, draft, texts, systemText) },
                ...draft.messages.slice(start + 1),
            ];
        }
        // Replaced wholesale, never merged: the carrier sends exactly the
        // authored options and never inherits the host's own generation defaults.
        draft.options = authoredOptions(selected);
        const allowed = blockedRead
            ? ["read"]
            : (AGENT_TOOLS[hiddenAgentFor(selected.identity)] ?? []);
        draft.tools = Object.fromEntries(
            allowed.flatMap((id) => (draft.tools[id] ? [[id, draft.tools[id]]] : [])),
        );
        // Leave room for the closed manifest before the host's hard ceiling. The
        // context hook can remove tools synchronously, so no further investigation
        // executes while the model is asked to return only its checked subset.
        if (selected.identity.agent === DREAMER_MEMORY_MAPPER_AGENT && steps >= cap - 2) {
            selected.budget ??= createDreamTokenBudget(
                typeof selected.identity.metadata?.tokenBudget === "number"
                    ? selected.identity.metadata.tokenBudget
                    : Number.MAX_SAFE_INTEGER,
            );
            const decision = selected.budget.finalize();
            draft.tools = {};
            draft.messages.push({
                role: "user",
                content: [{ type: "text", text: TOKEN_BUDGET_FINALIZE_MESSAGE }],
            });
            if (decision === "finalize") {
                const onBudgetUpdate = selected.identity.metadata?.onBudgetUpdate;
                if (typeof onBudgetUpdate === "function")
                    onBudgetUpdate({ ...selected.budget.snapshot(), sessionId: draft.sessionID });
            }
        }
        selected.observedMessages = draft.messages;
        selected.shaped = true;
        return true;
    }
}
