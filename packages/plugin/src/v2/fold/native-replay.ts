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
import { codeModeCatalogKind } from "./code-mode-catalog";
import { hostMediaAsset, hostUsesMediaAssets, rememberHostMedia } from "./host-media";
import type { NativeFoldCache, NativeRowRecord } from "./memory-cache";
import { encodeNative, NativeReplayUnavailable, reviveNative } from "./native-codec";
import {
    type AdmissionV3,
    type CapturedReplayV3,
    ControlMetadataUnavailable,
    captureControls,
    controlsThrough,
    effortPart,
    encodeAdmissionV3,
    floorFor,
    hostCheckpointCarrier,
    importedFloor,
    insertControls,
    instructionRetirement,
    type ReplayFloor,
    type ReplayStateV3,
    validAdmissionV3,
    validCapturedReplayV3,
    validFloor,
    validReplayState,
} from "./native-replay-v3";
import { foldDigest, stripCheckpointRecentContext } from "./owner";
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
interface SupplyArgs {
    draft: SessionContext;
    reader: V2StoreReader;
    summary: string;
    previousCut?: StoreRow<"compaction">;
    manual?: { replay: ReplayStateV3; commit: () => void };
}
const coordinates = new WeakMap<V2Message, string>();
const sequences = new WeakMap<V2Message, number>();
export function nativeRowSequence(message: V2Message): number | undefined {
    return sequences.get(message);
}
export function nativeRowID(message: V2Message): string | undefined {
    return coordinates.get(message) ?? message.id;
}
export function bindNativeRowID(message: V2Message, id: string, seq?: number): void {
    coordinates.set(message, id);
    if (seq !== undefined) sequences.set(message, seq);
}
/**
 * The capture-only inputs of a native input: the model and each effort control
 * with its position (the last message with a host id before it, and the count
 * of messages without an id after that one). A capture records these, and the
 * source rows cannot rebuild them, so a change requires a fresh capture.
 *
 * The position uses host ids only, not the source coordinates that a capture
 * binds on its copy: a host draft has none bound, so a key that used them would
 * never match the key of the capture.
 */
export function captureInputsKey(model: string, messages: readonly V2Message[]): string {
    const parts: unknown[] = [model];
    let previous: string | undefined;
    let unnamed = 0;
    for (const message of messages) {
        const part = effortPart(message);
        if (part) parts.push([previous, unnamed, part.effort, part.previous]);
        else if (message.id) {
            previous = message.id;
            unnamed = 0;
        } else unnamed += 1;
    }
    return JSON.stringify(parts);
}
export function copyNativeInput(messages: readonly V2Message[]): V2Message[] {
    const copies = reviveNative(encodeNative(messages));
    copies.forEach((copy, i) => {
        const original = messages[i];
        const id = original && nativeRowID(original);
        if (id !== undefined) coordinates.set(copy, id);
        const seq = original && sequences.get(original);
        if (seq !== undefined) sequences.set(copy, seq);
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
const capturedReplayKey = (sessionID: string) =>
    `native-fold-state/v3/${encodeURIComponent(sessionID)}`;

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
        await remove(capturedReplayKey(sessionID));
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
    // Keep one identity-only most-recently-used entry outside the optional
    // transcript budget. Large transcripts may be evicted after every request;
    // their unchanged source stamps must not be queried again on every warm capture.
    // Source identity, range and edit invalidation still fence reuse, and switching
    // sessions replaces this entry rather than retaining unbounded per-session metadata.
    private stampMRU?: {
        sessionID: string;
        source: string;
        through: number;
        after: number | undefined;
        rows: V2RowStamp[];
    };
    private readonly loaded = new Map<string, number>();
    private readonly sources = new Map<string, string>();
    private readonly staleHeads = new Set<string>();
    private readonly unprovenControls = new Set<string>();
    // What the last capture of each session recorded: its capture inputs key,
    // the served head and the head's boundary. A pass may skip the native copy
    // only while all three are unchanged (see captureCurrent and
    // noteSkippedCapture).
    private readonly captureInputs = new Map<
        string,
        { key: string; head: string | undefined; boundary: string | undefined }
    >();
    // The capture inputs key and served head of a session's last native copy
    // that did not give a current capture (the capture did not run or failed).
    // The same inputs are not copied again until the served head changes (see
    // copyWanted, settleCopy and noteSkippedCapture).
    private readonly failedCopies = new Map<string, { key: string; head: string | undefined }>();
    private readonly editedAdmissions = new Map<
        string,
        {
            original: AdmissionV3;
            replay: ReplayStateV3;
        }
    >();
    private readonly legacyUpgrades = new Map<
        string,
        {
            value: AdmissionV3;
            rows: StoreRow[];
            started: number;
        }
    >();
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
    /**
     * True when a pass may skip the native copy and capture: the last capture
     * of this session succeeded with the same model and effort controls, and
     * nothing has invalidated it since. The rows themselves need no capture,
     * because a missing row is restored from the host store.
     */
    captureCurrent(sessionID: string, model: string, messages: readonly V2Message[]): boolean {
        return this.captureCurrentFor(sessionID, captureInputsKey(model, messages));
    }
    /** {@link captureCurrent} for a {@link captureInputsKey} the caller already computed. */
    captureCurrentFor(sessionID: string, key: string): boolean {
        if (this.options.protocol !== 3) return false;
        if (this.unavailable.has(sessionID) || this.unprovenControls.has(sessionID)) return false;
        return this.captureInputs.get(sessionID)?.key === key;
    }
    /**
     * Whether a pass that may skip the capture should copy its native input:
     * the capture is not current, and the last copy with the same inputs did
     * not fail to give a current capture. This bounds the copies to one for
     * each change of model, effort controls or served head while the capture
     * cannot run. `key` is the {@link captureInputsKey} of the pass's draft.
     */
    copyWanted(sessionID: string, key: string): boolean {
        if (this.captureCurrentFor(sessionID, key)) return false;
        return this.failedCopies.get(sessionID)?.key !== key;
    }
    /**
     * Called after a pass that tried to copy for the capture, whether or not
     * the copy succeeded: records whether the pass gave a current capture.
     * `key` is the capture inputs key of the draft before the transform.
     */
    settleCopy(draft: SessionContext, key: string): void {
        if (this.captureCurrentFor(draft.sessionID, key)) this.failedCopies.delete(draft.sessionID);
        else this.failedCopies.set(draft.sessionID, { key, head: this.servedBaseline(draft) });
    }
    /**
     * Called after a pass that skipped the capture. When the capture was not
     * current at the start of the pass, or the served head or its boundary
     * differs from the last capture, the stored head and controls are stale:
     * a host fold is refused until a pass captures again. A changed served
     * head also lets the next pass try a failed copy once more.
     */
    noteSkippedCapture(draft: SessionContext, boundary: string | undefined, current = true): void {
        const recorded = this.captureInputs.get(draft.sessionID);
        const head = this.servedBaseline(draft);
        const failed = this.failedCopies.get(draft.sessionID);
        if (failed && failed.head !== head) this.failedCopies.delete(draft.sessionID);
        if (current && recorded && head === recorded.head && boundary === recorded.boundary) return;
        this.captureInputs.delete(draft.sessionID);
        this.unprovenControls.add(draft.sessionID);
    }
    invalidate(sessionID: string, suppressNomination = false): void {
        if (this.stampMRU?.sessionID === sessionID) this.stampMRU = undefined;
        this.captureInputs.delete(sessionID);
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
    async retiredInstructionThrough(sessionID: string, reader: V2StoreReader): Promise<number> {
        if (!reader.latestCompaction(sessionID)) return -1;
        return (await this.floorState(sessionID, reader))?.retiredInstructionThrough ?? -1;
    }
    async instructionRetirement(sessionID: string, reader: V2StoreReader) {
        if (!reader.latestCompaction(sessionID)) return instructionRetirement();
        return instructionRetirement(await this.floorState(sessionID, reader));
    }

    /** A deliberate host compaction rebuilds history but must keep unsummarized conversation. */
    async prepareManualFold(
        sessionID: string,
        reader: V2StoreReader,
        boundaryID: string | null,
        summary: string,
    ): Promise<ReplayStateV3> {
        const running = reader.latestRunningCompaction(sessionID);
        if (!running || this.options.protocol !== 3)
            throw new NativeReplayUnavailable("Manual compaction has no running host checkpoint");
        const previous = await this.floorState(sessionID, reader);
        if (this.unprovenControls.has(sessionID) || previous?.blocked)
            throw new NativeReplayUnavailable("Manual compaction controls have not been captured");
        const seq = boundaryID ? reader.sequenceForId(sessionID, boundaryID) : undefined;
        const row = seq === undefined ? undefined : reader.range(sessionID, seq - 1, seq)[0];
        const first = reader.page(sessionID, { limit: 1 }).rows[0];
        // A newly rendered summary can cover less than the previous baseline.
        // Its boundary, not the previous checkpoint's higher floor, owns this cut.
        let floor = row ? floorFor(row, "summary") : undefined;
        floor ??= first ? floorFor(first, "start") : undefined;
        if (!floor) throw new NativeReplayUnavailable("Manual compaction has no history boundary");
        const instructions = reader.instructionRowsThrough(sessionID, running.seq - 1);
        const retiredInstructionIDs: string[] = [];
        let newerFullCatalog = false;
        for (const instruction of [...instructions].reverse()) {
            const text = instruction.data.text ?? "";
            const catalog = codeModeCatalogKind(instruction.data);
            // Beyond summary coverage, retire only a same-identity replacement
            // (the host's catalog notice) or content re-stated by the fresh fold.
            if (
                instruction.seq > floor.after &&
                ((catalog && catalog !== "combined-replacement" && newerFullCatalog) ||
                    (text.length > 0 && summary.includes(text)))
            )
                retiredInstructionIDs.push(instruction.id);
            if (catalog === "replacement" || catalog === "combined-replacement")
                newerFullCatalog = true;
        }
        return {
            floor,
            controls: previous?.controls ?? [],
            ...(floor.after >= 0 ? { retiredInstructionThrough: floor.after } : {}),
            retiredInstructionIDs,
        };
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
        preferCapture = false,
    ): Promise<ReplayStateV3 | undefined> {
        const retained = this.tail(sessionID)?.replay;
        const controlsKnown = (replay: ReplayStateV3) =>
            replay.controls.every(
                (control) =>
                    !control.after || reader.sequenceForId(sessionID, control.after) !== undefined,
            );
        const memory =
            retained &&
            validReplayState(retained) &&
            controlsKnown(retained) &&
            validFloor(reader, sessionID, retained.floor)
                ? retained
                : undefined;
        const cut = reader.latestCompaction(sessionID);
        const saved = await this.readV3(sessionID);
        const durable =
            saved &&
            saved.proof.sourceDigest === foldDigest(reader.hostIdentity()) &&
            (!cut || saved.proof.admissionID === cut.id) &&
            controlsKnown(saved.replay) &&
            validFloor(reader, sessionID, saved.replay.floor)
                ? saved.replay
                : undefined;
        const imported = importedFloor(reader, sessionID, cut?.seq);
        const captured = await this.readCapturedReplay(sessionID, reader);
        const existing = preferCapture
            ? (captured ?? memory ?? durable)
            : (memory ?? durable ?? captured);
        // A store coordinate cannot prove that a previously served effort
        // marker was absent. Only a fresh capture may establish empty controls.
        if (preferCapture && !existing && !served) return undefined;
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
            ? { ...existing, floor, controls: existing?.controls ?? [], blocked: existing?.blocked }
            : undefined;
    }
    private async readV3(sessionID: string): Promise<AdmissionV3 | undefined> {
        const saved = (await this.admissions?.get(this.admissionKey(sessionID))) as
            | { payload?: string; digest?: string }
            | undefined;
        if (typeof saved?.payload !== "string" || saved.digest !== foldDigest(saved.payload))
            return undefined;
        try {
            const value: unknown = JSON.parse(saved.payload);
            return validAdmissionV3(value) && value.proof.sessionID === sessionID
                ? value
                : undefined;
        } catch {
            return undefined;
        }
    }

    private async readCapturedReplay(
        sessionID: string,
        reader: V2StoreReader,
    ): Promise<ReplayStateV3 | undefined> {
        const saved = (await this.admissions?.get(capturedReplayKey(sessionID))) as
            | { payload?: string; digest?: string }
            | undefined;
        if (typeof saved?.payload !== "string" || saved.digest !== foldDigest(saved.payload))
            return undefined;
        try {
            const value: unknown = JSON.parse(saved.payload);
            return validCapturedReplayV3(value) &&
                value.sessionID === sessionID &&
                value.sourceDigest === foldDigest(reader.hostIdentity()) &&
                value.through <= reader.latestSequence(sessionID) &&
                validFloor(reader, sessionID, value.replay.floor) &&
                value.replay.controls.every(
                    (control) =>
                        !control.after ||
                        reader.sequenceForId(sessionID, control.after) !== undefined,
                )
                ? value.replay
                : undefined;
        } catch {
            return undefined;
        }
    }

    private async saveCapturedReplay(
        sessionID: string,
        replay: ReplayStateV3,
        reader: V2StoreReader,
    ): Promise<void> {
        const value: CapturedReplayV3 = {
            version: 3,
            sessionID,
            sourceDigest: foldDigest(reader.hostIdentity()),
            through: reader.latestSequence(sessionID),
            replay,
        };
        if (!validCapturedReplayV3(value))
            throw new Error("Unsupported captured native replay metadata");
        const payload = JSON.stringify(value);
        try {
            await this.admissions?.set(capturedReplayKey(sessionID), {
                payload,
                digest: foldDigest(payload),
            });
            this.unprovenControls.delete(sessionID);
        } catch (error) {
            this.unprovenControls.add(sessionID);
            throw error;
        }
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
        const checkpointID =
            this.tail(draft.sessionID)?.replay?.floor.kind === "host-checkpoint"
                ? this.tail(draft.sessionID)?.replay?.floor.id
                : undefined;
        return cached &&
            draft.messages.some((message) =>
                message.content.some(
                    (part) =>
                        part.type === "text" &&
                        (part.text === cached ||
                            (message.id === checkpointID &&
                                typeof part.text === "string" &&
                                part.text.includes(`<summary>\n${cached}\n</summary>`))),
                ),
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
        if (
            (await this.admissions?.get(admissionKey(sessionID))) &&
            !(await this.readV3(sessionID))
        ) {
            this.report(sessionID, "fold refused: V2 upgrade has not completed a rebuilding pass");
            return false;
        }
        if (this.unprovenControls.has(sessionID)) {
            this.report(sessionID, "fold refused: capture controls have not been persisted");
            return false;
        }
        const replay = await this.floorState(sessionID, reader, undefined, undefined, true);
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
        _cut: StoreRow<"compaction">,
        reader: V2StoreReader,
    ): Promise<number | undefined> {
        // V2 records have no replay floor. A healthy writer stages a proven
        // summary boundary, a complete host checkpoint, or the legacy-only
        // validated source repair. It saves the new floor only after a successful
        // prefix rebuild. Read-only recovery cannot guess an origin or start
        // that repair while another writer owns the store.
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

    async prepareLegacyUpgrade(args: {
        draft: SessionContext;
        cut: StoreRow<"compaction">;
        reader: V2StoreReader;
        onHard?(): void;
    }): Promise<boolean> {
        const { draft, cut, reader } = args;
        const admissions = this.admissions;
        if (this.options.protocol !== 3 || !admissions || !isLocalCheckpoint(cut)) return false;
        if (await this.readV3(draft.sessionID)) return false;
        this.legacyUpgrades.delete(draft.sessionID);
        const started = performance.now();
        const receipt = (await this.admissions?.get(admissionKey(draft.sessionID))) as
            | { payload?: string; digest?: string }
            | undefined;
        if (!receipt?.payload || receipt.digest !== foldDigest(receipt.payload)) return false;
        let legacy: DurableSnapshot;
        try {
            legacy = JSON.parse(receipt.payload) as DurableSnapshot;
        } catch {
            return false;
        }
        if (
            legacy.sourceDigest !== foldDigest(reader.hostIdentity()) ||
            legacy.sessionID !== draft.sessionID ||
            legacy.admissionID !== cut.id ||
            legacy.summaryDigest !== foldDigest(cut.data.summary ?? "") ||
            !/^[a-f0-9]{64}$/.test(legacy.historyDigest)
        )
            return false;

        // Preserve V2's full provenance check before trusting a legacy receipt.
        // This one validation read is also the repair input if the old record
        // cannot prove which source rows its served summary covered.
        const rows = reader.range(draft.sessionID, -1, cut.seq - 1).filter(conversational);
        if (foldDigest(JSON.stringify(rows)) !== legacy.historyDigest) return false;
        // keepID only bounds the host's retained tail. It does not prove that
        // Magic Context summarized every row before it.
        let floor: ReplayFloor | undefined;
        if (!floor) {
            const candidate = await this.floorState(draft.sessionID, reader);
            const cached = readSessionMeta(
                this.storage.db,
                draft.sessionID,
            ).cachedM0Bytes?.toString("utf8");
            if (
                candidate &&
                (candidate.floor.kind === "checkpoint" ||
                    (candidate.floor.kind === "summary" && cached === cut.data.summary))
            )
                floor = candidate.floor;
        }
        const mode = floor ? "bounded" : "source-repair";
        // Serialized recent text has no source identities, roles, boundaries or
        // multiplicity proof. Always project the validated source rows instead.
        // Staging this projection grants no permission to replace a prefix
        // whose served cache lifetime has not expired.
        floor ??= rows[0] ? floorFor(rows[0], "start") : floorFor(cut, "checkpoint");
        let controls: ReturnType<typeof captureControls> = [];
        let blocked = false;
        try {
            controls = captureControls(
                draft,
                nativeRowID,
                new Set(draft.messages.flatMap((message) => nativeRowID(message) ?? [])),
            );
        } catch (error) {
            if (!(error instanceof ControlMetadataUnavailable)) throw error;
            // Keep serving the host's controls, but do not nominate a new fold
            // until a later capture can preserve all of them.
            blocked = true;
        }
        const replay: ReplayStateV3 = {
            floor,
            controls,
            ...(blocked ? { blocked } : {}),
            upgrade: { admissionID: cut.id, mode },
        };
        const value: AdmissionV3 = {
            version: 3,
            replay,
            proof: {
                sourceDigest: legacy.sourceDigest,
                sessionID: draft.sessionID,
                admissionID: cut.id,
                summaryDigest: legacy.summaryDigest,
                historyDigest: foldDigest(
                    JSON.stringify(rows.filter((row) => row.seq > floor.after)),
                ),
            },
        };
        // A failed attempt leaves no durable V3 floor. The next healthy writer
        // retries under the same rebuild permission rather than replaying a
        // partially repaired prefix.
        this.legacyUpgrades.set(draft.sessionID, { value, rows, started });
        await this.retainReplay(
            draft.sessionID,
            replay,
            `${draft.model.providerID}/${draft.model.id}`,
            cut.seq - 1,
        );
        return true;
    }

    legacyUpgradeInput(sessionID: string, model: SessionContext["model"]): V2Message[] | undefined {
        const pending = this.legacyUpgrades.get(sessionID);
        if (!pending) return undefined;
        return pending.rows
            .filter((row) => row.seq > pending.value.replay.floor.after)
            .flatMap((row) => {
                const messages = this.rendered(structuredClone(row), model);
                for (const message of messages) bindNativeRowID(message, row.id, row.seq);
                return messages;
            });
    }

    async commitLegacyUpgrade(
        sessionID: string,
        prefixMutationPermitted: boolean,
    ): Promise<boolean> {
        if (!prefixMutationPermitted) return false;
        const pending = this.legacyUpgrades.get(sessionID);
        const admissions = this.admissions;
        if (!pending || !admissions) return false;
        const replay = this.tail(sessionID)?.replay ?? pending.value.replay;
        if (replay.blocked) return false;
        const value: AdmissionV3 = {
            ...pending.value,
            replay,
            proof: {
                ...pending.value.proof,
                historyDigest: foldDigest(
                    JSON.stringify(pending.rows.filter((row) => row.seq > replay.floor.after)),
                ),
            },
        };
        const payload = encodeAdmissionV3(value);
        await admissions.set(this.admissionKey(sessionID), {
            payload,
            digest: foldDigest(payload),
        });
        this.legacyUpgrades.delete(sessionID);
        this.report(
            sessionID,
            `V2 upgrade-state HARD mode=${replay.upgrade?.mode} rows_read=${pending.rows.length} duration_ms=${Math.round(performance.now() - pending.started)} floor=${replay.floor.id}:${replay.floor.after}`,
        );
        return true;
    }

    cancelLegacyUpgrade(sessionID: string): void {
        this.legacyUpgrades.delete(sessionID);
    }

    async checkpointForReplay(sessionID: string, reader: V2StoreReader) {
        if (this.options.protocol !== 3) return undefined;
        const replay = await this.floorState(sessionID, reader);
        if (replay?.floor.kind !== "host-checkpoint") return undefined;
        const row = reader
            .range(sessionID, replay.floor.seq - 1, replay.floor.seq)
            .find((row) => row.id === replay.floor.id && row.type === "compaction");
        if (!row || !isLocalCheckpoint(row)) return undefined;
        const rendered = hostCheckpointCarrier(row);
        if (replay.withoutRecentContext)
            stripCheckpointRecentContext(rendered, row.data.summary ?? "");
        return { row, rendered, submitted: row.data.summary ?? "" };
    }

    async checkpointCovered(sessionID: string, checkpointID: string): Promise<void> {
        const admissions = this.admissions;
        if (!admissions) return;
        const pending = this.legacyUpgrades.get(sessionID);
        const value = (await this.readV3(sessionID)) ?? pending?.value;
        if (
            value?.replay.floor.kind !== "host-checkpoint" ||
            value.replay.floor.id !== checkpointID ||
            value.replay.withoutRecentContext
        )
            return;
        value.replay.withoutRecentContext = true;
        const payload = encodeAdmissionV3(value);
        if (!pending)
            await admissions.set(this.admissionKey(sessionID), {
                payload,
                digest: foldDigest(payload),
            });
        const tail = this.tail(sessionID);
        if (tail) await this.retainReplay(sessionID, value.replay, tail.model, tail.sourceSeq);
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
                proof.summaryDigest !== foldDigest(cut.data.summary ?? "")
            ) {
                this.report(sessionID, "replay refused: invalid checkpoint floor or provenance");
                return false;
            }
            let replay = saved.replay;
            if (!validFloor(reader, sessionID, replay.floor)) {
                const floor = replay.floor;
                // Editing the inclusive start row changes its content digest,
                // not its proven position. Preserve that coordinate for the
                // shared history rebuild; a missing/replaced row is not a floor.
                const anchor =
                    floor?.kind === "start" &&
                    Number.isSafeInteger(floor.seq) &&
                    floor.after === floor.seq - 1
                        ? reader
                              .range(sessionID, floor.seq - 1, floor.seq)
                              .find(
                                  (row) =>
                                      row.id === floor.id &&
                                      row.session_id === sessionID &&
                                      conversational(row),
                              )
                        : undefined;
                if (!anchor) {
                    this.report(
                        sessionID,
                        "replay refused: invalid checkpoint floor or provenance",
                    );
                    return false;
                }
                replay = { ...replay, floor: floorFor(anchor, "start") };
                this.editedAdmissions.set(sessionID, { original: saved, replay });
                this.staleHeads.add(sessionID);
                this.invalidate(sessionID);
                await this.retainReplay(
                    sessionID,
                    replay,
                    this.tail(sessionID)?.model ?? "",
                    cut.seq - 1,
                );
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
                this.editedAdmissions.set(sessionID, { original: saved, replay });
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

    async commitEditedAdmission(sessionID: string): Promise<boolean> {
        const pending = this.editedAdmissions.get(sessionID);
        const admissions = this.admissions;
        if (!pending || !admissions) return false;
        const current = await this.readV3(sessionID);
        // An explicit revocation or a newer writer wins over this prepared pass.
        if (JSON.stringify(current) !== JSON.stringify(pending.original)) return false;
        const reader = this.openReader(sessionID);
        try {
            const cut = reader.latestCompaction(sessionID);
            const proof = pending.original.proof;
            const replay = this.tail(sessionID)?.replay ?? pending.replay;
            if (
                !cut ||
                cut.id !== proof.admissionID ||
                !isLocalCheckpoint(cut) ||
                proof.sourceDigest !== foldDigest(reader.hostIdentity()) ||
                proof.summaryDigest !== foldDigest(cut.data.summary ?? "") ||
                !validFloor(reader, sessionID, replay.floor)
            )
                return false;
            const value: AdmissionV3 = {
                ...pending.original,
                replay: {
                    ...replay,
                    controls: controlsThrough(replay.controls, reader, sessionID, cut.seq - 1),
                },
                proof: {
                    ...proof,
                    historyDigest: historyDigest(
                        reader,
                        sessionID,
                        cut.seq - 1,
                        replay.floor.after,
                    ),
                },
            };
            const payload = encodeAdmissionV3(value);
            await admissions.set(this.admissionKey(sessionID), {
                payload,
                digest: foldDigest(payload),
            });
            this.editedAdmissions.delete(sessionID);
            return true;
        } finally {
            reader.close();
        }
    }

    cancelEditedAdmission(sessionID: string): void {
        this.editedAdmissions.delete(sessionID);
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
        const retired = instructionRetirement(replayOverride ?? this.tail(sessionID)?.replay);
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
            .filter((row) => !retired(row))
            .filter((row) => row.seq > after && row.seq <= through);
        const tail = this.tail(sessionID);
        let records: readonly Pick<NativeRowRecord, "id" | "data" | "type" | "seq">[];
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
        const projected = records
            .filter((row) => !retired(row))
            .flatMap((row) => {
                const messages = reviveNative(JSON.parse(row.data) as V2Message[]);
                for (const message of messages) bindNativeRowID(message, row.id, row.seq);
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
        selection?: { floor: ReplayFloor; baseline?: string },
    ): Omit<NativeRowRecord, "revision">[] {
        const after = selection?.floor.after;
        const candidates = native.flatMap((message) => {
            if (!selection) return [{ message, covered: false }];
            const id = nativeRowID(message);
            if (
                effortPart(message) ||
                HEAD_IDS.some((head) => head === id) ||
                (!id &&
                    selection.baseline &&
                    message.role === "user" &&
                    message.content.some(
                        (part) => part.type === "text" && part.text === selection.baseline,
                    ))
            )
                return [];
            const seq =
                id && selection.floor.kind !== "start"
                    ? reader.sequenceForId(sessionID, id)
                    : undefined;
            return [{ message, covered: seq !== undefined && seq <= selection.floor.after }];
        });
        native = candidates.filter(({ covered }) => !covered).map(({ message }) => message);
        const through = reader.latestSequence(sessionID);
        const retained = this.stampMRU;
        let metadata = this.metadata.get(sessionID);
        if (
            !metadata &&
            retained?.sessionID === sessionID &&
            retained.source === reader.hostIdentity() &&
            retained.after === after &&
            retained.through === through
        ) {
            metadata = retained.rows;
            this.metadata.set(sessionID, metadata);
            this.metadataThrough.set(sessionID, through);
            this.metadataAfter.set(sessionID, after);
        }
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
        if (this.options.protocol === 3)
            this.stampMRU = {
                sessionID,
                source: reader.hostIdentity(),
                through,
                after,
                rows: metadata,
            };
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
        // Apply the summary boundary while binding source rows so id-less tool
        // results use the same owner. Skipped synthetic history and unmatched
        // systems cannot replace it; dropping an assistant already summarized
        // must also drop its results.
        for (const { message, covered } of candidates) {
            if (covered) {
                if (message.role !== "tool") owner = undefined;
                continue;
            }
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
            if (!id && message.role === "tool") {
                id = owner;
                if (selection && !id) continue;
            }
            const row = id ? byID.get(id) : undefined;
            if (!row)
                throw new NativeReplayUnavailable("Native carrier has no source row coordinate");
            cursor = row.seq;
            bindNativeRowID(message, row.id, row.seq);
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
                if (this.options.protocol === 3) {
                    replay = await this.floorState(draft.sessionID, reader, boundary, draft);
                    if (!replay)
                        throw new NativeReplayUnavailable("No usable host replay boundary");
                    // Match stored instruction-update system messages, including
                    // repeated text, against source records before capturing controls.
                    // controls must use those source identities, not a text match.
                    replay = { ...replay, blocked: false };
                }
                let rows = replay
                    ? this.records(draft.sessionID, native, reader, {
                          floor: replay.floor,
                          baseline: this.servedBaseline(draft),
                      })
                    : this.records(draft.sessionID, native, reader);
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
                this.captureInputs.set(draft.sessionID, {
                    key: captureInputsKey(tail.model, native),
                    head: tail.baseline,
                    boundary: boundary?.id,
                });
            } finally {
                reader.close();
            }
        } catch (error) {
            this.unavailable.add(draft.sessionID);
            this.invalidate(draft.sessionID);
            if (replay) replay = { ...replay, blocked: true };
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
                // Control provenance is small and durable, independent of the
                // optional transcript cache's capacity and eviction callbacks.
                await this.saveCapturedReplay(draft.sessionID, replay, reader);
                const saved = await this.readV3(draft.sessionID);
                const cut = reader.latestCompaction(draft.sessionID);
                if (
                    saved &&
                    !this.editedAdmissions.has(draft.sessionID) &&
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
                    const payload = encodeAdmissionV3(value);
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
    async supply(args: SupplyArgs): Promise<boolean> {
        const release = this.storage.hold(args.draft.sessionID);
        try {
            return await this.supplyHeld(args);
        } finally {
            this.account(args.draft.sessionID);
            release();
        }
    }
    private async supplyHeld(args: SupplyArgs): Promise<boolean> {
        const { draft, reader, summary } = args;
        if (this.options.protocol === 3) {
            if (this.unprovenControls.has(draft.sessionID)) return false;
            if (
                (await this.admissions?.get(admissionKey(draft.sessionID))) &&
                !(await this.readV3(draft.sessionID))
            )
                return false;
            const running = reader.latestRunningCompaction(draft.sessionID);
            const replay =
                args.manual?.replay ??
                (await this.floorState(draft.sessionID, reader, undefined, undefined, true));
            if (!running || !replay || replay.blocked) {
                this.report(draft.sessionID, "fold refused: no usable host checkpoint boundary");
                return false;
            }
            const model = `${draft.model.providerID}/${draft.model.id}`;
            if (!args.manual && this.tail(draft.sessionID)?.model !== model)
                this.storage.replaceRows(
                    draft.sessionID,
                    reader.latestSequence(draft.sessionID),
                    [],
                );
            if (!args.manual)
                await this.retainReplay(
                    draft.sessionID,
                    replay,
                    model,
                    reader.latestSequence(draft.sessionID),
                );
            if (!args.manual)
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
            const payload = encodeAdmissionV3(value);
            if (args.manual) {
                const keys = [
                    capturedReplayKey(draft.sessionID),
                    this.admissionKey(draft.sessionID),
                ];
                const old = await Promise.all(keys.map((key) => this.admissions?.get(key)));
                const capture: CapturedReplayV3 = {
                    version: 3,
                    sessionID: draft.sessionID,
                    sourceDigest: foldDigest(reader.hostIdentity()),
                    through: reader.latestSequence(draft.sessionID),
                    replay,
                };
                const capturedPayload = JSON.stringify(capture);
                let written = 0;
                try {
                    for (const [index, key] of keys.entries()) {
                        const data = index === 0 ? capturedPayload : payload;
                        await this.admissions?.set(key, {
                            payload: data,
                            digest: foldDigest(data),
                        });
                        written++;
                    }
                    args.manual.commit();
                } catch (error) {
                    // Undo only successful writes so a refused admission leaves
                    // the previously stored replay and checkpoint unchanged.
                    for (let index = written - 1; index >= 0; index--) {
                        const key = keys[index];
                        if (!key) continue;
                        if (old[index] !== undefined) await this.admissions?.set(key, old[index]);
                        else if (this.admissions?.remove) await this.admissions.remove(key);
                        else await this.admissions?.set(key, null);
                    }
                    throw error;
                }
                this.invalidate(draft.sessionID);
                this.cancelLegacyUpgrade(draft.sessionID);
                this.cancelEditedAdmission(draft.sessionID);
                await this.retainReplay(draft.sessionID, replay, model, running.seq - 1);
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
                return true;
            }
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
        options: {
            bounded?: boolean;
            after?: number;
            retiredInstructionThrough?: number;
            retiredInstructionIDs?: string[];
        } = {},
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
            options = {
                ...options,
                bounded: false,
                after: replay.floor.after,
                retiredInstructionThrough: replay.retiredInstructionThrough,
                retiredInstructionIDs: replay.retiredInstructionIDs,
            };
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
        options: {
            bounded?: boolean;
            after?: number;
            retiredInstructionThrough?: number;
            retiredInstructionIDs?: string[];
        },
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
        const retired = instructionRetirement(options);
        for (const row of this.storage.rows(sessionID, after, cut.seq - 1)) {
            if (retired(row)) continue;
            const revived = reviveNative(JSON.parse(row.data) as V2Message[]);
            for (const message of revived) bindNativeRowID(message, row.id, row.seq);
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
            const retired = instructionRetirement(replay);
            const messages = reader
                .range(sessionID, replay?.floor.after ?? -1, cut.seq - 1)
                .filter(conversational)
                .filter((row) => !retired(row))
                .flatMap((row) => {
                    const messages = this.rendered(row, model);
                    for (const message of messages) bindNativeRowID(message, row.id, row.seq);
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
        return this.changed.has(sessionID) || this.editedAdmissions.has(sessionID);
    }
    needsHeadRebuild(sessionID: string): boolean {
        return this.staleHeads.has(sessionID) || this.editedAdmissions.has(sessionID);
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
        if (this.stampMRU?.sessionID === sessionID) this.stampMRU = undefined;
        this.unprovenControls.delete(sessionID);
        this.captureInputs.delete(sessionID);
        this.failedCopies.delete(sessionID);
        this.cancelLegacyUpgrade(sessionID);
        this.cancelEditedAdmission(sessionID);
        // The session id locates the v2 key and matching legacy keys without any
        // prior source observation. Real hosts remove rows instead of leaving tombstones.
        if (this.admissions) await forgetNativeFoldProvenance(this.admissions, sessionID);
        await this.storage.forget(sessionID);
    }
}
