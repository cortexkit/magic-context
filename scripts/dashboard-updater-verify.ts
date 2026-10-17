#!/usr/bin/env bun
/**
 * Verify a dashboard release file against its Tauri updater signature.
 *
 * Usage: bun scripts/dashboard-updater-verify.ts <file> <signature-file>
 *
 * The public key is always read from `plugins.updater.pubkey` in
 * packages/dashboard/src-tauri/tauri.conf.json (the key the in-app updater
 * trusts), and the check runs the same `verifyTauriSignature` the CLI's
 * `setup` dashboard installer uses. So a file that passes here is one both the
 * updater and the installer accept. Exits non-zero with the reason otherwise.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyTauriSignature } from "../packages/cli/src/lib/dashboard-install";

const [filePath, signaturePath] = process.argv.slice(2);
if (!filePath || !signaturePath) {
    console.error("usage: bun scripts/dashboard-updater-verify.ts <file> <signature-file>");
    process.exit(2);
}

const confPath = join(import.meta.dir, "../packages/dashboard/src-tauri/tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8")) as {
    plugins?: { updater?: { pubkey?: unknown } };
};
const publicKey = conf.plugins?.updater?.pubkey;
if (typeof publicKey !== "string" || publicKey.length === 0) {
    console.error(`no plugins.updater.pubkey in ${confPath}`);
    process.exit(1);
}

const verdict = verifyTauriSignature(
    readFileSync(filePath),
    readFileSync(signaturePath, "utf8"),
    publicKey,
);
if (!verdict.ok) {
    console.error(`FAIL ${filePath}: ${verdict.reason}`);
    process.exit(1);
}
console.log(`ok ${filePath}: signature verifies against the updater key in tauri.conf.json`);
