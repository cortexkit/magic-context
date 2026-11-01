/** Resolved storage keys must never be interpreted as filesystem paths. */
export function isResolvedProjectId(value: string): boolean {
    return value.startsWith("git:") || value.startsWith("dir:") || value.startsWith("pj-");
}
