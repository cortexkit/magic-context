/** Anthropic calibration only uses the count endpoint, with an API key or OAuth. */
import { postCountJson, requireCount } from "./counting";

interface ModelTest {
    label: string;
    provider: string;
    modelId: string;
}

interface AuthEntry {
    type: string;
    access?: string;
    key?: string;
}

interface MeasureResult {
    systemApi: number | null;
    toolsApi: number | null;
    method: "count_tokens";
    proseApi: number | null;
    sections: Record<string, number>;
}

const ANTHROPIC_BETA = "oauth-2025-04-20";
const COUNT_URL = "https://api.anthropic.com/v1/messages/count_tokens?beta=true";
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

async function callCountTokens(
    body: Record<string, unknown>,
    accessToken: string,
    authType: string,
): Promise<number> {
    const json = await postCountJson(COUNT_URL, {
        ...(authType === "api" ? { "x-api-key": accessToken } : { authorization: `Bearer ${accessToken}` }),
        "anthropic-version": "2023-06-01",
        "anthropic-beta": ANTHROPIC_BETA,
        "content-type": "application/json",
        "user-agent": "magic-context-calibration/1.0",
    }, body);
    return requireCount(json.input_tokens);
}

export async function measureAnthropic(
    test: ModelTest,
    auth: AuthEntry,
    systemText: string,
    toolsArray: unknown[],
    proseSections: Record<string, string> = {},
): Promise<MeasureResult> {
    const method = "count_tokens";
    const access = auth.type === "api" ? auth.key : auth.access;
    if (!access) throw new Error("Missing Anthropic credentials");
    // System-only request: keep system prompt as one big text block (single block
    // so per-block overhead doesn't dominate; matches what the plugin renders).
    const systemBody = {
        model: test.modelId,
        system: auth.type === "oauth" && !systemText.startsWith(CLAUDE_CODE_SYSTEM_PREFIX)
            ? `${CLAUDE_CODE_SYSTEM_PREFIX}\n\n${systemText}`
            : systemText,
        messages: [{ role: "user", content: "x" }],
    };
    const systemApi = await callCountTokens(systemBody, access, auth.type);

    // Tools-only request
    const toolsBody = {
        model: test.modelId,
        tools: toolsArray,
        messages: [{ role: "user", content: "x" }],
    };
    const toolsApi = await callCountTokens(toolsBody, access, auth.type);

    // Subtract baseline (~9 tokens for the {role:user,content:"x"} envelope plus
    // the floor) so the returned numbers reflect just the system / tools content.
    const baselineBody = {
        model: test.modelId,
        messages: [{ role: "user", content: "x" }],
    };
    const baseline = await callCountTokens(baselineBody, access, auth.type);
    const sections: Record<string, number> = {};
    let proseApi: number | null = null;
    if (Object.keys(proseSections).length > 0) {
        const countProse = async (content: string) => Math.max(0, await callCountTokens({ model: test.modelId, messages: [{ role: "user", content: `x\n${content}` }] }, access, auth.type) - baseline);
        proseApi = await countProse(Object.values(proseSections).join("\n\n"));
        for (const [name, content] of Object.entries(proseSections)) sections[name] = await countProse(content);
    }
    return {
        method,
        proseApi,
        sections,
        systemApi: Math.max(0, systemApi - baseline),
        toolsApi: Math.max(0, toolsApi - baseline),
    };
}
