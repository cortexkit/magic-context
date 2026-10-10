import { describe, expect, it } from "bun:test";
import { commitTypedModelValue, getTypedModelSelection } from "./model-selection";

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
