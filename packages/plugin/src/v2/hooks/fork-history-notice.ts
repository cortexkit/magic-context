import { registerStoredHistoryNotice } from "../../hooks/magic-context/stored-history-notice";
import { getDataDir } from "../../shared/data-path";
import { sessionLog } from "../../shared/logger";
import { withoutSqliteTransformPass } from "../../shared/sqlite";
import { gaDatabasePath, V2StoreReader } from "../store-reader";
import { deliverSynthetic } from "./channel2";
import { FORK_HISTORY_NOTICE } from "./storage-notice";
import { registerCopiedNoticeAdmission } from "./synthetic-admission";
import type { V2Context } from "./types";

export function registerForkHistoryNotice(context: V2Context): () => void {
    const readHost = () =>
        new V2StoreReader(gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"));
    const unregisterAdmission = registerCopiedNoticeAdmission(context.storage, (sessionID, id) => {
        // Forks copy synthetic rows too, but remint their ids without copying the
        // admission keys. Authenticate the exact notice from the host's row kind;
        // a user who types the same text has a user row, not a synthetic row.
        const reader = readHost();
        try {
            const row = reader.messageById(sessionID, id);
            return row?.type === "synthetic" && row.data.text === FORK_HISTORY_NOTICE;
        } finally {
            reader.close();
        }
    });
    const unregisterNotice = registerStoredHistoryNotice(
        context.location.directory,
        async (sessionID, gap) => {
            try {
                const reader = readHost();
                try {
                    if (!reader.forkOrigin(sessionID)) return false;
                } finally {
                    reader.close();
                }
                // The per-session historian lease serializes the claim. Claim in
                // durable host plugin storage before sending, so a host restart
                // cannot repeat the notice after delivery.
                const key = `fork-history-notice/${sessionID}`;
                if ((await context.storage.get(key)) === true) return true;
                await context.storage.set(key, true);
                sessionLog(
                    sessionID,
                    `v2 fork saved history has a gap (${gap}); /ctx-recomp repairs this fork`,
                );
                // The stored notice uses the ordinary synthetic admission and is
                // stripped before any model request. Wait outside the current turn:
                // an older host can otherwise discard the synthetic on interruption.
                void withoutSqliteTransformPass(() =>
                    Promise.resolve()
                        .then(() => context.session.wait({ sessionID }))
                        .then(() => deliverSynthetic(context, sessionID, FORK_HISTORY_NOTICE))
                        .catch((error: unknown) =>
                            sessionLog(
                                sessionID,
                                "v2 fork history notice could not be delivered:",
                                error,
                            ),
                        ),
                );
                return true;
            } catch (error) {
                sessionLog(sessionID, "v2 fork history notice check failed:", error);
                return false;
            }
        },
    );
    return () => {
        unregisterNotice();
        unregisterAdmission();
    };
}
