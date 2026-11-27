export const RECOMP_PAUSED_HEADING = "## Magic Recomp — Paused";

/** Read the text after the paused-rebuild heading, for the sidebar and status dialog. */
export function pausedRecompReason(message: string | undefined): string | null {
    const prefix = `${RECOMP_PAUSED_HEADING}\n`;
    if (!message?.startsWith(prefix)) return null;
    return message.slice(prefix.length).replace(/\s+/g, " ").trim();
}
