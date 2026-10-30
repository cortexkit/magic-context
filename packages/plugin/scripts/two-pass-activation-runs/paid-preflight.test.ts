import { expect, test } from "bun:test";
import { containerInvocation, selectedJobs, validateRunConfig, type ContainerRunConfig } from "./container-config";
import { readJobHandoff } from "./credential-protocol";
import { launchContainers, materialForJob, type CredentialSource } from "./container-launcher";
import { preparationBlockers, type PreparationConfig } from "./paid-preflight";
import paid from "./paid-credential-run.json";

const today = () => new Date().toISOString().slice(0, 10);
const freeConfig = (): ContainerRunConfig => ({ version: 1, mock: true, network: "none", runMs: 1000, grants: [], jobs: [{
    id: "free", lane: "opencode-1", image: "trusted:mock", providerId: "opencode", modelId: "deepseek-v4.1-flash-free",
    priceClass: "free", prompt: "Synthetic fixture", outputCeiling: 128,
    tariff: { inputUSDPerMillion: 0, outputUSDPerMillion: 0, source: "https://opencode.ai/docs/zen/#pricing", checkedAt: today() },
}] });
const paidConfig = (): ContainerRunConfig => ({ version: 1, mock: false, network: "bridge", runMs: 1000,
    grants: [{ name: "apikey:test", kind: "api_key" }], jobs: [{ id: "paid", lane: "omp", image: "trusted:paid",
        modelId: "example", grant: { name: "apikey:test", kind: "api_key" }, prompt: "Synthetic fixture", outputCeiling: 128,
        providerURL: "https://example.invalid/v1", tariff: { inputUSDPerMillion: 1, outputUSDPerMillion: 2, source: "Fixture paid rate" },
    }] });

test("grant-free jobs validate without grants and never consult the credential source", async () => {
    const config = freeConfig();
    validateRunConfig(config);
    let reads = 0;
    const source: CredentialSource = { async getScoped() { reads++; throw new Error("vault must not open"); }, close() {} };
    expect(await materialForJob(source, config.jobs[0], config.runMs)).toBe("");
    expect(reads).toBe(0);
    const { argv: args } = containerInvocation(config, config.jobs[0], "free-job", "");
    expect(args).not.toContain("-e");
    expect(JSON.parse(args.at(-1)!).job.grant).toBeUndefined();
});

test("grant-free invocation refuses material rather than sending it unbound", () => {
    const config = freeConfig();
    expect(() => containerInvocation(config, config.jobs[0], "free-job", "unexpected-material")).toThrow("credential_free_material_refused");
});

test("grant-free handoff accepts EOF only and erases unexpected bytes", async () => {
    async function* empty() {}
    expect(await readJobHandoff(empty())).toBeUndefined();
    const bytes = Buffer.from("unexpected-material");
    async function* unexpected() { yield bytes; }
    await expect(readJobHandoff(unexpected())).rejects.toThrow("credential_free_handoff_refused");
    expect(bytes.every((value) => value === 0)).toBe(true);
});

test("free jobs reject a dummy grant", () => {
    const config = freeConfig();
    config.jobs[0].grant = { name: "apikey:test", kind: "api_key" };
    config.grants = [config.jobs[0].grant];
    expect(() => validateRunConfig(config)).toThrow("credential_free_route_required");
});

test("zero tariffs require a nonempty cited source", () => {
    const config = freeConfig();
    config.jobs[0].tariff!.source = " ";
    expect(() => validateRunConfig(config)).toThrow("paid_tariff_required");
});

test("zero tariffs require today's checkedAt", () => {
    const config = freeConfig();
    delete config.jobs[0].tariff!.checkedAt;
    expect(() => validateRunConfig(config)).toThrow("credential_zero_tariff_fresh_source_required");
    config.jobs[0].tariff!.checkedAt = "2000-01-01";
    expect(() => validateRunConfig(config)).toThrow("credential_zero_tariff_fresh_source_required");
});

test("a paid job cannot use zero as an unresolved price", () => {
    const config = paidConfig();
    config.jobs[0].tariff!.inputUSDPerMillion = 0;
    expect(() => validateRunConfig(config)).toThrow("paid_tariff_required");
});

test("a non-Zen job cannot opt into grant-free dispatch", () => {
    const config = freeConfig();
    config.jobs[0].providerId = "anthropic";
    expect(() => validateRunConfig(config)).toThrow("credential_free_route_required");
});

test("unresolved jobs refuse before vault or container dispatch", async () => {
    const config = paidConfig();
    config.jobs[0].status = "unresolved";
    config.jobs[0].unresolvedReason = "Missing exact catalog identity";
    let reads = 0;
    const source: CredentialSource = { async getScoped() { reads++; throw new Error("vault must not open"); }, close() {} };
    await expect(launchContainers(config, source, "unused")).rejects.toThrow("credential_unresolved_jobs");
    expect(reads).toBe(0);
});

test("only explicitly excluded ids bypass unresolved rows", () => {
    const config = paidConfig();
    config.jobs.push({ ...config.jobs[0], id: "unresolved", status: "unresolved", unresolvedReason: "Missing tariff" });
    config.excludedJobIds = ["unresolved"];
    validateRunConfig(config);
    expect(selectedJobs(config).map((job) => job.id)).toEqual(["paid"]);
    config.excludedJobIds = ["typo"];
    expect(() => validateRunConfig(config)).toThrow("credential_excluded_job_unknown");
});

test("unresolved rows require a stable id and a nonempty reason even when excluded", () => {
    const config = paidConfig();
    config.jobs[0].status = "unresolved";
    config.excludedJobIds = ["paid"];
    expect(() => validateRunConfig(config)).toThrow("credential_unresolved_job_reason_required");
    config.jobs[0].unresolvedReason = "Missing tariff";
    delete config.jobs[0].id;
    expect(() => validateRunConfig(config)).toThrow("credential_unresolved_job_reason_required");
});

test("duplicate job ids and duplicate exclusions refuse", () => {
    const config = paidConfig();
    config.jobs.push({ ...config.jobs[0] });
    expect(() => validateRunConfig(config)).toThrow("credential_duplicate_job_id");
    config.jobs.pop();
    config.excludedJobIds = ["paid", "paid"];
    expect(() => validateRunConfig(config)).toThrow("credential_excluded_job_unknown");
});

test("preparation plans cannot silently execute credential probes as a campaign", () => {
    const config = paidConfig();
    config.preparationOnly = true;
    expect(() => validateRunConfig(config)).toThrow("credential_campaign_driver_required");
});

test("unknown job status refuses rather than treating the job as ready", () => {
    const config = paidConfig();
    config.jobs[0].status = "paused" as never;
    expect(() => validateRunConfig(config)).toThrow("credential_job_status");
});

test("proposed retry bounds include fresh turn-one retries and per-fact checks", () => {
    expect(paid.campaign.candidateAttemptsPerRunCeiling).toBe(9);
    expect(paid.campaign.maxCheckCallsPerFact).toBe(24);
    expect(120 * (paid.campaign.candidateAttemptsPerRunCeiling + paid.campaign.maxFactsPerRun * paid.campaign.maxCheckCallsPerFact)).toBe(93240);
});

test("preparation preflight lists every unresolved and excluded row honestly", () => {
    const config = paid as unknown as PreparationConfig;
    const blockers = preparationBlockers(config);
    expect(blockers.filter((reason) => config.jobs.some((job) => reason.startsWith(`${job.id}:`))).length).toBe(10);
    expect(blockers.some((reason) => reason.startsWith("omp-muse:"))).toBe(true);
    expect(blockers.some((reason) => reason.startsWith("oc1-sonnet-fallback:"))).toBe(false);
    expect(blockers).toContain("ledger_prior_spend_unreconciled");
    expect(blockers).toContain("real_read_tool_attestation_missing");
    expect(blockers).toContain("fresh_zen_origin_attestation_missing");
    for (const job of config.jobs.filter((job) => job.graderIds)) {
        for (const id of job.graderIds!) expect(config.graders.find((grader) => grader.id === id)!.family).not.toBe(job.family!);
    }
});
