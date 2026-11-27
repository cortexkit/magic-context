import { describe, expect, it } from "bun:test";
import type { CiSources } from "./ci-mode-coverage";
import {
    filesForMode,
    validateManifestDocument,
    validateModeManifest,
    type ModeManifest,
} from "./validate-mode-manifest";

const validation = validateModeManifest();

function manifestWith(entries: ModeManifest["entries"]): ModeManifest {
    return {
        schema: 2,
        header: "test manifest",
        entries,
    };
}

describe("mode manifest validator", () => {
    it("covers every live e2e test exactly once", () => {
        expect(validation.files.length).toBe(265);
        expect(validation.files.length).toBe(264);
        expect(validation.files.length).toBe(259);
        expect(validation.manifest.entries).toHaveLength(validation.files.length);
        expect(new Set(validation.manifest.entries.map((entry) => entry.path)).size).toBe(
            validation.files.length,
        );
        expect(validation.manifest.entries.map((entry) => entry.path).sort()).toEqual(validation.files);
    });

    it("derives separate TS and Rust invocation lists", () => {
        const ts = filesForMode(validation, "ts");
        const rust = filesForMode(validation, "rust");
        expect(ts).toHaveLength(143);
        expect(rust).toHaveLength(60);
        expect(rust).toContain("tests/rust-compaction-marker-catchup.test.ts");
        expect(rust).toContain("tests/rust-tool-attachments.test.ts");
        expect(rust).toContain("tests/rust-tool-attachment-upgrade.test.ts");
        expect(rust).toContain("tests/idle-ttl-restart.test.ts");
        expect(rust).toContain("tests/subagent-behavior.test.ts");
        expect(ts.filter((path) => path.startsWith("tests/pi-")).length).toBe(9);
        expect(filesForMode(validation, "ts", "opencode")).toHaveLength(51);
        for (const host of ["opencode", "pi"] as const) {
            expect(filesForMode(validation, "ts", host)).toContain("tests/recomp-paused.test.ts");
        }
        expect(rust).not.toContain("tests/recomp-paused.test.ts");
        expect(filesForMode(validation, "ts", "opencode")).toContain("tests/wrapup-next-message.test.ts");
        expect(rust).not.toContain("tests/wrapup-next-message.test.ts");
        expect(filesForMode(validation, "ts", "opencode")).toContain("tests/processed-images.test.ts");
        expect(rust).not.toContain("tests/processed-images.test.ts");
        for (const host of ["opencode2", "pi", "omp"] as const) {
            expect(filesForMode(validation, "ts", host)).not.toContain("tests/processed-images.test.ts");
        }
        expect(ts).toContain("tests/latest-turn-thinking.test.ts");
        expect(ts).toContain("tests/opencode2/latest-turn-thinking-recovery.test.ts");
        expect(rust).not.toContain("tests/latest-turn-thinking.test.ts");
        expect(rust).not.toContain("tests/opencode2/latest-turn-thinking-recovery.test.ts");
        expect(ts).toContain("tests/reasoning-token-budget.test.ts");
        expect(rust).not.toContain("tests/reasoning-token-budget.test.ts");
        expect(filesForMode(validation, "ts", "pi")).toHaveLength(37);
        expect(filesForMode(validation, "ts", "opencode2")).toHaveLength(103);
        // These OpenCode 2 files are ts-only with hosts ["opencode2"], so only the
        // OpenCode 2 host lane runs them; the other host lanes never select them.
        for (const path of [
            "tests/opencode2/recomp-paused.test.ts",
            "tests/opencode2/storage-notice-boundaries.test.ts",
            "tests/opencode2/issue-889-model-switch.test.ts",
            "tests/opencode2/overflow-terminal-errors.test.ts",
            "tests/opencode2/message-index-continuity.test.ts",
            "tests/opencode2/error-result-compaction.test.ts",
            "tests/opencode2/latest-turn-thinking-recovery.test.ts",
            "tests/opencode2/signed-drop-rebuild.test.ts",
            "tests/opencode2/adapters-s2-contracts.test.ts",
            "tests/opencode2/adapters-s3-marker-policy.test.ts",
            "tests/opencode2/pins.test.ts",
            "tests/opencode2/tool-definition-cache-loss.test.ts",
            "tests/opencode2/reporter-emergency-drop.test.ts",
            "tests/opencode2/storage-busy.test.ts",
            "tests/opencode2/generate.test.ts",
            "tests/opencode2/subagent-mode.test.ts",
            "tests/opencode2/subagent-write-tools.test.ts",
            "tests/opencode2/dreamer-task-context.test.ts",
            "tests/opencode2/commands-s2-wrapup.test.ts",
            "tests/opencode2/recomp-hidden-executor.test.ts",
            "tests/opencode2/dream-schedule-timer.test.ts",
            "tests/opencode2/native-fold-hidden-edit.test.ts",
            "tests/opencode2/native-fold-fork-cache-review.test.ts",
            "tests/opencode2/fork-stale-summary.test.ts",
            "tests/opencode2/native-fold-provenance.test.ts",
            "tests/opencode2/image-attachment.test.ts",
            "tests/opencode2/restored-image-system-first-draft.test.ts",
        ]) {
            expect(filesForMode(validation, "ts", "opencode2")).toContain(path);
            expect(filesForMode(validation, "ts", "opencode")).not.toContain(path);
        }
        // OMP hashes each request into its system header, breaking within-session byte identity
        // in cache-stability and long-running-session; their manifest entries declare the omission.
        expect(filesForMode(validation, "ts", "omp")).toHaveLength(28);
        expect(filesForMode(validation, "ts", "omp")).toContain("tests/omp-compaction-marker.test.ts");
        expect(filesForMode(validation, "ts", "pi")).not.toContain("tests/omp-compaction-marker.test.ts");
        const behaviorFiles = validation.manifest.entries.filter((entry) => entry.path.startsWith("tests/"));
        const excluded = behaviorFiles
            .filter((entry) => entry.tier === "excluded")
            .map((entry) => entry.path);
        expect([...excluded].sort()).toEqual([
            "tests/degraded-pass-lock.test.ts",
            "tests/dreamer-host-timeout.test.ts",
            "tests/dreamer-mapper-step-cap-pi.test.ts",
            "tests/dreamer-token-budget-oc1.test.ts",
            "tests/historian-host-timeout.test.ts",
            "tests/historian-no-tools.test.ts",
            "tests/historian-window-fit.test.ts",
            "tests/issue-538-engine-wall.test.ts",
            "tests/issue-570-home-project.test.ts",
            "tests/issue-574-unborn-project.test.ts",
            "tests/issue-586-pi-responses-orphans.test.ts",
            "tests/issue-752-restart-first-pass.test.ts",
            "tests/issue-797-restart-tool-rows.test.ts",
            "tests/live-providers.test.ts",
            "tests/opencode2/commands-s2-keymap.test.ts",
            "tests/opencode2/commands-s2-tui-feedback.test.ts",
            "tests/opencode2/context-s2-lanes.test.ts",
            "tests/opencode2/converted-store-overwindow.test.ts",
            "tests/opencode2/hidden-run-notifications.test.ts",
            "tests/opencode2/mapper-step-finalize.test.ts",
            "tests/opencode2/marker-s3-runtime.test.ts",
            "tests/opencode2/rust-mode-boundary-restart-gate.test.ts",
            "tests/opencode2/session-api-cutover.test.ts",
            "tests/opencode2/sidebar-component.test.ts",
            "tests/opencode2/status-dialog.test.ts",
            "tests/opencode2/store-generation-conversion.test.ts",
            "tests/opencode2/ts-mode-on-migrated-real-store.test.ts",
            "tests/rust-classify-host-runner.test.ts",
            "tests/rust-full-sync-frame-cap.test.ts",
            "tests/rust-plugin-stage-cache.test.ts",
            "tests/system-prompt-change-order.test.ts",
        ]);
        expect(new Set([...ts, ...rust]).size).toBe(behaviorFiles.length - excluded.length);
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
                        ...entries[0]!,
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
        expect(validation.manifest.entries.filter((entry) => entry.path.startsWith("tests/"))
            .every((entry) => entry.hosts.length > 0)).toBe(true);
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

const directPath = "src/temp-dir.test.ts";
const directScript = "scripts/ci/harness-tests.sh";
const workflow = ".github/workflows/ci.yml";
const now = Date.parse("2026-11-27T23:59:59Z");
const manual = {
    path: directPath,
    tier: "excluded",
    invocation: { ts: false, rust: false },
    hosts: [],
    rationale: "Fixture for CI registration checks.",
    contract_refs: ["mode-manifest.json"],
} satisfies ModeManifest["entries"][number];

function oneStep(run: string): string {
    return `jobs:\n  test:\n    steps:\n      - run: ${JSON.stringify(run)}\n`;
}

function fixtureCi(files: Record<string, string> = {}, run?: string): CiSources {
    return { workflows: new Map(run ? [[workflow, oneStep(run)]] : []), read: (path) => files[path] };
}

function checkEntry(entry: ModeManifest["entries"][number], ci = fixtureCi()) {
    return validateManifestDocument(manifestWith([entry]), [entry.path], { now, ci });
}

describe("CI reachability guard", () => {
    it("rejects an on-disk harness test missing from the manifest inventory", () => {
        const entries = validation.manifest.entries.filter((entry) => entry.path !== directPath);
        expect(() => validateManifestDocument(manifestWith(entries))).toThrow(/missing manifest entries: src\/temp-dir\.test\.ts/);
    });

    it("rejects an unscheduled test with only a prose rationale", () => {
        expect(() => checkEntry(manual)).toThrow(/src\/temp-dir\.test\.ts: not selected by any CI lane/);
    });

    it("rejects a declared mode whose CI selector is absent", () => {
        const entry = validation.manifest.entries.find((item) => item.path === "tests/opencode2/bounded-raw-reads.test.ts")!;
        expect(() => checkEntry(entry)).toThrow(/declares an invocation but no CI lane selects it/);
    });

    it("rejects a host matrix that omits a shard still used by the runner", () => {
        const entry = validation.manifest.entries.find((item) => item.path === "tests/opencode2/bounded-raw-reads.test.ts")!;
        const runner = "scripts/ci/e2e-host-opencode2-run-host-e2e-suite-opencode-2-tests-from-mode-manifest.sh";
        const yaml = `jobs:\n  e2e-host-opencode2:\n    strategy:\n      matrix:\n        shard: [0]\n    steps:\n      - run: bash ${runner}\n`;
        const ci: CiSources = {
            workflows: new Map([[workflow, yaml]]),
            read: (path) => path === runner ? 'bun scripts/select-host-shard.ts opencode2 "$1/2"' : undefined,
        };
        expect(() => checkEntry(entry, ci)).toThrow(/host wrapper and CI shard count disagree/);
    });

    it("rejects unrecognized exclusions and triage without a real UTC date", () => {
        const unknown = { ...manual, exclusion: { reason: "some-other-reason" } };
        expect(() => checkEntry(unknown as ModeManifest["entries"][number])).toThrow(/invalid exclusion/);
        for (const since of [undefined, "2026-02-29", "Nov 27", "2026-11-27T00:00:00Z"]) {
            expect(() => checkEntry({ ...manual, exclusion: { reason: "triage-pending", since } }))
                .toThrow(/requires a valid UTC date/);
        }
    });

    it("accepts a 30-day-old triage and rejects older or future dates", () => {
        const pending = (since: string) => ({ ...manual, exclusion: { reason: "triage-pending" as const, since } });
        expect(checkEntry(pending("2026-10-28")).manifest.entries).toHaveLength(1);
        expect(() => checkEntry(pending("2026-10-27"))).toThrow(/older than 30 days/);
        expect(() => checkEntry(pending("2026-11-28"))).toThrow(/since date is in the future/);
    });

    it("accepts direct CI coverage independently of the tier", () => {
        const command = `bun test ./${directPath}`;
        const declared = { ...manual, runs_in: directScript };
        expect(checkEntry(declared, fixtureCi({ [directScript]: command }, `bash ${directScript}`)).manifest.entries)
            .toHaveLength(1);
        expect(checkEntry(declared, fixtureCi({ [directScript]: command, "scripts/gate.sh": `bash ${directScript}` })).manifest.entries)
            .toHaveLength(1);
        expect(checkEntry({ ...manual, runs_in: workflow }, fixtureCi({}, `bun test packages/e2e-tests/${directPath}`))
            .manifest.entries).toHaveLength(1);
    });

    it("rejects a missing runs_in source", () => {
        expect(() => checkEntry({ ...manual, runs_in: directScript }, fixtureCi({}, `bash ${directScript}`)))
            .toThrow(/runs_in script does not exist/);
        expect(() => checkEntry({ ...manual, runs_in: workflow })).toThrow(/runs_in workflow does not exist/);
    });

    it("rejects a direct script no longer referenced by CI", () => {
        expect(() => checkEntry({ ...manual, runs_in: directScript }, fixtureCi({ [directScript]: `bun test ${directPath}` }, "bash scripts/ci/renamed.sh")))
            .toThrow(/runs_in script is not referenced/);
    });

    it("rejects a removed literal test path in a script or workflow", () => {
        const declared = { ...manual, runs_in: directScript };
        for (const command of ["bun test src/other.test.ts", "bun test src/*.test.ts", `bun test ${directPath}.bak`, `# bun test ${directPath}`]) {
            expect(() => checkEntry(declared, fixtureCi({ [directScript]: command }, `bash ${directScript}`)))
                .toThrow(/runs_in script does not name the test/);
        }
        expect(() => checkEntry({ ...manual, runs_in: workflow }, fixtureCi({}, "bun test src/other.test.ts")))
            .toThrow(/runs_in workflow does not name the test/);
    });

    it("rejects an exclusion on a test already run by CI", () => {
        const declared = { ...manual, runs_in: workflow, exclusion: { reason: "manual-long-running" as const } };
        expect(() => checkEntry(declared, fixtureCi({}, `bun test ${directPath}`)))
            .toThrow(/selected by CI but declares an exclusion/);
    });
});
