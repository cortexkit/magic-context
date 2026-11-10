import { openTestDb } from "./test-db";
import { join } from "node:path";
import type { RustTestHarness } from "./rust-harness";

type Row = { id: string; data: string; message_id?: string };

/**
 * Replay post-compaction raw history (at most 2048 messages) from a read-only
 * transaction into the disposable harness. Message/part IDs and agent/model
 * routing are remapped to the harness; text, reasoning and tool payloads remain
 * intact. The summary flag is cleared because the replay has no older history
 * for OpenCode's compaction filter to traverse.
 */
export function appendPerfReplay(
    h: RustTestHarness,
    sessionId: string,
    sourcePath: string,
    sourceSession: string,
): number {
    const source = openTestDb(sourcePath, { readonly: true });
    let messages: Row[];
    let parts: Row[];
    try {
        source.exec("BEGIN");
        const boundary =
            (
                source
                    .query(
                        "SELECT MAX(time_created) AS stamp FROM message WHERE session_id = ? AND json_extract(data, '$.summary') = 1",
                    )
                    .get(sourceSession) as { stamp: number | null }
            ).stamp ?? 0;
        messages = (
            source
                .query(
                    "SELECT id, data FROM message WHERE session_id = ? AND time_created >= ? ORDER BY time_created DESC, id DESC LIMIT 2048",
                )
                .all(sourceSession, boundary) as Row[]
        ).reverse();
        const readParts = source.query(
            "SELECT id, message_id, data FROM part WHERE message_id = ? ORDER BY time_created, id",
        );
        parts = messages.flatMap((row) => readParts.all(row.id) as Row[]);
        source.exec("COMMIT");
    } finally {
        source.close();
    }
    if (messages.length === 0) throw new Error("Replay source has no messages");
    const target = openTestDb(join(h.env.dataDir, "opencode", "opencode.db"));
    try {
        const seed = JSON.parse(
            (
                target
                    .query(
                        "SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' LIMIT 1",
                    )
                    .get(sessionId) as { data: string }
            ).data,
        );
        const latest = (
            target
                .query("SELECT MIN(time_created) AS stamp FROM message WHERE session_id = ?")
                .get(sessionId) as { stamp: number }
        ).stamp;
        const idFor = (prefix: string, stamp: number, counter: number) => {
            const encoded = ~(BigInt(stamp) * 0x1000n + BigInt(counter));
            const bytes = Buffer.alloc(6);
            for (let byte = 0; byte < 6; byte++)
                bytes[byte] = Number((encoded >> BigInt(40 - byte * 8)) & 255n);
            return `${prefix}_${bytes.toString("hex")}${counter.toString(36).padStart(14, "0")}`;
        };
        const ids = new Map(
            messages.map((row, index) => [
                row.id,
                {
                    id: idFor("msg", latest - messages.length + index - 1, 1),
                    stamp: latest - messages.length + index - 1,
                },
            ]),
        );
        const messageInsert = target.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        const partInsert = target.prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
        );
        target.transaction(() => {
            for (const row of messages) {
                const mapped = ids.get(row.id)!;
                const data = JSON.parse(row.data);
                const parent = ids.get(data.parentID);
                messageInsert.run(
                    mapped.id,
                    sessionId,
                    mapped.stamp,
                    mapped.stamp,
                    JSON.stringify({
                        ...data,
                        summary: false,
                        agent: "build",
                        ...(data.role === "user"
                            ? { model: seed.model }
                            : {
                                  providerID: seed.model?.providerID,
                                  modelID: seed.model?.modelID,
                              }),
                        id: mapped.id,
                        sessionID: sessionId,
                        ...(parent ? { parentID: parent.id } : {}),
                        time: { ...data.time, created: mapped.stamp },
                    }),
                );
            }
            let counter = 2;
            for (const row of parts) {
                const mapped = ids.get(row.message_id!);
                if (!mapped) continue;
                const id = idFor("prt", mapped.stamp, counter++ % 4096);
                partInsert.run(
                    id,
                    mapped.id,
                    sessionId,
                    mapped.stamp,
                    mapped.stamp,
                    JSON.stringify({
                        ...JSON.parse(row.data),
                        id,
                        messageID: mapped.id,
                        sessionID: sessionId,
                    }),
                );
            }
        })();
    } finally {
        target.close();
    }
    return messages.length;
}
