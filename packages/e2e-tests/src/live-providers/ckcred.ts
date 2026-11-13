/**
 * Credentials for the live-provider harness, served by the CortexKit credential vault (CKCRED,
 * the claustrum daemon) to the enrolled consumer `mc-e2e`.
 *
 * The enrollment ceremony is run once by hand:
 *
 *   bun packages/e2e-tests/src/live-providers/ckcred.ts propose   # prints the request id
 *   (the operator approves `mc-e2e` with exact read grants on the credential ids below)
 *   bun packages/e2e-tests/src/live-providers/ckcred.ts poll      # stores the token
 *   bun packages/e2e-tests/src/live-providers/ckcred.ts check     # lists covered ids, no secrets
 *
 * The token lives at ~/.config/cortexkit/mc-e2e/enrollment.json (mode 0600). The raw request
 * secret is kept only until the token arrives, in a 0600 file under $TMPDIR, because the vault
 * needs it to authorize the poll and returns the token exactly once.
 *
 * Secret material from `fetchCredential` stays in memory or in a throwaway host config/login slot
 * that is deleted with its scenario root. Calibration passes it only in the child's environment.
 * Nothing here logs it. A provider rejecting a key is a
 * test result, so this module never reports auth failures back to the vault.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaustrumClient, writeEnrollmentTokenFile } from "@cortexkit/claustrum-client";

export const CONSUMER_NAME = "mc-e2e";

/** The vault records this harness reads. Each needs an exact read grant for `mc-e2e`. */
export const CREDENTIAL_IDS = [
    "apikey:openai",
    "apikey:openrouter",
    "apikey:deepseek",
    "apikey:kimi-for-coding",
    "oauth:anthropic",
    "chatgpt:openai",
] as const;
export type CredentialId = (typeof CREDENTIAL_IDS)[number] | `oauth:anthropic:${string}` | `chatgpt:openai:${string}`;

export const ENROLLMENT_PATH =
    process.env.MC_E2E_ENROLLMENT_PATH ?? join(homedir(), ".config", "cortexkit", CONSUMER_NAME, "enrollment.json");
const PENDING_PATH =
    process.env.MC_E2E_ENROLLMENT_PENDING_PATH ??
    join(process.env.TMPDIR ?? tmpdir(), "magic-context", "live-providers", "enrollment-pending.json");

interface PendingProposal {
    requestSecret: string;
    requestId?: string;
}

function readPending(): PendingProposal | null {
    if (!existsSync(PENDING_PATH)) return null;
    return JSON.parse(readFileSync(PENDING_PATH, "utf8")) as PendingProposal;
}

function writePending(value: PendingProposal): void {
    mkdirSync(dirname(PENDING_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(PENDING_PATH, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

/**
 * The vault hashes the 32 decoded secret bytes, not the 64-character hex text, so the
 * hash sent with the proposal must be computed the same way.
 */
function hashSecret(secretHex: string): string {
    return createHash("sha256").update(Buffer.from(secretHex, "hex")).digest("hex");
}

async function connect(): Promise<ClaustrumClient> {
    // The vault logs unknown error classes through this callback; keep them on stderr only.
    return ClaustrumClient.connect({ logger: (errorClass) => console.error(`ckcred error class: ${errorClass}`) });
}

/**
 * Start vault enrollment for `mc-e2e` by proposing it. The secret is persisted before the call so a crash between proposing and
 * recording the request id loses nothing: re-proposing with the same secret returns the same id.
 */
export async function propose(): Promise<string> {
    const pending = readPending() ?? { requestSecret: randomBytes(32).toString("hex") };
    writePending(pending);
    const client = await connect();
    try {
        const { requestId } = await client.enrollPropose({
            name: CONSUMER_NAME,
            requestSecretHash: hashSecret(pending.requestSecret),
        });
        writePending({ ...pending, requestId });
        return requestId;
    } finally {
        client.close();
    }
}

/** Poll the enrollment proposal once. The token is written to disk before anything else touches it. */
export async function poll(): Promise<"pending" | "approved" | "denied"> {
    const pending = readPending();
    if (!pending?.requestId) throw new Error("No pending proposal; run `propose` first");
    const client = await connect();
    try {
        const outcome = await client.enrollPoll({ requestId: pending.requestId, requestSecret: pending.requestSecret });
        if (outcome.status === "approved") {
            await writeEnrollmentTokenFile(ENROLLMENT_PATH, {
                token: outcome.token,
                token_generation: outcome.tokenGeneration,
            });
            rmSync(PENDING_PATH, { force: true });
        }
        return outcome.status;
    } finally {
        client.close();
    }
}

function enrollmentToken(): string {
    if (!existsSync(ENROLLMENT_PATH)) {
        throw new Error(`No enrollment token at ${ENROLLMENT_PATH}; run the enrollment ceremony first`);
    }
    const value = JSON.parse(readFileSync(ENROLLMENT_PATH, "utf8")) as { token?: unknown };
    if (typeof value.token !== "string") throw new Error(`Malformed enrollment file ${ENROLLMENT_PATH}`);
    return value.token;
}

/** Ids the token's grants cover, without reading any secret. */
export async function coveredIds(): Promise<string[]> {
    const client = await connect();
    try {
        const inventory = await client.listScoped(enrollmentToken());
        return inventory.rows.map((row) => row.id);
    } finally {
        client.close();
    }
}

/**
 * Read one key for one scenario or calibration child. Never log returned material or
 * persist it outside a scenario's throwaway host config.
 */
export async function fetchCredential(id: CredentialId): Promise<string> {
    const client = await connect();
    try {
        const served = await client.getScoped({ credentialId: id, enrollmentToken: enrollmentToken() });
        return served.material;
    } finally {
        client.close();
    }
}

if (import.meta.main) {
    const command = process.argv[2];
    if (command === "propose") {
        const requestId = await propose();
        console.log(JSON.stringify({ consumer: CONSUMER_NAME, requestId, credentialIds: CREDENTIAL_IDS }));
    } else if (command === "poll") {
        console.log(JSON.stringify({ status: await poll(), enrollmentPath: ENROLLMENT_PATH }));
    } else if (command === "check") {
        const covered = await coveredIds();
        console.log(
            JSON.stringify({
                covered,
                missing: CREDENTIAL_IDS.filter((id) => !covered.includes(id)),
            }),
        );
    } else {
        console.error("usage: ckcred.ts propose | poll | check");
        process.exit(2);
    }
}
