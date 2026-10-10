import { For } from "solid-js";
import { editToolDescription, TOOL_DESCRIPTIONS } from "./tool-description-config";

export {
  editToolDescription,
  normalizeToolDescriptions,
  TOOL_DESCRIPTIONS,
} from "./tool-description-config";

export default function ToolDescriptions(props: {
  preset: "full" | "light";
  value: Record<string, unknown> | undefined;
  onChange: (value: Record<string, unknown> | undefined) => void;
}) {
  return (
    <div class="config-tool-descriptions">
      <For each={Object.keys(TOOL_DESCRIPTIONS)}>
        {(tool) => (
          <div class="config-tool-row">
            <div class="config-field-header">
              <label class="config-field-label" for={`description-${tool}`}>
                {tool}
              </label>
              <button
                type="button"
                class="btn sm"
                disabled={props.value?.[tool] === undefined}
                onClick={() =>
                  props.onChange(
                    editToolDescription(
                      props.value,
                      tool,
                      TOOL_DESCRIPTIONS[tool][props.preset],
                      props.preset,
                    ),
                  )
                }
              >
                Reset to default
              </button>
            </div>
            <textarea
              id={`description-${tool}`}
              class="config-input"
              rows={5}
              value={String(props.value?.[tool] ?? TOOL_DESCRIPTIONS[tool][props.preset])}
              onInput={(event) =>
                props.onChange(
                  editToolDescription(props.value, tool, event.currentTarget.value, props.preset),
                )
              }
            />
            <span class="config-field-desc">
              {props.value?.[tool] === undefined
                ? `Built-in ${props.preset} description · not written to config`
                : "Custom description"}
            </span>
          </div>
        )}
      </For>
    </div>
  );
}
