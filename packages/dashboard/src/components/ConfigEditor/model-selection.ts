const INVALID_MODEL_ID_HINT = "Enter a model id in provider/model form";

const MINIMAX_MODEL_PREFIXES: Record<string, string> = {
  minimax: "",
  "minimax-cn": "",
  "minimax-coding-plan": "",
  opencode: "",
  "opencode-go": "",
  "opencode-zen": "",
  openrouter: "minimax/",
  "vercel-ai-gateway": "minimax/",
  huggingface: "minimaxai/",
  together: "minimaxai/",
  fireworks: "accounts/fireworks/models/",
  "fireworks-ai": "accounts/fireworks/models/",
  "amazon-bedrock": "minimax.",
  "qwen-token-plan": "",
  "qwen-token-plan-cn": "",
};

const FLASH_MODEL_IDS = new Set([
  "minimax/MiniMax-M3.1-Flash",
  "minimax-cn/MiniMax-M3.1-Flash",
  "openrouter/minimax/minimax-m3.1-flash:free",
  "opencode/minimax-m3.1-flash-free",
  "opencode-zen/minimax-m3.1-flash-free",
]);

/** Filter suggestions only; saved values and explicit custom IDs remain untouched. */
export function suggestedModels(models: readonly string[]): string[] {
  return models
    .filter((id) => {
      if (FLASH_MODEL_IDS.has(id)) return true;
      const slash = id.indexOf("/");
      const provider = id.slice(0, slash);
      const prefix = MINIMAX_MODEL_PREFIXES[provider];
      const model = id.slice(slash + 1).toLowerCase();
      if (
        (provider === "fireworks" || provider === "fireworks-ai") &&
        model === "accounts/fireworks/routers/minimax-latest"
      ) {
        return false;
      }
      if (prefix === undefined || !model.startsWith(prefix)) return true;
      const nativeModel = model.slice(prefix.length);
      if (!/^minimax[-.](?:m\d|text-)/.test(nativeModel)) return true;
      return nativeModel === "minimax-m3" || nativeModel === "minimax.m3";
    })
    .sort((a, b) => Number(FLASH_MODEL_IDS.has(b)) - Number(FLASH_MODEL_IDS.has(a)));
}

export function getTypedModelSelection(
  input: string,
  availableModels: readonly string[],
): { model: string | null; hint: string | null; isListed: boolean } {
  const model = input.trim();
  if (!model) return { model: null, hint: null, isListed: false };

  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    return { model: null, hint: INVALID_MODEL_ID_HINT, isListed: false };
  }

  // Discovery lists are never exhaustive, so a valid provider/model ID must
  // remain selectable even when it is not one of the discovered models.
  return {
    model,
    hint: null,
    isListed: availableModels.includes(model),
  };
}

export function commitTypedModelValue(
  input: string,
  availableModels: readonly string[],
  onChange: (model: string) => void,
): { model: string | null; hint: string | null; isListed: boolean } {
  const selection = getTypedModelSelection(input, availableModels);
  if (selection.model) onChange(selection.model);
  return selection;
}
