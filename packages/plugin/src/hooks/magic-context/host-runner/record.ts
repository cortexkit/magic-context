/**
 * Deterministic runner-record transitions. There is no transport or storage here.
 * The adapter persists each transition before calling its commit function, and
 * persists the request fence before sending it. Only committed entries assemble.
 * Messages and the frozen plan are owned by the record; callers must not mutate
 * them after admission. Host-specific normalization, hook targets and structural
 * validation belong to the adapter, not to the ordinal space.
 */
export const MAX_REQUEST_BYTES = 3 * 1024 * 1024;

export type HookName = "pre_user" | "post_assistant" | "post_tool";
export interface Subject {
    subject_mid: string;
    hook: HookName;
    subject_part?: string;
}
export interface HookAnswer {
    subject: Subject;
    ops: readonly unknown[];
    tags: readonly unknown[];
    note?: string;
}
export type HookOutcome =
    | { subject: Subject; answer: HookAnswer }
    | { subject: Subject; unavailable: true };
export interface Entry<M> {
    id: string;
    ordinal: number;
    /** Compact JSON, serialized once; requests splice these bytes verbatim. */
    ingest: string;
    served: M;
    op_version: number;
    hook: { answers: readonly HookAnswer[]; unavailable?: true };
    ingested: boolean;
    race: boolean;
}
export interface Compaction<M> {
    compaction_id: string;
    version: number;
    range: { from: number; to: number };
    replacement: readonly M[];
}
export interface View<M> extends Compaction<M> {
    state: "applied" | "invalidated";
    coverage?: { end_mid: string; ordinal: number };
}
export interface Descent {
    lineage_id: string;
    through_ordinal: number;
}
export type ExitReason =
    | "provider_message_too_large"
    | "provider_history_lost"
    | "provider_record_lost"
    | "provider_foreign_history"
    | "provider_revert_ambiguous";
export type NotAppliedReason =
    | "superseded_request"
    | "late"
    | "range_inverted"
    | "stale_version"
    | "range_beyond_newest"
    | "structural";
export type PrefixEvent = "idless" | "non_terminal" | "unknown_op_version";
export interface RecordCounters {
    id_lookups: number;
    content_reads: number;
    message_serializations: number;
    holes: number;
    prefix_events: number;
}
export interface RunnerRecord<M, P = unknown> {
    lineage_id: string;
    ancestry: Descent[];
    descends_from?: Descent;
    first_ordinal: number;
    next_ordinal: number;
    after_ordinal: number;
    served_through_ordinal: number;
    ordinal_divergence: number;
    plan: P;
    view: View<M>;
    entries: Entry<M>[];
    ids: Map<string, number>;
    elided: Set<string>;
    hole_ids: Set<string>;
    unserved_subjects: Subject[];
    issued?: {
        request_id: string;
        newest: number;
        deadline_ms: number;
        lineage_id: string;
        answered?: true;
    };
    last_not_applied?: { compaction_id: string; version: number; reason: NotAppliedReason };
    pipeline_exit?: { reason: ExitReason; reseed_full_request: boolean };
    history_gap_from?: number;
    counters: RecordCounters;
}

function ordinal(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

export function createRecord<M, P>(input: {
    lineage_id: string;
    first_ordinal?: number;
    plan: P;
    initial: Compaction<M>;
}): RunnerRecord<M, P> {
    const first = input.first_ordinal ?? 1;
    if (
        !ordinal(first) ||
        first === 0 ||
        !validCompaction(input.initial) ||
        input.initial.range.to > first
    ) {
        throw new Error("Invalid initial runner record");
    }
    return {
        lineage_id: input.lineage_id,
        ancestry: [],
        first_ordinal: first,
        next_ordinal: first,
        after_ordinal: first - 1,
        served_through_ordinal: first - 1,
        ordinal_divergence: 0,
        plan: input.plan,
        view: { ...input.initial, state: "applied" },
        entries: [],
        ids: new Map(),
        elided: new Set(),
        hole_ids: new Set(),
        unserved_subjects: [],
        counters: {
            id_lookups: 0,
            content_reads: 0,
            message_serializations: 0,
            holes: 0,
            prefix_events: 0,
        },
    };
}

/** The scanner accesses only id. classify/read are never called for known ids. */
export interface Incoming<M> {
    id?: string;
    classify: () => "marker" | "terminal" | "non_terminal";
    read: () => M;
}
export interface WindowScan<M> {
    appends: { incoming: Incoming<M>; id: string; ordinal: number; race: boolean }[];
    elided: string[];
    passthrough: Incoming<M>[];
    events: PrefixEvent[];
    holes: string[];
    revert_through?: number;
    exit?: ExitReason;
}

export function scanWindow<M>(
    record: RunnerRecord<M>,
    window: readonly Incoming<M>[],
): WindowScan<M> {
    const result: WindowScan<M> = {
        appends: [],
        elided: [],
        passthrough: [],
        events: [],
        holes: [],
    };
    if (record.pipeline_exit) return { ...result, exit: record.pipeline_exit.reason };
    const present = new Set<string>();
    const unknown: { incoming: Incoming<M>; id: string; index: number }[] = [];
    let highest = -1;
    let lastKnownIndex = -1;
    for (const [index, incoming] of window.entries()) {
        const id = incoming.id;
        if (!id) {
            result.passthrough.push(incoming);
            result.events.push("idless");
            continue;
        }
        record.counters.id_lookups++;
        const held = record.ids.get(id);
        if (held !== undefined) {
            present.add(id);
            highest = Math.max(highest, held);
            lastKnownIndex = index;
            continue;
        }
        if (record.elided.has(id) || present.has(id)) continue;
        present.add(id);
        const kind = incoming.classify();
        if (kind === "marker") result.elided.push(id);
        else if (kind === "non_terminal") {
            result.passthrough.push(incoming);
            result.events.push("non_terminal");
        } else unknown.push({ incoming, id, index });
    }
    if (highest < 0 && record.next_ordinal > record.first_ordinal) {
        return { ...result, exit: "provider_foreign_history" };
    }
    // A missing id below a known ordinary successor is a hole. A race-only
    // successor cannot prove that the missing suffix still exists in the host.
    const missing = record.entries.filter(
        (entry) => entry.ordinal < highest && !present.has(entry.id),
    );
    const lowestMissing = missing[0];
    if (lowestMissing) {
        const successors = record.entries.filter(
            (entry) => entry.ordinal > lowestMissing.ordinal && entry.ordinal <= highest,
        );
        if (
            successors.some((entry) => entry.race) &&
            successors.every((entry) => entry.race || !present.has(entry.id))
        ) {
            return { ...result, exit: "provider_revert_ambiguous" };
        }
    }
    result.holes = missing.map((entry) => entry.id);
    if (highest >= 0 && highest < record.next_ordinal - 1) result.revert_through = highest;
    let next =
        result.revert_through === undefined ? record.next_ordinal : result.revert_through + 1;
    result.appends = unknown.map(({ incoming, id, index }) => ({
        incoming,
        id,
        ordinal: next++,
        race: index < lastKnownIndex,
    }));
    return result;
}

/** Commit only after the scan's truncate, elisions, ancestry and exit are durable. */
export function commitScan<M>(
    record: RunnerRecord<M>,
    scan: WindowScan<M>,
    newLineage?: string,
): void {
    if (record.pipeline_exit) return;
    if (scan.exit) {
        commitExit(record, scan.exit);
        return;
    }
    if (scan.revert_through !== undefined) descend(record, scan.revert_through, newLineage ?? "");
    for (const id of scan.elided) record.elided.add(id);
    for (const id of scan.holes) {
        if (!record.hole_ids.has(id)) {
            record.hole_ids.add(id);
            record.counters.holes++;
        }
    }
    record.counters.prefix_events += scan.events.length;
}

/** Also used for module-ahead conflicts, before retrying the uncommitted appends. */
export function descend<M>(record: RunnerRecord<M>, through: number, lineage: string): void {
    if (
        !ordinal(through) ||
        through < record.first_ordinal - 1 ||
        through >= record.next_ordinal ||
        !lineage ||
        lineage === record.lineage_id ||
        record.ancestry.some((item) => item.lineage_id === lineage)
    ) {
        throw new Error("Invalid runner lineage descent");
    }
    const parent = { lineage_id: record.lineage_id, through_ordinal: through };
    record.ancestry.push(parent);
    record.descends_from = parent;
    record.lineage_id = lineage;
    record.entries = record.entries.filter((entry) => entry.ordinal <= through);
    for (const [id, held] of record.ids) {
        if (held > through) {
            record.ids.delete(id);
            record.hole_ids.delete(id);
        }
    }
    record.unserved_subjects = record.unserved_subjects.filter((subject) =>
        record.ids.has(subject.subject_mid),
    );
    record.next_ordinal = through + 1;
    record.served_through_ordinal = Math.min(record.served_through_ordinal, through);
    record.after_ordinal = Math.min(record.after_ordinal, through);
    // Keep the high-water request id; its old lineage can no longer apply.
    record.history_gap_from = undefined;
    if (through < record.view.range.to - 1) record.view = { ...record.view, state: "invalidated" };
}

export function descendModuleAhead<M>(record: RunnerRecord<M>, lineage: string): void {
    descend(record, record.next_ordinal - 1, lineage);
}

export interface OpFunctions<M> {
    current: number;
    /** Each shipped version applies only the adapter's text targets. */
    versions: ReadonlyMap<number, (message: M, answers: readonly HookAnswer[]) => M>;
}

/** Envelope/control fields are encoded separately so ingest is never reserialized. */
export function encodeStatusRequest(
    control: Readonly<Record<string, unknown>>,
    entries: readonly Pick<Entry<unknown>, "ordinal" | "id" | "ingest">[],
): string {
    const messages = entries.map(encodeStatusEntry).join(",");
    return encodeRequest("compaction.step", control, `"messages":[${messages}]`);
}

function encodeStatusEntry(entry: Pick<Entry<unknown>, "ordinal" | "id" | "ingest">): string {
    return `{"ordinal":${entry.ordinal},"mid":${JSON.stringify(entry.id)},"message":${entry.ingest}}`;
}

export function encodeHookRequest(
    control: Readonly<Record<string, unknown>>,
    ingest: string,
): string {
    return encodeRequest("transform.hook", control, `"message":${ingest}`);
}

function encodeRequest(
    method: string,
    control: Readonly<Record<string, unknown>>,
    payload: string,
): string {
    const reserved = method === "transform.hook" ? "message" : "messages";
    if (reserved in control) throw new Error(`Control fields must not contain ${reserved}`);
    const fields = JSON.stringify(control).slice(1, -1);
    return `{"method":${JSON.stringify(method)},"params":{${fields}${fields ? "," : ""}${payload}}}`;
}

export function encodedBytes(encoded: string): number {
    return new TextEncoder().encode(encoded).byteLength;
}

export function hookFits(control: Readonly<Record<string, unknown>>, ingest: string): boolean {
    return encodedBytes(encodeHookRequest(control, ingest)) <= MAX_REQUEST_BYTES;
}

export type Admission<M> =
    | { entry: Entry<M>; unserved_subjects: Subject[] }
    | { exit: "provider_message_too_large" };

/** Run once per unknown terminal message, before any hook is sent. */
export function admit<M>(
    record: RunnerRecord<M>,
    candidate: WindowScan<M>["appends"][number],
    control: Readonly<Record<string, unknown>>,
): { ingest: string; message: M } | { exit: "provider_message_too_large" } {
    record.counters.content_reads++;
    const ingest = JSON.stringify(candidate.incoming.read());
    record.counters.message_serializations++;
    const entry = { id: candidate.id, ordinal: candidate.ordinal, ingest };
    if (encodedBytes(encodeStatusRequest(control, [entry])) > MAX_REQUEST_BYTES)
        return { exit: "provider_message_too_large" };
    // Own an immutable admission snapshot, independent of later host edits.
    return { ingest, message: JSON.parse(ingest) as M };
}

/** A single failed subject freezes the entire message, including successful ops. */
export function finishEntry<M>(
    candidate: WindowScan<M>["appends"][number],
    admitted: { ingest: string; message: M },
    outcomes: readonly HookOutcome[],
    functions: OpFunctions<M>,
): Admission<M> {
    const apply = functions.versions.get(functions.current);
    if (!apply) throw new Error("Missing current op function");
    if (
        outcomes.some(
            (outcome) =>
                outcome.subject.subject_mid !== candidate.id ||
                ("answer" in outcome && !sameSubject(outcome.subject, outcome.answer.subject)),
        )
    )
        throw new Error("Hook subject mismatch");
    const unavailable = outcomes.some((outcome) => "unavailable" in outcome);
    const answers = unavailable
        ? []
        : outcomes.flatMap((outcome) => ("answer" in outcome ? [outcome.answer] : []));
    return {
        entry: {
            id: candidate.id,
            ordinal: candidate.ordinal,
            ingest: admitted.ingest,
            served: unavailable ? admitted.message : apply(admitted.message, answers),
            op_version: functions.current,
            hook: unavailable ? { answers: [], unavailable: true } : { answers },
            ingested: outcomes.length > 0 && !unavailable,
            race: candidate.race,
        },
        unserved_subjects: unavailable ? outcomes.map((outcome) => outcome.subject) : [],
    };
}

/** The ordinary-pass transaction's entries/state have succeeded before this call. */
export function commitEntries<M>(
    record: RunnerRecord<M>,
    admissions: readonly Admission<M>[],
): void {
    if (record.pipeline_exit) throw new Error("Exited runner record");
    let next = record.next_ordinal;
    const seen = new Set<string>();
    for (const admission of admissions) {
        if ("exit" in admission) throw new Error("Commit the admission exit instead of entries");
        const entry = admission.entry;
        if (
            entry.ordinal !== next++ ||
            record.ids.has(entry.id) ||
            record.elided.has(entry.id) ||
            seen.has(entry.id)
        )
            throw new Error("Non-contiguous or repeated runner admission");
        seen.add(entry.id);
    }
    for (const admission of admissions) {
        if ("exit" in admission) continue;
        record.entries.push(admission.entry);
        record.ids.set(admission.entry.id, admission.entry.ordinal);
        record.ordinal_divergence += Number(admission.entry.race);
        for (const subject of admission.unserved_subjects) {
            if (!record.unserved_subjects.some((held) => sameSubject(held, subject)))
                record.unserved_subjects.push(subject);
        }
    }
    record.next_ordinal = next;
    record.served_through_ordinal = next - 1;
    updateCursor(record);
}

function sameSubject(a: Subject, b: Subject): boolean {
    return (
        a.subject_mid === b.subject_mid &&
        a.hook === b.hook &&
        (a.subject_part ?? "") === (b.subject_part ?? "")
    );
}

/** Only an answered call acknowledges the burn list that it actually carried. */
export function acknowledgeUnserved<M>(record: RunnerRecord<M>, sent: readonly Subject[]): void {
    record.unserved_subjects = record.unserved_subjects.filter(
        (held) => !sent.some((subject) => sameSubject(held, subject)),
    );
}

function updateCursor<M>(record: RunnerRecord<M>): void {
    // An invalidated view may extend beyond a revert's newest. Only the
    // inherited prefix before the retained tail is already known to ck-mc.
    let cursor = (record.entries[0]?.ordinal ?? record.next_ordinal) - 1;
    for (const entry of record.entries) {
        if (!entry.ingested) break;
        cursor = entry.ordinal;
    }
    record.after_ordinal = cursor;
}

export function statusContent<M>(record: RunnerRecord<M>): {
    after_ordinal: number;
    messages: Pick<Entry<M>, "ordinal" | "id" | "ingest">[];
} {
    return {
        after_ordinal: record.after_ordinal,
        messages: record.entries
            .filter((entry) => entry.ordinal > record.after_ordinal && !entry.ingested)
            .map(({ ordinal, id, ingest }) => ({ ordinal, id, ingest })),
    };
}

/** Page the missing ingest bytes, measuring the complete encoded envelope. */
export function statusPages<M>(
    record: RunnerRecord<M>,
    control: Readonly<Record<string, unknown>>,
): string[] {
    if ("more" in control || "after_ordinal" in control)
        throw new Error("Paging owns more and after_ordinal");
    const content = statusContent(record);
    const fragments = content.messages.map((entry) => {
        const encoded = encodeStatusEntry(entry);
        return { encoded, bytes: encodedBytes(encoded), ordinal: entry.ordinal };
    });
    const pages: string[] = [];
    let index = 0;
    let after = content.after_ordinal;
    do {
        const pageControl = { ...control, after_ordinal: after };
        const base = encodedBytes(encodeStatusRequest(pageControl, []));
        const withMore = encodedBytes(encodeStatusRequest({ ...pageControl, more: true }, []));
        if (base > MAX_REQUEST_BYTES) throw new Error("Status control exceeds request cap");
        let count = 0;
        let bytes = 0;
        while (index + count < fragments.length) {
            const fragment = fragments[index + count];
            const nextBytes = bytes + fragment.bytes + Number(count > 0);
            const overhead = index + count + 1 < fragments.length ? withMore : base;
            if (overhead + nextBytes > MAX_REQUEST_BYTES) break;
            count++;
            bytes = nextBytes;
        }
        if (index < fragments.length && !count)
            throw new Error("Single-entry status exceeds request cap");
        const more = index + count < fragments.length;
        pages.push(
            encodeRequest(
                "compaction.step",
                { ...pageControl, ...(more ? { more: true } : {}) },
                `"messages":[${fragments
                    .slice(index, index + count)
                    .map((entry) => entry.encoded)
                    .join(",")}]`,
            ),
        );
        if (!count) break;
        after = fragments[index + count - 1].ordinal;
        index += count;
    } while (index < fragments.length);
    return pages;
}

/** After the page answer is durable, ck-mc holds even previously frozen-raw bytes. */
export function acknowledgeStatus<M>(record: RunnerRecord<M>, sentIds: ReadonlySet<string>): void {
    for (const entry of record.entries) if (sentIds.has(entry.id)) entry.ingested = true;
    updateCursor(record);
}

/** A restart derives served once, using the recorded version, never the host window. */
export function hydrateEntry<M>(
    entry: Omit<Entry<M>, "served">,
    functions: OpFunctions<M>,
): { entry: Entry<M>; event?: "unknown_op_version" } {
    const kept = functions.versions.get(entry.op_version);
    const apply = kept ?? functions.versions.get(functions.current);
    if (!apply) throw new Error("Missing current op function");
    const message = JSON.parse(entry.ingest) as M;
    return {
        entry: {
            ...entry,
            served: entry.hook.unavailable ? message : apply(message, entry.hook.answers),
        },
        ...(!kept ? { event: "unknown_op_version" as const } : {}),
    };
}

/** Fence persistence precedes the call. A timeout is represented by its deadline. */
export function issueRequest<M>(
    record: RunnerRecord<M>,
    request_id: string,
    deadline_ms: number,
): void {
    if (!request_id || !Number.isFinite(deadline_ms) || record.issued?.request_id === request_id)
        throw new Error("Invalid runner request fence");
    record.issued = {
        request_id,
        deadline_ms,
        newest: record.next_ordinal - 1,
        lineage_id: record.lineage_id,
    };
}

/** All step answers (including noop, wait and refuse) share the same fence. */
export function checkAnswerFence<M>(
    record: RunnerRecord<M>,
    request_id: string,
    arrived_ms: number,
): "superseded_request" | "late" | undefined {
    const fence = record.issued;
    if (
        record.pipeline_exit ||
        !fence ||
        fence.answered ||
        request_id !== fence.request_id ||
        fence.lineage_id !== record.lineage_id
    )
        return "superseded_request";
    if (!Number.isFinite(arrived_ms) || arrived_ms >= fence.deadline_ms) return "late";
    return undefined;
}

/** Persist a non-view answer before acknowledging its status or burn list. */
export function commitNonViewAnswer<M>(
    record: RunnerRecord<M>,
    request_id: string,
    arrived_ms: number,
    answer: "noop" | "wait" | "refuse",
): "superseded_request" | "late" | undefined {
    const reason = checkAnswerFence(record, request_id, arrived_ms);
    if (!reason && record.issued) {
        record.issued.answered = true;
        if (answer === "noop") record.history_gap_from = undefined;
    }
    return reason;
}

function validCompaction<M>(view: Compaction<M>): boolean {
    return (
        typeof view.compaction_id === "string" &&
        !!view.compaction_id &&
        ordinal(view.version) &&
        ordinal(view.range?.from) &&
        ordinal(view.range?.to) &&
        view.range.from <= view.range.to &&
        Array.isArray(view.replacement)
    );
}

/**
 * Host structural checks are required, over replacement plus the retained tail.
 * They validate roles, tool pairing and boundary safety without transforming the
 * replacement. Coverage is returned only on application, never on a refused view.
 */
export function applyCompaction<M>(
    record: RunnerRecord<M>,
    input: {
        request_id: string;
        arrived_ms: number;
        compaction: Compaction<M>;
        coverage?: View<M>["coverage"];
    },
    structural: (messages: readonly M[], view: Compaction<M>) => boolean,
):
    | { applied: true; coverage?: View<M>["coverage"] }
    | { applied: false; reason: NotAppliedReason } {
    const view = input.compaction;
    const fence = record.issued;
    let reason: NotAppliedReason | undefined;
    const fenceReason = checkAnswerFence(record, input.request_id, input.arrived_ms);
    if (!fence || fenceReason) reason = fenceReason ?? "superseded_request";
    else if (
        ordinal(view.range?.from) &&
        ordinal(view.range?.to) &&
        view.range.from > view.range.to
    )
        reason = "range_inverted";
    else if (!validCompaction(view)) reason = "structural";
    else if (view.version <= record.view.version) reason = "stale_version";
    else if (view.range.to > fence.newest + 1) reason = "range_beyond_newest";
    else {
        const tail = record.entries.filter((entry) => entry.ordinal >= view.range.to);
        // Pruned bytes cannot be resurrected by a retreating range boundary.
        const retainedFrom = record.entries[0]?.ordinal ?? record.next_ordinal;
        if (view.range.to < record.view.range.to && view.range.to < retainedFrom)
            reason = "structural";
        else if (tail.length && tail[0].ordinal !== Math.max(record.first_ordinal, view.range.to))
            reason = "structural";
        else if (!structural([...view.replacement, ...tail.map((entry) => entry.served)], view))
            reason = "structural";
    }
    if (fence && !fenceReason) fence.answered = true;
    if (reason) {
        if (
            ordinal(view.version) &&
            view.version > record.view.version &&
            (!record.last_not_applied || view.version > record.last_not_applied.version)
        )
            record.last_not_applied = {
                compaction_id: view.compaction_id,
                version: view.version,
                reason,
            };
        return { applied: false, reason };
    }
    record.view = {
        ...view,
        state: "applied",
        ...(input.coverage ? { coverage: input.coverage } : {}),
    };
    record.history_gap_from = undefined;
    record.entries = record.entries.filter((entry) => entry.ordinal >= view.range.to);
    record.last_not_applied =
        record.last_not_applied && record.last_not_applied.version > view.version
            ? record.last_not_applied
            : undefined;
    updateCursor(record);
    return { applied: true, ...(input.coverage ? { coverage: input.coverage } : {}) };
}

export function commitExit<M>(record: RunnerRecord<M>, reason: ExitReason): boolean {
    if (record.pipeline_exit) return false;
    record.pipeline_exit = { reason, reseed_full_request: record.ordinal_divergence > 0 };
    return true;
}

/** Gap recovery is bounded: resending the same missing frontier twice exits. */
export function commitHistoryGap<M>(record: RunnerRecord<M>, gap: number): void {
    if (!ordinal(gap)) throw new Error("Invalid history gap");
    if (gap < record.view.range.to || record.history_gap_from === gap) {
        commitExit(record, "provider_history_lost");
        return;
    }
    record.history_gap_from = gap;
    for (const entry of record.entries) if (entry.ordinal >= gap) entry.ingested = false;
    updateCursor(record);
}

export interface RebuildInputs {
    call_when_share?: number;
    context_window?: number;
    previous_usage?: { input: number; cache_read: number; cache_write: number };
    appended_tokens: number;
    prefix_rebuilding?: string;
    provider_overflow?: boolean;
}
export function rebuildNeeded<M>(record: RunnerRecord<M>, inputs: RebuildInputs): boolean {
    if (record.pipeline_exit) return false;
    if (
        record.view.state === "invalidated" ||
        inputs.prefix_rebuilding ||
        inputs.provider_overflow ||
        record.last_not_applied
    )
        return true;
    const usage = inputs.previous_usage;
    return (
        inputs.call_when_share !== undefined &&
        inputs.context_window !== undefined &&
        usage !== undefined &&
        usage.input + usage.cache_read + usage.cache_write + inputs.appended_tokens >=
            inputs.call_when_share * inputs.context_window
    );
}

export function assemble<M>(record: RunnerRecord<M>, passthrough: readonly M[] = []): M[] {
    if (record.pipeline_exit)
        throw new Error(`Runner pipeline exited: ${record.pipeline_exit.reason}`);
    if (record.view.state === "invalidated")
        throw new Error("Runner view invalidated: revert rebuild required");
    return [
        ...record.view.replacement,
        ...record.entries.map((entry) => entry.served),
        ...passthrough,
    ];
}
