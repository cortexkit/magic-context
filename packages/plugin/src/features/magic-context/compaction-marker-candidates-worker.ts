import { serveWorkerJobs } from "../../shared/reusable-worker-entry";
import type { MarkerCandidateReply } from "./compaction-marker-candidates";

serveWorkerJobs<{ path: string; sessionId: string; references?: boolean }>(async (input, port) => {
    port.postMessage({ kind: "accepted" } satisfies MarkerCandidateReply);
    const [{ Database }, { scanMarkerCandidateSnapshot }] = await Promise.all([
        import("../../shared/sqlite"),
        import("./compaction-marker-candidates"),
    ]);
    let db: InstanceType<typeof Database> | undefined;
    let reply: MarkerCandidateReply;
    try {
        db = new Database(input.path, { readonly: true });
        db.exec("PRAGMA busy_timeout=250");
        reply = {
            kind: "candidates",
            snapshot: scanMarkerCandidateSnapshot(db, input.sessionId, input.references !== false),
        };
    } catch (error) {
        reply = { kind: "error", error: error instanceof Error ? error.message : String(error) };
    } finally {
        db?.close();
    }
    port.postMessage(reply);
    port.close();
});
