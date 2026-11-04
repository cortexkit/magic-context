import type { HiddenRunIdentity } from "../hooks/magic-context/compartment-runner-types";

/** These agents transform supplied text; agents that inspect code or memories keep their existing tools. */
export function isToolFreeHiddenAgent(agent: string): boolean {
    return [
        "historian",
        "historian-two-pass",
        "historian-recomp",
        "historian-editor",
        "dreamer-classifier",
        "dreamer-reviewer",
        "smart-note-compiler",
    ].includes(agent);
}

export const TOOL_USE_DISABLED = "tool use is disabled for this task";
export const ZEN_READ_AGENT_SUFFIX = "-zen-blocked-read";

export function needsBlockedRead(agent: string, providerID: string | undefined): boolean {
    return providerID === "opencode" && isToolFreeHiddenAgent(agent);
}

export function blockedReadInstruction(run: Pick<HiddenRunIdentity, "agent" | "metadata">): string {
    if (run.agent.startsWith("historian"))
        return "Summarize only the supplied conversation and memory context. Do not call tools.";
    if (run.metadata?.task === "compress-cues")
        return "Compress only the supplied memory cues. Do not call tools.";
    if (run.agent === "smart-note-compiler")
        return "Compile only the supplied conditions and memory context. Do not call tools.";
    if (run.agent === "dreamer-reviewer")
        return "Review only the supplied observations and memory context. Do not call tools.";
    return "Classify only the supplied memory context. Do not call tools.";
}

export function withBlockedReadInstruction(
    system: string,
    run: Parameters<typeof blockedReadInstruction>[0],
): string {
    const instruction = blockedReadInstruction(run);
    return system.endsWith(instruction) ? system : `${system}${system ? "\n\n" : ""}${instruction}`;
}

// Only sessions opened by Magic Context's hidden executor can have tool calls
// blocked in OpenCode 1. Agent names and user permissions never select user sessions.
const blockedSessions = new Set<string>();
const v1Runs = new Map<string, HiddenRunIdentity>();

export function rememberV1HiddenRun(sessionID: string, run: HiddenRunIdentity | undefined): void {
    if (run) v1Runs.set(sessionID, run);
    else {
        v1Runs.delete(sessionID);
        setBlockedReadSession(sessionID, false);
    }
}

/**
 * OpenCode 1 calls chat.message after selecting the request's actual model.
 * Select the read-bearing carrier there so agent defaults and fallback models
 * cannot accidentally apply Zen's compatibility surface to another provider.
 */
export function shapeV1HiddenMessage(
    sessionID: string,
    message: {
        agent?: string;
        model?: { providerID: string };
        system?: string;
    },
): void {
    const run = v1Runs.get(sessionID);
    if (!run) return;
    const agent = message.agent ?? run.agent;
    const base = agent.endsWith(ZEN_READ_AGENT_SUFFIX)
        ? agent.slice(0, -ZEN_READ_AGENT_SUFFIX.length)
        : agent;
    const enabled = needsBlockedRead(base, message.model?.providerID);
    setBlockedReadSession(sessionID, enabled);
    if (!enabled) return;
    message.agent = `${base}${ZEN_READ_AGENT_SUFFIX}`;
    message.system = withBlockedReadInstruction(message.system ?? "", run);
}

export function setBlockedReadSession(sessionID: string, enabled: boolean): void {
    if (enabled) blockedSessions.add(sessionID);
    else blockedSessions.delete(sessionID);
}

export function blockedReadSessionRefusal(sessionID: string): string | undefined {
    return blockedSessions.has(sessionID) ? TOOL_USE_DISABLED : undefined;
}
