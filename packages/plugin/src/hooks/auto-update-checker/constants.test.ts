import { describe, expect, test } from "bun:test";

import { CACHE_DIR, NPM_FETCH_TIMEOUT, NPM_REGISTRY_URL, PACKAGE_NAME } from "./constants";

describe("auto-update-checker/constants", () => {
    test("uses Magic Context package identity and npm defaults", () => {
        expect(PACKAGE_NAME).toBe("@cortexkit/opencode-magic-context");
        expect(NPM_REGISTRY_URL).toBe("https://registry.npmjs.org");
        expect(NPM_FETCH_TIMEOUT).toBe(10_000);
    });

    test("points at OpenCode packages cache", () => {
        expect(CACHE_DIR).toContain("opencode");
        expect(CACHE_DIR).toEndWith("packages");
    });
});
