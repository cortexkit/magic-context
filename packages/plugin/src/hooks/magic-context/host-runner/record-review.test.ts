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
    commitNonViewAnswer,
    commitScan,
    createRecord,
    descendModuleAhead,
    encodedBytes,
    encodeStatusPage,
    encodeStatusRequest,
    finishEntry,
    type HookAnswer,
    type HookOutcome,
    hydrateEntry,
    type Incoming,
    issueRequest,
    MAX_REQUEST_BYTES,
    type OpFunctions,
    type RunnerRecord,
    rebuildNeeded,
    type Subject,
    scanWindow,
    statusContent,
    statusPages,
} from "./record";

type Message = { id: string; text: string };

const functions: OpFunctions<Message> = {
    current: 1,
    versions: new Map([
        [
            1,
            (message: Message, answers: readonly HookAnswer[]) => ({
                ...message,
                text: `${answers.length ? "§7§ " : ""}${message.text}`,
            }),
        ],
    ]),
};

const control = {
    session: "review",
    harness: "opencode",
    lineage_id: "L",
    request_id: "page-1",
    served_through_ordinal: 0,
    model: "m",
    now: 1,
};

function record(): RunnerRecord<Message> {
    return createRecord({
        lineage_id: "L",
        plan: { on_unavailable: "pass" },
        initial: { compaction_id: "setup", version: 0, range: { from: 0, to: 0 }, replacement: [] },
    });
}

function incoming(id: string, text = id): Incoming<Message> {
    return { id, classify: () => "terminal", read: () => ({ id, text }) };
}

function answered(id: string): HookOutcome[] {
    const subject: Subject = { subject_mid: id, hook: "pre_user" };
    return [{ subject, answer: { subject, ops: [], tags: [7] } }];
}

function unavailable(id: string): HookOutcome[] {
    return [{ subject: { subject_mid: id, hook: "pre_user" }, unavailable: true }];
}

function pass(
    state: RunnerRecord<Message>,
    window: Incoming<Message>[],
    outcomes: (id: string) => HookOutcome[] = answered,
): void {
    const scan = scanWindow(state, window);
    commitScan(state, scan, `${state.lineage_id}-child`);
    if (scan.exit) return;
    const admissions = scan.appends.map((candidate) => {
        const admitted = admit(state, candidate, {
            ...control,
            after_ordinal: state.after_ordinal,
        });
        if ("exit" in admitted) throw new Error(admitted.exit);
        return finishEntry(candidate, admitted, outcomes(candidate.id), functions);
    });
    commitEntries(state, admissions);
}

function view(to: number, version: number, text = "summary"): Compaction<Message> {
    return {
        compaction_id: `view-${version}`,
        version,
        range: { from: 1, to },
        replacement: [{ id: "head", text }],
    };
}

function apply(state: RunnerRecord<Message>, to: number, text = "summary"): void {
    const request = `view-request-${state.view.version + 1}`;
    issueRequest(state, request, 100);
    expect(
        applyCompaction(
            state,
            {
                request_id: request,
                arrived_ms: 1,
                compaction: view(to, state.view.version + 1, text),
            },
            () => true,
        ),
    ).toEqual({ applied: true });
}

/** Independent envelope sizing; ASCII payloads add exactly one byte per character. */
function capSizedText(statusControl: Record<string, unknown>): string {
    const envelope = {
        method: "compaction.step",
        params: {
            ...statusControl,
            messages: [{ ordinal: 1, mid: "A", message: { id: "A", text: "" } }],
        },
    };
    return "x".repeat(MAX_REQUEST_BYTES - Buffer.byteLength(JSON.stringify(envelope), "utf8"));
}

describe("H1 review: status admission and paging boundary defects", () => {
    test("R1 admission counts the paging-owned after_ordinal in the single-entry cap", () => {
        const state = record();
        const text = capSizedText(control);
        const candidate = scanWindow(state, [incoming("A", text)]).appends[0];
        const entry = { id: "A", ordinal: 1, ingest: JSON.stringify({ id: "A", text }) };
        expect(encodedBytes(encodeStatusRequest(control, [entry]))).toBe(MAX_REQUEST_BYTES);
        expect(encodedBytes(encodeStatusRequest({ ...control, after_ordinal: 0 }, [entry]))).toBe(
            MAX_REQUEST_BYTES + 18,
        );

        // statusPages owns after_ordinal and rejects callers that put it in control.
        // Admission with that same control must not accept an unsendable message.
        const admitted = admit(state, candidate, control);
        expect("exit" in admitted).toBe(true);
    });

    test("R2 a cap-sized message either exits at admission or has sendable status pages", () => {
        const state = record();
        const admissionControl = { ...control, after_ordinal: 0 };
        const text = capSizedText(admissionControl);
        const scan = scanWindow(state, [incoming("A", text), incoming("B", text)]);
        const admitted = admit(state, scan.appends[0], admissionControl);
        if ("exit" in admitted) {
            // Reserving the continuation overhead at admission is a safe outcome.
            expect(admitted.exit).toBe("provider_message_too_large");
            return;
        }
        const first = { id: "A", ordinal: 1, ingest: admitted.ingest };
        expect(encodedBytes(encodeStatusRequest(admissionControl, [first]))).toBe(
            MAX_REQUEST_BYTES,
        );
        expect(
            encodedBytes(encodeStatusRequest({ ...admissionControl, more: true }, [first])),
        ).toBe(MAX_REQUEST_BYTES + 12);
        const second = admit(state, scan.appends[1], admissionControl);
        if ("exit" in second) {
            expect(second.exit).toBe("provider_message_too_large");
            return;
        }
        commitEntries(state, [
            finishEntry(scan.appends[0], admitted, unavailable("A"), functions),
            finishEntry(scan.appends[1], second, unavailable("B"), functions),
        ]);

        // Neither message can fit on a continuation page, in either order.
        // Admission must leave a sendable record, not defer failure to a rebuild.
        let pages: string[] = [];
        expect(() => {
            pages = statusPages(state, control).map((page, index) => {
                issueRequest(
                    state,
                    String(index + 1).padStart(control.request_id.length, "0"),
                    100,
                );
                return encodeStatusPage(state, page);
            });
        }).not.toThrow();
        for (const page of pages) expect(encodedBytes(page)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
        expect(
            pages.flatMap((page) =>
                JSON.parse(page).params.messages.map((entry: { mid: string }) => entry.mid),
            ),
        ).toEqual(["A", "B"]);
    });
});

describe("H1 review: passing controls and record-only coverage", () => {
    test("defer ignores changed known content; a middle insertion only appends", () => {
        const state = record();
        pass(state, [incoming("A"), incoming("B"), incoming("C")]);
        const firstBytes = JSON.stringify(assemble(state));
        const known = (id: string): Incoming<Message> => ({
            id,
            classify: () => {
                throw new Error("Known message classification was read");
            },
            read: () => {
                throw new Error("Known message content was read");
            },
        });
        for (const entry of state.entries) {
            Object.defineProperty(entry.served, "toJSON", {
                value: () => {
                    throw new Error("Known served message was serialized by the record");
                },
                configurable: true,
            });
        }
        const before = assemble(state);
        pass(state, [known("A"), incoming("X"), known("B"), known("C")]);
        pass(state, [known("A"), known("X"), known("B"), known("C")]);
        expect(assemble(state).map((message) => message.id)).toEqual(["A", "B", "C", "X"]);
        for (let i = 0; i < before.length; i++) expect(assemble(state)[i]).toBe(before[i]);
        expect(state.ordinal_divergence).toBe(1);
        expect(state.lineage_id).toBe("L");
        expect(rebuildNeeded(state, { appended_tokens: 0 })).toBe(false);
        // The test's byte oracle is outside the runner, after the serialization tripwires.
        for (const entry of state.entries)
            delete (entry.served as Message & { toJSON?: unknown }).toJSON;
        expect(JSON.stringify(assemble(state).slice(0, 3))).toBe(firstBytes);
    });

    test("one-turn and multi-turn raw reverts keep the surviving first-serve bytes", () => {
        for (const through of [5, 2]) {
            const state = record();
            pass(
                state,
                ["A", "B", "C", "D", "E", "F"].map((id) => incoming(id)),
            );
            const prefix = assemble(state).slice(0, through);
            pass(
                state,
                ["A", "B", "C", "D", "E"].slice(0, through).map((id) => incoming(id, "edited")),
            );
            expect(assemble(state)).toEqual(prefix);
            expect(state.served_through_ordinal).toBe(through);
            expect(state.descends_from).toEqual({ lineage_id: "L", through_ordinal: through });
            expect(state.view.state).toBe("applied");
            pass(state, [...prefix.map((message) => incoming(message.id)), incoming("new")]);
            expect(assemble(state).slice(0, through)).toEqual(prefix);
            expect(state.ids.get("new")).toBe(through + 1);
        }
    });

    test("an interior hole remains served; an ambiguous race suffix exits", () => {
        const state = record();
        pass(
            state,
            ["A", "B", "C", "D"].map((id) => incoming(id)),
        );
        const first = assemble(state);
        pass(
            state,
            ["A", "X", "C", "D", "E"].map((id) => incoming(id)),
        );
        pass(
            state,
            ["A", "X", "C", "D", "E", "F"].map((id) => incoming(id)),
        );
        expect(assemble(state).slice(0, 4)).toEqual(first);
        expect(state.counters.holes).toBe(1);
        expect(state.pipeline_exit).toBeUndefined();
        const ambiguous = record();
        pass(
            ambiguous,
            ["A", "B", "C"].map((id) => incoming(id)),
        );
        pass(
            ambiguous,
            ["A", "X", "B", "C"].map((id) => incoming(id)),
        );
        pass(
            ambiguous,
            ["A", "X", "B"].map((id) => incoming(id)),
        );
        expect(ambiguous.pipeline_exit?.reason).toBe("provider_revert_ambiguous");
        expect(() => assemble(ambiguous)).toThrow("provider_revert_ambiguous");
    });

    test("execute and fold replace only via one accepted view, then defer stays frozen", () => {
        const state = record();
        pass(
            state,
            ["A", "B", "C"].map((id) => incoming(id)),
        );
        const c = state.entries[2].served;
        apply(state, 3, "execute-head");
        expect(assemble(state)).toEqual([{ id: "head", text: "execute-head" }, c]);
        const executeBytes = JSON.stringify(assemble(state));
        pass(
            state,
            ["A", "B", "C"].map((id) => incoming(id, "edited")),
        );
        expect(JSON.stringify(assemble(state))).toBe(executeBytes);
        expect(
            rebuildNeeded(state, { appended_tokens: 0, prefix_rebuilding: "expired_cache" }),
        ).toBe(true);
        apply(state, 4, "folded-head");
        const foldedBytes = JSON.stringify(assemble(state));
        expect(
            applyCompaction(
                state,
                {
                    request_id: "view-request-2",
                    arrived_ms: 2,
                    compaction: view(4, 3, "second-bust"),
                },
                () => true,
            ),
        ).toEqual({ applied: false, reason: "superseded_request" });
        pass(
            state,
            ["A", "B", "C", "D"].map((id) => incoming(id)),
        );
        expect(JSON.stringify(assemble(state).slice(0, 1))).toBe(foldedBytes);
    });

    test("restart after all raw entries were pruned detects a covered revert and refuses noop", () => {
        const state = record();
        pass(
            state,
            ["A", "B", "C", "D"].map((id) => incoming(id)),
        );
        apply(state, 5);
        const durable = JSON.parse(
            JSON.stringify({
                ...state,
                ids: [...state.ids],
                elided: [...state.elided],
                hole_ids: [...state.hole_ids],
            }),
        );
        const restarted: RunnerRecord<Message> = {
            ...durable,
            ids: new Map(durable.ids),
            elided: new Set(durable.elided),
            hole_ids: new Set(durable.hole_ids),
        };
        pass(restarted, [incoming("A"), incoming("B")]);
        expect(restarted.entries).toEqual([]);
        expect(restarted.ids.has("D")).toBe(false);
        expect(restarted.ancestry).toHaveLength(1);
        expect(restarted.view.state).toBe("invalidated");
        issueRequest(restarted, "revert-noop", 100);
        expect(commitNonViewAnswer(restarted, "revert-noop", 1, "noop")).toBeUndefined();
        expect(() => assemble(restarted)).toThrow("invalidated");
        expect(rebuildNeeded(restarted, { appended_tokens: 0 })).toBe(true);
        apply(restarted, 3, "surviving-head");
        expect(assemble(restarted)).toEqual([{ id: "head", text: "surviving-head" }]);
    });

    test("staged hooks cannot serve or advance the watermark before the durable append", () => {
        const state = record();
        pass(state, [incoming("A")]);
        const committedBytes = JSON.stringify(assemble(state));
        const scan = scanWindow(state, [incoming("A"), incoming("X"), incoming("Y")]);
        const candidate = scan.appends[0];
        const admitted = admit(state, candidate, control);
        if ("exit" in admitted) throw new Error(admitted.exit);
        const stranded = finishEntry(candidate, admitted, answered("X"), functions);
        expect("entry" in stranded).toBe(true);
        expect(JSON.stringify(assemble(state))).toBe(committedBytes);
        expect(state.served_through_ordinal).toBe(1);
        expect(state.ids.has("X")).toBe(false);
        descendModuleAhead(state, "retry");
        expect(state.served_through_ordinal).toBe(1);
        expect(state.descends_from).toEqual({ lineage_id: "L", through_ordinal: 1 });
        pass(state, [incoming("A"), incoming("Z"), incoming("X"), incoming("Y")]);
        expect([...state.ids.values()]).toEqual([1, 2, 3, 4]);
        expect(assemble(state).map((message) => message.id)).toEqual(["A", "Z", "X", "Y"]);
    });

    test("partial failure and restart retain raw bytes, even after a durable status resend", () => {
        const state = record();
        const assistant: Subject = { subject_mid: "A", hook: "post_assistant" };
        const p1: Subject = { subject_mid: "A", hook: "post_tool", subject_part: "p1" };
        const p2: Subject = { subject_mid: "A", hook: "post_tool", subject_part: "p2" };
        pass(state, [incoming("A")], () => [
            { subject: assistant, answer: { subject: assistant, ops: [], tags: [7] } },
            { subject: p1, answer: { subject: p1, ops: [], tags: [8] } },
            { subject: p2, unavailable: true },
        ]);
        const rawBytes = JSON.stringify(assemble(state));
        expect(rawBytes).toBe('[{"id":"A","text":"A"}]');
        expect(state.unserved_subjects).toEqual([assistant, p1, p2]);
        const { served: _served, ...durable } = state.entries[0];
        state.entries = [hydrateEntry(JSON.parse(JSON.stringify(durable)), functions).entry];
        expect(JSON.stringify(assemble(state))).toBe(rawBytes);
        issueRequest(state, "resend", 10);
        expect(commitNonViewAnswer(state, "resend", 1, "noop")).toBeUndefined();
        acknowledgeStatus(state, new Set(["A"]));
        acknowledgeUnserved(state, [p1]);
        expect(state.unserved_subjects).toEqual([assistant, p2]);
        acknowledgeUnserved(state, [assistant, p2]);
        expect(statusContent(state)).toEqual({ after_ordinal: 1, messages: [] });
        expect(JSON.stringify(assemble(state))).toBe(rawBytes);
        const { served: _resent, ...resentDurable } = state.entries[0];
        expect(JSON.stringify(hydrateEntry(resentDurable, functions).entry.served)).toBe(
            state.entries[0].ingest,
        );
    });

    test("ordinary-sized pages cap bytes and mark only continuation pages with more", () => {
        const state = record();
        pass(
            state,
            ["A", "B", "C"].map((id) => incoming(id, "é".repeat(600000))),
            unavailable,
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
        expect(decoded.map((page) => page.after_ordinal)).toEqual([0, 2]);
        expect(
            decoded.flatMap((page) => page.messages.map((entry: { mid: string }) => entry.mid)),
        ).toEqual(["A", "B", "C"]);
        expect(decoded[0].messages[0].message.text).toBe("é".repeat(600000));
    });

    test("exit survives restart and only a deliberately new record can switch back", () => {
        for (const race of [false, true]) {
            const state = record();
            pass(state, [incoming("A"), incoming("B")]);
            if (race) pass(state, [incoming("A"), incoming("X"), incoming("B")]);
            const bytes = JSON.stringify(assemble(state));
            expect(commitExit(state, "provider_history_lost")).toBe(true);
            const restarted = { ...state, pipeline_exit: { ...state.pipeline_exit! } };
            expect(commitExit(restarted, "provider_foreign_history")).toBe(false);
            expect(restarted.pipeline_exit?.reseed_full_request).toBe(race);
            expect(() => assemble(restarted)).toThrow("provider_history_lost");
            expect(scanWindow(restarted, [incoming("A"), incoming("new")]).exit).toBe(
                "provider_history_lost",
            );
            expect(
                JSON.stringify([
                    ...restarted.view.replacement,
                    ...restarted.entries.map((entry) => entry.served),
                ]),
            ).toBe(bytes);
            const switched = record();
            pass(switched, [incoming("A"), incoming("B")]);
            expect(switched.pipeline_exit).toBeUndefined();
            expect(assemble(switched).map((message) => message.id)).toEqual(["A", "B"]);
        }
    });
});
