export function normalizeMemoryContent(content: string): string {
    return content.toLowerCase().replace(/\s+/g, " ").trim();
}

export function computeNormalizedHash(content: string): string {
    const normalized = normalizeMemoryContent(content);
    return new Bun.CryptoHasher("md5").update(normalized).digest("hex");
}
