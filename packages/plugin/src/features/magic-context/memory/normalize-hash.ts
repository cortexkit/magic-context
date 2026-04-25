import { createHash } from "node:crypto";

export function normalizeMemoryContent(content: string): string {
    return content.toLowerCase().replace(/\s+/g, " ").trim();
}

export function computeNormalizedHash(content: string): string {
    const normalized = normalizeMemoryContent(content);
    // node:crypto's MD5 produces the exact same hex digest as Bun.CryptoHasher("md5"),
    // so existing memory hashes remain stable across the runtime swap.
    return createHash("md5").update(normalized).digest("hex");
}
