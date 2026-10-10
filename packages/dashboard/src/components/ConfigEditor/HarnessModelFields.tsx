import { For, Show } from "solid-js";
import type { Harness, ModelEntry } from "./harness-model-data";
import {
  fallbackEntries,
  modelEntryWithModel,
  modelEntryWithQualifier,
  modelId,
  modelQualifier,
  record,
} from "./harness-model-data";

export type { Harness, ModelEntry, OpenCodeModelEntry, PiModelEntry } from "./harness-model-data";
export {
  fallbackEntries,
  modelCatalogForHarness,
  modelEntryWithModel,
  modelEntryWithQualifier,
  modelId,
  modelQualifier,
  thinkingLevelsForHarness,
} from "./harness-model-data";

import ModelSelect from "./ModelSelect";
import VariantSelect from "./VariantSelect";

function QualifierControl(props: {
  harness: Harness;
  label: string;
  description: string;
  path: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  model?: string;
  variants?: Record<string, string[]>;
}) {
  const qualifier = () => (props.harness === "opencode" ? "variant" : "thinking_level");

  return (
    <div class="config-field">
      <div class="config-field-header">
        <span class="config-field-label">{props.label}</span>
        <span class="config-field-key">
          {props.path}.{qualifier()}
        </span>
      </div>
      <span class="config-field-desc">{props.description}</span>
      <VariantSelect
        harness={props.harness}
        model={props.model}
        variants={props.variants}
        label={props.label}
        value={props.value}
        onChange={props.onChange}
      />
    </div>
  );
}

interface HarnessModelFieldsProps {
  harness: Harness;
  models: string[];
  value: unknown;
  onChange: (value: Record<string, unknown>) => void;
  agent: "historian" | "dreamer";
  variants?: Record<string, string[]>;
}

export default function HarnessModelFields(props: HarnessModelFieldsProps) {
  const block = () => record(props.value);
  const qualifierKey = () => (props.harness === "opencode" ? "variant" : "thinking_level");
  const label = () => (props.harness === "opencode" ? "Variant" : "Thinking level");
  const updateBlock = (patch: Record<string, unknown>) => {
    const next = { ...block(), ...patch };
    for (const key of Object.keys(next)) {
      if (next[key] === undefined) delete next[key];
    }
    props.onChange(next);
  };
  const model = () => modelId(block().model);
  const fallbacks = () => fallbackEntries(block().fallback_models);
  const updateFallback = (index: number, entry: ModelEntry | undefined) => {
    const next = fallbacks();
    if (entry) next[index] = entry;
    else next.splice(index, 1);
    updateBlock({ fallback_models: next.length > 0 ? next : undefined });
  };

  return (
    <div class="harness-model-fields" data-harness={props.harness} data-agent={props.agent}>
      <div class="config-field">
        <div class="config-field-header">
          <span class="config-field-label">Model</span>
          <span class="config-field-key">
            {props.agent}.{props.harness}.model
          </span>
        </div>
        <span class="config-field-desc">
          Primary model for the {props.agent} {props.harness} harness
        </span>
        <ModelSelect
          models={props.models}
          value={model()}
          onChange={(next) =>
            updateBlock({
              model: modelEntryWithModel(block().model, props.harness, next || undefined),
            })
          }
          placeholder="— Use fallback chain —"
        />
      </div>

      <QualifierControl
        harness={props.harness}
        model={model()}
        variants={props.variants}
        label={`Primary ${label().toLowerCase()}`}
        description="Stored on this model entry and used only by this harness."
        path={`${props.agent}.${props.harness}.model`}
        value={modelQualifier(block().model, props.harness)}
        onChange={(next) =>
          updateBlock({ model: modelEntryWithQualifier(block().model, props.harness, next) })
        }
      />

      <QualifierControl
        harness={props.harness}
        model={model()}
        variants={props.variants}
        label={`Default ${label().toLowerCase()}`}
        description="Used when the primary entry does not specify its own qualifier."
        path={`${props.agent}.${props.harness}`}
        value={
          typeof block()[qualifierKey()] === "string"
            ? (block()[qualifierKey()] as string)
            : undefined
        }
        onChange={(next) => updateBlock({ [qualifierKey()]: next })}
      />

      <div class="config-field config-field-wide">
        <div class="config-field-header">
          <span class="config-field-label">Fallback Models</span>
          <span class="config-field-key">
            {props.agent}.{props.harness}.fallback_models
          </span>
        </div>
        <span class="config-field-desc">
          Fallback entries keep their own {label().toLowerCase()} and never inherit the primary
          entry's value.
        </span>
        <div class="model-chain-list">
          <Show
            when={fallbacks().length > 0}
            fallback={<span class="model-chain-empty">Using built-in fallback chain</span>}
          >
            <For each={fallbacks()}>
              {(entry, index) => (
                <div class="model-chain-item">
                  <ModelSelect
                    models={props.models}
                    value={modelId(entry)}
                    onChange={(next) =>
                      updateFallback(
                        index(),
                        modelEntryWithModel(entry, props.harness, next || undefined),
                      )
                    }
                    placeholder="— Select fallback model —"
                  />
                  <VariantSelect
                    harness={props.harness}
                    model={modelId(entry)}
                    variants={props.variants}
                    label={`Fallback ${label().toLowerCase()}`}
                    value={modelQualifier(entry, props.harness)}
                    onChange={(next) =>
                      updateFallback(index(), modelEntryWithQualifier(entry, props.harness, next))
                    }
                  />
                  <button
                    type="button"
                    class="config-icon-btn"
                    aria-label={`Remove fallback ${modelId(entry)}`}
                    onClick={() => updateFallback(index(), undefined)}
                  >
                    ✕
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
        <div class="model-chain-add">
          <ModelSelect
            models={props.models.filter(
              (candidate) => !fallbacks().some((entry) => modelId(entry) === candidate),
            )}
            value={undefined}
            onChange={(next) => {
              if (next) updateBlock({ fallback_models: [...fallbacks(), next] });
            }}
            placeholder="— Add fallback model —"
          />
        </div>
      </div>
    </div>
  );
}
