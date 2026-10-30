import type { ScopedCredentials } from "./activation-driver";
import { validateMaterial } from "./credential-protocol";

type CredentialId = Parameters<ScopedCredentials["getScoped"]>[0];

/** This wrapper rejects non-Darwin processes; call it only from the trusted Mac orchestrator. */
export function scopedCredentials(input: {
    connect(): Promise<{
        getScoped(request: { credentialId: string; enrollmentToken: string; minTtlMs?: number }): Promise<{ material: string }>;
        close(): void | Promise<void>;
    }>;
    enrollmentToken: string;
    onRunEnded(id: CredentialId): Promise<void>;
    exactGrants?: readonly CredentialId[];
    minTtlMs?: number;
}): ScopedCredentials {
    if (process.platform !== "darwin") throw new Error("credential_broker_trusted_host_required");
    return {
        async getScoped(id) {
            if (process.platform !== "darwin") throw new Error("credential_broker_trusted_host_required");
            if (!input.enrollmentToken || !(input.exactGrants ?? ["apikey:anthropic", "apikey:cline-pass"]).includes(id))
                throw new Error("exact_credential_grant_required");
            const client = await input.connect();
            try {
                const response = await client.getScoped({ credentialId: id, enrollmentToken: input.enrollmentToken,
                    ...(input.minTtlMs === undefined ? {} : { minTtlMs: input.minTtlMs }) });
                if (!response.material) throw new Error("empty_scoped_credential");
                return validateMaterial(response.material);
            } finally { await client.close(); }
        },
        notifyRunEnded: (id) => input.onRunEnded(id),
    };
}
