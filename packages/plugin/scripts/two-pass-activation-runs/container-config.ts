import { assertSpawnBoundary, validateGrant, type GrantRequest } from "./credential-protocol";
import type { HostLane } from "./host-adapters";
import type { Profile } from "../two-pass-live-replay/artifact-schema";

export interface ContainerJob {
    id?: string;
    status?: "ready" | "unresolved";
    unresolvedReason?: string;
    priceClass?: "free" | "paid";
    lane: HostLane | "anthropic-cache";
    image: string;
    grant?: GrantRequest;
    providerURL?: string;
    providerId?: string;
    providerPackage?: string;
    piApi?: string;
    modelId: string;
    prompt: string;
    outputCeiling: number;
    magicContext?: Record<string, unknown>;
    cacheSystem?: string;
    cacheTurnTwo?: string;
    tariff?: Profile["tariff"] & { checkedAt?: string };
}
export interface ContainerRunConfig {
    version: 1;
    mock: boolean;
    network?: "none" | "bridge";
    runMs: number;
    grants: GrantRequest[];
    jobs: ContainerJob[];
    excludedJobIds?: string[];
    preparationOnly?: boolean;
}

export function selectedJobs(config: ContainerRunConfig): ContainerJob[] {
    const excluded = config.excludedJobIds ?? [];
    if (new Set(excluded).size !== excluded.length || excluded.some((id) => !config.jobs.some((job) => job.id === id)))
        throw new Error("credential_excluded_job_unknown");
    const ids = config.jobs.map((job) => job.id).filter((id) => id !== undefined);
    if (new Set(ids).size !== ids.length) throw new Error("credential_duplicate_job_id");
    return config.jobs.filter((job) => !job.id || !excluded.includes(job.id));
}

export function validateRunConfig(config: ContainerRunConfig) {
    if (config.version !== 1 || typeof config.mock !== "boolean" || !Number.isSafeInteger(config.runMs) ||
        config.runMs < 1000 || config.runMs > 1_800_000) throw new Error("credential_run_config");
    if (config.mock && config.network !== "none") throw new Error("mock_network_must_be_none");
    if (!config.mock && config.network !== "bridge") throw new Error("paid_network_bridge_required");
    if (!Array.isArray(config.grants)) throw new Error("real_grant_list_required");
    for (const grant of config.grants) validateGrant(grant);
    if (new Set(config.grants.map((grant) => grant.name)).size !== config.grants.length) throw new Error("duplicate_credential_grant");
    if (!config.jobs?.length) throw new Error("credential_jobs_required");
    for (const job of config.jobs) if (job.status === "unresolved" && (!job.id || !job.unresolvedReason?.trim()))
        throw new Error("credential_unresolved_job_reason_required");
    const jobs = selectedJobs(config);
    if (!jobs.length) throw new Error("credential_jobs_required");
    if (!config.grants.length && jobs.some((job) => job.priceClass !== "free")) throw new Error("real_grant_list_required");
    for (const job of jobs) {
        if (job.status === "unresolved") throw new Error("credential_unresolved_jobs");
        if (job.status && !["ready", "unresolved"].includes(job.status)) throw new Error("credential_job_status");
        const free = job.priceClass === "free";
        if (free && (job.grant || job.providerId !== "opencode" || !["opencode-1", "opencode-2"].includes(job.lane)))
            throw new Error("credential_free_route_required");
        if (!free) validateGrant(job.grant!);
        if (job.grant && !config.grants.some((grant) => grant.name === job.grant!.name && grant.kind === job.grant!.kind))
            throw new Error("unlisted_credential_grant");
        if (!["opencode-1", "opencode-2", "omp", "anthropic-cache"].includes(job.lane) ||
            !/^[\w./:@-]+$/.test(job.image) || !job.modelId || !job.prompt ||
            !Number.isSafeInteger(job.outputCeiling) || job.outputCeiling < 1 || job.outputCeiling > 8192)
            throw new Error("credential_job_config");
        if (!config.mock || free) {
            if (!job.tariff || !Number.isFinite(job.tariff.inputUSDPerMillion) || !Number.isFinite(job.tariff.outputUSDPerMillion) ||
                job.tariff.inputUSDPerMillion < 0 || job.tariff.outputUSDPerMillion < 0 || !job.tariff.source?.trim())
                throw new Error("paid_tariff_required");
            if (free ? job.tariff.inputUSDPerMillion !== 0 || job.tariff.outputUSDPerMillion !== 0
                : job.tariff.inputUSDPerMillion === 0 || job.tariff.outputUSDPerMillion === 0)
                throw new Error("paid_tariff_required");
            if (free && job.tariff.checkedAt !== new Date().toISOString().slice(0, 10))
                throw new Error("credential_zero_tariff_fresh_source_required");
        }
        if (!config.mock) {
            if (!job.providerURL) throw new Error("paid_provider_route_required");
            const url = new URL(job.providerURL);
            if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
                throw new Error("paid_provider_route_required");
        }
        if (job.lane === "anthropic-cache" && (job.modelId !== "claude-sonnet-5-5" || !job.cacheSystem || !job.cacheTurnTwo))
            throw new Error("cache_measurement_inputs_required");
    }
    for (const grant of config.grants) if (!config.jobs.some((job) => job.grant?.name === grant.name))
        throw new Error("unused_credential_grant");
    // The credential probe cannot execute corpus schedules or share a ledger across containers.
    if (config.preparationOnly) throw new Error("credential_campaign_driver_required");
}

export function containerArgs(config: ContainerRunConfig, job: ContainerJob, name: string) {
    validateRunConfig(config);
    return ["run", "--rm", "--init", "--name", name, "--cpus", "4", "--memory", "8g", "--pids-limit", "1024",
        "--network", config.mock ? "none" : "bridge", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--tmpfs", "/run/two-pass:rw,nosuid,nodev,mode=0700,size=1g", "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=256m",
        "-i", "--entrypoint", "bun", job.image,
        "/opt/two-pass/packages/plugin/scripts/two-pass-activation-runs/container-child.ts",
        JSON.stringify({ job, mock: config.mock })];
}

export function containerInvocation(config: ContainerRunConfig, job: ContainerJob, name: string, material: string) {
    const argv = containerArgs(config, job, name);
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    if (job.grant) assertSpawnBoundary(argv, env, material);
    else if (material) throw new Error("credential_free_material_refused");
    return { argv, env };
}
