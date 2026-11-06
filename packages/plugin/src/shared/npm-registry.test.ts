import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NPM_REGISTRY_URL, resolveNpmRegistryUrl, resolveUserNpmrcPath } from "./npm-registry";
import { createTestTempDirFromPath } from "./test-temp-dir";

const PACKAGE = "@cortexkit/opencode-magic-context";

/** An isolated home, so the developer's own .npmrc never leaks in. */
function sandbox(user?: string) {
    const root = createTestTempDirFromPath(join(tmpdir(), "mc-npm-registry-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    if (user !== undefined) writeFileSync(join(home, ".npmrc"), user);
    return { root, home, env: { HOME: home } as NodeJS.ProcessEnv };
}

describe("resolveNpmRegistryUrl", () => {
    test("uses public npm only when nothing is configured", () => {
        const { env } = sandbox();
        expect(resolveNpmRegistryUrl(env)).toBe(NPM_REGISTRY_URL);
        expect(resolveNpmRegistryUrl({ ...env, npm_config_registry: " " })).toBe(NPM_REGISTRY_URL);
    });

    test("honors both npm environment spellings and trims trailing slashes", () => {
        const { env } = sandbox();
        expect(
            resolveNpmRegistryUrl({
                ...env,
                npm_config_registry: " https://mirror.example/npm/// ",
            }),
        ).toBe("https://mirror.example/npm");
        expect(
            resolveNpmRegistryUrl({ ...env, NPM_CONFIG_REGISTRY: "https://mirror.example/npm/" }),
        ).toBe("https://mirror.example/npm");
    });

    test("prefers a nonempty lowercase setting, as npm does", () => {
        const { env } = sandbox();
        expect(
            resolveNpmRegistryUrl({
                ...env,
                npm_config_registry: "https://lower.example",
                NPM_CONFIG_REGISTRY: "https://upper.example",
            }),
        ).toBe("https://lower.example");
    });

    test("does not replace an explicitly configured registry with public npm", () => {
        const { env } = sandbox();
        expect(resolveNpmRegistryUrl({ ...env, npm_config_registry: "not-a-valid-url" })).toBe(
            "not-a-valid-url",
        );
    });

    test("reads the user .npmrc", () => {
        const { env } = sandbox("registry=https://user.example/npm/\n");
        expect(resolveNpmRegistryUrl(env)).toBe("https://user.example/npm");
    });

    test("honors both userconfig spellings instead of ~/.npmrc", () => {
        const { env, root } = sandbox("registry=https://home.example\n");
        const custom = join(root, "custom.npmrc");
        writeFileSync(custom, "registry=https://custom.example\n");
        for (const key of ["npm_config_userconfig", "NPM_CONFIG_USERCONFIG"]) {
            expect(resolveUserNpmrcPath({ ...env, [key]: custom })).toBe(custom);
            expect(resolveNpmRegistryUrl({ ...env, [key]: custom })).toBe("https://custom.example");
        }
    });

    test("keeps the environment ahead of the user .npmrc", () => {
        const { env } = sandbox(
            "registry=https://user.example\n@cortexkit:registry=https://user-scoped.example\n",
        );
        expect(
            resolveNpmRegistryUrl(
                { ...env, npm_config_registry: "https://env.example" },
                { packageName: PACKAGE },
            ),
        ).toBe("https://env.example");
    });

    test("prefers the scoped registry within each source", () => {
        const { env } = sandbox(
            "registry=https://default.example\n@cortexkit:registry=https://scoped.example/\n",
        );
        expect(resolveNpmRegistryUrl(env, { packageName: PACKAGE })).toBe("https://scoped.example");
        expect(resolveNpmRegistryUrl(env, { packageName: "left-pad" })).toBe(
            "https://default.example",
        );
        expect(resolveNpmRegistryUrl(env, { packageName: "@other/pkg" })).toBe(
            "https://default.example",
        );
        expect(
            resolveNpmRegistryUrl(
                {
                    ...env,
                    npm_config_registry: "https://env.example",
                    "npm_config_@cortexkit:registry": "https://env-scoped.example",
                },
                { packageName: PACKAGE },
            ),
        ).toBe("https://env-scoped.example");
    });

    test("never reads a project .npmrc", () => {
        const { env, root } = sandbox("registry=https://user.example\n");
        const project = join(root, "project");
        mkdirSync(project);
        writeFileSync(join(project, "package.json"), "{}");
        writeFileSync(join(project, ".npmrc"), "registry=https://attacker.example\n");
        const previous = process.cwd();
        process.chdir(project);
        try {
            expect(resolveNpmRegistryUrl(env, { packageName: PACKAGE })).toBe(
                "https://user.example",
            );
        } finally {
            process.chdir(previous);
        }
    });

    test("expands ${VAR} and skips a value whose variable is unset", () => {
        const { env } = sandbox("registry=${MIRROR_URL}/npm/\n");
        expect(resolveNpmRegistryUrl({ ...env, MIRROR_URL: "https://expanded.example" })).toBe(
            "https://expanded.example/npm",
        );
        expect(resolveNpmRegistryUrl(env)).toBe(NPM_REGISTRY_URL);
    });

    test("strips inline comments as npm's ini parser does", () => {
        for (const [line, expected] of [
            [
                "registry=https://mirror.example/npm/ # corporate mirror",
                "https://mirror.example/npm",
            ],
            ["registry=https://mirror.example/npm/;comment", "https://mirror.example/npm"],
            ['registry="https://mirror.example/a#b"', "https://mirror.example/a#b"],
            [String.raw`registry=https://mirror.example/a\#b`, "https://mirror.example/a#b"],
        ]) {
            const { env } = sandbox(`${line}\n`);
            expect(resolveNpmRegistryUrl(env)).toBe(expected);
        }
    });

    test("ignores comment lines, sections, quotes and unrelated keys", () => {
        const { env } = sandbox(
            [
                "; registry=https://commented.example",
                "# registry=https://hashed.example",
                "//user.example/:_authToken=secret-token",
                "always-auth=true",
                'registry = "https://quoted.example/"',
                "[section]",
            ].join("\n"),
        );
        expect(resolveNpmRegistryUrl(env)).toBe("https://quoted.example");
    });

    test("falls back past an unreadable user file", () => {
        const { env } = sandbox();
        expect(resolveNpmRegistryUrl(env, { readFile: () => null })).toBe(NPM_REGISTRY_URL);
    });
});
