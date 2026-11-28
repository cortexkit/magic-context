import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { createTestTempDir } from "../shared/test-temp-dir";
import type { HiddenChildHost, HiddenChildSetupBudget } from "./hidden-child-record";
import {
    hiddenRunPlacement,
    matchesHiddenRunLocation,
    supportsQuietHiddenChildren,
} from "./hidden-run-holder";

type CreateHolder = NonNullable<HiddenChildHost["createHolder"]>;

test("holder creation stops waiting at the holder's guard even if the host never answers", async () => {
    const { dir, cleanup } = createTestTempDir("oc2-holder-guard-");
    const entered = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    const deadline = Promise.withResolvers<never>();
    const timeout = new Error("holder creation timed out");
    let stage = "";
    const budget: HiddenChildSetupBudget = {
        get stage() {
            return stage;
        },
        setStage(value) {
            stage = value;
        },
        check() {},
        cleanupMs: 2_000,
        work: (start) => Promise.race([start(), deadline.promise]),
    };
    const placement = hiddenRunPlacement(
        async (input) => {
            entered.resolve();
            await answer.promise;
            return input;
        },
        dir,
        budget,
    );
    let refused: unknown;
    void placement.catch((error) => {
        refused = error;
    });
    try {
        await entered.promise;
        expect(stage).toBe("creating the background holder");
        deadline.reject(timeout);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(refused).toBe(timeout);
    } finally {
        answer.resolve();
        await placement.catch(() => {});
        cleanup();
    }
});

test.each([
    ["2.0.22", true],
    ["2.1.0", true],
    ["2.3.1", true],
    ["2.3.2", true],
    ["2.4.2", true],
    ["2.3.0", false],
    ["2.5.0-beta.1", false],
    ["0.0.0-dev-20358", false],
    [undefined, false],
] as const)("quiet hidden runs for version %p", (version, quiet) => {
    expect(supportsQuietHiddenChildren(version)).toBe(quiet);
});

test("holder and child location checks accept both Windows slash spellings", () => {
    const opencode = "D:/work/app";
    const plugin = "D:\\work\\app";
    expect(matchesHiddenRunLocation(plugin, opencode)).toBe(true);
    expect(matchesHiddenRunLocation(opencode, plugin)).toBe(true);
    expect(matchesHiddenRunLocation(plugin, "D:/work/elsewhere")).toBe(false);
    expect(matchesHiddenRunLocation(plugin, undefined)).toBe(false);
});

test("holder identity and host placement use the given location spelling", async () => {
    const { dir, cleanup } = createTestTempDir("oc2-holder-");
    try {
        const target = join(dir, "target");
        const link = join(dir, "link");
        mkdirSync(target);
        symlinkSync(target, link, "junction");
        const directories: string[] = [];
        const create: CreateHolder = async (input) => {
            directories.push(input.location.directory);
            return input;
        };
        const a = await hiddenRunPlacement(create, target);
        const b = await hiddenRunPlacement(create, link);
        const c = await hiddenRunPlacement(create, link);
        expect(directories).toEqual([target, link, link]);
        expect(a.parentID).not.toBe(b.parentID);
        expect(b.parentID).toBe(c.parentID);
        expect(b.id).not.toBe(c.id);
    } finally {
        cleanup();
    }
});

test("holder creation refuses a missing run directory without calling the host", async () => {
    const { dir, cleanup } = createTestTempDir("oc2-holder-");
    try {
        let calls = 0;
        await expect(
            hiddenRunPlacement(
                async (input) => {
                    calls++;
                    return input;
                },
                join(dir, "missing"),
            ),
        ).rejects.toThrow(/ENOENT/);
        expect(calls).toBe(0);
    } finally {
        cleanup();
    }
});

test("all three displaced holder candidates are reported without creating a child", async () => {
    const { dir, cleanup } = createTestTempDir("oc2-holder-");
    try {
        const ids: string[] = [];
        const create: CreateHolder = async (input) => {
            ids.push(input.id);
            return { ...input, location: { directory: join(dir, "elsewhere") } };
        };
        const error = await hiddenRunPlacement(create, dir).catch((error: Error) => error);
        expect(ids).toEqual([ids[0], `${ids[0]}_2`, `${ids[0]}_3`]);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
            `No background holder at ${dir}; displaced holders: ${ids.join(", ")}`,
        );
    } finally {
        cleanup();
    }
});

test("a host-normalized location does not make the holder look displaced", async () => {
    const { dir, cleanup } = createTestTempDir("oc2-holder-");
    try {
        const ids: string[] = [];
        const placement = await hiddenRunPlacement(async (input) => {
            ids.push(input.id);
            return { ...input, location: { directory: `${dir}${sep}` } };
        }, dir);
        expect(ids).toEqual([placement.parentID]);
    } finally {
        cleanup();
    }
});
