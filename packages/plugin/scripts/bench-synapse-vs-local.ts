#!/usr/bin/env bun
/**
 * Speed benchmark: bundled local MiniLM lane vs Synapse over the subc daemon,
 * embedding real compartment texts pulled read-only from context.db.
 *
 * Usage: bun packages/plugin/scripts/bench-synapse-vs-local.ts [--n 100]
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { getMagicContextStorageDir } from "../src/shared/data-path";
import { SynapseEmbeddingProvider } from "../src/features/magic-context/memory/embedding-synapse";
import { LocalEmbeddingProvider } from "../src/features/magic-context/memory/embedding-local";

const nIdx = process.argv.indexOf("--n");
const N = nIdx >= 0 ? Number(process.argv[nIdx + 1]) : 100;

// Real corpus: compartment P1 paraphrases (the same content class the chunk
// embedder feeds), read-only.
const { Database } = await import("bun:sqlite");
const db = new Database(join(getMagicContextStorageDir(), "context.db"), {
    readonly: true,
});
const rows = db
    .query(`SELECT id, p1 FROM compartments WHERE p1 IS NOT NULL AND LENGTH(p1) > 100 ORDER BY id DESC LIMIT ${N}`)
    .all() as { id: number; p1: string }[];
db.close();
const totalChars = rows.reduce((s, r) => s + r.p1.length, 0);
console.log(`corpus: ${rows.length} compartment P1 texts, ${totalChars} chars total, avg ${(totalChars / rows.length).toFixed(0)}`);

const items = rows.map((r) => ({
    id: `compartment:${r.id}`,
    text: r.p1,
    contentSha256: new Bun.CryptoHasher("sha256").update(r.p1).digest("hex"),
}));

// Lane 1: Synapse over subc (gte-modernbert-base f16, Metal).
{
    const connectionFile = join(homedir(), ".local/share/cortexkit/run/subc-connection.json");
    const metadata = await SynapseEmbeddingProvider.discover({
        connectionFile,
        projectRoot: process.cwd(),
        session: `script:bench:${Date.now()}`,
    });
    const provider = new SynapseEmbeddingProvider({
        connectionFile,
        projectRoot: process.cwd(),
        session: `script:bench:${Date.now()}`,
        model: metadata.model,
        fingerprint: metadata.fingerprint,
        tableEpoch: metadata.table_epoch,
    });
    // Warm call outside the timed window so route open + model residency are
    // not billed to the throughput number.
    await provider.embed("warmup");
    const t = Date.now();
    const result = await provider.embedItems(items);
    const ms = Date.now() - t;
    console.log(
        `synapse (gte-modernbert-f16 @ subc): ${result.size}/${items.length} vectors in ${ms}ms  (${(ms / items.length).toFixed(1)}ms/item, ${((totalChars / 1000) / (ms / 1000)).toFixed(0)}k chars/s)`,
    );
}

// Lane 2: bundled local MiniLM (all-MiniLM-L6-v2 ONNX, 512-token truncation).
{
    const provider = new LocalEmbeddingProvider();
    const warm = await provider.embed("warmup");
    if (!warm) {
        console.error("local MiniLM unavailable (onnxruntime missing?)");
        process.exit(1);
    }
    const t = Date.now();
    const vectors = await provider.embedBatch(items.map((i) => i.text));
    const ms = Date.now() - t;
    const ok = vectors.filter((v) => v !== null).length;
    console.log(
        `local (all-MiniLM-L6-v2 onnx): ${ok}/${items.length} vectors in ${ms}ms  (${(ms / items.length).toFixed(1)}ms/item, ${((totalChars / 1000) / (ms / 1000)).toFixed(0)}k chars/s)`,
    );
}

process.exit(0);
