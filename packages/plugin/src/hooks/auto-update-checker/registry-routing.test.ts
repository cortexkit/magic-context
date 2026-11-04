import { afterEach, beforeEach, describe, expect, test } from "bun:test";

let importCounter = 0;
function freshChecker() {
    return import(`./checker.ts?registry-routing=${importCounter++}`);
}

const original = {
    npm_config_registry: process.env.npm_config_registry,
    NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY,
};
const servers: ReturnType<typeof Bun.serve>[] = [];

beforeEach(() => {
    delete process.env.npm_config_registry;
    delete process.env.NPM_CONFIG_REGISTRY;
});

afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    for (const server of servers.splice(0)) server.stop(true);
});

function registry(status = 200) {
    const requests: string[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            requests.push(new URL(request.url).pathname);
            return Response.json({ "dist-tags": { latest: "0.49.35" } }, { status });
        },
    });
    servers.push(server);
    return { url: `${server.url.origin}/npm/`, requests };
}

describe("update-check registry routing", () => {
    for (const key of ["npm_config_registry", "NPM_CONFIG_REGISTRY"]) {
        test(`fetches metadata through ${key}`, async () => {
            const { getLatestVersion } = await freshChecker();
            const mirror = registry();
            process.env[key] = mirror.url;
            expect(await getLatestVersion("latest", { timeoutMs: 1000 })).toBe("0.49.35");
            expect(mirror.requests).toEqual(["/npm/%40cortexkit/opencode-magic-context"]);
        });
    }

    test("preserves an explicit per-check registry override", async () => {
        const { getLatestVersion } = await freshChecker();
        const configured = registry();
        const override = registry();
        process.env.npm_config_registry = configured.url;
        expect(
            await getLatestVersion("latest", { registryUrl: override.url, timeoutMs: 1000 }),
        ).toBe("0.49.35");
        expect(configured.requests).toEqual([]);
        expect(override.requests).toHaveLength(1);
    });

    test("returns a failed mirror check without retrying public npm", async () => {
        const { getLatestVersion } = await freshChecker();
        const mirror = registry(503);
        process.env.npm_config_registry = mirror.url;
        const requested: string[] = [];
        const fetchImpl: typeof fetch = Object.assign(
            (async (...args: Parameters<typeof fetch>) => {
                requested.push(String(args[0]));
                return fetch(...args);
            }) as typeof fetch,
            { preconnect: fetch.preconnect },
        );
        expect(await getLatestVersion("latest", { fetch: fetchImpl, timeoutMs: 1000 })).toBeNull();
        expect(requested).toHaveLength(1);
        expect(requested[0]).toStartWith(mirror.url);
        expect(mirror.requests).toHaveLength(1);
    });
});
