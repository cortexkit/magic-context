import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "../../../../plugin/src/shared/sqlite";
import { gaDatabasePath, V2StoreReader } from "../../../../plugin/src/v2/store-reader";
import type { OpenCode2TestHarness } from "../../../src/opencode2-harness";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function expectNativeAdmission(h: OpenCode2TestHarness, sessionID: string): void {
    const path = gaDatabasePath(h.dataDir, "latest", h.opencode.env);
    const reader = new V2StoreReader(path);
    const db = new Database(path, { readonly: true });
    try {
        const cut = reader.latestCompaction(sessionID);
        if (!cut) throw new Error("expected a completed host checkpoint");
        expect(cut.data.status).toBe("completed");
        const suffix = `:native-fold/v3/${encodeURIComponent(sessionID)}`;
        const rows = (
            db.prepare("SELECT key,value FROM kv WHERE key LIKE ?").all(`%${suffix}`) as Array<{
                key: string;
                value: string;
            }>
        ).filter((row) => row.key.endsWith(suffix));
        expect(rows).toHaveLength(1);
        const receipt = JSON.parse(rows[0]!.value) as { payload: string; digest: string };
        expect(receipt.digest).toBe(sha256(receipt.payload));
        const value = JSON.parse(receipt.payload);
        expect(value.version).toBe(3);
        expect(Object.keys(value).sort()).toEqual(["proof", "replay", "version"]);
        const provenance = value.proof;
        expect(Object.keys(provenance).sort()).toEqual([
            "admissionID", "historyDigest", "sessionID", "sourceDigest", "summaryDigest",
        ]);
        expect(provenance).toMatchObject({
            admissionID: cut.id,
            sessionID,
            sourceDigest: sha256(reader.hostIdentity()),
            summaryDigest: sha256(cut.data.summary ?? ""),
        });
        expect(provenance.historyDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(value.replay.floor.digest).toMatch(/^[0-9a-f]{64}$/);
        expect(Number.isSafeInteger(value.replay.floor.after)).toBe(true);
        expect(value.replay.controls.every((control: Record<string, unknown>) =>
            Object.keys(control).every(key => ["after", "effort", "previous"].includes(key)),
        )).toBe(true);
    } finally {
        reader.close();
        db.close();
    }
}

export function summaryHeads(body: unknown): string[] {
    const text = JSON.stringify((body as { messages?: unknown }).messages);
    if (!text) throw new Error("expected provider messages containing Magic Context heads");
    return ["session-history", "session-history-since"].map((tag) => {
        const head = text.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`))?.[0];
        if (!head) throw new Error(`provider request omitted ${tag}`);
        return head;
    });
}
