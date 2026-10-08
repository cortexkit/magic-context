// Structural host boundary: importing the GA context types also augments global
// Error with Effect's readonly ignore flag, breaking the co-published v1 types.
// These are only the mutable request and promise-domain fields this adapter uses.
export interface V2Message {
    id?: string;
    role: string;
    content: Array<Record<string, unknown>>;
    [key: string]: unknown;
}
export interface SessionContext {
    sessionID: string;
    model: {
        providerID: string;
        id: string;
        variant?: string;
        limit?: { context: number; input?: number; output?: number };
    };
    agent: string;
    messages: V2Message[];
    system: Array<Record<string, unknown>>;
    tools: Record<string, { description: string; input: unknown }>;
    options: Record<string, unknown>;
    result?: { summary: string };
}
export interface V2AgentEditor {
    update(
        id: string,
        update: (agent: {
            system?: string;
            description?: string;
            mode: "subagent" | "primary" | "all";
            hidden: boolean;
            steps?: number;
            request: {
                settings: Record<string, unknown>;
                headers: Record<string, string>;
                body: Record<string, unknown>;
            };
            permissions: Array<{
                action: string;
                resource: string;
                effect: "allow" | "deny" | "ask";
            }>;
        }) => void,
    ): void;
}

export interface V2AgentDomain {
    reload(): Promise<void>;
    transform(callback: (editor: V2AgentEditor) => void): Promise<unknown>;
}

/** What the host hands a registered command when a client invokes it. */
export interface V2CommandInvocation {
    sessionID: string;
    /** `text` is the argument remainder the client typed after the command name. */
    prompt: { text: string };
    delivery: string;
}

export interface V2CommandEditor {
    add(definition: {
        name: string;
        description?: string;
        execute: (input: V2CommandInvocation) => Promise<void>;
    }): void;
}

/**
 * Server-side command registry. The host keeps the added definitions in a
 * location-scoped map that `GET /api/command` lists and
 * `POST /api/session/:sessionID/command` executes, so a command registered here
 * is reachable from every client, not only the terminal UI.
 */
export interface V2CommandDomain {
    transform(callback: (editor: V2CommandEditor) => void): Promise<unknown>;
    reload(): Promise<void>;
}

export interface V2Context {
    /** OpenCode 2 keys a location by directory and, when one is set, workspace. */
    location: { directory: string; workspaceID?: string };
    agent: V2AgentDomain;
    /** Absent on hosts predating the command domain; registration is then skipped. */
    command?: V2CommandDomain;
    event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown> };
    model: {
        list():
            | Promise<{
                  data: Array<{
                      id: string;
                      providerID: string;
                      limit: { context: number };
                  }>;
              }>
            | Promise<
                  Array<{
                      id: string;
                      providerID: string;
                      limit: { context: number };
                  }>
              >
            | Array<{
                  id: string;
                  providerID: string;
                  limit: { context: number };
              }>
            | {
                  data: Array<{
                      id: string;
                      providerID: string;
                      limit: { context: number };
                  }>;
              };
    };
    storage: {
        get(key: string): Promise<unknown>;
        set(key: string, value: unknown): Promise<void>;
    };
    tool: {
        transform?(
            callback: (editor: {
                update(id: string, update: (tool: { description: string }) => void): void;
                add?(tool: {
                    name: string;
                    description: string;
                    input: unknown;
                    options?: { codemode: boolean };
                    execute(
                        input: unknown,
                        context: {
                            sessionID: string;
                            messageID: string;
                            agent: string;
                            progress(value: Record<string, unknown>): Promise<void>;
                        },
                    ): Promise<{ content: string }>;
                }): void;
            }) => void,
        ): Promise<unknown>;
        hook(
            name: "execute.before" | "execute.after",
            callback: (draft: {
                tool: string;
                sessionID: string;
                /** The agent the calling session runs. */
                agent?: string;
                input: unknown;
                status?: string;
                result?: { content?: unknown };
            }) => void | Promise<void>,
        ): Promise<unknown>;
    };
    session: {
        create(input: {
            title: string;
            agent: string;
            model: { providerID: string; id: string; variant?: string };
            location: { directory: string };
            metadata: { magic_context: "hidden-run"; role: "historian" | "dreamer" };
            /** Kept only by hosts that also have the optional `session.remove` declared below. */
            parentID?: string;
            /** Session rules, evaluated after every rule of the session's agent. */
            permissions?: Array<{ action: string; resource: string; effect: "allow" | "deny" }>;
        }): Promise<{ id: string }>;
        get(input: { sessionID: string }): Promise<{
            model?: { providerID: string; id: string; variant?: string };
            parentID?: string;
            /** The location the host bound the session to when it was created. */
            location?: { directory?: string; workspaceID?: string };
        }>;
        switchModel(input: {
            sessionID: string;
            model: { providerID: string; id: string; variant?: string };
        }): Promise<void>;
        prompt(input: { sessionID: string; text: string }): Promise<unknown>;
        wait(input: { sessionID: string }): Promise<void>;
        update(input: { sessionID: string; title: string }): Promise<void>;
        synthetic(input: {
            sessionID: string;
            id: string;
            text: string;
            delivery: "steer";
        }): Promise<unknown>;
        hook(
            name: "http.response",
            callback: (draft: {
                sessionID: string;
                model: { providerID: string; id: string };
                kind: string;
                response: Response;
            }) => Promise<void>,
        ): Promise<unknown>;
        hook(
            name: "context" | "compaction" | "generate",
            callback: (draft: SessionContext) => Promise<void>,
        ): Promise<unknown>;
        interrupt(input: { sessionID: string }): Promise<{ interrupted: boolean }>;
        /**
         * Present only on OpenCode 2 builds newer than 2.0.21, so it is optional and must be
         * feature-checked (`typeof remove === "function"`), never inferred from a version.
         */
        remove?(input: { sessionID: string }): Promise<void>;
    };
}
