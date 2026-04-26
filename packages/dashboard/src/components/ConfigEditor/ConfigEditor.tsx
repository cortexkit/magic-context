import { createMemo, createResource, createSignal, For, type JSX, Show } from "solid-js";
import { getConfig, getProjectConfigs, saveConfig, saveProjectConfig } from "../../lib/api";
import type { ProjectConfigEntry } from "../../lib/types";
import ModelSelect from "./ModelSelect";
import PerModelField from "./PerModelField";

// ── JSONC helpers ───────────────────────────────────────────

// Minimal JSONC parser: strip comments while respecting string literals, then parse.
function parseJsonc(text: string): Record<string, unknown> {
  let result = "";
  let i = 0;
  while (i < text.length) {
    // String literal — copy verbatim
    if (text[i] === '"') {
      result += '"';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") {
          result += text[i++];
        } // skip escape + next char
        if (i < text.length) {
          result += text[i++];
        }
      }
      if (i < text.length) {
        result += text[i++];
      } // closing quote
    }
    // Single-line comment
    else if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    }
    // Block comment
    else if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2; // skip */
    }
    // Normal character
    else {
      result += text[i++];
    }
  }
  try {
    return JSON.parse(result);
  } catch {
    return {};
  }
}

/** Pretty-print config as JSONC (plain JSON with 2-space indent). */
function toJsonc(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, null, 2);
}

// ── Config field definitions ────────────────────────────────

interface FieldDef {
  key: string;
  label: string;
  type: "boolean" | "number" | "string" | "select";
  options?: string[];
  description: string;
  section: string;
  defaultValue?: boolean | number | string;
}

const FIELD_DEFS: FieldDef[] = [
  // General
  {
    key: "enabled",
    label: "Enabled",
    type: "boolean",
    description: "Enable the magic-context plugin",
    section: "General",
  },
  {
    key: "ctx_reduce_enabled",
    label: "Agent Controlled Reduction",
    type: "boolean",
    description:
      "Enable agent controlled reductions via ctx_reduce tool. When enabled, agent is prompted and nudged to choose what messages and tool calls to drop periodically. If disabled the system still works via auto drops based on message ages.",
    section: "General",
  },
  {
    key: "drop_tool_structure",
    label: "Drop Tool Structure",
    type: "boolean",
    description:
      "When enabled, dropped tool calls are fully removed. When disabled, tool input/output is truncated in place so tool structure stays visible.",
    section: "General",
    defaultValue: true,
  },
  {
    key: "compaction_markers",
    label: "Compaction Markers",
    type: "boolean",
    description:
      "Inject boundary into OpenCode's DB so transform only processes the live tail after historian compaction. Significantly reduces transform input size for long sessions.",
    section: "General",
    defaultValue: true,
  },
  // Thresholds
  // cache_ttl and execute_threshold_percentage are rendered as custom PerModelField components
  {
    key: "nudge_interval_tokens",
    label: "Nudge Interval (tokens)",
    type: "number",
    description: "Token interval between rolling ctx_reduce nudges.",
    section: "General",
  },
  // Tags & cleanup
  {
    key: "protected_tags",
    label: "Protected Tags",
    type: "number",
    description: "Number of recent tags protected from drops.",
    section: "Tags & Cleanup",
  },
  {
    key: "auto_drop_tool_age",
    label: "Auto Drop Tool Age",
    type: "number",
    description: "Tag age after which tool outputs are automatically dropped.",
    section: "Tags & Cleanup",
  },
  {
    key: "clear_reasoning_age",
    label: "Clear Reasoning Age",
    type: "number",
    description: "Tag age after which reasoning blocks are cleared.",
    section: "Tags & Cleanup",
  },
  {
    key: "iteration_nudge_threshold",
    label: "Iteration Nudge Threshold",
    type: "number",
    description: "Number of consecutive tool calls before showing an iteration nudge.",
    section: "General",
  },
  // Historian
  {
    key: "history_budget_percentage",
    label: "History Budget %",
    type: "number",
    description: "Fraction of context limit reserved for rendered history (0.0–1.0).",
    section: "Historian",
  },
  {
    key: "historian_timeout_ms",
    label: "Historian Timeout (ms)",
    type: "number",
    description: "Max wait time for a historian run before timeout.",
    section: "Historian",
  },
  // Memory
  {
    key: "memory.enabled",
    label: "Memory Enabled",
    type: "boolean",
    description: "Enable cross-session project memory.",
    section: "Memory",
  },
  {
    key: "memory.injection_budget_tokens",
    label: "Injection Budget (tokens)",
    type: "number",
    description: "Max tokens for memory injection into session history.",
    section: "Memory",
  },
  {
    key: "memory.auto_promote",
    label: "Auto Promote",
    type: "boolean",
    description: "Automatically promote session facts to project memory.",
    section: "Memory",
  },
  {
    key: "memory.retrieval_count_promotion_threshold",
    label: "Retrieval Count Promotion Threshold",
    type: "number",
    description:
      "Minimum ctx_search retrieval count before a session fact is auto-promoted to project memory.",
    section: "Memory",
  },
];

// ── Nested value access helpers ─────────────────────────────

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const clone = structuredClone(obj);
  const parts = path.split(".");
  let current: Record<string, unknown> = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
  return clone;
}

// ── Section icons ───────────────────────────────────────────

const SECTION_ICONS: Record<string, string> = {
  General: "⚙️",
  Thresholds: "⚡",
  "Tags & Cleanup": "🏷️",
  Historian: "📜",
  Memory: "🧠",
  Experimental: "🧪",
};

// Fields that should use range sliders (percentage or threshold values)
const RANGE_SLIDER_FIELDS = new Set([
  "history_budget_percentage",
  "nudge_interval_tokens",
  "protected_tags",
  "auto_drop_tool_age",
  "clear_reasoning_age",
  "iteration_nudge_threshold",
  "historian_timeout_ms",
  "memory.injection_budget_tokens",
]);

// ── ConfigForm component ────────────────────────────────────

function ConfigForm(props: {
  content: string;
  onSave: (content: string) => void;
  saveStatus: string | null;
  models: string[];
}) {
  const [showRaw, setShowRaw] = createSignal(false);
  const [rawEdit, setRawEdit] = createSignal<string | null>(null);
  const [formData, setFormData] = createSignal<Record<string, unknown>>(parseJsonc(props.content));
  const [embeddingTestResult, setEmbeddingTestResult] = createSignal<{
    ok: boolean;
    message: string;
  } | null>(null);

  /**
   * Structured outcome returned by the Rust probe (mirrors the `EmbeddingProbeOutcome`
   * enum in `src-tauri/src/embedding_probe.rs`, serialized via serde with
   * `tag = "kind"` + `rename_all = "snake_case"`). Each variant carries the
   * fields needed to render provider-specific guidance instead of a raw
   * HTTP status.
   */
  type EmbeddingProbeOutcome =
    | { kind: "ok"; status: number; dimensions: number | null }
    | { kind: "auth_failed"; status: number; preview: string }
    | { kind: "endpoint_unsupported"; status: number; preview: string }
    | { kind: "http_error"; status: number; preview: string }
    | { kind: "network_error"; message: string }
    | { kind: "timeout"; timeout_ms: number }
    | { kind: "invalid_scheme"; endpoint: string }
    | { kind: "unresolved_token"; field: string; token: string };

  /** Render the probe outcome as `{ ok, message }` for the inline UI. The
   *  wording mirrors doctor's output so a user who runs both tools sees
   *  consistent guidance. */
  function formatProbeOutcome(outcome: EmbeddingProbeOutcome): {
    ok: boolean;
    message: string;
  } {
    switch (outcome.kind) {
      case "ok":
        return {
          ok: true,
          message: `✓ Connected (${outcome.status}, ${outcome.dimensions ?? "?"}-dim vectors)`,
        };
      case "auth_failed":
        return {
          ok: false,
          message: `Credentials rejected (${outcome.status}) — check your API key`,
        };
      case "endpoint_unsupported":
        return {
          ok: false,
          message: `Endpoint does not support embeddings (${outcome.status}) — provider may not offer an embeddings API or the URL points at the wrong route`,
        };
      case "http_error":
        return {
          ok: false,
          message: `HTTP ${outcome.status}: ${outcome.preview.slice(0, 120)}`,
        };
      case "network_error":
        return { ok: false, message: `Connection failed: ${outcome.message}` };
      case "timeout":
        return {
          ok: false,
          message: `Endpoint did not respond within ${outcome.timeout_ms}ms — check URL and network`,
        };
      case "invalid_scheme":
        return {
          ok: false,
          message: `Endpoint must start with http:// or https:// (got: ${outcome.endpoint})`,
        };
      case "unresolved_token":
        return {
          ok: false,
          message: `${outcome.field} still contains ${outcome.token} — the referenced variable is not set in this process. Launch OpenCode from a terminal (where your shell exports the var) or run \`doctor\` to validate from the shell.`,
        };
    }
  }
  const models = () => props.models;

  // Reset form data when content prop changes
  const parsed = createMemo(() => parseJsonc(props.content));

  const hasChanges = createMemo(() => {
    return JSON.stringify(formData()) !== JSON.stringify(parsed());
  });

  // Section order: Tags & Cleanup goes last (rendered after agent cards)
  const SECTION_ORDER: Record<string, number> = {
    General: 0,
    Thresholds: 1,
    Historian: 2,
    Memory: 3,
    "Tags & Cleanup": 99,
  };

  const sections = createMemo(() => {
    const groups: Record<string, FieldDef[]> = {};
    for (const field of FIELD_DEFS) {
      if (!groups[field.section]) groups[field.section] = [];
      groups[field.section].push(field);
    }
    return Object.entries(groups).sort(
      ([a], [b]) => (SECTION_ORDER[a] ?? 50) - (SECTION_ORDER[b] ?? 50),
    );
  });

  const handleFieldChange = (key: string, value: unknown) => {
    const updated = setNestedValue(formData(), key, value);
    setFormData(updated);
  };

  const handleFormSave = () => {
    // Merge form data with original to preserve unknown keys
    const original = parsed();
    const merged = { ...original, ...formData() };
    // Deep merge for nested objects
    for (const key of ["embedding", "memory"]) {
      if (typeof formData()[key] === "object" && formData()[key] != null) {
        merged[key] = {
          ...((original[key] as Record<string, unknown>) ?? {}),
          ...(formData()[key] as Record<string, unknown>),
        };
      }
    }
    props.onSave(toJsonc(merged));
  };

  const handleRawSave = () => {
    const content = rawEdit();
    if (content != null) {
      props.onSave(content);
      setRawEdit(null);
      setFormData(parseJsonc(content));
    }
  };

  // Range slider helpers
  const getRangeConfig = (
    fieldKey: string,
  ): { min: number; max: number; step: number; suffix: string; defaultValue: number } => {
    switch (fieldKey) {
      case "execute_threshold_percentage":
        return { min: 20, max: 80, step: 1, suffix: "%", defaultValue: 65 };
      case "history_budget_percentage":
        return { min: 0.05, max: 0.5, step: 0.01, suffix: "", defaultValue: 0.15 };
      case "nudge_interval_tokens":
        return { min: 1000, max: 50000, step: 1000, suffix: " tokens", defaultValue: 10000 };
      case "protected_tags":
        return { min: 1, max: 100, step: 1, suffix: "", defaultValue: 20 };
      case "auto_drop_tool_age":
        return { min: 10, max: 200, step: 5, suffix: "", defaultValue: 100 };
      case "clear_reasoning_age":
        return { min: 10, max: 200, step: 5, suffix: "", defaultValue: 50 };
      case "iteration_nudge_threshold":
        return { min: 5, max: 30, step: 1, suffix: "", defaultValue: 15 };
      case "historian_timeout_ms":
        return { min: 60000, max: 600000, step: 30000, suffix: " ms", defaultValue: 300000 };
      case "memory.injection_budget_tokens":
        return { min: 500, max: 20000, step: 500, suffix: " tokens", defaultValue: 4000 };
      default:
        return { min: 0, max: 100, step: 1, suffix: "", defaultValue: 0 };
    }
  };

  const renderField = (field: FieldDef): JSX.Element => {
    const value = () => {
      const formVal = getNestedValue(formData(), field.key);
      return formVal !== undefined ? formVal : getNestedValue(parsed(), field.key);
    };
    const scalarValue = () => {
      const v = value();
      if (v != null && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        return obj.default !== undefined ? obj.default : undefined;
      }
      return v;
    };
    const isObjectValue = () => {
      const v = value();
      return v != null && typeof v === "object" && !Array.isArray(v);
    };
    const booleanValue = () => {
      const v = value();
      if (typeof v === "boolean") return v;
      return (field.defaultValue as boolean | undefined) ?? true;
    };
    const isRangeSlider =
      field.type === "number" && RANGE_SLIDER_FIELDS.has(field.key) && !isObjectValue();

    return (
      <div class="config-field">
        <div class="config-field-header">
          <span class="config-field-label">{field.label}</span>
          <span class="config-field-key">{field.key}</span>
        </div>
        <span class="config-field-desc">{field.description}</span>
        {field.type === "boolean" ? (
          <label class="toggle-switch">
            <input
              type="checkbox"
              checked={booleanValue()}
              onChange={(e) => handleFieldChange(field.key, e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
            <span class="toggle-label">{booleanValue() ? "Enabled" : "Disabled"}</span>
          </label>
        ) : field.type === "select" ? (
          <select
            class="config-input"
            value={String(value() ?? "")}
            onChange={(e) => handleFieldChange(field.key, e.currentTarget.value)}
          >
            <For each={field.options ?? []}>{(opt) => <option value={opt}>{opt}</option>}</For>
          </select>
        ) : isRangeSlider ? (
          <div class="range-slider-container">
            <input
              class="range-slider"
              type="range"
              min={getRangeConfig(field.key).min}
              max={getRangeConfig(field.key).max}
              step={getRangeConfig(field.key).step}
              value={
                scalarValue() != null
                  ? Number(scalarValue())
                  : getRangeConfig(field.key).defaultValue
              }
              onInput={(e) => handleFieldChange(field.key, Number(e.currentTarget.value))}
            />
            <span class="range-slider-value">
              {scalarValue() != null
                ? Number(scalarValue())
                : getRangeConfig(field.key).defaultValue}
              {getRangeConfig(field.key).suffix}
            </span>
          </div>
        ) : field.type === "number" ? (
          <input
            class="config-input"
            type="number"
            value={value() != null ? String(value()) : ""}
            placeholder="default"
            onInput={(e) => {
              const v = e.currentTarget.value;
              handleFieldChange(field.key, v ? Number(v) : undefined);
            }}
          />
        ) : (
          <input
            class="config-input"
            type="text"
            value={typeof value() === "object" ? JSON.stringify(value()) : String(value() ?? "")}
            placeholder="default"
            onInput={(e) => handleFieldChange(field.key, e.currentTarget.value)}
          />
        )}
      </div>
    );
  };

  return (
    <div>
      {/* Sticky Action Bar */}
      <div class="config-action-bar">
        <div class="tab-pills" style={{ margin: "0" }}>
          <button
            type="button"
            class={`tab-pill ${!showRaw() ? "active" : ""}`}
            onClick={() => setShowRaw(false)}
          >
            Form
          </button>
          <button
            type="button"
            class={`tab-pill ${showRaw() ? "active" : ""}`}
            onClick={() => {
              setShowRaw(true);
              setRawEdit(null);
            }}
          >
            Raw JSONC
          </button>
        </div>
        <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
          <Show when={props.saveStatus}>
            <span
              style={{
                "font-size": "12px",
                color: props.saveStatus?.startsWith("✓") ? "var(--green)" : "var(--red)",
              }}
            >
              {props.saveStatus}
            </span>
          </Show>
          <button
            type="button"
            class="btn primary sm"
            disabled={!hasChanges()}
            onClick={handleFormSave}
            style={{
              opacity: hasChanges() ? 1 : 0.4,
              cursor: hasChanges() ? "pointer" : "default",
            }}
          >
            Save Changes
          </button>
        </div>
      </div>

      <Show
        when={!showRaw()}
        fallback={
          <div>
            <Show
              when={rawEdit() != null}
              fallback={
                <div>
                  <pre class="config-pre">{props.content || "// Empty config"}</pre>
                  <div style={{ "margin-top": "12px" }}>
                    <button type="button" class="btn sm" onClick={() => setRawEdit(props.content)}>
                      Edit
                    </button>
                  </div>
                </div>
              }
            >
              <textarea
                class="code-editor"
                style={{ "min-height": "calc(100vh - 340px)" }}
                value={rawEdit() ?? ""}
                onInput={(e) => setRawEdit(e.currentTarget.value)}
              />
              <div style={{ display: "flex", gap: "8px", "margin-top": "12px" }}>
                <button type="button" class="btn primary sm" onClick={handleRawSave}>
                  Save
                </button>
                <button type="button" class="btn sm" onClick={() => setRawEdit(null)}>
                  Cancel
                </button>
              </div>
            </Show>
          </div>
        }
      >
        <div class="config-grid">
          <For each={sections().filter(([name]) => name !== "Tags & Cleanup")}>
            {([sectionName, fields]) => {
              const isFullWidth = sectionName === "Historian" || sectionName === "Memory";
              return (
                <>
                  <div class={`config-card ${isFullWidth ? "full-width" : ""}`}>
                    <div class="config-card-header">
                      <span class="config-card-icon">{SECTION_ICONS[sectionName] || "📋"}</span>
                      <span class="config-card-title">{sectionName}</span>
                    </div>
                    {sectionName === "Memory" ? (
                      (() => {
                        const embeddingProvider = () => {
                          const v = getNestedValue(formData(), "embedding.provider");
                          return (v as string) || "local";
                        };
                        const isRemote = () => embeddingProvider() === "openai-compatible";
                        return (
                          <div class="config-card-two-col">
                            {/* Left: Memory settings */}
                            <div class="config-card-content">
                              <For each={fields}>{renderField}</For>
                            </div>
                            {/* Right: Embedding settings */}
                            <div class="config-card-content">
                              {/* Provider */}
                              <div class="config-field">
                                <div class="config-field-header">
                                  <span class="config-field-label">Embedding Provider</span>
                                  <span class="config-field-key">embedding.provider</span>
                                </div>
                                <span class="config-field-desc">
                                  Provider for memory semantic search
                                </span>
                                <div style={{ display: "flex", gap: "6px" }}>
                                  <For each={["local", "openai-compatible", "off"] as const}>
                                    {(opt) => (
                                      <button
                                        class={`btn sm ${embeddingProvider() === opt ? "primary" : ""}`}
                                        onClick={() => handleFieldChange("embedding.provider", opt)}
                                        type="button"
                                      >
                                        {opt === "local"
                                          ? "Local"
                                          : opt === "openai-compatible"
                                            ? "OpenAI Compatible"
                                            : "Off"}
                                      </button>
                                    )}
                                  </For>
                                </div>
                                <Show when={embeddingProvider() === "local"}>
                                  <span
                                    class="config-field-desc"
                                    style={{
                                      "margin-top": "4px",
                                      color: "var(--text-muted)",
                                      "font-style": "italic",
                                    }}
                                  >
                                    Uses Xenova/all-MiniLM-L6-v2 locally — no configuration needed
                                  </span>
                                </Show>
                              </div>

                              {/* Remote-only fields */}
                              <Show when={isRemote()}>
                                <div class="config-field">
                                  <div class="config-field-header">
                                    <span class="config-field-label">Model</span>
                                    <span class="config-field-key">embedding.model</span>
                                  </div>
                                  <span class="config-field-desc">
                                    Embedding model name (e.g., text-embedding-3-small)
                                  </span>
                                  <input
                                    class="config-input"
                                    type="text"
                                    value={String(
                                      getNestedValue(formData(), "embedding.model") ?? "",
                                    )}
                                    placeholder="text-embedding-3-small"
                                    onInput={(e) =>
                                      handleFieldChange(
                                        "embedding.model",
                                        e.currentTarget.value || undefined,
                                      )
                                    }
                                  />
                                </div>

                                <div class="config-field">
                                  <div class="config-field-header">
                                    <span class="config-field-label">Endpoint</span>
                                    <span class="config-field-key">embedding.endpoint</span>
                                  </div>
                                  <span class="config-field-desc">API endpoint URL</span>
                                  <input
                                    class="config-input"
                                    type="text"
                                    value={String(
                                      getNestedValue(formData(), "embedding.endpoint") ?? "",
                                    )}
                                    placeholder="https://api.openai.com/v1"
                                    onInput={(e) =>
                                      handleFieldChange(
                                        "embedding.endpoint",
                                        e.currentTarget.value || undefined,
                                      )
                                    }
                                  />
                                </div>

                                <div class="config-field">
                                  <div class="config-field-header">
                                    <span class="config-field-label">API Key</span>
                                    <span class="config-field-key">embedding.api_key</span>
                                  </div>
                                  <span class="config-field-desc">
                                    Authentication key for the embedding API
                                  </span>
                                  <input
                                    class="config-input"
                                    type="password"
                                    value={String(
                                      getNestedValue(formData(), "embedding.api_key") ?? "",
                                    )}
                                    placeholder="sk-..."
                                    onInput={(e) =>
                                      handleFieldChange(
                                        "embedding.api_key",
                                        e.currentTarget.value || undefined,
                                      )
                                    }
                                  />
                                </div>

                                <div>
                                  <button
                                    type="button"
                                    class="btn sm"
                                    onClick={async () => {
                                      const endpoint = String(
                                        getNestedValue(formData(), "embedding.endpoint") ?? "",
                                      ).trim();
                                      const model = String(
                                        getNestedValue(formData(), "embedding.model") ?? "",
                                      ).trim();
                                      const apiKey = String(
                                        getNestedValue(formData(), "embedding.api_key") ?? "",
                                      ).trim();
                                      if (!endpoint || !model) {
                                        setEmbeddingTestResult({
                                          ok: false,
                                          message: "Endpoint and model are required",
                                        });
                                        return;
                                      }
                                      setEmbeddingTestResult({ ok: false, message: "Testing..." });
                                      try {
                                        const { invoke } = await import("@tauri-apps/api/core");
                                        // Rust returns the structured outcome directly (not
                                        // `Result<T, String>` anymore). Any thrown error from
                                        // `invoke` itself is a tauri infrastructure failure
                                        // (e.g., command not registered) rather than a probe
                                        // classification — we surface that unchanged.
                                        const outcome = await invoke<EmbeddingProbeOutcome>(
                                          "test_embedding_endpoint",
                                          { endpoint, model, apiKey: apiKey || null },
                                        );
                                        setEmbeddingTestResult(formatProbeOutcome(outcome));
                                      } catch (e: unknown) {
                                        setEmbeddingTestResult({
                                          ok: false,
                                          message: String(
                                            (e as { message?: string })?.message ?? e,
                                          ),
                                        });
                                      }
                                    }}
                                  >
                                    ⚡ Test Connection
                                  </button>
                                  <Show when={embeddingTestResult()}>
                                    <span
                                      style={{
                                        "margin-left": "10px",
                                        "font-size": "12px",
                                        color: embeddingTestResult()?.ok
                                          ? "var(--green)"
                                          : "var(--red)",
                                      }}
                                    >
                                      {embeddingTestResult()?.message}
                                    </span>
                                  </Show>
                                </div>
                              </Show>
                            </div>
                          </div>
                        );
                      })()
                    ) : sectionName === "Historian" ? (
                      <div class="config-card-two-col">
                        {/* Left: Model + Fallbacks */}
                        <div class="config-card-content">
                          <div class="config-field">
                            <div class="config-field-header">
                              <span class="config-field-label">Model</span>
                            </div>
                            <span class="config-field-desc">Primary model for historian agent</span>
                            <ModelSelect
                              models={models() ?? []}
                              value={
                                getNestedValue(formData(), "historian.model") as string | undefined
                              }
                              onChange={(v) => handleFieldChange("historian.model", v || undefined)}
                              placeholder="— Use fallback chain —"
                            />
                          </div>
                          <div class="config-field">
                            <div class="config-field-header">
                              <span class="config-field-label">Fallback Models</span>
                            </div>
                            <span class="config-field-desc">Models to try if primary fails</span>
                            <div class="model-chain-list">
                              <Show
                                when={
                                  (
                                    (getNestedValue(
                                      formData(),
                                      "historian.fallback_models",
                                    ) as string[]) ?? []
                                  ).length > 0
                                }
                                fallback={
                                  <span class="model-chain-empty">
                                    Using built-in fallback chain
                                  </span>
                                }
                              >
                                <For
                                  each={
                                    (getNestedValue(
                                      formData(),
                                      "historian.fallback_models",
                                    ) as string[]) ?? []
                                  }
                                >
                                  {(model, index) => (
                                    <div class="model-chain-item">
                                      <span class="mono" style={{ flex: 1 }}>
                                        {model}
                                      </span>
                                      <button
                                        type="button"
                                        class="btn sm danger"
                                        onClick={() => {
                                          const current =
                                            (getNestedValue(
                                              formData(),
                                              "historian.fallback_models",
                                            ) as string[]) ?? [];
                                          handleFieldChange(
                                            "historian.fallback_models",
                                            current.filter((_, i) => i !== index()).length > 0
                                              ? current.filter((_, i) => i !== index())
                                              : undefined,
                                          );
                                        }}
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
                                models={(models() ?? []).filter(
                                  (m) =>
                                    !(
                                      (getNestedValue(
                                        formData(),
                                        "historian.fallback_models",
                                      ) as string[]) ?? []
                                    ).includes(m),
                                )}
                                value={undefined}
                                onChange={(v) => {
                                  if (v) {
                                    const current =
                                      (getNestedValue(
                                        formData(),
                                        "historian.fallback_models",
                                      ) as string[]) ?? [];
                                    handleFieldChange("historian.fallback_models", [...current, v]);
                                  }
                                }}
                                placeholder="— Add fallback model —"
                              />
                            </div>
                          </div>
                        </div>
                        {/* Right: Settings sliders */}
                        <div class="config-card-content">
                          <For each={fields}>{renderField}</For>

                          {/* Commit Cluster Trigger */}
                          {(() => {
                            const commitCluster = () =>
                              (getNestedValue(formData(), "commit_cluster_trigger") as
                                | { enabled?: boolean; min_clusters?: number }
                                | undefined) ?? {};
                            const enabled = () => commitCluster().enabled ?? true;
                            const minClusters = () => commitCluster().min_clusters ?? 3;
                            return (
                              <>
                                <div class="config-field">
                                  <div class="config-field-header">
                                    <span class="config-field-label">Commit Cluster Trigger</span>
                                    <span class="config-field-key">
                                      commit_cluster_trigger.enabled
                                    </span>
                                  </div>
                                  <span class="config-field-desc">
                                    Fire historian when enough git commit clusters accumulate in the
                                    unsummarized conversation tail. A commit cluster is a distinct
                                    work phase where the agent made git commits, separated by
                                    meaningful user turns.
                                  </span>
                                  <label class="toggle-switch">
                                    <input
                                      type="checkbox"
                                      checked={enabled()}
                                      onChange={(e) =>
                                        handleFieldChange("commit_cluster_trigger", {
                                          ...commitCluster(),
                                          enabled: e.currentTarget.checked,
                                        })
                                      }
                                    />
                                    <span class="toggle-slider" />
                                    <span class="toggle-label">
                                      {enabled() ? "Enabled" : "Disabled"}
                                    </span>
                                  </label>
                                </div>

                                <Show when={enabled()}>
                                  <div class="config-field">
                                    <div class="config-field-header">
                                      <span class="config-field-label">Min Clusters</span>
                                      <span class="config-field-key">
                                        commit_cluster_trigger.min_clusters
                                      </span>
                                    </div>
                                    <span class="config-field-desc">
                                      Minimum number of commit clusters required to trigger
                                      historian
                                    </span>
                                    <input
                                      class="config-input"
                                      type="number"
                                      min={1}
                                      value={minClusters()}
                                      onInput={(e) => {
                                        const v = e.currentTarget.value;
                                        handleFieldChange("commit_cluster_trigger", {
                                          ...commitCluster(),
                                          min_clusters: v ? Math.max(1, Number(v)) : 3,
                                        });
                                      }}
                                    />
                                  </div>
                                </Show>
                              </>
                            );
                          })()}
                        </div>
                      </div>
                    ) : (
                      <div class="config-card-content">
                        <For each={fields}>{renderField}</For>
                      </div>
                    )}
                  </div>
                  {/* Thresholds card — right of General */}
                  {sectionName === "General" && (
                    <div class="config-card">
                      <div class="config-card-header">
                        <span class="config-card-icon">⚡</span>
                        <span class="config-card-title">Thresholds</span>
                      </div>
                      <div class="config-card-content">
                        <PerModelField
                          label="Cache TTL"
                          configKey="cache_ttl"
                          description="How long to wait before executing queued operations."
                          value={
                            getNestedValue(formData(), "cache_ttl") ??
                            getNestedValue(parsed(), "cache_ttl")
                          }
                          onChange={(v) => handleFieldChange("cache_ttl", v)}
                          models={models() ?? []}
                          inputType="text"
                          defaultPlaceholder="5m"
                        />
                        <PerModelField
                          label="Execute Threshold %"
                          configKey="execute_threshold_percentage"
                          description="Context usage percentage (20–80) at which queued drops execute. Max 80."
                          value={
                            getNestedValue(formData(), "execute_threshold_percentage") ??
                            getNestedValue(parsed(), "execute_threshold_percentage")
                          }
                          onChange={(v) => handleFieldChange("execute_threshold_percentage", v)}
                          models={models() ?? []}
                          inputType="slider"
                          sliderConfig={{
                            min: 20,
                            max: 80,
                            step: 1,
                            suffix: "%",
                            defaultValue: 65,
                          }}
                          defaultPlaceholder="65"
                        />
                        <PerModelField
                          label="Execute Threshold (tokens)"
                          configKey="execute_threshold_tokens"
                          description="Optional absolute-tokens threshold. When set for a model, overrides the percentage above. Per-model map only (use 'default' key for a fallback across all unlisted models). Clamped to 80% × context_limit at runtime."
                          value={
                            getNestedValue(formData(), "execute_threshold_tokens") ??
                            getNestedValue(parsed(), "execute_threshold_tokens")
                          }
                          onChange={(v) => handleFieldChange("execute_threshold_tokens", v)}
                          models={models() ?? []}
                          inputType="text"
                          alwaysObject
                          numericText
                          defaultPlaceholder="150000"
                        />
                      </div>
                    </div>
                  )}
                </>
              );
            }}
          </For>

          {/* ── Agent Configuration Cards ───────────────────────── */}

          {/* Dreamer Card */}
          <div class="config-card full-width">
            <div class="config-card-header">
              <span class="config-card-icon">🌙</span>
              <span class="config-card-title">DREAMER</span>
            </div>
            <div class="config-card-two-col">
              {/* Left: Enabled, Schedule, Inject Docs */}
              <div class="config-card-content">
                <div class="config-field">
                  <div class="config-field-header">
                    <span class="config-field-label">Enabled</span>
                  </div>
                  <span class="config-field-desc">Enable dreamer background processing</span>
                  <label class="toggle-switch">
                    <input
                      type="checkbox"
                      checked={(getNestedValue(formData(), "dreamer.enabled") as boolean) ?? false}
                      onChange={(e) =>
                        handleFieldChange("dreamer.enabled", e.currentTarget.checked)
                      }
                    />
                    <span class="toggle-slider" />
                    <span class="toggle-label">
                      {((getNestedValue(formData(), "dreamer.enabled") as boolean) ?? false)
                        ? "Enabled"
                        : "Disabled"}
                    </span>
                  </label>
                </div>

                <div class="config-field">
                  <div class="config-field-header">
                    <span class="config-field-label">Schedule</span>
                  </div>
                  <span class="config-field-desc">
                    Time window for dreamer runs (e.g., 02:00-06:00)
                  </span>
                  <input
                    class="config-input"
                    type="text"
                    value={String(getNestedValue(formData(), "dreamer.schedule") ?? "")}
                    placeholder="02:00-06:00"
                    onInput={(e) =>
                      handleFieldChange("dreamer.schedule", e.currentTarget.value || undefined)
                    }
                  />
                </div>

                <div class="config-field">
                  <div class="config-field-header">
                    <span class="config-field-label">Inject Docs</span>
                  </div>
                  <span class="config-field-desc">
                    Inject ARCHITECTURE.md and STRUCTURE.md into agent context
                  </span>
                  <label class="toggle-switch">
                    <input
                      type="checkbox"
                      checked={
                        (getNestedValue(formData(), "dreamer.inject_docs") as boolean) ?? false
                      }
                      onChange={(e) =>
                        handleFieldChange("dreamer.inject_docs", e.currentTarget.checked)
                      }
                    />
                    <span class="toggle-slider" />
                    <span class="toggle-label">
                      {((getNestedValue(formData(), "dreamer.inject_docs") as boolean) ?? false)
                        ? "Enabled"
                        : "Disabled"}
                    </span>
                  </label>
                </div>
              </div>

              {/* Right: Model + Fallbacks */}
              <div class="config-card-content">
                <div class="config-field">
                  <div class="config-field-header">
                    <span class="config-field-label">Model</span>
                  </div>
                  <span class="config-field-desc">Primary model for dreamer agent</span>
                  <ModelSelect
                    models={models() ?? []}
                    value={getNestedValue(formData(), "dreamer.model") as string | undefined}
                    onChange={(v) => handleFieldChange("dreamer.model", v || undefined)}
                    placeholder="— Use fallback chain —"
                  />
                </div>

                <div class="config-field">
                  <div class="config-field-header">
                    <span class="config-field-label">Fallback Models</span>
                  </div>
                  <span class="config-field-desc">Models to try if primary fails</span>
                  <div class="model-chain-list">
                    <Show
                      when={
                        ((getNestedValue(formData(), "dreamer.fallback_models") as string[]) ?? [])
                          .length > 0
                      }
                      fallback={
                        <span class="model-chain-empty">Using built-in fallback chain</span>
                      }
                    >
                      <For
                        each={
                          (getNestedValue(formData(), "dreamer.fallback_models") as string[]) ?? []
                        }
                      >
                        {(model, index) => (
                          <div class="model-chain-item">
                            <span class="mono" style={{ flex: 1 }}>
                              {model}
                            </span>
                            <button
                              type="button"
                              class="btn sm danger"
                              onClick={() => {
                                const current =
                                  (getNestedValue(
                                    formData(),
                                    "dreamer.fallback_models",
                                  ) as string[]) ?? [];
                                const updated = current.filter((_, i) => i !== index());
                                handleFieldChange(
                                  "dreamer.fallback_models",
                                  updated.length > 0 ? updated : undefined,
                                );
                              }}
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
                      models={(models() ?? []).filter(
                        (m) =>
                          !(
                            (getNestedValue(formData(), "dreamer.fallback_models") as string[]) ??
                            []
                          ).includes(m),
                      )}
                      value={undefined}
                      onChange={(v) => {
                        if (v) {
                          const current =
                            (getNestedValue(formData(), "dreamer.fallback_models") as string[]) ??
                            [];
                          handleFieldChange("dreamer.fallback_models", [...current, v]);
                        }
                      }}
                      placeholder="— Add fallback model —"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* User Memories + Key File Pinning — graduated from experimental in v0.14.
                These render as a sibling 2-col grid below the main 2-col grid. They were
                previously nested inside the outer grid, which made them inherit a 3rd grid
                cell (rendering in only the left half with the right half empty). */}
            <div class="config-card-two-col">
              <div class="config-card-content">
                  <div class="config-field">
                    <div class="config-field-header">
                      <span class="config-field-label">User Memories</span>
                      <span class="config-field-key">dreamer.user_memories.enabled</span>
                    </div>
                    <span class="config-field-desc">
                      Extract behavioral observations from historian runs, promote recurring
                      patterns to stable user memories. Requires dreamer.
                    </span>
                    <label class="toggle-switch">
                      <input
                        type="checkbox"
                        checked={
                          (getNestedValue(
                            formData(),
                            "dreamer.user_memories.enabled",
                          ) as boolean) ?? true
                        }
                        onChange={(e) =>
                          handleFieldChange(
                            "dreamer.user_memories.enabled",
                            e.currentTarget.checked,
                          )
                        }
                      />
                      <span class="toggle-slider" />
                      <span class="toggle-label">
                        {((getNestedValue(
                          formData(),
                          "dreamer.user_memories.enabled",
                        ) as boolean) ?? true)
                          ? "Enabled"
                          : "Disabled"}
                      </span>
                    </label>
                  </div>

                  <Show
                    when={
                      ((getNestedValue(
                        formData(),
                        "dreamer.user_memories.enabled",
                      ) as boolean) ?? true)
                    }
                  >
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Promotion Threshold</span>
                        <span class="config-field-key">
                          dreamer.user_memories.promotion_threshold
                        </span>
                      </div>
                      <span class="config-field-desc">
                        Minimum candidate observations before dreamer promotes to stable (2–20)
                      </span>
                      <input
                        class="config-input"
                        type="number"
                        min={2}
                        max={20}
                        value={
                          (getNestedValue(
                            formData(),
                            "dreamer.user_memories.promotion_threshold",
                          ) as number) ?? 3
                        }
                        onInput={(e) =>
                          handleFieldChange(
                            "dreamer.user_memories.promotion_threshold",
                            Number(e.currentTarget.value),
                          )
                        }
                      />
                    </div>
                  </Show>
                </div>

                <div class="config-card-content">
                  <div class="config-field">
                    <div class="config-field-header">
                      <span class="config-field-label">Key File Pinning</span>
                      <span class="config-field-key">dreamer.pin_key_files.enabled</span>
                    </div>
                    <span class="config-field-desc">
                      Pin frequently-read files into the system prompt so the agent doesn't need to
                      re-read them after drops. Requires dreamer.
                    </span>
                    <label class="toggle-switch">
                      <input
                        type="checkbox"
                        checked={
                          (getNestedValue(
                            formData(),
                            "dreamer.pin_key_files.enabled",
                          ) as boolean) ?? false
                        }
                        onChange={(e) =>
                          handleFieldChange(
                            "dreamer.pin_key_files.enabled",
                            e.currentTarget.checked,
                          )
                        }
                      />
                      <span class="toggle-slider" />
                      <span class="toggle-label">
                        {((getNestedValue(
                          formData(),
                          "dreamer.pin_key_files.enabled",
                        ) as boolean) ?? false)
                          ? "Enabled"
                          : "Disabled"}
                      </span>
                    </label>
                  </div>

                  <Show
                    when={
                      (getNestedValue(
                        formData(),
                        "dreamer.pin_key_files.enabled",
                      ) as boolean) ?? false
                    }
                  >
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Token Budget</span>
                        <span class="config-field-key">dreamer.pin_key_files.token_budget</span>
                      </div>
                      <span class="config-field-desc">
                        Total tokens for all pinned key files (2,000–30,000)
                      </span>
                      <input
                        class="config-input"
                        type="number"
                        min={2000}
                        max={30000}
                        step={1000}
                        value={
                          (getNestedValue(
                            formData(),
                            "dreamer.pin_key_files.token_budget",
                          ) as number) ?? 10000
                        }
                        onInput={(e) =>
                          handleFieldChange(
                            "dreamer.pin_key_files.token_budget",
                            Number(e.currentTarget.value),
                          )
                        }
                      />
                    </div>

                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Min Reads</span>
                        <span class="config-field-key">dreamer.pin_key_files.min_reads</span>
                      </div>
                      <span class="config-field-desc">
                        Minimum full-read count before a file is eligible for pinning (2–20)
                      </span>
                      <input
                        class="config-input"
                        type="number"
                        min={2}
                        max={20}
                        value={
                          (getNestedValue(
                            formData(),
                            "dreamer.pin_key_files.min_reads",
                          ) as number) ?? 4
                        }
                        onInput={(e) =>
                          handleFieldChange(
                            "dreamer.pin_key_files.min_reads",
                            Number(e.currentTarget.value),
                          )
                        }
                      />
                    </div>
                  </Show>
                </div>
              </div>
          </div>

          {/* Sidekick Card */}
          <div class="config-card">
            <div class="config-card-header">
              <span class="config-card-icon">🤖</span>
              <span class="config-card-title">SIDEKICK</span>
            </div>
            <div class="config-card-content">
              {/* Enabled Toggle */}
              <div class="config-field">
                <div class="config-field-header">
                  <span class="config-field-label">Enabled</span>
                </div>
                <span class="config-field-desc">Enable sidekick augmentation</span>
                <label class="toggle-switch">
                  <input
                    type="checkbox"
                    checked={(getNestedValue(formData(), "sidekick.enabled") as boolean) ?? false}
                    onChange={(e) => handleFieldChange("sidekick.enabled", e.currentTarget.checked)}
                  />
                  <span class="toggle-slider" />
                  <span class="toggle-label">
                    {((getNestedValue(formData(), "sidekick.enabled") as boolean) ?? false)
                      ? "Enabled"
                      : "Disabled"}
                  </span>
                </label>
              </div>

              {/* Model Select */}
              <div class="config-field">
                <div class="config-field-header">
                  <span class="config-field-label">Model</span>
                </div>
                <span class="config-field-desc">Primary model for sidekick agent</span>
                <ModelSelect
                  models={models() ?? []}
                  value={getNestedValue(formData(), "sidekick.model") as string | undefined}
                  onChange={(v) => handleFieldChange("sidekick.model", v || undefined)}
                  placeholder="— Use fallback chain —"
                />
              </div>

              {/* Timeout */}
              <div class="config-field">
                <div class="config-field-header">
                  <span class="config-field-label">Timeout (ms)</span>
                </div>
                <span class="config-field-desc">Max wait time for sidekick response</span>
                <input
                  class="config-input"
                  type="number"
                  value={
                    getNestedValue(formData(), "sidekick.timeout_ms") != null
                      ? String(getNestedValue(formData(), "sidekick.timeout_ms"))
                      : ""
                  }
                  placeholder="30000"
                  onInput={(e) => {
                    const v = e.currentTarget.value;
                    handleFieldChange("sidekick.timeout_ms", v ? Number(v) : undefined);
                  }}
                />
              </div>

              {/* Fallback Models */}
              <div class="config-field">
                <div class="config-field-header">
                  <span class="config-field-label">Fallback Models</span>
                </div>
                <span class="config-field-desc">Models to try if primary fails</span>
                <div class="model-chain-list">
                  <Show
                    when={
                      ((getNestedValue(formData(), "sidekick.fallback_models") as string[]) ?? [])
                        .length > 0
                    }
                    fallback={<span class="model-chain-empty">Using built-in fallback chain</span>}
                  >
                    <For
                      each={
                        (getNestedValue(formData(), "sidekick.fallback_models") as string[]) ?? []
                      }
                    >
                      {(model, index) => (
                        <div class="model-chain-item">
                          <span class="mono" style={{ flex: 1 }}>
                            {model}
                          </span>
                          <button
                            type="button"
                            class="btn sm danger"
                            onClick={() => {
                              const current =
                                (getNestedValue(
                                  formData(),
                                  "sidekick.fallback_models",
                                ) as string[]) ?? [];
                              const updated = current.filter((_, i) => i !== index());
                              handleFieldChange(
                                "sidekick.fallback_models",
                                updated.length > 0 ? updated : undefined,
                              );
                            }}
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
                    models={(models() ?? []).filter(
                      (m) =>
                        !(
                          (getNestedValue(formData(), "sidekick.fallback_models") as string[]) ?? []
                        ).includes(m),
                    )}
                    value={undefined}
                    onChange={(v) => {
                      if (v) {
                        const current =
                          (getNestedValue(formData(), "sidekick.fallback_models") as string[]) ??
                          [];
                        handleFieldChange("sidekick.fallback_models", [...current, v]);
                      }
                    }}
                    placeholder="— Add fallback model —"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Tags & Cleanup — rendered after agent cards */}
          {(() => {
            const tagsFields = sections().find(([name]) => name === "Tags & Cleanup");
            if (!tagsFields) return null;
            return (
              <div class="config-card">
                <div class="config-card-header">
                  <span class="config-card-icon">🏷️</span>
                  <span class="config-card-title">Tags & Cleanup</span>
                </div>
                <div class="config-card-content">
                  <For each={tagsFields[1]}>{renderField}</For>
                </div>
              </div>
            );
          })()}

        </div>
      </Show>
    </div>
  );
}

// ── ProjectConfigDetail ─────────────────────────────────────

function ProjectConfigDetail(props: {
  entry: ProjectConfigEntry;
  onBack: () => void;
  models: string[];
}) {
  const configPath = () =>
    props.entry.exists
      ? props.entry.config_path
      : props.entry.alt_exists
        ? (props.entry.alt_config_path ?? "")
        : props.entry.config_path;
  const [config] = createResource(
    () => configPath(),
    async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      return (await invoke("get_config", {
        source: "project",
        projectPath: props.entry.worktree,
      })) as import("../../lib/types").ConfigFile;
    },
  );

  const [saveStatus, setSaveStatus] = createSignal<string | null>(null);

  const handleSave = async (content: string) => {
    try {
      await saveProjectConfig(props.entry.worktree, content);
      setSaveStatus("✓ Saved");
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      setSaveStatus(`✕ Error: ${err}`);
      setTimeout(() => setSaveStatus(null), 4000);
    }
  };

  return (
    <div>
      <div
        style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "12px" }}
      >
        <button type="button" class="btn sm" onClick={props.onBack}>
          ← Back
        </button>
        <span style={{ "font-weight": "600" }}>{props.entry.project_name}</span>
      </div>
      <table class="kv-table" style={{ "margin-bottom": "12px" }}>
        <tbody>
          <tr>
            <td>Path</td>
            <td style={{ "word-break": "break-all" }}>{configPath()}</td>
          </tr>
          <tr>
            <td>Worktree</td>
            <td style={{ "word-break": "break-all" }}>{props.entry.worktree}</td>
          </tr>
        </tbody>
      </table>
      <Show when={config()} fallback={<div class="empty-state">Loading...</div>}>
        <ConfigForm
          content={config()?.content}
          onSave={handleSave}
          saveStatus={saveStatus()}
          models={props.models}
        />
      </Show>
    </div>
  );
}

// ── Main ConfigEditor ───────────────────────────────────────

export default function ConfigEditor(props: { models: string[] }) {
  const [tab, setTab] = createSignal<"user" | "projects">("user");
  const [userConfig, { refetch: refetchUser }] = createResource(() => getConfig("user"));
  const [projectConfigs, { refetch: refetchProjects }] = createResource(getProjectConfigs);
  const [saveStatus, setSaveStatus] = createSignal<string | null>(null);
  const [selectedProject, setSelectedProject] = createSignal<ProjectConfigEntry | null>(null);

  const handleUserSave = async (content: string) => {
    try {
      await saveConfig("user", content);
      setSaveStatus("✓ Saved");
      refetchUser();
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      setSaveStatus(`✕ Error: ${err}`);
      setTimeout(() => setSaveStatus(null), 4000);
    }
  };

  return (
    <>
      <div class="section-header">
        <h1 class="section-title">Configuration</h1>
        <div class="section-actions">
          <button
            type="button"
            class="btn sm"
            onClick={() => {
              refetchUser();
              refetchProjects();
            }}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      <div class="tab-pills">
        <button
          type="button"
          class={`tab-pill ${tab() === "user" ? "active" : ""}`}
          onClick={() => {
            setTab("user");
            setSelectedProject(null);
          }}
        >
          User Config
        </button>
        <button
          type="button"
          class={`tab-pill ${tab() === "projects" ? "active" : ""}`}
          onClick={() => {
            setTab("projects");
            setSelectedProject(null);
          }}
        >
          Project Configs
          <Show when={(projectConfigs() ?? []).length > 0}>
            <span class="category-count" style={{ "margin-left": "4px" }}>
              ({projectConfigs()?.length})
            </span>
          </Show>
        </button>
      </div>

      <div class="scroll-area">
        <Show when={tab() === "user"}>
          <Show
            when={!userConfig.loading}
            fallback={<div class="empty-state">Loading config...</div>}
          >
            <div style={{ "margin-bottom": "8px" }}>
              <table class="kv-table">
                <tbody>
                  <tr>
                    <td>Path</td>
                    <td style={{ "word-break": "break-all" }}>{userConfig()?.path ?? "—"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <Show
              when={userConfig()?.exists}
              fallback={
                <div class="empty-state">
                  <span class="empty-state-icon">⚙️</span>
                  <span>No user config found at {userConfig()?.path}</span>
                  <span style={{ "font-size": "11px" }}>
                    Run <code>bunx --bun @cortexkit/opencode-magic-context setup</code> to create
                    one
                  </span>
                </div>
              }
            >
              <ConfigForm
                content={userConfig()?.content}
                onSave={handleUserSave}
                saveStatus={saveStatus()}
                models={props.models}
              />
            </Show>
          </Show>
        </Show>

        <Show when={tab() === "projects"}>
          <Show
            when={selectedProject()}
            fallback={
              (projectConfigs() ?? []).length > 0 ? (
                <div class="list-gap">
                  <For each={projectConfigs() ?? []}>
                    {(entry) => (
                      <button
                        type="button"
                        class="card"
                        style={{ cursor: "pointer", "text-align": "left", width: "100%" }}
                        onClick={() => setSelectedProject(entry)}
                      >
                        <div class="card-title">
                          <span class="pill blue">project</span>
                          <span style={{ "margin-left": "8px", "font-weight": "600" }}>
                            {entry.project_name}
                          </span>
                        </div>
                        <div class="card-meta">
                          <span>{entry.worktree}</span>
                          <span>·</span>
                          <span>
                            {entry.exists ? "magic-context.jsonc" : ".opencode/magic-context.jsonc"}
                          </span>
                        </div>
                      </button>
                    )}
                  </For>
                </div>
              ) : (
                <div class="empty-state">
                  <span class="empty-state-icon">📁</span>
                  <span>No project-level configs found</span>
                  <span style={{ "font-size": "11px" }}>
                    Create <code>magic-context.jsonc</code> in a project root to add
                    project-specific overrides
                  </span>
                </div>
              )
            }
          >
            {(proj) => (
              <ProjectConfigDetail
                entry={proj()}
                onBack={() => setSelectedProject(null)}
                models={props.models}
              />
            )}
          </Show>
        </Show>
      </div>
    </>
  );
}
