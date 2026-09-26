import { describe, expect, it } from "bun:test";
import {
    filesForMode,
    validateManifestDocument,
    validateModeManifest,
    type ModeManifest,
} from "./validate-mode-manifest";

const validation = validateModeManifest();

function manifestWith(entries: ModeManifest["entries"]): ModeManifest {
    return {
        schema: 1,
        header: "test manifest",
        entries,
    };
}

describe("mode manifest validator", () => {
    it("covers every live e2e test exactly once", () => {
        // Bump this with the manifest whenever a tests/**/*.test.ts file is added or
        // removed. Adding an excluded OpenCode 2 file moves this number and the excluded
        // list below and nothing else, because tier "excluded" never enters a TS or
        // Rust invocation list. A ts-only OpenCode 2 file also moves the TS and
        // opencode2 counts in the next test.
        expect(validation.files.length).toBe(125);
        expect(validation.manifest.entries).toHaveLength(validation.files.length);
        expect(new Set(validation.manifest.entries.map((entry) => entry.path)).size).toBe(
            validation.files.length,
        );
        expect(validation.manifest.entries.map((entry) => entry.path).sort()).toEqual(validation.files);
    });

    it("derives separate TS and Rust invocation lists", () => {
        const ts = filesForMode(validation, "ts");
        const rust = filesForMode(validation, "rust");
        expect(ts).toHaveLength(41);
        expect(rust).toHaveLength(55);
        expect(rust).toContain("tests/subagent-behavior.test.ts");
        expect(ts.filter((path) => path.startsWith("tests/pi-")).length).toBe(2);
        expect(filesForMode(validation, "ts", "opencode")).toHaveLength(34);
        expect(filesForMode(validation, "ts", "pi")).toHaveLength(24);
        expect(filesForMode(validation, "ts", "opencode2")).toHaveLength(25);
        // These four OpenCode 2 files are ts-only with hosts ["opencode2"], so only the
        // OpenCode 2 host lane runs them; the other host lanes never select them.
        for (const path of [
            "tests/opencode2/adapters-s2-contracts.test.ts",
            "tests/opencode2/adapters-s3-marker-policy.test.ts",
            "tests/opencode2/pins.test.ts",
            "tests/opencode2/reporter-emergency-drop.test.ts",
        ]) {
            expect(filesForMode(validation, "ts", "opencode2")).toContain(path);
            expect(filesForMode(validation, "ts", "opencode")).not.toContain(path);
        }
        // OMP hashes each request into its system header, breaking within-session byte identity
        // in cache-stability and long-running-session; their manifest entries declare the omission.
        expect(filesForMode(validation, "ts", "omp")).toHaveLength(19);
        const excluded = validation.manifest.entries
            .filter((entry) => entry.tier === "excluded")
            .map((entry) => entry.path);
        expect([...excluded].sort()).toEqual([
            "tests/adv-identical-bytes-hard.test.ts",
            "tests/opencode2/automatic-s3-paths.test.ts",
            "tests/opencode2/bounded-raw-reads.test.ts",
            "tests/opencode2/commands-s2-flush.test.ts",
            "tests/opencode2/commands-s2-host-registration.test.ts",
            "tests/opencode2/commands-s2-keymap.test.ts",
            "tests/opencode2/commands-s2-wrapup.test.ts",
            "tests/opencode2/compartment-boundary-host-row.test.ts",
            "tests/opencode2/context-s2-lanes.test.ts",
            "tests/opencode2/converted-drop-replay.test.ts",
            "tests/opencode2/converted-store-overwindow.test.ts",
            "tests/opencode2/dream-loop.test.ts",
            "tests/opencode2/dreamer-s2-carrier.test.ts",
            "tests/opencode2/emergency-refusal-visible.test.ts",
            "tests/opencode2/entry-s2-context.test.ts",
            "tests/opencode2/fold-s3-owner.test.ts",
            "tests/opencode2/harness-s3-identity.test.ts",
            "tests/opencode2/hidden-child-ga.test.ts",
            "tests/opencode2/hidden-child-unbound.test.ts",
            "tests/opencode2/image-attachment.test.ts",
            "tests/opencode2/marker-s3-runtime.test.ts",
            "tests/opencode2/mural-media-schema.test.ts",
            "tests/opencode2/over-limit-recovery.test.ts",
            "tests/opencode2/probes.test.ts",
            "tests/opencode2/prompt-surface-s6.test.ts",
            "tests/opencode2/restart-system-prompt-change.test.ts",
            "tests/opencode2/rpc-s2-listener.test.ts",
            "tests/opencode2/runner.test.ts",
            "tests/opencode2/rust-mode-boundary-restart-gate.test.ts",
            "tests/opencode2/rust-mode-limitation.test.ts",
            "tests/opencode2/session-project-binding.test.ts",
            "tests/opencode2/sidebar-component.test.ts",
            "tests/opencode2/status-dialog.test.ts",
            "tests/opencode2/store-directories.test.ts",
            "tests/opencode2/store-generation-conversion.test.ts",
            "tests/opencode2/store-reader.test.ts",
            "tests/opencode2/synthetic-todo-schema.test.ts",
            "tests/opencode2/tool-definition-telemetry.test.ts",
            "tests/opencode2/tool-result-image.test.ts",
            "tests/opencode2/ts-mode-on-migrated-real-store.test.ts",
            "tests/opencode2/v1-v2-reconversion.test.ts",
            "tests/rust-classify-host-runner.test.ts",
            "tests/window-overlay-reload.test.ts",
        ]);
        expect(new Set([...ts, ...rust]).size).toBe(validation.files.length - excluded.length);
    });

    it("rejects a missing, duplicated, or dead manifest path", () => {
        const entries = validation.manifest.entries;
        expect(() => validateManifestDocument(manifestWith(entries.slice(0, -1)), validation.files)).toThrow(
            /missing manifest entries/,
        );
        expect(() =>
            validateManifestDocument(manifestWith([...entries, entries[0]!]), validation.files),
        ).toThrow(/duplicate manifest entry/);
        expect(() =>
            validateManifestDocument(
                manifestWith([
                    ...entries.slice(0, -1),
                    {
                        ...entries.at(-1)!,
                        path: "tests/not-live.test.ts",
                    },
                ]),
                validation.files,
            ),
        ).toThrow(/dead or out-of-scope/);
    });

    it("requires explicit hosts and exposes shared behavior scenarios to each declared lane", () => {
        const smoke = validation.manifest.entries.find((entry) => entry.path === "tests/smoke.test.ts");
        const ordinary = validation.manifest.entries.find((entry) => entry.path === "tests/cache-invariants.test.ts");
        const opencode2 = validation.manifest.entries.find((entry) => entry.path === "tests/opencode2/runner.test.ts");
        expect(validation.manifest.entries.every((entry) => entry.hosts.length > 0)).toBe(true);
        expect(smoke?.hosts).toEqual(["opencode", "opencode2", "pi", "omp"]);
        expect(ordinary?.hosts).toEqual(["opencode", "opencode2", "pi", "omp"]);
        expect(opencode2?.hosts).toEqual(["opencode2"]);
    });

    it("accepts a both-modes entry in both invocation lists", () => {
        const entries = validation.manifest.entries;
        const both = validateManifestDocument(
            manifestWith([
                {
                    ...entries[0]!,
                    tier: "both-modes",
                    invocation: { ts: true, rust: true },
                    contract_refs: ["PARITY.md"],
                },
                ...entries.slice(1),
            ]),
            validation.files,
        );
        expect(filesForMode(both, "ts")).toContain(entries[0]!.path);
        expect(filesForMode(both, "rust")).toContain(entries[0]!.path);
    });

    it("rejects invalid tiers, hosts, silent behavior omissions, and a both-modes entry missing an invocation", () => {
        const entries = validation.manifest.entries;
        expect(() =>
            validateManifestDocument(
                manifestWith([
                    {
                        ...entries[0]!,
                        tier: "not-a-tier" as never,
                    },
                    ...entries.slice(1),
                ]),
                validation.files,
            ),
        ).toThrow(/invalid classification/);
        expect(() =>
            validateManifestDocument(
                manifestWith([
                    {
                        ...entries[0]!,
                        hosts: ["opencode", "opencode"] as never,
                    },
                    ...entries.slice(1),
                ]),
                validation.files,
            ),
        ).toThrow(/invalid hosts/);
        const behaviorIndex = entries.findIndex((entry) => entry.behavior === true && entry.hosts.length === 4);
        const behavior = entries[behaviorIndex]!;
        expect(() =>
            validateManifestDocument(
                manifestWith([
                    ...entries.slice(0, behaviorIndex),
                    { ...behavior, hosts: ["opencode"], divergences: [] },
                    ...entries.slice(behaviorIndex + 1),
                ]),
                validation.files,
            ),
        ).toThrow(/silently omits behavior hosts/);
        expect(() =>
            validateManifestDocument(
                manifestWith([
                    {
                        ...entries[0]!,
                        tier: "both-modes",
                        invocation: { ts: true, rust: false },
                    },
                    ...entries.slice(1),
                ]),
                validation.files,
            ),
        ).toThrow(/invocation disagrees with both-modes/);
    });
});
