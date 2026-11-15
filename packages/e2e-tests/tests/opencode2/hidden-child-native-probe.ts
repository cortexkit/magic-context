import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Loaded next to Magic Context. It reports two things the host-level test cannot see from outside:
 * whether this host gives plugins `session.remove` (the same feature check Magic Context makes),
 * and, for every session whose context is shaped, the parent and metadata the host stored for it
 * at that moment. Hidden children are removed when their run ends, so this is the only point at
 * which their parent can be read.
 */
export default {
    id: "mc-hidden-child-native-probe",
    async setup(context: any) {
        const directory = context.location.directory as string;
        // Whether `session.update` stores metadata a plugin passes it: update a scratch session and
        // read it back. The scratch session is removed again where the host allows it; elsewhere it
        // stays as one ordinary (not hidden-run) session, which the test's assertions allow for.
        let metadataForward: string;
        let metadataSemantics: string = "unknown";
        try {
            const scratch = await context.session.create({
                title: "metadata forward probe",
                metadata: { original: true },
                location: { directory },
            });
            try {
                await context.session.update({
                    sessionID: scratch.id,
                    metadata: { probe: "updated" },
                });
                const back = await context.session.get({ sessionID: scratch.id });
                metadataForward = back.metadata?.probe === "updated" ? "stored" : "dropped";
                metadataSemantics = back.metadata?.original === undefined ? "replace" : "merge";
            } finally {
                if (typeof context.session.remove === "function")
                    await context.session.remove({ sessionID: scratch.id });
            }
        } catch (error) {
            metadataForward = `error: ${String(error)}`;
        }
        writeFileSync(
            join(directory, "native-probe-capability.json"),
            JSON.stringify({ remove: typeof context.session.remove, metadataForward, metadataSemantics }),
        );
        if (typeof context.session.remove === "function" && !existsSync(join(directory, "native-remove-done.json"))) {
            void (async () => {
                while (!existsSync(join(directory, "native-remove-start"))) await Bun.sleep(20);
                const child = await context.session.create({ title: "running remove probe", location: { directory }, model: { providerID: "openai", id: "mock-model" } });
                await context.session.prompt({ sessionID: child.id, text: "running remove probe" });
                while (!existsSync(join(directory, "native-remove-now"))) await Bun.sleep(20);
                await context.session.remove({ sessionID: child.id });
                let missingError = "";
                try { await context.session.remove({ sessionID: child.id }); }
                catch (error) { missingError = String(error); }
                writeFileSync(join(directory, "native-remove-done.json"), JSON.stringify({ id: child.id, missingError }));
            })().catch((error) => writeFileSync(join(directory, "native-remove-done.json"), JSON.stringify({ error: String(error) })));
        }
        const seen = new Set<string>();
        await context.session.hook("context", async (draft: { sessionID: string }) => {
            if (seen.has(draft.sessionID)) return;
            seen.add(draft.sessionID);
            try {
                const session = await context.session.get({ sessionID: draft.sessionID });
                appendFileSync(
                    join(directory, "native-probe-sessions.jsonl"),
                    `${JSON.stringify({
                        sessionID: draft.sessionID,
                        parentID: session.parentID ?? null,
                        metadata: session.metadata ?? null,
                    })}\n`,
                );
            } catch (error) {
                appendFileSync(
                    join(directory, "native-probe-sessions.jsonl"),
                    `${JSON.stringify({ sessionID: draft.sessionID, error: String(error) })}\n`,
                );
            }
        });
    },
};
