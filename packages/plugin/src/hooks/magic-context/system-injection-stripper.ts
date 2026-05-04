const SYSTEM_INJECTION_MARKERS = [
    "<!-- OMO_INTERNAL_INITIATOR -->",
    "[SYSTEM DIRECTIVE: MAGIC-CONTEXT",
    "[SYSTEM DIRECTIVE: OH-MY-OPENCODE",
    "[Category+Skill Reminder]",
    "[EDIT ERROR - IMMEDIATE ACTION REQUIRED]",
    "[task CALL FAILED - IMMEDIATE RETRY REQUIRED]",
    "[EMERGENCY CONTEXT WINDOW WARNING]",
    "Unstable background agent appears idle",
    "**THE SUBAGENT JUST CLAIMED THIS TASK IS DONE.",
];

const SYSTEM_REMINDER_REGEX = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const OMO_MARKER_REGEX = /<!-- OMO_INTERNAL_INITIATOR -->/g;

export function stripSystemInjection(text: string): string | null {
    let hasInjection = false;
    for (const marker of SYSTEM_INJECTION_MARKERS) {
        if (text.includes(marker)) {
            hasInjection = true;
            break;
        }
    }
    if (SYSTEM_REMINDER_REGEX.test(text)) hasInjection = true;
    SYSTEM_REMINDER_REGEX.lastIndex = 0;

    if (!hasInjection) return null;

    let cleaned = text;
    cleaned = cleaned.replace(SYSTEM_REMINDER_REGEX, "");
    cleaned = cleaned.replace(OMO_MARKER_REGEX, "");
    cleaned = cleaned.replace(
        /\[SYSTEM DIRECTIVE: OH-MY-(?:OPENCODE|CLAUDE)[^\]]*\][\s\S]*?(?=\n\n(?!\s*[-*])|$)/g,
        "",
    );

    for (const marker of SYSTEM_INJECTION_MARKERS) {
        if (marker.startsWith("<!-- ") || marker.startsWith("[SYSTEM DIRECTIVE")) continue;
        const idx = cleaned.indexOf(marker);
        if (idx === -1) continue;
        const blockEnd = cleaned.indexOf("\n\n", idx + marker.length);
        cleaned =
            blockEnd !== -1
                ? cleaned.slice(0, idx) + cleaned.slice(blockEnd)
                : cleaned.slice(0, idx);
    }

    return cleaned.trim();
}
