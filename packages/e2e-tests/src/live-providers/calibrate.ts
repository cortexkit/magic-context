/** Run calibration with one vault credential confined to the child's environment. */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { PROVIDER_VARIABLES } from "../../../plugin/scripts/calibrate-tokenizer/credentials";
import type { CredentialId } from "./ckcred";

export const USAGE = "bun packages/e2e-tests/src/live-providers/calibrate.ts <credential id> <env var name> -- <calibration args...>";
const variables = new Set(Object.values(PROVIDER_VARIABLES).flatMap((value) => value.split(" or ")));

/** Subscription records may contain a token object; API keys and bare tokens stay opaque. */
export function credentialToken(material: string): string {
    if (!material.trimStart().startsWith("{")) {
        if (!material.trim()) throw new Error("Vault returned empty credential material");
        return material;
    }
    let value: { access_token?: unknown; accessToken?: unknown; access?: unknown };
    try { value = JSON.parse(material); } catch { throw new Error("Vault returned invalid credential material"); }
    const token = value.access_token ?? value.accessToken ?? value.access;
    if (typeof token !== "string" || !token.trim()) throw new Error("Vault credential has no access token");
    return token;
}

interface Dependencies {
    fetchCredential: (id: CredentialId) => Promise<string>;
    start: (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
}

export async function runCalibration(args: string[], dependencies: Dependencies, env = process.env): Promise<number> {
    const [id, variable, separator, ...calibrationArgs] = args;
    if (!id || !variable || separator !== "--" || !variables.has(variable)) throw new Error(USAGE);
    // Do not let an inherited credential silently select a second provider or auth mode.
    const childEnv = { ...env };
    for (const name of variables) delete childEnv[name];
    const material = await dependencies.fetchCredential(id as CredentialId);
    childEnv[variable] = credentialToken(material);
    return dependencies.start(calibrationArgs, childEnv);
}

async function start(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL("../../../plugin/scripts/calibrate-tokenizer/index.ts", import.meta.url)), ...args], {
            env, stdio: "inherit", windowsHide: true,
        });
        child.once("error", () => reject(new Error("Could not start calibration child")));
        child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
    });
}

if (import.meta.main) {
    try {
        process.exitCode = await runCalibration(process.argv.slice(2), {
            fetchCredential: async (id) => (await import("./ckcred")).fetchCredential(id), start,
        });
    } catch {
        // Vault and process errors may contain material: never print their payloads.
        console.error(`Could not run calibration. Usage: ${USAGE}`);
        process.exitCode = 1;
    }
}
