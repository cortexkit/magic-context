import { describe, expect, test } from "bun:test";
import { NPM_REGISTRY_URL, resolveNpmRegistryUrl } from "./npm-registry";

describe("resolveNpmRegistryUrl", () => {
    test("uses public npm only when no registry is configured", () => {
        expect(resolveNpmRegistryUrl({})).toBe(NPM_REGISTRY_URL);
        expect(resolveNpmRegistryUrl({ npm_config_registry: " " })).toBe(NPM_REGISTRY_URL);
    });

    test("honors both npm environment spellings and trims trailing slashes", () => {
        expect(
            resolveNpmRegistryUrl({ npm_config_registry: " https://mirror.example/npm/// " }),
        ).toBe("https://mirror.example/npm");
        expect(resolveNpmRegistryUrl({ NPM_CONFIG_REGISTRY: "https://mirror.example/npm/" })).toBe(
            "https://mirror.example/npm",
        );
    });

    test("prefers a nonempty lowercase setting, as npm does", () => {
        expect(
            resolveNpmRegistryUrl({
                npm_config_registry: "https://lower.example",
                NPM_CONFIG_REGISTRY: "https://upper.example",
            }),
        ).toBe("https://lower.example");
        expect(
            resolveNpmRegistryUrl({
                npm_config_registry: " ",
                NPM_CONFIG_REGISTRY: "https://upper.example",
            }),
        ).toBe("https://upper.example");
    });

    test("does not replace an explicitly configured registry with public npm", () => {
        expect(resolveNpmRegistryUrl({ npm_config_registry: "not-a-valid-url" })).toBe(
            "not-a-valid-url",
        );
    });
});
