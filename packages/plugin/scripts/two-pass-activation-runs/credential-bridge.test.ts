import { expect, test } from "bun:test";
import { assertNoMaterial, assertSpawnBoundary, readHandoff, redactedLines, validateMaterial } from "./credential-protocol";
import { fetchForRun, macCredentialSource, type CredentialSource } from "./container-launcher";
import { containerArgs, containerInvocation, validateRunConfig, type ContainerRunConfig } from "./container-config";
import mockConfig from "./mock-credential-run.json";
import { withCredential } from "./activation-driver";

const grant = { name: "apikey:anthropic:ufukaltinokgmail", kind: "api_key" } as const;
const key = "synthetic-bridge-test-material";
const source = (material = key): CredentialSource => ({ async getScoped() { return { material, expiresAtMs: null }; }, close() {} });

test("stdin handoff reads once, binds the exact grant and erases byte buffers", async () => {
    const bytes = Buffer.from(JSON.stringify({ version: 1, grant, material: key }));
    async function* input() { yield bytes; }
    const handoff = await readHandoff(input(), grant);
    expect(handoff.material === key).toBe(true);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    const wrong = Buffer.from(JSON.stringify({ version: 1, grant: { ...grant, name: "apikey:other" }, material: key }));
    await expect(readHandoff((async function* () { yield wrong; })(), grant)).rejects.toThrow("credential_handoff_binding");
});

test("handoff refuses oversized input and refresh-token-shaped material by name", async () => {
    await expect(readHandoff((async function* () { yield Buffer.alloc(16_385); })(), grant)).rejects.toThrow("credential_handoff_too_large");
    expect(() => validateMaterial('{"access_token":"mock-access","refresh_token":"mock-refresh"}')).toThrow("credential_refresh_token_refused");
});

test("refresh-bearing vault response is refused by name before a container can start", async () => {
    await expect(fetchForRun(source('{"refresh_token":"mock-refresh","access_token":"mock-access"}'), grant, 10_000))
        .rejects.toThrow("credential_refresh_token_refused");
    const response = source();
    response.getScoped = async () => ({ material: key, expiresAtMs: null, refreshToken: "mock-refresh" });
    await expect(fetchForRun(response, grant, 10_000)).rejects.toThrow("credential_refresh_token_refused");
});

test("exact scoped read demands TTL covering the run and fails closed on vault refusal", async () => {
    const calls: unknown[] = [];
    const vault = source();
    vault.getScoped = async (request) => { calls.push(request); return { material: key, expiresAtMs: null, credentialId: grant.name }; };
    expect((await fetchForRun(vault, grant, 10_000)) === key).toBe(true);
    expect(calls).toEqual([{ credentialId: grant.name, minTtlMs: 15_000 }]);
    vault.getScoped = async () => { throw new Error("mock-vault-refusal"); };
    await expect(fetchForRun(vault, grant, 10_000)).rejects.toThrow("credential_vault_refused");
    await expect(fetchForRun(source(), { name: "oauth:mock", kind: "access_token" }, 10_000)).rejects.toThrow("credential_ttl_unsatisfied");
});

test("credential wrapper preserves the no-credit terminal reason and still ends the grant", async () => {
    let ended = 0;
    await expect(withCredential({ async getScoped() { return key; }, async notifyRunEnded() { ended++; } }, grant.name, true,
        async () => { throw new Error("credential_no_credit"); })).rejects.toThrow("credential_no_credit");
    expect(ended).toBe(1);
    await expect(withCredential({ async getScoped() { return key; }, async notifyRunEnded() { throw new Error("mock_cleanup_failure"); } }, grant.name, true,
        async () => { throw new Error("credential_no_credit"); })).rejects.toThrow("credential_no_credit");
});

test("Linux cannot open a Mac credential source even with an enrollment path", async () => {
    await expect(macCredentialSource("/must-not-read-live-enrollment")).rejects.toThrow("credential_broker_trusted_host_required");
});

test("redacted log check catches keys split across writes", () => {
    const logs: string[] = [];
    const filter = redactedLines([key], (text) => logs.push(text));
    filter.write(`prefix ${key.slice(0, 8)}`);
    filter.write(`${key.slice(8)} suffix\nlast ${key}`);
    filter.end();
    assertNoMaterial("logs", logs.join(""), key);
    expect(logs).toEqual(["prefix [REDACTED] suffix\n", "last [REDACTED]"]);
});

test("inspect and init proc leak checks fail without printing material", () => {
    expect(() => assertNoMaterial("inspect", JSON.stringify({ Config: { Env: [`KEY=${key}`] } }), key)).toThrow("credential_leak_inspect");
    expect(() => assertNoMaterial("init_proc", Buffer.from(`KEY=${key}\0`), key)).toThrow("credential_leak_init_proc");
});

test("container argv has caps, rm, no mounts or key environment and only one stdin handoff", () => {
    const config = mockConfig as ContainerRunConfig;
    validateRunConfig(config);
    const argv = containerArgs(config, config.jobs[0], "mock-name");
    expect(argv).toContain("--rm");
    expect(argv.slice(argv.indexOf("--cpus"), argv.indexOf("--cpus") + 4)).toEqual(["--cpus", "4", "--memory", "8g"]);
    expect(argv).not.toContain("-e"); expect(argv).not.toContain("--env"); expect(argv).not.toContain("-v");
    expect(argv).not.toContain("--mount");
    expect(argv.join(" ").includes(key)).toBe(false);
    expect(argv.filter((arg) => arg === "-i")).toHaveLength(1);
});

test("spawn boundary excludes raw and encoded keys from argv and environment", () => {
    const config = mockConfig as ContainerRunConfig;
    const invocation = containerInvocation(config, config.jobs[0], "mock-name", key);
    expect(invocation.argv[0]).toBe("run");
    expect(Object.keys(invocation.env).sort()).toEqual(["HOME", "PATH"]);
});

test("spawn boundary refuses raw base64 and hex key forms in argv or environment", () => {
    for (const form of [key, Buffer.from(key).toString("base64"), Buffer.from(key).toString("hex")]) {
        expect(() => assertSpawnBoundary(["run", form], {}, key)).toThrow("credential_leak_spawn_argv");
        expect(() => assertSpawnBoundary(["run"], { MOCK: form }, key)).toThrow("credential_leak_spawn_environment");
    }
});

test("paid run without explicit bridge network refuses by name", () => {
    expect(() => validateRunConfig({ ...mockConfig, mock: false, network: undefined } as ContainerRunConfig)).toThrow("paid_network_bridge_required");
});
test("mock run with bridge networking refuses by name", () => {
    expect(() => validateRunConfig({ ...mockConfig, network: "bridge" } as ContainerRunConfig)).toThrow("mock_network_must_be_none");
});
test("bridge networking without a real grant list refuses by name", () => {
    expect(() => validateRunConfig({ ...mockConfig, mock: false, network: "bridge", grants: [] } as ContainerRunConfig)).toThrow("real_grant_list_required");
});
