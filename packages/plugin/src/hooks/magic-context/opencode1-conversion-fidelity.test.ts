/// <reference types="bun-types" />

/**
 * The OpenCode 1 conversion the provider-visible tests run is a verbatim copy
 * of upstream source (opencode1-to-model-messages.fixture.ts). These tests fail
 * if the copy is edited, and, where an OpenCode checkout is available, if it no
 * longer matches upstream at the pinned tag.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    assembleOpencode1Excerpt,
    OPENCODE1_COMMIT,
    OPENCODE1_EXCERPT_SHA256,
    OPENCODE1_SOURCES,
    OPENCODE1_TAG,
    readOpencode1Excerpt,
} from "./opencode1-to-model-messages.fixture";

/** An OpenCode checkout to compare against: OPENCODE_SOURCE_DIR, or the usual local clone. */
function opencodeCheckout(): string | undefined {
    const candidates = [process.env.OPENCODE_SOURCE_DIR, join(homedir(), "Work/OSS/opencode")];
    for (const candidate of candidates) {
        if (!candidate || !existsSync(join(candidate, ".git"))) continue;
        try {
            const commit = execFileSync(
                "git",
                ["-C", candidate, "rev-parse", `${OPENCODE1_TAG}^{commit}`],
                {
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "ignore"],
                    windowsHide: true,
                },
            ).trim();
            if (commit === OPENCODE1_COMMIT) return candidate;
        } catch {
            // Not a checkout holding the tag.
        }
    }
    return undefined;
}

describe("vendored OpenCode 1 conversion", () => {
    it("is the pinned excerpt, byte for byte", () => {
        const text = readOpencode1Excerpt();
        expect(createHash("sha256").update(text).digest("hex")).toBe(OPENCODE1_EXCERPT_SHA256);
        expect(text).toContain("export const toModelMessagesEffect = Effect.fnUntraced");
        expect(text).toContain(
            'export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:"',
        );
    });

    const checkout = opencodeCheckout();
    it.skipIf(!checkout)("matches upstream at the pinned tag", () => {
        const dir = checkout as string;
        const git = (args: string[]) =>
            execFileSync("git", ["-C", dir, ...args], {
                encoding: "utf8",
                maxBuffer: 64 * 1024 * 1024,
                windowsHide: true,
            });
        for (const source of Object.values(OPENCODE1_SOURCES)) {
            expect(git(["rev-parse", `${OPENCODE1_TAG}:${source.path}`]).trim()).toBe(source.blob);
        }
        const upstream = assembleOpencode1Excerpt((path) =>
            git(["show", `${OPENCODE1_TAG}:${path}`]),
        );
        expect(upstream).toBe(readOpencode1Excerpt());
    });
});
