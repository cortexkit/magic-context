import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../../plugin/src/features/magic-context/storage";
import { createTagger } from "../../../plugin/src/features/magic-context/tagger";
import { runValidatedHistorianPass } from "../../../plugin/src/hooks/magic-context/compartment-runner-historian";
import type { HiddenCompletionExecutor } from "../../../plugin/src/hooks/magic-context/compartment-runner-types";
import { createTransform } from "../../../plugin/src/hooks/magic-context/transform";
import { flushLogger, setLogLineForwarder } from "../../../plugin/src/shared/logger";

// The parent test supplies an isolated home and database; no host store is opened.
const root = process.env.ISSUE_LOG_CAPTURE_ROOT;
if (!root || process.env.HOME !== root) throw new Error("isolated capture home required");
const lines: string[] = [];
const db = openDatabase(join(root, "context.db"));
if (!db) throw new Error("capture database unavailable");
flushLogger();
setLogLineForwarder((line) => lines.push(...line.trimEnd().split("\n")));
const privateText = "PRIVATE_PROMPT_CANARY PRIVATE_FILE_CANARY PRIVATE_TOOL_CANARY";
const errorText =
    "PRIVATE_ERROR_CANARY /home/PRIVATE_HOME_CANARY/private.env API_KEY=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
try {
    const sessionId = "ses_PRIVATE_SESSION_CANARY";
    let decision: "defer" | "execute" = "defer";
    const transform = createTransform({
        tagger: createTagger(),
        scheduler: { shouldExecute: () => decision },
        contextUsageMap: new Map(),
        historyRefreshSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        db,
        historianRunnable: false,
        protectedTokens: 0,
        liveModelBySession: new Map([
            [sessionId, { providerID: "opencode", modelID: "deepseek-v4.1-flash-free" }],
        ]),
    });
    for (const next of ["defer", "defer", "execute"] as const) {
        decision = next;
        await transform(
            {},
            {
                messages: [
                    {
                        info: {
                            id: "msg_PRIVATE_MESSAGE_CANARY",
                            role: "user",
                            sessionID: sessionId,
                        },
                        parts: [{ type: "text", text: privateText }],
                    },
                    {
                        info: {
                            id: "msg_PRIVATE_TOOL_CANARY",
                            role: "assistant",
                            sessionID: sessionId,
                        },
                        parts: [
                            {
                                type: "tool",
                                tool: "read",
                                callID: "private-call",
                                state: {
                                    status: "completed",
                                    input: { path: "/home/PRIVATE_HOME_CANARY/file.txt" },
                                    output: privateText,
                                },
                            },
                        ],
                    },
                ],
            },
        );
    }
    for (const failure of [false, true]) {
        const executor: HiddenCompletionExecutor = {
            capabilities: { tools: false, harness: "opencode2" },
            open: async () => {
                if (failure) throw new TypeError(errorText);
                return {
                    id: "ses_PRIVATE_HISTORIAN_CANARY",
                    childSessionId: "ses_PRIVATE_HISTORIAN_CANARY",
                };
            },
            attempt: async () => {},
            collect: async () => ({
                text: `<output><compartment start="1" end="1" title="${privateText}"><p1>${privateText}</p1></compartment></output>`,
                reasoning: null,
                lengthCapped: false,
                usage: { input: 400, output: 80, cacheRead: 0, cacheWrite: 0 },
            }),
            close: async () => {},
        };
        await runValidatedHistorianPass({
            client: undefined,
            hiddenCompletionExecutor: executor,
            db,
            parentSessionId: sessionId,
            sessionDirectory: root,
            prompt: `Messages 1-1:\n1: U: ${privateText}`,
            chunk: {
                startIndex: 1,
                endIndex: 1,
                lines: [{ ordinal: 1, messageId: "msg_PRIVATE_MESSAGE_CANARY" }],
            },
            priorCompartments: [],
            sequenceOffset: 0,
            dumpLabelBase: "privacy-capture",
        });
    }
} finally {
    closeDatabase();
    setLogLineForwarder(null);
}
console.log(JSON.stringify(lines));
