export const IDENTITY_MERGE_COMMAND = "npx @cortexkit/magic-context@latest doctor merge-identities";

/** Shell arguments in notices must be safe to paste even when a folder contains spaces or quotes. */
function shellArg(value: string): string {
    if (/^[\w.:/-]+$/.test(value)) return value;
    return process.platform === "win32"
        ? `'${value.replaceAll("'", "''")}'`
        : `'${value.replaceAll("'", "'\\''")}'`;
}

export function identityMergeCommand(from: string, to?: string): string {
    return `${IDENTITY_MERGE_COMMAND} --from ${shellArg(from)} --to ${to ? shellArg(to) : '"DESTINATION_IDENTITY"'} --apply`;
}
