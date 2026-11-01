import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestTempDirFromPath } from "../shared/test-temp-dir";

const fixture = join(import.meta.dir, "__tests__/committed-drop-review.fixture.ts");
function child(root: string, lane: string, mode: string, position: number, signed = false) {
    const result = spawnSync(
        process.execPath,
        [fixture, root, lane, mode, String(position), "719", signed ? "signed" : "plain"],
        {
            env: {
                ...process.env,
                OPENCODE_DB: undefined,
                MAGIC_CONTEXT_STORAGE_DIR: join(root, "store"),
                MAGIC_CONTEXT_TEST_DATA_DIR: root,
                XDG_CONFIG_HOME: root,
                XDG_DATA_HOME: root,
                BUN_JSC_useOMGJIT: "0",
            },
            windowsHide: true,
            encoding: "utf8",
            timeout: 45000,
            maxBuffer: 8 * 1024 * 1024,
        },
    );
    const line = result.stdout.split("\n").find((line) => line.startsWith("REVIEW_RESULT "));
    if (!line) throw new Error(result.stderr + result.stdout);
    return { ...result, proof: JSON.parse(line.slice(14)) };
}
function temporary() {
    const parent = join(tmpdir(), "magic-context");
    mkdirSync(parent, { recursive: true });
    return createTestTempDirFromPath(join(parent, "committed-drop-review-"));
}
for (const lane of ["oc1", "oc2", "pi"]) {
    for (const position of lane === "pi" ? [1, 2, 3, 4, 5] : [1, 2, 3]) {
        test.skipIf(process.platform === "win32")(
            `independent recovery ${lane} SIGKILL position ${position}: durable subset is already served; restart equals or refuses`,
            () => {
                const root = temporary();
                try {
                    const killed = child(root, lane, "kill", position);
                    expect(killed.signal, killed.stderr).toBe("SIGKILL");
                    const proof = killed.proof;
                    expect(proof.error).toBeUndefined();
                    const dropped = proof.state.tags.filter(
                        (row: unknown[]) => row[3] === "dropped",
                    );
                    // Pi commits native permissions and drops atomically, so a
                    // failed write cannot leave an unserved durable prefix.
                    expect(dropped).toHaveLength(lane === "pi" ? 0 : position - 1);
                    expect(proof.wire.split("independent tool result ".repeat(1200))).toHaveLength(
                        9 - dropped.length,
                    );
                    const restarted = child(root, lane, "restart", position);
                    expect(restarted.status, restarted.stderr).toBe(0);
                    // A dirty recovery fence may require a rebuilding pass after a crash.
                    // A refusal is safe; serving the old unreduced request is not.
                    if (restarted.proof.wire) expect(restarted.proof.equal).toBe(true);
                    else expect(restarted.proof.error).toBeDefined();
                    console.log(
                        `CRASH_RECOVERY ${lane} position=${position} restart=${restarted.proof.wire ? "equal" : "refused"}`,
                    );
                    expect(
                        restarted.proof.state.tags.filter((row: unknown[]) => row[3] === "dropped"),
                    ).toEqual(dropped);
                } finally {
                    rmSync(root, { recursive: true, force: true });
                }
            },
            100000,
        );
    }
}
// A reasoning signature covers the earlier messages as originally sent. Even
// when a drop was stored before a later write failed, recovery cannot change
// those messages and keep that signature.
for (const lane of ["oc1", "oc2", "pi"]) {
    test(`review signed-prefix ${lane}: committed subset must strip signed thinking or refuse`, () => {
        const root = temporary();
        try {
            const recovered = child(root, lane, "seed", 2, true);
            expect(recovered.status, recovered.stderr).toBe(0);
            // Pi's atomic commit retains the original signed prefix on failure;
            // OpenCode still exercises recovery of earlier per-drop commits.
            expect(
                recovered.proof.state.tags.filter((row: unknown[]) => row[3] === "dropped"),
            ).toHaveLength(lane === "pi" ? 0 : 1);
            expect(recovered.proof.before).toContain("independent-signature");
            if (!recovered.proof.wire) {
                expect(recovered.proof.error).toContain("This request was not sent");
                return;
            }
            const before = JSON.parse(recovered.proof.before) as unknown[];
            const after = JSON.parse(recovered.proof.wire) as unknown[];
            const prefix = (messages: unknown[]) =>
                JSON.stringify(
                    messages.slice(
                        0,
                        messages.findIndex((m) =>
                            JSON.stringify(m).includes("independent-signature"),
                        ),
                    ),
                );
            const changedPrefix = prefix(before) !== prefix(after);
            const keptSignature = recovered.proof.wire.includes("independent-signature");
            console.log(
                `SIGNED_RECOVERY ${lane} changed=${changedPrefix} keptSignature=${keptSignature}`,
            );
            expect(changedPrefix && keptSignature).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 60000);
}
