import { describe, expect, test } from "bun:test";
import { lifecycleTextHash } from "./lifecycle-text";
import counterVectors from "./turn-one-counter-vectors.json";
import identityVectors from "./turn-two-identity-vectors.json";
import {
    canonicalLifecycleJson,
    expandTurnTwoEntry,
    isTurnTwoEntry,
    lifecycleToolHash,
    matchesReportedProfile,
    matchesTurnTwoEntry,
    matchesTurnTwoSelection,
    type TurnOneFailureRow,
    type TurnTwoEntry,
    type TurnTwoTrialAuthorization,
    turnOneFailureCount,
    turnOneFailureProfileHash,
    turnOneFailurePublicationId,
    turnTwoLaneForReport,
} from "./turn-two-profile";

function entry(): TurnTwoEntry {
    return {
        lane: "opencode-1",
        carrier: "hidden-completion",
        provider: "fixture-provider",
        modelId: "fixture/model",
        variant: "qualifier",
        temperature: 0.1,
        thinkingLevel: "low",
        historianSystemHash: lifecycleTextHash("historian"),
        combinedSchemaHash: lifecycleTextHash("combined"),
        historianToolHash: lifecycleToolHash(["read"]),
        checkSystemHashes: {
            disproof: lifecycleTextHash("disproof"),
            support: lifecycleTextHash("support"),
            "kept-clause": lifecycleTextHash("kept-clause"),
            compatibility: lifecycleTextHash("compatibility"),
        },
        checkSchemaHash: lifecycleTextHash("check contract"),
        checkToolHash: lifecycleToolHash([]),
    };
}

describe("turn-two frozen profiles", () => {
    test("one frozen identity expands into historian and four isolated-check rows", () => {
        const candidate = entry();
        const rows = expandTurnTwoEntry(candidate);
        const shared = {
            lane: candidate.lane,
            carrier: candidate.carrier,
            provider: candidate.provider,
            modelId: candidate.modelId,
            variant: candidate.variant,
            temperature: candidate.temperature,
            thinkingLevel: candidate.thinkingLevel,
        };
        expect(rows).toEqual([
            {
                ...shared,
                systemHash: candidate.historianSystemHash,
                schemaHash: candidate.combinedSchemaHash,
                toolHash: candidate.historianToolHash,
            },
            ...["disproof", "support", "kept-clause", "compatibility"].map((kind) => ({
                ...shared,
                systemHash:
                    candidate.checkSystemHashes[kind as keyof typeof candidate.checkSystemHashes],
                schemaHash: candidate.checkSchemaHash,
                toolHash: candidate.checkToolHash,
            })),
        ]);
        for (const row of rows) expect(matchesReportedProfile(row, { ...row })).toBe(true);
        expect(matchesTurnTwoEntry(candidate, candidate)).toBe(true);
    });
    test("malformed frozen identity hashes and inference values fail closed", () => {
        for (const invalid of ["", "abc", "F".repeat(64), null, undefined])
            expect(isTurnTwoEntry({ ...entry(), historianToolHash: invalid })).toBe(false);
        for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, "0.1", undefined])
            expect(isTurnTwoEntry({ ...entry(), temperature: invalid })).toBe(false);
    });
    test("trial authorization carries a full candidate and its attested root", () => {
        const trial: TurnTwoTrialAuthorization = {
            candidate: entry(),
            attestedRoot: "/disposable/magic-context/trial",
        };
        expect(expandTurnTwoEntry(trial.candidate)).toHaveLength(5);
        expect(trial.attestedRoot).toBe("/disposable/magic-context/trial");
    });
    test("requested identity comparison ignores temperature and thinkingLevel including absence", () => {
        const candidate = entry();
        for (const effective of [
            { temperature: 2, thinkingLevel: "high" },
            { temperature: null, thinkingLevel: null },
            {},
        ]) {
            const {
                temperature: _temperature,
                thinkingLevel: _thinkingLevel,
                ...requested
            } = candidate;
            expect(matchesTurnTwoSelection({ ...requested, ...effective }, candidate)).toBe(true);
        }
        expect(matchesTurnTwoEntry({ ...candidate, thinkingLevel: "high" }, candidate)).toBe(false);
        expect(matchesTurnTwoEntry({ ...candidate, temperature: 2 }, candidate)).toBe(false);
    });
});

const substitutions: [string, (value: TurnTwoEntry) => unknown][] = [
    ["lane", (value) => ({ ...value, lane: "opencode-2" })],
    ["carrier", (value) => ({ ...value, carrier: "opencode-session" })],
    ["provider", (value) => ({ ...value, provider: "other-provider" })],
    ["modelId", (value) => ({ ...value, modelId: "other/model-route" })],
    ["variant", (value) => ({ ...value, variant: "other-qualifier" })],
    ["temperature", (value) => ({ ...value, temperature: 0.2 })],
    ["thinkingLevel", (value) => ({ ...value, thinkingLevel: "high" })],
    ...(
        [
            "historianSystemHash",
            "combinedSchemaHash",
            "historianToolHash",
            "checkSchemaHash",
            "checkToolHash",
        ] as const
    ).map((field): [string, (value: TurnTwoEntry) => unknown] => [
        field,
        (value) => ({ ...value, [field]: lifecycleTextHash("substitution") }),
    ]),
    ...(["disproof", "support", "kept-clause", "compatibility"] as const).map(
        (kind): [string, (value: TurnTwoEntry) => unknown] => [
            `checkSystemHashes.${kind}`,
            (value) => ({
                ...value,
                checkSystemHashes: {
                    ...value.checkSystemHashes,
                    [kind]: lifecycleTextHash("substitution"),
                },
            }),
        ],
    ),
];
for (const [field, substitute] of substitutions) {
    test(`substituted ${field} matches nothing`, () => {
        const candidate = entry();
        expect(matchesTurnTwoEntry(candidate, candidate)).toBe(true);
        const changed = substitute(candidate);
        expect(matchesTurnTwoEntry(changed, candidate)).toBe(false);
        expect(matchesTurnTwoEntry(candidate, changed)).toBe(false);
        if (field !== "temperature" && field !== "thinkingLevel")
            expect(matchesTurnTwoSelection(changed, candidate)).toBe(false);
    });
    test(`absent entry ${field} matches nothing`, () => {
        const missing = entry();
        if (field.startsWith("checkSystemHashes.")) {
            delete (missing.checkSystemHashes as Partial<typeof missing.checkSystemHashes>)[
                field.slice("checkSystemHashes.".length) as keyof typeof missing.checkSystemHashes
            ];
        } else {
            delete (missing as unknown as Record<string, unknown>)[field];
        }
        expect(isTurnTwoEntry(missing)).toBe(false);
        expect(matchesTurnTwoEntry(missing, missing)).toBe(false);
        if (field !== "temperature" && field !== "thinkingLevel")
            expect(matchesTurnTwoSelection(missing, entry())).toBe(false);
    });
}

for (const field of [
    "lane",
    "carrier",
    "provider",
    "modelId",
    "variant",
    "temperature",
    "thinkingLevel",
    "systemHash",
    "schemaHash",
    "toolHash",
] as const) {
    test(`absent row ${field} matches nothing even against another absent key`, () => {
        const candidate = expandTurnTwoEntry(entry())[0]!;
        const actual = { ...candidate };
        delete (actual as Partial<typeof actual>)[field];
        expect(matchesReportedProfile(actual, candidate)).toBe(false);
        expect(matchesReportedProfile(actual, actual)).toBe(false);
    });
    test(`substituted row ${field} matches nothing`, () => {
        const candidate = expandTurnTwoEntry(entry())[0]!;
        const changed = {
            ...candidate,
            [field]:
                field === "temperature"
                    ? 0.2
                    : field.endsWith("Hash")
                      ? lifecycleTextHash("substitution")
                      : field === "lane"
                        ? "opencode-2"
                        : field === "carrier"
                          ? "opencode-session"
                          : "other",
        };
        expect(matchesReportedProfile(candidate, candidate)).toBe(true);
        expect(matchesReportedProfile(changed, candidate)).toBe(false);
    });
}

for (const field of ["variant", "temperature", "thinkingLevel"] as const) {
    test(`explicit null ${field} matches only null`, () => {
        const candidate = entry();
        const nullable = { ...candidate, [field]: null };
        expect(matchesTurnTwoEntry(nullable, nullable)).toBe(true);
        expect(matchesTurnTwoEntry(nullable, candidate)).toBe(false);
        expect(matchesTurnTwoEntry(candidate, nullable)).toBe(false);
        const nullRow = expandTurnTwoEntry(nullable)[0]!;
        const row = expandTurnTwoEntry(candidate)[0]!;
        expect(matchesReportedProfile(nullRow, nullRow)).toBe(true);
        expect(matchesReportedProfile(row, nullRow)).toBe(false);
        expect(matchesReportedProfile(nullRow, row)).toBe(false);
        const missing = { ...nullRow };
        delete (missing as Partial<typeof missing>)[field];
        expect(matchesReportedProfile(missing, nullRow)).toBe(false);
    });
}

describe("historian identity and hash vectors", () => {
    for (const vector of identityVectors.runtimeReports) {
        test(`runtime lane: ${vector.name}`, () => {
            expect(turnTwoLaneForReport(vector.report)).toBe(vector.expectedLane);
        });
    }
    for (const carrier of [
        "session-runner:thalamus-harness",
        "session-runner:broca",
        "session-runner:thalamus",
        "broca",
        "host-queue",
        "rust_host",
    ]) {
        test(`ck-mc carrier ${carrier} cannot match a TypeScript host identity even against an equal entry`, () => {
            const candidate = { ...entry(), carrier } as TurnTwoEntry;
            const row = { ...expandTurnTwoEntry(entry())[0]!, carrier };
            expect(matchesReportedProfile(row, row)).toBe(false);
            expect(matchesTurnTwoEntry(candidate, candidate)).toBe(false);
            expect(matchesTurnTwoSelection(candidate, candidate)).toBe(false);
        });
    }
    test("Pi and OMP identities stay distinct in either direction", () => {
        const pi: TurnTwoEntry = { ...entry(), lane: "pi", carrier: "pi-historian-rpc" };
        const omp: TurnTwoEntry = { ...pi, lane: "omp" };
        expect(matchesTurnTwoEntry(pi, pi)).toBe(true);
        expect(matchesTurnTwoEntry(omp, omp)).toBe(true);
        expect(matchesTurnTwoEntry(pi, omp)).toBe(false);
        expect(matchesTurnTwoEntry(omp, pi)).toBe(false);
    });
    test("unsupported lane and carrier pairs match nothing", () => {
        for (const changed of [
            { lane: "unknown" },
            { carrier: "unknown" },
            { lane: "opencode-2", carrier: "opencode-session" },
        ]) {
            const candidate = { ...entry(), ...changed };
            expect(matchesTurnTwoEntry(candidate, candidate)).toBe(false);
        }
    });
    for (const vector of identityVectors.textHashes) {
        test(`text hash ${vector.field}: ${vector.name}`, () => {
            expect(Buffer.byteLength(vector.inputUtf8, "utf8")).toBe(vector.byteLength);
            expect(lifecycleTextHash(vector.inputUtf8)).toBe(vector.sha256);
        });
    }
    for (const vector of identityVectors.toolHashes) {
        test(`tool hash: ${vector.name}`, () => {
            expect(canonicalLifecycleJson(vector.toolSurface)).toBe(vector.inputUtf8);
            expect(Buffer.byteLength(vector.inputUtf8, "utf8")).toBe(vector.byteLength);
            expect(lifecycleToolHash(vector.toolSurface)).toBe(vector.sha256);
        });
    }
    test("canonical JSON preserves array order and sorts even integer-like object keys lexically", () => {
        expect(canonicalLifecycleJson({ 2: "two", 10: "ten", nested: { z: 1, a: [2, 1] } })).toBe(
            '{"10":"ten","2":"two","nested":{"a":[2,1],"z":1}}',
        );
        expect(lifecycleToolHash(["read", "write"])).not.toBe(lifecycleToolHash(["write", "read"]));
        for (const invalid of [
            undefined,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            { missing: undefined },
            new Date(0),
        ])
            expect(() => canonicalLifecycleJson(invalid)).toThrow(TypeError);
    });
});

describe("historian turn-one failure counter vectors", () => {
    test("requested profile hash and publication id use the exact six canonical key fields", () => {
        const profile = counterVectors.requestedProfile as Parameters<
            typeof turnOneFailureProfileHash
        >[0];
        expect(canonicalLifecycleJson(profile)).toBe(counterVectors.profileHashVector.inputUtf8);
        expect(turnOneFailureProfileHash(profile)).toBe(counterVectors.profileHashVector.sha256);
        expect(canonicalLifecycleJson(counterVectors.key)).toBe(
            counterVectors.keyHashVector.inputUtf8,
        );
        expect(lifecycleTextHash(counterVectors.keyHashVector.inputUtf8)).toBe(
            counterVectors.keyHashVector.sha256,
        );
        expect(turnOneFailurePublicationId(counterVectors.key)).toBe(
            counterVectors.keyHashVector.publication_id,
        );
        expect(
            turnOneFailurePublicationId({
                ...counterVectors.key,
                childId: "ignored",
                appendedMessageIds: ["message-002"],
            } as typeof counterVectors.key),
        ).toBe(counterVectors.keyHashVector.publication_id);
    });
    for (const sequence of counterVectors.sequences) {
        test(`counter sequence: ${sequence.name}`, () => {
            const rows: TurnOneFailureRow[] = [];
            const counts: number[] = [];
            for (const { row, expectedCount } of sequence.rows) {
                expect(row.stage).toBe("turn_one");
                expect(row.run_attempt).toBe(
                    1 + Math.max(0, ...rows.map((prior) => prior.run_attempt)),
                );
                expect(row.stage_key).toBe(`${row.publication_id}:${row.run_attempt}`);
                expect(row.session_id).toBe(counterVectors.key.parentSessionId);
                expect(turnOneFailurePublicationId(row.request_json)).toBe(row.publication_id);
                rows.push(row);
                counts.push(turnOneFailureCount(row.publication_id, rows));
                expect(counts.at(-1)).toBe(expectedCount);
            }
            expect(counts).toEqual(sequence.expectedCounts);
            expect(sequence.expectedMemoryPublications).toEqual([]);
            expect(
                turnOneFailureCount(
                    counterVectors.keyHashVector.publication_id,
                    [...rows].reverse(),
                ),
            ).toBe(1);
        });
    }
    test("counter ignores another publication, another stage and unknown sends", () => {
        const row = counterVectors.sequences[0]!.rows[0]!.row;
        expect(
            turnOneFailureCount(row.publication_id, [
                row,
                { ...row, publication_id: "other" },
                { ...row, stage: "turn_two" },
                { ...row, state: "sending" },
            ]),
        ).toBe(1);
    });
});
