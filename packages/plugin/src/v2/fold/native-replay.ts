import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { HEAD_IDS } from "../hooks/payload";
import type { SessionContext, V2Context, V2Message } from "../hooks/types";
import {
    RAW_MESSAGE_TYPES,
    type StoreRow,
    type V2RowStamp,
    type V2StoreReader,
} from "../store-reader";
import { hostMediaAsset, hostUsesMediaAssets, rememberHostMedia } from "./host-media";
import type { NativeFoldCache, NativeRowRecord } from "./memory-cache";
import { encodeNative, NativeReplayUnavailable, reviveNative } from "./native-codec";
import { foldDigest } from "./owner";
import { restoreRow } from "./restore";

interface NativeTail {
    model: string;
    sourceSeq: number;
    baseline?: string;
}
interface Snapshot {
    source: string;
    sessionID: string;
    admissionID: string;
    summary: string;
}
interface DurableSnapshot {
    sourceDigest: string;
    sessionID: string;
    admissionID: string;
    summaryDigest: string;
    historyDigest: string;
}
const coordinates = new WeakMap<V2Message, string>();
export function nativeRowID(message: V2Message): string | undefined {
    return coordinates.get(message) ?? message.id;
}
export function copyNativeInput(messages: readonly V2Message[]): V2Message[] {
    const copies = reviveNative(encodeNative(messages));
    copies.forEach((copy, i) => {
        const original = messages[i];
        const id = original && nativeRowID(original);
        if (id !== undefined) coordinates.set(copy, id);
    });
    return copies;
}
export function isLocalCheckpoint(row: StoreRow): row is StoreRow<"compaction"> {
    return (
        row.type === "compaction" &&
        row.data.status === "completed" &&
        row.data.providerContext === undefined &&
        (row.data.native as { messages?: unknown } | undefined)?.messages === undefined
    );
}
export function isAdmittedLocalCheckpoint(
    storage: NativeFoldCache,
    sessionID: string,
    cut: StoreRow<"compaction">,
): boolean {
    if (!isLocalCheckpoint(cut) || cut.session_id !== sessionID) return false;
    const admission = storage.admission(sessionID, cut.id);
    if (!admission?.payload || admission.digest !== foldDigest(admission.payload)) return false;
    try {
        const snapshot = JSON.parse(admission.payload) as Snapshot;
        return (
            snapshot.source === storage.sourceID &&
            snapshot.sessionID === sessionID &&
            snapshot.admissionID === cut.id &&
            snapshot.summary === cut.data.summary
        );
    } catch {
        return false;
    }
}
const conversational = (row: { type: string }) =>
    (RAW_MESSAGE_TYPES as readonly string[]).includes(row.type) || row.type === "location-switched";
const historyDigest = (reader: V2StoreReader, sessionID: string, through: number) =>
    foldDigest(JSON.stringify(reader.range(sessionID, -1, through).filter(conversational)));
const admissionKey = (sessionID: string) => `native-fold/v2/${encodeURIComponent(sessionID)}`;

export async function forgetNativeFoldProvenance(
    storage: V2Context["storage"],
    sessionID: string,
    legacyOnly = false,
): Promise<void> {
    const remove = async (key: string) => {
        if (storage.remove) await storage.remove(key);
        else await storage.set(key, null);
    };
    if (!legacyOnly) await remove(admissionKey(sessionID));
    if (!storage.scan) return;
    let after: string | undefined;
    do {
        const page = await storage.scan({ prefix: "native-fold/v1/", after, limit: 100 });
        for (const { key } of page.entries) {
            // Legacy keys put the source hash before the session id. Scan
            // those keys even if this process has not observed the source.
            if (key.slice("native-fold/v1/".length).split("/").slice(1).join("/") === sessionID)
                await remove(key);
        }
        after = page.next;
    } while (after);
}

/** A disposable per-session row cache. The host owns the session history and
 * every edit and revert to it; this cache only holds copies. Host events
 * invalidate the copies of hidden rows, and visible rows are replaced from each
 * incoming draft. Rows missing from the cache or invalidated are rebuilt once
 * from the host store with restoreRow.
 */
export class NativeFoldReplay {
    private readonly changed = new Set<string>();
    private readonly dirty = new Set<string>();
    private readonly unavailable = new Set<string>();
    private readonly metadata = new Map<string, V2RowStamp[]>();
    private readonly metadataThrough = new Map<string, number>();
    private readonly loaded = new Map<string, number>();
    private readonly sources = new Map<string, string>();
    private readonly staleHeads = new Set<string>();
    constructor(
        readonly storage: NativeFoldCache,
        private readonly openReader: (sessionID: string) => V2StoreReader,
        private readonly admissions?: V2Context["storage"],
    ) {
        storage.onEvict((sessionID) => this.clear(sessionID));
    }
    private account(sessionID: string): void {
        const source = this.sources.get(sessionID);
        let bytes = 256 + (source?.length ?? 0) * 2;
        for (const row of this.metadata.get(sessionID) ?? [])
            bytes += 128 + (row.id.length + row.type.length) * 2;
        this.storage.accountReplay(sessionID, bytes);
    }

    async observeSource(sessionID: string, reader: V2StoreReader): Promise<void> {
        const source = reader.hostIdentity();
        const prior = this.sources.get(sessionID);
        if (prior && prior !== source) await this.forget(sessionID);
        this.sources.set(sessionID, source);
        this.account(sessionID);
    }
    onEvent(event: { type?: string; data?: { sessionID?: string; to?: string } }): void {
        const sessionID = event.data?.sessionID;
        if (
            sessionID &&
            (event.type?.startsWith("session.revert.") ||
                event.type === "session.message.content.updated")
        )
            this.invalidate(sessionID);
    }
    invalidate(sessionID: string, suppressNomination = false): void {
        if (suppressNomination) this.unavailable.add(sessionID);
        this.dirty.add(sessionID);
        this.changed.add(sessionID);
        this.metadata.delete(sessionID);
        this.metadataThrough.delete(sessionID);
        this.account(sessionID);
    }
    private tail(sessionID: string): NativeTail | undefined {
        const record = this.storage.tail(sessionID);
        return record ? (JSON.parse(record.data) as NativeTail) : undefined;
    }
    async baseline(sessionID: string): Promise<string | undefined> {
        return this.tail(sessionID)?.baseline;
    }
    private admissionKey(sessionID: string): string {
        return admissionKey(sessionID);
    }
    private async removeAdmission(key: string): Promise<void> {
        if (this.admissions?.remove) await this.admissions.remove(key);
        else await this.admissions?.set(key, null);
    }
    private async removeLegacyAdmissions(sessionID: string): Promise<void> {
        if (this.admissions) await forgetNativeFoldProvenance(this.admissions, sessionID, true);
    }
    async admits(
        sessionID: string,
        cut: StoreRow<"compaction">,
        reader: V2StoreReader,
    ): Promise<boolean> {
        if (!isLocalCheckpoint(cut) || cut.session_id !== sessionID) return false;
        if (isAdmittedLocalCheckpoint(this.storage, sessionID, cut)) return true;
        if (!this.admissions) return false;
        // Persist digests, not the summary or captured message bytes. A matching
        // host-store identity authorizes rebuilding only from that same store.
        try {
            const source = reader.hostIdentity();
            const saved = (await this.admissions.get(this.admissionKey(sessionID))) as
                | { payload: string; digest: string }
                | undefined;
            if (!saved?.payload || saved.digest !== foldDigest(saved.payload)) return false;
            const snapshot = JSON.parse(saved.payload) as DurableSnapshot;
            if (
                snapshot.sourceDigest !== foldDigest(source) ||
                snapshot.sessionID !== sessionID ||
                snapshot.admissionID !== cut.id ||
                snapshot.summaryDigest !== foldDigest(cut.data.summary ?? "")
            )
                return false;
            // The host-store identity can stay the same while hidden row contents
            // change. Compare pre-cut rows before accepting a cold admission;
            // host content-update events invalidate warm admissions without rescanning.
            if (snapshot.historyDigest !== historyDigest(reader, sessionID, cut.seq - 1)) {
                this.staleHeads.add(sessionID);
                this.invalidate(sessionID);
                await this.removeAdmission(this.admissionKey(sessionID));
                return false;
            }
            await this.storage.supply(
                sessionID,
                cut.id,
                JSON.stringify({
                    source: this.storage.sourceID,
                    sessionID,
                    admissionID: cut.id,
                    summary: cut.data.summary,
                }),
            );
            return true;
        } catch {
            return false;
        }
    }
    private rendered(row: StoreRow, model: SessionContext["model"]): V2Message[] {
        return restoreRow(
            row,
            model,
            hostUsesMediaAssets()
                ? {
                      asset: hostMediaAsset,
                      unavailable: () => {},
                  }
                : undefined,
        );
    }
    private record(
        row: Pick<StoreRow, "id" | "seq" | "type">,
        messages: readonly V2Message[],
    ): Omit<NativeRowRecord, "revision"> {
        const data = JSON.stringify(encodeNative(messages));
        return { id: row.id, type: row.type, seq: row.seq, data, digest: foldDigest(data) };
    }
    private records(
        sessionID: string,
        native: readonly V2Message[],
        reader: V2StoreReader,
    ): Omit<NativeRowRecord, "revision">[] {
        let metadata = this.metadata.get(sessionID);
        const through = reader.latestSequence(sessionID);
        const known = new Set(metadata?.map((row) => row.id));
        if (
            !metadata ||
            (this.metadataThrough.get(sessionID) ?? -1) < through ||
            native.some((message) => message.id && !known.has(message.id))
        ) {
            metadata = reader.rowStampsThrough(sessionID, through).filter(conversational);
            this.metadata.set(sessionID, metadata);
            this.metadataThrough.set(sessionID, through);
        }
        const byID = new Map(metadata.map((row) => [row.id, row]));
        const grouped = new Map<V2RowStamp, V2Message[]>();
        const anchorIndex = native.findIndex((message) => {
            const id = nativeRowID(message);
            return id !== undefined && byID.has(id);
        });
        const leading = native
            .slice(0, anchorIndex < 0 ? native.length : anchorIndex)
            .filter((message) => !nativeRowID(message) && message.role === "system");
        const anchorMessage = native[anchorIndex];
        const anchorID = anchorMessage && nativeRowID(anchorMessage);
        const anchor = anchorID ? byID.get(anchorID) : undefined;
        // A visible window may start after a checkpoint. Its leading systems belong
        // immediately before the nearest anchored row, not the oldest stored system.
        const leadingRows = anchor
            ? metadata
                  .filter((row) => row.type === "system" && row.seq < anchor.seq)
                  .slice(-leading.length)
            : [];
        const leadingIDs = new Map(leading.map((message, i) => [message, leadingRows[i]?.id]));
        let cursor = -1;
        let owner: string | undefined;
        for (const message of native) {
            let id = nativeRowID(message);
            if (!id && message.role === "system") {
                if (leadingIDs.has(message)) {
                    id = leadingIDs.get(message);
                    // Without an anchor, a leading system cannot be matched safely to
                    // a stored row. Do not cache it; missing hidden rows are read on restore.
                    if (!id) continue;
                } else id = metadata.find((row) => row.type === "system" && row.seq > cursor)?.id;
            }
            if (!id && message.role === "tool") id = owner;
            const row = id ? byID.get(id) : undefined;
            if (!row)
                throw new NativeReplayUnavailable("Native carrier has no source row coordinate");
            cursor = row.seq;
            coordinates.set(message, row.id);
            if (message.role !== "tool") owner = row.id;
            const messages = grouped.get(row) ?? [];
            messages.push(message);
            grouped.set(row, messages);
        }
        return [...grouped].map(([row, messages]) => this.record(row, messages));
    }
    async capture(
        draft: SessionContext,
        native: readonly V2Message[],
        boundary?: { id: string; summary: string },
    ): Promise<void> {
        // Capture is optional and runs after a servable transform. Cache trouble
        // cannot undo that transform or turn a usable request into an interruption.
        const release = this.storage.hold(draft.sessionID);
        try {
            rememberHostMedia(native);
            const reader = this.openReader(draft.sessionID);
            try {
                let rows = this.records(draft.sessionID, native, reader);
                const baseline = draft.messages
                    .find((message) => message.id === HEAD_IDS[0])
                    ?.content.find((part) => part.type === "text")?.text;
                const through = Math.max(-1, ...rows.map((row) => row.seq));
                // The served history head already replaces these rows. Keep only
                // its raw tail; edits and cold restores still read the host store.
                if (boundary && baseline === boundary.summary) {
                    const after = reader.sequenceForId(draft.sessionID, boundary.id);
                    if (after !== undefined) {
                        rows = rows.filter((row) => row.seq > after);
                        this.storage.replaceRows(draft.sessionID, through, rows);
                    }
                }
                const tail: NativeTail = {
                    model: `${draft.model.providerID}/${draft.model.id}`,
                    sourceSeq: through,
                    baseline:
                        typeof baseline === "string"
                            ? baseline
                            : this.tail(draft.sessionID)?.baseline,
                };
                await this.storage.saveTail(draft.sessionID, JSON.stringify(tail), rows);
                this.storage.truncate(draft.sessionID, through);
                this.loaded.set(draft.sessionID, through);
                this.unavailable.delete(draft.sessionID);
                this.changed.delete(draft.sessionID);
                this.staleHeads.delete(draft.sessionID);
            } finally {
                reader.close();
            }
        } catch {
            this.unavailable.add(draft.sessionID);
            this.invalidate(draft.sessionID);
        } finally {
            this.account(draft.sessionID);
            release();
        }
    }
    async canReplay(sessionID: string, _reader: V2StoreReader): Promise<boolean> {
        return (
            !this.unavailable.has(sessionID) && typeof (await this.baseline(sessionID)) === "string"
        );
    }
    async supply(args: {
        draft: SessionContext;
        reader: V2StoreReader;
        summary: string;
        previousCut?: StoreRow<"compaction">;
    }): Promise<boolean> {
        const release = this.storage.hold(args.draft.sessionID);
        try {
            return await this.supplyHeld(args);
        } finally {
            this.account(args.draft.sessionID);
            release();
        }
    }
    private async supplyHeld(args: {
        draft: SessionContext;
        reader: V2StoreReader;
        summary: string;
        previousCut?: StoreRow<"compaction">;
    }): Promise<boolean> {
        const { draft, reader, summary } = args;
        const tail = this.tail(draft.sessionID);
        const running = reader.latestRunningCompaction(draft.sessionID);
        const id = running?.id;
        const model = `${draft.model.providerID}/${draft.model.id}`;
        if (!id || (tail && tail.model !== model)) return false;
        const through = reader.latestSequence(draft.sessionID);
        const after = this.dirty.has(draft.sessionID) ? -1 : (tail?.sourceSeq ?? through);
        // An evicted capture is not missing history: the host store remains the
        // source of truth. Admit the checkpoint without copying the whole session
        // back into the cache; restore reads the required rows on the next turn.
        const fresh = tail
            ? reader.range(draft.sessionID, after, through).filter(conversational)
            : [];
        const records = fresh.map((row) => this.record(row, this.rendered(row, draft.model)));
        if (this.dirty.has(draft.sessionID))
            this.storage.replaceRows(draft.sessionID, through, records);
        await this.storage.saveTail(
            draft.sessionID,
            JSON.stringify({
                ...tail,
                model,
                baseline: tail?.baseline ?? summary,
                sourceSeq: Math.max(tail?.sourceSeq ?? through, ...fresh.map((row) => row.seq)),
            }),
            records,
        );
        this.dirty.delete(draft.sessionID);
        this.metadata.delete(draft.sessionID);
        this.metadataThrough.delete(draft.sessionID);
        this.loaded.set(draft.sessionID, through);
        const snapshot: Snapshot = {
            source: this.storage.sourceID,
            sessionID: draft.sessionID,
            admissionID: id,
            summary,
        };
        await this.storage.supply(draft.sessionID, id, JSON.stringify(snapshot));
        if (this.admissions) {
            const provenance: DurableSnapshot = {
                sourceDigest: foldDigest(reader.hostIdentity()),
                sessionID: draft.sessionID,
                admissionID: id,
                summaryDigest: foldDigest(summary),
                historyDigest: historyDigest(
                    reader,
                    draft.sessionID,
                    (running?.seq ?? through) - 1,
                ),
            };
            const payload = JSON.stringify(provenance);
            await this.admissions.set(this.admissionKey(draft.sessionID), {
                payload,
                digest: foldDigest(payload),
            });
            await this.removeLegacyAdmissions(draft.sessionID);
        }
        return true;
    }
    async restore(
        sessionID: string,
        cut: StoreRow<"compaction">,
        model: string,
        options: { bounded?: boolean; after?: number } = {},
    ): Promise<V2Message[] | undefined> {
        const release = this.storage.hold(sessionID);
        try {
            return await this.restoreHeld(sessionID, cut, model, options);
        } finally {
            this.account(sessionID);
            release();
        }
    }
    private async restoreHeld(
        sessionID: string,
        cut: StoreRow<"compaction">,
        model: string,
        options: { bounded?: boolean; after?: number },
    ): Promise<V2Message[] | undefined> {
        if (!isLocalCheckpoint(cut)) return undefined;
        const resolvedModel = {
            providerID: model.slice(0, model.indexOf("/")),
            id: model.slice(model.indexOf("/") + 1),
        };
        const tail = this.tail(sessionID);
        if (tail && tail.model !== model) this.invalidate(sessionID);
        let after = options.after ?? -1;
        let reader: V2StoreReader | undefined;
        try {
            if (options.bounded && options.after === undefined && !this.changed.has(sessionID)) {
                const state = getOrCreateSessionMeta(this.storage.db, sessionID);
                const max = this.storage.db
                    .prepare(
                        "SELECT COALESCE(MAX(id),0) AS id FROM m0_mutation_log WHERE session_id=?",
                    )
                    .get(sessionID) as { id: number };
                const boundary = (
                    this.storage.db
                        .prepare(
                            "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id=?",
                        )
                        .get(sessionID) as { id: string | null } | undefined
                )?.id;
                if (max.id <= (state.cachedM0MaxMutationId ?? 0) && boundary) {
                    after =
                        this.storage.sequenceForID(sessionID, boundary) ??
                        (reader = this.openReader(sessionID)).sequenceForId(sessionID, boundary) ??
                        -1;
                }
            }
            const through = cut.seq - 1;
            let metadata = this.metadata.get(sessionID);
            if (!metadata || (this.metadataThrough.get(sessionID) ?? -1) < through) {
                reader ??= this.openReader(sessionID);
                metadata = reader.rowStampsThrough(sessionID, through).filter(conversational);
                this.metadata.set(sessionID, metadata);
                this.metadataThrough.set(sessionID, through);
            }
            const required = metadata.filter((row) => row.seq > after && row.seq <= through);
            // Sequence numbers also cover non-message rows. Only explicit source-row
            // membership can certify a sparse or previously trimmed captured interval.
            if (
                this.dirty.has(sessionID) ||
                !tail ||
                ((this.loaded.get(sessionID) ?? -1) < through &&
                    !this.storage.admission(sessionID, cut.id)) ||
                !this.storage.containsRows(
                    sessionID,
                    required.map((row) => row.id),
                )
            ) {
                reader ??= this.openReader(sessionID);
                const fresh = reader.range(sessionID, after, through).filter(conversational);
                const records = fresh.map((row) =>
                    this.record(row, this.rendered(row, resolvedModel)),
                );
                const restored = new Set(records.map((row) => row.id));
                if (required.some((row) => !restored.has(row.id)))
                    throw new NativeReplayUnavailable("Host restore omitted a required source row");
                this.storage.replaceRows(sessionID, through, records, after);
                await this.storage.saveTail(
                    sessionID,
                    JSON.stringify({
                        model,
                        sourceSeq: through,
                        baseline: tail?.baseline ?? cut.data.summary,
                    }),
                    [],
                );
                this.loaded.set(sessionID, through);
                this.dirty.delete(sessionID);
            }
        } finally {
            reader?.close();
        }
        const messages: V2Message[] = [];
        for (const row of this.storage.rows(sessionID, after, cut.seq - 1)) {
            const revived = reviveNative(JSON.parse(row.data) as V2Message[]);
            for (const message of revived) coordinates.set(message, row.id);
            messages.push(...revived);
        }
        return messages;
    }
    async restoreRead(
        sessionID: string,
        cut: StoreRow<"compaction">,
        model: SessionContext["model"],
    ): Promise<V2Message[]> {
        const reader = this.openReader(sessionID);
        try {
            return reader
                .range(sessionID, -1, cut.seq - 1)
                .filter(conversational)
                .flatMap((row) => {
                    const messages = this.rendered(row, model);
                    for (const message of messages) coordinates.set(message, row.id);
                    return messages;
                });
        } finally {
            reader.close();
        }
    }
    sourceChanged(sessionID: string): boolean {
        return this.changed.has(sessionID);
    }
    needsHeadRebuild(sessionID: string): boolean {
        return this.staleHeads.has(sessionID);
    }
    private clear(sessionID: string): void {
        this.sources.delete(sessionID);
        this.metadata.delete(sessionID);
        this.metadataThrough.delete(sessionID);
        this.loaded.delete(sessionID);
        this.unavailable.delete(sessionID);
        this.dirty.delete(sessionID);
        this.changed.delete(sessionID);
        this.staleHeads.delete(sessionID);
    }
    async forget(sessionID: string): Promise<void> {
        // The session id locates the v2 key and matching legacy keys without any
        // prior source observation. Real hosts remove rows instead of leaving tombstones.
        if (this.admissions) await forgetNativeFoldProvenance(this.admissions, sessionID);
        await this.storage.forget(sessionID);
    }
}
