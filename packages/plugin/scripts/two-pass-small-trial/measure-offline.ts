import { readFileSync } from "node:fs";
import {
    shouldDiscardLastHistorianCompartment,
    validateHistorianOutput,
} from "../../src/hooks/magic-context/compartment-runner-validation";
import configJSON from "./deepseek.json";
import { requestHash, turnOne, turnTwo } from "./prompts";
import { type Config, loadCases } from "./run";

// Offline reconstruction must never fall through to a provider or embedder.
const refuseNetwork = () => {
    throw new Error("offline_measurement_network_forbidden");
};
globalThis.fetch = Object.assign(refuseNetwork, { preconnect: refuseNetwork });

const artifact = JSON.parse(
    readFileSync(
        process.argv[2] ??
            ".cortexkit/internal-docs/investigations/two-pass-small-trial/paid-run-001/run.json",
        "utf8",
    ),
) as {
    cases: Array<{
        caseId: number;
        firstReply: string;
        firstRequestHash: string;
        secondRequestHash: string;
        deferredFacts: number;
    }>;
};
const config = configJSON as Config;
const { selected } = loadCases(config);
const rows = [];
for (const c of selected) {
    const recorded = artifact.cases.find((row) => row.caseId === c.id);
    if (!recorded) throw new Error(`missing_recorded_case:${c.id}`);
    const first = turnOne(c);
    if (requestHash(first) !== recorded.firstRequestHash)
        throw new Error(`turn_one_bytes_changed:${c.id}`);
    const second = await turnTwo(c, first, recorded.firstReply);
    if (
        JSON.stringify(second.request.messages.slice(0, 3)) !==
        JSON.stringify([...first.messages, { role: "assistant", content: recorded.firstReply }])
    )
        throw new Error(`prefix_changed:${c.id}`);
    if (
        process.env.BASELINE === "1" &&
        (requestHash(second.request) !== recorded.secondRequestHash ||
            second.deferredFacts !== recorded.deferredFacts)
    )
        throw new Error(`baseline_mismatch:${c.id}`);
    const last = c.blocks.at(-1)!;
    const validation = validateHistorianOutput(
        second.summary,
        c.source.sessionId,
        { startIndex: c.blocks[0]!.startOrdinal, endIndex: last.endOrdinal, lines: c.lines },
        [],
        0,
    );
    if (!validation.ok) throw new Error(`invalid_recorded_summary:${c.id}`);
    const originalFacts = validation.facts ?? [];
    const published = shouldDiscardLastHistorianCompartment(validation.compartments, {
        endIndex: last.endOrdinal,
    })
        ? validation.compartments.slice(0, -1)
        : validation.compartments;
    const publishedStart = Math.min(...published.map((range) => range.startMessage));
    const publishedEnd = Math.max(...published.map((range) => range.endMessage));
    const prompt = second.request.messages.at(-1)!.content;
    rows.push({
        caseId: c.id,
        offeredIds: second.facts.map((f) => f.factId),
        offeredOriginalBullets: second.facts.map(
            (f) => originalFacts.findIndex((original) => original.content === f.content) + 1,
        ),
        publishedCount: second.facts.length + second.deferredFacts,
        publishedRanges: published.map(({ startMessage, endMessage }) => ({
            startMessage,
            endMessage,
        })),
        factAnchors: originalFacts.map((fact, index) => {
            const start = fact.anchor?.startOrdinal;
            const end = fact.anchor?.endOrdinal;
            let rangeCoverage = "unanchored";
            if (start !== undefined && end !== undefined) {
                if (Math.min(start, end) < publishedStart || Math.max(start, end) > publishedEnd)
                    rangeCoverage = "unpublished";
                else if (
                    published.some(
                        (range) => start >= range.startMessage && end <= range.endMessage,
                    )
                )
                    rangeCoverage = "single-published";
                else rangeCoverage = "cross-published";
            }
            return {
                originalBullet: index + 1,
                compartmentIndex: fact.anchor?.compartmentIndex,
                startOrdinal: start,
                endOrdinal: end,
                rangeCoverage,
            };
        }),
        deferredFacts: second.deferredFacts,
        promptUnits: prompt.length,
        promptBytes: Buffer.byteLength(prompt),
        firstRequestHash: requestHash(first),
        secondRequestHash: requestHash(second.request),
        prefixIdentical: true,
    });
}
console.log(JSON.stringify({ bun: Bun.version, network: "forbidden", cap: 160000, rows }, null, 2));
