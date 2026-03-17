export const SYSTEM_DIRECTIVE_PREFIX = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT";

export function createSystemDirective(type: string): string {
    return `${SYSTEM_DIRECTIVE_PREFIX} - ${type}]`;
}

export function isSystemDirective(text: string): boolean {
    return text.trimStart().startsWith(SYSTEM_DIRECTIVE_PREFIX);
}

export function hasSystemReminder(text: string): boolean {
    return /<system-reminder>[\s\S]*?<\/system-reminder>/i.test(text);
}

export function removeSystemReminders(text: string): string {
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
}

export const SystemDirectiveTypes = {
    CONTEXT_MANAGEMENT: "CONTEXT MANAGEMENT",
} as const;
