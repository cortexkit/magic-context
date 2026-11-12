import { appendFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setup } from "../../plugin/src/v2/server";
import type { V2Context } from "../../plugin/src/v2/hooks/types";

type ProbeContext = V2Context & { session: {
    hook(name: "prompt", callback: (event: { sessionID: string; prompt: { text: string } }) => void): Promise<unknown>;
    hook(name: "retry", callback: (event: { sessionID: string; error: unknown; decision: unknown }) => void): Promise<unknown>;
} };

// Test-only OpenCode 2 plugin used by issue-890-two-process.ts, loaded in place of
// Magic Context. It wraps the built adapter without changing its routing or
// hidden-run registry, and writes one JSONL trace per process (pid, session calls,
// prompt and context hooks), so it shows which process created and which ran a
// hidden child when two servers share a store. Two files under XDG_STATE_HOME
// steer it: `hold-hidden` pauses a summarizer turn in its context hook so other
// servers can start while it is in flight, and `alter-marker` appends text to a
// hidden prompt as the deliberate positive control for the refusal.
export default {
    id: "mc-issue-890-probe",
    async setup(context: ProbeContext) {
        const trace = (event: string, data: unknown) =>
            appendFileSync(join(process.env.XDG_STATE_HOME!, `trace-${process.pid}.jsonl`),
                `${JSON.stringify({ at: Date.now(), pid: process.pid, ppid: process.ppid, event, data })}\n`);
        trace("setup", { directory: context.location.directory });
        const pagesWaitingForChat = new Map<string, AbortController[]>();
        await context.session.hook("prompt", (event) => {
            trace("prompt.hook", { sessionID: event.sessionID, length: event.prompt.text.length,
                sha256: createHash("sha256").update(event.prompt.text).digest("hex").slice(0, 16) });
            // The generated OpenChamber agent-tool prompt hook only aborts UI-card
            // waiters belonging to this session; it never changes event.prompt.
            for (const controller of pagesWaitingForChat.get(event.sessionID) ?? []) controller.abort();
            if (event.prompt.text.startsWith("mc:hidden:") && existsSync(join(process.env.XDG_STATE_HOME!, "alter-marker"))) {
                // Deliberately hostile control, not behavior observed in OpenChamber.
                event.prompt.text += " [fixture wrapper]";
            }
        });
        await context.session.hook("retry", (event) => {
            trace("retry", { sessionID: event.sessionID, error: event.error, decision: event.decision });
        });
        await context.session.hook("context", async (draft) => {
            trace("context", { sessionID: draft.sessionID, agent: draft.agent,
                messages: draft.messages.length });
            const hold = join(process.env.XDG_STATE_HOME!, "hold-hidden");
            if (draft.agent === "historian" && existsSync(hold)) {
                trace("context.paused", { sessionID: draft.sessionID });
                const deadline = Date.now() + 30_000;
                while (existsSync(hold) && Date.now() < deadline) await Bun.sleep(20);
                if (existsSync(hold)) throw new Error("Hidden context pause timed out");
            }
        });
        const session = { ...context.session };
        for (const method of ["create", "prompt", "wait", "remove"] as const) {
            const original = context.session[method];
            if (!original) throw new Error(`Host is missing session.${method}`);
            Object.assign(session, {
                [method]: async (input: never) => {
                    trace(`${method}.start`, input);
                    try {
                        const result = await Reflect.apply(original, context.session, [input]);
                        trace(`${method}.end`, result);
                        return result;
                    } catch (error) {
                        trace(`${method}.error`, String(error));
                        throw error;
                    }
                },
            });
        }
        return setup({ ...context, session });
    },
};
