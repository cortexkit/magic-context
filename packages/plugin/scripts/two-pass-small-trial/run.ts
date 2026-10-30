import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";
import { setLogLineForwarder } from "../../src/shared/logger";
import { fetchForRun, macCredentialSource } from "../two-pass-activation-runs/container-launcher";
import {
    hash,
    preflight,
    type ReplayCase,
    readCorpus,
} from "../two-pass-live-replay/artifact-schema";
import { readRawInput } from "./input";
import { projectOrdinalCoverage } from "./ordinal-coverage";
import { decisionChecks, memoryDrafts, requestHash, turnOne, turnTwo } from "./prompts";
import { DeepSeek, Ledger, logger, type Prices, sanitizer } from "./provider";
import { DOCS, type RunResult, report } from "./report";
import { transcript } from "./transcript";

export interface Config {
    version: 1;
    corpusRoot: string;
    manifestPath: string;
    manifestSHA256: string;
    caseIds: number[];
    repeats: 1;
    grant: { name: "apikey:deepseek"; kind: "api_key" };
    endpoint: "https://api.deepseek.com/chat/completions";
    maxSpendUSD: number;
    peakUSDPerMillion: Prices;
    outputDir: string;
    turnOneThinking?: "disabled" | "enabled";
    turnTwoThinking?: "disabled" | "enabled";
}
export function validateConfig(c: Config) {
    if (
        c.version !== 1 ||
        (c.turnOneThinking !== undefined && !["disabled", "enabled"].includes(c.turnOneThinking)) ||
        (c.turnTwoThinking !== undefined && !["disabled", "enabled"].includes(c.turnTwoThinking)) ||
        c.repeats !== 1 ||
        // Five to ten distinct corpus cases. Case 27 is the known-bad calibration
        // output and is never sent to a provider.
        !Array.isArray(c.caseIds) ||
        c.caseIds.length < 5 ||
        c.caseIds.length > 10 ||
        new Set(c.caseIds).size !== c.caseIds.length ||
        c.caseIds.some((id) => !Number.isInteger(id) || id < 0 || id >= 40 || id === 27) ||
        c.grant?.name !== "apikey:deepseek" ||
        c.grant.kind !== "api_key" ||
        c.endpoint !== "https://api.deepseek.com/chat/completions" ||
        !(c.maxSpendUSD > 0 && c.maxSpendUSD <= 2) ||
        c.peakUSDPerMillion?.hit !== 0.006 ||
        c.peakUSDPerMillion.miss !== 0.3 ||
        c.peakUSDPerMillion.output !== 1.2 ||
        !/^[a-f0-9]{64}$/.test(c.manifestSHA256) ||
        !c.corpusRoot ||
        !c.manifestPath ||
        !c.outputDir.startsWith(".cortexkit/internal-docs/investigations/two-pass-small-trial/") ||
        c.outputDir.split("/").includes("..")
    )
        throw new Error("invalid_trial_config");
}
export function loadCases(c: Config) {
    const manifest = readFileSync(resolve(c.corpusRoot, c.manifestPath), "utf8");
    if (lifecycleTextHash(manifest) !== c.manifestSHA256) throw new Error("manifest_hash");
    const corpus = readCorpus(c.corpusRoot, c.manifestPath);
    const matrix = '{"version":1,"rows":[]}';
    preflight(corpus, matrix, lifecycleTextHash(matrix), [], []);
    return {
        corpus,
        selected: c.caseIds.map((id) => {
            const found = corpus.cases.find((item) => item.id === id);
            if (!found) throw new Error("missing_case");
            return readRawInput(c.corpusRoot, found);
        }),
    };
}
export function selectionReport(
    cases: ReplayCase[],
    selected: ReplayCase[],
    thinking?: Config["turnOneThinking"],
) {
    const sizes = cases.map((c) => Buffer.byteLength(c.userPrompt)).sort((a, b) => a - b);
    const claims = cases.map((c) => c.inventory.value.length).sort((a, b) => a - b);
    const reasons: Record<number, string> = {
        0: "Fewest reviewed claims; lower-middle sent input",
        10: "Largest recorded input; large sent input and 20 claims",
        8: "Joint-maximum reviewed-claim count (32)",
        12: "Required control: worker-question/finished-notice safety",
        35: "Required control: exact memory edit and byte-size thresholds; lower input and claim count",
    };
    return [
        "# Small trial preparation (no provider calls)",
        "",
        DOCS,
        "",
        `Corpus spread: ${cases.length} cases; recorded input bytes ${sizes[0]}–${sizes.at(-1)}; reviewed claims ${claims[0]}–${claims.at(-1)}. Byte sizes include recorded project memory; sent turn-one sizes differ because the production enabled builder removes it and adds anchors.`,
        "",
        "| Case | Recorded UTF-8 bytes | Sent turn-one request UTF-8 bytes | Reviewed claims | Reason | Request SHA256 |",
        "|---|---|---|---|---|---|",
        ...selected.map((c) => {
            const request = turnOne(c, thinking);
            return `| ${c.id} | ${Buffer.byteLength(c.userPrompt)} | ${Buffer.byteLength(JSON.stringify(request))} | ${c.inventory.value.length} | ${reasons[c.id] ?? "Input-size/claim-count spread"} | ${requestHash(request)} |`;
        }),
        "",
        "One repeat, one model, no case 27 (known-bad calibration). No credential is opened by preparation. Corpus remains in corpus-readonly/ and is never copied into internal docs.",
        "",
        "## All-case size and claim-count inventory",
        "",
        "| Case | Recorded UTF-8 bytes | Sent turn-one request UTF-8 bytes | Reviewed claims |",
        "|---|---|---|---|",
        ...cases.map(
            (c) =>
                `| ${c.id} | ${Buffer.byteLength(c.userPrompt)} | ${Buffer.byteLength(JSON.stringify(turnOne(c, thinking)))} | ${c.inventory.value.length} |`,
        ),
        "",
    ].join("\n");
}

export async function runTrial(input: {
    config: Config;
    cases: ReplayCase[];
    mode: "mock" | "live";
    material: string;
    outputDir: string;
    mockEndpoint?: string;
    emit?: (text: string) => void;
    sleep?: (ms: number) => Promise<void>;
}): Promise<RunResult> {
    validateConfig(input.config);
    if (input.mode === "live" && (process.platform !== "darwin" || input.mockEndpoint))
        throw new Error("live_requires_mac_direct_endpoint");
    if (
        input.mode === "mock" &&
        !/^http:\/\/127\.0\.0\.1:\d+\/chat\/completions$/.test(input.mockEndpoint ?? "")
    )
        throw new Error("mock_endpoint_required");
    if (input.cases.map((c) => c.id).join() !== input.config.caseIds.join())
        throw new Error("selected_case_binding");
    mkdirSync(dirname(input.outputDir), { recursive: true, mode: 0o700 });
    mkdirSync(input.outputDir, { mode: 0o700 });
    const clean = sanitizer(input.material);
    const write = (name: string, value: string) => {
        const path = resolve(input.outputDir, name);
        writeFileSync(`${path}.pending`, clean(value), { mode: 0o600 });
        renameSync(`${path}.pending`, path);
    };
    const result: RunResult = {
        mode: input.mode,
        started: new Date().toISOString(),
        cases: [],
        attempts: [],
    };
    const save = () => {
        for (const record of result.cases)
            write(
                `transcript-case-${record.caseId}.md`,
                transcript({
                    ...record,
                    providerReplies: result.attempts
                        .filter((row) => row.caseId === record.caseId && row.raw !== undefined)
                        .map((row) => ({
                            turn: row.turn,
                            attempt: row.attempt,
                            raw: row.raw ?? "",
                        })),
                }),
            );
        write(
            "run.json",
            JSON.stringify(
                {
                    config: input.config,
                    configHash: hash(input.config),
                    ...result,
                    // Keep request evidence without copying private recorded input into the report directory.
                    cases: result.cases.map(({ firstRequest, secondRequest, ...record }) => ({
                        ...record,
                        firstRequestHash: requestHash(firstRequest),
                        firstRequestBytes: Buffer.byteLength(JSON.stringify(firstRequest)),
                        secondRequestHash: secondRequest ? requestHash(secondRequest) : undefined,
                        secondRequestBytes: secondRequest
                            ? Buffer.byteLength(JSON.stringify(secondRequest))
                            : undefined,
                    })),
                },
                null,
                2,
            ),
        );
    };
    const ledger = new Ledger(input.config.maxSpendUSD, input.config.peakUSDPerMillion, save);
    result.attempts = ledger.rows;
    const log = logger(input.material, input.emit ?? ((text) => process.stdout.write(text)));
    setLogLineForwarder((line) => log(line.trimEnd()));
    const client = new DeepSeek({
        endpoint: input.mockEndpoint ?? input.config.endpoint,
        material: input.material,
        ledger,
        save,
        log,
        sleep: input.sleep,
    });
    save();
    try {
        for (const c of input.cases) {
            const record = {
                caseId: c.id,
                firstRequest: turnOne(c, input.config.turnOneThinking),
            } as RunResult["cases"][number];
            result.cases.push(record);
            save();
            try {
                log(`case=${c.id} turn=1 sending`);
                record.firstReply = await client.send(record.firstRequest, c.id, 1);
                save();
                const second = await turnTwo(
                    c,
                    record.firstRequest,
                    record.firstReply,
                    input.config.turnTwoThinking,
                );
                record.summary = second.summary;
                record.secondRequest = second.request;
                record.deferredFacts = second.deferredFacts;
                save();
                log(`case=${c.id} turn=2 sending`);
                record.secondReply = await client.send(second.request, c.id, 2);
                record.checks = decisionChecks(record.secondReply);
                save();
                const diagnostics = { extraFactIds: [] as number[] };
                record.drafts = memoryDrafts(record.secondReply, second.facts, c, diagnostics);
                record.extraFactIds = diagnostics.extraFactIds;
            } catch (error) {
                const message = error instanceof Error ? error.message : "unknown_failure";
                record.failure = /^[a-z][a-z0-9_]+$/.test(message)
                    ? message
                    : "case_processing_failure";
                if (
                    /^(credential_|client_stopped|spend_cap|transport_|usage_|invalid_usage|provider_)/.test(
                        record.failure,
                    )
                ) {
                    result.failure = record.failure;
                    break;
                }
            } finally {
                save();
            }
        }
    } finally {
        result.ended = new Date().toISOString();
        save();
        write("review.md", report(result, input.cases));
        log(
            `finished mode=${result.mode} committedUSD=${ledger.committedUSD.toFixed(8)} failure=${result.failure ?? "none"}`,
        );
        setLogLineForwarder(null);
    }
    return result;
}

async function main() {
    const args = process.argv.slice(2);
    const option = (name: string) => args[args.indexOf(name) + 1];
    if (
        !args.includes("--config") ||
        ["--prepare", "--render", "--mock", "--live"].filter((v) => args.includes(v)).length !== 1
    )
        throw new Error("usage_choose_prepare_render_mock_or_live_and_config");
    const config = JSON.parse(readFileSync(option("--config"), "utf8")) as Config;
    validateConfig(config);
    if (args.includes("--turn-one-thinking")) {
        const thinking = option("--turn-one-thinking");
        if (thinking !== "enabled" && thinking !== "disabled")
            throw new Error("invalid_trial_config");
        config.turnOneThinking = thinking;
    }
    if (args.includes("--turn-two-thinking")) {
        config.turnTwoThinking = option("--turn-two-thinking") as Config["turnTwoThinking"];
        validateConfig(config);
    }
    if (args.includes("--mock")) {
        const { mockCases, mockServer } = await import("./mock");
        const server = mockServer();
        try {
            await runTrial({
                config,
                cases: mockCases(config.caseIds),
                mode: "mock",
                material: "mock-deepseek-key",
                outputDir: `${config.outputDir}-mock`,
                mockEndpoint: server.url,
            });
        } finally {
            server.stop();
        }
        return;
    }
    const { corpus, selected } = loadCases(config);
    if (args.includes("--render")) {
        const dir = ".cortexkit/internal-docs/investigations/two-pass-small-trial/clean-renders";
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const coverage = [];
        for (const c of selected) {
            const firstRequest = turnOne(c, config.turnOneThinking);
            writeFileSync(
                resolve(dir, `transcript-case-${c.id}.md`),
                transcript({ caseId: c.id, firstRequest }),
                { mode: 0o600 },
            );
            const original = corpus.cases.find((item) => item.id === c.id);
            if (!original) throw new Error("missing_case");
            coverage.push({
                ...projectOrdinalCoverage(
                    c.id,
                    original.lines.map((line) => line.ordinal),
                    firstRequest.messages[1].content,
                ),
                requestSHA256: requestHash(firstRequest),
            });
        }
        writeFileSync(resolve(dir, "ordinal-coverage.json"), JSON.stringify(coverage, null, 2), {
            mode: 0o600,
        });
        console.log(`rendered cases=${selected.map((c) => c.id).join(",")} providerCalls=0`);
        return;
    }
    if (args.includes("--prepare")) {
        const dir = ".cortexkit/internal-docs/investigations/two-pass-small-trial";
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(
            resolve(dir, "preparation.md"),
            selectionReport(corpus.cases, selected, config.turnOneThinking),
            {
                mode: 0o600,
            },
        );
        logger("", (text) => process.stdout.write(text))(
            `prepared cases=${selected.map((c) => c.id).join(",")} corpusCases=${corpus.cases.length} providerCalls=0`,
        );
        return;
    }
    if (process.platform !== "darwin") throw new Error("credential_broker_trusted_host_required");
    if (!args.includes("--enrollment")) throw new Error("credential_enrollment_path_required");
    // Validate and build all first requests before opening the vault or spending anything.
    selected.forEach((c) => {
        turnOne(c, config.turnOneThinking);
    });
    const source = await macCredentialSource(option("--enrollment"));
    let material = "";
    try {
        material = await fetchForRun(source, config.grant, 3_600_000);
        const result = await runTrial({
            config,
            cases: selected,
            mode: "live",
            material,
            outputDir: config.outputDir,
        });
        if (result.failure || result.cases.some((c) => c.failure)) process.exitCode = 1;
    } finally {
        material = "";
        await source.close();
    }
}
if (import.meta.main)
    main().catch(() => {
        // Provider/vault exceptions can contain secrets. Detailed safe status is in the run artifact.
        logger("", (text) => process.stderr.write(text))(
            "small_trial_failed; inspect the private review report or validate config/enrollment",
        );
        process.exitCode = 1;
    });
