import "./quiet-live-log";
/**
 * Generate the differential historian OUTPUT VALIDATION golden for the Rust mc-module port.
 *
 * Drives the real TypeScript parser/validator from packages/plugin via Bun.resolveSync,
 * then applies the pure publication-time discard-last rule that currently lives in the
 * incremental runner. The emitted cases contain: raw historian XML, chunk/store metadata,
 * the parsed TS shape normalized to Rust field names, and the publishable validation verdict.
 *
 * Run: bun crates/mc-module/gen/gen-validate-golden.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const resolve = (m: string) => Bun.resolveSync(m, pluginDir);

const parserMod = await import(resolve("./src/hooks/magic-context/compartment-parser"));
const validationMod = await import(resolve("./src/hooks/magic-context/compartment-runner-validation"));

const { parseCompartmentOutput } = parserMod as {
    parseCompartmentOutput: (text: string) => ParsedTs;
};
const { validateHistorianOutput, validateChunkCoverage, validateStoredCompartments } =
    validationMod as {
        validateHistorianOutput: (
            text: string,
            sessionId: string,
            chunk: TsChunk,
            prior: TsStoredRange[],
            sequenceOffset: number,
        ) => TsValidation;
        validateChunkCoverage: (chunk: Pick<TsChunk, "startIndex" | "endIndex" | "lines">) =>
            | string
            | null;
        validateStoredCompartments: (prior: TsStoredRange[]) => string | null;
    };

const BOUNDARY_HEALING_SLACK = 2;

interface ChunkJson {
    start_index: number;
    end_index: number;
    lines: Array<{ ordinal: number; message_id: string }>;
    tool_only_ranges: Array<{ start: number; end: number }>;
}

interface TsChunk {
    startIndex: number;
    endIndex: number;
    lines: Array<{ ordinal: number; messageId: string }>;
    toolOnlyRanges?: ReadonlyArray<{ start: number; end: number }>;
}

interface StoredRangeJson {
    start_message: number;
    end_message: number;
}

interface TsStoredRange {
    startMessage: number;
    endMessage: number;
}

interface ValidateOptionsJson {
    sequence_offset: number;
    in_emergency: boolean;
}

interface ParsedTs {
    compartments: Array<Record<string, unknown>>;
    facts: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
    unprocessedFrom: number | null;
    userObservations: string[];
    primerCandidates: Array<Record<string, unknown>>;
}

type TsValidation =
    | {
          ok: true;
          compartments: Array<Record<string, unknown>>;
          facts: Array<Record<string, unknown>>;
          events?: Array<Record<string, unknown>>;
          userObservations?: string[];
          primerCandidates?: Array<Record<string, unknown>>;
      }
    | { ok: false; error: string };

interface NormalizedCompartment {
    start_message: number;
    end_message: number;
    title: string;
    content: string;
    p1: string | null;
    p2: string | null;
    p3: string | null;
    p4: string | null;
    importance: number | null;
    episode_type: string | null;
}

interface NormalizedValidatedCompartment extends NormalizedCompartment {
    sequence: number;
    start_message_id: string;
    end_message_id: string;
}

interface FactJson {
    category: string;
    content: string;
    origin_compartment_index: number | null;
}

interface EventJson {
    kind: string;
    at_compartment: number | null;
    fields: Record<string, string>;
}

interface PrimerJson {
    question: string;
    origin_compartment_index: number | null;
}

interface UserObservationJson {
    content: string;
    origin_compartment_index: number | null;
}

interface ParsedJson {
    compartments: NormalizedCompartment[];
    facts: FactJson[];
    events: EventJson[];
    unprocessed_from: number | null;
    user_observations: UserObservationJson[];
    primer_candidates: PrimerJson[];
}

interface ValidatedJson {
    compartments: NormalizedValidatedCompartment[];
    facts: FactJson[];
    events: EventJson[];
    primer_candidates: PrimerJson[];
    user_observations: UserObservationJson[];
    unprocessed_from: number;
    discarded_last: boolean;
}

interface VerdictJson {
    ok: boolean;
    error?: string;
    result?: ValidatedJson;
}

type ExpectKind = "accept" | "reject" | "heal" | "discard";

interface CaseSpec {
    label: string;
    text: string;
    chunk: ChunkJson;
    prior_compartments?: StoredRangeJson[];
    options?: Partial<ValidateOptionsJson>;
    expect: ExpectKind;
    healed?: { compartment_index: number; end_message: number };
    expect_discarded_last?: boolean;
}

interface GoldenCase {
    label: string;
    input: {
        text: string;
        chunk: ChunkJson;
        prior_compartments: StoredRangeJson[];
        options: ValidateOptionsJson;
    };
    parsed: ParsedJson;
    validation: VerdictJson;
}

function chunk(
    start: number,
    end: number,
    toolOnlyRanges: Array<{ start: number; end: number }> = [],
): ChunkJson {
    return {
        start_index: start,
        end_index: end,
        lines: Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => {
            const ordinal = start + i;
            return { ordinal, message_id: `msg-${ordinal}` };
        }),
        tool_only_ranges: toolOnlyRanges,
    };
}

function comp(start: number, end: number, title: string): string {
    return `<compartment start="${start}" end="${end}" title="${title}" episode_type="feature" importance="50">
<p1>${title} full &amp; exact</p1>
<p2>${title} short</p2>
<p3>${title}</p3>
<p4 />
</compartment>`;
}

function output(
    compartments: Array<[number, number, string]>,
    unprocessedFrom: number,
    extra = "",
): string {
    return `<output>
<compartments>
${compartments.map(([start, end, title]) => comp(start, end, title)).join("\n")}
</compartments>
${extra}
<meta><messages_processed>${compartments[0]?.[0] ?? 0}-${unprocessedFrom - 1}</messages_processed><unprocessed_from>${unprocessedFrom}</unprocessed_from></meta>
</output>`;
}

function toTsChunk(c: ChunkJson): TsChunk {
    return {
        startIndex: c.start_index,
        endIndex: c.end_index,
        lines: c.lines.map((line) => ({ ordinal: line.ordinal, messageId: line.message_id })),
        toolOnlyRanges: c.tool_only_ranges,
    };
}

function toTsPrior(prior: StoredRangeJson[]): TsStoredRange[] {
    return prior.map((range) => ({
        startMessage: range.start_message,
        endMessage: range.end_message,
    }));
}

function asNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function normalizeCompartment(c: Record<string, unknown>): NormalizedCompartment {
    return {
        start_message: Number(c.startMessage),
        end_message: Number(c.endMessage),
        title: String(c.title ?? ""),
        content: String(c.content ?? ""),
        p1: asString(c.p1),
        p2: asString(c.p2),
        p3: asString(c.p3),
        p4: asString(c.p4),
        importance: asNumber(c.importance),
        episode_type: asString(c.episodeType),
    };
}

function normalizeValidatedCompartment(c: Record<string, unknown>): NormalizedValidatedCompartment {
    return {
        sequence: Number(c.sequence),
        start_message_id: String(c.startMessageId ?? ""),
        end_message_id: String(c.endMessageId ?? ""),
        ...normalizeCompartment(c),
    };
}

function normalizeFact(f: Record<string, unknown>): FactJson {
    return {
        category: String(f.category ?? ""),
        content: String(f.content ?? ""),
        origin_compartment_index: asNumber(f.originCompartmentIndex),
    };
}

function normalizeEvent(e: Record<string, unknown>): EventJson {
    const fields: Record<string, string> = {};
    const rawFields = e.fields && typeof e.fields === "object" ? (e.fields as Record<string, unknown>) : {};
    for (const key of Object.keys(rawFields).sort()) {
        const value = rawFields[key];
        if (typeof value === "string") fields[key] = value;
    }
    return {
        kind: String(e.kind ?? ""),
        at_compartment: asNumber(e.atCompartment),
        fields,
    };
}

function normalizePrimer(p: Record<string, unknown>): PrimerJson {
    return {
        question: String(p.question ?? ""),
        origin_compartment_index: asNumber(p.originCompartmentIndex),
    };
}

function normalizeParsed(parsed: ParsedTs): ParsedJson {
    return {
        compartments: parsed.compartments.map(normalizeCompartment),
        facts: parsed.facts.map(normalizeFact),
        events: parsed.events.map(normalizeEvent),
        unprocessed_from: parsed.unprocessedFrom,
        user_observations: parsed.userObservations.map((content) => ({
            content,
            origin_compartment_index: null,
        })),
        primer_candidates: parsed.primerCandidates.map(normalizePrimer),
    };
}

function keepSideChannel(anchor: number | null, persistedCount: number, discardedLast: boolean): boolean {
    return anchor === null ? !discardedLast : anchor <= persistedCount;
}

function ok(result: ValidatedJson): VerdictJson {
    return { ok: true, result };
}

function fail(error: string): VerdictJson {
    return { ok: false, error };
}

function runTsOracle(spec: CaseSpec, parsedTs: ParsedTs, options: ValidateOptionsJson): VerdictJson {
    const chunkTs = toTsChunk(spec.chunk);
    const prior = spec.prior_compartments ?? [];
    const priorTs = toTsPrior(prior);

    const coverageError = validateChunkCoverage(chunkTs);
    if (coverageError) return fail(`Historian chunk coverage invalid: ${coverageError}`);

    const storedError = validateStoredCompartments(priorTs);
    if (storedError) return fail(`Existing compartments are invalid: ${storedError}`);

    const lastPrior = prior.at(-1);
    if (lastPrior) {
        const expectedStart = lastPrior.end_message + 1;
        if (spec.chunk.start_index !== expectedStart) {
            return fail(
                `Historian chunk starts at raw message ${spec.chunk.start_index} but existing compartments end at ${lastPrior.end_message}; expected next raw message ${expectedStart}`,
            );
        }
    }

    const validation = validateHistorianOutput(
        spec.text,
        "validate-golden",
        chunkTs,
        priorTs,
        options.sequence_offset,
    );
    if (!validation.ok) return fail(validation.error);

    const emitted = validation.compartments.map(normalizeValidatedCompartment);
    let compartments = emitted;
    let discardedLast = false;
    if (!options.in_emergency && emitted.length >= 2) {
        const last = emitted.at(-1)!;
        const lookaheadMargin = spec.chunk.end_index - last.end_message;
        if (lookaheadMargin <= BOUNDARY_HEALING_SLACK) {
            compartments = emitted.slice(0, -1);
            discardedLast = true;
        }
    }

    const offset = lastPrior ? lastPrior.end_message + 1 : spec.chunk.start_index;
    const lastNewEnd = compartments.at(-1)?.end_message ?? 0;
    if (lastNewEnd < offset) return fail(`no forward progress beyond raw message ${offset - 1}`);

    const persistedCount = compartments.length;
    const facts = (validation.facts ?? [])
        .map(normalizeFact)
        .filter((fact) => keepSideChannel(fact.origin_compartment_index, persistedCount, discardedLast));
    const events = (validation.events ?? [])
        .map(normalizeEvent)
        .filter((event) => event.at_compartment === null || event.at_compartment <= persistedCount);
    const primerCandidates = (validation.primerCandidates ?? [])
        .map(normalizePrimer)
        .filter((candidate) =>
            keepSideChannel(candidate.origin_compartment_index, persistedCount, discardedLast),
        )
        .slice(0, 1);
    const userObservations = (validation.userObservations ?? [])
        .map((content) => ({ content, origin_compartment_index: null }))
        .filter((observation) =>
            keepSideChannel(observation.origin_compartment_index, persistedCount, discardedLast),
        );

    // Ensure the parser was genuinely part of the oracle path. This catches cases where a
    // malformed output would otherwise look successful only because the validator result was reused.
    if (parsedTs.compartments.length === 0 && emitted.length > 0) {
        throw new Error(`oracle invariant broken for ${spec.label}: validator emitted unparsed compartments`);
    }

    return ok({
        compartments,
        facts,
        events,
        primer_candidates: primerCandidates,
        user_observations: userObservations,
        unprocessed_from: lastNewEnd + 1,
        discarded_last: discardedLast,
    });
}

const sideChannels = `
<facts>
<PROJECT_RULES>
* Keep generated goldens deterministic.
</PROJECT_RULES>
</facts>
<events>
<causal_incident at_compartment="1"><summary>Kept event.</summary><evidence>raw line</evidence></causal_incident>
<trajectory_correction at_compartment="2"><summary>Second event.</summary><evidence>raw line</evidence></trajectory_correction>
</events>
<user_observations>
* User prefers direct validation failures.
</user_observations>
<primer_candidates>
<primer at_compartment="2">How does historian validation map endpoints?</primer>
</primer_candidates>`;

const discardSideChannels = `
<facts>
<PROJECT_RULES>
* Provisional facts are skipped on discard-last because current facts are unanchored.
</PROJECT_RULES>
</facts>
<events>
<causal_incident at_compartment="1"><summary>Earlier event.</summary></causal_incident>
<trajectory_correction at_compartment="2"><summary>Tail event.</summary></trajectory_correction>
</events>
<user_observations>
* Provisional observations are skipped on discard-last because current observations are unanchored.
</user_observations>
<primer_candidates>
<primer at_compartment="1">How does the kept compartment work?</primer>
<primer at_compartment="2">How does the discarded compartment work?</primer>
</primer_candidates>`;

const cases: CaseSpec[] = [
    {
        label: "clean multi-compartment with side channels",
        text: output(
            [
                [1, 2, "alpha"],
                [3, 4, "beta"],
            ],
            5,
            sideChannels,
        ),
        chunk: chunk(1, 7),
        expect: "accept",
        expect_discarded_last: false,
    },
    {
        label: "overlapping ranges reject",
        text: output(
            [
                [1, 3, "alpha"],
                [3, 4, "beta"],
            ],
            5,
        ),
        chunk: chunk(1, 4),
        expect: "reject",
    },
    {
        label: "large narrative gap rejects",
        text: output(
            [
                [1, 2, "alpha"],
                [19, 22, "beta"],
            ],
            23,
        ),
        chunk: chunk(1, 22),
        expect: "reject",
    },
    {
        label: "twenty-message tool-only gap heals",
        text: output(
            [
                [1, 2, "alpha"],
                [23, 24, "beta"],
            ],
            25,
        ),
        chunk: chunk(1, 24, [{ start: 3, end: 22 }]),
        expect: "heal",
        healed: { compartment_index: 0, end_message: 22 },
    },
    {
        label: "five-message non-tool gap rejects",
        text: output(
            [
                [1, 2, "alpha"],
                [8, 10, "beta"],
            ],
            11,
        ),
        chunk: chunk(1, 10),
        expect: "reject",
    },
    {
        label: "wrong unprocessed_from rejects",
        text: output([[1, 2, "alpha"]], 4),
        chunk: chunk(1, 5),
        expect: "reject",
    },
    {
        label: "chunk coverage rejects missing trailing line",
        text: output([[1, 3, "alpha"]], 4),
        chunk: { ...chunk(1, 3), lines: chunk(1, 3).lines.slice(0, 2) },
        expect: "reject",
    },
    {
        label: "prior store contiguity accepts next raw ordinal",
        text: output([[3, 5, "gamma"]], 6),
        chunk: chunk(3, 5),
        prior_compartments: [{ start_message: 1, end_message: 2 }],
        options: { sequence_offset: 1 },
        expect: "accept",
        expect_discarded_last: false,
    },
    {
        label: "prior store contiguity rejects skipped raw ordinal",
        text: output([[4, 5, "gamma"]], 6),
        chunk: chunk(4, 5),
        prior_compartments: [{ start_message: 1, end_message: 2 }],
        options: { sequence_offset: 1 },
        expect: "reject",
    },
    {
        label: "discard-last fires on weak lookahead and filters anchored tail",
        text: output(
            [
                [1, 2, "alpha"],
                [3, 4, "beta"],
            ],
            5,
            discardSideChannels,
        ),
        chunk: chunk(1, 4),
        expect: "discard",
    },
    {
        label: "discard-last suppressed for k1 progress guard",
        text: output([[1, 4, "single"]], 5),
        chunk: chunk(1, 4),
        expect: "accept",
        expect_discarded_last: false,
    },
    {
        label: "discard-last suppressed in emergency",
        text: output(
            [
                [1, 2, "alpha"],
                [3, 4, "beta"],
            ],
            5,
        ),
        chunk: chunk(1, 4),
        options: { in_emergency: true },
        expect: "accept",
        expect_discarded_last: false,
    },
    {
        label: "primer at_compartment remains 1-based publish index",
        text: output(
            [
                [1, 2, "alpha"],
                [3, 4, "beta"],
            ],
            5,
            `<primer_candidates><primer at_compartment="2">How does beta work?</primer></primer_candidates>`,
        ),
        chunk: chunk(1, 7),
        expect: "accept",
        expect_discarded_last: false,
    },
    {
        label: "events beyond persisted compartment count are filtered",
        text: output(
            [
                [1, 2, "alpha"],
                [3, 4, "beta"],
            ],
            5,
            `<events><causal_incident at_compartment="1"><summary>kept</summary></causal_incident><trajectory_correction at_compartment="3"><summary>dropped</summary></trajectory_correction></events>`,
        ),
        chunk: chunk(1, 7),
        expect: "accept",
        expect_discarded_last: false,
    },
    {
        label: "malformed xml rejects with no usable compartments",
        text: `<output><compartment start="1" end="2" title="bad">missing close`,
        chunk: chunk(1, 2),
        expect: "reject",
    },
    {
        label: "empty output rejects",
        text: "",
        chunk: chunk(1, 2),
        expect: "reject",
    },
];

const golden: GoldenCase[] = cases.map((spec) => {
    const options: ValidateOptionsJson = {
        sequence_offset: spec.options?.sequence_offset ?? 0,
        in_emergency: spec.options?.in_emergency ?? false,
    };
    const parsedTs = parseCompartmentOutput(spec.text);
    const parsed = normalizeParsed(parsedTs);
    const validation = runTsOracle(spec, parsedTs, options);

    if (spec.expect === "reject" && validation.ok) {
        throw new Error(`case '${spec.label}' is labeled reject but TS oracle accepted it`);
    }
    if (spec.expect !== "reject" && !validation.ok) {
        throw new Error(`case '${spec.label}' is labeled ${spec.expect} but TS oracle rejected: ${validation.error}`);
    }
    if (spec.expect === "heal") {
        if (!spec.healed) throw new Error(`heal case '${spec.label}' lacks healed expectation`);
        const before = parsed.compartments[spec.healed.compartment_index]?.end_message;
        const after = validation.result?.compartments[spec.healed.compartment_index]?.end_message;
        if (before === after || after !== spec.healed.end_message) {
            throw new Error(
                `case '${spec.label}' is labeled heal but range did not heal as expected (before=${before}, after=${after})`,
            );
        }
    }
    if (spec.expect === "discard" && validation.result?.discarded_last !== true) {
        throw new Error(`case '${spec.label}' is labeled discard but discard-last did not fire`);
    }
    if (spec.expect_discarded_last !== undefined && validation.result) {
        if (validation.result.discarded_last !== spec.expect_discarded_last) {
            throw new Error(
                `case '${spec.label}' discard mismatch: expected ${spec.expect_discarded_last}, got ${validation.result.discarded_last}`,
            );
        }
    }

    return {
        label: spec.label,
        input: {
            text: spec.text,
            chunk: spec.chunk,
            prior_compartments: spec.prior_compartments ?? [],
            options,
        },
        parsed,
        validation,
    };
});

const rejectCount = golden.filter((c) => !c.validation.ok).length;
const healCount = golden.filter((c) => c.validation.result?.discarded_last === true).length;
if (rejectCount === 0) throw new Error("validate golden has no rejecting cases");
if (healCount === 0) throw new Error("validate golden has no discard-last cases");

const outPath = join(import.meta.dir, "..", "testdata", "validate-golden.json");
writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${golden.length} validate cases (${rejectCount} rejects) → ${outPath}`);
