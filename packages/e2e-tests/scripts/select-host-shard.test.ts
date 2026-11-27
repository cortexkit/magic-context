import { describe, expect, test } from "bun:test";
import { selectHostShard, type ShardedHost } from "./select-host-shard";
import { filesForMode, validateModeManifest } from "./validate-mode-manifest";

describe("host shard coverage", () => {
    for (const [host, count] of [["opencode", 4], ["opencode2", 3]] as const) {
        test(`${host} shards cover the manifest exactly once and exclude other lanes`, () => {
            const validation = validateModeManifest();
            const files = filesForMode(validation, "ts", host);
            const shards = Array.from({ length: count }, (_, index) => selectHostShard(host, `${index}/${count}`, validation));
            const selected = shards.flat();
            expect(selected.length).toBe(files.length);
            expect(new Set(selected).size).toBe(files.length);
            expect(selected.sort()).toEqual(files);
            expect(shards.every((shard) => shard.length > 0)).toBe(true);
            for (const entry of validation.manifest.entries) {
                if (!entry.invocation.ts || !entry.hosts.includes(host)) expect(selected).not.toContain(entry.path);
            }
            expect(selected).not.toContain("tests/opencode2/store-generation-conversion.test.ts");
            expect(selected).not.toContain("tests/opencode2/converted-store-overwindow.test.ts");
            expect(selected).not.toContain("tests/opencode2/marker-s3-runtime.test.ts");
        });
    }

    test("rejects invalid and empty host shard specifications", () => {
        for (const host of ["opencode", "opencode2"] as ShardedHost[]) {
            for (const spec of ["", "1", "4/4", "-1/4", "0/0", "0/999", "1/1/1"]) {
                expect(() => selectHostShard(host, spec)).toThrow();
            }
        }
    });
});
