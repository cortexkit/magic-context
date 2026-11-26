import { expect, test } from "bun:test";
import { devNull } from "node:os";
import { isolatedTestGitEnv } from "./test-git-env";

test("Git fixtures keep explicit settings without inheriting user configuration or repository paths", () => {
    const inherited = {
        GIT_CONFIG: "outer-config",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "outer-hooks",
        GIT_CONFIG_PARAMETERS: "'core.hooksPath=outer-hooks'",
        GIT_CONFIG_GLOBAL: "outer-global-config",
        GIT_DIR: "outer-repository/.git",
        GIT_WORK_TREE: "outer-repository",
        GIT_INDEX_FILE: "outer-index",
    };
    const keys = Object.keys(inherited);
    const original = keys.map((key) => process.env[key]);
    Object.assign(process.env, inherited);
    try {
        const env = isolatedTestGitEnv({ GIT_AUTHOR_DATE: "@1 +0000" });
        expect(
            Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("GIT_"))),
        ).toEqual({
            GIT_CONFIG_GLOBAL: devNull,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_DATE: "@1 +0000",
        });
        expect(env.PATH).toBe(process.env.PATH);
        expect(process.env.GIT_DIR).toBe(inherited.GIT_DIR);
    } finally {
        for (const [index, key] of keys.entries()) {
            const value = original[index];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
