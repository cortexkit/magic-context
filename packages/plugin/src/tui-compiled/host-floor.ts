/**
 * The oldest OpenCode 1 release whose bundled OpenTUI (0.4.5) the sidebar's
 * shared frame supports. OpenCode 1.18.0–1.18.3 bundle 0.4.3 and 1.17.x bundle
 * 0.3.4 or 0.4.2. OpenCode 2 releases Magic Context supports all bundle newer
 * OpenTUI, so only OpenCode 1 versions are checked.
 */
export const MIN_OPENCODE1_SIDEBAR_VERSION = "1.18.4";

function parseRelease(version: string): [number, number, number] | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * The line to show instead of loading the TUI part when the host is an OpenCode 1
 * release older than {@link MIN_OPENCODE1_SIDEBAR_VERSION}, otherwise null. A
 * version that is not a plain release number (a development build, or a host that
 * reports none) is let through: it cannot be placed against the floor.
 */
export function unsupportedTuiHostMessage(version: string | undefined): string | null {
    const release = version ? parseRelease(version) : null;
    const floor = parseRelease(MIN_OPENCODE1_SIDEBAR_VERSION);
    if (!release || !floor || release[0] !== 1) return null;
    for (let index = 0; index < 3; index += 1) {
        if (release[index] > floor[index]) return null;
        if (release[index] < floor[index]) {
            return `Magic Context's sidebar needs OpenCode ${MIN_OPENCODE1_SIDEBAR_VERSION} or later (this is ${version}); context management keeps running.`;
        }
    }
    return null;
}
