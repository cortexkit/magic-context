import { describe, expect, test } from "bun:test";
import {
    acknowledgeStatus,
    acknowledgeUnserved,
    admit,
    applyCompaction,
    assemble,
    type Compaction,
    commitEntries,
    commitExit,
    commitHistoryGap,
    commitNonViewAnswer,
    commitScan,
    createRecord,
    descendModuleAhead,
    encodedBytes,
    encodeHookRequest,
    encodeStatusPage,
    encodeStatusRequest,
    finishEntry,
    type HookAnswer,
    type HookOutcome,
    hookFits,
    hydrateEntry,
    type Incoming,
    issueRequest,
    MAX_REQUEST_BYTES,
    type NotAppliedReason,
    type OpFunctions,
    type RunnerRecord,
    rebuildNeeded,
    type Subject,
    scanWindow,
    statusContent,
    statusPages,
} from "./record";

type Message = { id: string; text: string; untouched?: { signature: string } };
const functions: OpFunctions<Message> = {
    current: 2,
    versions: new Map([
        [
            1,
            (message: Message, answers: readonly HookAnswer[]) => ({
                ...message,
                text: `${answers.length ? "old:" : ""}${message.text}`,
            }),
        ],
        [
            2,
            (message: Message, answers: readonly HookAnswer[]) => ({
                ...message,
                text: `${answers.length ? "§7§ " : ""}${message.text}`,
            }),
        ],
    ]),
};
const control = {
    session: "s",
    harness: "opencode",
    lineage_id: "L",
    request_id: "r",
    served_through_ordinal: 0,
    model: "m",
    now: 1,
};
function record(first = 1): RunnerRecord<Message> {
    return createRecord({
        lineage_id: "L",
        first_ordinal: first,
        plan: { on_unavailable: "pass" },
        initial: { compaction_id: "setup", version: 0, range: { from: 0, to: 0 }, replacement: [] },
    });
}
function incoming(id: string, text = id): Incoming<Message> {
    return {
        id,
        classify: () => "terminal",
        read: () => ({ id, text, untouched: { signature: "signed" } }),
    };
}
function subject(id: string, hook: Subject["hook"] = "pre_user", part?: string): Subject {
    return { subject_mid: id, hook, ...(part ? { subject_part: part } : {}) };
}
function answer(value: Subject): HookOutcome {
    return { subject: value, answer: { subject: value, ops: [], tags: [7] } };
}
let lineage = 0;
function pass(
    state: RunnerRecord<Message>,
    window: Incoming<Message>[],
    outcomes?: (id: string) => HookOutcome[],
): void {
    const scan = scanWindow(state, window);
    commitScan(state, scan, `L-${++lineage}`);
    if (scan.exit) return;
    const entries = scan.appends.map((candidate) => {
        const admission = admit(state, candidate, control);
        if ("exit" in admission) throw new Error(admission.exit);
        return finishEntry(
            candidate,
            admission,
            outcomes?.(candidate.id) ?? [answer(subject(candidate.id))],
            functions,
        );
    });
    commitEntries(state, entries);
}
function ids(state: RunnerRecord<Message>): string[] {
    return assemble(state).map((message) => message.id);
}
function compaction(
    to: number,
    version = 1,
    replacement: Message[] = [{ id: "view", text: "summary" }],
): Compaction<Message> {
    return { compaction_id: "c", version, range: { from: 1, to }, replacement };
}
function apply(state: RunnerRecord<Message>, to: number): void {
    issueRequest(state, `r-${state.view.version}`, 100);
    expect(
        applyCompaction(
            state,
            {
                request_id: state.issued?.request_id ?? "",
                arrived_ms: 1,
                compaction: compaction(to, state.view.version + 1),
            },
            () => true,
        ).applied,
    ).toBe(true);
}

describe("runner record append oracle", () => {
    test("A1 known ids preserve first-serve bytes and references on appends", () => {
        const state = record();
        let previous: Message[] = [];
        for (let i = 1; i <= 20; i++) {
            pass(
                state,
                Array.from({ length: i }, (_, j) => incoming(`m${j}`, `changed-${i}`)),
            );
            const current = assemble(state);
            expect(current.slice(0, previous.length)).toEqual(previous);
            for (let j = 0; j < previous.length; j++) expect(current[j]).toBe(previous[j]);
            previous = current;
        }
        expect(state.next_ordinal).toBe(21);
    });

    test("A2 host counters: known content is never read or serialized at 1k and 8k", () => {
        for (const length of [1000, 8000]) {
            const state = record();
            pass(
                state,
                Array.from({ length }, (_, i) => incoming(`m${i}`)),
            );
            const before = { ...state.counters };
            let reads = 0;
            const window = Array.from(
                { length },
                (_, i): Incoming<Message> => ({
                    id: `m${i}`,
                    classify: () => {
                        throw new Error("known classification");
                    },
                    read: () => {
                        reads++;
                        return { id: `m${i}`, text: "changed" };
                    },
                }),
            );
            let servedSerializations = 0;
            for (const entry of state.entries) {
                Object.defineProperty(entry.served, "toJSON", {
                    value: () => {
                        servedSerializations++;
                        return { ...entry.served };
                    },
                    enumerable: false,
                });
            }
            const prior = assemble(state);
            pass(state, [...window, incoming("new")]);
            expect(reads).toBe(0);
            expect(servedSerializations).toBe(0);
            expect(state.counters.content_reads - before.content_reads).toBe(1);
            expect(state.counters.message_serializations - before.message_serializations).toBe(1);
            expect(state.counters.id_lookups - before.id_lookups).toBe(length + 1);
            expect(assemble(state).slice(0, length)).toEqual(prior);
            expect(statusContent(state)).toEqual({ after_ordinal: length + 1, messages: [] });
        }
    });

    test("A4 late race message appends instead of sorting into served prefix", () => {
        const state = record();
        pass(
            state,
            ["u1", "a1", "a2"].map((id) => incoming(id)),
        );
        const before = assemble(state);
        pass(
            state,
            ["u1", "a1", "X", "a2", "a3"].map((id) => incoming(id)),
        );
        expect(ids(state)).toEqual(["u1", "a1", "a2", "X", "a3"]);
        expect(assemble(state).slice(0, 3)).toEqual(before);
        expect(state.ordinal_divergence).toBe(1);
        expect(state.entries.find((entry) => entry.id === "X")?.race).toBe(true);
    });

    test("A4 interior hole stays served and is counted once", () => {
        const state = record();
        pass(
            state,
            ["A", "B", "C", "D"].map((id) => incoming(id)),
        );
        const before = assemble(state);
        pass(
            state,
            ["A", "X", "C", "D", "E"].map((id) => incoming(id)),
        );
        pass(
            state,
            ["A", "X", "C", "D", "E", "F"].map((id) => incoming(id)),
        );
        expect(ids(state)).toEqual(["A", "B", "C", "D", "X", "E", "F"]);
        expect(assemble(state).slice(0, 4)).toEqual(before);
        expect(state.counters.holes).toBe(1);
        expect(state.pipeline_exit).toBeUndefined();
    });

    test("A4 repeated race id neither truncates nor starts a lineage", () => {
        const state = record();
        pass(
            state,
            ["A", "B", "C"].map((id) => incoming(id)),
        );
        for (const window of [
            ["A", "X", "B", "C"],
            ["A", "X", "B", "C"],
            ["A", "X", "B", "C", "D"],
        ])
            pass(
                state,
                window.map((id) => incoming(id)),
            );
        expect(ids(state)).toEqual(["A", "B", "C", "X", "D"]);
        expect(state.lineage_id).toBe("L");
        expect(state.ordinal_divergence).toBe(1);
    });

    test("A4 ambiguous race-only successor exits and cannot serve C", () => {
        const state = record();
        pass(
            state,
            ["A", "B", "C"].map((id) => incoming(id)),
        );
        pass(
            state,
            ["A", "X", "B", "C"].map((id) => incoming(id)),
        );
        pass(
            state,
            ["A", "X", "B"].map((id) => incoming(id)),
        );
        expect(state.pipeline_exit).toEqual({
            reason: "provider_revert_ambiguous",
            reseed_full_request: true,
        });
        expect(() => assemble(state)).toThrow("provider_revert_ambiguous");
    });

    test("A4 moved marker pair is elided without ordinals, hooks, status or divergence", () => {
        const state = record();
        pass(state, [incoming("A")]);
        const marker = (id: string): Incoming<Message> => ({
            id,
            classify: () => "marker",
            read: () => {
                throw new Error("marker content read");
            },
        });
        pass(state, [marker("old-start"), marker("old-end"), incoming("A"), incoming("B")]);
        pass(state, [
            incoming("A"),
            marker("new-start"),
            marker("new-end"),
            incoming("B"),
            incoming("C"),
        ]);
        expect(state.elided.size).toBe(4);
        expect([...state.ids.values()]).toEqual([1, 2, 3]);
        expect(ids(state)).toEqual(["A", "B", "C"]);
        expect(state.ordinal_divergence).toBe(0);
        expect(statusContent(state)).toEqual({ after_ordinal: 3, messages: [] });
    });

    test("property: random append, revert and race preserve first bytes and surviving prefixes", () => {
        let observedReverts = 0;
        let observedRaces = 0;
        for (let seed = 1; seed <= 100; seed++) {
            let randomState = seed;
            const random = () => {
                randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
                return randomState / 2 ** 32;
            };
            const state = record();
            const firstServe = new Map<string, string>();
            let window: Incoming<Message>[] = [];
            let unique = 0;
            for (let step = 0; step < 80; step++) {
                const previous = assemble(state);
                let prefix = previous.length;
                if (previous.length > 1 && random() < 0.3) {
                    prefix = 1 + Math.floor(random() * (previous.length - 1));
                    const surviving = new Set(
                        previous.slice(0, prefix).map((message) => message.id),
                    );
                    window = window.filter((item) => item.id && surviving.has(item.id));
                    observedReverts++;
                }
                for (let count = 1 + Math.floor(random() * 3); count > 0; count--) {
                    const item = incoming(`seed${seed}-m${++unique}`);
                    const race = window.length > 0 && random() < 0.4;
                    const position = race ? Math.floor(random() * window.length) : window.length;
                    window.splice(position, 0, item);
                    if (race) observedRaces++;
                }
                // Deliberately change all host content, even on duplicate ids.
                window = window.map((item) => incoming(item.id ?? "", `host-${step}-${item.id}`));
                pass(state, window);
                expect(state.pipeline_exit).toBeUndefined();
                const current = assemble(state);
                expect(current.slice(0, prefix)).toEqual(previous.slice(0, prefix));
                for (const message of current) {
                    const bytes = JSON.stringify(message);
                    if (firstServe.has(message.id))
                        expect(bytes).toBe(firstServe.get(message.id) ?? "");
                    else firstServe.set(message.id, bytes);
                }
            }
        }
        expect(observedReverts).toBeGreaterThan(1000);
        expect(observedRaces).toBeGreaterThan(1000);
    });
});

describe("revert, restart and module-ahead", () => {
    test("A5 raw-tail revert clamps served watermark before the next hook", () => {
        const state = record(90);
        pass(
            state,
            Array.from({ length: 11 }, (_, i) => incoming(`m${90 + i}`)),
        );
        apply(state, 91);
        const prefix = assemble(state).slice(0, 1);
        const scan = scanWindow(state, [incoming("m90"), incoming("new")]);
        expect(scan.revert_through).toBe(90);
        commitScan(state, scan, "descendant");
        expect(state.served_through_ordinal).toBe(90);
        expect(state.descends_from).toEqual({ lineage_id: "L", through_ordinal: 90 });
        expect(state.next_ordinal).toBe(91);
        expect(assemble(state)).toEqual(prefix);
        expect(state.ids.has("m100")).toBe(false);
        // A crash after this hook leaves the committed watermark at 90.
        const admission = admit(state, scan.appends[0], control);
        expect("exit" in admission).toBe(false);
        expect(state.served_through_ordinal).toBe(90);
    });

    test("A5 revert into a fully pruned view uses ids and fails closed until one rebuild", () => {
        const state = record();
        pass(
            state,
            ["A", "B", "C", "D"].map((id) => incoming(id)),
        );
        apply(state, 5);
        expect(state.entries).toEqual([]);
        // H2 hydrates these ids even when there is no raw tail left.
        const restarted = {
            ...state,
            ids: new Map(state.ids),
            entries: [],
            ancestry: [...state.ancestry],
        };
        pass(
            restarted,
            ["A", "B"].map((id) => incoming(id)),
        );
        expect(restarted.view.state).toBe("invalidated");
        expect(restarted.after_ordinal).toBe(2);
        expect(restarted.ancestry).toEqual([{ lineage_id: "L", through_ordinal: 2 }]);
        expect(rebuildNeeded(restarted, { appended_tokens: 0 })).toBe(true);
        expect(() => assemble(restarted)).toThrow("invalidated");
        // An unavailable step or noop does not clear invalidation.
        expect(() => assemble(restarted)).toThrow("invalidated");
        issueRequest(restarted, "revert", 100);
        expect(
            applyCompaction(
                restarted,
                { request_id: "revert", arrived_ms: 1, compaction: compaction(3, 2) },
                () => true,
            ).applied,
        ).toBe(true);
        expect(restarted.view.state).toBe("applied");
        expect(ids(restarted)).toEqual(["view"]);
    });

    test("module-ahead descent drops speculative hook answers and retries the same ordinals", () => {
        const state = record();
        pass(state, [incoming("A")]);
        const scan = scanWindow(state, [
            incoming("A"),
            incoming("Z"),
            incoming("X"),
            incoming("Y"),
        ]);
        const admitted = admit(state, scan.appends[1], control);
        if ("exit" in admitted) throw new Error("unexpected oversize");
        const stranded = finishEntry(scan.appends[1], admitted, [answer(subject("X"))], functions);
        expect("entry" in stranded).toBe(true);
        expect(ids(state)).toEqual(["A"]);
        descendModuleAhead(state, "retry");
        expect(state.descends_from).toEqual({ lineage_id: "L", through_ordinal: 1 });
        expect(state.served_through_ordinal).toBe(1);
        expect(state.next_ordinal).toBe(2);
        pass(state, [incoming("A"), incoming("Z"), incoming("X"), incoming("Y")]);
        expect(ids(state)).toEqual(["A", "Z", "X", "Y"]);
        expect([...state.ids.values()]).toEqual([1, 2, 3, 4]);
        expect(state.unserved_subjects).toEqual([]);
    });

    test("restart replays pinned op versions; unknown version declares a prefix event", () => {
        const state = record();
        pass(state, [incoming("A")]);
        const { served: _served, ...durable } = state.entries[0];
        expect(hydrateEntry({ ...durable, op_version: 1 }, functions).entry.served.text).toBe(
            "old:A",
        );
        const restored = hydrateEntry(durable, functions);
        expect(restored.entry.served).toEqual(state.entries[0].served);
        expect(restored.event).toBeUndefined();
        expect(hydrateEntry({ ...durable, op_version: 99 }, functions).event).toBe(
            "unknown_op_version",
        );
    });

    test("idless and non-terminal rows declare events but are not admitted", () => {
        const state = record();
        const idless: Incoming<Message> = {
            classify: () => "terminal",
            read: () => ({ id: "", text: "wire" }),
        };
        const running = { ...incoming("running"), classify: () => "non_terminal" as const };
        const scan = scanWindow(state, [idless, running, incoming("A")]);
        commitScan(state, scan);
        expect(scan.events).toEqual(["idless", "non_terminal"]);
        expect(scan.passthrough).toEqual([idless, running]);
        expect(scan.appends.map((item) => item.id)).toEqual(["A"]);
        expect(state.counters.prefix_events).toBe(2);
        expect(state.ids.size).toBe(0);
    });
});

describe("status and encoded request caps", () => {
    test("A9 partial failure freezes raw, burns every part subject and resends one message", () => {
        const state = record();
        const subjects = [
            subject("A", "post_assistant"),
            subject("A", "post_tool", "p1"),
            subject("A", "post_tool", "p2"),
        ];
        pass(state, [incoming("A")], () => [
            answer(subjects[0]),
            answer(subjects[1]),
            { subject: subjects[2], unavailable: true },
        ]);
        expect(state.entries[0].served.text).toBe("A");
        expect(state.entries[0].hook.answers).toEqual([]);
        expect(state.unserved_subjects).toEqual(subjects);
        expect(statusContent(state).messages.map((entry) => entry.id)).toEqual(["A"]);
        expect(statusContent(state).after_ordinal).toBe(0);
        pass(state, [incoming("A"), incoming("B")]);
        expect(state.counters.content_reads).toBe(2);
        expect(statusContent(state).messages.map((entry) => entry.id)).toEqual(["A"]);
        acknowledgeUnserved(state, subjects.slice(0, 2));
        expect(state.unserved_subjects).toEqual([subjects[2]]);
        acknowledgeUnserved(state, subjects);
        acknowledgeStatus(state, new Set(["A"]));
        expect(state.unserved_subjects).toEqual([]);
        expect(statusContent(state)).toEqual({ after_ordinal: 2, messages: [] });
    });

    test("A9 distinct mids and part ids keep independent answer identities", () => {
        const state = record();
        pass(state, [incoming("A", "continue"), incoming("B", "continue")]);
        expect(state.entries.map((entry) => entry.hook.answers[0].subject.subject_mid)).toEqual([
            "A",
            "B",
        ]);
        const parts = [subject("C", "post_tool", "p1"), subject("C", "post_tool", "p2")];
        pass(state, [incoming("A"), incoming("B"), incoming("C")], () => [
            { subject: parts[0], unavailable: true },
            { subject: parts[1], unavailable: true },
        ]);
        acknowledgeUnserved(state, [parts[0]]);
        expect(state.unserved_subjects).toEqual([parts[1]]);
    });

    test("A9 all answered hooks yield an empty rebuild status at newest", () => {
        const state = record(4000);
        for (let i = 1; i <= 30; i++)
            pass(
                state,
                Array.from({ length: i }, (_, j) => incoming(`m${j}`)),
            );
        expect(statusContent(state)).toEqual({ after_ordinal: 4029, messages: [] });
    });

    test("size checks measure escaped and non-ASCII encoded envelopes and duplicated blocks", () => {
        const state = record();
        const text = 'é"\\\n'.repeat(210000);
        const scan = scanWindow(state, [incoming("A", text)]);
        const admitted = admit(state, scan.appends[0], control);
        if ("exit" in admitted) throw new Error("single status should fit");
        const status = encodeStatusRequest(control, [
            { id: "A", ordinal: 1, ingest: admitted.ingest },
        ]);
        expect(encodedBytes(status)).toBeLessThan(MAX_REQUEST_BYTES);
        expect(encodedBytes(status)).toBeGreaterThan(status.length);
        const hook = { ...control, blocks: [text], subject_mid: "A", subject_ordinal: 1 };
        expect(hookFits(hook, admitted.ingest)).toBe(false);
        expect(encodedBytes(encodeHookRequest(hook, admitted.ingest))).toBeGreaterThan(
            MAX_REQUEST_BYTES,
        );
        expect(JSON.parse(status).params.messages[0].message.text).toBe(text);
        const oversized = scanWindow(state, [incoming("B", "é".repeat(MAX_REQUEST_BYTES))]);
        expect(admit(state, oversized.appends[0], control)).toEqual({
            exit: "provider_message_too_large",
        });
    });

    test("status pages preserve exact ingest and cap the whole envelope", () => {
        const state = record();
        pass(
            state,
            ["A", "B", "C"].map((id) => incoming(id, "é".repeat(600000))),
            (id) => [{ subject: subject(id), unavailable: true }],
        );
        const pages = statusPages(state, control).map((page, index) => {
            issueRequest(state, String(index + 1).padStart(control.request_id.length, "0"), 100);
            return encodeStatusPage(state, page);
        });
        expect(pages).toHaveLength(2);
        for (const page of pages) expect(encodedBytes(page)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
        const decoded = pages.map((page) => JSON.parse(page).params);
        expect(decoded[0].more).toBe(true);
        expect(decoded[1].more).toBeUndefined();
        expect(decoded[0].after_ordinal).toBe(0);
        expect(decoded[1].after_ordinal).toBe(2);
        expect(
            decoded.flatMap((page) => page.messages.map((entry: { mid: string }) => entry.mid)),
        ).toEqual(["A", "B", "C"]);
        expect(decoded[0].messages[0].message.text).toBe("é".repeat(600000));
    });

    test("history gap clears ingestion at the first raw ordinal and repeats exit", () => {
        const state = record();
        pass(
            state,
            ["A", "B", "C"].map((id) => incoming(id)),
        );
        apply(state, 2);
        const view = state.view;
        commitHistoryGap(state, 2);
        expect(state.view).toBe(view);
        expect(statusContent(state)).toEqual({
            after_ordinal: 1,
            messages: state.entries.map(({ ordinal, id, ingest }) => ({ ordinal, id, ingest })),
        });
        acknowledgeStatus(state, new Set(["B", "C"]));
        issueRequest(state, "resend-page", 10);
        expect(commitNonViewAnswer(state, "resend-page", 1, "wait")).toBeUndefined();
        commitHistoryGap(state, 2);
        expect(state.pipeline_exit?.reason).toBe("provider_history_lost");
    });
});

describe("fence, version, structural and exit rules", () => {
    test("checks run in contract order and only applied coverage may move a marker", () => {
        const cases: {
            id: string;
            time: number;
            view: Compaction<Message>;
            reason: NotAppliedReason;
        }[] = [
            { id: "old", time: 100, view: compaction(20, 0), reason: "superseded_request" },
            { id: "r", time: 100, view: compaction(20, 0), reason: "late" },
            {
                id: "r",
                time: 99,
                view: { ...compaction(2, 0), range: { from: 3, to: 2 } },
                reason: "range_inverted",
            },
            { id: "r", time: 99, view: compaction(20, 0), reason: "stale_version" },
            { id: "r", time: 99, view: compaction(20, 1), reason: "range_beyond_newest" },
            { id: "r", time: 99, view: compaction(2, 1), reason: "structural" },
        ];
        for (const item of cases) {
            const state = record();
            pass(
                state,
                ["A", "B", "C"].map((id) => incoming(id)),
            );
            issueRequest(state, "r", 100);
            const before = assemble(state);
            const outcome = applyCompaction(
                state,
                {
                    request_id: item.id,
                    arrived_ms: item.time,
                    compaction: item.view,
                    coverage: { end_mid: "A", ordinal: 1 },
                },
                () => false,
            );
            expect(outcome).toEqual({ applied: false, reason: item.reason });
            expect(assemble(state)).toEqual(before);
            expect(state.view.coverage).toBeUndefined();
        }
    });

    test("structural validator sees replacement plus frozen served tail, not live host bytes", () => {
        const state = record();
        pass(
            state,
            ["A", "B", "C"].map((id) => incoming(id)),
        );
        const oldC = state.entries[2].served;
        issueRequest(state, "r", 10);
        let called = 0;
        const result = applyCompaction(
            state,
            {
                request_id: "r",
                arrived_ms: 1,
                compaction: compaction(3),
                coverage: { end_mid: "B", ordinal: 2 },
            },
            (messages) => {
                called++;
                expect(messages.map((message) => message.id)).toEqual(["view", "C"]);
                expect(messages[1]).toBe(oldC);
                return true;
            },
        );
        expect(called).toBe(1);
        expect(result).toEqual({ applied: true, coverage: { end_mid: "B", ordinal: 2 } });
        expect(ids(state)).toEqual(["view", "C"]);
        expect(state.ids.get("B")).toBe(2);
        expect(state.entries).toHaveLength(1);
    });

    test("a single request never applies two views; issued newest bounds concurrent appends", () => {
        const state = record();
        pass(state, [incoming("A")]);
        issueRequest(state, "r", 10);
        pass(state, [incoming("A"), incoming("B")]);
        expect(
            applyCompaction(
                state,
                { request_id: "r", arrived_ms: 1, compaction: compaction(2) },
                () => true,
            ).applied,
        ).toBe(true);
        expect(
            applyCompaction(
                state,
                { request_id: "r", arrived_ms: 2, compaction: compaction(3, 2) },
                () => true,
            ),
        ).toEqual({ applied: false, reason: "superseded_request" });
        issueRequest(state, "r2", 10);
        expect(
            applyCompaction(
                state,
                { request_id: "r2", arrived_ms: 1, compaction: compaction(4, 2) },
                () => true,
            ),
        ).toEqual({ applied: false, reason: "range_beyond_newest" });
        expect(ids(state)).toEqual(["view", "B"]);
    });

    test("retreating range cannot resurrect pruned bytes, even on revert rebuild", () => {
        const state = record();
        pass(
            state,
            ["A", "B", "C", "D"].map((id) => incoming(id)),
        );
        apply(state, 5);
        pass(state, [incoming("A"), incoming("B"), incoming("new")]);
        issueRequest(state, "bad-revert", 10);
        expect(
            applyCompaction(
                state,
                { request_id: "bad-revert", arrived_ms: 1, compaction: compaction(2, 2) },
                () => true,
            ),
        ).toEqual({ applied: false, reason: "structural" });
        expect(() => assemble(state)).toThrow("invalidated");
    });

    test("rebuild opportunities exclude a plain publish or queued drop", () => {
        const state = record();
        expect(rebuildNeeded(state, { appended_tokens: 0 })).toBe(false);
        const threshold = {
            call_when_share: 0.8,
            context_window: 100,
            previous_usage: { input: 60, cache_read: 10, cache_write: 5 },
            appended_tokens: 4,
        };
        expect(rebuildNeeded(state, threshold)).toBe(false);
        expect(rebuildNeeded(state, { ...threshold, appended_tokens: 5 })).toBe(true);
        for (const reason of [
            "flush",
            "expired_cache",
            "model_switch",
            "manifest_change",
            "revert",
        ])
            expect(rebuildNeeded(state, { appended_tokens: 0, prefix_rebuilding: reason })).toBe(
                true,
            );
    });

    test("exits are sticky, record-only and distinguish rollback reseeding", () => {
        for (const reason of [
            "provider_record_lost",
            "provider_message_too_large",
            "provider_history_lost",
            "provider_foreign_history",
            "provider_revert_ambiguous",
        ] as const) {
            const state = record();
            pass(state, [incoming("A")]);
            expect(commitExit(state, reason)).toBe(true);
            expect(commitExit(state, "provider_foreign_history")).toBe(false);
            expect(state.pipeline_exit).toEqual({ reason, reseed_full_request: false });
            expect(() => assemble(state)).toThrow(reason);
            pass(state, [incoming("A"), incoming("B")]);
            expect(state.entries).toHaveLength(1);
        }
        const state = record();
        pass(state, [incoming("A"), incoming("B")]);
        pass(state, [incoming("A"), incoming("X"), incoming("B")]);
        commitExit(state, "provider_history_lost");
        expect(state.pipeline_exit?.reseed_full_request).toBe(true);
    });

    test("late noop, wait and refusal answers cannot advance the record", () => {
        const state = record();
        pass(state, [incoming("A")], (id) => [{ subject: subject(id), unavailable: true }]);
        issueRequest(state, "old", 10);
        issueRequest(state, "new", 20);
        expect(commitNonViewAnswer(state, "old", 1, "noop")).toBe("superseded_request");
        expect(commitNonViewAnswer(state, "new", 20, "wait")).toBe("late");
        expect(state.after_ordinal).toBe(0);
        expect(commitNonViewAnswer(state, "new", 19, "noop")).toBeUndefined();
        acknowledgeStatus(state, new Set(["A"]));
        expect(state.after_ordinal).toBe(1);
        expect(commitNonViewAnswer(state, "new", 19, "noop")).toBe("superseded_request");
    });

    test("foreign history is never spliced into a non-empty record", () => {
        const state = record();
        pass(state, [incoming("A")]);
        pass(state, [incoming("foreign")]);
        expect(state.pipeline_exit?.reason).toBe("provider_foreign_history");
        expect(state.ids.has("foreign")).toBe(false);
    });
});

describe("status sizing and per-page fence regressions", () => {
    // Independent envelope: reserve continuation and the longest legal numeric fields.
    function boundaryText(extra = 0): string {
        const request = {
            method: "compaction.step",
            params: {
                ...control,
                lineage_id: "L",
                served_through_ordinal: Number.MAX_SAFE_INTEGER,
                after_ordinal: Number.MAX_SAFE_INTEGER,
                more: true,
                messages: [
                    {
                        ordinal: 1,
                        mid: "A",
                        message: { id: "A", text: "", untouched: { signature: "signed" } },
                    },
                ],
            },
        };
        return "x".repeat(
            MAX_REQUEST_BYTES - Buffer.byteLength(JSON.stringify(request), "utf8") + extra,
        );
    }

    test("two worst-envelope cap entries fit continuation and final requests with fresh fences", () => {
        const state = record();
        const text = boundaryText();
        const scan = scanWindow(state, [incoming("A", text), incoming("B", text)]);
        const admissions = scan.appends.map((candidate) => {
            const admitted = admit(state, candidate, control);
            if ("exit" in admitted) throw new Error(admitted.exit);
            const worst = {
                ...control,
                served_through_ordinal: Number.MAX_SAFE_INTEGER,
                after_ordinal: Number.MAX_SAFE_INTEGER,
                more: true,
            };
            expect(
                encodedBytes(
                    encodeStatusRequest(worst, [
                        { id: candidate.id, ordinal: candidate.ordinal, ingest: admitted.ingest },
                    ]),
                ),
            ).toBe(MAX_REQUEST_BYTES);
            return finishEntry(
                candidate,
                admitted,
                [{ subject: subject(candidate.id), unavailable: true }],
                functions,
            );
        });
        commitEntries(state, admissions);
        const pages = statusPages(state, control);
        expect(pages).toHaveLength(2);
        expect(state.issued).toBeUndefined();
        expect(pages.map((page) => page.control.request_id)).toEqual([undefined, undefined]);
        const requests = pages.map((page, index) => {
            issueRequest(state, String(index + 1), 100);
            const encoded = encodeStatusPage(state, page);
            expect(encodedBytes(encoded)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
            expect(
                commitNonViewAnswer(state, String(index + 1), 1, index === 0 ? "wait" : "noop"),
            ).toBeUndefined();
            acknowledgeStatus(state, new Set(page.messages.map((entry) => entry.id)));
            return JSON.parse(encoded).params;
        });
        expect(requests.map((request) => request.request_id)).toEqual(["1", "2"]);
        expect(requests.map((request) => request.after_ordinal)).toEqual([0, 1]);
        expect(requests[0].more).toBe(true);
        expect(requests[1].more).toBeUndefined();
        expect(
            requests.flatMap((request) =>
                request.messages.map((entry: { mid: string }) => entry.mid),
            ),
        ).toEqual(["A", "B"]);
        expect(state.after_ordinal).toBe(2);
    });

    test("one byte over worst-envelope cap exits durably before any append", () => {
        const state = record();
        const candidate = scanWindow(state, [incoming("A", boundaryText(1))]).appends[0];
        const admitted = admit(state, candidate, { ...control, after_ordinal: 0, more: false });
        expect("exit" in admitted).toBe(true);
        if (!("exit" in admitted)) throw new Error("Oversize admission unexpectedly accepted");
        expect(admitted.exit).toBe("provider_message_too_large");
        // The adapter persists the returned exit before this record-side commit.
        expect(commitExit(state, admitted.exit)).toBe(true);
        expect(state.entries).toEqual([]);
        expect(state.ids.size).toBe(0);
        expect(() => assemble(state)).toThrow("provider_message_too_large");
    });

    test("core derives page lineage and watermark instead of trusting incomplete request control", () => {
        const state = record();
        pass(state, [incoming("A"), incoming("B")]);
        const pages = statusPages(state, {
            ...control,
            lineage_id: "caller-stale",
            served_through_ordinal: 0,
        });
        issueRequest(state, "1", 100);
        const request = JSON.parse(encodeStatusPage(state, pages[0])).params;
        expect(request.lineage_id).toBe("L");
        expect(request.served_through_ordinal).toBe(2);
        expect(request.after_ordinal).toBe(2);
        expect(request.messages).toEqual([]);
    });

    test("encoding requires one fresh persisted fence per page and respects its id budget", () => {
        const state = record();
        pass(
            state,
            ["A", "B", "C"].map((id) => incoming(id, "é".repeat(600000))),
            (id) => [{ subject: subject(id), unavailable: true }],
        );
        const pages = statusPages(state, control);
        expect(() => encodeStatusPage(state, pages[0])).toThrow("fresh durable request fence");
        issueRequest(state, "1", 100);
        const first = encodeStatusPage(state, pages[0]);
        expect(JSON.parse(first).params.request_id).toBe("1");
        expect(() => encodeStatusPage(state, pages[1])).toThrow("fresh durable request fence");
        issueRequest(state, "too-long", 100);
        expect(() => encodeStatusPage(state, pages[1])).toThrow("planned byte budget");
        issueRequest(state, "2", 100);
        expect(JSON.parse(encodeStatusPage(state, pages[1])).params.request_id).toBe("2");
    });

    test("descent invalidates planned pages even when a new fence is issued", () => {
        const state = record();
        pass(state, [incoming("A")]);
        const page = statusPages(state, control)[0];
        descendModuleAhead(state, "descendant");
        issueRequest(state, "1", 100);
        expect(() => encodeStatusPage(state, page)).toThrow("fresh durable request fence");
    });
});
