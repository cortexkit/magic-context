const SYSTEM_DIRECTIVE_PREFIX = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT";

export function isSystemDirective(text: string): boolean {
    return text.trimStart().startsWith(SYSTEM_DIRECTIVE_PREFIX);
}

export function removeSystemReminders(text: string): string {
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
}
