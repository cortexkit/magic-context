export const IDENTITY_MERGE_COMMAND = "npx @cortexkit/magic-context@latest doctor merge-identities";
export const IDENTITY_MERGE_PREVIEW_HINT = "It shows what would move. Add --apply to move them.";

/** Shell arguments in notices must be safe to paste even when a folder contains spaces or quotes. */
function shellArg(value: string, platform: NodeJS.Platform): string {
    if (/^[\w.:/-]+$/.test(value)) return value;
    return platform === "win32" ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

export function identityMergeCommand(
    from: string,
    to?: string,
    platform = process.platform,
): string {
    return `${IDENTITY_MERGE_COMMAND} --from ${shellArg(from, platform)} --to ${to ? shellArg(to, platform) : '"DESTINATION_IDENTITY"'}`;
}
