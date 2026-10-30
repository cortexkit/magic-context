import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { readSessionMeta } from "../../features/magic-context/storage-meta-session";
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
import {
    type AdmissionV3,
    ControlMetadataUnavailable,
    captureControls,
    controlsThrough,
    effortPart,
    floorFor,
    importedFloor,
    insertControls,
    type ReplayFloor,
    type ReplayStateV3,
    validControls,
    validFloor,
} from "./native-replay-v3";
import { foldDigest } from "./owner";
import { restoreRow } from "./restore";

interface NativeTail {
    model: string;
    sourceSeq: number;
    baseline?: string;
    replay?: ReplayStateV3;
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
const historyDigest = (reader: V2StoreReader, sessionID: string, through: number, after = -1) =>
    foldDigest(JSON.stringify(reader.range(sessionID, after, through).filter(conversational)));
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
    if (!legacyOnly) {
        await remove(admissionKey(sessionID));
        await remove(`native-fold/v3/${encodeURIComponent(sessionID)}`);
    }
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
    private readonly metadataAfter = new Map<string, number | undefined>();
    private readonly loaded = new Map<string, number>();
    private readonly sources = new Map<string, string>();
    private readonly staleHeads = new Set<string>();
    constructor(
        readonly storage: NativeFoldCache,
        private readonly openReader: (sessionID: string) => V2StoreReader,
        private readonly admissions?: V2Context["storage"],
        private readonly options: {
            protocol?: 2 | 3;
            log?: (sessionID: string, line: string) => void;
        } = {},
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
        return this.options.protocol === 3
            ? `native-fold/v3/${encodeURIComponent(sessionID)}`
            : admissionKey(sessionID);
    }
    private report(sessionID: string, reason: string): void {
        try {
            this.options.log?.(sessionID, `v3 host fold: ${reason}`);
        } catch {}
    }
    private async floorState(
        sessionID: string,
        reader: V2StoreReader,
        boundary?: { id: string; summary: string },
        served?: SessionContext,
    ): Promise<ReplayStateV3 | undefined> {
        const retained = this.tail(sessionID)?.replay;
        const memory =
            retained &&
            validControls(retained.controls) &&
            validFloor(reader, sessionID, retained.floor)
                ? retained
                : undefined;
        const cut = reader.latestCompaction(sessionID);
        const saved = await this.readV3(sessionID);
        const durable =
            saved &&
            saved.proof.sourceDigest === foldDigest(reader.hostIdentity()) &&
            (!cut || saved.proof.admissionID === cut.id) &&
            validFloor(reader, sessionID, saved.replay.floor)
                ? saved.replay
                : undefined;
        const imported = importedFloor(reader, sessionID, cut?.seq);
        const existing = memory ?? durable;
        let floor: ReplayFloor | undefined = existing?.floor ?? imported;
        if (imported && (!floor || imported.after > floor.after)) floor = imported;
        if (cut) {
            const meta = readSessionMeta(this.storage.db, sessionID);
            const max = this.storage.db
                .prepare("SELECT COALESCE(MAX(id),0) AS id FROM m0_mutation_log WHERE session_id=?")
                .get(sessionID) as { id: number };
            const bound = this.storage.db
                .prepare(
                    "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id=?",
                )
                .get(sessionID) as { id: string | null } | undefined;
            const seq = bound?.id ? reader.sequenceForId(sessionID, bound.id) : undefined;
            if (
                meta.cachedM0Bytes &&
                max.id <= (meta.cachedM0MaxMutationId ?? 0) &&
                seq !== undefined &&
                (!floor || seq > floor.after)
            ) {
                const row = reader
                    .range(sessionID, seq - 1, seq)
                    .find((row) => row.id === bound?.id);
                if (row) floor = floorFor(row, "summary");
            }
        }
        const baseline = served ? this.servedBaseline(served) : undefined;
        if (boundary && baseline === boundary.summary) {
            const seq = reader.sequenceForId(sessionID, boundary.id);
            if (seq !== undefined && (!floor || seq > floor.after)) {
                const row = reader
                    .range(sessionID, seq - 1, seq)
                    .find((row) => row.id === boundary.id);
                if (row) floor = floorFor(row, "summary");
            }
        }
        if (!floor && !cut) {
            const row = reader.page(sessionID, { limit: 1 }).rows[0];
            if (row) floor = floorFor(row, "start");
        }
        return floor
            ? { floor, controls: existing?.controls ?? [], blocked: existing?.blocked }
            : undefined;
    }
    private async readV3(sessionID: string): Promise<AdmissionV3 | undefined> {
        const saved = (await this.admissions?.get(this.admissionKey(sessionID))) as
            | { payload?: string; digest?: string }
            | undefined;
        if (!saved?.payload || saved.digest !== foldDigest(saved.payload)) return undefined;
        const value = JSON.parse(saved.payload) as AdmissionV3;
        return value.version === 3 &&
            value.proof?.sessionID === sessionID &&
            value.replay &&
            validControls(value.replay.controls)
            ? value
            : undefined;
    }
    private servedBaseline(draft: SessionContext): string | undefined {
        const identified = draft.messages
            .find((message) => message.id === HEAD_IDS[0])
            ?.content.find((part) => part.type === "text")?.text;
        if (typeof identified === "string") return identified;
        if (this.options.protocol !== 3) return undefined;
        const cached = readSessionMeta(this.storage.db, draft.sessionID).cachedM0Bytes?.toString(
            "utf8",
        );
        return cached &&
            draft.messages.some((message) =>
                message.content.some((part) => part.type === "text" && part.text === cached),
            )
            ? cached
            : undefined;
    }
    private async retainReplay(
        sessionID: string,
        replay: ReplayStateV3,
        model: string,
        sourceSeq: number,
    ): Promise<void> {
        const tail = this.tail(sessionID) ?? { model, sourceSeq };
        await this.storage.saveTail(sessionID, JSON.stringify({ ...tail, replay }), []);
        if (!this.storage.tail(sessionID))
            await this.storage.saveTail(
                sessionID,
                JSON.stringify({ model, sourceSeq, replay }),
                [],
            );
    }
    async canFold(sessionID: string, reader: V2StoreReader): Promise<boolean> {
        if (this.options.protocol !== 3) {
            const future = await this.admissions?.get(
                `native-fold/v3/${encodeURIComponent(sessionID)}`,
            );
            if (future) {
                this.report(sessionID, "refused: unsupported admission version");
                return false;
            }
            return true;
        }
        const replay = await this.floorState(sessionID, reader);
        if (!replay || replay.blocked) {
            this.report(
                sessionID,
                "refused: no usable host replay boundary; waiting for a permitted rebuild",
            );
            return false;
        }
        return true;
    }
    async restorationFloor(
        sessionID: string,
        cut: StoreRow<"compaction">,
        reader: V2StoreReader,
    ): Promise<number | undefined> {
        if (this.options.protocol !== 3) return undefined;
        const replay = await this.floorState(sessionID, reader);
        if (replay) return replay.floor.after;
        const current = await this.admissions?.get(this.admissionKey(sessionID));
        const legacy = (await this.admissions?.get(admissionKey(sessionID))) as
            | { payload?: string }
            | undefined;
        if (current || legacy?.payload) {
            this.report(sessionID, "replay refused: no usable host checkpoint boundary");
            throw new NativeReplayUnavailable("Host checkpoint replay boundary is unavailable");
        }
        return undefined;
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
        if (this.options.protocol === 3) {
            const saved = await this.readV3(sessionID);
            if (!saved || !isLocalCheckpoint(cut) || cut.session_id !== sessionID) return false;
            const proof = saved.proof;
            if (
                proof.sourceDigest !== foldDigest(reader.hostIdentity()) ||
                proof.admissionID !== cut.id ||
                proof.summaryDigest !== foldDigest(cut.data.summary ?? "") ||
                !validFloor(reader, sessionID, saved.replay.floor)
            ) {
                this.report(sessionID, "replay refused: invalid checkpoint floor or provenance");
                return false;
            }
            await this.retainReplay(
                sessionID,
                saved.replay,
                this.tail(sessionID)?.model ?? "",
                cut.seq - 1,
            );
            if (
                proof.historyDigest !==
                historyDigest(reader, sessionID, cut.seq - 1, saved.replay.floor.after)
            ) {
                this.staleHeads.add(sessionID);
                this.invalidate(sessionID);
                await this.removeAdmission(this.admissionKey(sessionID));
                await this.retainReplay(
                    sessionID,
                    saved.replay,
                    this.tail(sessionID)?.model ?? "",
                    cut.seq - 1,
                );
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
        }
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
    /** Prove checkpoint input when another process holds context.db's write lock.
     * Recovery must not change durable provenance, and mismatched native
     * provenance cannot authorize another store or be treated as legacy input.
     */
    async replayAdmission(
        sessionID: string,
        cut: StoreRow<"compaction">,
        reader: V2StoreReader,
    ): Promise<"native" | "legacy" | undefined> {
        if (this.options.protocol === 3) {
            const saved = await this.readV3(sessionID);
            if (!saved) return "legacy";
            if (saved.proof.admissionID !== cut.id) return "legacy";
            return saved.proof.sourceDigest === foldDigest(reader.hostIdentity()) &&
                saved.proof.summaryDigest === foldDigest(cut.data.summary ?? "") &&
                validFloor(reader, sessionID, saved.replay.floor) &&
                saved.proof.historyDigest ===
                    historyDigest(reader, sessionID, cut.seq - 1, saved.replay.floor.after)
                ? "native"
                : undefined;
        }
        if (!isLocalCheckpoint(cut) || cut.session_id !== sessionID) return undefined;
        try {
            const source = reader.hostIdentity();
            const observed = this.sources.get(sessionID);
            if (observed && observed !== source) return undefined;
            if (observed === source && isAdmittedLocalCheckpoint(this.storage, sessionID, cut))
                return "native";
            const saved = (await this.admissions?.get(this.admissionKey(sessionID))) as
                | { payload: string; digest: string }
                | undefined;
            if (!saved) return "legacy";
            if (!saved.payload || saved.digest !== foldDigest(saved.payload)) return undefined;
            const snapshot = JSON.parse(saved.payload) as DurableSnapshot;
            if (snapshot.admissionID !== cut.id) return "legacy";
            if (
                snapshot.sourceDigest !== foldDigest(source) ||
                snapshot.sessionID !== sessionID ||
                snapshot.summaryDigest !== foldDigest(cut.data.summary ?? "") ||
                snapshot.historyDigest !== historyDigest(reader, sessionID, cut.seq - 1)
            )
                return undefined;
            return "native";
        } catch {
            return undefined;
        }
    }
    /** Build the native ingress projection without changing capture state. A
     * refused model change must not invalidate the still-servable old capture.
     */
    replayInput(
        args: {
            sessionID: string;
            cut: StoreRow<"compaction">;
            model: SessionContext["model"];
            reader: V2StoreReader;
            bounded: boolean;
        },
        replayOverride?: ReplayStateV3,
    ): V2Message[] | undefined {
        const { sessionID, cut, model, reader } = args;
        if (!isLocalCheckpoint(cut) || cut.session_id !== sessionID) return undefined;
        let after = -1;
        if (this.options.protocol === 3) {
            const replay = replayOverride ?? this.tail(sessionID)?.replay;
            if (!replay || !validFloor(reader, sessionID, replay.floor)) return undefined;
            after = replay.floor.after;
        } else if (args.bounded && !this.changed.has(sessionID)) {
            const state = readSessionMeta(this.storage.db, sessionID);
            const max = this.storage.db
                .prepare("SELECT COALESCE(MAX(id),0) AS id FROM m0_mutation_log WHERE session_id=?")
                .get(sessionID) as { id: number };
            const boundary = (
                this.storage.db
                    .prepare(
                        "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id=?",
                    )
                    .get(sessionID) as { id: string | null } | undefined
            )?.id;
            if (max.id <= (state.cachedM0MaxMutationId ?? 0) && boundary)
                after = reader.sequenceForId(sessionID, boundary) ?? -1;
        }
        const through = cut.seq - 1;
        const metadata =
            (this.metadataThrough.get(sessionID) ?? -1) >= through
                ? this.metadata.get(sessionID)
                : undefined;
        const required = (
            metadata ??
            reader.rowStampsThrough(
                sessionID,
                through,
                this.options.protocol === 3 ? after : undefined,
            )
        )
            .filter(conversational)
            .filter((row) => row.seq > after && row.seq <= through);
        const tail = this.tail(sessionID);
        let records: readonly Pick<NativeRowRecord, "id" | "data">[];
        if (
            !this.dirty.has(sessionID) &&
            tail?.model === `${model.providerID}/${model.id}` &&
            this.storage.containsRows(
                sessionID,
                required.map((row) => row.id),
            )
        ) {
            records = this.storage.rows(sessionID, after, through);
        } else {
            records = reader
                .range(sessionID, after, through)
                .filter(conversational)
                .map((row) => this.record(row, this.rendered(row, model)));
            const restored = new Set(records.map((row) => row.id));
            if (required.some((row) => !restored.has(row.id))) return undefined;
        }
        const projected = records.flatMap((row) => {
            const messages = reviveNative(JSON.parse(row.data) as V2Message[]);
            for (const message of messages) coordinates.set(message, row.id);
            return messages;
        });
        return this.options.protocol === 3
            ? insertControls(
                  projected,
                  controlsThrough(
                      (replayOverride ?? this.tail(sessionID)?.replay)?.controls ?? [],
                      reader,
                      sessionID,
                      through,
                  ),
                  nativeRowID,
              )
            : projected;
    }
    async projectReplay(
        args: Parameters<NativeFoldReplay["replayInput"]>[0],
    ): Promise<V2Message[] | undefined> {
        const replay =
            this.options.protocol === 3
                ? await this.floorState(args.sessionID, args.reader)
                : undefined;
        return this.replayInput(args, replay);
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
        after?: number,
    ): Omit<NativeRowRecord, "revision">[] {
        let metadata = this.metadata.get(sessionID);
        const through = reader.latestSequence(sessionID);
        const known = new Set(metadata?.map((row) => row.id));
        if (
            !metadata ||
            this.metadataAfter.get(sessionID) !== after ||
            (this.metadataThrough.get(sessionID) ?? -1) < through ||
            native.some((message) => message.id && !known.has(message.id))
        ) {
            metadata = reader.rowStampsThrough(sessionID, through, after).filter(conversational);
            this.metadata.set(sessionID, metadata);
            this.metadataThrough.set(sessionID, through);
            this.metadataAfter.set(sessionID, after);
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
            if (this.options.protocol === 3 && !id && message.role === "system") {
                const text = message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n");
                const source = metadata
                    .filter((row) => row.type === "system" && row.seq > cursor)
                    .find((row) =>
                        reader
                            .range(sessionID, row.seq - 1, row.seq)
                            .some((stored) => stored.id === row.id && stored.data.text === text),
                    );
                id = source?.id;
                if (!id) continue;
            }
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
        let replay: ReplayStateV3 | undefined;
        let sourceSeq = -1;
        try {
            rememberHostMedia(native);
            const reader = this.openReader(draft.sessionID);
            try {
                let captured = native;
                if (this.options.protocol === 3) {
                    replay = await this.floorState(draft.sessionID, reader, boundary, draft);
                    if (!replay)
                        throw new NativeReplayUnavailable("No usable host replay boundary");
                    const known = reader.rowStampsThrough(
                        draft.sessionID,
                        reader.latestSequence(draft.sessionID),
                        replay.floor.after,
                    );
                    const ids = new Set(known.map((row) => row.id));
                    replay = {
                        ...replay,
                        blocked: false,
                        controls: captureControls(
                            draft,
                            (message) => {
                                const id = nativeRowID(message);
                                if (id) return id;
                                if (message.role !== "system") return undefined;
                                const text = message.content
                                    .filter((part) => part.type === "text")
                                    .map((part) => part.text)
                                    .join("\n");
                                return known
                                    .filter((row) => row.type === "system")
                                    .find((row) =>
                                        reader
                                            .range(draft.sessionID, row.seq - 1, row.seq)
                                            .some(
                                                (stored) =>
                                                    stored.id === row.id &&
                                                    stored.data.text === text,
                                            ),
                                    )?.id;
                            },
                            ids,
                        ),
                    };
                    captured = native.filter((message) => {
                        if (effortPart(message)) return false;
                        const id = nativeRowID(message);
                        if (HEAD_IDS.some((head) => head === id)) return false;
                        const baseline = this.servedBaseline(draft);
                        if (!id)
                            return !(
                                baseline &&
                                message.role === "user" &&
                                message.content.some(
                                    (part) => part.type === "text" && part.text === baseline,
                                )
                            );
                        const seq = reader.sequenceForId(draft.sessionID, id);
                        return seq === undefined || seq > replay!.floor.after;
                    });
                }
                let rows = this.records(draft.sessionID, captured, reader, replay?.floor.after);
                if (replay) {
                    const identities = new Map<string, string[]>();
                    for (const row of rows.filter((row) => row.type === "system")) {
                        for (const message of reviveNative(JSON.parse(row.data) as V2Message[])) {
                            const key = JSON.stringify(message.content);
                            const found = identities.get(key) ?? [];
                            found.push(row.id);
                            identities.set(key, found);
                        }
                    }
                    const ids = new Set(rows.map((row) => row.id));
                    replay = {
                        ...replay,
                        blocked: false,
                        controls: captureControls(
                            draft,
                            (message) =>
                                nativeRowID(message) ??
                                (message.role === "system"
                                    ? identities.get(JSON.stringify(message.content))?.shift()
                                    : undefined),
                            ids,
                        ),
                    };
                }
                const baseline = this.servedBaseline(draft);
                const through = Math.max(-1, ...rows.map((row) => row.seq));
                sourceSeq = through;
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
        } catch (error) {
            this.unavailable.add(draft.sessionID);
            this.invalidate(draft.sessionID);
            if (replay && error instanceof ControlMetadataUnavailable)
                replay = { ...replay, blocked: true };
            if (this.options.protocol === 3)
                this.report(draft.sessionID, `capture unavailable: ${String(error)}`);
        } finally {
            this.account(draft.sessionID);
            release();
        }
        if (replay) {
            await this.retainReplay(
                draft.sessionID,
                replay,
                `${draft.model.providerID}/${draft.model.id}`,
                sourceSeq,
            );
            const reader = this.openReader(draft.sessionID);
            try {
                const saved = await this.readV3(draft.sessionID);
                const cut = reader.latestCompaction(draft.sessionID);
                if (
                    saved &&
                    cut?.id === saved.proof.admissionID &&
                    replay.floor.after > saved.replay.floor.after &&
                    boundary &&
                    this.servedBaseline(draft) === boundary.summary
                ) {
                    const value: AdmissionV3 = {
                        ...saved,
                        replay: {
                            ...replay,
                            controls: controlsThrough(
                                replay.controls,
                                reader,
                                draft.sessionID,
                                cut.seq - 1,
                            ),
                        },
                        proof: {
                            ...saved.proof,
                            historyDigest: historyDigest(
                                reader,
                                draft.sessionID,
                                cut.seq - 1,
                                replay.floor.after,
                            ),
                        },
                    };
                    const payload = JSON.stringify(value);
                    await this.admissions?.set(this.admissionKey(draft.sessionID), {
                        payload,
                        digest: foldDigest(payload),
                    });
                }
            } catch (error) {
                this.report(
                    draft.sessionID,
                    `capture provenance update unavailable: ${String(error)}`,
                );
            } finally {
                reader.close();
            }
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
        if (this.options.protocol === 3) {
            const running = reader.latestRunningCompaction(draft.sessionID);
            const replay = await this.floorState(draft.sessionID, reader);
            if (!running || !replay || replay.blocked) {
                this.report(draft.sessionID, "fold refused: no usable host checkpoint boundary");
                return false;
            }
            const model = `${draft.model.providerID}/${draft.model.id}`;
            if (this.tail(draft.sessionID)?.model !== model)
                this.storage.replaceRows(
                    draft.sessionID,
                    reader.latestSequence(draft.sessionID),
                    [],
                );
            await this.retainReplay(
                draft.sessionID,
                replay,
                model,
                reader.latestSequence(draft.sessionID),
            );
            await this.storage.supply(
                draft.sessionID,
                running.id,
                JSON.stringify({
                    source: this.storage.sourceID,
                    sessionID: draft.sessionID,
                    admissionID: running.id,
                    summary,
                }),
            );
            const value: AdmissionV3 = {
                version: 3,
                replay,
                proof: {
                    sourceDigest: foldDigest(reader.hostIdentity()),
                    sessionID: draft.sessionID,
                    admissionID: running.id,
                    summaryDigest: foldDigest(summary),
                    historyDigest: historyDigest(
                        reader,
                        draft.sessionID,
                        running.seq - 1,
                        replay.floor.after,
                    ),
                },
            };
            const payload = JSON.stringify(value);
            await this.admissions?.set(this.admissionKey(draft.sessionID), {
                payload,
                digest: foldDigest(payload),
            });
            return true;
        }
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
        let replay: ReplayStateV3 | undefined;
        let controls: ReplayStateV3["controls"] = [];
        if (this.options.protocol === 3) {
            const reader = this.openReader(sessionID);
            try {
                replay = await this.floorState(sessionID, reader);
                if (replay)
                    controls = controlsThrough(replay.controls, reader, sessionID, cut.seq - 1);
            } finally {
                reader.close();
            }
            if (!replay) {
                this.report(sessionID, "replay refused: missing usable checkpoint boundary");
                throw new NativeReplayUnavailable("Host checkpoint replay boundary is unavailable");
            }
            options = { ...options, bounded: false, after: replay.floor.after };
        }
        const release = this.storage.hold(sessionID);
        let result: V2Message[] | undefined;
        try {
            result = await this.restoreHeld(sessionID, cut, model, options);
        } finally {
            this.account(sessionID);
            release();
        }
        if (replay) {
            await this.retainReplay(sessionID, replay, model, cut.seq - 1);
            return result && insertControls(result, controls, nativeRowID);
        }
        return result;
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
        if (tail && tail.model !== model && !(this.options.protocol === 3 && tail.model === ""))
            this.invalidate(sessionID);
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
                metadata = reader
                    .rowStampsThrough(
                        sessionID,
                        through,
                        this.options.protocol === 3 ? after : undefined,
                    )
                    .filter(conversational);
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
            const replay =
                this.options.protocol === 3 ? await this.floorState(sessionID, reader) : undefined;
            if (this.options.protocol === 3 && !replay) {
                this.report(sessionID, "replay refused: missing usable checkpoint boundary");
                throw new NativeReplayUnavailable("Host checkpoint replay boundary is unavailable");
            }
            const messages = reader
                .range(sessionID, replay?.floor.after ?? -1, cut.seq - 1)
                .filter(conversational)
                .flatMap((row) => {
                    const messages = this.rendered(row, model);
                    for (const message of messages) coordinates.set(message, row.id);
                    return messages;
                });
            return replay
                ? insertControls(
                      messages,
                      controlsThrough(replay.controls, reader, sessionID, cut.seq - 1),
                      nativeRowID,
                  )
                : messages;
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
        this.metadataAfter.delete(sessionID);
        this.metadataAfter.delete(sessionID);
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
