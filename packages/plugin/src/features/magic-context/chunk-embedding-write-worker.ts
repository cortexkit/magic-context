import { setHarness } from "../../shared/harness";
import { serveWorkerJobs } from "../../shared/reusable-worker-entry";
import { Database } from "../../shared/sqlite";
import { configureContextDatabasePragmas } from "../../shared/sqlite-context-pragmas";
import { exitOnWorkerClose, isWorkerCloseMessage } from "../../shared/worker-shutdown";
import type { ChunkEmbeddingWorkerRequest } from "./chunk-embedding-writer";
import {
    countUnembeddedSessionCompartments,
    loadUnembeddedSessionChunkCandidates,
    recordChunkEmbedBackoff,
    replaceCompartmentChunkEmbeddings,
} from "./compartment-chunk-embedding";
import {
    acquireGitSweepLease,
    releaseGitSweepLease,
    renewGitSweepLease,
} from "./git-commits/sweep-coordinator";
import { recordSessionProjectIdentity } from "./session-project-storage";
import { enforceSchemaFence, LATEST_SUPPORTED_VERSION } from "./storage-db";

serveWorkerJobs<{ path: string; harness: Parameters<typeof setHarness>[0]; timeout: number }>(
    (workerData, port) => {
        setHarness(workerData.harness);
        const db = new Database(workerData.path);
        if (!enforceSchemaFence(db, workerData.path, LATEST_SUPPORTED_VERSION)) {
            db.close();
            throw new Error("chunk embedding writer rejected an unsupported store schema");
        }
        const timeout = Math.max(0, Math.floor(workerData.timeout));
        db.exec(`PRAGMA busy_timeout=${timeout}; PRAGMA foreign_keys=ON`);
        configureContextDatabasePragmas(db);
        // Close this writable connection before the thread ends; see worker-shutdown.ts.
        exitOnWorkerClose(port, () => db.close(), false);
        port.on("message", (input: ChunkEmbeddingWorkerRequest) => {
            // The owner's close request is not an operation and gets no reply.
            if (isWorkerCloseMessage(input)) return;
            try {
                let value: unknown;
                switch (input.kind) {
                    case "replace":
                        replaceCompartmentChunkEmbeddings(db, input.rows, input.sourceKey);
                        break;
                    case "project":
                        recordSessionProjectIdentity(db, input.session, input.project);
                        break;
                    case "count":
                        value = countUnembeddedSessionCompartments(
                            db,
                            input.project,
                            input.session,
                            input.model,
                            input.tokens,
                        );
                        break;
                    case "candidates":
                        value = loadUnembeddedSessionChunkCandidates(
                            db,
                            input.project,
                            input.session,
                            input.model,
                            input.limit,
                            input.excluded,
                            input.tokens,
                            true,
                        );
                        break;
                    case "backoff":
                        recordChunkEmbedBackoff(db, input.candidate, input.project, input.model);
                        break;
                    case "acquire":
                        value = acquireGitSweepLease(db, input.project, input.holder, {
                            ignoreCooldown: true,
                        });
                        break;
                    case "renew":
                        value = renewGitSweepLease(db, input.project, input.holder);
                        break;
                    case "release":
                        releaseGitSweepLease(db, input.project, input.holder);
                        break;
                }
                port.postMessage({ value });
            } catch (error) {
                port.postMessage({ error: error instanceof Error ? error.message : String(error) });
            }
        });
    },
    false,
);
