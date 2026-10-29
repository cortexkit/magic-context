import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildTurnOneAuthorizationRequest } from "../../src/features/magic-context/memory/turn-two";
import { HISTORIAN_FORMAT_INSTRUCTION } from "../../src/features/magic-context/memory/turn-one-publication";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";
import { historianSystemPrompt, HISTORIAN_FACT_ANCHOR_INSTRUCTION } from "../../src/hooks/magic-context/compartment-prompt";
import { parseCompartmentOutput } from "../../src/hooks/magic-context/compartment-parser";
import { estimateTokens, preloadTokenizer, getTokenEstimatorFingerprint } from "../../src/hooks/magic-context/read-session-formatting";
import { preflight, readCorpus, schedule, hash, type Profile, type RunArtifact, type Reviewer } from "../two-pass-live-replay/artifact-schema";
import { gradeInputs, strippedPrompt, GRADER_SYSTEM } from "../two-pass-live-replay/runner";
import { validateRunConfig, selectedJobs, type ContainerRunConfig, type ContainerJob } from "./container-config";

export interface PreparationConfig extends ContainerRunConfig {
    campaign: {
        specimensRoot: string; manifestPath: string; matrixPath: string;
        expectedMatrixHash: string; expectedManifestHash: string; repeats: number;
        maxFactsPerRun: number; maxGraderInputTokens: number; maxCandidateInputTokens: number;
        candidateAttemptsPerRunCeiling: number; graderAttemptsPerTaskCeiling: number;
        maxCheckCallsPerFact: number; maxProviderStepsPerSend: number; hostRetriesPerSend: number;
        outputCeiling: number; graderOutputCeiling: number;
        ledger: { profileCapUSD: number; campaignCapUSD: number; previousSpendUSD: number | null; reconciliationSource: string | null };
        readToolAttestation: unknown; zenOriginAttestation: unknown; driverStatus: string;
    };
    graders: Array<{ id: string; family: string; modelRoute: string; tariff: NonNullable<ContainerJob["tariff"]> }>;
    jobs: Array<ContainerJob & { family?: string; carrier?: Profile["entry"]["carrier"]; modelRoute?: string; graderIds?: string[] }>;
}

const message = (error: unknown) => error instanceof Error ? error.message : "unknown_error";
export function preparationBlockers(config: PreparationConfig): string[] {
    const selected = selectedJobs(config);
    const blockers = selected.filter((job) => job.status === "unresolved").map((job) => `${job.id}: ${job.unresolvedReason || "missing unresolved reason"}`);
    if (config.preparationOnly || config.campaign.driverStatus !== "implemented") blockers.push("campaign_driver_required");
    if (config.campaign.ledger.previousSpendUSD === null || !config.campaign.ledger.reconciliationSource) blockers.push("ledger_prior_spend_unreconciled");
    if (!config.campaign.readToolAttestation) blockers.push("real_read_tool_attestation_missing");
    if (!config.campaign.zenOriginAttestation) blockers.push("fresh_zen_origin_attestation_missing");
    return blockers;
}

/** Static preparation only: imports no credential source and never starts a host or provider. */
export async function preparePaidRun(config: PreparationConfig) {
    const plan = config.campaign;
    if (plan.repeats !== 3 || schedule().length !== 120) throw new Error("campaign_schedule_mismatch");
    const manifestBytes = readFileSync(resolve(plan.specimensRoot, plan.manifestPath), "utf8");
    if (lifecycleTextHash(manifestBytes) !== plan.expectedManifestHash) throw new Error("manifest_hash");
    const corpus = readCorpus(plan.specimensRoot, plan.manifestPath);
    const matrixBytes = readFileSync(plan.matrixPath, "utf8");
    preflight(corpus, matrixBytes, plan.expectedMatrixHash, [], []);
    const profileResults: Array<{ id: string; result: string }> = [];
    for (const job of config.jobs.filter((job) => job.priceClass === "free")) {
        const primary = config.graders.find((grader) => grader.id === job.graderIds?.[0]);
        const identity: Reviewer = { kind: "model", model: primary?.modelRoute ?? "", family: primary?.family ?? "" };
        const profile: Profile = {
            id: job.id!, family: job.family!, modelRoute: job.modelRoute!, priceClass: "free", tariff: job.tariff!,
            configurationSource: "Requested null settings for the planned trial; not an effective host report",
            variantSource: "Requested unset variant for the planned trial; not an effective host report",
            configuredTemperature: null, configuredThinkingLevel: null,
            entry: buildTurnOneAuthorizationRequest({ lane: job.lane as "opencode-1" | "opencode-2", carrier: job.carrier!,
                provider: job.providerId!, modelId: job.modelId, variant: null, temperature: null, thinkingLevel: null },
                { system: historianSystemPrompt(true), formatInstruction: HISTORIAN_FORMAT_INSTRUCTION, toolSurface: [], checkToolSurface: [] }).requestedIdentity,
        };
        try { preflight(corpus, matrixBytes, plan.expectedMatrixHash, [profile], [{ testedFamily: profile.family, grader: identity }]); profileResults.push({ id: job.id!, result: "passed_static_profile_only" }); }
        catch (error) { profileResults.push({ id: job.id!, result: message(error) }); }
    }
    const tokenizerLoaded = await preloadTokenizer();
    const perCase = corpus.cases.map((c) => {
        const parsed = parseCompartmentOutput(c.recordedOutput);
        const enabledPrompt = `${strippedPrompt(c.userPrompt)}\n\n${HISTORIAN_FACT_ANCHOR_INSTRUCTION}\n\n${HISTORIAN_FORMAT_INSTRUCTION}`;
        // Recorded facts/projections are a proxy, not predictions of a future model's decisions.
        const facts = parsed.facts.map((fact, i) => ({ id: i + 1, content: fact.content, state: "resolved", fact_attempts: 1, reason: null }));
        const run: RunArtifact = { runId: `recorded-proxy:${c.id}:0`, profileId: "recorded-proxy", caseId: c.id, repeat: 0,
            sends: [{ kind: "stripped", childId: "recorded-proxy", ledgerId: -1, requestHash: "proxy",
                request: { system: historianSystemPrompt(false), messages: [{ role: "user", content: strippedPrompt(c.userPrompt) }], tools: [], mode: "best_effort" },
                reply: c.recordedOutput, replyHash: lifecycleTextHash(c.recordedOutput) }], retryCandidates: [], turnOneFailures: 0, turnTwoSends: 0, schemaValid: true, facts,
            compartments: [], stages: [], receipts: [], projection: { memories: c.memories, candidates: facts }, projectionHash: hash({ memories: c.memories, candidates: facts }), grades: [] };
        const tasks = gradeInputs(run, c, corpus);
        const gradeTokens = tasks.map((task) => estimateTokens(GRADER_SYSTEM + JSON.stringify({ binding: task.binding, input: task.input })));
        return { caseId: c.id, recordedPromptBytes: Buffer.byteLength(c.userPrompt), recordedPromptTokens: estimateTokens(c.userPrompt),
            enabledFirstInputTokens: estimateTokens(historianSystemPrompt(true) + enabledPrompt),
            strippedInputTokens: estimateTokens(historianSystemPrompt(false) + strippedPrompt(c.userPrompt)),
            recordedOutputTokens: estimateTokens(c.recordedOutput), recordedFacts: facts.length, claims: c.inventory.value.length,
            graderCallsPerRepeat: tasks.length, graderInputTokensPerRepeat: gradeTokens.reduce((a, b) => a + b, 0), maxGraderInputTokens: Math.max(...gradeTokens) };
    });
    const graderCalls = perCase.reduce((n, c) => n + c.graderCallsPerRepeat, 0) * plan.repeats + 1;
    const calibrationCase = corpus.cases.find((c) => c.id === 27)!;
    const calibrationTokens = estimateTokens(GRADER_SYSTEM + JSON.stringify({ binding: { runId: "recorded-proxy", kind: "calibration", key: "27:13",
        inputHash: corpus.calibration.sha256, outputHash: corpus.calibration.value.outputHash },
        input: { case: calibrationCase, recordedOutputHash: corpus.calibration.value.outputHash } }));
    const graderInputTokens = perCase.reduce((n, c) => n + c.graderInputTokensPerRepeat, 0) * plan.repeats + calibrationTokens;
    const graderOutputTokens = graderCalls * plan.graderOutputCeiling;
    const maxGradeTasks = (plan.maxFactsPerRun * 40 + perCase.reduce((n, c) => n + 2 * c.claims, 0) + corpus.controls.length) * plan.repeats + 2;
    const perJob = config.jobs.map((job) => {
        const excluded = config.excludedJobIds?.includes(job.id!) ?? false;
        const cache = job.lane === "anthropic-cache";
        const grader = config.graders.find((g) => g.id === job.graderIds?.[0]);
        const pricedGrading = !excluded && !cache && grader ? (graderInputTokens * grader.tariff.inputUSDPerMillion + graderOutputTokens * grader.tariff.outputUSDPerMillion) / 1e6 : 0;
        const gradingCeiling = !excluded && !cache && grader ? maxGradeTasks * plan.graderAttemptsPerTaskCeiling *
            (plan.maxGraderInputTokens * grader.tariff.inputUSDPerMillion + plan.graderOutputCeiling * grader.tariff.outputUSDPerMillion) / 1e6 : 0;
        const candidateCost = excluded || job.priceClass === "free" ? 0 : null;
        const cacheCeiling = cache ? 6 * (plan.maxCandidateInputTokens * job.tariff!.inputUSDPerMillion + job.outputCeiling * job.tariff!.outputUSDPerMillion) / 1e6 : 0;
        const replayCallsCeiling = 120 * (plan.candidateAttemptsPerRunCeiling + plan.maxFactsPerRun * plan.maxCheckCallsPerFact);
        return { id: job.id, excluded, candidateBaseCalls: excluded ? 0 : cache ? 2 : 360,
            candidateCheckCallsEstimate: excluded || cache ? 0 : null,
            candidateCallsCeiling: excluded ? 0 : cache ? 6 : replayCallsCeiling,
            candidateProviderAttemptCeiling: excluded ? 0 : cache ? 6 : replayCallsCeiling * plan.maxProviderStepsPerSend * (1 + plan.hostRetriesPerSend),
            measuredKnownCandidateInputTokens: excluded || cache ? null : perCase.reduce((n, c) => n + c.enabledFirstInputTokens + c.strippedInputTokens, 0) * plan.repeats,
            futureTurnTwoInputTokens: null,
            graderCalls: excluded || cache ? 0 : graderCalls, graderCallsCeiling: excluded || cache ? 0 : maxGradeTasks * plan.graderAttemptsPerTaskCeiling,
            measuredProxyGraderInputTokens: excluded || cache ? 0 : graderInputTokens,
            candidateEstimateUSD: candidateCost, graderEstimateUSD: pricedGrading,
            pricedSubtotalUSD: pricedGrading, conditionalPricedCeilingUSD: gradingCeiling + cacheCeiling,
            totalEstimateUSD: candidateCost === null ? null : pricedGrading,
            profileCapShortfallUSD: Math.max(0, gradingCeiling + cacheCeiling - plan.ledger.profileCapUSD) };
    });
    let validatorResult = "accepted";
    try { validateRunConfig(config); } catch (error) { validatorResult = message(error); }
    const allowlist = JSON.parse(readFileSync(resolve(import.meta.dir, "../../src/features/magic-context/memory/turn-two-allowlist.json"), "utf8"));
    const pricedSubtotal = perJob.reduce((n, job) => n + job.pricedSubtotalUSD, 0);
    const pricedCeiling = perJob.reduce((n, job) => n + job.conditionalPricedCeilingUSD, 0);
    const blockers = preparationBlockers(config);
    if (profileResults.some((result) => result.result !== "passed_static_profile_only")) blockers.push("native_profile_preflight_failed");
    if (pricedCeiling > plan.ledger.campaignCapUSD) blockers.push("priced_campaign_budget_insufficient");
    return { mode: "mock-static-preflight-no-dispatch", corpus: { cases: corpus.cases.length, claims: perCase.reduce((n, c) => n + c.claims, 0), nativeStructuralPreflight: "passed", manifestHash: plan.expectedManifestHash },
        matrixHash: plan.expectedMatrixHash, nativeProfiles: profileResults,
        allowlist: { shippedEntries: allowlist.entries.length, unchangedEmpty: allowlist.entries.length === 0, selectedCandidateBuilds: "missing" },
        ledger: { ...plan.ledger, reservationUnit: "Existing runtime reserves UTF-8 bytes, not these tokenizer estimates", estimateShortfallAtLeastUSD: Math.max(0, pricedSubtotal - plan.ledger.campaignCapUSD), budgetShortfallAtLeastUSD: Math.max(0, pricedCeiling - plan.ledger.campaignCapUSD) },
        readToolCheck: "unresolved; mock/static checks cannot attest real host tool presence and denied reads", zenOriginCheck: "unresolved; no inference sent",
        tokenizer: { loaded: tokenizerLoaded, fingerprint: getTokenEstimatorFingerprint() },
        estimateAssumptions: { output: "full 4096-token grader allowance, not observed output", futureFacts: "recorded-output proxy; receipts/attempts and candidate projection differ at runtime", calibration: "native case-27 payload, recorded-proxy run id", ceiling: "proposed bounded driver: 32 facts/run, 1M tokens/grader input, 3 HTTP attempts x 2 grader passes; not enforced by credential probes", excluded: config.excludedJobIds },
        perCase, perJob, pricedSubtotalUSD: pricedSubtotal, conditionalPricedCeilingUSD: pricedCeiling,
        overallEstimateUSD: null, overallCeilingUSD: null, unknownCostReason: "Antigravity and ClinePass actual billing, cache measurement prompt sizes, future two-pass/grader payloads and activation auxiliaries are unresolved",
        validatorResult, blockers, ready: blockers.length === 0 && validatorResult === "accepted" };
}

if (import.meta.main) {
    if (process.argv[2] !== "--mock-preflight") throw new Error("mock_preflight_flag_required");
    const config = JSON.parse(readFileSync(process.argv[3], "utf8")) as PreparationConfig;
    const result = await preparePaidRun(config);
    const json = JSON.stringify(result, null, 2);
    if (process.argv[4]) writeFileSync(process.argv[4], json, { mode: 0o600 });
    console.log(json);
    if (!result.ready) process.exitCode = 1;
}
