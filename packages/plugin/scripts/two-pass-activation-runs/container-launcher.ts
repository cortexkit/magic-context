import { spawn, execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { containerInvocation, selectedJobs, validateRunConfig, type ContainerRunConfig } from "./container-config";
import { assertNoMaterial, redactedLines, validateMaterial, type GrantRequest } from "./credential-protocol";

export interface CredentialSource {
    getScoped(request: { credentialId: string; minTtlMs: number }): Promise<{
        material: string; expiresAtMs: number | null; credentialId?: string;
    }>;
    close(): void | Promise<void>;
}

/** Construct only on the trusted Mac. Neither connection nor enrollment crosses the stdin boundary. */
export async function macCredentialSource(enrollmentPath: string): Promise<CredentialSource> {
    if (process.platform !== "darwin") throw new Error("credential_broker_trusted_host_required");
    // The client is ESM-only (its exports declare only "import"), so require() cannot resolve it.
    // Import the e2e-tests package's installed copy directly; the plugin does not depend on it.
    const { ClaustrumClient } = (await import(
        new URL("../../../e2e-tests/node_modules/@cortexkit/claustrum-client/dist/index.js", import.meta.url).href
    )) as typeof import("../../../e2e-tests/node_modules/@cortexkit/claustrum-client");
    let enrollment = JSON.parse(readFileSync(enrollmentPath, "utf8")).token;
    if (typeof enrollment !== "string" || !enrollment) throw new Error("credential_enrollment_required");
    const client = await ClaustrumClient.connect({ logger() {} });
    return {
        getScoped: (request) => client.getScoped({ ...request, enrollmentToken: enrollment }),
        async close() { enrollment = ""; await client.close(); },
    };
}

export async function fetchForRun(source: CredentialSource, grant: GrantRequest, runMs: number) {
    let served: Awaited<ReturnType<CredentialSource["getScoped"]>>;
    try { served = await source.getScoped({ credentialId: grant.name, minTtlMs: runMs + 5000 }); }
    catch { throw new Error("credential_vault_refused"); }
    try {
        // Check the whole response as well as material so a future structured response cannot smuggle a refresh token.
        if (/refresh[_-]?token|"refresh"\s*:/i.test(JSON.stringify(served))) throw new Error("credential_refresh_token_refused");
        if (served.credentialId !== undefined && served.credentialId !== grant.name) throw new Error("credential_grant_mismatch");
        if (grant.kind === "access_token" && (served.expiresAtMs === null || served.expiresAtMs < Date.now() + runMs + 5000))
            throw new Error("credential_ttl_unsatisfied");
        return validateMaterial(served.material);
    } finally { served.material = ""; }
}

export async function materialForJob(source: CredentialSource, job: ContainerRunConfig["jobs"][number], runMs: number) {
    return job.grant ? fetchForRun(source, job.grant, runMs) : "";
}

const docker = async (...args: string[]) => (await promisify(execFile)("docker", args, { maxBuffer: 16 * 1024 * 1024 })).stdout;

export async function launchContainers(config: ContainerRunConfig, source: CredentialSource, output: string) {
    validateRunConfig(config);
    mkdirSync(output, { recursive: true, mode: 0o700 });
    try {
        // Sequential containers also prevent concurrent cache-check workers using the same grant.
        for (const [index, job] of selectedJobs(config).entries()) {
            let material = await materialForJob(source, job, config.runMs);
            const secrets = [material];
            const name = `two-pass-credential-${randomUUID()}`;
            const logs: string[] = [];
            const filter = redactedLines(secrets, (line) => logs.push(line));
            let inspected: Promise<unknown> | undefined;
            let ready = false;
            let failure: string | undefined;
            let scan = "";
            const invocation = containerInvocation(config, job, name, material);
            const child = spawn("docker", invocation.argv, { env: invocation.env, stdio: ["pipe", "pipe", "pipe"] });
            const timer = setTimeout(() => { failure = "credential_container_timeout"; void docker("kill", name).catch(() => {}); }, config.runMs);
            const pending: Promise<void>[] = [];
            const receive = (chunk: Buffer) => {
                try {
                    filter.write(chunk);
                    scan += chunk.toString();
                    if (!ready && scan.includes('"credentialBridgeReady":true')) {
                        ready = true;
                        inspected = inspectBoundary(name, material, config.mock ? "none" : "bridge");
                        // Attach rejection immediately while the host is still running.
                        inspected.catch(() => { failure = "credential_container_inspection_failed"; void docker("kill", name).catch(() => {}); });
                    }
                    scan = scan.slice(-4096);
                } catch { failure = "credential_output_failed"; void docker("kill", name).catch(() => {}); }
            };
            child.stdout.on("data", receive); child.stderr.on("data", receive);
            child.stdin.on("error", () => { failure = "credential_handoff_failed"; });
            let payload = job.grant ? Buffer.from(JSON.stringify({ version: 1, grant: job.grant, material })) : Buffer.alloc(0);
            try {
                console.log(JSON.stringify({ lane: job.lane, grant: job.grant?.name ?? null, network: config.network }));
                const exited = new Promise<number | null>((resolve, reject) => {
                    child.once("error", () => reject(new Error("credential_docker_spawn_failed")));
                    child.once("close", resolve);
                });
                pending.push(new Promise<void>((resolve) => child.stdin.end(payload, () => { payload.fill(0); resolve(); })));
                const status = await exited;
                await Promise.all(pending);
                filter.end();
                const boundary = await inspected;
                if (failure) throw new Error(failure);
                if (!ready || !boundary) throw new Error("credential_inspection_not_observed");
                const retained = logs.join("");
                assertNoMaterial("logs", retained, material);
                const metadata = JSON.stringify(boundary);
                assertNoMaterial("retained_metadata", metadata, material);
                // A --rm container must no longer be inspectable, including on failed runs.
                let removed = false;
                try { await docker("inspect", name); } catch { removed = true; }
                if (!removed) throw new Error("credential_container_retained");
                writeFileSync(join(output, `${index}-${job.lane}.log`), retained, { mode: 0o600 });
                writeFileSync(join(output, `${index}-${job.lane}.json`), JSON.stringify({ boundary, removed, status,
                    mock: config.mock, lane: job.lane, grant: job.grant?.name ?? null, network: config.network }, null, 2), { mode: 0o600 });
                if (status !== 0) {
                    const reason = ["credential_no_credit", "credential_rate_limited"].find((code) => retained.includes(code));
                    throw new Error(reason ?? "credential_container_run_failed");
                }
            } finally {
                clearTimeout(timer);
                child.stdin.destroy();
                if (child.exitCode === null) await docker("kill", name).catch(() => {});
                payload.fill(0); payload = Buffer.alloc(0); material = ""; scan = ""; secrets.fill("");
                console.log(JSON.stringify({ lane: job.lane, grant: job.grant?.name ?? null, credentialRunEnded: true }));
            }
        }
    } finally { await source.close(); }
}

async function inspectBoundary(name: string, material: string, network: string) {
    const raw = await docker("inspect", name);
    assertNoMaterial("inspect", raw, material);
    const [metadata] = JSON.parse(raw);
    if (!metadata.HostConfig.AutoRemove || metadata.HostConfig.NanoCpus !== 4_000_000_000 || metadata.HostConfig.Memory !== 8 * 1024 ** 3 ||
        metadata.Mounts.length || !metadata.HostConfig.ReadonlyRootfs || metadata.HostConfig.PidsLimit !== 1024 ||
        metadata.HostConfig.NetworkMode !== network || !metadata.HostConfig.CapDrop.includes("ALL") ||
        !metadata.HostConfig.SecurityOpt.includes("no-new-privileges") || !metadata.HostConfig.Tmpfs["/run/two-pass"]?.includes("mode=0700"))
        throw new Error("credential_container_boundary_mismatch");
    const proc = await docker("exec", name, "bun", "-e", "const f=require('node:fs'); for(const p of ['/proc/1/cmdline','/proc/1/environ']) process.stdout.write(f.readFileSync(p));");
    assertNoMaterial("init_proc", proc, material);
    const commandLine = await docker("exec", name, "ps", "-eo", "args=");
    assertNoMaterial("container_ps", commandLine, material);
    await docker("exec", name, "bun", "-e", "require('node:fs').writeFileSync('/run/two-pass/inspection-approved','ok',{mode:0o600});");
    return { metadata, initCmdlineAndEnvironClean: true, containerPsClean: true,
        macSpawnArgvAndEnvironmentClean: true, macAttestation: "validated spawn inputs, not process observation" };
}

if (import.meta.main) {
    try {
        const [configPath, output, enrollmentPath] = process.argv.slice(2);
        const config = JSON.parse(readFileSync(configPath, "utf8")) as ContainerRunConfig;
        validateRunConfig(config);
        if (!output) throw new Error("credential_evidence_directory_required");
        const source: CredentialSource = config.mock ? {
            async getScoped() { return { material: `mock-bridge-${randomBytes(24).toString("hex")}`, expiresAtMs: null }; }, close() {},
        } : selectedJobs(config).some((job) => job.grant) ? await macCredentialSource(enrollmentPath) : {
            async getScoped() { throw new Error("credential_free_route_required"); }, close() {},
        };
        await launchContainers(config, source, resolve(output));
    } catch (error) {
        const code = error instanceof Error && /^(credential_|mock_network_|paid_|real_grant_|exact_credential_|cache_measurement_)[a-z_]+$/.test(error.message)
            ? error.message : "credential_launcher_failed";
        console.error(code); process.exitCode = 1;
    }
}
