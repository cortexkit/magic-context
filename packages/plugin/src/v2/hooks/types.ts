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
    model: { providerID: string; id: string; variant?: string };
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

export interface V2Context {
    location: { directory: string };
    agent: V2AgentDomain;
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
                add(tool: {
                    name: string;
                    description: string;
                    input: unknown;
                    options?: { codemode?: boolean };
                    execute(
                        input: unknown,
                        context: {
                            sessionID: string;
                            agent: string;
                            messageID: string;
                            id: string;
                        },
                    ): Promise<{ content?: string; metadata?: Record<string, unknown> }>;
                }): void;
                update(id: string, update: (tool: { description: string }) => void): void;
            }) => void,
        ): Promise<unknown>;
        hook(
            name: "execute.before" | "execute.after",
            callback: (draft: {
                tool: string;
                sessionID: string;
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
        }): Promise<{ id: string }>;
        get(input: { sessionID: string }): Promise<{
            model?: { providerID: string; id: string; variant?: string };
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
            name: "context" | "compaction" | "generate",
            callback: (draft: SessionContext) => Promise<void>,
        ): Promise<unknown>;
        interrupt(input: { sessionID: string }): Promise<{ interrupted: boolean }>;
    };
}
