import { getOrCreateSessionMeta, openDatabase } from "../features/magic-context/storage";
import { updateSessionMeta } from "../features/magic-context/storage-meta-session";
import { log } from "../shared/logger";

// Error codes that SQLite raises for transient contention — should be retried
// on next transform pass rather than surfaced as persistent failures. BUSY is
// by far the most common in WAL mode; LOCKED is theoretically possible when a
// shared-cache conflict occurs (extremely rare in our single-DB setup but
// covered defensively).
const TRANSIENT_SQLITE_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);

type MessageWithParts = {
    info: import("@opencode-ai/sdk").Message;
    parts: import("@opencode-ai/sdk").Part[];
};

type MessagesTransformOutput = { messages: MessageWithParts[] };

/**
 * Top-level transform wrapper. Catches errors so OpenCode's prompt loop
 * always proceeds — without this guard, a transient DB contention event can
 * crash the user's turn through OpenCode's Effect pipeline. See issue #23:
 * https://github.com/cortexkit/magic-context/issues/23
 *
 * Error handling is tiered:
 *
 * - **SQLITE_BUSY**: Transient, expected from concurrent plugin processes
 *   (second OpenCode instance, long dreamer/historian child session, slow
 *   WAL checkpoint). Logged tersely; next pass will retry naturally. No
 *   persistent telemetry needed.
 *
 * - **Non-BUSY errors**: Schema corruption, programming bugs, type errors.
 *   These can silently disable magic-context for the entire session if the
 *   error repeats on every pass. We:
 *     1. Log with full detail (code, name, message, stack).
 *     2. Persist a short error summary into `session_meta.last_transform_error`
 *        so the sidebar/dashboard surfaces the failure state. The sidebar
 *        already reads this field; runPostTransformPhase's catch only fires
 *        for errors that reach it, and an error thrown early enough bypasses
 *        it entirely. Writing it here at the outer boundary guarantees
 *        observability.
 *     3. Return with messages unmodified for this pass.
 *
 * In both cases we NEVER rethrow — OpenCode's Effect pipeline turns thrown
 * errors into user-visible prompt failures. We accept degraded behavior
 * (no injection / no drops this turn) rather than blocking the user.
 *
 * Correctness is preserved because all persistent state mutations inside
 * the inner transform are idempotent across passes.
 */
export function createMessagesTransformHandler(args: {
    magicContext: {
        "experimental.chat.messages.transform"?: (
            input: Record<string, never>,
            output: MessagesTransformOutput,
        ) => Promise<void>;
    } | null;
}): (input: Record<string, never>, output: MessagesTransformOutput) => Promise<void> {
    return async (input, output): Promise<void> => {
        try {
            await args.magicContext?.["experimental.chat.messages.transform"]?.(input, output);
        } catch (error) {
            const code = (error as { code?: string } | null)?.code;
            const name = (error as { name?: string } | null)?.name;
            const message = error instanceof Error ? error.message : String(error);
            const isTransient = typeof code === "string" && TRANSIENT_SQLITE_CODES.has(code);

            if (isTransient) {
                log(
                    `[magic-context] transform skipped this pass — ${code} (transient; retrying next pass): ${message}`,
                );
                return;
            }

            // Persistent non-transient errors are the real risk: silent forever
            // disable unless we surface them. Persist to session_meta so the
            // sidebar shows an obvious failure indicator.
            log(
                `[magic-context] transform FAILED code=${code ?? "none"} name=${name ?? "none"}: ${message}. Continuing with unmodified messages for this pass.`,
                error,
            );

            // Best-effort: surface the error in session_meta so users see
            // something is broken. We can only do this when we have a
            // session id — the output's first message carries it.
            const sessionId = resolveSessionId(output);
            if (sessionId) {
                try {
                    const db = openDatabase();
                    const summary = truncateError(name, code, message);
                    // Write-if-changed guard: when the same error repeats on
                    // every transform pass (e.g. persistent schema corruption),
                    // skip the DB write if lastTransformError already matches.
                    // Prevents needless WAL churn during degraded operation.
                    const current = getOrCreateSessionMeta(db, sessionId).lastTransformError;
                    if (current !== summary) {
                        updateSessionMeta(db, sessionId, { lastTransformError: summary });
                    }
                } catch (persistError) {
                    // Swallow — if we can't even write the error, we definitely
                    // can't recover. Next pass may succeed.
                    log("[magic-context] failed to persist transform error:", persistError);
                }
            }
        }
    };
}

function resolveSessionId(output: MessagesTransformOutput): string | null {
    for (const message of output.messages) {
        const sid = (message.info as { sessionID?: string } | undefined)?.sessionID;
        if (typeof sid === "string" && sid.length > 0) return sid;
    }
    return null;
}

function truncateError(
    name: string | undefined,
    code: string | undefined,
    message: string,
    maxLen = 240,
): string {
    const prefix = `${name ?? "Error"}${code ? ` [${code}]` : ""}: `;
    const budget = Math.max(20, maxLen - prefix.length);
    const trimmed = message.length > budget ? `${message.slice(0, budget)}…` : message;
    return `${prefix}${trimmed}`;
}
