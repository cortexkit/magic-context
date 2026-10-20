import { describe, expect, it } from "bun:test";
import { commitTypedModelValue, getTypedModelSelection, suggestedModels } from "./model-selection";

describe("ModelSelect MiniMax suggestions", () => {
  it("puts discovered Flash routes first and keeps only current text choices", () => {
    const current = [
      "minimax/MiniMax-M3",
      "minimax-cn/MiniMax-M3",
      "openrouter/minimax/minimax-m3",
      "opencode/minimax-m3",
      "opencode-go/minimax-m3",
      "together/MiniMaxAI/MiniMax-M3",
      "fireworks/accounts/fireworks/models/minimax-m3",
    ];
    const flash = [
      "minimax/MiniMax-M3.1-Flash",
      "minimax-cn/MiniMax-M3.1-Flash",
      "openrouter/minimax/minimax-m3.1-flash:free",
      "opencode/minimax-m3.1-flash-free",
      "opencode-zen/minimax-m3.1-flash-free",
    ];
    const old = [
      "minimax/MiniMax-M2.7",
      "minimax/MiniMax-Text-01",
      "fireworks/accounts/fireworks/routers/minimax-latest",
      "minimax-cn/MiniMax-M2.7-highspeed",
      "minimax-coding-plan/MiniMax-M2.7",
      "openrouter/minimax/minimax-m1",
      "openrouter/minimax/minimax-m3:batch",
      "opencode/minimax-m2.5",
      "opencode-go/minimax-m2.7",
      "vercel-ai-gateway/minimax/minimax-m2.1-lightning",
      "huggingface/MiniMaxAI/MiniMax-M2.7",
      "amazon-bedrock/minimax.minimax-m2",
      "qwen-token-plan-cn/MiniMax-M2.5",
      "fireworks/accounts/fireworks/models/minimax-m2p7",
    ];
    expect(suggestedModels([...current, ...old, ...flash])).toEqual([...flash, ...current]);
  });

  it("preserves unrelated, custom and nontext models without inventing routes", () => {
    const models = ["openai/gpt-5", "custom/MiniMax-M2.7", "minimax/speech-02-hd"];
    expect(suggestedModels(models)).toEqual(models);
    expect(suggestedModels(["minimax/MiniMax-M3"])).toEqual(["minimax/MiniMax-M3"]);
    expect(models).toEqual(["openai/gpt-5", "custom/MiniMax-M2.7", "minimax/speech-02-hd"]);
  });

  it("keeps saved and explicitly entered legacy IDs while hiding ordinary suggestions", () => {
    const saved = "minimax/MiniMax-M2.7";
    const catalog = [saved, "minimax/MiniMax-M3"];
    const choices = suggestedModels(catalog);
    const committed: string[] = [];
    expect(commitTypedModelValue(saved, choices, (id) => committed.push(id))).toEqual({
      model: saved,
      hint: null,
      isListed: false,
    });
    expect(committed).toEqual([saved]);
    expect(catalog).toEqual([saved, "minimax/MiniMax-M3"]);
  });
});

describe("ModelSelect custom model entries", () => {
  it("commits an unlisted provider/model ID when discovered models exist", () => {
    const committed: string[] = [];

    expect(
      commitTypedModelValue("mistral/mistral-large", ["openai/gpt-5"], (model) => {
        committed.push(model);
      }),
    ).toEqual({ model: "mistral/mistral-large", hint: null, isListed: false });
    expect(committed).toEqual(["mistral/mistral-large"]);
  });

  it("rejects a slashless model ID with a visible hint", () => {
    const committed: string[] = [];

    expect(
      commitTypedModelValue("mistral-large", ["openai/gpt-5"], (model) => {
        committed.push(model);
      }),
    ).toEqual({
      model: null,
      hint: "Enter a model id in provider/model form",
      isListed: false,
    });
    expect(committed).toEqual([]);
    expect(getTypedModelSelection("mistral-large", ["openai/gpt-5"]).hint).toBe(
      "Enter a model id in provider/model form",
    );
  });
});
