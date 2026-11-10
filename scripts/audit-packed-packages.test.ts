import { describe, expect, it } from "bun:test";
import { type AuditReport, classifyHighFindings } from "./audit-packed-packages";

const ROOT = "@cortexkit/opencode-magic-context";
const advisory = (id: string) => ({
    source: 1,
    title: "toml-node advisory",
    url: `https://github.com/advisories/${id}`,
});
const TOML_ADVISORIES = ["GHSA-4qx8-w7c3-pj3p", "GHSA-9j65-hcg3-gc64", "GHSA-9qmh-m7c6-f92p"].map(
    advisory,
);

/** The shape npm audit reported for the packed plugin on 2026-10-23. */
function tomlChain(): NonNullable<AuditReport["vulnerabilities"]> {
    return {
        toml: { severity: "high", via: [...TOML_ADVISORIES] },
        effect: { severity: "high", via: ["toml"] },
        "@opencode-ai/plugin": { severity: "high", via: ["effect"] },
        [ROOT]: { severity: "high", via: ["@opencode-ai/plugin"] },
    };
}

describe("packed audit exceptions", () => {
    it("accepts the documented toml advisories along OpenCode's plugin path", () => {
        const result = classifyHighFindings({ vulnerabilities: tomlChain() }, ROOT);
        expect(result.refused).toEqual([]);
        expect(result.accepted).toHaveLength(4);
        expect(result.unusedExceptions).toEqual(["zod", "effect"]);
    });

    it("refuses a toml advisory that is not on the list", () => {
        const vulnerabilities = tomlChain();
        vulnerabilities.toml = {
            severity: "high",
            via: [...TOML_ADVISORIES, advisory("GHSA-0000-0000-0000")],
        };
        const result = classifyHighFindings({ vulnerabilities }, ROOT);
        expect(result.refused).toContain("toml (high)");
        expect(result.refused).toContain(`${ROOT} (high)`);
    });

    it("refuses a new advisory on a package along the path", () => {
        const vulnerabilities = tomlChain();
        vulnerabilities.effect = { severity: "high", via: ["toml", advisory("GHSA-1111-1111-1111")] };
        const result = classifyHighFindings({ vulnerabilities }, ROOT);
        expect(result.refused).toContain("effect (high)");
        expect(result.refused).toContain("@opencode-ai/plugin (high)");
        expect(result.refused).toContain(`${ROOT} (high)`);
    });

    it("refuses toml reached through a package outside the documented path", () => {
        const vulnerabilities = tomlChain();
        vulnerabilities["some-other-dependency"] = { severity: "high", via: ["toml"] };
        vulnerabilities[ROOT] = { severity: "high", via: ["@opencode-ai/plugin", "some-other-dependency"] };
        const result = classifyHighFindings({ vulnerabilities }, ROOT);
        expect(result.refused).toContain("some-other-dependency (high)");
        expect(result.refused).toContain(`${ROOT} (high)`);
    });

    it("refuses an unrelated critical finding", () => {
        const vulnerabilities = { ...tomlChain(), lodash: { severity: "critical", via: [advisory("GHSA-x")] } };
        const result = classifyHighFindings({ vulnerabilities }, ROOT);
        expect(result.refused).toEqual(["lodash (critical)"]);
    });

    it("reports an exception that no longer matches anything", () => {
        const result = classifyHighFindings({ vulnerabilities: {} }, ROOT);
        expect(result.accepted).toEqual([]);
        expect(result.refused).toEqual([]);
        expect(result.unusedExceptions).toEqual(["toml", "zod", "effect"]);
    });

    /** The shape npm audit reported for the packed plugin on 2026-11-10. */
    const effectCookieAdvisory = (range = ">=4.0.0-beta.0 <4.0.0-beta.103") => ({
        source: 2,
        title: "Effect: Cookie attribute injection",
        url: "https://github.com/advisories/GHSA-chp3-j5qr-2vfr",
        severity: "moderate",
        range,
    });

    it("effect exception accepts its own advisory together with the toml path", () => {
        const vulnerabilities = tomlChain();
        vulnerabilities.effect = { severity: "high", via: [effectCookieAdvisory(), "toml"] };
        const result = classifyHighFindings({ vulnerabilities }, ROOT);
        expect(result.refused).toEqual([]);
        expect(result.accepted).toHaveLength(4);
        expect(result.unusedExceptions).toEqual(["zod"]);
    });

    it("effect exception refuses a widened advisory range", () => {
        const vulnerabilities = tomlChain();
        vulnerabilities.effect = {
            severity: "high",
            via: [effectCookieAdvisory(">=4.0.0-beta.0 <4.0.0-rc.120"), "toml"],
        };
        const result = classifyHighFindings({ vulnerabilities }, ROOT);
        expect(result.refused).toContain("effect (high)");
        expect(result.refused).toContain(`${ROOT} (high)`);
    });

    it("effect exception does not cover a second advisory or an unaccepted dependency", () => {
        const second = tomlChain();
        second.effect = {
            severity: "high",
            via: [effectCookieAdvisory(), advisory("GHSA-1111-1111-1111"), "toml"],
        };
        expect(classifyHighFindings({ vulnerabilities: second }, ROOT).refused).toContain("effect (high)");

        const otherDependency = tomlChain();
        otherDependency.effect = { severity: "high", via: [effectCookieAdvisory(), "toml", "some-parser"] };
        otherDependency["some-parser"] = { severity: "high", via: [advisory("GHSA-2222-2222-2222")] };
        expect(classifyHighFindings({ vulnerabilities: otherDependency }, ROOT).refused).toContain("effect (high)");

        const newToml = tomlChain();
        newToml.toml = { severity: "high", via: [...TOML_ADVISORIES, advisory("GHSA-0000-0000-0000")] };
        newToml.effect = { severity: "high", via: [effectCookieAdvisory(), "toml"] };
        expect(classifyHighFindings({ vulnerabilities: newToml }, ROOT).refused).toContain("effect (high)");
    });

    it("zod exception accepts only its documented advisory", () => {
        const chain = () => ({
            ...tomlChain(),
            zod: {
                severity: "high",
                via: [advisory("GHSA-mrhx-c7xc-m3w5")],
                nodes: ["node_modules/@opencode-ai/plugin/node_modules/zod"],
            },
            "@opencode-ai/plugin": { severity: "high", via: ["effect", "zod"] },
        });
        const accepted = classifyHighFindings({ vulnerabilities: chain() }, ROOT);
        expect(accepted.refused).toEqual([]);
        expect(accepted.accepted).toHaveLength(5);
        expect(accepted.unusedExceptions).toEqual(["effect"]);
        for (const name of ["zod", "@opencode-ai/plugin", ROOT]) {
            const vulnerabilities: NonNullable<AuditReport["vulnerabilities"]> = chain();
            vulnerabilities[name].via?.push(advisory("GHSA-new-advisory"));
            const result = classifyHighFindings({ vulnerabilities }, ROOT);
            expect(result.refused).toContain(`${name} (high)`);
            expect(result.refused).toContain(`${ROOT} (high)`);
        }
        const vulnerabilities = { ...chain(), unrelated: { severity: "critical", via: [advisory("GHSA-new")] } };
        expect(classifyHighFindings({ vulnerabilities }, ROOT).refused).toEqual(["unrelated (critical)"]);
    });

    it("zod exception accepts only OpenCode's nested dependency path", () => {
        const chain = (): NonNullable<AuditReport["vulnerabilities"]> => ({
            zod: {
                severity: "high",
                via: [advisory("GHSA-mrhx-c7xc-m3w5")],
                nodes: ["node_modules/@opencode-ai/plugin/node_modules/zod"],
            },
            "@opencode-ai/plugin": { severity: "high", via: ["zod"] },
            [ROOT]: { severity: "high", via: ["@opencode-ai/plugin"] },
        });
        for (const nodes of [
            [],
            ["node_modules/zod"],
            ["node_modules/some-other-dependency/node_modules/zod"],
            ["node_modules/@opencode-ai/plugin/node_modules/zod", "node_modules/zod"],
        ]) {
            const vulnerabilities = chain();
            vulnerabilities.zod.nodes = nodes;
            const result = classifyHighFindings({ vulnerabilities }, ROOT);
            expect(result.refused).toContain("zod (high)");
            expect(result.refused).toContain(`${ROOT} (high)`);
        }
        const missingNodes = chain();
        delete missingNodes.zod.nodes;
        expect(classifyHighFindings({ vulnerabilities: missingNodes }, ROOT).refused).toContain("zod (high)");
        for (const via of [["zod"], ["@opencode-ai/plugin", "zod"], ["some-other-dependency"]]) {
            const vulnerabilities = chain();
            vulnerabilities[ROOT].via = via;
            vulnerabilities["some-other-dependency"] = { severity: "high", via: ["zod"] };
            expect(classifyHighFindings({ vulnerabilities }, ROOT).refused).toContain(`${ROOT} (high)`);
        }
        const fixed = chain();
        delete fixed.zod;
        delete fixed["@opencode-ai/plugin"];
        delete fixed[ROOT];
        expect(classifyHighFindings({ vulnerabilities: fixed }, ROOT).unusedExceptions).toContain("zod");
    });
});
