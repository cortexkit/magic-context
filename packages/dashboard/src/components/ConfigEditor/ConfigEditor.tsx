import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Show,
} from "solid-js";
import { getConfig, getProjectConfigs, saveConfig, saveProjectConfig } from "../../lib/api";
import { jsoncErrorMessage, parseJsonc } from "../../lib/jsonc";
import { invoke } from "../../lib/platform";
import type { ModelCatalogs, OpencodeInstallState, ProjectConfigEntry } from "../../lib/types";
import { configSaveBlocker } from "./config-save-guard";
import { configDefault, configSchemaNode, defaultLabel, defaultPlaceholder } from "./config-schema";
import type { DreamTaskConfig, DreamTaskModelConfig } from "./DreamerTasksField";
import DreamerTasksField from "./DreamerTasksField";
import HarnessModelFields, { type Harness, modelCatalogForHarness } from "./HarnessModelFields";
import HelpPopover from "./HelpPopover";
import { LANGUAGE_OPTIONS } from "./languages";
import ModelRoutes from "./ModelRoutes";
import ModelSelect from "./ModelSelect";
import PerModelTable from "./PerModelTable";
import { PER_MODEL_KEYS, type PerModelValues } from "./per-model-overrides";
import SearchPicker from "./SearchPicker";
import StringList from "./StringList";
import { structuredConfigSaveContent } from "./structured-save";
import ToolDescriptions, { normalizeToolDescriptions } from "./ToolDescriptions";
import "./config-editor.css";

// ── JSONC helpers ───────────────────────────────────────────

const CONFIG_TAB_STORAGE_KEY = "magic-context-dashboard.config-tab";
const MAGIC_CONTEXT_SCHEMA_URL =
  "https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json";
const USER_DEFAULT_CONFIG = `{
  "$schema": "${MAGIC_CONTEXT_SCHEMA_URL}",
  "enabled": true
}`;

type ConfigTarget = "user" | "projects";

function loadConfigTarget(): ConfigTarget {
  try {
    return localStorage.getItem(CONFIG_TAB_STORAGE_KEY) === "projects" ? "projects" : "user";
  } catch {
    return "user";
  }
}

interface ParsedConfigContent {
  value: Record<string, unknown>;
  error: string | null;
}

function parseConfigContent(text: string): ParsedConfigContent {
  try {
    return { value: parseJsonc(text), error: null };
  } catch (error) {
    return { value: {}, error: jsoncErrorMessage(error) };
  }
}

// ── Config field definitions ────────────────────────────────

interface FieldDef {
  key: string;
  label: string;
  type: "boolean" | "number" | "string" | "select";
  options?: string[];
  description: string;
  section: string;
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
    key: "allow_home_project",
    label: "Allow Home Directory Sessions",
    type: "boolean",
    description:
      "Allow sessions started exactly from your home directory to use a durable Magic Context project identity. User-level only.",
    section: "General",
  },
  {
    key: "language",
    label: "Output Language",
    type: "string",
    description:
      "Optional user-level output language for Magic Context generated prose and guidance, as a 2-letter ISO 639-1 code (e.g. tr, es, de, ja). Leave blank to keep today's behavior.",
    section: "General",
  },
  {
    key: "toast_duration_ms",
    label: "Toast Duration (ms)",
    type: "number",
    description: "How long Magic Context TUI toasts stay visible.",
    section: "General",
  },
  // Mural
  {
    key: "mural.enabled",
    label: "Mural Enabled",
    type: "boolean",
    description:
      "Render a deterministic image of project memories that did not fit the context budget.",
    section: "Memory & search",
  },
  {
    key: "mural.model",
    label: "Cue Compressor Model",
    type: "string",
    description:
      "Shared across harnesses. Model used to compress each memory into a mural cue. The mural image itself is rendered deterministically.",
    section: "Background models",
  },
  // Context defaults and their exceptions are rendered by PerModelTable.
  // Tags & cleanup
  {
    key: "protected_tokens",
    label: "Protected tokens",
    type: "number",
    description:
      "Absolute token floor protected from automatic reclaim (4,000–1,000,000). Leave blank to derive it from the model's usable context window. User-level only.",
    section: "Context window",
  },
  // Historian
  {
    key: "history_budget_percentage",
    label: "History Budget %",
    type: "number",
    description: "Fraction of context limit reserved for rendered history (0.0–1.0).",
    section: "History",
  },
  {
    key: "historian_timeout_ms",
    label: "Historian Timeout (ms)",
    type: "number",
    description: "Max wait time for a historian run before timeout.",
    section: "History",
  },
  // Memory
  {
    key: "memory.enabled",
    label: "Memory Enabled",
    type: "boolean",
    description: "Enable cross-session project memory.",
    section: "Memory & search",
  },
  {
    key: "memory.injection_budget_tokens",
    label: "Injection Budget (tokens)",
    type: "number",
    description: "Max tokens for memory injection into session history.",
    section: "Memory & search",
  },
  {
    key: "memory.auto_promote",
    label: "Auto Promote",
    type: "boolean",
    description: "Automatically promote session facts to project memory.",
    section: "Memory & search",
  },
  {
    key: "memory.retrieval_count_promotion_threshold",
    label: "Retrieval Count Promotion Threshold",
    type: "number",
    description:
      "Minimum ctx_search retrieval count before a session fact is auto-promoted to project memory.",
    section: "Memory & search",
  },
];

// These fields are valid only in trusted user configuration. They remain in the
// schema coverage manifest because the user form renders them, but project forms
// must not present controls for settings the runtime strips from repositories.
const USER_ONLY_FORM_FIELDS = new Set([
  "language",
  "allow_home_project",
  "mural.model",
  "protected_tokens",
]);

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

const CONFIG_SECTIONS = [
  "General",
  "Context window",
  "History",
  "Memory & search",
  "Background models",
  "Dreamer schedule",
  "Prompt surface",
  "Advanced",
];

// ── ConfigForm component ────────────────────────────────────

function ConfigForm(props: {
  content: string;
  exists: boolean;
  readError?: string | null;
  path: string;
  onSave: (content: string) => void | Promise<void>;
  saveStatus: string | null;
  modelCatalogs: ModelCatalogs;
  opencodeInstallState: OpencodeInstallState;
  /** "user" or "project". Project configs are untrusted repository input: the
   *  runtime strips embedding endpoint/provider from them, and the Test
   *  Connection probe refuses project scope (it would expand the repo's
   *  {env:}/{file:} tokens and contact its endpoint, a secret-exfil vector).
   *  So the embedding column is hidden for project scope. Defaults to "user". */
  scope?: "user" | "project";
}) {
  const [showRaw, setShowRaw] = createSignal(false);
  const [showKeys, setShowKeys] = createSignal(false);
  const [activeSection, setActiveSection] = createSignal("General");
  const [rawEdit, setRawEdit] = createSignal<string | null>(null);
  const [formData, setFormData] = createSignal<Record<string, unknown>>({});
  const [embeddingTestResult, setEmbeddingTestResult] = createSignal<{
    ok: boolean;
    message: string;
  } | null>(null);
  const isUserScope = () => (props.scope ?? "user") === "user";

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
    | { kind: "unresolved_token"; field: string; token: string }
    | { kind: "blocked_sensitive_file"; field: string; token: string; reason: string }
    | { kind: "scope_not_allowed"; scope: string };

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
      case "unresolved_token": {
        // Message depends on the token kind: a {file:} token failed because the
        // file is missing/unreadable; an {env:} token failed because the var is
        // not exported into this GUI process (the classic "launch from a
        // terminal" case). The old wording assumed env for both, which was wrong
        // and confusing for the recommended {file:~/...key} pattern.
        const isFile = outcome.token.startsWith("{file:");
        const detail = isFile
          ? "the file it points to could not be read (check the path exists and is readable)"
          : "the environment variable is not set in this process. Launch the app from a terminal where your shell exports it, or run `doctor` to validate from the shell";
        return {
          ok: false,
          message: `${outcome.field} references ${outcome.token}, but ${detail}.`,
        };
      }
      case "blocked_sensitive_file":
        return {
          ok: false,
          message: `${outcome.field} references ${outcome.token}, which resolves to a credential location (${outcome.reason}). Refusing to read it for an endpoint test. Point this at your embedding API key, not a credential file.`,
        };
      case "scope_not_allowed":
        return {
          ok: false,
          message: `Test Connection is only available for user-level config. Project config cannot set an embedding endpoint (the runtime ignores it), so there is nothing to test here.`,
        };
    }
  }
  const models = () => modelCatalogForHarness(props.modelCatalogs, "opencode");
  const [backgroundHarness, setBackgroundHarness] = createSignal<Harness>("opencode");
  const [dreamerHarness, setDreamerHarness] = createSignal<Harness>("opencode");
  const modelsForHarness = (harness: Harness) =>
    modelCatalogForHarness(props.modelCatalogs, harness);
  const showManualModelHint = () =>
    props.opencodeInstallState === "desktop" || models().length === 0;
  // The "Desktop detected" wording is only accurate when detection actually
  // reported a Desktop-only install. An empty model list with the CLI present
  // (e.g. `opencode models` returned nothing) gets the neutral phrasing.
  const manualModelHint = () => (
    <Show when={showManualModelHint()}>
      <span
        class="config-field-desc"
        style={{ color: "var(--text-muted)", "font-style": "italic" }}
      >
        {props.opencodeInstallState === "desktop"
          ? "OpenCode Desktop detected, CLI not installed. Type a model id manually, or install the OpenCode CLI to auto-populate models."
          : "No models found. Type a model id manually, or install/configure the OpenCode CLI to auto-populate models."}
      </span>
    </Show>
  );

  const parsedState = createMemo(() => parseConfigContent(props.content));
  const parsed = createMemo(() => parsedState().value);
  createEffect(() => {
    const next = parsedState();
    if (!next.error) {
      setFormData(next.value);
    } else {
      setShowRaw(true);
      setRawEdit(null);
    }
  });

  // Structured saves merge form fields into the parsed file. If reading or
  // parsing failed, saving the fallback object would erase secrets and unknown settings.
  const structuredSaveBlocker = createMemo(() =>
    configSaveBlocker({
      exists: props.exists,
      readError: props.readError,
      parseError: parsedState().error,
    }),
  );
  const saveMessage = () => structuredSaveBlocker() ?? props.saveStatus;

  const hasChanges = createMemo(() => {
    return !structuredSaveBlocker() && JSON.stringify(formData()) !== JSON.stringify(parsed());
  });

  const sections = createMemo(() => {
    const groups: Record<string, FieldDef[]> = {};
    for (const field of FIELD_DEFS) {
      if (!groups[field.section]) groups[field.section] = [];
      groups[field.section].push(field);
    }
    return Object.entries(groups).sort(
      ([a], [b]) => CONFIG_SECTIONS.indexOf(a) - CONFIG_SECTIONS.indexOf(b),
    );
  });

  const fieldsForScope = (fields: FieldDef[]) =>
    isUserScope() ? fields : fields.filter((field) => !USER_ONLY_FORM_FIELDS.has(field.key));

  const handleFieldChange = (key: string, value: unknown) => {
    const updated = setNestedValue(formData(), key, value);
    setFormData(updated);
  };

  const handlePerModelChange = (patch: PerModelValues) => {
    setFormData((previous) => ({ ...previous, ...patch }));
  };
  const inheritedDefault = (key: string) => (
    <Show when={getNestedValue(formData(), key) === undefined}>
      <span class="config-inherited">Default: {defaultLabel(key)}</span>
    </Show>
  );
  const booleanSetting = (key: string) => getNestedValue(formData(), key) ?? configDefault(key);

  const handleFormSave = () => {
    if (structuredSaveBlocker()) {
      return;
    }

    // Patch the values into the file text rather than re-serializing the
    // object, so the user's comments survive. The guard above has already
    // checked that `props.content` parses.
    props.onSave(structuredConfigSaveContent(props.content, normalizeToolDescriptions(formData())));
  };

  const handleRawSave = () => {
    const content = rawEdit();
    if (content != null) {
      props.onSave(content);
      setRawEdit(null);
      const next = parseConfigContent(content);
      if (!next.error) {
        setFormData(next.value);
      }
    }
  };

  const renderField = (field: FieldDef): JSX.Element => {
    const value = () => {
      const formVal = getNestedValue(formData(), field.key);
      return formVal;
    };
    const booleanValue = () => {
      const v = value();
      if (typeof v === "boolean") return v;
      return Boolean(configDefault(field.key));
    };

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
              aria-label={field.label}
              checked={booleanValue()}
              onChange={(e) => handleFieldChange(field.key, e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
            <span class="toggle-label">
              {booleanValue() ? "Enabled" : "Disabled"}
              {inheritedDefault(field.key)}
            </span>
          </label>
        ) : field.type === "select" ? (
          <select
            class="config-input"
            value={String(value() ?? "")}
            onChange={(e) => handleFieldChange(field.key, e.currentTarget.value)}
          >
            <For each={field.options ?? []}>{(opt) => <option value={opt}>{opt}</option>}</For>
          </select>
        ) : field.type === "number" ? (
          <input
            class="config-input"
            type="number"
            aria-label={field.label}
            min={configSchemaNode(field.key)?.minimum}
            max={configSchemaNode(field.key)?.maximum}
            step={field.key === "history_budget_percentage" ? 0.01 : 1}
            value={value() != null ? String(value()) : ""}
            placeholder={defaultPlaceholder(field.key, "Derived from model window")}
            onInput={(e) => {
              const v = e.currentTarget.value;
              handleFieldChange(field.key, v ? Number(v) : undefined);
            }}
          />
        ) : field.key === "language" ? (
          <SearchPicker
            label="Output Language"
            value={value() as string | undefined}
            options={LANGUAGE_OPTIONS}
            emptyLabel="No override"
            onChange={(next) => handleFieldChange(field.key, next)}
          />
        ) : field.key === "mural.model" ? (
          <ModelSelect
            label="Cue Compressor Model"
            models={[...new Set(Object.values(props.modelCatalogs).filter(Array.isArray).flat())]}
            value={value() as string | undefined}
            placeholder="Use built-in cue model"
            onChange={(next) => handleFieldChange(field.key, next || undefined)}
          />
        ) : (
          <input
            class="config-input"
            type="text"
            aria-label={field.label}
            value={typeof value() === "object" ? JSON.stringify(value()) : String(value() ?? "")}
            placeholder={defaultPlaceholder(
              field.key,
              field.key === "language" ? "No language override" : "Use built-in cue model",
            )}
            onInput={(e) => {
              const next = e.currentTarget.value;
              handleFieldChange(
                field.key,
                field.key === "language" && next.trim() === "" ? undefined : next,
              );
            }}
          />
        )}
      </div>
    );
  };

  return (
    <div class={`config-editor ${showKeys() ? "show-config-keys" : ""}`}>
      {/* Sticky Action Bar */}
      <div class="config-action-bar">
        <div class="config-file-meta">
          <code title={props.path}>{props.path}</code>
          <span>
            {isUserScope()
              ? "Shared CortexKit user config · OpenCode, Pi & OMP"
              : "Project configuration"}
          </span>
        </div>
        <fieldset class="config-segmented" aria-label="Editor mode">
          <button
            type="button"
            classList={{ active: !showRaw() }}
            aria-pressed={!showRaw()}
            onClick={() => setShowRaw(false)}
          >
            Form
          </button>
          <button
            type="button"
            classList={{ active: showRaw() }}
            aria-pressed={showRaw()}
            onClick={() => {
              setShowRaw(true);
              setRawEdit(null);
            }}
          >
            Raw JSONC
          </button>
        </fieldset>
        <div class="config-header-actions">
          <Show when={!showRaw()}>
            <label class="toggle-switch config-keys-toggle">
              <input
                type="checkbox"
                checked={showKeys()}
                onChange={(event) => setShowKeys(event.currentTarget.checked)}
              />
              <span class="toggle-slider" />
              <span>Show config keys</span>
            </label>
          </Show>
          <Show when={saveMessage()}>
            {(message) => (
              <span
                style={{
                  "font-size": "12px",
                  color: message().startsWith("✓") ? "var(--green)" : "var(--red)",
                }}
              >
                {message()}
              </span>
            )}
          </Show>
          <button
            type="button"
            class="btn primary sm config-save"
            disabled={showRaw() ? rawEdit() == null || rawEdit() === props.content : !hasChanges()}
            onClick={() => (showRaw() ? handleRawSave() : handleFormSave())}
          >
            {(showRaw() && rawEdit() != null && rawEdit() !== props.content) ||
            (!showRaw() && hasChanges())
              ? "● Save changes"
              : "Saved"}
          </button>
        </div>
      </div>

      <Show when={parsedState().error}>
        {(error) => {
          const line = error().match(/Line\s+(\d+)/i)?.[1] ?? "1";
          const column = error().match(/column\s+(\d+)/i)?.[1] ?? "1";
          return (
            <div class="empty-state" style={{ color: "var(--red)", "margin-bottom": "12px" }}>
              Config: PARSE FAILED ({props.path}:{line}:{column}) — structured defaults are not
              shown; fix the file in Raw JSONC. {error()}
            </div>
          );
        }}
      </Show>

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
                <button type="button" class="btn sm" onClick={() => setRawEdit(null)}>
                  Cancel
                </button>
              </div>
            </Show>
          </div>
        }
      >
        <div class="config-workspace">
          <nav class="config-section-index" aria-label="Config sections">
            <span class="config-index-eyebrow">Settings</span>
            <For each={CONFIG_SECTIONS}>
              {(section, index) => (
                <button
                  type="button"
                  classList={{ active: activeSection() === section }}
                  aria-current={activeSection() === section ? "page" : undefined}
                  onClick={() => setActiveSection(section)}
                >
                  <span>{String(index() + 1).padStart(2, "0")}</span>
                  {section}
                </button>
              )}
            </For>
            <p>Blank inputs inherit a default. Only restart-sensitive settings are badged.</p>
          </nav>
          <section class="config-section-panel" aria-label={activeSection()}>
            <h2>{activeSection()}</h2>
            <div class="config-grid">
              <For each={sections()}>
                {([sectionName, fields]) => {
                  return (
                    <>
                      <div class="config-card full-width" hidden={activeSection() !== sectionName}>
                        {sectionName === "Memory & search" ? (
                          (() => {
                            const embeddingProvider = () => {
                              const v = getNestedValue(formData(), "embedding.provider");
                              return (v as string) || "local";
                            };
                            const isRemote = () => embeddingProvider() === "openai-compatible";
                            const localDtype = () =>
                              String(getNestedValue(formData(), "embedding.local_dtype") ?? "fp32");
                            return (
                              <div class="config-card-two-col">
                                {/* Left: Memory settings */}
                                <div class="config-card-content">
                                  <For each={fieldsForScope(fields)}>{renderField}</For>
                                </div>
                                {/* Right: Embedding settings. Hidden for project
                                configs: the runtime strips embedding
                                endpoint/provider from untrusted project config,
                                and Test Connection on a project would be a
                                secret-exfil vector (expands the repo's tokens +
                                contacts its endpoint). Project memory toggles
                                live in the left column above. */}
                                <Show when={(props.scope ?? "user") !== "project"}>
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
                                              onClick={() =>
                                                handleFieldChange("embedding.provider", opt)
                                              }
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
                                        <div class="config-field">
                                          <div class="config-field-header">
                                            <span class="config-field-label">Model dtype</span>
                                            <span class="config-field-key">
                                              embedding.local_dtype
                                            </span>
                                          </div>
                                          <span class="config-field-desc">
                                            Uses Xenova/all-MiniLM-L6-v2 locally. Omitted keeps the
                                            fp32 ONNX dtype; quantized choices use less memory.
                                          </span>
                                          <select
                                            class="config-input"
                                            value={localDtype()}
                                            onChange={(e) =>
                                              handleFieldChange(
                                                "embedding.local_dtype",
                                                e.currentTarget.value || undefined,
                                              )
                                            }
                                          >
                                            <For
                                              each={[
                                                "auto",
                                                "fp32",
                                                "fp16",
                                                "q8",
                                                "int8",
                                                "uint8",
                                                "q4",
                                                "bnb4",
                                                "q4f16",
                                                "q2",
                                                "q2f16",
                                                "q1",
                                                "q1f16",
                                              ]}
                                            >
                                              {(dtype) => <option value={dtype}>{dtype}</option>}
                                            </For>
                                          </select>
                                        </div>
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
                                              getNestedValue(formData(), "embedding.endpoint") ??
                                                "",
                                            ).trim();
                                            const model = String(
                                              getNestedValue(formData(), "embedding.model") ?? "",
                                            ).trim();
                                            const apiKey = String(
                                              getNestedValue(formData(), "embedding.api_key") ?? "",
                                            ).trim();
                                            const inputType = String(
                                              getNestedValue(formData(), "embedding.input_type") ??
                                                "",
                                            ).trim();
                                            const truncate = String(
                                              getNestedValue(formData(), "embedding.truncate") ??
                                                "",
                                            ).trim();
                                            if (!endpoint || !model) {
                                              setEmbeddingTestResult({
                                                ok: false,
                                                message: "Endpoint and model are required",
                                              });
                                              return;
                                            }
                                            setEmbeddingTestResult({
                                              ok: false,
                                              message: "Testing...",
                                            });
                                            try {
                                              // Rust returns the structured outcome directly (not
                                              // `Result<T, String>` anymore). Any thrown error from
                                              // `invoke` itself is a tauri infrastructure failure
                                              // (e.g., command not registered) rather than a probe
                                              // classification — we surface that unchanged.
                                              const outcome = await invoke<EmbeddingProbeOutcome>(
                                                "test_embedding_endpoint",
                                                {
                                                  endpoint,
                                                  model,
                                                  apiKey: apiKey || null,
                                                  inputType: inputType || null,
                                                  truncate: truncate || null,
                                                  // Backend trust boundary: only "user"
                                                  // scope expands tokens + probes. The
                                                  // button is hidden for projects, but
                                                  // send the scope so the backend can
                                                  // refuse regardless.
                                                  source: props.scope ?? "user",
                                                },
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
                                </Show>
                              </div>
                            );
                          })()
                        ) : sectionName === "History" ? (
                          <div class="config-card-two-col">
                            {/* Right: Settings sliders */}
                            <div class="config-card-content">
                              <For each={fieldsForScope(fields)}>{renderField}</For>

                              {/* Commit Cluster Trigger */}
                              {(() => {
                                const commitCluster = () =>
                                  (getNestedValue(formData(), "commit_cluster_trigger") as
                                    | { enabled?: boolean; min_clusters?: number }
                                    | undefined) ?? {};
                                const enabled = () =>
                                  Boolean(booleanSetting("commit_cluster_trigger.enabled"));
                                const minClusters = () => commitCluster().min_clusters;
                                return (
                                  <>
                                    <div class="config-field">
                                      <div class="config-field-header">
                                        <span class="config-field-label">
                                          Commit Cluster Trigger
                                        </span>
                                        <span class="config-field-key">
                                          commit_cluster_trigger.enabled
                                        </span>
                                      </div>
                                      <span class="config-field-desc">
                                        Fire historian when enough git commit clusters accumulate in
                                        the unsummarized conversation tail. A commit cluster is a
                                        distinct work phase where the agent made git commits,
                                        separated by meaningful user turns.
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
                                          {inheritedDefault("commit_cluster_trigger.enabled")}
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
                                          value={minClusters() ?? ""}
                                          placeholder={defaultPlaceholder(
                                            "commit_cluster_trigger.min_clusters",
                                          )}
                                          onInput={(e) => {
                                            const v = e.currentTarget.value;
                                            handleFieldChange("commit_cluster_trigger", {
                                              ...commitCluster(),
                                              min_clusters: v ? Math.max(1, Number(v)) : undefined,
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
                            <For each={fieldsForScope(fields)}>{renderField}</For>
                          </div>
                        )}
                      </div>
                      {/* Defaults precede the context reclaim controls. */}
                      {sectionName === "General" && (
                        <div
                          class="config-card full-width"
                          hidden={activeSection() !== "Context window"}
                        >
                          <PerModelTable
                            values={Object.fromEntries(
                              PER_MODEL_KEYS.map((key) => [key, formData()[key]]),
                            )}
                            onChange={handlePerModelChange}
                            models={[
                              ...new Set(
                                [
                                  props.modelCatalogs.opencode,
                                  props.modelCatalogs.pi,
                                  props.modelCatalogs.omp,
                                ].flat(),
                              ),
                            ]}
                            userScope={isUserScope()}
                          />
                        </div>
                      )}
                    </>
                  );
                }}
              </For>

              {/* Prompt surface is editable in both scopes for routing. Override text
              is shown but locked for project config because the runtime removes
              those user-only fields before merging repository settings. */}
              {(() => {
                const promptSurface = () =>
                  (getNestedValue(formData(), "prompt_surface") as
                    | Record<string, unknown>
                    | undefined) ?? {};
                const userScope = () => (props.scope ?? "user") === "user";
                const defaultPreset = () =>
                  promptSurface().default === "light" ? "light" : "full";
                const setPromptSurface = (patch: Record<string, unknown>) =>
                  handleFieldChange("prompt_surface", { ...promptSurface(), ...patch });

                return (
                  <div class="config-card full-width" hidden={activeSection() !== "Prompt surface"}>
                    <div class="config-card-header">
                      <span class="config-card-icon">🪄</span>
                      <span class="config-card-title">Prompt Surface</span>
                    </div>
                    <div class="config-card-content">
                      <div
                        class="config-field-desc"
                        style={{ "margin-bottom": "8px", opacity: "0.85" }}
                      >
                        Choose the built-in full or light preset. Model routes use the literal
                        provider/model or provider/* form and are case-sensitive; additional slashes
                        in model IDs are preserved. Guidance and tool-description overrides are
                        user-only.
                      </div>
                      <div class="config-field">
                        <div class="config-field-header">
                          <span class="config-field-label">Default preset</span>
                          <span class="config-field-key">prompt_surface.default</span>
                        </div>
                        <select
                          class="config-input"
                          value={defaultPreset()}
                          onChange={(e) => setPromptSurface({ default: e.currentTarget.value })}
                        >
                          <option value="full">full</option>
                          <option value="light">light</option>
                        </select>
                      </div>
                      <div class="config-field config-field-wide">
                        <div class="config-field-header">
                          <span class="config-field-label">Model routes</span>
                          <span class="config-field-key">prompt_surface.models</span>
                        </div>
                        <span class="config-field-desc">
                          Routes from provider/model or provider/* to full or light. Leave empty for
                          default routing.
                        </span>
                        <ModelRoutes
                          models={models()}
                          value={promptSurface().models as Record<string, unknown> | undefined}
                          onChange={(next) => setPromptSurface({ models: next })}
                        />
                      </div>
                      <Show when={userScope()}>
                        <div class="config-field">
                          <div class="config-field-header">
                            <span class="config-field-label">Guidance override path</span>
                            <span class="config-field-key">
                              prompt_surface.guidance_override_path
                            </span>
                          </div>
                          <span class="config-field-desc">
                            User-only path to a complete primary guidance section. Relative paths
                            resolve from the user config file.
                          </span>
                          <input
                            class="config-input"
                            type="text"
                            disabled={!userScope()}
                            value={String(promptSurface().guidance_override_path ?? "")}
                            placeholder={userScope() ? "path/to/guidance.md" : "user config only"}
                            onInput={(e) =>
                              setPromptSurface({
                                guidance_override_path: e.currentTarget.value || undefined,
                              })
                            }
                          />
                        </div>
                      </Show>
                      <Show when={userScope()}>
                        <div class="config-field config-field-wide">
                          <div class="config-field-header">
                            <span class="config-field-label">Tool-description overrides</span>
                            <span class="config-field-key">prompt_surface.tool_descriptions</span>
                          </div>
                          <span class="config-field-desc">
                            User-only overrides keyed by tool ID. Only top-level descriptions
                            change; IDs, parameter schemas, and parameter descriptions remain fixed.
                          </span>
                          <ToolDescriptions
                            preset={defaultPreset()}
                            value={
                              promptSurface().tool_descriptions as
                                | Record<string, unknown>
                                | undefined
                            }
                            onChange={(next) => setPromptSurface({ tool_descriptions: next })}
                          />
                        </div>
                      </Show>
                    </div>
                  </div>
                );
              })()}

              {/* ── Agent Configuration Cards ───────────────────────── */}

              {/* Only model choices switch with the background harness tabs. */}
              <div class="config-card full-width" hidden={activeSection() !== "Background models"}>
                <div class="tab-pills">
                  <For each={["opencode", "pi", "omp"] as const}>
                    {(harness) => (
                      <button
                        type="button"
                        class={`tab-pill ${backgroundHarness() === harness ? "active" : ""}`}
                        onClick={() => setBackgroundHarness(harness)}
                      >
                        {harness === "opencode" ? "OpenCode" : harness === "pi" ? "Pi" : "OMP"}
                      </button>
                    )}
                  </For>
                </div>
                <Show when={backgroundHarness() === "opencode"}>{manualModelHint()}</Show>
                <div class="config-agent-grid">
                  <For each={["historian", "dreamer"] as const}>
                    {(agent) => (
                      <Show when={isUserScope() || agent === "dreamer"}>
                        <div class="config-agent-card">
                          <h3>{agent === "historian" ? "Historian" : "Dreamer"}</h3>
                          <HarnessModelFields
                            agent={agent}
                            harness={backgroundHarness()}
                            models={modelsForHarness(backgroundHarness())}
                            variants={props.modelCatalogs.opencodeVariants}
                            value={getNestedValue(formData(), `${agent}.${backgroundHarness()}`)}
                            onChange={(block) =>
                              handleFieldChange(`${agent}.${backgroundHarness()}`, block)
                            }
                          />
                        </div>
                      </Show>
                    )}
                  </For>
                </div>
                <Show when={!isUserScope()}>
                  <p class="config-table-note">
                    Historian model settings are user-config only. Project Dreamer overrides remain
                    editable.
                  </p>
                </Show>
              </div>

              <div class="config-card full-width" hidden={activeSection() !== "Dreamer schedule"}>
                <div class="config-card-header">
                  <span class="config-card-icon">🌙</span>
                  <span class="config-card-title">DREAMER</span>
                </div>
                <div class="config-card-two-col">
                  {/* Left: Enabled, Schedule, Inject Docs */}
                  <div class="config-card-content">
                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Dreamer agent enabled</span>
                        <span class="config-field-key">dreamer.disable (inverted)</span>
                      </div>
                      <span class="config-field-desc">
                        Controls whether the Dreamer hidden agent is registered. To keep manual
                        /ctx-dream but disable automatic runs, leave enabled and set Schedule to
                        empty.
                      </span>
                      <label class="toggle-switch">
                        <input
                          type="checkbox"
                          checked={getNestedValue(formData(), "dreamer.disable") !== true}
                          onChange={(e) => {
                            handleFieldChange("dreamer.disable", !e.currentTarget.checked);
                            handleFieldChange("dreamer.enabled", undefined);
                          }}
                        />
                        <span class="toggle-slider" />
                        <span class="toggle-label">
                          {getNestedValue(formData(), "dreamer.disable") !== true
                            ? "Enabled"
                            : "Disabled"}
                          <Show when={getNestedValue(formData(), "dreamer.disable") === undefined}>
                            <span class="config-inherited">Default: on</span>
                          </Show>
                        </span>
                      </label>
                    </div>

                    <div class="config-field">
                      <div class="config-field-header">
                        <span class="config-field-label">Inject Docs</span>
                        <span class="config-field-key">dreamer.inject_docs</span>
                      </div>
                      <span class="config-field-desc">
                        Inject ARCHITECTURE.md and STRUCTURE.md into agent context
                      </span>
                      <label class="toggle-switch">
                        <input
                          type="checkbox"
                          checked={Boolean(booleanSetting("dreamer.inject_docs"))}
                          onChange={(e) =>
                            handleFieldChange("dreamer.inject_docs", e.currentTarget.checked)
                          }
                        />
                        <span class="toggle-slider" />
                        <span class="toggle-label">
                          {booleanSetting("dreamer.inject_docs") ? "Enabled" : "Disabled"}
                          {inheritedDefault("dreamer.inject_docs")}
                        </span>
                      </label>
                    </div>
                  </div>

                  <div class="config-task-harness">
                    <div class="tab-pills" style={{ "margin-bottom": "12px" }}>
                      <button
                        type="button"
                        class={`tab-pill ${dreamerHarness() === "opencode" ? "active" : ""}`}
                        onClick={() => setDreamerHarness("opencode")}
                      >
                        OpenCode
                      </button>
                      <button
                        type="button"
                        class={`tab-pill ${dreamerHarness() === "pi" ? "active" : ""}`}
                        onClick={() => setDreamerHarness("pi")}
                      >
                        Pi
                      </button>
                      <button
                        type="button"
                        class={`tab-pill ${dreamerHarness() === "omp" ? "active" : ""}`}
                        onClick={() => setDreamerHarness("omp")}
                      >
                        OMP
                      </button>
                    </div>
                    <p class="config-table-note">
                      Tabs change task model overrides only. Blank model = this harness's Dreamer
                      model.
                    </p>
                  </div>
                </div>

                <div class="config-task-schedules">
                  <div class="config-field-header">
                    <span class="config-field-label">Task schedules and model overrides</span>
                    <span class="config-field-key">
                      dreamer.tasks / dreamer.{"<harness>"}.tasks
                    </span>
                  </div>
                  <span class="config-field-desc">
                    Schedules apply once for every harness. Click a task to edit cron, task
                    qualifiers, and promotion thresholds. Off means an empty schedule, not a
                    separate enable flag.
                  </span>
                  <DreamerTasksField
                    value={
                      getNestedValue(formData(), "dreamer.tasks") as
                        | Record<string, DreamTaskConfig>
                        | undefined
                    }
                    onChange={(tasks) => handleFieldChange("dreamer.tasks", tasks)}
                    harness={dreamerHarness()}
                    modelTasks={
                      getNestedValue(formData(), `dreamer.${dreamerHarness()}.tasks`) as
                        | Record<string, DreamTaskModelConfig>
                        | undefined
                    }
                    onModelTasksChange={(tasks) => {
                      const path = `dreamer.${dreamerHarness()}`;
                      const current = getNestedValue(formData(), path) as
                        | Record<string, unknown>
                        | undefined;
                      const next = { ...(current ?? {}) };
                      if (tasks) next.tasks = tasks;
                      else delete next.tasks;
                      handleFieldChange(path, next);
                    }}
                    models={modelsForHarness(dreamerHarness())}
                    variants={props.modelCatalogs.opencodeVariants}
                  />
                </div>
              </div>

              {/* History & Recall — features graduated out of `experimental.*` in
              v0.22.0. temporal_awareness is top-level; auto_search and
              git_commit_indexing live under `memory.*`; caveman is top-level.
              Full-width, rendered late. Each feature is a master toggle; child
              controls only appear when the feature is on. */}
              {(() => {
                // temporal_awareness — top-level boolean (default ON)
                const temporalAwareness = () => Boolean(booleanSetting("temporal_awareness"));

                // memory.git_commit_indexing — { enabled, since_days, max_commits }
                const gitCommit = () =>
                  (getNestedValue(formData(), "memory.git_commit_indexing") as
                    | { enabled?: boolean; since_days?: number; max_commits?: number }
                    | undefined) ?? {};
                const gitCommitEnabled = () =>
                  Boolean(booleanSetting("memory.git_commit_indexing.enabled"));
                const gitCommitSinceDays = () => gitCommit().since_days;
                const gitCommitMaxCommits = () => gitCommit().max_commits;
                const setGitCommit = (patch: Record<string, unknown>) =>
                  handleFieldChange("memory.git_commit_indexing", { ...gitCommit(), ...patch });

                // memory.auto_search — { enabled, score_threshold, min_prompt_chars } (default ON)
                const autoSearch = () =>
                  (getNestedValue(formData(), "memory.auto_search") as
                    | { enabled?: boolean; score_threshold?: number; min_prompt_chars?: number }
                    | undefined) ?? {};
                const autoSearchEnabled = () =>
                  Boolean(booleanSetting("memory.auto_search.enabled"));
                const autoSearchScoreThreshold = () => autoSearch().score_threshold;
                const autoSearchMinChars = () => autoSearch().min_prompt_chars;
                const setAutoSearch = (patch: Record<string, unknown>) =>
                  handleFieldChange("memory.auto_search", { ...autoSearch(), ...patch });

                // caveman_text_compression — top-level { enabled, min_chars }
                const caveman = () =>
                  (getNestedValue(formData(), "caveman_text_compression") as
                    | { enabled?: boolean; min_chars?: number }
                    | undefined) ?? {};
                const cavemanEnabled = () =>
                  Boolean(booleanSetting("caveman_text_compression.enabled"));
                const cavemanMinChars = () => caveman().min_chars;
                const setCaveman = (patch: Record<string, unknown>) =>
                  handleFieldChange("caveman_text_compression", { ...caveman(), ...patch });

                return (
                  <div
                    class="config-card full-width"
                    hidden={!["History", "Memory & search"].includes(activeSection())}
                  >
                    <div class="config-card-header">
                      <span class="config-card-icon">🔮</span>
                      <span class="config-card-title">History &amp; Recall</span>
                    </div>
                    <div class="config-card-content">
                      {/* Temporal awareness */}
                      <div class="config-field" hidden={activeSection() !== "History"}>
                        <div class="config-field-header">
                          <span class="config-field-label">Temporal Awareness</span>
                          <HelpPopover topic="temporal_awareness" label="Temporal Awareness" />
                          <span class="config-field-key">temporal_awareness</span>
                        </div>
                        <span class="config-field-desc">
                          Inject elapsed-time markers (e.g. <code>+12m</code>, <code>+3d 4h</code>)
                          between user messages with &gt;5 min gaps.
                        </span>
                        <label class="toggle-switch">
                          <input
                            type="checkbox"
                            checked={temporalAwareness()}
                            onChange={(e) =>
                              handleFieldChange("temporal_awareness", e.currentTarget.checked)
                            }
                          />
                          <span class="toggle-slider" />
                          <span class="toggle-label">
                            {temporalAwareness() ? "Enabled" : "Disabled"}
                            {inheritedDefault("temporal_awareness")}
                          </span>
                        </label>
                      </div>

                      {/* Auto search */}
                      <div class="config-field" hidden={activeSection() !== "Memory & search"}>
                        <div class="config-field-header">
                          <span class="config-field-label">Auto Search Hint</span>
                          <HelpPopover topic="auto_search" label="Auto Search Hint" />
                          <span class="config-field-key">memory.auto_search.enabled</span>
                        </div>
                        <span class="config-field-desc">
                          On each new user message, run <code>ctx_search</code> in the background
                          and append a compact <code>&lt;ctx-search-hint&gt;</code> block of vague
                          fragments when the top hit clears the score threshold.
                        </span>
                        <label class="toggle-switch">
                          <input
                            type="checkbox"
                            checked={autoSearchEnabled()}
                            onChange={(e) => setAutoSearch({ enabled: e.currentTarget.checked })}
                          />
                          <span class="toggle-slider" />
                          <span class="toggle-label">
                            {autoSearchEnabled() ? "Enabled" : "Disabled"}
                            {inheritedDefault("memory.auto_search.enabled")}
                          </span>
                        </label>
                      </div>

                      <Show when={activeSection() === "Memory & search" && autoSearchEnabled()}>
                        <div class="config-field">
                          <div class="config-field-header">
                            <span class="config-field-label">Score Threshold</span>
                            <span class="config-field-key">memory.auto_search.score_threshold</span>
                          </div>
                          <span class="config-field-desc">
                            Minimum top-hit score for the hint to fire. Higher = fewer but more
                            relevant hints. Range 0.30–0.95.
                          </span>
                          <input
                            class="config-input"
                            type="number"
                            min={0.3}
                            max={0.95}
                            step={0.05}
                            value={autoSearchScoreThreshold() ?? ""}
                            placeholder={defaultPlaceholder("memory.auto_search.score_threshold")}
                            onInput={(e) => {
                              const v = e.currentTarget.value;
                              setAutoSearch({
                                score_threshold: v
                                  ? Math.max(0.3, Math.min(0.95, Number(v)))
                                  : undefined,
                              });
                            }}
                          />
                        </div>
                        <div class="config-field">
                          <div class="config-field-header">
                            <span class="config-field-label">Min Prompt Chars</span>
                            <span class="config-field-key">
                              memory.auto_search.min_prompt_chars
                            </span>
                          </div>
                          <span class="config-field-desc">
                            Skip the hint when a user message is shorter than this. Avoids embedding
                            cost on trivial replies. Range 5–500, default 20.
                          </span>
                          <input
                            class="config-input"
                            type="number"
                            min={5}
                            max={500}
                            value={autoSearchMinChars() ?? ""}
                            placeholder={defaultPlaceholder("memory.auto_search.min_prompt_chars")}
                            onInput={(e) => {
                              const v = e.currentTarget.value;
                              setAutoSearch({
                                min_prompt_chars: v
                                  ? Math.max(5, Math.min(500, Number(v)))
                                  : undefined,
                              });
                            }}
                          />
                        </div>
                      </Show>

                      {/* Git commit indexing */}
                      <div class="config-field" hidden={activeSection() !== "Memory & search"}>
                        <div class="config-field-header">
                          <span class="config-field-label">Git Commit Indexing</span>
                          <HelpPopover topic="git_commit_indexing" label="Git Commit Indexing" />
                          <span class="config-field-key">memory.git_commit_indexing.enabled</span>
                        </div>
                        <span class="config-field-desc">
                          Index <code>HEAD</code> non-merge commits into <code>ctx_search</code> as
                          a 4th source alongside memories, facts, and message history.
                        </span>
                        <label class="toggle-switch">
                          <input
                            type="checkbox"
                            checked={gitCommitEnabled()}
                            onChange={(e) => setGitCommit({ enabled: e.currentTarget.checked })}
                          />
                          <span class="toggle-slider" />
                          <span class="toggle-label">
                            {gitCommitEnabled() ? "Enabled" : "Disabled"}
                            {inheritedDefault("memory.git_commit_indexing.enabled")}
                          </span>
                        </label>
                      </div>

                      <Show when={activeSection() === "Memory & search" && gitCommitEnabled()}>
                        <div class="config-field">
                          <div class="config-field-header">
                            <span class="config-field-label">History Window (days)</span>
                            <span class="config-field-key">
                              memory.git_commit_indexing.since_days
                            </span>
                          </div>
                          <span class="config-field-desc">
                            Days of HEAD history to index. Older commits are excluded from search.
                            Range 7–3650, default 365.
                          </span>
                          <input
                            class="config-input"
                            type="number"
                            min={7}
                            max={3650}
                            value={gitCommitSinceDays() ?? ""}
                            placeholder={defaultPlaceholder(
                              "memory.git_commit_indexing.since_days",
                            )}
                            onInput={(e) => {
                              const v = e.currentTarget.value;
                              setGitCommit({
                                since_days: v ? Math.max(7, Math.min(3650, Number(v))) : undefined,
                              });
                            }}
                          />
                        </div>
                        <div class="config-field">
                          <div class="config-field-header">
                            <span class="config-field-label">Max Commits</span>
                            <span class="config-field-key">
                              memory.git_commit_indexing.max_commits
                            </span>
                          </div>
                          <span class="config-field-desc">
                            Maximum commits kept per project. Oldest evicted when the cap is
                            reached. Range 100–20000, default 2000.
                          </span>
                          <input
                            class="config-input"
                            type="number"
                            min={100}
                            max={20000}
                            value={gitCommitMaxCommits() ?? ""}
                            placeholder={defaultPlaceholder(
                              "memory.git_commit_indexing.max_commits",
                            )}
                            onInput={(e) => {
                              const v = e.currentTarget.value;
                              setGitCommit({
                                max_commits: v
                                  ? Math.max(100, Math.min(20000, Number(v)))
                                  : undefined,
                              });
                            }}
                          />
                        </div>
                      </Show>

                      {/* Caveman text compression */}
                      <div class="config-field" hidden={activeSection() !== "History"}>
                        <div class="config-field-header">
                          <span class="config-field-label">Caveman Text Compression</span>
                          <HelpPopover
                            topic="caveman_text_compression"
                            label="Caveman Text Compression"
                          />
                          <span class="config-field-key">caveman_text_compression.enabled</span>
                        </div>
                        <span class="config-field-desc">
                          Age-tiered compression for long user/assistant text parts.
                        </span>
                        <label class="toggle-switch">
                          <input
                            type="checkbox"
                            checked={cavemanEnabled()}
                            onChange={(e) => setCaveman({ enabled: e.currentTarget.checked })}
                          />
                          <span class="toggle-slider" />
                          <span class="toggle-label">
                            {cavemanEnabled() ? "Enabled" : "Disabled"}
                            {inheritedDefault("caveman_text_compression.enabled")}
                          </span>
                        </label>
                      </div>

                      <Show when={activeSection() === "History" && cavemanEnabled()}>
                        <div class="config-field">
                          <div class="config-field-header">
                            <span class="config-field-label">Min Chars</span>
                            <span class="config-field-key">caveman_text_compression.min_chars</span>
                          </div>
                          <span class="config-field-desc">
                            Text parts shorter than this are left untouched. Range 100–10000,
                            default 500.
                          </span>
                          <input
                            class="config-input"
                            type="number"
                            min={100}
                            max={10000}
                            step={50}
                            value={cavemanMinChars() ?? ""}
                            placeholder={defaultPlaceholder("caveman_text_compression.min_chars")}
                            onInput={(e) => {
                              const v = e.currentTarget.value;
                              setCaveman({
                                min_chars: v
                                  ? Math.max(100, Math.min(10000, Number(v)))
                                  : undefined,
                              });
                            }}
                          />
                        </div>
                      </Show>
                    </div>
                  </div>
                );
              })()}

              {/* Advanced — power-user / debug knobs. Full-width, rendered last. */}
              {(() => {
                const autoUpdate = () => Boolean(booleanSetting("auto_update"));
                const keepSubagents = () => Boolean(booleanSetting("keep_subagents"));
                const todowrite = () =>
                  (getNestedValue(formData(), "todowrite") as
                    | { enabled?: boolean; overlay?: boolean }
                    | undefined) ?? {};
                const todowriteEnabled = () => Boolean(booleanSetting("todowrite.enabled"));
                const todowriteOverlay = () => Boolean(booleanSetting("todowrite.overlay"));
                const setTodowrite = (patch: Record<string, unknown>) =>
                  handleFieldChange("todowrite", { ...todowrite(), ...patch });
                const [protectedToolsDraft, setProtectedToolsDraft] = createSignal<
                  string | undefined
                >();
                const sqlite = () =>
                  (getNestedValue(formData(), "sqlite") as
                    | { cache_size_mb?: number; mmap_size_mb?: number }
                    | undefined) ?? {};
                const sqliteCacheMb = () => sqlite().cache_size_mb;
                const sqliteMmapMb = () => sqlite().mmap_size_mb;
                const setSqlite = (patch: Record<string, unknown>) =>
                  handleFieldChange("sqlite", { ...sqlite(), ...patch });
                const systemPromptInjectionEnabled = () =>
                  Boolean(booleanSetting("system_prompt_injection.enabled"));
                const compactionEnabled = () => Boolean(booleanSetting("compaction.enabled"));
                const storagePrivatePermissions = () =>
                  Boolean(booleanSetting("storage.enforce_private_permissions"));
                const piExtensions = () => {
                  const value = getNestedValue(formData(), "pi.subagent_extensions");
                  return Array.isArray(value)
                    ? value.filter((entry): entry is string => typeof entry === "string")
                    : [];
                };

                return (
                  <div
                    class="config-card full-width"
                    hidden={
                      !["Advanced", "Context window", "Prompt surface"].includes(activeSection())
                    }
                  >
                    <div class="config-card-header">
                      <span class="config-card-icon">🛠️</span>
                      <span class="config-card-title">Advanced</span>
                    </div>
                    <div class="config-card-content">
                      <Show when={isUserScope()}>
                        {/* Auto update */}
                        <div class="config-field" hidden={activeSection() !== "Advanced"}>
                          <div class="config-field-header">
                            <span class="config-field-label">Auto Update</span>
                            <span class="config-field-key">auto_update</span>
                          </div>
                          <span class="config-field-desc">
                            Automatically self-update the OpenCode plugin to the latest published
                            version on startup. On by default. (User-config only — project configs
                            cannot change it.)
                          </span>
                          <label class="toggle-switch">
                            <input
                              type="checkbox"
                              checked={autoUpdate()}
                              onChange={(e) =>
                                handleFieldChange("auto_update", e.currentTarget.checked)
                              }
                            />
                            <span class="toggle-slider" />
                            <span class="toggle-label">
                              {autoUpdate() ? "Enabled" : "Disabled"}
                              {inheritedDefault("auto_update")}
                            </span>
                          </label>
                        </div>
                      </Show>

                      {/* Keep subagents */}
                      <div class="config-field" hidden={activeSection() !== "Advanced"}>
                        <div class="config-field-header">
                          <span class="config-field-label">Keep Subagent Sessions</span>
                          <HelpPopover topic="keep_subagents" label="Keep Subagent Sessions" />
                          <span class="config-field-key">keep_subagents</span>
                        </div>
                        <span class="config-field-desc">
                          Retain the child sessions magic-context spawns for its own agents
                          (historian, dreamer, memory migration, key-files, user-memory).
                        </span>
                        <label class="toggle-switch">
                          <input
                            type="checkbox"
                            checked={keepSubagents()}
                            onChange={(e) =>
                              handleFieldChange("keep_subagents", e.currentTarget.checked)
                            }
                          />
                          <span class="toggle-slider" />
                          <span class="toggle-label">
                            {keepSubagents() ? "Enabled" : "Disabled"}
                            {inheritedDefault("keep_subagents")}
                          </span>
                        </label>
                      </div>

                      {/* Pi todowrite */}
                      <div class="config-field" hidden={activeSection() !== "Advanced"}>
                        <div class="config-field-header">
                          <span class="config-field-label">Pi Todowrite Tool</span>
                          <span class="config-restart-badge">Reload / restart</span>
                          <span class="config-field-key">todowrite.enabled</span>
                        </div>
                        <span class="config-field-desc">
                          Register Magic Context&apos;s Pi <code>todowrite</code> task-list tool.
                          Disable this if you use another Pi todo extension. OpenCode has its own
                          built-in todowrite, so this setting only affects Pi. Requires /reload or
                          restart after changing.
                        </span>
                        <label class="toggle-switch">
                          <input
                            type="checkbox"
                            checked={todowriteEnabled()}
                            onChange={(e) => setTodowrite({ enabled: e.currentTarget.checked })}
                          />
                          <span class="toggle-slider" />
                          <span class="toggle-label">
                            {todowriteEnabled() ? "Enabled" : "Disabled"}
                            {inheritedDefault("todowrite.enabled")}
                          </span>
                        </label>
                      </div>

                      <Show when={activeSection() === "Advanced" && todowriteEnabled()}>
                        <div class="config-field">
                          <div class="config-field-header">
                            <span class="config-field-label">Pi Todo Overlay</span>
                            <span class="config-restart-badge">Reload / restart</span>
                            <span class="config-field-key">todowrite.overlay</span>
                          </div>
                          <span class="config-field-desc">
                            Show the persistent todo overlay above the editor while tasks are
                            active. The /todos command and tool remain available when only the
                            overlay is off.
                          </span>
                          <label class="toggle-switch">
                            <input
                              type="checkbox"
                              checked={todowriteOverlay()}
                              onChange={(e) => setTodowrite({ overlay: e.currentTarget.checked })}
                            />
                            <span class="toggle-slider" />
                            <span class="toggle-label">
                              {todowriteOverlay() ? "Enabled" : "Disabled"}
                              {inheritedDefault("todowrite.overlay")}
                            </span>
                          </label>
                        </div>
                      </Show>

                      <Show when={isUserScope()}>
                        <div class="config-field" hidden={activeSection() !== "Context window"}>
                          <div class="config-field-header">
                            <span class="config-field-label">Compaction Management</span>
                            <span class="config-restart-badge">Restart</span>
                            <span class="config-field-key">compaction.enabled</span>
                          </div>
                          <span class="config-field-desc">
                            Let Magic Context manage the context window. Turn this off to keep
                            memory and search features while native compaction (or nothing) owns the
                            window. Requires a restart and applies only to user configuration.
                          </span>
                          <label class="toggle-switch">
                            <input
                              type="checkbox"
                              checked={compactionEnabled()}
                              onChange={(e) =>
                                handleFieldChange("compaction.enabled", e.currentTarget.checked)
                              }
                            />
                            <span class="toggle-slider" />
                            <span class="toggle-label">
                              {compactionEnabled() ? "Enabled" : "Disabled"}
                              {inheritedDefault("compaction.enabled")}
                            </span>
                          </label>
                        </div>
                        <div class="config-field" hidden={activeSection() !== "Advanced"}>
                          <div class="config-field-header">
                            <span class="config-field-label">Private Storage Permissions</span>
                            <span class="config-field-key">
                              storage.enforce_private_permissions
                            </span>
                          </div>
                          <span class="config-field-desc">
                            Keep Magic Context directories owner-only (0700) and files owner-only
                            (0600). Disable only when a trusted group manages permissions
                            externally.
                          </span>
                          <label class="toggle-switch">
                            <input
                              type="checkbox"
                              checked={storagePrivatePermissions()}
                              onChange={(e) =>
                                handleFieldChange(
                                  "storage.enforce_private_permissions",
                                  e.currentTarget.checked,
                                )
                              }
                            />
                            <span class="toggle-slider" />
                            <span class="toggle-label">
                              {storagePrivatePermissions() ? "Enabled" : "Disabled"}
                              {inheritedDefault("storage.enforce_private_permissions")}
                            </span>
                          </label>
                        </div>
                        <div
                          class="config-field config-field-wide"
                          hidden={activeSection() !== "Advanced"}
                        >
                          <div class="config-field-header">
                            <span class="config-field-label">Pi Subagent Extensions</span>
                            <span class="config-field-key">pi.subagent_extensions</span>
                          </div>
                          <span class="config-field-desc">
                            Optional user-level allowlist for extensions loaded by Pi subagent
                            children. Add one extension path or package per row.
                          </span>
                          <StringList
                            label="Pi Subagent Extensions"
                            value={piExtensions()}
                            onChange={(entries) =>
                              handleFieldChange(
                                "pi.subagent_extensions",
                                entries.length ? entries : undefined,
                              )
                            }
                          />
                        </div>
                      </Show>

                      {/* Automatic result protection */}
                      <div class="config-field" hidden={activeSection() !== "Context window"}>
                        <div class="config-field-header">
                          <span class="config-field-label">Protected Tools</span>
                          <span class="config-field-key">protected_tools</span>
                        </div>
                        <span class="config-field-desc">
                          Keep each tool's newest active results from automatic and queued drops.
                          Counts merge over the defaults; 0 disables protection for a tool.
                        </span>
                        <details class="config-help">
                          <summary>Protection policy</summary>
                          <p>
                            Enter a JSON object mapping tool names to whole numbers ≥ 0. Names
                            ignore case and leading mcp_. Protection applies even at 95% pressure,
                            with no byte cap: large protected outputs can reach refusal sooner.
                            Changes affect later cache-rebuilding passes. Queued drops wait for
                            newer calls to displace the result; historian summaries and folds are
                            unaffected.
                          </p>
                        </details>
                        <textarea
                          class="code-editor"
                          rows={4}
                          placeholder={'{ "todowrite": 1, "ctx_reduce": 3 }'}
                          value={
                            protectedToolsDraft() ??
                            JSON.stringify(
                              getNestedValue(formData(), "protected_tools") ?? {},
                              null,
                              2,
                            )
                          }
                          onInput={(e) => {
                            const text = e.currentTarget.value;
                            setProtectedToolsDraft(text);
                            try {
                              const next = parseJsonc(text);
                              if (
                                next &&
                                typeof next === "object" &&
                                !Array.isArray(next) &&
                                Object.values(next).every(
                                  (n) => typeof n === "number" && Number.isInteger(n) && n >= 0,
                                )
                              ) {
                                handleFieldChange("protected_tools", next);
                                setProtectedToolsDraft(undefined);
                              }
                            } catch {
                              /* Keep invalid drafts visible without saving them. */
                            }
                          }}
                        />
                      </div>

                      {/* System prompt injection */}
                      <div class="config-field" hidden={activeSection() !== "Prompt surface"}>
                        <div class="config-field-header">
                          <span class="config-field-label">System Prompt Injection</span>
                          <span class="config-field-key">system_prompt_injection.enabled</span>
                        </div>
                        <span class="config-field-desc">
                          Inject the magic-context guidance text into the system prompt. On by
                          default. Disabling it stops the guidance block entirely. To exclude only
                          specific custom agents, set{" "}
                          <code>system_prompt_injection.skip_signatures</code> (a substring list) in
                          the raw editor.
                        </span>
                        <label class="toggle-switch">
                          <input
                            type="checkbox"
                            checked={systemPromptInjectionEnabled()}
                            onChange={(e) =>
                              handleFieldChange(
                                "system_prompt_injection.enabled",
                                e.currentTarget.checked,
                              )
                            }
                          />
                          <span class="toggle-slider" />
                          <span class="toggle-label">
                            {systemPromptInjectionEnabled() ? "Enabled" : "Disabled"}
                            {inheritedDefault("system_prompt_injection.enabled")}
                          </span>
                        </label>
                      </div>

                      <Show when={isUserScope() && activeSection() === "Advanced"}>
                        {/* SQLite tuning */}
                        <div class="config-field">
                          <div class="config-field-header">
                            <span class="config-field-label">SQLite Cache (MB)</span>
                            <span class="config-field-key">sqlite.cache_size_mb</span>
                          </div>
                          <span class="config-field-desc">
                            Per-connection page-cache size in MB. Higher reduces disk reads on large
                            databases at the cost of memory. Range 2–2048 MiB, default 64.
                          </span>
                          <input
                            class="config-input"
                            type="number"
                            min={configSchemaNode("sqlite.cache_size_mb")?.minimum}
                            max={configSchemaNode("sqlite.cache_size_mb")?.maximum}
                            value={sqliteCacheMb() ?? ""}
                            placeholder={defaultPlaceholder("sqlite.cache_size_mb")}
                            onInput={(e) => {
                              const v = e.currentTarget.value;
                              setSqlite({
                                cache_size_mb: v ? Number(v) : undefined,
                              });
                            }}
                          />
                        </div>
                        <div class="config-field">
                          <div class="config-field-header">
                            <span class="config-field-label">SQLite mmap (MB)</span>
                            <span class="config-field-key">sqlite.mmap_size_mb</span>
                          </div>
                          <span class="config-field-desc">
                            Memory-mapped I/O size in MB. 0 disables mmap. Can speed up large reads
                            on some filesystems. Range 0–8192 MiB, default 0.
                          </span>
                          <input
                            class="config-input"
                            type="number"
                            min={0}
                            max={configSchemaNode("sqlite.mmap_size_mb")?.maximum}
                            value={sqliteMmapMb() ?? ""}
                            placeholder={defaultPlaceholder("sqlite.mmap_size_mb")}
                            onInput={(e) => {
                              const v = e.currentTarget.value;
                              setSqlite({
                                mmap_size_mb: v ? Number(v) : undefined,
                              });
                            }}
                          />
                        </div>
                      </Show>
                    </div>
                  </div>
                );
              })()}
            </div>
          </section>
        </div>
      </Show>
    </div>
  );
}

// ── ProjectConfigDetail ─────────────────────────────────────

function ProjectConfigDetail(props: {
  entry: ProjectConfigEntry;
  onBack: () => void;
  modelCatalogs: ModelCatalogs;
  opencodeInstallState: OpencodeInstallState;
}) {
  const configPath = () => props.entry.config_path;

  const [config] = createResource(
    () => configPath(),
    async () => getConfig("project", props.entry.worktree),
  );

  const projectReadBlocker = createMemo(() =>
    configSaveBlocker({
      exists: config()?.exists ?? false,
      readError: config()?.error,
    }),
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
        <Show
          when={projectReadBlocker()}
          fallback={
            <ConfigForm
              content={config()?.content ?? ""}
              exists={config()?.exists ?? true}
              readError={config()?.error}
              path={config()?.path ?? configPath()}
              onSave={handleSave}
              saveStatus={saveStatus()}
              modelCatalogs={props.modelCatalogs}
              opencodeInstallState={props.opencodeInstallState}
              scope="project"
            />
          }
        >
          {(message) => <div class="empty-state">{message()}</div>}
        </Show>
      </Show>
    </div>
  );
}

// ── Main ConfigEditor ───────────────────────────────────────

export default function ConfigEditor(props: {
  modelCatalogs: ModelCatalogs;
  opencodeInstallState: OpencodeInstallState;
  catalogLoading: boolean;
  catalogError: string | null;
  onRetryCatalogs: () => void;
}) {
  const [configTarget, setConfigTarget] = createSignal<ConfigTarget>(loadConfigTarget());
  const [userConfig, { refetch: refetchUser }] = createResource(() => getConfig("user"));
  const [projectConfigs, { refetch: refetchProjects }] = createResource(getProjectConfigs);
  const [saveStatus, setSaveStatus] = createSignal<string | null>(null);
  const [selectedProject, setSelectedProject] = createSignal<ProjectConfigEntry | null>(null);
  const userReadBlocker = createMemo(() =>
    configSaveBlocker({
      exists: userConfig()?.exists ?? false,
      readError: userConfig()?.error,
    }),
  );

  const selectConfigTarget = (next: ConfigTarget) => {
    setConfigTarget(next);
    setSaveStatus(null);
    if (next === "projects") {
      setSelectedProject(null);
      return;
    }
    try {
      localStorage.setItem(CONFIG_TAB_STORAGE_KEY, next);
    } catch {
      // Ignore localStorage failures; in-memory tab selection still works.
    }
    refetchUser();
  };

  const handleUserSave = async (content: string) => {
    try {
      await saveConfig("user", content);
      refetchUser();
      setSaveStatus("✓ Saved");
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      setSaveStatus(`✕ Error: ${err}`);
      setTimeout(() => setSaveStatus(null), 4000);
    }
  };

  const handleCreateUserDefaults = async () => {
    await handleUserSave(USER_DEFAULT_CONFIG);
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

      <Show when={props.catalogLoading || props.catalogError}>
        <div class="empty-state" role="status">
          <span>{props.catalogLoading ? "Loading OpenCode models..." : props.catalogError}</span>
          <Show when={!props.catalogLoading && props.catalogError}>
            <button type="button" class="btn sm" onClick={props.onRetryCatalogs}>
              Retry model discovery
            </button>
          </Show>
        </div>
      </Show>

      <div class="tab-pills">
        <button
          type="button"
          class={`tab-pill ${configTarget() === "user" ? "active" : ""}`}
          onClick={() => selectConfigTarget("user")}
        >
          User Config
        </button>
        <button
          type="button"
          class={`tab-pill ${configTarget() === "projects" ? "active" : ""}`}
          onClick={() => selectConfigTarget("projects")}
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
        <Show when={configTarget() !== "projects"}>
          <Show
            when={!userConfig.loading}
            fallback={<div class="empty-state">Loading config...</div>}
          >
            <Show
              when={userConfig()?.exists}
              fallback={
                <div class="empty-state">
                  <span class="empty-state-icon">⚙️</span>
                  <span>No user config found at {userConfig()?.path}</span>
                  <span style={{ "font-size": "11px" }}>
                    Run <code>npx @cortexkit/magic-context setup</code> or create with defaults
                  </span>
                  <button type="button" class="btn" onClick={handleCreateUserDefaults}>
                    Create with defaults
                  </button>
                  <Show when={saveStatus()}>
                    <span style={{ "font-size": "11px" }}>{saveStatus()}</span>
                  </Show>
                </div>
              }
            >
              <Show
                when={userReadBlocker()}
                fallback={
                  <ConfigForm
                    content={userConfig()?.content ?? ""}
                    exists={userConfig()?.exists ?? true}
                    readError={userConfig()?.error}
                    path={userConfig()?.path ?? "magic-context.jsonc"}
                    onSave={handleUserSave}
                    saveStatus={saveStatus()}
                    modelCatalogs={props.modelCatalogs}
                    opencodeInstallState={props.opencodeInstallState}
                    scope="user"
                  />
                }
              >
                {(message) => <div class="empty-state">{message()}</div>}
              </Show>
            </Show>
          </Show>
        </Show>

        <Show when={configTarget() === "projects"}>
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
                          <span>.cortexkit/magic-context.jsonc</span>
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
                    Create <code>.cortexkit/magic-context.jsonc</code> in a project to add
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
                modelCatalogs={props.modelCatalogs}
                opencodeInstallState={props.opencodeInstallState}
              />
            )}
          </Show>
        </Show>
      </div>
    </>
  );
}
