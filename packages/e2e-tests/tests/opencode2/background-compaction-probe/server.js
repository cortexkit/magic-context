import { appendFileSync } from "node:fs";
import { join } from "node:path";

// Observes every compaction hook call after Magic Context has answered it.
// Each call is appended to `compaction-calls.jsonl` in the project directory
// and, when MC_E2E_COMPACTION_BARRIER_URL is set, reported to the test's
// loopback server. The hook waits for that server's reply, so the test can
// hold a call (for example OpenCode 2.3+'s early background call) while it
// reads the stores, and release it when it is done.
export default {
    id: "mc-background-compaction-probe",
    async setup(context) {
        await context.session.hook("compaction", async (draft) => {
            const record = {
                sessionID: draft.sessionID,
                messages: Array.isArray(draft.messages) ? draft.messages.length : 0,
                answered: draft.result !== undefined,
            };
            appendFileSync(
                join(context.location.directory, "compaction-calls.jsonl"),
                `${JSON.stringify(record)}\n`,
            );
            const url = process.env.MC_E2E_COMPACTION_BARRIER_URL;
            if (url) {
                const response = await fetch(url, { method: "POST", body: JSON.stringify(record) });
                await response.text();
            }
        });
    },
};
