export type AuthEntry = { type: "api"; key: string } | { type: "oauth"; access: string };
export type Credentials = Record<string, AuthEntry>;

export const PROVIDER_VARIABLES: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN",
    openai: "OPENAI_API_KEY",
    "openai-codex": "OPENAI_OAUTH_TOKEN",
    moonshot: "MOONSHOT_API_KEY",
    zai: "ZAI_API_KEY",
    xai: "XAI_API_KEY",
    google: "GEMINI_API_KEY",
    meta: "META_API_KEY",
    "github-copilot": "GITHUB_COPILOT_TOKEN",
    cerebras: "CEREBRAS_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    "fireworks-ai": "FIREWORKS_API_KEY",
    "opencode-go": "OPENCODE_API_KEY",
    inception: "INCEPTION_API_KEY",
    minimax: "MINIMAX_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
};

/** Credentials are deliberately never discovered from a host login or loose key file. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv): Credentials {
    const key = env.ANTHROPIC_API_KEY?.trim();
    const access = env.ANTHROPIC_OAUTH_TOKEN?.trim();
    if (key && access) throw new Error("Set only one of ANTHROPIC_API_KEY and ANTHROPIC_OAUTH_TOKEN; both are set");
    const credentials: Credentials = {};
    for (const [provider, variable] of Object.entries(PROVIDER_VARIABLES)) {
        if (provider === "anthropic") continue;
        const value = env[variable]?.trim();
        if (value) credentials[provider] = provider === "openai-codex"
            ? { type: "oauth", access: value } : { type: "api", key: value };
    }
    if (key) credentials.anthropic = { type: "api", key };
    if (access) credentials.anthropic = { type: "oauth", access };
    credentials.deepseek = { type: "api", key: "" };
    return credentials;
}
