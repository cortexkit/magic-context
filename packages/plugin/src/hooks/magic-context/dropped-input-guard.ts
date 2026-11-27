import { refuseBudgetedToolCall } from "../../features/magic-context/dreamer/token-budget";
import { blockedReadSessionRefusal } from "../../shared/hidden-zen-read";
import { sessionLog } from "../../shared/logger";

// The pre-fix truncated render kept at most five characters of the original
// value before the sentinel, so a copied placeholder always has that exact
// shape. Matching only that shape keeps a legitimate value that merely ends
// with the sentinel text (a log line, a fixture) executable.
const LEGACY_TRUNCATED_VALUE = /^[\s\S]{0,5}\.\.\.\[truncated\]$/;

// Longest quote of the received arguments the refusal repeats back. Enough to
// show the model the placeholder it wrote without echoing a large payload.
const MAX_QUOTED_ARGUMENTS = 160;
// Tools with very wide schemas would otherwise turn the refusal into a manual.
const MAX_LISTED_PARAMETERS = 12;
// Sessions that refused and then went away never reach the reset, so the
// per-session counters are bounded rather than kept for the process lifetime.
const MAX_TRACKED_SESSIONS = 1000;

function isDroppedPlaceholderString(value: string): boolean {
    return (
        (value.startsWith("[dropped §") && value.endsWith("§]")) ||
        LEGACY_TRUNCATED_VALUE.test(value) ||
        value === "[object]" ||
        /^\[\d+ items\]$/.test(value)
    );
}

export function droppedInputMarker(tagId: number): { dropped: string } {
    return { dropped: `[dropped §${tagId}§]` };
}

export function containsDroppedInputPlaceholder(value: unknown): boolean {
    const seen = new WeakSet<object>();

    const visit = (candidate: unknown): boolean => {
        if (typeof candidate === "string") return isDroppedPlaceholderString(candidate);
        if (candidate === null || typeof candidate !== "object") return false;
        if (seen.has(candidate)) return false;
        seen.add(candidate);
        if (Array.isArray(candidate)) return candidate.some(visit);
        return Object.values(candidate as Record<string, unknown>).some(visit);
    };

    return visit(value);
}

export interface ToolParameterNames {
    required: string[];
    optional: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}

function isOptionalZodField(field: unknown): boolean {
    if (!isRecord(field)) return false;
    const isOptional = (field as { isOptional?: unknown }).isOptional;
    if (typeof isOptional === "function") {
        try {
            return (isOptional as () => boolean).call(field) === true;
        } catch {
            // Fall through to the internal marker below.
        }
    }
    const internals = (field as { _zod?: { optin?: unknown } })._zod;
    return internals?.optin === "optional";
}

/**
 * Read a tool's parameter names from its schema. Pi and OpenCode 2 hand over
 * JSON Schema (`properties` + `required`); the OpenCode 1 `tool.definition`
 * hook hands over the tool's zod object. Anything else yields undefined so the
 * refusal never invents names it could not see.
 */
export function toolParameterNames(schema: unknown): ToolParameterNames | undefined {
    if (!isRecord(schema)) return undefined;

    const properties = schema.properties;
    if (isRecord(properties) && !Array.isArray(properties)) {
        const names = Object.keys(properties);
        const requiredList = Array.isArray(schema.required) ? schema.required : [];
        const required = new Set(
            requiredList.filter((name): name is string => typeof name === "string"),
        );
        return {
            required: names.filter((name) => required.has(name)),
            optional: names.filter((name) => !required.has(name)),
        };
    }

    let shape: unknown;
    try {
        shape = (schema as { shape?: unknown }).shape;
    } catch {
        shape = undefined;
    }
    if (isRecord(shape) && !Array.isArray(shape)) {
        const result: ToolParameterNames = { required: [], optional: [] };
        for (const [name, field] of Object.entries(shape)) {
            (isOptionalZodField(field) ? result.optional : result.required).push(name);
        }
        return result;
    }

    return undefined;
}

// Parameter names of every tool definition the host has shown this process,
// keyed by tool name. OpenCode's execute hooks carry the tool name but not its
// schema, so the definition hooks record it here for the refusal to read.
const recordedToolParameters = new Map<string, ToolParameterNames>();

export function recordToolParameters(toolName: string, schema: unknown): void {
    const names = toolParameterNames(schema);
    if (names) recordedToolParameters.set(toolName, names);
    else recordedToolParameters.delete(toolName);
}

function quoteArguments(input: unknown): string {
    let text: string;
    try {
        text = JSON.stringify(input) ?? String(input);
    } catch {
        text = String(input);
    }
    return text.length > MAX_QUOTED_ARGUMENTS
        ? `${text.slice(0, MAX_QUOTED_ARGUMENTS - 1)}…`
        : text;
}

function ordinal(value: number): string {
    const lastTwo = value % 100;
    if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`;
    switch (value % 10) {
        case 1:
            return `${value}st`;
        case 2:
            return `${value}nd`;
        case 3:
            return `${value}rd`;
        default:
            return `${value}th`;
    }
}

function describeParameters(names: ToolParameterNames | undefined): string {
    if (!names || names.required.length + names.optional.length === 0) {
        return "the tool's own parameters";
    }
    const listed = [...names.required.map((name) => `${name} (required)`), ...names.optional];
    const shown = listed.slice(0, MAX_LISTED_PARAMETERS);
    const more = listed.length > shown.length ? ", …" : "";
    return `its parameters: ${shown.join(", ")}${more}`;
}

export interface DroppedInputRefusal {
    toolName?: string;
    input: unknown;
    /** The tool's schema when the caller can see it; names are otherwise looked up by tool name. */
    parameters?: unknown;
    /** How many calls in a row, including this one, carried placeholder arguments. */
    consecutive: number;
}

/**
 * The tool-result text a refused call gets back. The model wrote the
 * placeholder itself (usually by copying the dropped-call rendering from its
 * history), so the text says exactly that, shows what was received, and names
 * what to send instead. ctx_expand is only for recovering an earlier call's
 * arguments, never a prerequisite for a fresh call.
 */
export function droppedInputRefusalMessage(refusal: DroppedInputRefusal): string {
    const tool = refusal.toolName ? `\`${refusal.toolName}\`` : undefined;
    const names =
        toolParameterNames(refusal.parameters) ??
        (refusal.toolName ? recordedToolParameters.get(refusal.toolName) : undefined);
    const lines: string[] = [];
    if (refusal.consecutive >= 2) {
        lines.push(
            `This is the ${ordinal(refusal.consecutive)} call in a row with placeholder arguments.`,
        );
    }
    lines.push(
        `Not executed: your arguments${tool ? ` to ${tool}` : ""} were ${quoteArguments(refusal.input)}. That is the placeholder Magic Context shows in place of an earlier call's arguments, not a value to send. Nothing is wrong with the session or the tool.`,
        `Call ${tool ?? "the tool"} again with real values for ${describeParameters(names)}.`,
        "Only if you need the original arguments of an earlier dropped call, recover them with ctx_expand first.",
    );
    return lines.join("\n");
}

export interface DroppedInputCall {
    sessionID?: string;
    toolName?: string;
    input: unknown;
}

export interface DroppedInputGuardOptions {
    /** Look up a tool's live schema by name (Pi exposes every tool's parameters). */
    parametersFor?: (toolName: string) => unknown;
}

/**
 * Stateful guard for one plugin instance. Detection is purely content-based;
 * the state is only the per-session count of consecutive refusals, which a
 * call that passes the guard resets.
 */
export function createDroppedInputGuard(options: DroppedInputGuardOptions = {}) {
    const consecutiveBySession = new Map<string, number>();

    return {
        /** Returns the refusal text for a placeholder call, or undefined when the call may run. */
        check(call: DroppedInputCall): string | undefined {
            const session = call.sessionID ?? "";
            if (!containsDroppedInputPlaceholder(call.input)) {
                consecutiveBySession.delete(session);
                return undefined;
            }
            const consecutive = (consecutiveBySession.get(session) ?? 0) + 1;
            consecutiveBySession.delete(session);
            consecutiveBySession.set(session, consecutive);
            if (consecutiveBySession.size > MAX_TRACKED_SESSIONS) {
                const oldest = consecutiveBySession.keys().next().value;
                if (oldest !== undefined) consecutiveBySession.delete(oldest);
            }
            let parameters: unknown;
            if (call.toolName && options.parametersFor) {
                try {
                    parameters = options.parametersFor(call.toolName);
                } catch {
                    parameters = undefined;
                }
            }
            return droppedInputRefusalMessage({
                toolName: call.toolName,
                input: call.input,
                parameters,
                consecutive,
            });
        },
    };
}

export type DroppedInputGuard = ReturnType<typeof createDroppedInputGuard>;

/** Throw the refusal for a placeholder call; OpenCode surfaces the error as the tool result. */
export function assertExecutableToolInput(guard: DroppedInputGuard, call: DroppedInputCall): void {
    const refusal = guard.check(call);
    if (refusal !== undefined) throw new Error(refusal);
}

export function createDroppedInputToolExecuteBeforeHook() {
    const guard = createDroppedInputGuard();
    return async (input: unknown, output: unknown): Promise<void> => {
        const call = isRecord(input) ? input : {};
        const args = isRecord(output) ? (output as { args?: unknown }).args : undefined;
        if (typeof call.sessionID === "string") {
            const disabled = blockedReadSessionRefusal(call.sessionID);
            if (disabled) {
                sessionLog(call.sessionID, disabled, { tool: call.tool });
                throw new Error(disabled);
            }
            const callId = typeof call.callID === "string" ? call.callID : undefined;
            const refusal = refuseBudgetedToolCall(call.sessionID, callId);
            if (refusal) {
                if (refusal.spared) {
                    sessionLog(call.sessionID, "dreamer token budget: refusal did not count", {
                        tool: call.tool,
                        callId: callId ?? null,
                        reason: refusal.spared,
                    });
                } else {
                    sessionLog(call.sessionID, "dreamer token budget: tool call refused", {
                        tool: call.tool,
                        callId: callId ?? null,
                        hardStopped: refusal.hardStopped,
                    });
                }
                throw new Error(refusal.message);
            }
        }
        assertExecutableToolInput(guard, {
            sessionID: typeof call.sessionID === "string" ? call.sessionID : undefined,
            toolName: typeof call.tool === "string" ? call.tool : undefined,
            input: args,
        });
    };
}
