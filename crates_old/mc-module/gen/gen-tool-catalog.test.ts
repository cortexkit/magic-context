import { describe, expect, test } from "bun:test";
import { answer, checkPlanMagicContext, compactsSession, EXAMPLE_CONFIG, parsePreset } from "./gen-tool-catalog";
import type { Json, JsonObject } from "./gen-tool-catalog";

describe("role catalogs", () => {
    const head = ["ctx_reduce", "ctx_expand", "ctx_note", "ctx_memory", "ctx_search"];
    const helper = ["ctx_reduce", "ctx_expand", "ctx_search"];
    const toolsOnly = ["ctx_note", "ctx_memory", "ctx_search"];
    for (const preset of ["head", "worker", "reader"]) {
        for (const provider of [undefined, "other-module", "magic-context"]) {
            test(`${preset} with ${provider ?? "no"} compaction`, () => {
                const compacting = provider === "magic-context";
                const names = compacting ? preset === "head" ? head : helper : preset === "head" ? toolsOnly : [];
                const composition = { providers: [{ provider: "magic-context", tools: names.map((name) => ({ name })) }],
                    ...(provider ? { compaction: { provider } } : {}) };
                const reply = answer({ preset, params: {}, composition, system_text: { preset, params: {} } }, EXAMPLE_CONFIG);
                expect((reply.tools as { name: string }[]).map((tool) => tool.name)).toEqual(names);
                const userCommands = reply.user_commands as { name: string }[] | undefined;
                if (compacting && preset === "head") {
                    expect(userCommands?.map((command) => command.name)).toEqual([
                        "ctx-status",
                        "ctx-flush",
                        "ctx-wrapup",
                    ]);
                } else {
                    expect(reply.user_commands).toBeUndefined();
                }
                const text = (reply.system_text as { text: string }).text;
                if (!compacting && preset !== "head") expect(text).toBe("");
                else expect(text).not.toBe("");
                if (compacting && preset !== "head") {
                    expect(text).not.toContain("ctx_memory");
                    expect(text).not.toContain("ctx_note");
                }
            });
        }
    }
    test("aliases name roles, never select compaction", () => {
        for (const [alias, role] of [["primary", "head"], ["subagent", "worker"], ["tools-only", "head"]] as const) {
            expect(parsePreset(alias)).toBe(role);
            for (const compacting of [false, true]) {
                const names = compacting ? role === "head" ? head : helper : role === "head" ? toolsOnly : [];
                const composition = { providers: [{ provider: "magic-context", tools: names.map((name) => ({ name })) }],
                    ...(compacting ? { compaction: { provider: "magic-context" } } : {}) };
                const request = { preset: alias, params: {}, composition, system_text: { preset: role, params: {} } };
                const actual = answer(request, EXAMPLE_CONFIG);
                const expected = answer({ ...request, preset: role }, EXAMPLE_CONFIG);
                expect(actual).toEqual(expected);
            }
        }
    });
    test("catalog refuses an unknown preset by name", () => {
        expect(() => answer({ preset: "mason", params: {} }, EXAMPLE_CONFIG)).toThrow('invalid_request {field: "preset"}: Magic Context defines no preset "mason"');
        expect(() => answer({ preset: "head", params: {}, system_text: { preset: "mason", params: {} } }, EXAMPLE_CONFIG))
            .toThrow('invalid_request {field: "preset"}: Magic Context defines no preset "mason"');
    });
    test("compaction is optional but never null or malformed", () => {
        expect(compactsSession()).toBe(false);
        const invalid: Json[] = [null, {}, { provider: "" }, "magic-context", []];
        for (const compaction of invalid) {
            expect(() => compactsSession({ compaction })).toThrow("composition.compaction");
        }
    });
});

describe("fetch-plan compatibility fence", () => {
    test("plan refuses a Magic Context preset it does not serve", () => {
        for (const key of ["tool_items", "system_text_items", "step_transform_items"]) {
            expect(() => checkPlanMagicContext({ [key]: [{ provider: "magic-context", preset: "unserved", params: {} }] }))
                .toThrow('invalid_request {field: "preset"}: Magic Context defines no preset "unserved"');
        }
    });
    test("plan refuses non-compacting Magic Context worker and reader items", () => {
        for (const preset of ["worker", "reader", "subagent"]) {
            for (const key of ["tool_items", "system_text_items", "step_transform_items"]) {
                const compositions: JsonObject[] = [{}, { compaction: { provider: "other-module" } }];
                for (const composition of compositions) {
                    expect(() => checkPlanMagicContext({ composition, [key]: [{ provider: "magic-context", preset, params: {} }] }))
                        .toThrow("without Magic Context compaction: omit the item");
                }
            }
        }
    });
    test("plan accepts head, compacting helpers and omitted helper items", () => {
        checkPlanMagicContext({ tool_items: [{ provider: "magic-context", preset: "head", params: {} }] });
        for (const preset of ["worker", "reader"]) {
            checkPlanMagicContext({ composition: { compaction: { provider: "magic-context" } },
                tool_items: [{ provider: "magic-context", preset, params: {} }] });
            checkPlanMagicContext({ tool_items: [{ provider: "aft", preset, params: {} }] });
        }
    });
});
