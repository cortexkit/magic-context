import { homedir, userInfo } from "node:os";

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SECRET_KEY_PATTERN = /(?:key|token|secret|password|auth|bearer|credential)/i;

function redactionTypeForKey(key: string): string {
    const normalized = key
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, "_");
    const suffix = normalized.split(".").filter(Boolean).at(-1) ?? normalized;
    return suffix || "secret";
}

export function isSecretKey(key: string): boolean {
    return SECRET_KEY_PATTERN.test(key);
}

export function sanitizePathString(value: string): string {
    const home = homedir();
    const username = userInfo().username;
    let sanitized = value;
    if (home) {
        sanitized = sanitized.replace(new RegExp(escapeRegex(home), "g"), "~");
    }
    sanitized = sanitized.replace(/\/Users\/[^/]+\//g, "/Users/<USER>/");
    sanitized = sanitized.replace(/\/home\/[^/]+\//g, "/home/<USER>/");
    sanitized = sanitized.replace(/C:\\Users\\[^\\]+\\/g, "C:\\Users\\<USER>\\");
    if (username) {
        sanitized = sanitized.replace(new RegExp(escapeRegex(username), "g"), "<USER>");
    }
    return sanitized;
}

const SECRET_TEXT_PATTERNS: Array<{
    pattern: RegExp;
    replacement: string | ((match: string, ...groups: string[]) => string);
}> = [
    {
        pattern: /\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{32,}/g,
        replacement: "<ANTHROPIC_API_KEY_REDACTED>",
    },
    {
        pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
        replacement: "<OPENAI_API_KEY_REDACTED>",
    },
    {
        pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
        replacement: "<GITHUB_PAT_REDACTED>",
    },
    {
        pattern: /\b(?:gh[opsu]|ghr)_[A-Za-z0-9]{30,}/g,
        replacement: "<GITHUB_TOKEN_REDACTED>",
    },
    {
        pattern: /\bhf_[A-Za-z0-9]{30,}/g,
        replacement: "<HUGGINGFACE_TOKEN_REDACTED>",
    },
    {
        pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
        replacement: "<AWS_ACCESS_KEY_ID_REDACTED>",
    },
    {
        pattern: /\bxox[abprsuvc]-[A-Za-z0-9-]{10,}/g,
        replacement: "<SLACK_TOKEN_REDACTED>",
    },
    {
        pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
        replacement: "<GOOGLE_API_KEY_REDACTED>",
    },
    {
        pattern: /\b(Authorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
        replacement: (_full: string, prefix: string) => `${prefix}<REDACTED:bearer>`,
    },
    {
        pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        replacement: "<JWT_REDACTED>",
    },
    {
        pattern:
            /(["'])([^"']*(?:key|token|secret|password|auth|bearer|credential)[^"']*)\1(\s*:\s*)(["'])([^"']*)\4/gi,
        replacement: (
            _full: string,
            quote: string,
            key: string,
            separator: string,
            valueQuote: string,
        ) =>
            `${quote}${key}${quote}${separator}${valueQuote}<REDACTED:${redactionTypeForKey(key)}>${valueQuote}`,
    },
    {
        pattern:
            /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|auth|bearer|credential)[A-Za-z0-9_.-]*)\s*=\s*([^\s'"`]+)/gi,
        replacement: (_full: string, key: string) =>
            `${key}=<REDACTED:${redactionTypeForKey(key)}>`,
    },
];

export function redactSecretText(value: string): string {
    let redacted = value;
    for (const { pattern, replacement } of SECRET_TEXT_PATTERNS) {
        if (typeof replacement === "string") {
            redacted = redacted.replace(pattern, replacement);
        } else {
            redacted = redacted.replace(
                pattern,
                replacement as (match: string, ...groups: string[]) => string,
            );
        }
    }
    return redacted;
}

export function sanitizeDiagnosticText(value: string): string {
    return redactSecretText(sanitizePathString(value));
}

export function sanitizeConfigValue(value: unknown, keyPath: string[] = []): unknown {
    const key = keyPath.at(-1) ?? "";
    if (key && isSecretKey(key)) {
        return `<REDACTED:${redactionTypeForKey(key)}>`;
    }
    if (typeof value === "string") return sanitizeDiagnosticText(value);
    if (Array.isArray(value)) {
        return value.map((entry, index) => sanitizeConfigValue(entry, [...keyPath, String(index)]));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([entryKey, entry]) => [
                entryKey,
                sanitizeConfigValue(entry, [...keyPath, entryKey]),
            ]),
        );
    }
    return value;
}
