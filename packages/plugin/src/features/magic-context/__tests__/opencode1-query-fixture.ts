import { Database } from "../../../shared/sqlite";

/**
 * OpenCode v1.18.30, commit 3104c1428ec91f809e5ab86631300de41eb6952e:
 * https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/core/src/database/schema.gen.ts
 * Message/part DDL and indexes copied from lines 128-146 and 245-248.
 * Foreign keys remain declared; fixture connections leave enforcement off so
 * unrelated project/session tables need not be fabricated.
 */
export const OPENCODE1_MESSAGE_PART_SCHEMA = `
CREATE TABLE message (
    id text PRIMARY KEY,
    session_id text NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL,
    data text NOT NULL,
    CONSTRAINT fk_message_session_id_session_id_fk FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE TABLE part (
    id text PRIMARY KEY,
    message_id text NOT NULL,
    session_id text NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL,
    data text NOT NULL,
    CONSTRAINT fk_part_message_id_message_id_fk FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
);
CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
CREATE INDEX part_message_id_id_idx ON part(message_id, id);
CREATE INDEX part_session_idx ON part(session_id);`;

// Frozen pre-keyset queries, not constructed from the implementation under test.
export const OLD_BOUNDARY_SQL = `SELECT id, time_created, data
FROM message
WHERE session_id = ?
  AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
           AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
  AND COALESCE(json_extract(data, '$.role'), '') = 'user'
  AND (time_created < ? OR (time_created = ? AND id <= ?))
  AND NOT (
      EXISTS (SELECT 1 FROM part p
              WHERE p.message_id = message.id AND +p.session_id = message.session_id
                AND COALESCE(json_extract(p.data, '$.type'), '') <> 'compaction')
      AND NOT EXISTS (SELECT 1 FROM part p
                      WHERE p.message_id = message.id AND +p.session_id = message.session_id
                        AND COALESCE(json_extract(p.data, '$.type'), '') <> 'compaction'
                        AND COALESCE(json_extract(p.data, '$.synthetic'), 0) <> 1
                        AND COALESCE(json_extract(p.data, '$.syntheticTodoMarker'), 0) <> 1)
  )
ORDER BY time_created DESC, id DESC LIMIT 1`;

export const OLD_GAP_SQL = `SELECT 1 FROM message m
WHERE m.session_id=?
  AND (m.time_created>? OR (m.time_created=? AND m.id>?))
  AND (m.time_created<? OR (m.time_created=? AND m.id<?))
  AND NOT (COALESCE(json_type(m.data,'$.summary'),'')='true' AND COALESCE(json_extract(m.data,'$.finish'),'')='stop')
  AND NOT (
    EXISTS (SELECT 1 FROM part p WHERE p.message_id=m.id AND +p.session_id=m.session_id AND COALESCE(json_extract(p.data,'$.type'),'')<>'compaction')
    AND NOT EXISTS (SELECT 1 FROM part p WHERE p.message_id=m.id AND +p.session_id=m.session_id
        AND COALESCE(json_extract(p.data,'$.type'),'')<>'compaction'
        AND COALESCE(json_type(p.data,'$.synthetic'),'')<>'true'
        AND COALESCE(json_type(p.data,'$.syntheticTodoMarker'),'')<>'true')
  ) LIMIT 1`;

export const FIXTURE_SESSION = "ses-keyset";

// IDs intentionally run backwards within each timestamp group. A comparison
// based on IDs alone or timestamps alone cannot pass the differential.
export function fixtureKey(index: number): { id: string; timeCreated: number } {
    return {
        id: `msg_${String(index - (index % 4) + 3 - (index % 4)).padStart(7, "0")}`,
        timeCreated: 1_700_000_000_000 + Math.floor(index / 4),
    };
}

export function createQueryFixture(path: string, messages: number, parts: number): Database {
    const db = new Database(path);
    db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
    const insertMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const insertPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    const messagePadding = "m".repeat(512);
    const partText = "tool output ".repeat(24);
    db.transaction(() => {
        for (let index = 0; index < messages; index++) {
            const key = fixtureKey(index);
            const offset = index % 1024;
            const isUser = [0, 240, 480, 700, 710, 720, 730, 900, 901, 902].includes(offset);
            const summary = offset === 901 ? 1 : [900, 902, 903].includes(offset);
            insertMessage.run(
                key.id,
                FIXTURE_SESSION,
                key.timeCreated,
                key.timeCreated,
                JSON.stringify({
                    role: isUser ? "user" : "assistant",
                    summary,
                    finish: offset === 902 ? "length" : "stop",
                    agent: "build",
                    providerID: "fixture",
                    modelID: "fixture",
                    padding: messagePadding,
                }),
            );
            const count =
                Math.floor(((index + 1) * parts) / messages) -
                Math.floor((index * parts) / messages);
            for (let part = 0; part < count; part++) {
                // Empty, compaction-only, numeric/string flags, mixed real and
                // synthetic, todo wakes, and synthetic wakes carrying a marker.
                const owner = offset === 700 ? fixtureKey(Math.max(0, index - 1)) : key;
                const data =
                    offset === 710 || (offset === 240 && part === 0)
                        ? { type: "compaction", auto: true }
                        : {
                              type: isUser ? "text" : part % 2 ? "tool" : "reasoning",
                              text: partText,
                              synthetic:
                                  offset === 240 || (offset === 902 && part > 0)
                                      ? true
                                      : offset === 720
                                        ? 1
                                        : offset === 730
                                          ? "true"
                                          : false,
                              syntheticTodoMarker: offset === 480,
                          };
                insertPart.run(
                    `prt_${index}_${part}`,
                    owner.id,
                    FIXTURE_SESSION,
                    key.timeCreated,
                    key.timeCreated,
                    JSON.stringify(data),
                );
            }
        }
        // These must not disqualify a synthetic wake in the requested session.
        insertPart.run("prt_foreign", fixtureKey(240).id, "ses-other", 0, 0, '{"type":"text"}');
        insertMessage.run("msg_foreign", "ses-other", 1, 1, '{"role":"user"}');
    }).immediate();
    return db;
}

export function explainQuery(db: Database, sql: string, args: unknown[]): string[] {
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map(
        (row) => row.detail,
    );
}

function oldTarget(
    db: Database,
    targetId: string,
): { id: string; time_created: number } | undefined {
    return db
        .prepare(`SELECT id, time_created FROM message WHERE session_id=? AND id=?
        AND NOT (COALESCE(json_extract(data,'$.summary'),0)=1 AND COALESCE(json_extract(data,'$.finish'),'')='stop')`)
        .get(FIXTURE_SESSION, targetId) as { id: string; time_created: number } | undefined;
}

export function oldBoundary(
    db: Database,
    targetId: string,
): { id: string; timeCreated: number } | null {
    const target = oldTarget(db, targetId);
    if (!target) return null;
    const row = db
        .prepare(OLD_BOUNDARY_SQL)
        .get(FIXTURE_SESSION, target.time_created, target.time_created, target.id) as
        | { id: string; time_created: number }
        | undefined;
    return row ? { id: row.id, timeCreated: row.time_created } : null;
}

export function oldGap(db: Database, endId: string, nextId: string): boolean {
    const end = oldTarget(db, endId);
    const next = oldTarget(db, nextId);
    if (
        !end ||
        !next ||
        end.time_created > next.time_created ||
        (end.time_created === next.time_created && end.id >= next.id)
    )
        return false;
    return !db
        .prepare(OLD_GAP_SQL)
        .get(
            FIXTURE_SESSION,
            end.time_created,
            end.time_created,
            end.id,
            next.time_created,
            next.time_created,
            next.id,
        );
}

export function randomFixtureIndices(count: number, messages: number): number[] {
    let seed = 0x12345678;
    return Array.from({ length: count }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % messages;
    });
}
