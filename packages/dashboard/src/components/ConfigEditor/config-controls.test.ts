import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toolDescriptionManifest } from "../../../scripts/config-manifests";
import manifest from "../../generated/tool-descriptions.json";
import { CONFIG_HELP, docsUrl } from "./config-help";
import { configDefault, defaultLabel } from "./config-schema";
import { LANGUAGE_CODES, LANGUAGE_OPTIONS } from "./languages";
import { editRoute } from "./route-edit";
import { editToolDescription, normalizeToolDescriptions } from "./tool-description-config";
import { qualifierOptions } from "./variant-options";

describe("config controls", () => {
  it("every help link includes the deployment base and targets an existing docs page", () => {
    const tree = resolve(import.meta.dir, "../../../../docs/src/content/docs");
    expect(Object.keys(CONFIG_HELP)).toHaveLength(7);
    for (const help of Object.values(CONFIG_HELP)) {
      const url = new URL(docsUrl(help.page));
      expect(url.origin).toBe("https://docs.cortexkit.io");
      expect(url.pathname.startsWith("/magic-context/")).toBe(true);
      const page = url.pathname.slice("/magic-context/".length).replace(/\/$/, "");
      expect(
        existsSync(resolve(tree, `${page}.md`)) || existsSync(resolve(tree, `${page}.mdx`)),
      ).toBe(true);
    }
  });

  it("generated tool descriptions match the active plugin tool definitions", () => {
    expect(manifest).toEqual(toolDescriptionManifest());
  });

  it("tool edits store only differences and reset preserves unknown tools", () => {
    const original = { future_tool: "leave me", ctx_search: "custom" };
    expect(editToolDescription(original, "ctx_search", manifest.ctx_search.full, "full")).toEqual({
      future_tool: "leave me",
    });
    expect(
      editToolDescription(undefined, "ctx_search", manifest.ctx_search.light, "light"),
    ).toBeUndefined();
    expect(editToolDescription(undefined, "ctx_search", "custom", "light")).toEqual({
      ctx_search: "custom",
    });
    expect(
      normalizeToolDescriptions({
        future: 42,
        prompt_surface: {
          default: "full",
          tool_descriptions: {
            ctx_search: manifest.ctx_search.full,
            ctx_memory: "custom",
            future_tool: "unknown",
          },
        },
      }),
    ).toEqual({
      future: 42,
      prompt_surface: {
        default: "full",
        tool_descriptions: { ctx_memory: "custom", future_tool: "unknown" },
      },
    });
  });

  it("route edits preserve wildcard routes, nested model IDs and unrelated routes", () => {
    expect(
      editRoute(
        { "openai/*": "full", "other/model": "light" },
        "openai/*",
        "openrouter/google/model",
        "light",
      ),
    ).toEqual({ "openrouter/google/model": "light", "other/model": "light" });
    expect(editRoute({ "openai/*": "full" }, "openai/*", "", "full")).toEqual({});
  });

  it("language choices are all ISO 639-1 codes with searchable names", () => {
    expect(LANGUAGE_CODES).toHaveLength(184);
    expect(new Set(LANGUAGE_CODES).size).toBe(184);
    expect(LANGUAGE_OPTIONS.find((option) => option.value === "tr")?.label).toBe("Turkish (tr)");
    expect(LANGUAGE_CODES.every((code) => /^[a-z]{2}$/.test(code))).toBe(true);
  });

  it("variant pickers use exact OpenCode keys and distinguish unknown from no variants", () => {
    expect(
      qualifierOptions("opencode", "provider/model", { "provider/model": ["deep", "fast"] }),
    ).toEqual({ values: ["deep", "fast"], known: true });
    expect(qualifierOptions("opencode", "provider/model", { "provider/model": [] })).toEqual({
      values: [],
      known: true,
    });
    expect(qualifierOptions("opencode", "unknown/model").known).toBe(false);
    expect(qualifierOptions("opencode", "unknown/model").values).toContain("high");
  });

  it("Pi qualifiers come from model thinking support, not OpenCode variants", () => {
    expect(qualifierOptions("pi", "openai/gpt-4o", { "openai/gpt-4o": ["high"] })).toEqual({
      values: ["off"],
      known: true,
    });
    expect(qualifierOptions("pi", "custom/local").known).toBe(false);
    expect(qualifierOptions("omp", "openai/gpt-4o").known).toBe(false);
  });

  it("all inherited boolean rows resolve to a default, including Auto Update", () => {
    const source = readFileSync(resolve(import.meta.dir, "ConfigEditor.tsx"), "utf8");
    const explicit = [...source.matchAll(/(?:booleanSetting|inheritedDefault)\("([^"]+)"\)/g)].map(
      (match) => match[1],
    );
    const generic = [
      ...source.matchAll(/key: "([^"]+)",\s+label: "[^"]+",\s+type: "boolean"/g),
    ].map((match) => match[1]);
    expect(generic.length).toBeGreaterThan(3);
    expect(explicit.length).toBeGreaterThan(20);
    for (const key of new Set([...explicit, ...generic])) {
      expect(typeof configDefault(key), key).toBe("boolean");
      expect(defaultLabel(key), key).not.toBe("undefined");
    }
    expect(configDefault("auto_update")).toBe(true);
    expect(defaultLabel("auto_update")).toBe("on");
  });
});
