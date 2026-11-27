#!/usr/bin/env bun

import { Glob } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import versions from "../opencode2-versions.json";
import { ciModeCoverage, readCiSources, type CiSources } from "./ci-mode-coverage";
import { filesForMode } from "./mode-selection";
import { validateKnownOpenCode2Failures, type KnownOpenCode2Failure } from "./validate-known-oc2-failures";

export { filesForMode } from "./mode-selection";

export const E2E_ROOT = resolve(import.meta.dir, "..");
export const MANIFEST_PATH = resolve(E2E_ROOT, "mode-manifest.json");
const TEST_GLOB = "{tests,scripts,src}/**/*.test.ts";
const DAY_MS = 24 * 60 * 60 * 1000;
const EXCLUSION_REASONS = [
    "manual-paid-provider", "manual-native-lane", "manual-tui", "manual-pinned-host",
    "manual-long-running", "manual-opt-in-probe", "triage-pending", "known-product-gap",
] as const;

type ExclusionReason = (typeof EXCLUSION_REASONS)[number];
type Exclusion =
    | { reason: "known-product-gap"; since: string; issue: number }
    | { reason: Exclude<ExclusionReason, "known-product-gap">; since?: string };

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
    runs_in?: string;
    exclusion?: Exclusion;
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

function exclusionAgeDays(time: number, now: number): number {
    return Math.floor(now / DAY_MS) - Math.floor(time / DAY_MS);
}

function validateExclusion(value: unknown, path: string, now: number): Exclusion {
    if (!isRecord(value) || Object.keys(value).some((key) => key !== "reason" && key !== "since" &&
        (key !== "issue" || value.reason !== "known-product-gap")) ||
        !EXCLUSION_REASONS.includes(value.reason as ExclusionReason)) {
        throw new Error(`${path}: invalid exclusion; expected a reason from ${EXCLUSION_REASONS.join(", ")}`);
    }
    const reason = value.reason as ExclusionReason;
    const since = value.since;
    if (since === undefined && reason !== "triage-pending" && reason !== "known-product-gap") return { reason };
    if (typeof since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(since) ||
        !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since) {
        throw new Error(`${path}: ${reason} exclusion requires a valid UTC date (YYYY-MM-DD) in since`);
    }
    const days = exclusionAgeDays(Date.parse(since), now);
    if (days < 0) throw new Error(`${path}: exclusion since date is in the future`);
    if (reason === "triage-pending" && days > 30) {
        throw new Error(`${path}: triage-pending exclusion is older than 30 days (since ${since})`);
    }
    if (reason === "known-product-gap") {
        const issue = value.issue;
        if (typeof issue !== "number" || !Number.isSafeInteger(issue) || issue < 1) {
            throw new Error(`${path}: known-product-gap exclusion requires a positive issue number`);
        }
        return { reason, since, issue };
    }
    return { reason, since };
}

function validateEntry(value: unknown, index: number, now: number): ModeManifestEntry {
    if (!isRecord(value)) throw new Error(`entry ${index} is not an object`);
    const requiredKeys = ["path", "tier", "invocation", "hosts", "rationale", "contract_refs"];
    const allowedKeys = [...requiredKeys, "behavior", "divergences", "knownFailures", "runs_in", "exclusion"];
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
        (hosts.length === 0 && (path.startsWith("tests/") || invocation.ts || invocation.rust)) ||
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
    const runsIn = value.runs_in;
    if (runsIn !== undefined && typeof runsIn !== "string") throw new Error(`${path}: runs_in must be a path`);
    const exclusion = value.exclusion === undefined ? undefined : validateExclusion(value.exclusion, path, now);

    return {
        path,
        tier: typedTier,
        invocation: { ts: invocation.ts, rust: invocation.rust },
        hosts: [...hosts] as Host[],
        ...(behavior === undefined ? {} : { behavior }),
        ...(divergences.length === 0 ? {} : { divergences }),
        ...(runsIn === undefined ? {} : { runs_in: runsIn }),
        ...(exclusion === undefined ? {} : { exclusion }),
        rationale,
        contract_refs: [...contractRefs] as string[],
    };
}

/** Validate the committed manifest against the live test-file inventory. */
export function validateManifestDocument(
    raw: unknown,
    expectedFiles: string[] = enumerateTestFiles(),
    { now = Date.now(), ci = readCiSources(resolve(E2E_ROOT, "../..")) }: { now?: number; ci?: CiSources } = {},
): ValidationResult {
    if (!isRecord(raw) || raw.schema !== 2 || typeof raw.header !== "string" || !Array.isArray(raw.entries)) {
        throw new Error("mode manifest must be an object with schema: 2, header, and entries");
    }

    const entries = raw.entries.map((entry, index) => validateEntry(entry, index, now));
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
        if (!/^(?:tests|scripts|src)\/.+\.test\.ts$/.test(entry.path)) {
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

    const validation: ValidationResult = {
        manifest: { schema: 2, header: raw.header, entries },
        files: expectedFiles,
    };
    const covered = ciModeCoverage(validation, ci);
    const issues: string[] = [];
    for (const entry of entries) {
        if (covered.has(entry.path)) {
            if (entry.exclusion) issues.push(`${entry.path}: selected by CI but declares an exclusion`);
        } else if (entry.invocation.ts || entry.invocation.rust) {
            issues.push(`${entry.path}: declares an invocation but no CI lane selects it`);
        } else if (!entry.exclusion) {
            issues.push(`${entry.path}: not selected by any CI lane; add runs_in or an exclusion reason`);
        }
    }
    if (issues.length > 0) throw new Error(issues.join("\n"));
    return validation;
}

export function describeKnownProductGaps(validation: ValidationResult, now: number): string[] {
    return validation.manifest.entries.flatMap(({ path, exclusion, rationale }) => {
        if (exclusion?.reason !== "known-product-gap") return [];
        const days = exclusionAgeDays(Date.parse(exclusion.since), now);
        return [`known-product-gap: ${path} — issue ${exclusion.issue}, ${days}d (since ${exclusion.since}): ${rationale}`];
    });
}

export function validateModeManifest(): ValidationResult {
    const now = Date.now();
    const validation = validateManifestDocument(readManifest(), undefined, { now });
    // Mode selectors use stdout as a list of test files.
    for (const notice of describeKnownProductGaps(validation, now)) console.error(notice);
    return validation;
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
