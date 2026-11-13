/**
 * Run `verify-run.ts` with the DeepSeek key from the CortexKit vault.
 *
 * The key is fetched with the live-provider harness's vault access
 * (`fetchCredential` in `packages/e2e-tests/src/live-providers/ckcred.ts`),
 * read as `calibrate.ts`'s `credentialToken` reads vault material, and
 * written only to the runner's standard input. It never reaches an
 * argument, the environment or a file.
 *
 *   bun packages/plugin/scripts/dreamer-replay/with-deepseek-key.ts -- \
 *     --request <out>/verify/batch-0/verify.request.json --checkout <path>
 */
import { join } from "node:path";

const CREDENTIAL = "apikey:deepseek";

/** The two vault helpers, loaded from the e2e package, which owns the vault client. */
interface Vault {
    fetchCredential(id: string): Promise<string>;
    credentialToken(material: string): string;
}

async function vault(): Promise<Vault> {
    const base = new URL("../../../e2e-tests/src/live-providers/", import.meta.url);
    const ckcred = (await import(new URL("ckcred.ts", base).href)) as Pick<Vault, "fetchCredential">;
    const calibrate = (await import(new URL("calibrate.ts", base).href)) as Pick<Vault, "credentialToken">;
    return { fetchCredential: ckcred.fetchCredential, credentialToken: calibrate.credentialToken };
}

if (import.meta.main) {
    const separator = process.argv.indexOf("--");
    const args = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
    const helpers = await vault();
    const key = helpers.credentialToken(await helpers.fetchCredential(CREDENTIAL));
    const child = Bun.spawn(["bun", join(import.meta.dir, "verify-run.ts"), ...args], {
        stdin: "pipe",
        stdout: "inherit",
        stderr: "inherit",
        windowsHide: true,
    });
    child.stdin.write(key);
    await child.stdin.end();
    process.exit(await child.exited);
}
