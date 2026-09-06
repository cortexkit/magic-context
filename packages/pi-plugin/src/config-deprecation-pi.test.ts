/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPiConfig } from "./config";
import { __test, formatProtectedTagsDeprecationNotice } from "./index";

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

function makeTempRoot(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(path);
	return path;
}

function withHome(home: string): void {
	process.env.HOME = home;
	process.env.XDG_CONFIG_HOME = join(home, ".config");
}

function writeConfig(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text, "utf-8");
}

function writeProjectConfig(cwd: string, text: string): string {
	const path = join(cwd, ".cortexkit", "magic-context.jsonc");
	writeConfig(path, text);
	return path;
}

describe("Pi protected_tags deprecation surface (#421)", () => {
	beforeEach(() => {
		__test.resetClaimedProtectedTagsDeprecationNoticeForTesting();
	});

	afterEach(() => {
		__test.resetClaimedProtectedTagsDeprecationNoticeForTesting();
		if (originalHome !== undefined) {
			process.env.HOME = originalHome;
		}
		if (originalXdgConfigHome !== undefined) {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
		}
		for (const path of tempRoots.splice(0)) {
			try {
				rmSync(path, { recursive: true, force: true });
			} catch {
				// Ignore cleanup failures in test teardown
			}
		}
	});

	it("renders deprecation notice once per process on the Pi notice surface", () => {
		const claimedFirst = __test.claimProtectedTagsDeprecationNoticeOnce();
		expect(claimedFirst).toBe(true);

		const claimedSecond = __test.claimProtectedTagsDeprecationNoticeOnce();
		expect(claimedSecond).toBe(false);

		const noticeText = formatProtectedTagsDeprecationNotice();
		expect(noticeText).toContain("protected_tags");
		expect(noticeText).toContain("deprecated");
		expect(noticeText).toContain("protected_tokens");
	});

	it("behaves identically to key being absent with no numeric conversion", () => {
		const cwdWithKey = makeTempRoot("mc-dep-key-");
		const cwdAbsent = makeTempRoot("mc-dep-absent-");
		const home = makeTempRoot("mc-dep-home-");
		withHome(home);

		writeProjectConfig(cwdWithKey, JSON.stringify({ protected_tags: 42 }));
		writeProjectConfig(cwdAbsent, JSON.stringify({}));

		const loadedWithKey = loadPiConfig({ cwd: cwdWithKey });
		const loadedAbsent = loadPiConfig({ cwd: cwdAbsent });

		// Parse succeeds for both
		expect(loadedWithKey.configParseFailures).toHaveLength(0);
		expect(loadedAbsent.configParseFailures).toHaveLength(0);

		// Flag is true when present, false when absent
		expect(loadedWithKey.hasDeprecatedProtectedTags).toBe(true);
		expect(loadedAbsent.hasDeprecatedProtectedTags).toBeFalsy();

		// Behavior is identical to key being absent: no conversion of 42 to tokens
		// Neither loaded config creates a tokens property based on 42
		expect(
			(loadedWithKey.config as Record<string, unknown>).protected_tokens,
		).toBeUndefined();
		expect(
			(loadedAbsent.config as Record<string, unknown>).protected_tokens,
		).toBeUndefined();
	});
});
