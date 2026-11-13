import { expect, it } from "bun:test";
import { credentialToken, runCalibration, USAGE } from "./calibrate";

it("passes only one in-memory credential to the child, never argv or the parent environment", async () => {
    for (const material of ["fake-secret", '{"access_token":"fake-secret","refresh_token":"do-not-use"}', '{"access":"fake-secret"}', '{"accessToken":"fake-secret"}']) {
        const parent = { PATH: "fake-path", ANTHROPIC_API_KEY: "inherited-key", OPENAI_API_KEY: "other-key" };
        const requests: string[] = [];
        const status = await runCalibration(["oauth:anthropic", "ANTHROPIC_OAUTH_TOKEN", "--", "--only", "claude-fable-5-2"], {
            fetchCredential: async (id) => { requests.push(id); return material; },
            start: async (args, env) => {
                expect(args).toEqual(["--only", "claude-fable-5-2"]);
                expect(env).toEqual({ PATH: "fake-path", ANTHROPIC_OAUTH_TOKEN: "fake-secret" });
                return 37;
            },
        }, parent);
        expect(status).toBe(37);
        expect(requests).toEqual(["oauth:anthropic"]);
        expect(parent).toEqual({ PATH: "fake-path", ANTHROPIC_API_KEY: "inherited-key", OPENAI_API_KEY: "other-key" });
    }
});

it("validates the command before fetching any credential", async () => {
    let calls = 0;
    for (const args of [[], ["id", "PATH", "--"], ["id", "OPENAI_API_KEY", "not-a-separator"]]) {
        await expect(runCalibration(args, {
            fetchCredential: async () => { calls++; return "unused"; },
            start: async () => { calls++; return 0; },
        })).rejects.toThrow(USAGE);
    }
    expect(calls).toBe(0);
});

it("rejects empty or malformed material without echoing it", () => {
    for (const material of ["", "{fake-secret", '{"refresh_token":"fake-secret"}', '{"access_token":null}']) {
        try { credentialToken(material); throw new Error("unexpected success"); }
        catch (error) {
            expect(String(error)).not.toContain("fake-secret");
            expect(String(error)).not.toContain("unexpected success");
        }
    }
});
