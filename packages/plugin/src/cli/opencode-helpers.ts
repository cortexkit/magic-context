import { execSync } from "node:child_process";

export function isOpenCodeInstalled(): boolean {
    try {
        execSync("opencode --version", { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

export function getOpenCodeVersion(): string | null {
    try {
        return execSync("opencode --version", { stdio: "pipe" }).toString().trim();
    } catch {
        return null;
    }
}

export function getAvailableModels(): string[] {
    try {
        const output = execSync("opencode models", { stdio: "pipe" }).toString().trim();
        return output
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

/** Group models by provider for display */
export function groupModelsByProvider(models: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const model of models) {
        const slashIdx = model.indexOf("/");
        const provider = slashIdx >= 0 ? model.substring(0, slashIdx) : "other";
        const list = groups.get(provider) ?? [];
        list.push(model);
        groups.set(provider, list);
    }
    return groups;
}

/** Get unique providers from model list */
export function getProviders(models: string[]): string[] {
    const providers = new Set<string>();
    for (const model of models) {
        const slashIdx = model.indexOf("/");
        if (slashIdx >= 0) {
            providers.add(model.substring(0, slashIdx));
        }
    }
    return [...providers].sort();
}

/** Filter models matching any of the given patterns */
export function filterModels(models: string[], patterns: string[]): string[] {
    return models.filter((m) => patterns.some((p) => m.includes(p)));
}

/**
 * Build a curated model selection list for a given role.
 * Returns models ordered by recommendation priority.
 */
export function buildModelSelection(
    allModels: string[],
    role: "historian" | "dreamer" | "sidekick",
): { label: string; value: string; recommended?: boolean }[] {
    const result: { label: string; value: string; recommended?: boolean }[] = [];
    const added = new Set<string>();

    const addIfAvailable = (pattern: string, hint?: string) => {
        const matches = allModels.filter((m) => m === pattern || m.endsWith(`/${pattern}`));
        for (const m of matches) {
            if (!added.has(m)) {
                added.add(m);
                result.push({
                    label: hint ? `${m} — ${hint}` : m,
                    value: m,
                    recommended: result.length === 0,
                });
            }
        }
    };

    if (role === "historian") {
        // Follow the actual fallback chain order.
        // Per-request providers first (github-copilot) — better for historian's
        // single long prompt/request pattern vs token-based billing.
        addIfAvailable("github-copilot/claude-sonnet-4.6", "per-request billing");
        addIfAvailable("anthropic/claude-sonnet-4-6");
        addIfAvailable("github-copilot/gpt-5.4", "per-request billing");
        addIfAvailable("openai/gpt-5.4");
        addIfAvailable("github-copilot/gemini-3.1-pro-preview", "per-request billing");
        addIfAvailable("opencode-go/minimax-m2.7");
        addIfAvailable("opencode-go/glm-5");
    } else if (role === "dreamer") {
        // Local/cheap models first — dreamer runs overnight
        for (const m of allModels.filter((m) => m.startsWith("ollama/"))) {
            if (!added.has(m)) {
                added.add(m);
                result.push({ label: `${m} — local`, value: m, recommended: result.length === 0 });
            }
        }

        addIfAvailable("github-copilot/claude-sonnet-4.6", "per-request billing");
        addIfAvailable("anthropic/claude-sonnet-4-6");
        addIfAvailable("github-copilot/gemini-3-flash-preview", "per-request billing");
        addIfAvailable("opencode-go/glm-5");
        addIfAvailable("opencode-go/minimax-m2.7");
    } else if (role === "sidekick") {
        // Fast models first
        for (const m of allModels.filter((m) => m.startsWith("cerebras/"))) {
            if (!added.has(m)) {
                added.add(m);
                result.push({ label: m, value: m, recommended: result.length === 0 });
            }
        }

        addIfAvailable("opencode/gpt-5-nano");
        addIfAvailable("github-copilot/gemini-3-flash-preview");
        addIfAvailable("github-copilot/gpt-5-mini");
    }

    return result;
}
