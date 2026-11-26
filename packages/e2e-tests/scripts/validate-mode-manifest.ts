#!/usr/bin/env bun

import { Glob } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import versions from "../opencode2-versions.json";
import { validateKnownOpenCode2Failures, type KnownOpenCode2Failure } from "./validate-known-oc2-failures";

export const E2E_ROOT = resolve(import.meta.dir, "..");
export const MANIFEST_PATH = resolve(E2E_ROOT, "mode-manifest.json");
const TEST_GLOB = "tests/**/*.test.ts";

export const TIERS = ["both-modes", "ts-only", "rust-only", "excluded"] as const;
export const HOSTS = ["opencode", "opencode2", "pi", "omp"] as const;
export type Tier = (typeof TIERS)[number];
export type Mode = "ts" | "rust";
export type Host = (typeof HOSTS)[number];
export type HarnessSelection = "all" | Host;

export interface HostDivergence {
    host: Host;
    reason: string;
    contract_ref: string;
}

export interface ModeManifestEntry {
    path: string;
    tier: Tier;
    invocation: { ts: boolean; rust: boolean };
    hosts: Host[];
    behavior?: boolean;
    divergences?: HostDivergence[];
    knownFailures?: KnownOpenCode2Failure[];
    rationale: string;
    contract_refs: string[];
}

export interface ModeManifest {
    schema: number;
    header: string;
    entries: ModeManifestEntry[];
}

export interface ValidationResult {
    manifest: ModeManifest;
    files: string[];
}

function enumerateTestFiles(): string[] {
    const glob = new Glob(TEST_GLOB);
    return [...glob.scanSync({ cwd: E2E_ROOT, onlyFiles: true })].sort();
}

function readManifest(): unknown {
    try {
        return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown;
    } catch (error) {
        throw new Error(`could not read ${MANIFEST_PATH}: ${String(error)}`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEntry(value: unknown, index: number): ModeManifestEntry {
    if (!isRecord(value)) throw new Error(`entry ${index} is not an object`);
    const requiredKeys = ["path", "tier", "invocation", "hosts", "rationale", "contract_refs"];
    const allowedKeys = [...requiredKeys, "behavior", "divergences", "knownFailures"];
    const actualKeys = Object.keys(value).sort();
    if (
        requiredKeys.some((key) => !actualKeys.includes(key)) ||
        actualKeys.some((key) => !allowedKeys.includes(key))
    ) {
        throw new Error(
            `entry ${index} must contain ${requiredKeys.join(", ")}; got ${actualKeys.join(", ")}`,
        );
    }

    const path = value.path;
    if (typeof path !== "string" || path.length === 0) {
        throw new Error(`entry ${index} has an invalid path`);
    }
    const tier = value.tier;
    if (typeof tier !== "string" || !TIERS.includes(tier as Tier)) {
        throw new Error(`entry ${index} has invalid classification ${JSON.stringify(tier)}`);
    }
    const invocation = value.invocation;
    if (
        !isRecord(invocation) ||
        Object.keys(invocation).sort().join("\0") !== "rust\0ts" ||
        typeof invocation.ts !== "boolean" ||
        typeof invocation.rust !== "boolean"
    ) {
        throw new Error(`entry ${index} has invalid invocation; expected {ts:boolean,rust:boolean}`);
    }
    const hosts = value.hosts;
    if (
        !Array.isArray(hosts) ||
        hosts.length === 0 ||
        hosts.some((host) => typeof host !== "string" || !HOSTS.includes(host as Host)) ||
        new Set(hosts).size !== hosts.length
    ) {
        throw new Error(`entry ${index} has invalid hosts; expected unique values from ${HOSTS.join(", ")}`);
    }
    const rawBehavior = value.behavior;
    if (rawBehavior !== undefined && typeof rawBehavior !== "boolean") {
        throw new Error(`entry ${index} has invalid behavior flag`);
    }
    const behavior = rawBehavior as boolean | undefined;
    const rawDivergences = value.divergences;
    if (rawDivergences !== undefined && !Array.isArray(rawDivergences)) {
        throw new Error(`entry ${index} has invalid divergences; expected an array`);
    }
    const divergenceValues: unknown[] = Array.isArray(rawDivergences) ? rawDivergences : [];
    const divergences: HostDivergence[] = divergenceValues.map((divergence, divergenceIndex) => {
        if (!isRecord(divergence)) {
            throw new Error(`entry ${index} divergence ${divergenceIndex} is not an object`);
        }
        const keys = Object.keys(divergence).sort().join("\0");
        if (keys !== "contract_ref\0host\0reason") {
            throw new Error(`entry ${index} divergence ${divergenceIndex} must contain host, reason, contract_ref`);
        }
        const host = divergence.host;
        const reason = divergence.reason;
        const contractRef = divergence.contract_ref;
        if (typeof host !== "string" || !HOSTS.includes(host as Host)) {
            throw new Error(`entry ${index} divergence ${divergenceIndex} has invalid host`);
        }
        if (typeof reason !== "string" || reason.trim().length === 0) {
            throw new Error(`entry ${index} divergence ${divergenceIndex} has no reason`);
        }
        if (typeof contractRef !== "string" || contractRef.trim().length === 0) {
            throw new Error(`entry ${index} divergence ${divergenceIndex} has no contract_ref`);
        }
        return { host: host as Host, reason, contract_ref: contractRef };
    });
    if (new Set(divergences.map((divergence) => divergence.host)).size !== divergences.length) {
        throw new Error(`entry ${index} has duplicate divergence hosts`);
    }
    if (behavior === true) {
        const declared = new Set(hosts as Host[]);
        const explained = new Set(divergences.map((divergence) => divergence.host));
        const silent = HOSTS.filter((host) => !declared.has(host) && !explained.has(host));
        if (silent.length > 0) {
            throw new Error(`entry ${index} (${path}) silently omits behavior hosts: ${silent.join(", ")}`);
        }
    }

    const rationale = value.rationale;
    if (typeof rationale !== "string" || rationale.trim().length === 0) {
        throw new Error(`entry ${index} must have a rationale`);
    }
    const contractRefs = value.contract_refs;
    if (
        !Array.isArray(contractRefs) ||
        contractRefs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)
    ) {
        throw new Error(`entry ${index} must have a string-array contract_refs`);
    }

    const typedTier = tier as Tier;
    const expectedInvocation = {
        ts: typedTier === "both-modes" || typedTier === "ts-only",
        rust: typedTier === "both-modes" || typedTier === "rust-only",
    };
    if (invocation.ts !== expectedInvocation.ts || invocation.rust !== expectedInvocation.rust) {
        throw new Error(
            `entry ${index} invocation disagrees with ${typedTier}; expected ${JSON.stringify(expectedInvocation)}`,
        );
    }
    if (typedTier !== "both-modes" && contractRefs.length === 0) {
        throw new Error(`entry ${index} (${path}) is divergent/excluded but has no contract_refs`);
    }
    if (typedTier === "both-modes" && (!invocation.ts || !invocation.rust)) {
        throw new Error(`entry ${index} (${path}) is both-modes but is absent from an invocation`);
    }

    return {
        path,
        tier: typedTier,
        invocation: { ts: invocation.ts, rust: invocation.rust },
        hosts: [...hosts] as Host[],
        ...(behavior === undefined ? {} : { behavior }),
        ...(divergences.length === 0 ? {} : { divergences }),
        rationale,
        contract_refs: [...contractRefs] as string[],
    };
}

/** Validate the committed manifest against the live test-file inventory. */
export function validateManifestDocument(
    raw: unknown,
    expectedFiles: string[] = enumerateTestFiles(),
): ValidationResult {
    if (!isRecord(raw) || raw.schema !== 1 || typeof raw.header !== "string" || !Array.isArray(raw.entries)) {
        throw new Error("mode manifest must be an object with schema: 1, header, and entries");
    }

    const entries = raw.entries.map(validateEntry);
    const expectedSet = new Set(expectedFiles);
    const seen = new Map<string, number>();
    for (const [index, entry] of entries.entries()) {
        seen.set(entry.path, (seen.get(entry.path) ?? 0) + 1);
        if (!expectedSet.has(entry.path)) {
            throw new Error(`dead or out-of-scope manifest path: ${entry.path}`);
        }
        if (!existsSync(resolve(E2E_ROOT, entry.path))) {
            throw new Error(`manifest path does not exist: ${entry.path}`);
        }
        if (!entry.path.startsWith("tests/") || !entry.path.endsWith(".test.ts")) {
            throw new Error(`manifest path is not under ${TEST_GLOB}: ${entry.path}`);
        }
        if (seen.get(entry.path)! > 1) {
            throw new Error(`duplicate manifest entry: ${entry.path}`);
        }
        const original = raw.entries[index] as Record<string, unknown>;
        if (original.knownFailures !== undefined) {
            if (!entry.invocation.ts || !entry.hosts.includes("opencode2")) {
                throw new Error(`${entry.path}: known failures are allowed only on selected OpenCode 2 host tests`);
            }
            entry.knownFailures = validateKnownOpenCode2Failures(original.knownFailures, entry.path,
                readFileSync(resolve(E2E_ROOT, entry.path), "utf8"), versions.compatibility);
        }
    }

    const missing = expectedFiles.filter((path) => !seen.has(path));
    if (missing.length > 0) {
        throw new Error(`missing manifest entries: ${missing.join(", ")}`);
    }
    const duplicate = [...seen.entries()].filter(([, count]) => count > 1).map(([path]) => path);
    if (duplicate.length > 0) {
        throw new Error(`duplicate manifest entries: ${duplicate.join(", ")}`);
    }

    return {
        manifest: { schema: 1, header: raw.header, entries },
        files: expectedFiles,
    };
}

export function validateModeManifest(): ValidationResult {
    return validateManifestDocument(readManifest());
}

export function filesForMode(
    validation: ValidationResult,
    mode: Mode,
    harness: HarnessSelection = "all",
): string[] {
    return validation.manifest.entries
        .filter((entry) => entry.invocation[mode])
        .filter((entry) => harness === "all" || entry.hosts.includes(harness))
        .map((entry) => entry.path)
        .sort();
}

function parseArgs(args: string[]): { mode?: Mode; harness: HarnessSelection } {
    let mode: Mode | undefined;
    let harness: HarnessSelection = "all";
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--mode") {
            const value = args[++index];
            if (value !== "ts" && value !== "rust") throw new Error("--mode must be ts or rust");
            mode = value;
        } else if (arg === "--harness") {
            const value = args[++index];
            if (value !== "all" && !HOSTS.includes(value as Host)) {
                throw new Error(`--harness must be all or one of ${HOSTS.join(", ")}`);
            }
            harness = value as HarnessSelection;
        } else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: validate-mode-manifest.ts [--mode ts|rust] [--harness all|opencode|opencode2|pi|omp]",
            );
            process.exit(0);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return { mode, harness };
}

if (import.meta.main) {
    try {
        const { mode, harness } = parseArgs(Bun.argv.slice(2));
        const validation = validateModeManifest();
        if (!mode) {
            console.log(`validated ${validation.files.length} e2e test entries`);
        } else {
            for (const path of filesForMode(validation, mode, harness)) console.log(path);
        }
    } catch (error) {
        console.error(`mode manifest validation failed: ${String(error)}`);
        process.exit(1);
    }
}
