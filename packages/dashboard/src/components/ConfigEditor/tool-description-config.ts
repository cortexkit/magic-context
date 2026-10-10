import manifest from "../../generated/tool-descriptions.json";

export const TOOL_DESCRIPTIONS: Record<string, { full: string; light: string }> = manifest;

export function normalizeToolDescriptions(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const surface = config.prompt_surface as Record<string, unknown> | undefined;
  if (!surface?.tool_descriptions || typeof surface.tool_descriptions !== "object") return config;
  const descriptions = { ...(surface.tool_descriptions as Record<string, unknown>) };
  const preset = surface.default === "light" ? "light" : "full";
  for (const [tool, defaults] of Object.entries(TOOL_DESCRIPTIONS)) {
    if (descriptions[tool] === defaults[preset]) delete descriptions[tool];
  }
  return {
    ...config,
    prompt_surface: {
      ...surface,
      tool_descriptions: Object.keys(descriptions).length ? descriptions : undefined,
    },
  };
}

export function editToolDescription(
  value: Record<string, unknown> | undefined,
  tool: string,
  text: string,
  preset: "full" | "light",
): Record<string, unknown> | undefined {
  const next = { ...value };
  if (text === TOOL_DESCRIPTIONS[tool]?.[preset]) delete next[tool];
  else next[tool] = text;
  return Object.keys(next).length ? next : undefined;
}
