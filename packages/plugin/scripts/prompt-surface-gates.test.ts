import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    builtInLightMappingAssets,
    validateChecklist,
} from "./check-prompt-surface";
import {
    RATIFIED_FULL_MUTABLE_PROSE_CEILING,
    RATIFIED_LIGHT_MUTABLE_PROSE_CEILING,
    validateBudgetFixture,
} from "./prompt-surface-fixture";
import { builtInLightSurface } from "./prompt-surface-measurement";
import { renderChecklist } from "./render-prompt-surface-checklist";

const rootDir = resolve(import.meta.dir, "../../..");
const fixturePath = resolve(rootDir, "docs/specs/prompt-surface/budget-fixture.json");
const checklistPath = resolve(rootDir, "docs/specs/prompt-surface/checklist.json");
const renderedChecklistPath = resolve(rootDir, "docs/specs/prompt-surface/load-bearing-rules-checklist.md");

function withTempDir<T>(run: (directory: string) => T): T {
    const directory = mkdtempSync(join("/tmp", "prompt-surface-gate-"));
    try {
        return run(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

describe("prompt-surface CI gates", () => {
    test("fixture baseline drift is a red gate", () => {
        withTempDir((directory) => {
            const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
                mutableProseBaseline: number;
            };
            fixture.mutableProseBaseline += 1;
            const mutatedPath = join(directory, "budget-fixture.json");
            writeFileSync(mutatedPath, JSON.stringify(fixture));

            const result = validateBudgetFixture({ fixturePath: mutatedPath });
            expect(result.errors.some((error) => error.includes("mutable-prose baseline drifted"))).toBe(true);
        });
    });

    test("ratified ceiling literals cannot be raised through fixture edits", () => {
        withTempDir((directory) => {
            const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
                integerLightCeiling: number;
            };
            fixture.integerLightCeiling = 99_999;
            const mutatedPath = join(directory, "budget-fixture.json");
            writeFileSync(mutatedPath, JSON.stringify(fixture));

            const result = validateBudgetFixture({ fixturePath: mutatedPath });
            expect(result.errors.some((error) => error.includes(`ratified literal ${RATIFIED_LIGHT_MUTABLE_PROSE_CEILING}`))).toBe(
                true,
            );
        });
    });

    test("a light candidate above the ceiling is a red gate", () => {
        withTempDir((directory) => {
            const lightPath = join(directory, "light-surface.json");
            const longText = "inflate light guidance ".repeat(2_000);
            const mutated = builtInLightSurface();
            mutated.guidance = longText;
            writeFileSync(lightPath, JSON.stringify(mutated));

            const result = validateBudgetFixture({ fixturePath, lightSurfacePath: lightPath });
            expect(
                result.errors.some(
                    (error) =>
                        error.includes("light guidance + full descriptions") &&
                        error.includes(`exceeds ceiling ${RATIFIED_FULL_MUTABLE_PROSE_CEILING}`),
                ),
            ).toBe(true);
            expect(
                result.errors.some(
                    (error) =>
                        error.includes("light guidance + light descriptions") &&
                        error.includes(`exceeds ceiling ${RATIFIED_LIGHT_MUTABLE_PROSE_CEILING}`),
                ),
            ).toBe(true);
        });
    });

    test("gates every real guidance and registration-description combination", () => {
        const result = validateBudgetFixture({ fixturePath });
        expect(result.errors).toEqual([]);
        expect(
            result.messages.some((message) =>
                message.includes("serving matrix light guidance + full descriptions"),
            ),
        ).toBe(true);
        expect(
            result.messages.filter((message) => message.includes("Claude Code light guidance")),
        ).toHaveLength(2);
    });

    test("an oversized Claude Code light asset is a red gate", () => {
        withTempDir((directory) => {
            const assetPath = join(directory, "guidance_light_primary.txt");
            writeFileSync(assetPath, "inflate Claude Code guidance ".repeat(2_000));

            const result = validateBudgetFixture({
                fixturePath,
                ccLightAssetPaths: [assetPath],
            });
            expect(
                result.errors.some(
                    (error) =>
                        error.includes("Claude Code light guidance") &&
                        error.includes(`exceeds ceiling ${RATIFIED_LIGHT_MUTABLE_PROSE_CEILING}`),
                ),
            ).toBe(true);
        });
    });

    test("the committed light mapping resolves every compressed checklist rule", () => {
        const result = validateChecklist(checklistPath);
        expect(result.errors).toEqual([]);
        expect(result.messages.some((message) => message.includes("resolved 40"))).toBe(true);
    });

    test("deleting a mapped light line is a red mapping gate", () => {
        const assets = builtInLightMappingAssets();
        const mappedLine = assets["guidance:primary"]
            .split("\n")
            .find((line) => line.startsWith("In primary sessions with ctx_reduce"));
        if (!mappedLine) throw new Error("mapped primary tag line is missing from the test fixture");
        assets["guidance:primary"] = assets["guidance:primary"]
            .split("\n")
            .filter((line) => line !== mappedLine)
            .join("\n");

        const result = validateChecklist(checklistPath, { lightAssets: assets });
        expect(result.errors.some((error) => error.includes("quote does not resolve"))).toBe(true);
    });

    test("rendered checklist matches the machine-readable artifact", () => {
        const checklist = JSON.parse(readFileSync(checklistPath, "utf8"));
        expect(renderChecklist(checklist)).toBe(readFileSync(renderedChecklistPath, "utf8"));
    });

    test("an orphaned fragment is a red completeness gate", () => {
        withTempDir((directory) => {
            const checklist = JSON.parse(readFileSync(checklistPath, "utf8")) as {
                fragments: Record<string, unknown>;
            };
            checklist.fragments.orphan = checklist.fragments["guidance-long-term-frame"];
            const mutatedPath = join(directory, "checklist.json");
            writeFileSync(mutatedPath, JSON.stringify(checklist));

            const result = validateChecklist(mutatedPath);
            expect(
                result.errors.some((error) => error.includes("fragment orphan is not referenced")),
            ).toBe(true);
        });
    });

    test("deleting a checklist entry is a red completeness gate", () => {
        withTempDir((directory) => {
            const checklist = JSON.parse(readFileSync(checklistPath, "utf8")) as {
                rules: Array<{ id: string }>;
            };
            checklist.rules.pop();
            const mutatedPath = join(directory, "checklist.json");
            writeFileSync(mutatedPath, JSON.stringify(checklist));

            const result = validateChecklist(mutatedPath);
            expect(result.errors.some((error) => error.includes("checklist entries missing"))).toBe(true);
        });
    });
});
