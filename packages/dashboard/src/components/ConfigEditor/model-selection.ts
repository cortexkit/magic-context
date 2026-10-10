const INVALID_MODEL_ID_HINT = "Enter a model id in provider/model form";

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
