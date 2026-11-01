/** Hash provenance uses raw message parts, before formatting merges assistant blocks. */
export function rawCommitHashes(value: unknown): string[] {
    if (typeof value === "string") {
        return Array.from(value.matchAll(/\b[0-9a-f]{7,40}\b/gi), (match) =>
            match[0].toLowerCase(),
        );
    }
    if (value === null || typeof value !== "object") return [];
    return Object.values(value).flatMap(rawCommitHashes);
}

export function removeUnsupportedCommitHashes(
    text: string,
    supported: ReadonlySet<string>,
): string {
    return text.replace(/`?\b([0-9a-f]{7,40})\b`?/gi, (token, hash: string) => {
        const normalized = hash.toLowerCase();
        // Decimal-only tokens are numbers, even when they resemble short hashes.
        if (!/[a-f]/.test(normalized)) return token;
        return Array.from(supported).some((source) => source.startsWith(normalized)) ? token : "";
    });
}
