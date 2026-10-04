/**
 * Entry point of the UserPromptSubmit hook (`dist/prompt-hook.js`): a prompt
 * that names a recorded operation gets the verified operation added to the
 * model's context (see operation-skills/trigger.ts).
 *
 * Claude Code runs it on every prompt, so like stop-hook.js it loads no database
 * and no shared core. It must never get in the way of a prompt: every failure
 * ends in exit code 0 without output.
 */
import { readFileSync } from "node:fs";
import { readCaptureState } from "./capture";
import { operationContextFor } from "./operation-skills/trigger";
import { resolveHookSession } from "./session";

try {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    const session = payload && typeof payload === "object" ? resolveHookSession(payload) : null;
    // SessionStart records whether Magic Context is disabled for this project.
    if (
        session &&
        typeof payload.prompt === "string" &&
        !readCaptureState(session.sessionId).disabled
    ) {
        const context = operationContextFor(session.directory, payload.prompt);
        if (context) {
            process.stdout.write(
                `${JSON.stringify({
                    hookSpecificOutput: {
                        hookEventName: "UserPromptSubmit",
                        additionalContext: context,
                    },
                })}\n`,
            );
        }
    }
} catch (error) {
    console.error(`[magic-context] prompt hook skipped: ${String(error)}`);
}
process.exit(0);
