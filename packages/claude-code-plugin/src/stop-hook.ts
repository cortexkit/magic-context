/**
 * Entry point of the Stop hook (`dist/stop-hook.js`). Kept apart from hook.js
 * because Claude Code runs it at the end of every turn: it loads no database and
 * no shared core, only the transcript reader in capture.ts.
 *
 * It must never get in the way of a session: every failure ends in exit code 0.
 */
import { readFileSync } from "node:fs";
import { handleStop } from "./capture";

try {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    const instruction = payload && typeof payload === "object" ? handleStop(payload) : null;
    if (instruction) {
        // Claude Code labels every blocking Stop hook "Stop hook error"; say what it is.
        process.stdout.write(
            `${JSON.stringify({
                decision: "block",
                reason: instruction,
                systemMessage:
                    "Magic Context: saving verified work with the session's own model (not an error) · 正在用当前模型沉淀已验证的工作，不是错误",
            })}\n`,
        );
    }
} catch (error) {
    console.error(`[magic-context] stop hook skipped: ${String(error)}`);
}
process.exit(0);
