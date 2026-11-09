import { describe } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client";
import { TestHarness, type TestHarnessOptions } from "./harness";
import type { HostHarness, HostKind, HostPromptOptions } from "./host-harness";
import type { MockProvider } from "./mock-provider/server";
import { OpenCode2TestHarness, type OpenCode2TestHarnessOptions } from "./opencode2-harness";
import { PiTestHarness, type PiTestHarnessOptions } from "./pi-harness";

export interface ManifestDivergence {
    host: HostKind;
    reason: string;
    contract_ref: string;
}

interface ScenarioManifestEntry {
    path: string;
    hosts: HostKind[];
    divergences?: ManifestDivergence[];
}

interface ScenarioManifest {
    entries: ScenarioManifestEntry[];
}

export type ScenarioHarness = HostHarness & { readonly mock: MockProvider };
export type ScenarioHarnessOptions = TestHarnessOptions &
    OpenCode2TestHarnessOptions &
    PiTestHarnessOptions;

const E2E_ROOT = resolve(import.meta.dir, "..");
const manifest = JSON.parse(
    readFileSync(resolve(E2E_ROOT, "mode-manifest.json"), "utf8"),
) as ScenarioManifest;

function manifestPath(metaUrl: string): string {
    return relative(E2E_ROOT, fileURLToPath(metaUrl)).replaceAll("\\", "/");
}

export function hostsForScenario(metaUrl: string): HostKind[] {
    const path = manifestPath(metaUrl);
    const entry = manifest.entries.find((candidate) => candidate.path === path);
    if (!entry) throw new Error(`scenario is absent from mode-manifest.json: ${path}`);
    if (!Array.isArray(entry.hosts) || entry.hosts.length === 0) {
        throw new Error(`scenario has no explicit hosts in mode-manifest.json: ${path}`);
    }
    return entry.hosts;
}

/** Register the scenario once for each manifest host and run only the selected lane. */
export function forEachHost(
    metaUrl: string,
    scenario: string | null,
    register: (host: HostKind) => void,
): void {
    const hosts = hostsForScenario(metaUrl);
    const selected = process.env.MC_E2E_HOST ?? (hosts.includes("opencode") ? "opencode" : hosts[0]);
    if (!hosts.includes(selected as HostKind)) {
        throw new Error(
            `${manifestPath(metaUrl)} does not declare MC_E2E_HOST=${selected}; declared hosts: ${hosts.join(", ")}`,
        );
    }

    if (scenario === null) {
        const host = selected as HostKind;
        if (host === "opencode") register(host);
        else describe(`[${host}]`, () => register(host));
        return;
    }

    for (const host of hosts) {
        const suiteName = host === "opencode" ? scenario : `${scenario} [${host}]`;
        const define = host === selected ? describe : describe.skip;
        define(suiteName, () => register(host));
    }
}

export async function createScenarioHarness(
    host: HostKind,
    options: ScenarioHarnessOptions = {},
): Promise<ScenarioHarness> {
    if (host === "opencode") return TestHarness.create(options);
    if (host === "opencode2") return OpenCode2TestHarness.create(options);
    return PiTestHarness.create({ ...options, host });
}

export function isPiFamily(host: HostKind): host is "pi" | "omp" {
    return host === "pi" || host === "omp";
}

export async function createFreshSession(harness: ScenarioHarness): Promise<string> {
    if (harness instanceof PiTestHarness) {
        await harness.newSession();
        const state = await harness.getState();
        if (!state.sessionId) throw new Error(`${harness.host} did not report a session id`);
        return state.sessionId;
    }
    return harness.createSession();
}

export async function createSessionAndPrompt(
    harness: ScenarioHarness,
    prompt: string,
    options?: HostPromptOptions,
): Promise<string> {
    if (harness instanceof PiTestHarness) {
        const result = await harness.sendPrompt(prompt, options);
        if (!result.sessionId) throw new Error(`${harness.host} did not report a session id`);
        return result.sessionId;
    }
    const sessionId = await harness.createSession();
    await harness.sendPrompt(sessionId, prompt, options);
    return sessionId;
}

/**
 * Run `/ctx-flush` for one session through each host's own command path, so the
 * session's next request is an explicitly requested rebuild. Pi and Oh My Pi run
 * it as an extension command, OpenCode 1 through its HTTP command route, and
 * OpenCode 2 through its client's session command.
 */
export async function requestCtxFlush(harness: ScenarioHarness, sessionId: string): Promise<void> {
    if (harness instanceof PiTestHarness) {
        await harness.invokeExtensionCommand("ctx-flush");
        return;
    }
    if (harness instanceof TestHarness) {
        const response = await fetch(
            `${harness.serverUrl}/session/${sessionId}/command?directory=${encodeURIComponent(harness.workdir)}`,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ command: "ctx-flush", arguments: "" }),
            },
        );
        if (!response.ok) {
            throw new Error(`OpenCode /ctx-flush failed: ${response.status} ${await response.text()}`);
        }
        return;
    }
    if (harness instanceof OpenCode2TestHarness) {
        const host = harness.opencode;
        await OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        }).session.command({ sessionID: sessionId, name: "ctx-flush", text: "" });
        return;
    }
    throw new Error(`no /ctx-flush driver for ${harness.host}`);
}
