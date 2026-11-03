import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { createHash } from "node:crypto";
import { readJobHandoff, assertNoMaterial, secretForms, type Handoff } from "./credential-protocol";
import type { ContainerJob } from "./container-config";
import { callMeter, redact } from "./activation-driver";
import { hostAdapter } from "./host-adapters";
import { mockProvider } from "./mock-provider";
import { measurementTransport } from "./measurement-transports";
import type { MeasurementRequest } from "./cache-measurement-driver";
import { cacheResult } from "./cache-measurement-driver";
import { buildTurnOneAuthorizationRequest } from "../../src/features/magic-context/memory/turn-two";
import { CampaignLedger, type Profile } from "../two-pass-live-replay/artifact-schema";
import { disposableEnvironment } from "../two-pass-live-replay/host-drivers";

const root = "/run/two-pass/magic-context/credential-auth";
const install = "/opt/two-pass";

function files(path: string, seen = new Set<string>()): string[] {
    if (!existsSync(path)) return [];
    if (lstatSync(path).isSymbolicLink()) {
        const target = realpathSync(path);
        if (target.startsWith(`${install}/`)) return [];
        if (!target.startsWith(`${root}/`)) throw new Error("credential_auth_symlink_refused");
        path = target;
    }
    if (seen.has(path)) return [];
    seen.add(path);
    const stat = lstatSync(path);
    if (!stat.isDirectory()) return [path];
    return readdirSync(path).flatMap((name) => files(join(path, name), seen));
}

function scanAuth(key: string, hostExitConfirmed = true) {
    const authFiles = files(root);
    const logs = authFiles.filter((path) => /log|jsonl/.test(path));
    for (const file of authFiles) assertNoMaterial(logs.includes(file) ? "container_log" : "auth_folder", readFileSync(file), key);
    if ((lstatSync(root).mode & 0o777) !== 0o700) throw new Error("credential_auth_directory_permissions");
    return { path: root, keyAbsentAfterHostExit: hostExitConfirmed, keyAbsentAtScan: true,
        checkedFileCount: authFiles.length, checkedPathManifestSha256: createHash("sha256").update(authFiles.join("\n")).digest("hex"),
        checkedFiles: authFiles.filter((path) => !path.includes("/node_modules/") && !path.includes("/cache/")),
        logsChecked: logs.filter((path) => !path.includes("/node_modules/")), mode: "0700" };
}

export async function runContainerChild(job: ContainerJob, mock: boolean) {
    if (process.platform !== "linux") throw new Error("credential_child_linux_required");
    if (mock && Object.keys(networkInterfaces()).some((name) => name !== "lo")) throw new Error("mock_network_must_be_none");
    process.env.TMPDIR = "/run/two-pass";
    mkdirSync(root, { recursive: true, mode: 0o700 });
    let handoff: Handoff | undefined;
    let host: Awaited<ReturnType<ReturnType<typeof hostAdapter>["start"]>> | undefined;
    let provider: ReturnType<typeof mockProvider> | undefined;
    let key = "";
    let authChecked = false;
    const env = disposableEnvironment(root);
    const ledger = new CampaignLedger();
    const headers: Array<{ expectedHeader: string; matched: boolean; authorizationMatched: boolean; apiKeyMatched: boolean; presentHeaders: string[] }> = [];
    const processes = new Map<number, { pid: number; parentPid: number; variable: string; inherited: boolean; argvClean: boolean }>();
    const observeProcess = (pid: number, variable = "TWO_PASS_PROVIDER_API_KEY", required = false) => {
        assertNoMaterial("host_tree_cmdline", readFileSync(`/proc/${pid}/cmdline`), key);
        const environ = readFileSync(`/proc/${pid}/environ`);
        try {
            const entries = environ.toString().split("\0").filter((entry) => secretForms(key).some((form) => entry.includes(form)));
            if (entries.some((entry) => entry !== `${variable}=${key}`) || (required && entries.length !== 1))
                throw new Error("credential_child_environment_binding");
            const status = readFileSync(`/proc/${pid}/status`, "utf8");
            processes.set(pid, { pid, parentPid: Number(status.match(/^PPid:\s*(\d+)/m)?.[1]), variable, inherited: entries.length === 1, argvClean: true });
        } finally { environ.fill(0); }
    };
    const profile: Profile = { id: "credential-transport", family: "credential-transport", modelRoute: `${job.providerId ?? "mock"}/${job.modelId}`,
        priceClass: job.priceClass ?? "paid", tariff: job.tariff ?? { inputUSDPerMillion: 1, outputUSDPerMillion: 1, source: "Synthetic mock tariff, not provider pricing" },
        configurationSource: "explicit container job", variantSource: "explicit container job",
        entry: buildTurnOneAuthorizationRequest({ lane: job.lane === "anthropic-cache" ? "omp" : job.lane,
            carrier: job.lane === "omp" ? "pi-historian-rpc" : "hidden-completion", provider: job.providerId ?? "mock", modelId: job.modelId,
            variant: null, temperature: null, thinkingLevel: null }, { system: "credential-transport", formatInstruction: "credential-transport", toolSurface: [], checkToolSurface: [] }).requestedIdentity };
    try {
        try { handoff = await readJobHandoff(process.stdin, job.grant); }
        finally { process.stdin.destroy(); }
        if (handoff) { key = handoff.material; handoff.material = ""; }
        assertNoMaterial("reader_environ", readFileSync(`/proc/${process.pid}/environ`), key);
        for (const [name, path] of Object.entries(env)) mkdirSync(name === "OPENCODE_DB" ? join(path, "..") : path, { recursive: true, mode: 0o700 });
        if (existsSync(join(install, "host-sdk"))) cpSync(join(install, "host-sdk"), env.XDG_CONFIG_HOME, { recursive: true });
        let endpoint = job.providerURL;
        if (mock) {
            provider = mockProvider(() => "Mock credential transport acknowledged.", undefined, (observed) => {
                const expectedHeader = job.lane === "anthropic-cache" ? "x-api-key" : "authorization";
                headers.push({ expectedHeader, matched: job.grant ? observed.get(expectedHeader) === (expectedHeader === "authorization" ? `Bearer ${key}` : key)
                    : observed.get("authorization") === "Bearer public" && !observed.has("x-api-key"),
                    authorizationMatched: observed.get("authorization") === `Bearer ${key}`, apiKeyMatched: observed.get("x-api-key") === key,
                    presentHeaders: ["authorization", "x-api-key"].filter((name) => observed.has(name)) });
            });
            endpoint = provider.url;
        }
        if (!endpoint) throw new Error("paid_provider_route_required");
        console.log(JSON.stringify({ credentialBridgeReady: true, lane: job.lane, readerPid: process.pid }));
        // A credential-free acknowledgement releases dispatch only after the Mac's boundary checks.
        const inspectionDeadline = Date.now() + 30_000;
        while (!existsSync("/run/two-pass/inspection-approved")) {
            if (Date.now() >= inspectionDeadline) throw new Error("credential_inspection_not_acknowledged");
            await Bun.sleep(20);
        }
        rmSync("/run/two-pass/inspection-approved");
        let result: unknown;
        let childEnvironment: unknown;
        if (job.lane === "anthropic-cache") {
            if (job.modelId !== "claude-sonnet-5-5") throw new Error("credential_anthropic_model_required");
            if (!mock && endpoint !== "https://api.anthropic.com/v1/messages") throw new Error("credential_anthropic_endpoint_required");
            let activeReservation: number | undefined;
            const session = await measurementTransport({ ...(mock ? { mockAnthropicEndpoint: `${endpoint}/v1/messages` } : {}),
                onProviderAttempt(providerHost) { console.log(JSON.stringify({ providerAttempt: { providerHost, reservation: activeReservation } })); },
            }).openAnthropic({
                root, model: job.modelId, env: { ...env, ANTHROPIC_API_KEY: key },
            });
            observeProcess(session.isolation.proof.pid, "ANTHROPIC_API_KEY", true);
            const request: MeasurementRequest = { model: job.modelId, maxOutputTokens: job.outputCeiling,
                system: job.cacheSystem!, messages: [{ role: "user", content: job.prompt }], tools: [], mode: "best_effort" };
            const meter = callMeter(ledger, profile);
            const send = async (kind: "turn_one" | "turn_two") => {
                const id = meter.beforeSend({ kind, inputTokens: Buffer.byteLength(JSON.stringify(request)),
                    outputCeiling: job.outputCeiling, maxSteps: 1, hostRetries: 2 });
                activeReservation = id;
                const reply = await session.send(request);
                meter.settle(id, reply.steps);
                return reply;
            };
            try {
                const first = await send("turn_one");
                request.messages.push({ role: "assistant", content: first.text }, { role: "user", content: job.cacheTurnTwo! });
                const second = await send("turn_two");
                result = { first, second, cache: cacheResult(first, second), prefixExtended: true };
                childEnvironment = { allowedVariable: "ANTHROPIC_API_KEY", pid: session.isolation.proof.pid, argvClean: true };
            } finally { await session.close(); }
        } else {
            const adapter = hostAdapter(job.lane, { sourceRoot: install, mockProviderURL: endpoint,
                modelId: job.modelId, providerId: job.providerId ?? "mock", providerPackage: job.providerPackage,
                piApi: job.piApi, piAuth: job.grant?.kind === "api_key" ? "apiKey" : "oauth",
                outputCeiling: job.outputCeiling, providerKeyEnv: job.grant ? "TWO_PASS_PROVIDER_API_KEY" : undefined,
                grantFree: !job.grant,
                paidProvider: !mock, foregroundOnly: mock, timeoutMs: 120_000,
                onProviderAttempt(providerHost) { console.log(JSON.stringify({ providerAttempt: { providerHost } })); },
                onProcessObserved: (pid) => observeProcess(pid),
                magicContext: mock ? { enabled: false } : job.magicContext ?? {} });
            const entry = join(install, job.lane === "omp" ? "packages/pi-plugin/dist/index.js" : job.lane === "opencode-2" ? "packages/plugin/dist/v2/server.js" : "packages/plugin/dist/index.js");
            const childEnv = { ...env, ...(job.grant ? { TWO_PASS_PROVIDER_API_KEY: key } : {}) };
            host = await adapter.start({ installRoot: install, pluginEntrypoint: entry, env: childEnv, meter: callMeter(ledger, profile) });
            observeProcess(host.pid, "TWO_PASS_PROVIDER_API_KEY", !!job.grant);
            childEnvironment = { pid: host.pid, allowedVariable: job.grant ? "TWO_PASS_PROVIDER_API_KEY" : null, environContainsKey: !!job.grant, argvClean: true };
            result = await host.runSession(job.prompt);
        }
        if (mock && (!headers.length || headers.some((entry) => !entry.matched))) throw new Error("credential_provider_header_mismatch");
        if (host) { await host.stop(); host = undefined; }
        const authFolder = scanAuth(key);
        authChecked = true;
        console.log(JSON.stringify(redact({ lane: job.lane, mock, headers, childEnvironment, hostProcessTree: [...processes.values()],
            credentialBoundary: "one authorized host process tree", result, ledger: ledger.rows,
            authFolder,
            readerEnvironClean: true, stdinClosed: process.stdin.destroyed }, [key])));
    } catch (error) {
        if (mock) console.log(JSON.stringify(redact({ mockDiagnostic: {
            error: error instanceof Error ? error.message : "child_failure", headers,
            hostLog: existsSync(join(root, "mock-host.log")) ? readFileSync(join(root, "mock-host.log"), "utf8").slice(-12_000) : "",
        } }, [key])));
        throw error;
    } finally {
        try {
            let hostExitConfirmed = !host;
            try { if (host) await host.stop(); hostExitConfirmed = true; }
            finally { if (key && !authChecked) console.log(JSON.stringify({ authFolder: scanAuth(key, hostExitConfirmed), ledger: ledger.rows })); }
        } finally {
            provider?.close();
            if (handoff) handoff.material = "";
            key = "";
            for (const name of readdirSync(root)) rmSync(join(root, name), { force: true, recursive: true });
        }
    }
}

if (import.meta.main) {
    try {
        const { job, mock } = JSON.parse(process.argv[2]);
        await runContainerChild(job, mock);
    } catch (error) {
        const code = error instanceof Error && /^(credential_|mock_network_|paid_)[a-z_]+$/.test(error.message) ? error.message : "credential_child_failed";
        console.error(code); process.exitCode = 1;
    }
}
