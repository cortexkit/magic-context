import { join } from "node:path";
import { NOW } from "./upgrade-audit";
import { databaseSizes, resetPeak, peakKiB } from "./upgrade-metrics";
import { releasedWriters } from "./upgrade-release-context";
import {
    messageContentSnapshot,
    lkgContentDigestFromFields,
} from "../../packages/plugin/src/hooks/magic-context/lkg-slot";
import { MOVED_COLUMNS } from "./upgrade-payloads";

const [mode, tree, root] = process.argv.slice(2);
Date.now = () => NOW;
if (mode === "seed") {
    const writers = await releasedWriters(join(tree, "packages/plugin/dist"));
    const db = writers.openDatabase(join(root, "context.db"));
    if (!db) throw new Error("Released writer refused synthetic context.db");
    try {
        const { insertTag } = writers;
        const { indexSourcesAfterOrdinal } = writers;
        const { appendCompartments } = writers;
        const { insertMemory } = writers;
        const { addNote } = writers;
        const { ensureSessionMetaRow } = writers;
        const { recordSessionProjectIdentity } = writers;
        const { armThinkingBindingRecovery } = writers;
        const { saveLkgSlotToDb } = writers;
        db.prepare(
            "INSERT INTO workspaces(name,created_at,updated_at) VALUES ('rehearsal',?,?)",
        ).run(NOW, NOW);
        for (const [identity, name] of [
            ["git:upgrade-rehearsal", "main"],
            ["git:upgrade-peer", "peer"],
        ])
            db.prepare(
                "INSERT INTO workspace_members(workspace_id,project_path,display_name,display_path,added_at) VALUES (1,?,?,?,?)",
            ).run(identity, name, join(root, name), NOW);
        for (let s = 0; s < 20; s++) {
            const session = `session-${String(s).padStart(2, "0")}`;
            ensureSessionMetaRow(db, session);
            recordSessionProjectIdentity(db, session, "git:upgrade-rehearsal");
            const message = {
                info: { id: `signed-${s}`, role: "assistant" },
                parts: [
                    {
                        type: "thinking",
                        thinking: `Preserved reasoning ${s} 東京`,
                        signature: `fixture-signature-${s}`,
                    },
                    { type: "text", text: `Stored answer ${s} for tag continuity 東京` },
                ],
            };
            const snapshot = messageContentSnapshot(message);
            if (
                !saveLkgSlotToDb(db, session, {
                    jsonPrefix: JSON.stringify([message]),
                    inputIdSeq: [message.info.id],
                    inputContentDigests: [lkgContentDigestFromFields(snapshot.fields)],
                    inputContentSignatures: [snapshot.signature],
                    lastInputMessageId: message.info.id,
                    modelKey: "fixture-model",
                    providerKey: "anthropic",
                    capturedAt: NOW,
                })
            )
                throw new Error(`Could not persist LKG for ${session}`);
            armThinkingBindingRecovery(db, session);
            // Populate the released inline layout so the split must preserve real bytes,
            // including large replay collections and the distinction between NULL and empty.
            if (s % 4 !== 0)
                for (const column of MOVED_COLUMNS) {
                    const collection = JSON.stringify(
                        Array.from({ length: 700 }, (_, i) => `message-${s}-${i}-東京`),
                    );
                    const value =
                        s % 4 === 1
                            ? ""
                            : column.endsWith("_ids")
                              ? collection
                              : JSON.stringify({
                                    fixture: column,
                                    text: "Unicode 東京 🧠 ".repeat(500),
                                });
                    db.prepare(`UPDATE session_meta SET ${column}=? WHERE session_id=?`).run(
                        value,
                        session,
                    );
                }
            const count = s === 0 ? 150_000 : 500;
            for (let start = 1; start <= count; start += 1000) {
                const sources = Array.from(
                    { length: Math.min(1000, count - start + 1) },
                    (_, i) => {
                        const n = start + i;
                        const content = `Session ${s} message ${n}: preserve Unicode 東京 🧠, code, decisions and tool results.\n${"Realistic repeated payload with identifiers and paths. ".repeat(12)} unique-${s}-${n}`;
                        return {
                            id: `message-${s}-${n}`,
                            ordinal: n,
                            role: n % 2 ? "user" : "assistant",
                            createdAt: NOW - (count - n) * 1000,
                            sourceVersion: "1",
                            contentHash: new Bun.CryptoHasher("sha256")
                                .update(content)
                                .digest("hex"),
                            content,
                        };
                    },
                );
                indexSourcesAfterOrdinal(db, session, sources, sources.at(-1)!.ordinal);
                db.transaction(() => {
                    for (const source of sources)
                        insertTag(db, session, source.id, "message", 750, source.ordinal);
                }).immediate();
            }
            appendCompartments(
                db,
                session,
                Array.from({ length: s === 0 ? 2300 : 6 }, (_, i) => ({
                    sequence: i + 1,
                    startMessage: i * 65 + 1,
                    endMessage: (i + 1) * 65,
                    startMessageId: `message-${s}-${i * 65 + 1}`,
                    endMessageId: `message-${s}-${(i + 1) * 65}`,
                    title: `Design ${s}/${i}`,
                    content: `Compartment ${s}/${i}: ${"Exact archival content 東京. ".repeat(60)}`,
                    p1: `Full summary ${s}/${i}. ${"Implementation constraints and decisions. ".repeat(16)}`,
                    p2: `Concise summary ${s}/${i}`,
                    p3: `Decision ${s}/${i}`,
                    p4: `Landmark ${s}/${i}`,
                    importance: 50 + (i % 50),
                    episodeType: "design",
                })),
            );
            for (let i = 0; i < 5; i++) {
                addNote(db, "session", {
                    sessionId: session,
                    content: `Follow-up ${s}/${i}: 東京`,
                    anchorOrdinal: count - i,
                });
                addNote(db, "smart", {
                    sessionId: session,
                    projectPath: "git:upgrade-rehearsal",
                    content: `Check ${s}/${i}`,
                    surfaceCondition: "After the build passes",
                });
            }
        }
        db.transaction(() => {
            for (let i = 0; i < 1000; i++) {
                const memory = insertMemory(db, {
                    projectPath: "git:upgrade-rehearsal",
                    category: "CONSTRAINTS",
                    content: `Memory ${i}: preserve exact content 東京 🧠. ${"Architectural constraint. ".repeat(12)}`,
                    sourceType: "agent",
                    sourceSessionId: `session-${String(i % 20).padStart(2, "0")}`,
                });
                const embedding = new Float32Array(384);
                for (let j = 0; j < embedding.length; j++) embedding[j] = ((i + j) % 100) / 100;
                db.prepare(
                    "INSERT INTO memory_embeddings(memory_id,embedding,model_id) VALUES (?,?,'fixture-384')",
                ).run(memory.id, Buffer.from(embedding.buffer));
                db.prepare(
                    "INSERT INTO git_commits(sha,project_path,short_sha,message,author,committed_at,indexed_at) VALUES (?,?,?,?,?,?,?)",
                ).run(
                    i.toString(16).padStart(40, "0"),
                    "git:upgrade-rehearsal",
                    i.toString(16).padStart(7, "0"),
                    `Commit ${i}: exact content`,
                    "fixture",
                    NOW - i * 60000,
                    NOW,
                );
            }
        }).immediate();
        console.log(
            "Seeded 20 sessions, 159500 messages, 2414 compartments, 1000 memories/commits/384-d embeddings, 200 notes, 20 signed-thinking LKG/recovery/project records and a two-member workspace using released writers",
        );
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
        db.close();
    }
} else {
    const { Database } = await import("../../packages/plugin/src/shared/sqlite");
    const { openDatabase } = await import(
        "../../packages/plugin/src/features/magic-context/storage-db"
    );
    const { MIGRATIONS, runMigrations } = await import(
        "../../packages/plugin/src/features/magic-context/migrations"
    );
    const db =
        mode === "measure-context"
            ? new Database(join(root, "context.db"))
            : openDatabase(join(root, "context.db"));
    if (!db) throw new Error("Candidate refused context.db");
    try {
        if (mode === "measure-context") {
            const chain = [...MIGRATIONS];
            try {
                for (const step of chain.filter((m) => m.version > 95)) {
                    // The real migration runner retains ownership of its transaction and ledger.
                    MIGRATIONS.splice(
                        0,
                        MIGRATIONS.length,
                        ...chain.filter((m) => m.version <= step.version),
                    );
                    const before = databaseSizes(join(root, "context.db"));
                    resetPeak();
                    const started = performance.now();
                    runMigrations(db);
                    console.log(
                        `REHEARSAL_METRIC ${JSON.stringify({ database: "context", version: step.version, seconds: (performance.now() - started) / 1000, peakKiB: peakKiB(), beforeMainWal: before, afterMainWal: databaseSizes(join(root, "context.db")) })}`,
                    );
                }
            } finally {
                MIGRATIONS.splice(0, MIGRATIONS.length, ...chain);
            }
        }
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
        db.close();
    }
}
