import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { selectHostShard, selectOpenCode2KnownFailures } from "./select-host-shard";
import { validateKnownOpenCode2Failures } from "./validate-known-oc2-failures";
import { E2E_ROOT, validateManifestDocument, validateModeManifest } from "./validate-mode-manifest";

const path = "tests/deferred-compaction-marker.test.ts";
const name = "deferred compaction marker (plan v6) [opencode2] > publishes a compartment and supplies a durable native checkpoint without a provider call";
const rule = {
    hostVersions: ["2.3.2", "2.4.2"],
    tests: [name],
    class: "defect" as const,
    reason: "The completed host checkpoint has no durable replay admission.",
};
const matrix = ["2.0.22", "2.1.0", "2.3.2", "2.4.2"];
const source = readFileSync(join(E2E_ROOT, path), "utf8");
const checked = () => validateKnownOpenCode2Failures([rule], path, source, matrix);

test("known failures require an exact named test, a current matrix version, a cause class and a reason", () => {
    expect(checked()).toEqual([rule]);
    for (const version of ["2.99.0", "2.4", "2.0.22", "2.1.0"]) {
        expect(() => validateKnownOpenCode2Failures([{ ...rule, hostVersions: [version] }], path, source, matrix))
            .toThrow("exact, current OpenCode 2 matrix versions");
    }
    for (const tests of [[name + " typo"], ["wrong suite > " + name.split(" > ").at(-1)], [name.split(" > ").at(-1)]]) {
        expect(() => validateKnownOpenCode2Failures([{ ...rule, tests }], path, source, matrix))
            .toThrow("test name not declared in the file");
    }
    expect(() => validateKnownOpenCode2Failures([{ ...rule, reason: " " }], path, source, matrix)).toThrow("nonempty one-line reason");
    expect(() => validateKnownOpenCode2Failures([{ ...rule, class: "flaky" }], path, source, matrix)).toThrow("class must be defect or host");
    expect(() => validateKnownOpenCode2Failures([rule, rule], path, source, matrix)).toThrow("duplicate known failure");
});

test("the manifest rejects known failures on tests not selected by the OpenCode 2 lane", () => {
    const validation = validateModeManifest();
    const entry = validation.manifest.entries.find((item) => item.path === path)!;
    expect(() => validateManifestDocument({ ...validation.manifest, entries: [{ ...entry, hosts: ["opencode"], knownFailures: [rule] }] }, [path]))
        .toThrow("only on selected OpenCode 2 host tests");
});

test("the known-failure selector respects the exact host version and shard without filtering out the test", () => {
    const validation = validateModeManifest();
    const entry = validation.manifest.entries.find((item) => item.path === path)!;
    entry.knownFailures = checked();
    const shards = ["0/2", "1/2"].map((index) => selectHostShard("opencode2", index, validation));
    expect(shards.filter((files) => files.includes(path))).toHaveLength(1);
    const active = shards.find((files) => files.includes(path))!;
    const other = shards.find((files) => !files.includes(path))!;
    expect(selectOpenCode2KnownFailures(validation, active, "2.3.2"))
        .toEqual([{ path, name, class: "defect", reason: rule.reason }]);
    expect(selectOpenCode2KnownFailures(validation, other, "2.3.2")).toEqual([]);
    expect(selectOpenCode2KnownFailures(validation, active, "2.1.0")).toEqual([]);
});

const adjudicator = resolve(import.meta.dir, "../../../scripts/ci/adjudicate-oc2-junit.py");
const suite = name.split(" > ")[0]!;
const title = name.split(" > ")[1]!;

function runReport(state: "passed" | "failed" | "skipped", known: boolean, status = Number(state === "failed")) {
    const dir = mkdtempSync(join(tmpdir(), "oc2-junit-contract-"));
    try {
        const selection = join(dir, "known.json");
        const report = join(dir, "results.xml");
        writeFileSync(selection, JSON.stringify(known ? [{ path, name, class: "defect", reason: rule.reason }] : []));
        const result = state === "failed" ? '<failure message="no admission" />' : state === "skipped" ? "<skipped />" : "";
        writeFileSync(report, `<testsuites name="bun test" tests="1" failures="${Number(state === "failed")}" skipped="${Number(state === "skipped")}">
            <testsuite name="${path}" file="${path}"><testsuite name="${suite}" file="${path}">
                <testcase name="${title}" file="${path}">${result}</testcase>
            </testsuite></testsuite>
        </testsuites>`);
        return spawnSync("python3", [adjudicator, selection, report, String(status)], { encoding: "utf8" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a listed failure remains visible but allows the shard to pass", () => {
    const result = runReport("failed", true);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(rule.reason);
});

test("a listed pass fails the shard and requests removal of the entry", () => {
    const result = runReport("passed", true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("remove its knownFailures entry");
});

test("unlisted failures, listed skips, and an abnormal runner exit cannot pass", () => {
    for (const [result, message] of [
        [runReport("failed", false), "Unlisted failure:"],
        [runReport("skipped", true), "must run exactly once"],
        [runReport("failed", true, 137), "Bun exit 137"],
    ] as const) {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(message);
    }
});
