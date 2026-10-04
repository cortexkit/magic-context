/**
 * The four Magic Context agent tools Claude Code can use, built from the shared
 * core and described as MCP tools.
 *
 * `ctx_reduce` is not offered: it asks the host to drop context items, and Claude
 * Code exposes no way for a plugin to rewrite the conversation it sends. Claude
 * Code compacts its own context; these tools cover what survives that.
 */

import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { ensureMessagesIndexed } from "@magic-context/core/features/magic-context/message-index";
import { withRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "@magic-context/core/plugin/embedding-bootstrap";
import { getErrorMessage } from "@magic-context/core/shared/error-message";
import { log } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";
import { tool } from "@magic-context/core/shared/tool-schema";
import { createCtxExpandTools } from "@magic-context/core/tools/ctx-expand";
import { CTX_MEMORY_ACTIONS, createCtxMemoryTools } from "@magic-context/core/tools/ctx-memory";
import { createCtxNoteTools } from "@magic-context/core/tools/ctx-note";
import { createCtxSearchTools } from "@magic-context/core/tools/ctx-search";
import {
    CTX_EXPAND_CLAUDE_CODE_DESCRIPTION,
    CTX_NOTE_CLAUDE_CODE_DESCRIPTION,
    CTX_SEARCH_CLAUDE_CODE_DESCRIPTION,
} from "./guidance";
import type { McpTool, McpToolResult } from "./mcp/server";
import { createCtxSkillTool } from "./operation-skills/tool";
import type { Runtime } from "./runtime";
import type { ClaudeCodeSession } from "./session";
import { createTranscriptSource, locateTranscript, type TranscriptSource } from "./transcript";

// The shared tools build their argument schemas with this zod copy; use the same one to
// validate and to emit JSON Schema, so two zod versions never meet.
const z = tool.schema;

type CoreTool = ReturnType<typeof createCtxSearchTools>[string];
type Shape = Record<string, CoreTool["args"][string]>;

/** Per-tool presentation: the Claude Code description and any shared parameters to hide. */
const TOOL_PRESENTATION: Record<
    string,
    { description?: string; omitArgs?: string[]; readOnly: boolean }
> = {
    ctx_search: { description: CTX_SEARCH_CLAUDE_CODE_DESCRIPTION, readOnly: true },
    // `tag` addresses `§N§` tags, which only a fully managed host injects.
    ctx_expand: {
        description: CTX_EXPAND_CLAUDE_CODE_DESCRIPTION,
        omitArgs: ["tag"],
        readOnly: true,
    },
    // Smart notes are evaluated by the dreamer, which runs inside OpenCode and Pi.
    ctx_note: {
        description: CTX_NOTE_CLAUDE_CODE_DESCRIPTION,
        omitArgs: ["surface_condition"],
        readOnly: false,
    },
    ctx_memory: { readOnly: false },
};

export const CLAUDE_CODE_TOOL_NAMES = [...Object.keys(TOOL_PRESENTATION), "ctx_skill"];

const DISABLED_MESSAGE =
    "Magic Context is disabled for this project (`enabled: false` in magic-context.jsonc).";

interface ToolsInput {
    runtime: Runtime | null;
    /** The session the server started in. */
    session: ClaudeCodeSession;
    /**
     * The session the process is on when a tool is called; `/clear` and `/resume`
     * change it without restarting the server (see session-handoff.ts).
     */
    currentSession?: () => ClaudeCodeSession;
    /** Why the runtime is missing; every call answers with it. */
    unavailableReason?: string;
}

function resultText(result: unknown): string {
    if (typeof result === "string") return result;
    if (result && typeof result === "object" && "output" in result) {
        const output = (result as { output: unknown }).output;
        if (typeof output === "string") return output;
    }
    return String(result);
}

function describeIssues(error: {
    issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
    return error.issues
        .map(
            (issue) =>
                `${issue.path.length > 0 ? issue.path.join(".") : "arguments"}: ${issue.message}`,
        )
        .join("; ");
}

/**
 * `ctx_search`'s message lane reads the shared message index, which OpenCode and
 * Pi fill from their own message events. Claude Code has no such event, so the
 * index is brought up to date from the transcript before each search. Only the
 * compacted prefix is indexed: those messages no longer change, while the live
 * tail can still grow and is excluded from results anyway.
 */
function indexCompactedMessages(db: Database, sessionId: string, source: TranscriptSource): void {
    try {
        const compacted = source.compactedThroughOrdinal();
        if (compacted <= 0) return;
        ensureMessagesIndexed(db, sessionId, () =>
            source.provider.readMessages().slice(0, compacted),
        );
    } catch (error) {
        log(`[magic-context] message indexing for ctx_search failed: ${getErrorMessage(error)}`);
    }
}

function buildCoreTools(
    runtime: Runtime | null,
    transcriptFor: (sessionId: string) => TranscriptSource | null,
) {
    // With no runtime the definitions still supply names and schemas; the stub
    // database is never reached because every call is answered before execute.
    const db = (runtime?.db ?? null) as unknown as Database;
    const directoryConfig = runtime?.config;
    const resolveProjectPath = (directory: string) =>
        resolveProjectIdentityForSession(directory, directoryConfig?.allow_home_project);
    const memoryEnabled = directoryConfig?.memory?.enabled !== false;
    const compactedThrough = (sessionId: string): number =>
        transcriptFor(sessionId)?.compactedThroughOrdinal() ?? 0;

    return {
        ...createCtxNoteTools({ db, dreamerEnabled: false, resolveProjectPath }),
        ...createCtxSearchTools({
            db,
            resolveProjectPath,
            ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
            resolveMessageOrdinalCutoff: compactedThrough,
        }),
        ...(memoryEnabled
            ? createCtxMemoryTools({
                  db,
                  resolveProjectPath,
                  ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
                  allowedActions: [...CTX_MEMORY_ACTIONS],
              })
            : {}),
        ...createCtxExpandTools({
            db,
            expandTools: directoryConfig?.historian?.expand_tools,
            getLastCompactedOrdinal: (sessionId) => {
                const compacted = compactedThrough(sessionId);
                return compacted > 0 ? compacted : -1;
            },
        }),
    } satisfies Record<string, CoreTool>;
}

/** Build the MCP tool list for one Claude Code process. */
export function createClaudeCodeTools(input: ToolsInput): McpTool[] {
    const { runtime, session, unavailableReason } = input;
    const currentSession = input.currentSession ?? (() => session);

    // A transcript appears once its session has a first message; until then, look again.
    const transcripts = new Map<string, TranscriptSource>();
    const transcriptFor = (sessionId: string): TranscriptSource | null => {
        const known = transcripts.get(sessionId);
        if (known) return known;
        const path = locateTranscript({ sessionId, directory: session.directory });
        if (!path) return null;
        const source = createTranscriptSource(path);
        transcripts.set(sessionId, source);
        return source;
    };

    const core = buildCoreTools(runtime, transcriptFor);
    const tools: McpTool[] = [];

    for (const [name, definition] of Object.entries(core)) {
        const presentation = TOOL_PRESENTATION[name];
        if (!presentation) continue;
        const shape: Shape = { ...definition.args };
        for (const omitted of presentation.omitArgs ?? []) delete shape[omitted];
        const parser = z.object(shape).passthrough();

        tools.push({
            name,
            description: presentation.description ?? definition.description,
            inputSchema: z.toJSONSchema(z.object(shape), { io: "input" }) as Record<
                string,
                unknown
            >,
            annotations: {
                title: name,
                readOnlyHint: presentation.readOnly,
                destructiveHint: false,
                openWorldHint: false,
            },
            async call(rawArgs): Promise<McpToolResult> {
                if (!runtime) {
                    return {
                        text: unavailableReason ?? "Magic Context storage is unavailable.",
                        isError: true,
                    };
                }
                if (runtime.config.enabled !== true) {
                    return { text: DISABLED_MESSAGE, isError: true };
                }
                const parsed = parser.safeParse(rawArgs ?? {});
                if (!parsed.success) {
                    return {
                        text: `Invalid arguments: ${describeIssues(parsed.error)}`,
                        isError: true,
                    };
                }
                const { sessionId, directory } = currentSession();
                const toolContext = {
                    sessionID: sessionId,
                    messageID: "",
                    agent: "claude-code",
                    directory,
                    worktree: directory,
                    abort: new AbortController().signal,
                    metadata: () => {},
                    ask: async () => {},
                };
                const execute = () =>
                    definition.execute(parsed.data as never, toolContext as never);
                const source =
                    name === "ctx_search" || name === "ctx_expand"
                        ? transcriptFor(sessionId)
                        : null;
                if (source && name === "ctx_search") {
                    indexCompactedMessages(runtime.db, sessionId, source);
                }
                const output = source
                    ? await withRawMessageProvider(sessionId, source.provider, execute)
                    : await execute();
                const text = resultText(output);
                // The shared tools report failures as "Error: ..." replies.
                return { text, isError: /^Error\b/.test(text) };
            },
        });
    }
    // Operation skills are files in the project, so they work even without the database.
    tools.push(
        createCtxSkillTool({
            getProjectDir: () => currentSession().directory,
            unavailable: () =>
                runtime && runtime.config.enabled !== true ? DISABLED_MESSAGE : null,
        }),
    );
    return tools;
}
