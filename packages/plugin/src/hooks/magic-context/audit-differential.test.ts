import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTestTempDir } from "../../shared/test-temp-dir";

const script = resolve(import.meta.dir, "../../../../../scripts/signed-thinking-differential.sh");
const name = "v1/primary/control/synthetic-todo/pass-0013.default.json";
const initial = [{ role: "user", content: [{ type: "text", text: "original" }] }];

function withInventories(body: (dir: string) => void) {
    const { dir, cleanup } = createTestTempDir("audit-differential-");
    try {
        for (const arm of ["base", "head"])
            for (const model of ["rejected", "prefix-bound"])
                record(dir, arm, model, name, initial);
        body(dir);
    } finally {
        cleanup();
    }
}

function record(
    dir: string,
    arm: string,
    model: string,
    file: string,
    wire: unknown,
    eligible = true,
) {
    const path = join(dir, arm, model, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
        path,
        JSON.stringify({
            wire,
            wireBytes: JSON.stringify(wire),
            identityEligible: eligible,
            eligibility: {
                defer: eligible,
                noBoundary: eligible,
                noParkedTrigger: true,
                validatingRecord: true,
            },
        }),
    );
}

function compare(dir: string) {
    const result = Bun.spawnSync(
        ["bash", script, "--compare-only", join(dir, "base"), join(dir, "head")],
        { windowsHide: true },
    );
    return { exit: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

describe("signed-thinking byte differential", () => {
    it("compares both model classes and explicitly lists new fixtures", () =>
        withInventories((dir) => {
            record(
                dir,
                "head",
                "prefix-bound",
                "v1/primary/new-fixture/todo/pass-0001.default.json",
                initial,
            );
            const result = compare(dir);
            expect(result.exit).toBe(0);
            expect(result.output).toContain(
                "ADDITION prefix-bound v1/primary/new-fixture/todo/pass-0001.default.json",
            );
            expect(result.output).toContain("Compared 2 wire files; PASS");
        }));

    it("rejects a missing baseline pass before comparing bytes", () =>
        withInventories((dir) => {
            record(
                dir,
                "base",
                "rejected",
                "v1/primary/control/synthetic-todo/pass-0014.default.json",
                initial,
            );
            const result = compare(dir);
            expect(result.exit).toBe(1);
            expect(result.output).toContain(
                "FAIL rejected missing v1/primary/control/synthetic-todo/pass-0014.default.json",
            );
        }));

    it("rejects an extra pass in an existing fixture", () =>
        withInventories((dir) => {
            record(
                dir,
                "head",
                "rejected",
                "v1/primary/control/synthetic-todo/pass-0014.default.json",
                initial,
            );
            expect(compare(dir).exit).toBe(1);
        }));

    it("does not let rejected models escape via HEAD eligibility", () =>
        withInventories((dir) => {
            record(
                dir,
                "head",
                "rejected",
                name,
                [{ role: "user", content: [{ type: "text", text: "changed" }] }],
                false,
            );
            const result = compare(dir);
            expect(result.exit).toBe(1);
            expect(result.output).toContain(`FAIL rejected changed ${name}`);
        }));

    it("skips noneligible prefix-bound wires but fences eligible byte edits", () =>
        withInventories((dir) => {
            const changed = [{ role: "user", content: [{ type: "text", text: "changed" }] }];
            record(dir, "head", "prefix-bound", name, changed, false);
            expect(compare(dir).exit).toBe(0);
            record(dir, "head", "prefix-bound", name, changed, true);
            expect(compare(dir).exit).toBe(1);
        }));

    it("lists only the named cut and thinking-only divergences", () =>
        withInventories((dir) => {
            const cut =
                "pi/primary/cut-new-turn/prefix-cut-moved-by-a-compartment-rewrite-that-keeps-the-cached-pair/pass-0014.strict.json";
            record(dir, "base", "prefix-bound", cut, initial);
            record(dir, "head", "prefix-bound", cut, [
                { role: "user", content: [{ type: "text", text: "changed cut" }] },
            ]);
            record(dir, "head", "prefix-bound", name, [
                ...initial,
                {
                    role: "assistant",
                    content: [{ type: "thinking", thinking: "old", signature: "signed" }],
                },
            ]);
            const result = compare(dir);
            expect(result.exit).toBe(0);
            expect(result.output).toContain(`EXCEPTION prefix-bound ${cut}: recorded cut`);
            expect(result.output).toContain(
                `EXCEPTION prefix-bound ${name}: thinking-only companion strip`,
            );
        }));

    it("does not waive rejected-class thinking or unrelated force-lane files", () =>
        withInventories((dir) => {
            record(dir, "head", "rejected", name, [
                ...initial,
                {
                    role: "assistant",
                    content: [{ type: "thinking", thinking: "old", signature: "signed" }],
                },
            ]);
            expect(compare(dir).exit).toBe(1);
            const force = "opencode-aisdk/primary/mid-loop/DropFull/pass-0017.default.json";
            record(dir, "base", "rejected", force, initial);
            record(dir, "head", "rejected", force, []);
            // The unrelated todo change still fails even beside a named force-latch exception.
            const result = compare(dir);
            expect(result.exit).toBe(1);
            expect(result.output).toContain(`EXCEPTION rejected ${force}: force-latch bookkeeping`);
            expect(result.output).toContain(`FAIL rejected changed ${name}`);
        }));
});
