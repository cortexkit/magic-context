export const MAX_HANDOFF_BYTES = 16_384;
export type GrantName = `apikey:${string}` | `oauth:${string}`;
export interface GrantRequest { name: GrantName; kind: "api_key" | "access_token" }
export interface Handoff { version: 1; grant: GrantRequest; material: string }

export function secretForms(material: string): string[] {
    return material ? [material, Buffer.from(material).toString("base64"), Buffer.from(material).toString("hex")] : [];
}

export function assertSpawnBoundary(argv: readonly string[], env: Record<string, string | undefined>, material: string) {
    if (!material) throw new Error("credential_material_required");
    assertNoMaterial("spawn_argv", argv.join("\0"), material);
    assertNoMaterial("spawn_environment", Object.entries(env).map(([name, value]) => `${name}=${value ?? ""}`).join("\0"), material);
}

export function validateMaterial(value: unknown): string {
    // A vault may serve structured OAuth material. Never forward a refresh-bearing bundle.
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (/refresh[_-]?token|"refresh"\s*:/i.test(text ?? "")) throw new Error("credential_refresh_token_refused");
    if (typeof value !== "string" || !value || Buffer.byteLength(value) > 8192 || !/^[A-Za-z0-9._~+/=:-]+$/.test(value))
        throw new Error("credential_material_not_static_key_or_access_token");
    return value;
}

export function validateGrant(grant: GrantRequest) {
    if (!grant || !["api_key", "access_token"].includes(grant.kind) ||
        !(grant.kind === "api_key" ? /^apikey:[\w:.-]+$/ : /^oauth:[\w:.-]+$/).test(grant.name))
        throw new Error("exact_credential_grant_required");
}

export async function readHandoff(input: AsyncIterable<Uint8Array>, expected: GrantRequest): Promise<Handoff> {
    validateGrant(expected);
    const bytes = Buffer.alloc(MAX_HANDOFF_BYTES);
    let length = 0;
    let raw = "";
    try {
        for await (const chunk of input) {
            try {
                if (length + chunk.length > bytes.length) throw new Error("credential_handoff_too_large");
                bytes.set(chunk, length); length += chunk.length;
            } finally { chunk.fill(0); }
        }
        raw = bytes.subarray(0, length).toString("utf8");
        const value = JSON.parse(raw) as Handoff;
        if (value.version !== 1 || value.grant?.name !== expected.name || value.grant?.kind !== expected.kind ||
            Object.keys(value).sort().join(",") !== "grant,material,version") throw new Error("credential_handoff_binding");
        value.material = validateMaterial(value.material);
        return value;
    } finally { raw = ""; bytes.fill(0); }
}

export async function readJobHandoff(input: AsyncIterable<Uint8Array>, grant?: GrantRequest): Promise<Handoff | undefined> {
    if (grant) return readHandoff(input, grant);
    // Grant-free jobs accept EOF only, never an unbound credential payload.
    for await (const chunk of input) {
        const nonempty = chunk.length > 0;
        chunk.fill(0);
        if (nonempty) throw new Error("credential_free_handoff_refused");
    }
    return undefined;
}

/** Retain an incomplete line until it can be redacted, including secrets split across writes. */
export function redactedLines(secrets: string[], emit: (text: string) => void) {
    let pending = "";
    const clean = (text: string) => secrets.flatMap(secretForms).reduce((out, key) => out.split(key).join("[REDACTED]"), text);
    return {
        write(chunk: Uint8Array | string) {
            pending += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
            if (pending.length > 2_000_000) throw new Error("credential_output_line_too_large");
            let end: number;
            while ((end = pending.indexOf("\n")) >= 0) {
                emit(clean(pending.slice(0, end + 1))); pending = pending.slice(end + 1);
            }
        },
        end() { if (pending) emit(clean(pending)); pending = ""; },
    };
}

export function assertNoMaterial(label: string, value: string | Uint8Array, material: string) {
    if (secretForms(material).some((form) => Buffer.from(value).includes(Buffer.from(form)))) throw new Error(`credential_leak_${label}`);
}
