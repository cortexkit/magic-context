import { createHash } from "node:crypto";
import { registerStoredHistoryNotice } from "../../hooks/magic-context/stored-history-notice";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import type { V2StoreReader } from "../store-reader";
import { deliverSynthetic } from "./channel2";
import { FORK_HISTORY_NOTICE } from "./storage-notice";
import { registerCopiedNoticeAdmission } from "./synthetic-admission";
import type { V2Context } from "./types";

const keyFor = (sessionID: string) => `fork-history-notice/${sessionID}`;
const noticeIDFor = (sessionID: string) =>
    `msg_${createHash("sha256").update(`magic-context fork history notice\0${sessionID}`).digest("hex").slice(0, 24)}`;
type NoticeState = "absent" | "delivered" | "legacy-claim" | { id: string };

export function registerForkHistoryNotice(context: V2Context, openReader: () => V2StoreReader) {
    const states = new BoundedSessionMap<NoticeState>(1000);
    const attemptedUser = new BoundedSessionMap<string>(1000);
    const running = new Set<string>();
    const withReader = <T>(fn: (reader: V2StoreReader) => T): T => {
        const reader = openReader();
        try {
            return fn(reader);
        } finally {
            reader.close();
        }
    };
    const wasProjected = (reader: V2StoreReader, sessionID: string, id: string) => {
        const row = reader.messageById(sessionID, id);
        return row?.type === "synthetic" && row.data.text === FORK_HISTORY_NOTICE;
    };
    const unregisterAdmission = registerCopiedNoticeAdmission(context.storage, (sessionID, id) =>
        // Forks copy synthetic rows too, but remint their ids without copying the
        // admission keys. Authenticate the exact notice from the host's row kind;
        // a user who types the same text has a user row, not a synthetic row.
        withReader((reader) => wasProjected(reader, sessionID, id)),
    );
    const readState = async (sessionID: string): Promise<NoticeState> => {
        const known = states.get(sessionID);
        if (known !== undefined) return known;
        // One asynchronous host lookup per cold session. A diagnosed gap
        // writes the cache as well as host storage, so healthy passes stay in memory.
        const record = await context.storage.get(keyFor(sessionID));
        const concurrent = states.get(sessionID);
        if (concurrent !== undefined) return concurrent;
        const id = noticeIDFor(sessionID);
        const state =
            record === "delivered"
                ? "delivered"
                : record === true
                  ? "legacy-claim"
                  : typeof record === "object" &&
                      record !== null &&
                      "id" in record &&
                      record.id === id
                    ? { id }
                    : "absent";
        states.set(sessionID, state);
        return state;
    };
    const persist = async (sessionID: string, state: "delivered" | { id: string }) => {
        await context.storage.set(keyFor(sessionID), state);
        states.set(sessionID, state);
    };
    const unregisterNotice = registerStoredHistoryNotice(
        context.location.directory,
        async (sessionID, gap) => {
            try {
                if (!withReader((reader) => reader.forkOrigin(sessionID))) return false;
                if ((await readState(sessionID)) !== "absent") return true;
                // The historian records intent only. An idle check and a later
                // steer are separate host operations and can race a real turn.
                await persist(sessionID, { id: noticeIDFor(sessionID) });
                sessionLog(
                    sessionID,
                    `v2 fork saved history has a gap (${gap}); /ctx-recomp repairs this fork`,
                );
                return true;
            } catch (error) {
                sessionLog(sessionID, "v2 fork history notice check failed:", error);
                return false;
            }
        },
    );
    return {
        async deliverFromUserPass(sessionID: string, userID: string | undefined): Promise<void> {
            if (running.has(sessionID)) return;
            running.add(sessionID);
            try {
                let state = await readState(sessionID);
                if (state === "absent" || state === "delivered") return;
                if (state === "legacy-claim") {
                    // Older builds kept only a boolean. Preserve an existing
                    // notice, but a claim without a row still needs delivery.
                    const delivered = withReader((reader) =>
                        [...reader.syntheticMessageIDs(sessionID)].some(
                            (id) => !/_\d+$/.test(id) && wasProjected(reader, sessionID, id),
                        ),
                    );
                    if (delivered) {
                        await persist(sessionID, "delivered");
                        return;
                    }
                    state = { id: noticeIDFor(sessionID) };
                    await persist(sessionID, state);
                }
                const { id } = state;
                if (withReader((reader) => wasProjected(reader, sessionID, id))) {
                    await persist(sessionID, "delivered");
                    return;
                }
                if (
                    !userID ||
                    attemptedUser.get(sessionID) === userID ||
                    !withReader((reader) => reader.messageById(sessionID, userID)?.type === "user")
                )
                    return;
                attemptedUser.set(sessionID, userID);
                // Steer only while the host is serving a real user pass. The
                // same admitted id is used after a restart, and the pending
                // record is cleared only when the exact host row is visible.
                await deliverSynthetic(context, sessionID, FORK_HISTORY_NOTICE, id);
                if (withReader((reader) => wasProjected(reader, sessionID, id)))
                    await persist(sessionID, "delivered");
            } catch (error) {
                sessionLog(sessionID, "v2 fork history notice could not be delivered:", error);
            } finally {
                running.delete(sessionID);
            }
        },
        forget(sessionID: string) {
            states.delete(sessionID);
            attemptedUser.delete(sessionID);
        },
        dispose() {
            unregisterNotice();
            unregisterAdmission();
        },
    };
}
