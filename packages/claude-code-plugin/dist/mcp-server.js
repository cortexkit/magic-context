import {
  CTX_SEARCH_CLAUDE_CODE_DESCRIPTION,
  CTX_EXPAND_CLAUDE_CODE_DESCRIPTION,
  CTX_NOTE_CLAUDE_CODE_DESCRIPTION,
  MCP_SERVER_INSTRUCTIONS,
  cortexKitUserConfigBasePath,
  cortexKitProjectConfigBasePath,
  resolveLegacyConfigSources,
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  loadPluginConfigDetailed,
  SubcClient,
  connectionFileExists,
  SYNAPSE_DEFAULT_MODEL,
  toSynapseLaneDescriptor,
  SynapseEmbeddingProvider,
  loadCompartmentChunkEmbeddingsForSearch,
  getLastCompartmentEndMessage,
  getLastIndexedOrdinal,
  getIndexedMessageCorpusSize,
  ensureMessagesIndexed,
  setNoteLastReadAt,
  recordEmbeddingMeasurement,
  queueMemoryMutation,
  SESSION_NOTE_CONDITION_ERROR,
  getNoteByIdInScope,
  getNotes,
  addNote,
  getSessionNotes,
  getPendingSmartNotes,
  getReadySmartNotes,
  updateNote,
  dismissNotes,
  dismissNote,
  getActivePrimers,
  openRuntime,
  readCurrentSession,
  cosineSimilarity,
  computeNormalizedHash,
  loadProjectCommitEmbeddings,
  saveEmbeddingIfHashMatches,
  getProjectEmbeddings,
  invalidateProject,
  invalidateMemory,
  markProjectLoadUntrusted,
  registerProjectEmbedding,
  registerProjectShadowEmbedding,
  getShadowEmbeddingMeasurementCohort,
  getPrimaryEmbeddingMeasurementCohort,
  embedShadowTextForProject,
  enqueueShadowEmbeddingItems,
  registerProjectInObservationMode,
  unregisterProjectShadowEmbedding,
  getProjectEmbeddingSnapshot,
  embedTextForProject,
  isEmbeddingEnabled,
  embedText,
  ensureMemoryEmbeddings,
  hasMemoryShareableColumn,
  hasMemoryClassifiedAtColumn,
  ModuleMemoryAuthorityError,
  insertMemoryIdempotent,
  getMemoryByHash,
  getMemoriesByProject,
  getMemoriesByProjects,
  getMemoryById,
  getMemoriesByIds,
  updateMemorySeenCount,
  updateMemoryRetrievalCount,
  supersededMemory,
  mergeMemoryStats,
  archiveMemory,
  relaxedFtsQuery,
  sanitizeFtsQuery,
  searchMemoriesFTS,
  searchMemoriesFTSUnion,
  clearMemoryVerifications,
  EMPTY_READ_REPLY,
  noteTouchedAt,
  renderGlance,
  renderNotesById,
  formatWriteReply,
  getVisibleMemoryIds
} from "./chunk-32ztc1br.js";
import {
  getDataDir
} from "./chunk-6q6cxsv6.js";
import {
  log,
  sessionLog,
  flushLogger
} from "./chunk-e4mkgkj9.js";
import {
  getTagById,
  expandToolPart,
  withRawMessageProvider2,
  readRawSessionMessages2,
  visitRawSessionMessages2,
  readRawSessionMessageById2,
  readSessionChunk2
} from "./chunk-sztkf4tn.js";
import {
  directoryHasGitMetadata,
  describeUnresolvedProjectIdentity,
  resolveProjectIdentityForSession,
  normalizeStoredProjectPath,
  storedPathBelongsToIdentity,
  V2_MEMORY_CATEGORIES,
  CATEGORY_PRIORITY,
  resolveWorkspaceShareCategories,
  resolveWorkspaceIdentitySet,
  expandWorkspaceIdentitySetWithAliases,
  resolveStoredPathWorkspaceIdentity,
  storedPathBelongsToWorkspace,
  sourceNameForMemory,
  getErrorMessage
} from "./chunk-eea1pbdp.js";
import {
  estimateTokens
} from "./chunk-q5f7wcc8.js";
import {
  locateTranscript,
  createTranscriptSource,
  resolveMcpSession
} from "./chunk-zkqy4wkq.js";
import {
  TRIGGER_KINDS,
  OperationSkillError,
  loadSkill,
  listSkills,
  driftOf,
  isStale,
  saveSkill,
  markVerified,
  removeSkillOrOperation,
  findOperations,
  renderSetup,
  renderOperation
} from "./chunk-q6aesfzf.js";
import {
  logSlowWriteTransaction
} from "./chunk-t7etejbh.js";
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
// package.json
var package_default = {
  name: "@cortexkit/claude-code-magic-context",
  version: "0.44.4",
  private: true,
  type: "module",
  description: "Claude Code plugin for Magic Context: cross-session project memory, notes and recall (MCP server and hooks)",
  license: "MIT",
  author: "ualtinok",
  keywords: [
    "claude-code",
    "claude-code-plugin",
    "mcp",
    "memory",
    "context",
    "magic-context"
  ],
  repository: {
    type: "git",
    url: "https://github.com/cortexkit/magic-context",
    directory: "packages/claude-code-plugin"
  },
  scripts: {
    build: "bun ../../scripts/check-bun.mjs && tsc -p ../retina-local-fs/tsconfig.build.json && bun scripts/build.ts",
    typecheck: "tsc -p ../retina-local-fs/tsconfig.build.json && tsc --noEmit",
    test: "bun ../../scripts/check-bun.mjs && bun test --timeout 30000",
    smoke: "bun scripts/smoke.ts",
    "smoke:live": "bun scripts/smoke.ts --live",
    probe: "node scripts/load-probe.mjs",
    lint: "bun ../../scripts/check-bun.mjs && biome check src scripts test-preload.ts",
    "lint:fix": "biome check --write src scripts test-preload.ts",
    format: "biome format --write src scripts",
    clean: `bun -e "require('node:fs').rmSync('dist', { recursive: true, force: true })"`
  },
  devDependencies: {
    "@biomejs/biome": "^2.5.1",
    "@types/bun": "^1.3.10",
    "@types/node": "^22.20.0",
    typescript: "^5.8.0"
  },
  engines: {
    node: ">=22.13.0"
  }
};

// src/mcp/server.ts
import { createInterface } from "node:readline";
var SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
];
var PARSE_ERROR = -32700;
var INVALID_REQUEST = -32600;
var METHOD_NOT_FOUND = -32601;
var INVALID_PARAMS = -32602;
var INTERNAL_ERROR = -32603;
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

class McpServer {
  options;
  tools = null;
  constructor(options) {
    this.options = options;
  }
  async resolveTools() {
    if (!this.tools)
      this.tools = await this.options.getTools();
    return this.tools;
  }
  async handle(message) {
    if (Array.isArray(message)) {
      if (message.length === 0) {
        return errorResponse(null, INVALID_REQUEST, "Empty batch");
      }
      const responses = (await Promise.all(message.map((item) => this.handleOne(item)))).filter((response) => response !== undefined);
      return responses.length > 0 ? responses : undefined;
    }
    return this.handleOne(message);
  }
  async handleOne(message) {
    if (!isObject(message) || typeof message.method !== "string") {
      if (isObject(message) && (("result" in message) || ("error" in message)))
        return;
      const id = isObject(message) && isRpcId(message.id) ? message.id : null;
      return errorResponse(id, INVALID_REQUEST, "Invalid request");
    }
    const hasId = "id" in message && message.id !== undefined;
    const id = hasId && isRpcId(message.id) ? message.id : null;
    const params = isObject(message.params) ? message.params : {};
    try {
      const result = await this.dispatch(message.method, params);
      if (!hasId)
        return;
      if (result === NOT_FOUND) {
        return errorResponse(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
      }
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      if (!hasId) {
        this.options.log?.(`notification ${message.method} failed: ${describe(error)}`);
        return;
      }
      if (error instanceof InvalidParams) {
        return errorResponse(id, INVALID_PARAMS, error.message);
      }
      this.options.log?.(`${message.method} failed: ${describe(error)}`);
      return errorResponse(id, INTERNAL_ERROR, describe(error));
    }
  }
  async dispatch(method, params) {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requested);
        return {
          protocolVersion: protocolVersion ?? SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: this.options.name,
            ...this.options.title ? { title: this.options.title } : {},
            version: this.options.version
          },
          ...this.options.instructions ? { instructions: this.options.instructions } : {}
        };
      }
      case "ping":
        return {};
      case "tools/list": {
        const tools = await this.resolveTools();
        return {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...tool.annotations ? { annotations: tool.annotations } : {}
          }))
        };
      }
      case "tools/call":
        return this.callTool(params);
      default:
        return method.startsWith("notifications/") ? {} : NOT_FOUND;
    }
  }
  async callTool(params) {
    const name = params.name;
    if (typeof name !== "string")
      throw new InvalidParams("tools/call requires a tool name");
    const tool = (await this.resolveTools()).find((candidate) => candidate.name === name);
    if (!tool)
      throw new InvalidParams(`Unknown tool: ${name}`);
    const args = isObject(params.arguments) ? params.arguments : {};
    try {
      const result = await tool.call(args);
      return {
        content: [{ type: "text", text: result.text }],
        ...result.isError ? { isError: true } : {}
      };
    } catch (error) {
      this.options.log?.(`tool ${name} threw: ${describe(error)}`);
      return {
        content: [{ type: "text", text: `${name} failed: ${describe(error)}` }],
        isError: true
      };
    }
  }
}
var NOT_FOUND = Symbol("method-not-found");

class InvalidParams extends Error {
}
function isRpcId(value) {
  return typeof value === "string" || typeof value === "number" || value === null;
}
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
function serveStdio(server, options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const send = (response) => {
    output.write(`${JSON.stringify(response)}
`);
  };
  const pending = new Set;
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0)
      return;
    const work = (async () => {
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        send(errorResponse(null, PARSE_ERROR, "Parse error"));
        return;
      }
      const response = await server.handle(message);
      if (response !== undefined)
        send(response);
    })().finally(() => pending.delete(work));
    pending.add(work);
  });
  return new Promise((resolve) => {
    lines.on("close", () => {
      Promise.allSettled([...pending]).then(() => resolve());
    });
  });
}

// ../plugin/src/plugin/embedding-bootstrap.ts
import { readFileSync, statSync } from "node:fs";

// ../plugin/src/plugin/embedding-bootstrap-helpers.ts
import { createHash } from "node:crypto";
var EMBEDDING_AFFECTING_KEYS = new Set([
  "embedding.api_key",
  "embedding.endpoint",
  "embedding.model",
  "embedding.provider",
  "embedding.input_type",
  "embedding.truncate",
  "embedding.max_input_tokens",
  "embedding.query_input_type",
  "embedding.query_instruction",
  "embedding.document_prefix",
  "embedding.fallback_provider",
  "subc",
  "subc.connection_file",
  "shadow_embedding"
]);
var LITERAL_CONFIG_TOKEN_RE = /\{(?:env|file):[^}]+\}/;
function embeddingConfigHasLiteralTokens(embedding) {
  if (!embedding)
    return false;
  for (const value of Object.values(embedding)) {
    if (typeof value === "string" && LITERAL_CONFIG_TOKEN_RE.test(value)) {
      return true;
    }
  }
  return false;
}
var EMBEDDING_AFFECTING_TOP_LEVEL_KEYS = new Set([
  "embedding",
  "memory",
  "experimental",
  "subc",
  "shadow_embedding"
]);
var EMBEDDING_WARNING_TERMS = [
  "api_key",
  "endpoint",
  "model",
  "provider",
  "embedding",
  "input_type",
  "truncate",
  "subc",
  "shadow_embedding"
];
var loggedFailureSignatures = new Map;
function sha256Prefix(value, length = 16) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
function warningLooksEmbeddingRelated(message) {
  const lower = message.toLowerCase();
  return EMBEDDING_WARNING_TERMS.some((term) => lower.includes(term));
}
function isConfigLoadUntrusted(detailed) {
  if (detailed.sources.userConfig === "project-file-parse-error" || detailed.sources.userConfig === "project-file-io-error" || detailed.sources.userConfig === "legacy-config-unmigrated" || detailed.sources.projectConfig === "project-file-parse-error" || detailed.sources.projectConfig === "project-file-io-error" || detailed.sources.projectConfig === "legacy-config-unmigrated") {
    return true;
  }
  for (const failure of detailed.substitutionFailures) {
    if (EMBEDDING_AFFECTING_KEYS.has(failure.keyPath)) {
      return true;
    }
    if (failure.keyPath === "<unknown>" && warningLooksEmbeddingRelated(failure.message)) {
      return true;
    }
  }
  for (const recoveredKey of detailed.recoveredTopLevelKeys) {
    if (EMBEDDING_AFFECTING_TOP_LEVEL_KEYS.has(recoveredKey)) {
      return true;
    }
  }
  if (embeddingConfigHasLiteralTokens(detailed.config.embedding)) {
    return true;
  }
  return false;
}
function describeFailure(detailed) {
  const parts = [];
  for (const [source, outcome] of Object.entries(detailed.sources)) {
    if (outcome !== "ok") {
      parts.push(`${source}=${outcome}`);
    }
  }
  if (detailed.substitutionFailures.length > 0) {
    parts.push(`substitution=${detailed.substitutionFailures.map((failure) => `${failure.source}:${failure.keyPath}`).join(",")}`);
  }
  if (detailed.recoveredTopLevelKeys.length > 0) {
    parts.push(`recovered=${detailed.recoveredTopLevelKeys.join(",")}`);
  }
  return parts.length > 0 ? parts.join("; ") : detailed.loadOutcome;
}
function logConfigFailureOnce(projectIdentity, detailed) {
  const signature = sha256Prefix(JSON.stringify({
    outcomes: detailed.sources,
    substitutions: detailed.substitutionFailures.map((failure) => `${failure.source}:${failure.keyPath}:${failure.message}`).sort(),
    recoveredTopLevelKeys: [...detailed.recoveredTopLevelKeys].sort()
  }));
  const existing = loggedFailureSignatures.get(projectIdentity) ?? new Set;
  if (existing.has(signature))
    return;
  existing.add(signature);
  loggedFailureSignatures.set(projectIdentity, existing);
  log(`[mc][embedding] config load untrusted, preserving last-known-good for ${projectIdentity} — ${describeFailure(detailed)}`);
}
function handleUntrustedLoad(db, projectIdentity, directory, detailed) {
  markProjectLoadUntrusted(projectIdentity);
  const prior = getProjectEmbeddingSnapshot(projectIdentity);
  if (prior && !prior.runtimeFingerprint.startsWith("observation:")) {
    logConfigFailureOnce(projectIdentity, detailed);
    return true;
  }
  registerProjectInObservationMode(db, projectIdentity, directory, detailed.config.embedding, describeFailure(detailed));
  return true;
}

// ../plugin/src/plugin/embedding-routing.ts
var SYNAPSE_PROBE_TTL_MS = 60000;
var synapseProbeCache = new Map;
function fallbackConfig(config, provider) {
  const raw = config;
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint.trim() : "";
  const apiKey = typeof raw.api_key === "string" ? raw.api_key.trim() : "";
  const inputType = typeof raw.input_type === "string" ? raw.input_type.trim() : "";
  const queryInputType = typeof raw.query_input_type === "string" ? raw.query_input_type.trim() : "";
  const queryInstruction = typeof raw.query_instruction === "string" || raw.query_instruction === false ? raw.query_instruction : undefined;
  const documentPrefix = typeof raw.document_prefix === "string" ? raw.document_prefix : undefined;
  const truncate = typeof raw.truncate === "string" ? raw.truncate.trim() : "";
  const maxInputTokens = typeof raw.max_input_tokens === "number" ? raw.max_input_tokens : undefined;
  if (provider === "off")
    return { provider: "off" };
  if (provider === "openai-compatible") {
    return {
      provider: "openai-compatible",
      model,
      endpoint,
      ...apiKey ? { api_key: apiKey } : {},
      ...inputType ? { input_type: inputType } : {},
      ...queryInputType ? { query_input_type: queryInputType } : {},
      ...queryInstruction !== undefined ? { query_instruction: queryInstruction } : {},
      ...documentPrefix !== undefined ? { document_prefix: documentPrefix } : {},
      ...truncate ? { truncate } : {},
      ...maxInputTokens !== undefined ? { max_input_tokens: maxInputTokens } : {}
    };
  }
  return {
    provider: "local",
    model: model || DEFAULT_LOCAL_EMBEDDING_MODEL,
    local_runtime: raw.local_runtime === "native" || raw.local_runtime === "wasm" ? raw.local_runtime : "auto",
    ...maxInputTokens !== undefined ? { max_input_tokens: maxInputTokens } : {}
  };
}
function synapseOptions(config, subc, projectRoot, session, metadata) {
  return {
    connectionFile: subc.connection_file,
    projectRoot,
    session,
    model: metadata?.model ?? (config.provider === "synapse" && "model" in config ? config.model : undefined) ?? SYNAPSE_DEFAULT_MODEL,
    ...metadata ? {
      metadata
    } : {}
  };
}
function probeKey(subc, config) {
  const model = config.provider === "synapse" && "model" in config ? config.model : SYNAPSE_DEFAULT_MODEL;
  return `${subc.connection_file}\x00${model ?? SYNAPSE_DEFAULT_MODEL}`;
}
function discoverSynapseLane(config, subc, projectRoot, session) {
  const key = probeKey(subc, config);
  const cached = synapseProbeCache.get(key);
  if (cached && cached.expiresAt > Date.now())
    return cached.promise;
  const promise = SynapseEmbeddingProvider.discover(synapseOptions(config, subc, projectRoot, session));
  synapseProbeCache.set(key, { expiresAt: Date.now() + SYNAPSE_PROBE_TTL_MS, promise });
  promise.catch(() => {
    return;
  });
  return promise;
}
function resolvedSynapseConfig(subc, metadata, projectRoot, session) {
  return {
    provider: "synapse",
    model: metadata.model,
    max_input_tokens: metadata.max_tokens,
    synapse_connection_file: subc.connection_file,
    synapse_fingerprint: metadata.fingerprint,
    synapse_table_epoch: metadata.table_epoch,
    ...typeof metadata.dims === "number" ? { synapse_dims: metadata.dims } : {},
    ...metadata.recommended_batch ? { synapse_recommended_batch: metadata.recommended_batch } : {},
    ...metadata.recommended_token_budget ? { synapse_recommended_token_budget: metadata.recommended_token_budget } : {},
    synapse_descriptor: toSynapseLaneDescriptor(metadata),
    ...metadata.provenance !== undefined ? { synapse_provenance: metadata.provenance } : {}
  };
}
async function resolveEmbeddingRouting(args) {
  const config = args.config.embedding;
  const subc = args.config.subc;
  const shadowEnabled = args.config.shadow_embedding?.enabled === true;
  const warnings = [];
  if (config.provider !== "synapse") {
    let shadow = null;
    if (shadowEnabled && config.provider === "off") {
      warnings.push("shadow_embedding is ignored when embedding.provider is off");
    } else if (shadowEnabled && !subc) {
      warnings.push("shadow_embedding requires a subc block; shadow lane is disabled");
    } else if (shadowEnabled && subc) {
      try {
        const metadata = await discoverSynapseLane(config, subc, args.projectRoot, args.session ?? "routing");
        shadow = resolvedSynapseConfig(subc, metadata, args.projectRoot, args.session ?? "routing");
      } catch (error) {
        warnings.push(`shadow_embedding is unavailable; using the primary ${config.provider} lane: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { primary: config, shadow, warnings };
  }
  if (shadowEnabled) {
    warnings.push("shadow_embedding is ignored when the primary provider is synapse");
  }
  const fallbackProvider = config.fallback_provider;
  const fallback = fallbackConfig(config, fallbackProvider);
  if (!subc) {
    warnings.push("embedding.provider synapse requires a subc block; using fallback provider");
    return { primary: fallback, shadow: null, warnings };
  }
  if (!fallbackProvider) {
    warnings.push("embedding.provider synapse requires embedding.fallback_provider; using local fallback");
    return { primary: fallbackConfig(config, "local"), shadow: null, warnings };
  }
  try {
    const metadata = await discoverSynapseLane(config, subc, args.projectRoot, args.session ?? "routing");
    return {
      primary: resolvedSynapseConfig(subc, metadata, args.projectRoot, args.session ?? "routing"),
      shadow: null,
      warnings
    };
  } catch (error) {
    warnings.push(`Synapse is not ready; using embedding.fallback_provider=${fallbackProvider}: ${error instanceof Error ? error.message : String(error)}`);
    log(`[magic-context] Synapse routing fell back: ${warnings.at(-1)}`);
    return { primary: fallback, shadow: null, warnings };
  }
}

// ../plugin/src/plugin/embedding-bootstrap.ts
var configCache = new Map;
function loadRegistrationConfig(directory) {
  const legacy = resolveLegacyConfigSources(directory);
  const paths = [cortexKitUserConfigBasePath(), cortexKitProjectConfigBasePath(directory)].flatMap((base) => [`${base}.jsonc`, `${base}.json`]).concat(legacy.user.map((source) => source.path), legacy.project.map((source) => source.path));
  const key = paths.map((path) => {
    const stat = statSync(path, { throwIfNoEntry: false });
    return `${path}:${stat?.mtimeMs ?? "missing"}:${stat?.size ?? 0}`;
  }).join("|");
  const cached = configCache.get(directory);
  if (cached?.key === key)
    return cached.detailed;
  const detailed = loadPluginConfigDetailed(directory);
  const dynamic = paths.some((path) => {
    try {
      return /\{(?:env|file):/.test(readFileSync(path, "utf8"));
    } catch {
      return false;
    }
  });
  if (!dynamic) {
    if (configCache.size >= 64) {
      const oldest = configCache.keys().next().value;
      if (oldest !== undefined)
        configCache.delete(oldest);
    }
    configCache.set(directory, { key, detailed });
  } else
    configCache.delete(directory);
  return detailed;
}
async function ensureProjectRegisteredFromOpenCodeDirectory(directory, db) {
  const detailed = loadRegistrationConfig(directory);
  const projectIdentity = resolveProjectIdentityForSession(directory, detailed.config.allow_home_project);
  if (!projectIdentity)
    return;
  if (isConfigLoadUntrusted(detailed)) {
    handleUntrustedLoad(db, projectIdentity, directory, detailed);
    return;
  }
  const routing = await resolveEmbeddingRouting({
    config: detailed.config,
    projectRoot: directory,
    session: `bootstrap:${projectIdentity}`
  });
  for (const warning of routing.warnings) {
    log(`[magic-context] ${warning}`);
  }
  const features = {
    memoryEnabled: detailed.config.memory.enabled,
    gitCommitEnabled: detailed.config.memory.git_commit_indexing.enabled
  };
  const before = getProjectEmbeddingSnapshot(projectIdentity);
  const registered = registerProjectEmbedding(db, projectIdentity, routing.primary, features, directory);
  if (!before || before.providerIdentity !== registered.providerIdentity || before.runtimeFingerprint !== registered.runtimeFingerprint)
    invalidateProject(projectIdentity);
  if (routing.shadow) {
    registerProjectShadowEmbedding(db, projectIdentity, routing.shadow, directory);
  } else {
    unregisterProjectShadowEmbedding(projectIdentity);
  }
}

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/classic/external.js
var exports_external = {};
__export(exports_external, {
  $brand: () => $brand,
  $input: () => $input,
  $output: () => $output,
  NEVER: () => NEVER,
  TimePrecision: () => TimePrecision,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBase64: () => ZodBase64,
  ZodBase64URL: () => ZodBase64URL,
  ZodBigInt: () => ZodBigInt,
  ZodBigIntFormat: () => ZodBigIntFormat,
  ZodBoolean: () => ZodBoolean,
  ZodCIDRv4: () => ZodCIDRv4,
  ZodCIDRv6: () => ZodCIDRv6,
  ZodCUID: () => ZodCUID,
  ZodCUID2: () => ZodCUID2,
  ZodCatch: () => ZodCatch,
  ZodCodec: () => ZodCodec,
  ZodCustom: () => ZodCustom,
  ZodCustomStringFormat: () => ZodCustomStringFormat,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodE164: () => ZodE164,
  ZodEmail: () => ZodEmail,
  ZodEmoji: () => ZodEmoji,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFile: () => ZodFile,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodGUID: () => ZodGUID,
  ZodIPv4: () => ZodIPv4,
  ZodIPv6: () => ZodIPv6,
  ZodISODate: () => ZodISODate,
  ZodISODateTime: () => ZodISODateTime,
  ZodISODuration: () => ZodISODuration,
  ZodISOTime: () => ZodISOTime,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodJWT: () => ZodJWT,
  ZodKSUID: () => ZodKSUID,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNanoID: () => ZodNanoID,
  ZodNever: () => ZodNever,
  ZodNonOptional: () => ZodNonOptional,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodNumberFormat: () => ZodNumberFormat,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodPipe: () => ZodPipe,
  ZodPrefault: () => ZodPrefault,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRealError: () => ZodRealError,
  ZodRecord: () => ZodRecord,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodStringFormat: () => ZodStringFormat,
  ZodSuccess: () => ZodSuccess,
  ZodSymbol: () => ZodSymbol,
  ZodTemplateLiteral: () => ZodTemplateLiteral,
  ZodTransform: () => ZodTransform,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodULID: () => ZodULID,
  ZodURL: () => ZodURL,
  ZodUUID: () => ZodUUID,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  ZodXID: () => ZodXID,
  _ZodString: () => _ZodString,
  _default: () => _default2,
  _function: () => _function,
  any: () => any,
  array: () => array,
  base64: () => base642,
  base64url: () => base64url2,
  bigint: () => bigint2,
  boolean: () => boolean2,
  catch: () => _catch2,
  check: () => check,
  cidrv4: () => cidrv42,
  cidrv6: () => cidrv62,
  clone: () => clone,
  codec: () => codec,
  coerce: () => exports_coerce,
  config: () => config,
  core: () => exports_core2,
  cuid: () => cuid3,
  cuid2: () => cuid22,
  custom: () => custom,
  date: () => date3,
  decode: () => decode2,
  decodeAsync: () => decodeAsync2,
  discriminatedUnion: () => discriminatedUnion,
  e164: () => e1642,
  email: () => email2,
  emoji: () => emoji2,
  encode: () => encode2,
  encodeAsync: () => encodeAsync2,
  endsWith: () => _endsWith,
  enum: () => _enum2,
  file: () => file,
  flattenError: () => flattenError,
  float32: () => float32,
  float64: () => float64,
  formatError: () => formatError,
  function: () => _function,
  getErrorMap: () => getErrorMap,
  globalRegistry: () => globalRegistry,
  gt: () => _gt,
  gte: () => _gte,
  guid: () => guid2,
  hash: () => hash,
  hex: () => hex2,
  hostname: () => hostname2,
  httpUrl: () => httpUrl,
  includes: () => _includes,
  instanceof: () => _instanceof,
  int: () => int,
  int32: () => int32,
  int64: () => int64,
  intersection: () => intersection,
  ipv4: () => ipv42,
  ipv6: () => ipv62,
  iso: () => exports_iso,
  json: () => json,
  jwt: () => jwt,
  keyof: () => keyof,
  ksuid: () => ksuid2,
  lazy: () => lazy,
  length: () => _length,
  literal: () => literal,
  locales: () => exports_locales,
  looseObject: () => looseObject,
  lowercase: () => _lowercase,
  lt: () => _lt,
  lte: () => _lte,
  map: () => map,
  maxLength: () => _maxLength,
  maxSize: () => _maxSize,
  mime: () => _mime,
  minLength: () => _minLength,
  minSize: () => _minSize,
  multipleOf: () => _multipleOf,
  nan: () => nan,
  nanoid: () => nanoid2,
  nativeEnum: () => nativeEnum,
  negative: () => _negative,
  never: () => never,
  nonnegative: () => _nonnegative,
  nonoptional: () => nonoptional,
  nonpositive: () => _nonpositive,
  normalize: () => _normalize,
  null: () => _null3,
  nullable: () => nullable,
  nullish: () => nullish2,
  number: () => number2,
  object: () => object,
  optional: () => optional,
  overwrite: () => _overwrite,
  parse: () => parse3,
  parseAsync: () => parseAsync2,
  partialRecord: () => partialRecord,
  pipe: () => pipe,
  positive: () => _positive,
  prefault: () => prefault,
  preprocess: () => preprocess,
  prettifyError: () => prettifyError,
  promise: () => promise,
  property: () => _property,
  readonly: () => readonly,
  record: () => record,
  refine: () => refine,
  regex: () => _regex,
  regexes: () => exports_regexes,
  registry: () => registry,
  safeDecode: () => safeDecode2,
  safeDecodeAsync: () => safeDecodeAsync2,
  safeEncode: () => safeEncode2,
  safeEncodeAsync: () => safeEncodeAsync2,
  safeParse: () => safeParse2,
  safeParseAsync: () => safeParseAsync2,
  set: () => set,
  setErrorMap: () => setErrorMap,
  size: () => _size,
  startsWith: () => _startsWith,
  strictObject: () => strictObject,
  string: () => string2,
  stringFormat: () => stringFormat,
  stringbool: () => stringbool,
  success: () => success,
  superRefine: () => superRefine,
  symbol: () => symbol,
  templateLiteral: () => templateLiteral,
  toJSONSchema: () => toJSONSchema,
  toLowerCase: () => _toLowerCase,
  toUpperCase: () => _toUpperCase,
  transform: () => transform,
  treeifyError: () => treeifyError,
  trim: () => _trim,
  tuple: () => tuple,
  uint32: () => uint32,
  uint64: () => uint64,
  ulid: () => ulid2,
  undefined: () => _undefined3,
  union: () => union,
  unknown: () => unknown,
  uppercase: () => _uppercase,
  url: () => url,
  util: () => exports_util,
  uuid: () => uuid2,
  uuidv4: () => uuidv4,
  uuidv6: () => uuidv6,
  uuidv7: () => uuidv7,
  void: () => _void2,
  xid: () => xid2
});

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/core/index.js
var exports_core2 = {};
__export(exports_core2, {
  $ZodAny: () => $ZodAny,
  $ZodArray: () => $ZodArray,
  $ZodAsyncError: () => $ZodAsyncError,
  $ZodBase64: () => $ZodBase64,
  $ZodBase64URL: () => $ZodBase64URL,
  $ZodBigInt: () => $ZodBigInt,
  $ZodBigIntFormat: () => $ZodBigIntFormat,
  $ZodBoolean: () => $ZodBoolean,
  $ZodCIDRv4: () => $ZodCIDRv4,
  $ZodCIDRv6: () => $ZodCIDRv6,
  $ZodCUID: () => $ZodCUID,
  $ZodCUID2: () => $ZodCUID2,
  $ZodCatch: () => $ZodCatch,
  $ZodCheck: () => $ZodCheck,
  $ZodCheckBigIntFormat: () => $ZodCheckBigIntFormat,
  $ZodCheckEndsWith: () => $ZodCheckEndsWith,
  $ZodCheckGreaterThan: () => $ZodCheckGreaterThan,
  $ZodCheckIncludes: () => $ZodCheckIncludes,
  $ZodCheckLengthEquals: () => $ZodCheckLengthEquals,
  $ZodCheckLessThan: () => $ZodCheckLessThan,
  $ZodCheckLowerCase: () => $ZodCheckLowerCase,
  $ZodCheckMaxLength: () => $ZodCheckMaxLength,
  $ZodCheckMaxSize: () => $ZodCheckMaxSize,
  $ZodCheckMimeType: () => $ZodCheckMimeType,
  $ZodCheckMinLength: () => $ZodCheckMinLength,
  $ZodCheckMinSize: () => $ZodCheckMinSize,
  $ZodCheckMultipleOf: () => $ZodCheckMultipleOf,
  $ZodCheckNumberFormat: () => $ZodCheckNumberFormat,
  $ZodCheckOverwrite: () => $ZodCheckOverwrite,
  $ZodCheckProperty: () => $ZodCheckProperty,
  $ZodCheckRegex: () => $ZodCheckRegex,
  $ZodCheckSizeEquals: () => $ZodCheckSizeEquals,
  $ZodCheckStartsWith: () => $ZodCheckStartsWith,
  $ZodCheckStringFormat: () => $ZodCheckStringFormat,
  $ZodCheckUpperCase: () => $ZodCheckUpperCase,
  $ZodCodec: () => $ZodCodec,
  $ZodCustom: () => $ZodCustom,
  $ZodCustomStringFormat: () => $ZodCustomStringFormat,
  $ZodDate: () => $ZodDate,
  $ZodDefault: () => $ZodDefault,
  $ZodDiscriminatedUnion: () => $ZodDiscriminatedUnion,
  $ZodE164: () => $ZodE164,
  $ZodEmail: () => $ZodEmail,
  $ZodEmoji: () => $ZodEmoji,
  $ZodEncodeError: () => $ZodEncodeError,
  $ZodEnum: () => $ZodEnum,
  $ZodError: () => $ZodError,
  $ZodFile: () => $ZodFile,
  $ZodFunction: () => $ZodFunction,
  $ZodGUID: () => $ZodGUID,
  $ZodIPv4: () => $ZodIPv4,
  $ZodIPv6: () => $ZodIPv6,
  $ZodISODate: () => $ZodISODate,
  $ZodISODateTime: () => $ZodISODateTime,
  $ZodISODuration: () => $ZodISODuration,
  $ZodISOTime: () => $ZodISOTime,
  $ZodIntersection: () => $ZodIntersection,
  $ZodJWT: () => $ZodJWT,
  $ZodKSUID: () => $ZodKSUID,
  $ZodLazy: () => $ZodLazy,
  $ZodLiteral: () => $ZodLiteral,
  $ZodMap: () => $ZodMap,
  $ZodNaN: () => $ZodNaN,
  $ZodNanoID: () => $ZodNanoID,
  $ZodNever: () => $ZodNever,
  $ZodNonOptional: () => $ZodNonOptional,
  $ZodNull: () => $ZodNull,
  $ZodNullable: () => $ZodNullable,
  $ZodNumber: () => $ZodNumber,
  $ZodNumberFormat: () => $ZodNumberFormat,
  $ZodObject: () => $ZodObject,
  $ZodObjectJIT: () => $ZodObjectJIT,
  $ZodOptional: () => $ZodOptional,
  $ZodPipe: () => $ZodPipe,
  $ZodPrefault: () => $ZodPrefault,
  $ZodPromise: () => $ZodPromise,
  $ZodReadonly: () => $ZodReadonly,
  $ZodRealError: () => $ZodRealError,
  $ZodRecord: () => $ZodRecord,
  $ZodRegistry: () => $ZodRegistry,
  $ZodSet: () => $ZodSet,
  $ZodString: () => $ZodString,
  $ZodStringFormat: () => $ZodStringFormat,
  $ZodSuccess: () => $ZodSuccess,
  $ZodSymbol: () => $ZodSymbol,
  $ZodTemplateLiteral: () => $ZodTemplateLiteral,
  $ZodTransform: () => $ZodTransform,
  $ZodTuple: () => $ZodTuple,
  $ZodType: () => $ZodType,
  $ZodULID: () => $ZodULID,
  $ZodURL: () => $ZodURL,
  $ZodUUID: () => $ZodUUID,
  $ZodUndefined: () => $ZodUndefined,
  $ZodUnion: () => $ZodUnion,
  $ZodUnknown: () => $ZodUnknown,
  $ZodVoid: () => $ZodVoid,
  $ZodXID: () => $ZodXID,
  $brand: () => $brand,
  $constructor: () => $constructor,
  $input: () => $input,
  $output: () => $output,
  Doc: () => Doc,
  JSONSchema: () => exports_json_schema,
  JSONSchemaGenerator: () => JSONSchemaGenerator,
  NEVER: () => NEVER,
  TimePrecision: () => TimePrecision,
  _any: () => _any,
  _array: () => _array,
  _base64: () => _base64,
  _base64url: () => _base64url,
  _bigint: () => _bigint,
  _boolean: () => _boolean,
  _catch: () => _catch,
  _check: () => _check,
  _cidrv4: () => _cidrv4,
  _cidrv6: () => _cidrv6,
  _coercedBigint: () => _coercedBigint,
  _coercedBoolean: () => _coercedBoolean,
  _coercedDate: () => _coercedDate,
  _coercedNumber: () => _coercedNumber,
  _coercedString: () => _coercedString,
  _cuid: () => _cuid,
  _cuid2: () => _cuid2,
  _custom: () => _custom,
  _date: () => _date,
  _decode: () => _decode,
  _decodeAsync: () => _decodeAsync,
  _default: () => _default,
  _discriminatedUnion: () => _discriminatedUnion,
  _e164: () => _e164,
  _email: () => _email,
  _emoji: () => _emoji2,
  _encode: () => _encode,
  _encodeAsync: () => _encodeAsync,
  _endsWith: () => _endsWith,
  _enum: () => _enum,
  _file: () => _file,
  _float32: () => _float32,
  _float64: () => _float64,
  _gt: () => _gt,
  _gte: () => _gte,
  _guid: () => _guid,
  _includes: () => _includes,
  _int: () => _int,
  _int32: () => _int32,
  _int64: () => _int64,
  _intersection: () => _intersection,
  _ipv4: () => _ipv4,
  _ipv6: () => _ipv6,
  _isoDate: () => _isoDate,
  _isoDateTime: () => _isoDateTime,
  _isoDuration: () => _isoDuration,
  _isoTime: () => _isoTime,
  _jwt: () => _jwt,
  _ksuid: () => _ksuid,
  _lazy: () => _lazy,
  _length: () => _length,
  _literal: () => _literal,
  _lowercase: () => _lowercase,
  _lt: () => _lt,
  _lte: () => _lte,
  _map: () => _map,
  _max: () => _lte,
  _maxLength: () => _maxLength,
  _maxSize: () => _maxSize,
  _mime: () => _mime,
  _min: () => _gte,
  _minLength: () => _minLength,
  _minSize: () => _minSize,
  _multipleOf: () => _multipleOf,
  _nan: () => _nan,
  _nanoid: () => _nanoid,
  _nativeEnum: () => _nativeEnum,
  _negative: () => _negative,
  _never: () => _never,
  _nonnegative: () => _nonnegative,
  _nonoptional: () => _nonoptional,
  _nonpositive: () => _nonpositive,
  _normalize: () => _normalize,
  _null: () => _null2,
  _nullable: () => _nullable,
  _number: () => _number,
  _optional: () => _optional,
  _overwrite: () => _overwrite,
  _parse: () => _parse,
  _parseAsync: () => _parseAsync,
  _pipe: () => _pipe,
  _positive: () => _positive,
  _promise: () => _promise,
  _property: () => _property,
  _readonly: () => _readonly,
  _record: () => _record,
  _refine: () => _refine,
  _regex: () => _regex,
  _safeDecode: () => _safeDecode,
  _safeDecodeAsync: () => _safeDecodeAsync,
  _safeEncode: () => _safeEncode,
  _safeEncodeAsync: () => _safeEncodeAsync,
  _safeParse: () => _safeParse,
  _safeParseAsync: () => _safeParseAsync,
  _set: () => _set,
  _size: () => _size,
  _startsWith: () => _startsWith,
  _string: () => _string,
  _stringFormat: () => _stringFormat,
  _stringbool: () => _stringbool,
  _success: () => _success,
  _superRefine: () => _superRefine,
  _symbol: () => _symbol,
  _templateLiteral: () => _templateLiteral,
  _toLowerCase: () => _toLowerCase,
  _toUpperCase: () => _toUpperCase,
  _transform: () => _transform,
  _trim: () => _trim,
  _tuple: () => _tuple,
  _uint32: () => _uint32,
  _uint64: () => _uint64,
  _ulid: () => _ulid,
  _undefined: () => _undefined2,
  _union: () => _union,
  _unknown: () => _unknown,
  _uppercase: () => _uppercase,
  _url: () => _url,
  _uuid: () => _uuid,
  _uuidv4: () => _uuidv4,
  _uuidv6: () => _uuidv6,
  _uuidv7: () => _uuidv7,
  _void: () => _void,
  _xid: () => _xid,
  clone: () => clone,
  config: () => config,
  decode: () => decode,
  decodeAsync: () => decodeAsync,
  encode: () => encode,
  encodeAsync: () => encodeAsync,
  flattenError: () => flattenError,
  formatError: () => formatError,
  globalConfig: () => globalConfig,
  globalRegistry: () => globalRegistry,
  isValidBase64: () => isValidBase64,
  isValidBase64URL: () => isValidBase64URL,
  isValidJWT: () => isValidJWT,
  locales: () => exports_locales,
  parse: () => parse,
  parseAsync: () => parseAsync,
  prettifyError: () => prettifyError,
  regexes: () => exports_regexes,
  registry: () => registry,
  safeDecode: () => safeDecode,
  safeDecodeAsync: () => safeDecodeAsync,
  safeEncode: () => safeEncode,
  safeEncodeAsync: () => safeEncodeAsync,
  safeParse: () => safeParse,
  safeParseAsync: () => safeParseAsync,
  toDotPath: () => toDotPath,
  toJSONSchema: () => toJSONSchema,
  treeifyError: () => treeifyError,
  util: () => exports_util,
  version: () => version
});

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/core/core.js
var NEVER = Object.freeze({
  status: "aborted"
});
function $constructor(name, initializer, params) {
  function init(inst, def) {
    var _a;
    Object.defineProperty(inst, "_zod", {
      value: inst._zod ?? {},
      enumerable: false
    });
    (_a = inst._zod).traits ?? (_a.traits = new Set);
    inst._zod.traits.add(name);
    initializer(inst, def);
    for (const k in _.prototype) {
      if (!(k in inst))
        Object.defineProperty(inst, k, { value: _.prototype[k].bind(inst) });
    }
    inst._zod.constr = _;
    inst._zod.def = def;
  }
  const Parent = params?.Parent ?? Object;

  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    var _a;
    const inst = params?.Parent ? new Definition : this;
    init(inst, def);
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    for (const fn of inst._zod.deferred) {
      fn();
    }
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
var $brand = Symbol("zod_brand");

class $ZodAsyncError extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
}

class $ZodEncodeError extends Error {
  constructor(name) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
  }
}
var globalConfig = {};
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/core/util.js
var exports_util = {};
__export(exports_util, {
  BIGINT_FORMAT_RANGES: () => BIGINT_FORMAT_RANGES,
  Class: () => Class,
  NUMBER_FORMAT_RANGES: () => NUMBER_FORMAT_RANGES,
  aborted: () => aborted,
  allowsEval: () => allowsEval,
  assert: () => assert,
  assertEqual: () => assertEqual,
  assertIs: () => assertIs,
  assertNever: () => assertNever,
  assertNotEqual: () => assertNotEqual,
  assignProp: () => assignProp,
  base64ToUint8Array: () => base64ToUint8Array,
  base64urlToUint8Array: () => base64urlToUint8Array,
  cached: () => cached,
  captureStackTrace: () => captureStackTrace,
  cleanEnum: () => cleanEnum,
  cleanRegex: () => cleanRegex,
  clone: () => clone,
  cloneDef: () => cloneDef,
  createTransparentProxy: () => createTransparentProxy,
  defineLazy: () => defineLazy,
  esc: () => esc,
  escapeRegex: () => escapeRegex,
  extend: () => extend,
  finalizeIssue: () => finalizeIssue,
  floatSafeRemainder: () => floatSafeRemainder,
  getElementAtPath: () => getElementAtPath,
  getEnumValues: () => getEnumValues,
  getLengthableOrigin: () => getLengthableOrigin,
  getParsedType: () => getParsedType,
  getSizableOrigin: () => getSizableOrigin,
  hexToUint8Array: () => hexToUint8Array,
  isObject: () => isObject2,
  isPlainObject: () => isPlainObject,
  issue: () => issue,
  joinValues: () => joinValues,
  jsonStringifyReplacer: () => jsonStringifyReplacer,
  merge: () => merge,
  mergeDefs: () => mergeDefs,
  normalizeParams: () => normalizeParams,
  nullish: () => nullish,
  numKeys: () => numKeys,
  objectClone: () => objectClone,
  omit: () => omit,
  optionalKeys: () => optionalKeys,
  partial: () => partial,
  pick: () => pick,
  prefixIssues: () => prefixIssues,
  primitiveTypes: () => primitiveTypes,
  promiseAllObject: () => promiseAllObject,
  propertyKeyTypes: () => propertyKeyTypes,
  randomString: () => randomString,
  required: () => required,
  safeExtend: () => safeExtend,
  shallowClone: () => shallowClone,
  stringifyPrimitive: () => stringifyPrimitive,
  uint8ArrayToBase64: () => uint8ArrayToBase64,
  uint8ArrayToBase64url: () => uint8ArrayToBase64url,
  uint8ArrayToHex: () => uint8ArrayToHex,
  unwrapMessage: () => unwrapMessage
});
function assertEqual(val) {
  return val;
}
function assertNotEqual(val) {
  return val;
}
function assertIs(_arg) {}
function assertNever(_x) {
  throw new Error;
}
function assert(_) {}
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function joinValues(array, separator = "|") {
  return array.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}
function cached(getter) {
  const set = false;
  return {
    get value() {
      if (!set) {
        const value = getter();
        Object.defineProperty(this, "value", { value });
        return value;
      }
      throw new Error("cached value already set");
    }
  };
}
function nullish(input) {
  return input === null || input === undefined;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepString = step.toString();
  let stepDecCount = (stepString.split(".")[1] || "").length;
  if (stepDecCount === 0 && /\d?e-\d?/.test(stepString)) {
    const match = stepString.match(/\d?e-(\d?)/);
    if (match?.[1]) {
      stepDecCount = Number.parseInt(match[1]);
    }
  }
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var EVALUATING = Symbol("evaluating");
function defineLazy(object, key, getter) {
  let value = undefined;
  Object.defineProperty(object, key, {
    get() {
      if (value === EVALUATING) {
        return;
      }
      if (value === undefined) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object, key, {
        value: v
      });
    },
    configurable: true
  });
}
function objectClone(obj) {
  return Object.create(Object.getPrototypeOf(obj), Object.getOwnPropertyDescriptors(obj));
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function cloneDef(schema) {
  return mergeDefs(schema._zod.def);
}
function getElementAtPath(obj, path) {
  if (!path)
    return obj;
  return path.reduce((acc, key) => acc?.[key], obj);
}
function promiseAllObject(promisesObj) {
  const keys = Object.keys(promisesObj);
  const promises = keys.map((key) => promisesObj[key]);
  return Promise.all(promises).then((results) => {
    const resolvedObj = {};
    for (let i = 0;i < keys.length; i++) {
      resolvedObj[keys[i]] = results[i];
    }
    return resolvedObj;
  });
}
function randomString(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let str = "";
  for (let i = 0;i < length; i++) {
    str += chars[Math.floor(Math.random() * chars.length)];
  }
  return str;
}
function esc(str) {
  return JSON.stringify(str);
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject2(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = cached(() => {
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject(o) {
  if (isObject2(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === undefined)
    return true;
  const prot = ctor.prototype;
  if (isObject2(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  return o;
}
function numKeys(data) {
  let keyCount = 0;
  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      keyCount++;
    }
  }
  return keyCount;
}
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(data) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "object":
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return "promise";
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return "map";
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return "set";
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return "date";
      }
      if (typeof File !== "undefined" && data instanceof File) {
        return "file";
      }
      return "object";
    default:
      throw new Error(`Unknown data type: ${t}`);
  }
};
var propertyKeyTypes = new Set(["string", "number", "symbol"]);
var primitiveTypes = new Set(["string", "number", "bigint", "boolean", "symbol", "undefined"]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== undefined) {
    if (params?.error !== undefined)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function createTransparentProxy(getter) {
  let target;
  return new Proxy({}, {
    get(_, prop, receiver) {
      target ?? (target = getter());
      return Reflect.get(target, prop, receiver);
    },
    set(_, prop, value, receiver) {
      target ?? (target = getter());
      return Reflect.set(target, prop, value, receiver);
    },
    has(_, prop) {
      target ?? (target = getter());
      return Reflect.has(target, prop);
    },
    deleteProperty(_, prop) {
      target ?? (target = getter());
      return Reflect.deleteProperty(target, prop);
    },
    ownKeys(_) {
      target ?? (target = getter());
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(_, prop) {
      target ?? (target = getter());
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    defineProperty(_, prop, descriptor) {
      target ?? (target = getter());
      return Reflect.defineProperty(target, prop, descriptor);
    }
  });
}
function stringifyPrimitive(value) {
  if (typeof value === "bigint")
    return value.toString() + "n";
  if (typeof value === "string")
    return `"${value}"`;
  return `${value}`;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = {
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-340282346638528860000000000000000000000, 340282346638528860000000000000000000000],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
var BIGINT_FORMAT_RANGES = {
  int64: [/* @__PURE__ */ BigInt("-9223372036854775808"), /* @__PURE__ */ BigInt("9223372036854775807")],
  uint64: [/* @__PURE__ */ BigInt(0), /* @__PURE__ */ BigInt("18446744073709551615")]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = {};
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        newShape[key] = currDef.shape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const newShape = { ...schema._zod.def.shape };
      for (const key in mask) {
        if (!(key in currDef.shape)) {
          throw new Error(`Unrecognized key: "${key}"`);
        }
        if (!mask[key])
          continue;
        delete newShape[key];
      }
      assignProp(this, "shape", newShape);
      return newShape;
    },
    checks: []
  });
  return clone(schema, def);
}
function extend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error("Object schemas containing refinements cannot be extended. Use `.safeExtend()` instead.");
  }
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function safeExtend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  const def = {
    ...schema._zod.def,
    get shape() {
      const _shape = { ...schema._zod.def.shape, ...shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    checks: schema._zod.def.checks
  };
  return clone(schema, def);
}
function merge(a, b) {
  const def = mergeDefs(a._zod.def, {
    get shape() {
      const _shape = { ...a._zod.def.shape, ...b._zod.def.shape };
      assignProp(this, "shape", _shape);
      return _shape;
    },
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: []
  });
  return clone(a, def);
}
function partial(Class2, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in oldShape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = Class2 ? new Class2({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      } else {
        for (const key in oldShape) {
          shape[key] = Class2 ? new Class2({
            type: "optional",
            innerType: oldShape[key]
          }) : oldShape[key];
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function required(Class2, schema, mask) {
  const def = mergeDefs(schema._zod.def, {
    get shape() {
      const oldShape = schema._zod.def.shape;
      const shape = { ...oldShape };
      if (mask) {
        for (const key in mask) {
          if (!(key in shape)) {
            throw new Error(`Unrecognized key: "${key}"`);
          }
          if (!mask[key])
            continue;
          shape[key] = new Class2({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      } else {
        for (const key in oldShape) {
          shape[key] = new Class2({
            type: "nonoptional",
            innerType: oldShape[key]
          });
        }
      }
      assignProp(this, "shape", shape);
      return shape;
    },
    checks: []
  });
  return clone(schema, def);
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a;
    (_a = iss).path ?? (_a.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config) {
  const full = { ...iss, path: iss.path ?? [] };
  if (!iss.message) {
    const message = unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
    full.message = message;
  }
  delete full.inst;
  delete full.continue;
  if (!ctx?.reportInput) {
    delete full.input;
  }
  return full;
}
function getSizableOrigin(input) {
  if (input instanceof Set)
    return "set";
  if (input instanceof Map)
    return "map";
  if (input instanceof File)
    return "file";
  return "unknown";
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}
function cleanEnum(obj) {
  return Object.entries(obj).filter(([k, _]) => {
    return Number.isNaN(Number.parseInt(k, 10));
  }).map((el) => el[1]);
}
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0;i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
function uint8ArrayToBase64(bytes) {
  let binaryString = "";
  for (let i = 0;i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  return btoa(binaryString);
}
function base64urlToUint8Array(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - base64.length % 4) % 4);
  return base64ToUint8Array(base64 + padding);
}
function uint8ArrayToBase64url(bytes) {
  return uint8ArrayToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function hexToUint8Array(hex) {
  const cleanHex = hex.replace(/^0x/, "");
  if (cleanHex.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0;i < cleanHex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(cleanHex.slice(i, i + 2), 16);
  }
  return bytes;
}
function uint8ArrayToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

class Class {
  constructor(..._args) {}
}

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/core/errors.js
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  Object.defineProperty(inst, "_zod", {
    value: inst._zod,
    enumerable: false
  });
  Object.defineProperty(inst, "issues", {
    value: def,
    enumerable: false
  });
  inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
  Object.defineProperty(inst, "toString", {
    value: () => inst.message,
    enumerable: false
  });
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, { Parent: Error });
function flattenError(error, mapper = (issue) => issue.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error.issues) {
    if (sub.path.length > 0) {
      fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
      fieldErrors[sub.path[0]].push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error, _mapper) {
  const mapper = _mapper || function(issue) {
    return issue.message;
  };
  const fieldErrors = { _errors: [] };
  const processError = (error) => {
    for (const issue of error.issues) {
      if (issue.code === "invalid_union" && issue.errors.length) {
        issue.errors.map((issues) => processError({ issues }));
      } else if (issue.code === "invalid_key") {
        processError({ issues: issue.issues });
      } else if (issue.code === "invalid_element") {
        processError({ issues: issue.issues });
      } else if (issue.path.length === 0) {
        fieldErrors._errors.push(mapper(issue));
      } else {
        let curr = fieldErrors;
        let i = 0;
        while (i < issue.path.length) {
          const el = issue.path[i];
          const terminal = i === issue.path.length - 1;
          if (!terminal) {
            curr[el] = curr[el] || { _errors: [] };
          } else {
            curr[el] = curr[el] || { _errors: [] };
            curr[el]._errors.push(mapper(issue));
          }
          curr = curr[el];
          i++;
        }
      }
    }
  };
  processError(error);
  return fieldErrors;
}
function treeifyError(error, _mapper) {
  const mapper = _mapper || function(issue) {
    return issue.message;
  };
  const result = { errors: [] };
  const processError = (error, path = []) => {
    var _a, _b;
    for (const issue of error.issues) {
      if (issue.code === "invalid_union" && issue.errors.length) {
        issue.errors.map((issues) => processError({ issues }, issue.path));
      } else if (issue.code === "invalid_key") {
        processError({ issues: issue.issues }, issue.path);
      } else if (issue.code === "invalid_element") {
        processError({ issues: issue.issues }, issue.path);
      } else {
        const fullpath = [...path, ...issue.path];
        if (fullpath.length === 0) {
          result.errors.push(mapper(issue));
          continue;
        }
        let curr = result;
        let i = 0;
        while (i < fullpath.length) {
          const el = fullpath[i];
          const terminal = i === fullpath.length - 1;
          if (typeof el === "string") {
            curr.properties ?? (curr.properties = {});
            (_a = curr.properties)[el] ?? (_a[el] = { errors: [] });
            curr = curr.properties[el];
          } else {
            curr.items ?? (curr.items = []);
            (_b = curr.items)[el] ?? (_b[el] = { errors: [] });
            curr = curr.items[el];
          }
          if (terminal) {
            curr.errors.push(mapper(issue));
          }
          i++;
        }
      }
    }
  };
  processError(error);
  return result;
}
function toDotPath(_path) {
  const segs = [];
  const path = _path.map((seg) => typeof seg === "object" ? seg.key : seg);
  for (const seg of path) {
    if (typeof seg === "number")
      segs.push(`[${seg}]`);
    else if (typeof seg === "symbol")
      segs.push(`[${JSON.stringify(String(seg))}]`);
    else if (/[^\w$]/.test(seg))
      segs.push(`[${JSON.stringify(seg)}]`);
    else {
      if (segs.length)
        segs.push(".");
      segs.push(seg);
    }
  }
  return segs.join("");
}
function prettifyError(error) {
  const lines = [];
  const issues = [...error.issues].sort((a, b) => (a.path ?? []).length - (b.path ?? []).length);
  for (const issue of issues) {
    lines.push(`✖ ${issue.message}`);
    if (issue.path?.length)
      lines.push(`  → at ${toDotPath(issue.path)}`);
  }
  return lines.join(`
`);
}

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/core/parse.js
var _parse = (_Err) => (schema, value, _ctx, _params) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: false }) : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  if (result.issues.length) {
    const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, _params?.callee);
    throw e;
  }
  return result.value;
};
var parse = /* @__PURE__ */ _parse($ZodRealError);
var _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  if (result.issues.length) {
    const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
    captureStackTrace(e, params?.callee);
    throw e;
  }
  return result.value;
};
var parseAsync = /* @__PURE__ */ _parseAsync($ZodRealError);
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length ? {
    success: false,
    error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParse = /* @__PURE__ */ _safeParse($ZodRealError);
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { async: true }) : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? {
    success: false,
    error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  } : { success: true, data: result.value };
};
var safeParseAsync = /* @__PURE__ */ _safeParseAsync($ZodRealError);
var _encode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _parse(_Err)(schema, value, ctx);
};
var encode = /* @__PURE__ */ _encode($ZodRealError);
var _decode = (_Err) => (schema, value, _ctx) => {
  return _parse(_Err)(schema, value, _ctx);
};
var decode = /* @__PURE__ */ _decode($ZodRealError);
var _encodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _parseAsync(_Err)(schema, value, ctx);
};
var encodeAsync = /* @__PURE__ */ _encodeAsync($ZodRealError);
var _decodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _parseAsync(_Err)(schema, value, _ctx);
};
var decodeAsync = /* @__PURE__ */ _decodeAsync($ZodRealError);
var _safeEncode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _safeParse(_Err)(schema, value, ctx);
};
var safeEncode = /* @__PURE__ */ _safeEncode($ZodRealError);
var _safeDecode = (_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
};
var safeDecode = /* @__PURE__ */ _safeDecode($ZodRealError);
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? Object.assign(_ctx, { direction: "backward" }) : { direction: "backward" };
  return _safeParseAsync(_Err)(schema, value, ctx);
};
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync($ZodRealError);
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
};
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync($ZodRealError);
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/core/regexes.js
var exports_regexes = {};
__export(exports_regexes, {
  base64: () => base64,
  base64url: () => base64url,
  bigint: () => bigint,
  boolean: () => boolean,
  browserEmail: () => browserEmail,
  cidrv4: () => cidrv4,
  cidrv6: () => cidrv6,
  cuid: () => cuid,
  cuid2: () => cuid2,
  date: () => date,
  datetime: () => datetime,
  domain: () => domain,
  duration: () => duration,
  e164: () => e164,
  email: () => email,
  emoji: () => emoji,
  extendedDuration: () => extendedDuration,
  guid: () => guid,
  hex: () => hex,
  hostname: () => hostname,
  html5Email: () => html5Email,
  idnEmail: () => idnEmail,
  integer: () => integer,
  ipv4: () => ipv4,
  ipv6: () => ipv6,
  ksuid: () => ksuid,
  lowercase: () => lowercase,
  md5_base64: () => md5_base64,
  md5_base64url: () => md5_base64url,
  md5_hex: () => md5_hex,
  nanoid: () => nanoid,
  null: () => _null,
  number: () => number,
  rfc5322Email: () => rfc5322Email,
  sha1_base64: () => sha1_base64,
  sha1_base64url: () => sha1_base64url,
  sha1_hex: () => sha1_hex,
  sha256_base64: () => sha256_base64,
  sha256_base64url: () => sha256_base64url,
  sha256_hex: () => sha256_hex,
  sha384_base64: () => sha384_base64,
  sha384_base64url: () => sha384_base64url,
  sha384_hex: () => sha384_hex,
  sha512_base64: () => sha512_base64,
  sha512_base64url: () => sha512_base64url,
  sha512_hex: () => sha512_hex,
  string: () => string,
  time: () => time,
  ulid: () => ulid,
  undefined: () => _undefined,
  unicodeEmail: () => unicodeEmail,
  uppercase: () => uppercase,
  uuid: () => uuid,
  uuid4: () => uuid4,
  uuid6: () => uuid6,
  uuid7: () => uuid7,
  xid: () => xid
});
var cuid = /^[cC][^\s-]{8,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var extendedDuration = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var uuid = (version) => {
  if (!version)
    return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var uuid4 = /* @__PURE__ */ uuid(4);
var uuid6 = /* @__PURE__ */ uuid(6);
var uuid7 = /* @__PURE__ */ uuid(7);
var email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var html5Email = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var rfc5322Email = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
var unicodeEmail = /^[^\s@"]{1,64}@[^\s@]{1,255}$/u;
var idnEmail = unicodeEmail;
var browserEmail = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
var _emoji = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
  return new RegExp(_emoji, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^[A-Za-z0-9_-]*$/;
var hostname = /^(?=.{1,253}\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[-0-9a-zA-Z]{0,61}[0-9a-zA-Z])?)*\.?$/;
var domain = /^([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
var e164 = /^\+(?:[0-9]){6,14}[0-9]$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
var date = /* @__PURE__ */ new RegExp(`^${dateSource}$`);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const time2 = timeSource({ precision: args.precision });
  const opts = ["Z"];
  if (args.local)
    opts.push("");
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const timeRegex = `${time2}(?:${opts.join("|")})`;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var string = (params) => {
  const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
  return new RegExp(`^${regex}$`);
};
var bigint = /^-?\d+n?$/;
var integer = /^-?\d+$/;
var number = /^-?\d+(?:\.\d+)?/;
var boolean = /^(?:true|false)$/i;
var _null = /^null$/i;
var _undefined = /^undefined$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;
var hex = /^[0-9a-fA-F]*$/;
function fixedBase64(bodyLength, padding) {
  return new RegExp(`^[A-Za-z0-9+/]{${bodyLength}}${padding}$`);
}
function fixedBase64url(length) {
  return new RegExp(`^[A-Za-z0-9_-]{${length}}$`);
}
var md5_hex = /^[0-9a-fA-F]{32}$/;
var md5_base64 = /* @__PURE__ */ fixedBase64(22, "==");
var md5_base64url = /* @__PURE__ */ fixedBase64url(22);
var sha1_hex = /^[0-9a-fA-F]{40}$/;
var sha1_base64 = /* @__PURE__ */ fixedBase64(27, "=");
var sha1_base64url = /* @__PURE__ */ fixedBase64url(27);
var sha256_hex = /^[0-9a-fA-F]{64}$/;
var sha256_base64 = /* @__PURE__ */ fixedBase64(43, "=");
var sha256_base64url = /* @__PURE__ */ fixedBase64url(43);
var sha384_hex = /^[0-9a-fA-F]{96}$/;
var sha384_base64 = /* @__PURE__ */ fixedBase64(64, "");
var sha384_base64url = /* @__PURE__ */ fixedBase64url(64);
var sha512_hex = /^[0-9a-fA-F]{128}$/;
var sha512_base64 = /* @__PURE__ */ fixedBase64(86, "==");
var sha512_base64url = /* @__PURE__ */ fixedBase64url(86);

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a = inst._zod).onattach ?? (_a.onattach = []);
});
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
    if (def.value < curr) {
      if (def.inclusive)
        bag.maximum = def.value;
      else
        bag.exclusiveMaximum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
    if (def.value > curr) {
      if (def.inclusive)
        bag.minimum = def.value;
      else
        bag.exclusiveMinimum = def.value;
    }
  });
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst) => {
    var _a;
    (_a = inst._zod.bag).multipleOf ?? (_a.multipleOf = def.value);
  });
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple)
      return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
    if (isInt)
      bag.pattern = integer;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inst
      });
    }
  };
});
var $ZodCheckBigIntFormat = /* @__PURE__ */ $constructor("$ZodCheckBigIntFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  const [minimum, maximum] = BIGINT_FORMAT_RANGES[def.format];
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.format = def.format;
    bag.minimum = minimum;
    bag.maximum = maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (input < minimum) {
      payload.issues.push({
        origin: "bigint",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "bigint",
        input,
        code: "too_big",
        maximum,
        inst
      });
    }
  };
});
var $ZodCheckMaxSize = /* @__PURE__ */ $constructor("$ZodCheckMaxSize", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== undefined;
  });
  inst._zod.onattach.push((inst) => {
    const curr = inst._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size <= def.maximum)
      return;
    payload.issues.push({
      origin: getSizableOrigin(input),
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinSize = /* @__PURE__ */ $constructor("$ZodCheckMinSize", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== undefined;
  });
  inst._zod.onattach.push((inst) => {
    const curr = inst._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size >= def.minimum)
      return;
    payload.issues.push({
      origin: getSizableOrigin(input),
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckSizeEquals = /* @__PURE__ */ $constructor("$ZodCheckSizeEquals", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.size !== undefined;
  });
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.minimum = def.size;
    bag.maximum = def.size;
    bag.size = def.size;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const size = input.size;
    if (size === def.size)
      return;
    const tooBig = size > def.size;
    payload.issues.push({
      origin: getSizableOrigin(input),
      ...tooBig ? { code: "too_big", maximum: def.size } : { code: "too_small", minimum: def.size },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst) => {
    const curr = inst._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
    if (def.maximum < curr)
      inst._zod.bag.maximum = def.maximum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst) => {
    const curr = inst._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
    if (def.minimum > curr)
      inst._zod.bag.minimum = def.minimum;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = (payload) => {
    const val = payload.value;
    return !nullish(val) && val.length !== undefined;
  });
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.minimum = def.length;
    bag.maximum = def.length;
    bag.length = def.length;
  });
  inst._zod.check = (payload) => {
    const input = payload.value;
    const length = input.length;
    if (length === def.length)
      return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a, _b;
  $ZodCheck.init(inst, def);
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.format = def.format;
    if (def.pattern) {
      bag.patterns ?? (bag.patterns = new Set);
      bag.patterns.add(def.pattern);
    }
  });
  if (def.pattern)
    (_a = inst._zod).check ?? (_a.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b = inst._zod).check ?? (_b.check = () => {});
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
  $ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
  def.pattern = pattern;
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.patterns ?? (bag.patterns = new Set);
    bag.patterns.add(pattern);
  });
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function handleCheckPropertyResult(result, payload, property) {
  if (result.issues.length) {
    payload.issues.push(...prefixIssues(property, result.issues));
  }
}
var $ZodCheckProperty = /* @__PURE__ */ $constructor("$ZodCheckProperty", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    const result = def.schema._zod.run({
      value: payload.value[def.property],
      issues: []
    }, {});
    if (result instanceof Promise) {
      return result.then((result) => handleCheckPropertyResult(result, payload, def.property));
    }
    handleCheckPropertyResult(result, payload, def.property);
    return;
  };
});
var $ZodCheckMimeType = /* @__PURE__ */ $constructor("$ZodCheckMimeType", (inst, def) => {
  $ZodCheck.init(inst, def);
  const mimeSet = new Set(def.mime);
  inst._zod.onattach.push((inst) => {
    inst._zod.bag.mime = def.mime;
  });
  inst._zod.check = (payload) => {
    if (mimeSet.has(payload.value.type))
      return;
    payload.issues.push({
      code: "invalid_value",
      values: def.mime,
      input: payload.value.type,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/core/doc.js
class Doc {
  constructor(args = []) {
    this.content = [];
    this.indent = 0;
    if (this)
      this.args = args;
  }
  indented(fn) {
    this.indent += 1;
    fn(this);
    this.indent -= 1;
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, { execution: "sync" });
      arg(this, { execution: "async" });
      return;
    }
    const content = arg;
    const lines = content.split(`
`).filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const args = this?.args;
    const content = this?.content ?? [``];
    const lines = [...content.map((x) => `  ${x}`)];
    return new F(...args, lines.join(`
`));
  }
}

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 1,
  patch: 8
};

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const checks = [...inst._zod.def.checks ?? []];
  if (inst._zod.traits.has("$ZodCheck")) {
    checks.unshift(inst);
  }
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks, ctx) => {
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks) {
        if (ch._zod.def.when) {
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError;
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary) => {
            return handleCanaryResult(canary, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return result.then((result) => runChecks(result, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
  inst["~standard"] = {
    validate: (value) => {
      try {
        const r = safeParse(inst, value);
        return r.success ? { value: r.data } : { issues: r.error?.issues };
      } catch (_) {
        return safeParseAsync(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
      }
    },
    vendor: "zod",
    version: 1
  };
});
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string(inst._zod.bag);
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_) {}
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
var $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  $ZodStringFormat.init(inst, def);
});
var $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === undefined)
      throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ?? (def.pattern = uuid(v));
  } else
    def.pattern ?? (def.pattern = uuid());
  $ZodStringFormat.init(inst, def);
});
var $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  $ZodStringFormat.init(inst, def);
});
var $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      const url = new URL(trimmed);
      if (def.hostname) {
        def.hostname.lastIndex = 0;
        if (!def.hostname.test(url.hostname)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid hostname",
            pattern: hostname.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.protocol) {
        def.protocol.lastIndex = 0;
        if (!def.protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol)) {
          payload.issues.push({
            code: "invalid_format",
            format: "url",
            note: "Invalid protocol",
            pattern: def.protocol.source,
            input: payload.value,
            inst,
            continue: !def.abort
          });
        }
      }
      if (def.normalize) {
        payload.value = url.href;
      } else {
        payload.value = trimmed;
      }
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  $ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
  def.pattern ?? (def.pattern = nanoid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  $ZodStringFormat.init(inst, def);
});
var $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  $ZodStringFormat.init(inst, def);
});
var $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  $ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  $ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  $ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.format = `ipv4`;
  });
});
var $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst) => {
    const bag = inst._zod.bag;
    bag.format = `ipv6`;
  });
  inst._zod.check = (payload) => {
    try {
      new URL(`http://[${payload.value}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  $ZodStringFormat.init(inst, def);
});
var $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    const parts = payload.value.split("/");
    try {
      if (parts.length !== 2)
        throw new Error;
      const [address, prefix] = parts;
      if (!prefix)
        throw new Error;
      const prefixNum = Number(prefix);
      if (`${prefixNum}` !== prefix)
        throw new Error;
      if (prefixNum < 0 || prefixNum > 128)
        throw new Error;
      new URL(`http://[${address}]`);
    } catch {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "")
    return true;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
var $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst) => {
    inst._zod.bag.contentEncoding = "base64";
  });
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
function isValidBase64URL(data) {
  if (!base64url.test(data))
    return false;
  const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return isValidBase64(padded);
}
var $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64url);
  $ZodStringFormat.init(inst, def);
  inst._zod.onattach.push((inst) => {
    inst._zod.bag.contentEncoding = "base64url";
  });
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  $ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
var $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCustomStringFormat = /* @__PURE__ */ $constructor("$ZodCustomStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (def.fn(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: def.format,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = inst._zod.bag.pattern ?? number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : undefined : undefined;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodBigInt = /* @__PURE__ */ $constructor("$ZodBigInt", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = bigint;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = BigInt(payload.value);
      } catch (_) {}
    if (typeof payload.value === "bigint")
      return payload;
    payload.issues.push({
      expected: "bigint",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodBigIntFormat = /* @__PURE__ */ $constructor("$ZodBigInt", (inst, def) => {
  $ZodCheckBigIntFormat.init(inst, def);
  $ZodBigInt.init(inst, def);
});
var $ZodSymbol = /* @__PURE__ */ $constructor("$ZodSymbol", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "symbol")
      return payload;
    payload.issues.push({
      expected: "symbol",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodUndefined = /* @__PURE__ */ $constructor("$ZodUndefined", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _undefined;
  inst._zod.values = new Set([undefined]);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "undefined")
      return payload;
    payload.issues.push({
      expected: "undefined",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodNull = /* @__PURE__ */ $constructor("$ZodNull", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _null;
  inst._zod.values = new Set([null]);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input === null)
      return payload;
    payload.issues.push({
      expected: "null",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodAny = /* @__PURE__ */ $constructor("$ZodAny", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodVoid = /* @__PURE__ */ $constructor("$ZodVoid", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (typeof input === "undefined")
      return payload;
    payload.issues.push({
      expected: "void",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodDate = /* @__PURE__ */ $constructor("$ZodDate", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce) {
      try {
        payload.value = new Date(payload.value);
      } catch (_err) {}
    }
    const input = payload.value;
    const isDate = input instanceof Date;
    const isValidDate = isDate && !Number.isNaN(input.getTime());
    if (isValidDate)
      return payload;
    payload.issues.push({
      expected: "date",
      code: "invalid_type",
      input,
      ...isDate ? { received: "Invalid Date" } : {},
      inst
    });
    return payload;
  };
});
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = Array(input.length);
    const proms = [];
    for (let i = 0;i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result) => handleArrayResult(result, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
function handlePropertyResult(result, final, key, input) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (result.value === undefined) {
    if (key in input) {
      final.value[key] = undefined;
    }
  } else {
    final.value[key] = result.value;
  }
}
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  for (const k of keys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    keys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  for (const key of Object.keys(input)) {
    if (keySet.has(key))
      continue;
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r) => handlePropertyResult(r, payload, key, input)));
    } else {
      handlePropertyResult(r, payload, key, input);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const _normalized = cached(() => normalizeDef(def));
  defineLazy(inst._zod, "propValues", () => {
    const shape = def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        propValues[key] ?? (propValues[key] = new Set);
        for (const v of field.values)
          propValues[key].add(v);
      }
    }
    return propValues;
  });
  const isObject = isObject2;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = {};
    const proms = [];
    const shape = value.shape;
    for (const key of value.keys) {
      const el = shape[key];
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r) => handlePropertyResult(r, payload, key, input)));
      } else {
        handlePropertyResult(r, payload, key, input);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
  };
});
var $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const generateFastpass = (shape) => {
    const doc = new Doc(["shape", "payload", "ctx"]);
    const normalized = _normalized.value;
    const parseStr = (key) => {
      const k = esc(key);
      return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
    };
    doc.write(`const input = payload.value;`);
    const ids = Object.create(null);
    let counter = 0;
    for (const key of normalized.keys) {
      ids[key] = `key_${counter++}`;
    }
    doc.write(`const newResult = {};`);
    for (const key of normalized.keys) {
      const id = ids[key];
      const k = esc(key);
      doc.write(`const ${id} = ${parseStr(key)};`);
      doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
    }
    doc.write(`payload.value = newResult;`);
    doc.write(`return payload;`);
    const fn = doc.compile();
    return (payload, ctx) => fn(shape, payload, ctx);
  };
  let fastpass;
  const isObject = isObject2;
  const jit = !globalConfig.jitless;
  const allowsEval2 = allowsEval;
  const fastEnabled = jit && allowsEval2.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass)
        fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall)
        return payload;
      return handleCatchall([], input, payload, ctx, value, inst);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : undefined);
  defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : undefined);
  defineLazy(inst._zod, "values", () => {
    if (def.options.every((o) => o._zod.values)) {
      return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return;
  });
  defineLazy(inst._zod, "pattern", () => {
    if (def.options.every((o) => o._zod.pattern)) {
      const patterns = def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return;
  });
  const single = def.options.length === 1;
  const first = def.options[0]._zod.run;
  inst._zod.parse = (payload, ctx) => {
    if (single) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results) => {
      return handleUnionResults(results, payload, inst, ctx);
    });
  };
});
var $ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  const _super = inst._zod.parse;
  defineLazy(inst._zod, "propValues", () => {
    const propValues = {};
    for (const option of def.options) {
      const pv = option._zod.propValues;
      if (!pv || Object.keys(pv).length === 0)
        throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
      for (const [k, v] of Object.entries(pv)) {
        if (!propValues[k])
          propValues[k] = new Set;
        for (const val of v) {
          propValues[k].add(val);
        }
      }
    }
    return propValues;
  });
  const disc = cached(() => {
    const opts = def.options;
    const map = new Map;
    for (const o of opts) {
      const values = o._zod.propValues?.[def.discriminator];
      if (!values || values.size === 0)
        throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(o)}"`);
      for (const v of values) {
        if (map.has(v)) {
          throw new Error(`Duplicate discriminator value "${String(v)}"`);
        }
        map.set(v, o);
      }
    }
    return map;
  });
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        code: "invalid_type",
        expected: "object",
        input,
        inst
      });
      return payload;
    }
    const opt = disc.value.get(input?.[def.discriminator]);
    if (opt) {
      return opt._zod.run(payload, ctx);
    }
    if (def.unionFallback) {
      return _super(payload, ctx);
    }
    payload.issues.push({
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: def.discriminator,
      input,
      path: [def.discriminator],
      inst
    });
    return payload;
  };
});
var $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([left, right]).then(([left, right]) => {
        return handleIntersectionResults(payload, left, right);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  if (left.issues.length) {
    result.issues.push(...left.issues);
  }
  if (right.issues.length) {
    result.issues.push(...right.issues);
  }
  if (aborted(result))
    return result;
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    throw new Error(`Unmergable intersection. Error path: ` + `${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
var $ZodTuple = /* @__PURE__ */ $constructor("$ZodTuple", (inst, def) => {
  $ZodType.init(inst, def);
  const items = def.items;
  const optStart = items.length - [...items].reverse().findIndex((item) => item._zod.optin !== "optional");
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        input,
        inst,
        expected: "tuple",
        code: "invalid_type"
      });
      return payload;
    }
    payload.value = [];
    const proms = [];
    if (!def.rest) {
      const tooBig = input.length > items.length;
      const tooSmall = input.length < optStart - 1;
      if (tooBig || tooSmall) {
        payload.issues.push({
          ...tooBig ? { code: "too_big", maximum: items.length } : { code: "too_small", minimum: items.length },
          input,
          inst,
          origin: "array"
        });
        return payload;
      }
    }
    let i = -1;
    for (const item of items) {
      i++;
      if (i >= input.length) {
        if (i >= optStart)
          continue;
      }
      const result = item._zod.run({
        value: input[i],
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result) => handleTupleResult(result, payload, i)));
      } else {
        handleTupleResult(result, payload, i);
      }
    }
    if (def.rest) {
      const rest = input.slice(items.length);
      for (const el of rest) {
        i++;
        const result = def.rest._zod.run({
          value: el,
          issues: []
        }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result) => handleTupleResult(result, payload, i)));
        } else {
          handleTupleResult(result, payload, i);
        }
      }
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleTupleResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    if (def.keyType._zod.values) {
      const values = def.keyType._zod.values;
      payload.value = {};
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result) => {
              if (result.issues.length) {
                payload.issues.push(...prefixIssues(key, result.issues));
              }
              payload.value[key] = result.value;
            }));
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[key] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!values.has(key)) {
          unrecognized = unrecognized ?? [];
          unrecognized.push(key);
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized
        });
      }
    } else {
      payload.value = {};
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__")
          continue;
        const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        if (keyResult.issues.length) {
          payload.issues.push({
            code: "invalid_key",
            origin: "record",
            issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
            input: key,
            path: [key],
            inst
          });
          payload.value[keyResult.value] = keyResult.value;
          continue;
        }
        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result) => {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[keyResult.value] = result.value;
          }));
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[keyResult.value] = result.value;
        }
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
var $ZodMap = /* @__PURE__ */ $constructor("$ZodMap", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!(input instanceof Map)) {
      payload.issues.push({
        expected: "map",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    payload.value = new Map;
    for (const [key, value] of input) {
      const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
      const valueResult = def.valueType._zod.run({ value, issues: [] }, ctx);
      if (keyResult instanceof Promise || valueResult instanceof Promise) {
        proms.push(Promise.all([keyResult, valueResult]).then(([keyResult, valueResult]) => {
          handleMapResult(keyResult, valueResult, payload, key, input, inst, ctx);
        }));
      } else {
        handleMapResult(keyResult, valueResult, payload, key, input, inst, ctx);
      }
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleMapResult(keyResult, valueResult, final, key, input, inst, ctx) {
  if (keyResult.issues.length) {
    if (propertyKeyTypes.has(typeof key)) {
      final.issues.push(...prefixIssues(key, keyResult.issues));
    } else {
      final.issues.push({
        code: "invalid_key",
        origin: "map",
        input,
        inst,
        issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config()))
      });
    }
  }
  if (valueResult.issues.length) {
    if (propertyKeyTypes.has(typeof key)) {
      final.issues.push(...prefixIssues(key, valueResult.issues));
    } else {
      final.issues.push({
        origin: "map",
        code: "invalid_element",
        input,
        inst,
        key,
        issues: valueResult.issues.map((iss) => finalizeIssue(iss, ctx, config()))
      });
    }
  }
  final.value.set(keyResult.value, valueResult.value);
}
var $ZodSet = /* @__PURE__ */ $constructor("$ZodSet", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!(input instanceof Set)) {
      payload.issues.push({
        input,
        inst,
        expected: "set",
        code: "invalid_type"
      });
      return payload;
    }
    const proms = [];
    payload.value = new Set;
    for (const item of input) {
      const result = def.valueType._zod.run({ value: item, issues: [] }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result) => handleSetResult(result, payload)));
      } else
        handleSetResult(result, payload);
    }
    if (proms.length)
      return Promise.all(proms).then(() => payload);
    return payload;
  };
});
function handleSetResult(result, final) {
  if (result.issues.length) {
    final.issues.push(...result.issues);
  }
  final.value.add(result.value);
}
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  if (def.values.length === 0) {
    throw new Error("Cannot create literal schema with no valid values");
  }
  inst._zod.values = new Set(def.values);
  inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (inst._zod.values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodFile = /* @__PURE__ */ $constructor("$ZodFile", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input instanceof File)
      return payload;
    payload.issues.push({
      expected: "file",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output) => {
        payload.value = output;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new $ZodAsyncError;
    }
    payload.value = _out;
    return payload;
  };
});
function handleOptionalResult(result, input) {
  if (result.issues.length && input === undefined) {
    return { issues: [], value: undefined };
  }
  return result;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  inst._zod.optout = "optional";
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? new Set([...def.innerType._zod.values, undefined]) : undefined;
  });
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (def.innerType._zod.optin === "optional") {
      const result = def.innerType._zod.run(payload, ctx);
      if (result instanceof Promise)
        return result.then((r) => handleOptionalResult(r, payload.value));
      return handleOptionalResult(result, payload.value);
    }
    if (payload.value === undefined) {
      return payload;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "pattern", () => {
    const pattern = def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : undefined;
  });
  defineLazy(inst._zod, "values", () => {
    return def.innerType._zod.values ? new Set([...def.innerType._zod.values, null]) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleDefaultResult(result, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === undefined) {
    payload.value = def.defaultValue;
  }
  return payload;
}
var $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => {
    const v = def.innerType._zod.values;
    return v ? new Set([...v].filter((x) => x !== undefined)) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleNonOptionalResult(result, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === undefined) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
var $ZodSuccess = /* @__PURE__ */ $constructor("$ZodSuccess", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError("ZodSuccess");
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => {
        payload.value = result.issues.length === 0;
        return payload;
      });
    }
    payload.value = result.issues.length === 0;
    return payload;
  };
});
var $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => {
        payload.value = result.value;
        if (result.issues.length) {
          payload.value = def.catchValue({
            ...payload,
            error: {
              issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
            },
            input: payload.value
          });
          payload.issues = [];
        }
        return payload;
      });
    }
    payload.value = result.value;
    if (result.issues.length) {
      payload.value = def.catchValue({
        ...payload,
        error: {
          issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
        },
        input: payload.value
      });
      payload.issues = [];
    }
    return payload;
  };
});
var $ZodNaN = /* @__PURE__ */ $constructor("$ZodNaN", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "number" || !Number.isNaN(payload.value)) {
      payload.issues.push({
        input: payload.value,
        inst,
        expected: "nan",
        code: "invalid_type"
      });
      return payload;
    }
    return payload;
  };
});
var $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right) => handlePipeResult(right, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left) => handlePipeResult(left, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues }, ctx);
}
var $ZodCodec = /* @__PURE__ */ $constructor("$ZodCodec", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "values", () => def.in._zod.values);
  defineLazy(inst._zod, "optin", () => def.in._zod.optin);
  defineLazy(inst._zod, "optout", () => def.out._zod.optout);
  defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    const direction = ctx.direction || "forward";
    if (direction === "forward") {
      const left = def.in._zod.run(payload, ctx);
      if (left instanceof Promise) {
        return left.then((left) => handleCodecAResult(left, def, ctx));
      }
      return handleCodecAResult(left, def, ctx);
    } else {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right) => handleCodecAResult(right, def, ctx));
      }
      return handleCodecAResult(right, def, ctx);
    }
  };
});
function handleCodecAResult(result, def, ctx) {
  if (result.issues.length) {
    result.aborted = true;
    return result;
  }
  const direction = ctx.direction || "forward";
  if (direction === "forward") {
    const transformed = def.transform(result.value, result);
    if (transformed instanceof Promise) {
      return transformed.then((value) => handleCodecTxResult(result, value, def.out, ctx));
    }
    return handleCodecTxResult(result, transformed, def.out, ctx);
  } else {
    const transformed = def.reverseTransform(result.value, result);
    if (transformed instanceof Promise) {
      return transformed.then((value) => handleCodecTxResult(result, value, def.in, ctx));
    }
    return handleCodecTxResult(result, transformed, def.in, ctx);
  }
}
function handleCodecTxResult(left, value, nextSchema, ctx) {
  if (left.issues.length) {
    left.aborted = true;
    return left;
  }
  return nextSchema._zod.run({ value, issues: left.issues }, ctx);
}
var $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
  defineLazy(inst._zod, "values", () => def.innerType._zod.values);
  defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
  defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  payload.value = Object.freeze(payload.value);
  return payload;
}
var $ZodTemplateLiteral = /* @__PURE__ */ $constructor("$ZodTemplateLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  const regexParts = [];
  for (const part of def.parts) {
    if (typeof part === "object" && part !== null) {
      if (!part._zod.pattern) {
        throw new Error(`Invalid template literal part, no pattern found: ${[...part._zod.traits].shift()}`);
      }
      const source = part._zod.pattern instanceof RegExp ? part._zod.pattern.source : part._zod.pattern;
      if (!source)
        throw new Error(`Invalid template literal part: ${part._zod.traits}`);
      const start = source.startsWith("^") ? 1 : 0;
      const end = source.endsWith("$") ? source.length - 1 : source.length;
      regexParts.push(source.slice(start, end));
    } else if (part === null || primitiveTypes.has(typeof part)) {
      regexParts.push(escapeRegex(`${part}`));
    } else {
      throw new Error(`Invalid template literal part: ${part}`);
    }
  }
  inst._zod.pattern = new RegExp(`^${regexParts.join("")}$`);
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "string") {
      payload.issues.push({
        input: payload.value,
        inst,
        expected: "template_literal",
        code: "invalid_type"
      });
      return payload;
    }
    inst._zod.pattern.lastIndex = 0;
    if (!inst._zod.pattern.test(payload.value)) {
      payload.issues.push({
        input: payload.value,
        inst,
        code: "invalid_format",
        format: def.format ?? "template_literal",
        pattern: inst._zod.pattern.source
      });
      return payload;
    }
    return payload;
  };
});
var $ZodFunction = /* @__PURE__ */ $constructor("$ZodFunction", (inst, def) => {
  $ZodType.init(inst, def);
  inst._def = def;
  inst._zod.def = def;
  inst.implement = (func) => {
    if (typeof func !== "function") {
      throw new Error("implement() must be called with a function");
    }
    return function(...args) {
      const parsedArgs = inst._def.input ? parse(inst._def.input, args) : args;
      const result = Reflect.apply(func, this, parsedArgs);
      if (inst._def.output) {
        return parse(inst._def.output, result);
      }
      return result;
    };
  };
  inst.implementAsync = (func) => {
    if (typeof func !== "function") {
      throw new Error("implementAsync() must be called with a function");
    }
    return async function(...args) {
      const parsedArgs = inst._def.input ? await parseAsync(inst._def.input, args) : args;
      const result = await Reflect.apply(func, this, parsedArgs);
      if (inst._def.output) {
        return await parseAsync(inst._def.output, result);
      }
      return result;
    };
  };
  inst._zod.parse = (payload, _ctx) => {
    if (typeof payload.value !== "function") {
      payload.issues.push({
        code: "invalid_type",
        expected: "function",
        input: payload.value,
        inst
      });
      return payload;
    }
    const hasPromiseOutput = inst._def.output && inst._def.output._zod.def.type === "promise";
    if (hasPromiseOutput) {
      payload.value = inst.implementAsync(payload.value);
    } else {
      payload.value = inst.implement(payload.value);
    }
    return payload;
  };
  inst.input = (...args) => {
    const F = inst.constructor;
    if (Array.isArray(args[0])) {
      return new F({
        type: "function",
        input: new $ZodTuple({
          type: "tuple",
          items: args[0],
          rest: args[1]
        }),
        output: inst._def.output
      });
    }
    return new F({
      type: "function",
      input: args[0],
      output: inst._def.output
    });
  };
  inst.output = (output) => {
    const F = inst.constructor;
    return new F({
      type: "function",
      input: inst._def.input,
      output
    });
  };
  return inst;
});
var $ZodPromise = /* @__PURE__ */ $constructor("$ZodPromise", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    return Promise.resolve(payload.value).then((inner) => def.innerType._zod.run({ value: inner, issues: [] }, ctx));
  };
});
var $ZodLazy = /* @__PURE__ */ $constructor("$ZodLazy", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "innerType", () => def.getter());
  defineLazy(inst._zod, "pattern", () => inst._zod.innerType._zod.pattern);
  defineLazy(inst._zod, "propValues", () => inst._zod.innerType._zod.propValues);
  defineLazy(inst._zod, "optin", () => inst._zod.innerType._zod.optin ?? undefined);
  defineLazy(inst._zod, "optout", () => inst._zod.innerType._zod.optout ?? undefined);
  inst._zod.parse = (payload, ctx) => {
    const inner = inst._zod.innerType;
    return inner._zod.run(payload, ctx);
  };
});
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r) => handleRefineResult(r, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      path: [...inst._zod.def.path ?? []],
      continue: !inst._zod.def.abort
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/index.js
var exports_locales = {};
__export(exports_locales, {
  ar: () => ar_default,
  az: () => az_default,
  be: () => be_default,
  ca: () => ca_default,
  cs: () => cs_default,
  da: () => da_default,
  de: () => de_default,
  en: () => en_default,
  eo: () => eo_default,
  es: () => es_default,
  fa: () => fa_default,
  fi: () => fi_default,
  fr: () => fr_default,
  frCA: () => fr_CA_default,
  he: () => he_default,
  hu: () => hu_default,
  id: () => id_default,
  is: () => is_default,
  it: () => it_default,
  ja: () => ja_default,
  ka: () => ka_default,
  kh: () => kh_default,
  km: () => km_default,
  ko: () => ko_default,
  lt: () => lt_default,
  mk: () => mk_default,
  ms: () => ms_default,
  nl: () => nl_default,
  no: () => no_default,
  ota: () => ota_default,
  pl: () => pl_default,
  ps: () => ps_default,
  pt: () => pt_default,
  ru: () => ru_default,
  sl: () => sl_default,
  sv: () => sv_default,
  ta: () => ta_default,
  th: () => th_default,
  tr: () => tr_default,
  ua: () => ua_default,
  uk: () => uk_default,
  ur: () => ur_default,
  vi: () => vi_default,
  yo: () => yo_default,
  zhCN: () => zh_CN_default,
  zhTW: () => zh_TW_default
});

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/ar.js
var error = () => {
  const Sizable = {
    string: { unit: "حرف", verb: "أن يحوي" },
    file: { unit: "بايت", verb: "أن يحوي" },
    array: { unit: "عنصر", verb: "أن يحوي" },
    set: { unit: "عنصر", verb: "أن يحوي" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "مدخل",
    email: "بريد إلكتروني",
    url: "رابط",
    emoji: "إيموجي",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "تاريخ ووقت بمعيار ISO",
    date: "تاريخ بمعيار ISO",
    time: "وقت بمعيار ISO",
    duration: "مدة بمعيار ISO",
    ipv4: "عنوان IPv4",
    ipv6: "عنوان IPv6",
    cidrv4: "مدى عناوين بصيغة IPv4",
    cidrv6: "مدى عناوين بصيغة IPv6",
    base64: "نَص بترميز base64-encoded",
    base64url: "نَص بترميز base64url-encoded",
    json_string: "نَص على هيئة JSON",
    e164: "رقم هاتف بمعيار E.164",
    jwt: "JWT",
    template_literal: "مدخل"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `مدخلات غير مقبولة: يفترض إدخال ${issue.expected}، ولكن تم إدخال ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `مدخلات غير مقبولة: يفترض إدخال ${stringifyPrimitive(issue.values[0])}`;
        return `اختيار غير مقبول: يتوقع انتقاء أحد هذه الخيارات: ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return ` أكبر من اللازم: يفترض أن تكون ${issue.origin ?? "القيمة"} ${adj} ${issue.maximum.toString()} ${sizing.unit ?? "عنصر"}`;
        return `أكبر من اللازم: يفترض أن تكون ${issue.origin ?? "القيمة"} ${adj} ${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `أصغر من اللازم: يفترض لـ ${issue.origin} أن يكون ${adj} ${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `أصغر من اللازم: يفترض لـ ${issue.origin} أن يكون ${adj} ${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `نَص غير مقبول: يجب أن يبدأ بـ "${issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `نَص غير مقبول: يجب أن ينتهي بـ "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `نَص غير مقبول: يجب أن يتضمَّن "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `نَص غير مقبول: يجب أن يطابق النمط ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue.format} غير مقبول`;
      }
      case "not_multiple_of":
        return `رقم غير مقبول: يجب أن يكون من مضاعفات ${issue.divisor}`;
      case "unrecognized_keys":
        return `معرف${issue.keys.length > 1 ? "ات" : ""} غريب${issue.keys.length > 1 ? "ة" : ""}: ${joinValues(issue.keys, "، ")}`;
      case "invalid_key":
        return `معرف غير مقبول في ${issue.origin}`;
      case "invalid_union":
        return "مدخل غير مقبول";
      case "invalid_element":
        return `مدخل غير مقبول في ${issue.origin}`;
      default:
        return "مدخل غير مقبول";
    }
  };
};
function ar_default() {
  return {
    localeError: error()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/az.js
var error2 = () => {
  const Sizable = {
    string: { unit: "simvol", verb: "olmalıdır" },
    file: { unit: "bayt", verb: "olmalıdır" },
    array: { unit: "element", verb: "olmalıdır" },
    set: { unit: "element", verb: "olmalıdır" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Yanlış dəyər: gözlənilən ${issue.expected}, daxil olan ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Yanlış dəyər: gözlənilən ${stringifyPrimitive(issue.values[0])}`;
        return `Yanlış seçim: aşağıdakılardan biri olmalıdır: ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Çox böyük: gözlənilən ${issue.origin ?? "dəyər"} ${adj}${issue.maximum.toString()} ${sizing.unit ?? "element"}`;
        return `Çox böyük: gözlənilən ${issue.origin ?? "dəyər"} ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Çox kiçik: gözlənilən ${issue.origin} ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        return `Çox kiçik: gözlənilən ${issue.origin} ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Yanlış mətn: "${_issue.prefix}" ilə başlamalıdır`;
        if (_issue.format === "ends_with")
          return `Yanlış mətn: "${_issue.suffix}" ilə bitməlidir`;
        if (_issue.format === "includes")
          return `Yanlış mətn: "${_issue.includes}" daxil olmalıdır`;
        if (_issue.format === "regex")
          return `Yanlış mətn: ${_issue.pattern} şablonuna uyğun olmalıdır`;
        return `Yanlış ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Yanlış ədəd: ${issue.divisor} ilə bölünə bilən olmalıdır`;
      case "unrecognized_keys":
        return `Tanınmayan açar${issue.keys.length > 1 ? "lar" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `${issue.origin} daxilində yanlış açar`;
      case "invalid_union":
        return "Yanlış dəyər";
      case "invalid_element":
        return `${issue.origin} daxilində yanlış dəyər`;
      default:
        return `Yanlış dəyər`;
    }
  };
};
function az_default() {
  return {
    localeError: error2()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/be.js
function getBelarusianPlural(count, one, few, many) {
  const absCount = Math.abs(count);
  const lastDigit = absCount % 10;
  const lastTwoDigits = absCount % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return many;
  }
  if (lastDigit === 1) {
    return one;
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return few;
  }
  return many;
}
var error3 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "сімвал",
        few: "сімвалы",
        many: "сімвалаў"
      },
      verb: "мець"
    },
    array: {
      unit: {
        one: "элемент",
        few: "элементы",
        many: "элементаў"
      },
      verb: "мець"
    },
    set: {
      unit: {
        one: "элемент",
        few: "элементы",
        many: "элементаў"
      },
      verb: "мець"
    },
    file: {
      unit: {
        one: "байт",
        few: "байты",
        many: "байтаў"
      },
      verb: "мець"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "лік";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "масіў";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "увод",
    email: "email адрас",
    url: "URL",
    emoji: "эмодзі",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO дата і час",
    date: "ISO дата",
    time: "ISO час",
    duration: "ISO працягласць",
    ipv4: "IPv4 адрас",
    ipv6: "IPv6 адрас",
    cidrv4: "IPv4 дыяпазон",
    cidrv6: "IPv6 дыяпазон",
    base64: "радок у фармаце base64",
    base64url: "радок у фармаце base64url",
    json_string: "JSON радок",
    e164: "нумар E.164",
    jwt: "JWT",
    template_literal: "увод"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Няправільны ўвод: чакаўся ${issue.expected}, атрымана ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Няправільны ўвод: чакалася ${stringifyPrimitive(issue.values[0])}`;
        return `Няправільны варыянт: чакаўся адзін з ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          const maxValue = Number(issue.maximum);
          const unit = getBelarusianPlural(maxValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `Занадта вялікі: чакалася, што ${issue.origin ?? "значэнне"} павінна ${sizing.verb} ${adj}${issue.maximum.toString()} ${unit}`;
        }
        return `Занадта вялікі: чакалася, што ${issue.origin ?? "значэнне"} павінна быць ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          const minValue = Number(issue.minimum);
          const unit = getBelarusianPlural(minValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `Занадта малы: чакалася, што ${issue.origin} павінна ${sizing.verb} ${adj}${issue.minimum.toString()} ${unit}`;
        }
        return `Занадта малы: чакалася, што ${issue.origin} павінна быць ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Няправільны радок: павінен пачынацца з "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Няправільны радок: павінен заканчвацца на "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Няправільны радок: павінен змяшчаць "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Няправільны радок: павінен адпавядаць шаблону ${_issue.pattern}`;
        return `Няправільны ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Няправільны лік: павінен быць кратным ${issue.divisor}`;
      case "unrecognized_keys":
        return `Нераспазнаны ${issue.keys.length > 1 ? "ключы" : "ключ"}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Няправільны ключ у ${issue.origin}`;
      case "invalid_union":
        return "Няправільны ўвод";
      case "invalid_element":
        return `Няправільнае значэнне ў ${issue.origin}`;
      default:
        return `Няправільны ўвод`;
    }
  };
};
function be_default() {
  return {
    localeError: error3()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/ca.js
var error4 = () => {
  const Sizable = {
    string: { unit: "caràcters", verb: "contenir" },
    file: { unit: "bytes", verb: "contenir" },
    array: { unit: "elements", verb: "contenir" },
    set: { unit: "elements", verb: "contenir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entrada",
    email: "adreça electrònica",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data i hora ISO",
    date: "data ISO",
    time: "hora ISO",
    duration: "durada ISO",
    ipv4: "adreça IPv4",
    ipv6: "adreça IPv6",
    cidrv4: "rang IPv4",
    cidrv6: "rang IPv6",
    base64: "cadena codificada en base64",
    base64url: "cadena codificada en base64url",
    json_string: "cadena JSON",
    e164: "número E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Tipus invàlid: s'esperava ${issue.expected}, s'ha rebut ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Valor invàlid: s'esperava ${stringifyPrimitive(issue.values[0])}`;
        return `Opció invàlida: s'esperava una de ${joinValues(issue.values, " o ")}`;
      case "too_big": {
        const adj = issue.inclusive ? "com a màxim" : "menys de";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Massa gran: s'esperava que ${issue.origin ?? "el valor"} contingués ${adj} ${issue.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Massa gran: s'esperava que ${issue.origin ?? "el valor"} fos ${adj} ${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? "com a mínim" : "més de";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Massa petit: s'esperava que ${issue.origin} contingués ${adj} ${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Massa petit: s'esperava que ${issue.origin} fos ${adj} ${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `Format invàlid: ha de començar amb "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Format invàlid: ha d'acabar amb "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Format invàlid: ha d'incloure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Format invàlid: ha de coincidir amb el patró ${_issue.pattern}`;
        return `Format invàlid per a ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Número invàlid: ha de ser múltiple de ${issue.divisor}`;
      case "unrecognized_keys":
        return `Clau${issue.keys.length > 1 ? "s" : ""} no reconeguda${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Clau invàlida a ${issue.origin}`;
      case "invalid_union":
        return "Entrada invàlida";
      case "invalid_element":
        return `Element invàlid a ${issue.origin}`;
      default:
        return `Entrada invàlida`;
    }
  };
};
function ca_default() {
  return {
    localeError: error4()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/cs.js
var error5 = () => {
  const Sizable = {
    string: { unit: "znaků", verb: "mít" },
    file: { unit: "bajtů", verb: "mít" },
    array: { unit: "prvků", verb: "mít" },
    set: { unit: "prvků", verb: "mít" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "číslo";
      }
      case "string": {
        return "řetězec";
      }
      case "boolean": {
        return "boolean";
      }
      case "bigint": {
        return "bigint";
      }
      case "function": {
        return "funkce";
      }
      case "symbol": {
        return "symbol";
      }
      case "undefined": {
        return "undefined";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "pole";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "regulární výraz",
    email: "e-mailová adresa",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "datum a čas ve formátu ISO",
    date: "datum ve formátu ISO",
    time: "čas ve formátu ISO",
    duration: "doba trvání ISO",
    ipv4: "IPv4 adresa",
    ipv6: "IPv6 adresa",
    cidrv4: "rozsah IPv4",
    cidrv6: "rozsah IPv6",
    base64: "řetězec zakódovaný ve formátu base64",
    base64url: "řetězec zakódovaný ve formátu base64url",
    json_string: "řetězec ve formátu JSON",
    e164: "číslo E.164",
    jwt: "JWT",
    template_literal: "vstup"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Neplatný vstup: očekáváno ${issue.expected}, obdrženo ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Neplatný vstup: očekáváno ${stringifyPrimitive(issue.values[0])}`;
        return `Neplatná možnost: očekávána jedna z hodnot ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Hodnota je příliš velká: ${issue.origin ?? "hodnota"} musí mít ${adj}${issue.maximum.toString()} ${sizing.unit ?? "prvků"}`;
        }
        return `Hodnota je příliš velká: ${issue.origin ?? "hodnota"} musí být ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Hodnota je příliš malá: ${issue.origin ?? "hodnota"} musí mít ${adj}${issue.minimum.toString()} ${sizing.unit ?? "prvků"}`;
        }
        return `Hodnota je příliš malá: ${issue.origin ?? "hodnota"} musí být ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Neplatný řetězec: musí začínat na "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Neplatný řetězec: musí končit na "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Neplatný řetězec: musí obsahovat "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Neplatný řetězec: musí odpovídat vzoru ${_issue.pattern}`;
        return `Neplatný formát ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Neplatné číslo: musí být násobkem ${issue.divisor}`;
      case "unrecognized_keys":
        return `Neznámé klíče: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Neplatný klíč v ${issue.origin}`;
      case "invalid_union":
        return "Neplatný vstup";
      case "invalid_element":
        return `Neplatná hodnota v ${issue.origin}`;
      default:
        return `Neplatný vstup`;
    }
  };
};
function cs_default() {
  return {
    localeError: error5()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/da.js
var error6 = () => {
  const Sizable = {
    string: { unit: "tegn", verb: "havde" },
    file: { unit: "bytes", verb: "havde" },
    array: { unit: "elementer", verb: "indeholdt" },
    set: { unit: "elementer", verb: "indeholdt" }
  };
  const TypeNames = {
    string: "streng",
    number: "tal",
    boolean: "boolean",
    array: "liste",
    object: "objekt",
    set: "sæt",
    file: "fil"
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  function getTypeName(type) {
    return TypeNames[type] ?? type;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "tal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "liste";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
        return "objekt";
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "e-mailadresse",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dato- og klokkeslæt",
    date: "ISO-dato",
    time: "ISO-klokkeslæt",
    duration: "ISO-varighed",
    ipv4: "IPv4-område",
    ipv6: "IPv6-område",
    cidrv4: "IPv4-spektrum",
    cidrv6: "IPv6-spektrum",
    base64: "base64-kodet streng",
    base64url: "base64url-kodet streng",
    json_string: "JSON-streng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Ugyldigt input: forventede ${getTypeName(issue.expected)}, fik ${getTypeName(parsedType(issue.input))}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Ugyldig værdi: forventede ${stringifyPrimitive(issue.values[0])}`;
        return `Ugyldigt valg: forventede en af følgende ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        const origin = getTypeName(issue.origin);
        if (sizing)
          return `For stor: forventede ${origin ?? "value"} ${sizing.verb} ${adj} ${issue.maximum.toString()} ${sizing.unit ?? "elementer"}`;
        return `For stor: forventede ${origin ?? "value"} havde ${adj} ${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        const origin = getTypeName(issue.origin);
        if (sizing) {
          return `For lille: forventede ${origin} ${sizing.verb} ${adj} ${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `For lille: forventede ${origin} havde ${adj} ${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Ugyldig streng: skal starte med "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Ugyldig streng: skal ende med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ugyldig streng: skal indeholde "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ugyldig streng: skal matche mønsteret ${_issue.pattern}`;
        return `Ugyldig ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Ugyldigt tal: skal være deleligt med ${issue.divisor}`;
      case "unrecognized_keys":
        return `${issue.keys.length > 1 ? "Ukendte nøgler" : "Ukendt nøgle"}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Ugyldig nøgle i ${issue.origin}`;
      case "invalid_union":
        return "Ugyldigt input: matcher ingen af de tilladte typer";
      case "invalid_element":
        return `Ugyldig værdi i ${issue.origin}`;
      default:
        return `Ugyldigt input`;
    }
  };
};
function da_default() {
  return {
    localeError: error6()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/de.js
var error7 = () => {
  const Sizable = {
    string: { unit: "Zeichen", verb: "zu haben" },
    file: { unit: "Bytes", verb: "zu haben" },
    array: { unit: "Elemente", verb: "zu haben" },
    set: { unit: "Elemente", verb: "zu haben" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "Zahl";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "Array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "Eingabe",
    email: "E-Mail-Adresse",
    url: "URL",
    emoji: "Emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-Datum und -Uhrzeit",
    date: "ISO-Datum",
    time: "ISO-Uhrzeit",
    duration: "ISO-Dauer",
    ipv4: "IPv4-Adresse",
    ipv6: "IPv6-Adresse",
    cidrv4: "IPv4-Bereich",
    cidrv6: "IPv6-Bereich",
    base64: "Base64-codierter String",
    base64url: "Base64-URL-codierter String",
    json_string: "JSON-String",
    e164: "E.164-Nummer",
    jwt: "JWT",
    template_literal: "Eingabe"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Ungültige Eingabe: erwartet ${issue.expected}, erhalten ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Ungültige Eingabe: erwartet ${stringifyPrimitive(issue.values[0])}`;
        return `Ungültige Option: erwartet eine von ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Zu groß: erwartet, dass ${issue.origin ?? "Wert"} ${adj}${issue.maximum.toString()} ${sizing.unit ?? "Elemente"} hat`;
        return `Zu groß: erwartet, dass ${issue.origin ?? "Wert"} ${adj}${issue.maximum.toString()} ist`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Zu klein: erwartet, dass ${issue.origin} ${adj}${issue.minimum.toString()} ${sizing.unit} hat`;
        }
        return `Zu klein: erwartet, dass ${issue.origin} ${adj}${issue.minimum.toString()} ist`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Ungültiger String: muss mit "${_issue.prefix}" beginnen`;
        if (_issue.format === "ends_with")
          return `Ungültiger String: muss mit "${_issue.suffix}" enden`;
        if (_issue.format === "includes")
          return `Ungültiger String: muss "${_issue.includes}" enthalten`;
        if (_issue.format === "regex")
          return `Ungültiger String: muss dem Muster ${_issue.pattern} entsprechen`;
        return `Ungültig: ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Ungültige Zahl: muss ein Vielfaches von ${issue.divisor} sein`;
      case "unrecognized_keys":
        return `${issue.keys.length > 1 ? "Unbekannte Schlüssel" : "Unbekannter Schlüssel"}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Ungültiger Schlüssel in ${issue.origin}`;
      case "invalid_union":
        return "Ungültige Eingabe";
      case "invalid_element":
        return `Ungültiger Wert in ${issue.origin}`;
      default:
        return `Ungültige Eingabe`;
    }
  };
};
function de_default() {
  return {
    localeError: error7()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/en.js
var parsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "number";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error8 = () => {
  const Sizable = {
    string: { unit: "characters", verb: "to have" },
    file: { unit: "bytes", verb: "to have" },
    array: { unit: "items", verb: "to have" },
    set: { unit: "items", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Invalid input: expected ${issue.expected}, received ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue.values[0])}`;
        return `Invalid option: expected one of ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Too big: expected ${issue.origin ?? "value"} to have ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Too big: expected ${issue.origin ?? "value"} to be ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Too small: expected ${issue.origin} to have ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Too small: expected ${issue.origin} to be ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `Invalid string: must start with "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Invalid string: must end with "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Invalid string: must include "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Invalid string: must match pattern ${_issue.pattern}`;
        return `Invalid ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Invalid number: must be a multiple of ${issue.divisor}`;
      case "unrecognized_keys":
        return `Unrecognized key${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Invalid key in ${issue.origin}`;
      case "invalid_union":
        return "Invalid input";
      case "invalid_element":
        return `Invalid value in ${issue.origin}`;
      default:
        return `Invalid input`;
    }
  };
};
function en_default() {
  return {
    localeError: error8()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/eo.js
var parsedType2 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "nombro";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "tabelo";
      }
      if (data === null) {
        return "senvalora";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error9 = () => {
  const Sizable = {
    string: { unit: "karaktrojn", verb: "havi" },
    file: { unit: "bajtojn", verb: "havi" },
    array: { unit: "elementojn", verb: "havi" },
    set: { unit: "elementojn", verb: "havi" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "enigo",
    email: "retadreso",
    url: "URL",
    emoji: "emoĝio",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-datotempo",
    date: "ISO-dato",
    time: "ISO-tempo",
    duration: "ISO-daŭro",
    ipv4: "IPv4-adreso",
    ipv6: "IPv6-adreso",
    cidrv4: "IPv4-rango",
    cidrv6: "IPv6-rango",
    base64: "64-ume kodita karaktraro",
    base64url: "URL-64-ume kodita karaktraro",
    json_string: "JSON-karaktraro",
    e164: "E.164-nombro",
    jwt: "JWT",
    template_literal: "enigo"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Nevalida enigo: atendiĝis ${issue.expected}, riceviĝis ${parsedType2(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Nevalida enigo: atendiĝis ${stringifyPrimitive(issue.values[0])}`;
        return `Nevalida opcio: atendiĝis unu el ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Tro granda: atendiĝis ke ${issue.origin ?? "valoro"} havu ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elementojn"}`;
        return `Tro granda: atendiĝis ke ${issue.origin ?? "valoro"} havu ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Tro malgranda: atendiĝis ke ${issue.origin} havu ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Tro malgranda: atendiĝis ke ${issue.origin} estu ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Nevalida karaktraro: devas komenciĝi per "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Nevalida karaktraro: devas finiĝi per "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Nevalida karaktraro: devas inkluzivi "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Nevalida karaktraro: devas kongrui kun la modelo ${_issue.pattern}`;
        return `Nevalida ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Nevalida nombro: devas esti oblo de ${issue.divisor}`;
      case "unrecognized_keys":
        return `Nekonata${issue.keys.length > 1 ? "j" : ""} ŝlosilo${issue.keys.length > 1 ? "j" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Nevalida ŝlosilo en ${issue.origin}`;
      case "invalid_union":
        return "Nevalida enigo";
      case "invalid_element":
        return `Nevalida valoro en ${issue.origin}`;
      default:
        return `Nevalida enigo`;
    }
  };
};
function eo_default() {
  return {
    localeError: error9()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/es.js
var error10 = () => {
  const Sizable = {
    string: { unit: "caracteres", verb: "tener" },
    file: { unit: "bytes", verb: "tener" },
    array: { unit: "elementos", verb: "tener" },
    set: { unit: "elementos", verb: "tener" }
  };
  const TypeNames = {
    string: "texto",
    number: "número",
    boolean: "booleano",
    array: "arreglo",
    object: "objeto",
    set: "conjunto",
    file: "archivo",
    date: "fecha",
    bigint: "número grande",
    symbol: "símbolo",
    undefined: "indefinido",
    null: "nulo",
    function: "función",
    map: "mapa",
    record: "registro",
    tuple: "tupla",
    enum: "enumeración",
    union: "unión",
    literal: "literal",
    promise: "promesa",
    void: "vacío",
    never: "nunca",
    unknown: "desconocido",
    any: "cualquiera"
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  function getTypeName(type) {
    return TypeNames[type] ?? type;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype) {
          return data.constructor.name;
        }
        return "object";
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entrada",
    email: "dirección de correo electrónico",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "fecha y hora ISO",
    date: "fecha ISO",
    time: "hora ISO",
    duration: "duración ISO",
    ipv4: "dirección IPv4",
    ipv6: "dirección IPv6",
    cidrv4: "rango IPv4",
    cidrv6: "rango IPv6",
    base64: "cadena codificada en base64",
    base64url: "URL codificada en base64",
    json_string: "cadena JSON",
    e164: "número E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Entrada inválida: se esperaba ${getTypeName(issue.expected)}, recibido ${getTypeName(parsedType(issue.input))}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Entrada inválida: se esperaba ${stringifyPrimitive(issue.values[0])}`;
        return `Opción inválida: se esperaba una de ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        const origin = getTypeName(issue.origin);
        if (sizing)
          return `Demasiado grande: se esperaba que ${origin ?? "valor"} tuviera ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elementos"}`;
        return `Demasiado grande: se esperaba que ${origin ?? "valor"} fuera ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        const origin = getTypeName(issue.origin);
        if (sizing) {
          return `Demasiado pequeño: se esperaba que ${origin} tuviera ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Demasiado pequeño: se esperaba que ${origin} fuera ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Cadena inválida: debe comenzar con "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Cadena inválida: debe terminar en "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Cadena inválida: debe incluir "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Cadena inválida: debe coincidir con el patrón ${_issue.pattern}`;
        return `Inválido ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Número inválido: debe ser múltiplo de ${issue.divisor}`;
      case "unrecognized_keys":
        return `Llave${issue.keys.length > 1 ? "s" : ""} desconocida${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Llave inválida en ${getTypeName(issue.origin)}`;
      case "invalid_union":
        return "Entrada inválida";
      case "invalid_element":
        return `Valor inválido en ${getTypeName(issue.origin)}`;
      default:
        return `Entrada inválida`;
    }
  };
};
function es_default() {
  return {
    localeError: error10()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/fa.js
var error11 = () => {
  const Sizable = {
    string: { unit: "کاراکتر", verb: "داشته باشد" },
    file: { unit: "بایت", verb: "داشته باشد" },
    array: { unit: "آیتم", verb: "داشته باشد" },
    set: { unit: "آیتم", verb: "داشته باشد" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "عدد";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "آرایه";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ورودی",
    email: "آدرس ایمیل",
    url: "URL",
    emoji: "ایموجی",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "تاریخ و زمان ایزو",
    date: "تاریخ ایزو",
    time: "زمان ایزو",
    duration: "مدت زمان ایزو",
    ipv4: "IPv4 آدرس",
    ipv6: "IPv6 آدرس",
    cidrv4: "IPv4 دامنه",
    cidrv6: "IPv6 دامنه",
    base64: "base64-encoded رشته",
    base64url: "base64url-encoded رشته",
    json_string: "JSON رشته",
    e164: "E.164 عدد",
    jwt: "JWT",
    template_literal: "ورودی"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `ورودی نامعتبر: می‌بایست ${issue.expected} می‌بود، ${parsedType(issue.input)} دریافت شد`;
      case "invalid_value":
        if (issue.values.length === 1) {
          return `ورودی نامعتبر: می‌بایست ${stringifyPrimitive(issue.values[0])} می‌بود`;
        }
        return `گزینه نامعتبر: می‌بایست یکی از ${joinValues(issue.values, "|")} می‌بود`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `خیلی بزرگ: ${issue.origin ?? "مقدار"} باید ${adj}${issue.maximum.toString()} ${sizing.unit ?? "عنصر"} باشد`;
        }
        return `خیلی بزرگ: ${issue.origin ?? "مقدار"} باید ${adj}${issue.maximum.toString()} باشد`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `خیلی کوچک: ${issue.origin} باید ${adj}${issue.minimum.toString()} ${sizing.unit} باشد`;
        }
        return `خیلی کوچک: ${issue.origin} باید ${adj}${issue.minimum.toString()} باشد`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `رشته نامعتبر: باید با "${_issue.prefix}" شروع شود`;
        }
        if (_issue.format === "ends_with") {
          return `رشته نامعتبر: باید با "${_issue.suffix}" تمام شود`;
        }
        if (_issue.format === "includes") {
          return `رشته نامعتبر: باید شامل "${_issue.includes}" باشد`;
        }
        if (_issue.format === "regex") {
          return `رشته نامعتبر: باید با الگوی ${_issue.pattern} مطابقت داشته باشد`;
        }
        return `${Nouns[_issue.format] ?? issue.format} نامعتبر`;
      }
      case "not_multiple_of":
        return `عدد نامعتبر: باید مضرب ${issue.divisor} باشد`;
      case "unrecognized_keys":
        return `کلید${issue.keys.length > 1 ? "های" : ""} ناشناس: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `کلید ناشناس در ${issue.origin}`;
      case "invalid_union":
        return `ورودی نامعتبر`;
      case "invalid_element":
        return `مقدار نامعتبر در ${issue.origin}`;
      default:
        return `ورودی نامعتبر`;
    }
  };
};
function fa_default() {
  return {
    localeError: error11()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/fi.js
var error12 = () => {
  const Sizable = {
    string: { unit: "merkkiä", subject: "merkkijonon" },
    file: { unit: "tavua", subject: "tiedoston" },
    array: { unit: "alkiota", subject: "listan" },
    set: { unit: "alkiota", subject: "joukon" },
    number: { unit: "", subject: "luvun" },
    bigint: { unit: "", subject: "suuren kokonaisluvun" },
    int: { unit: "", subject: "kokonaisluvun" },
    date: { unit: "", subject: "päivämäärän" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "säännöllinen lauseke",
    email: "sähköpostiosoite",
    url: "URL-osoite",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-aikaleima",
    date: "ISO-päivämäärä",
    time: "ISO-aika",
    duration: "ISO-kesto",
    ipv4: "IPv4-osoite",
    ipv6: "IPv6-osoite",
    cidrv4: "IPv4-alue",
    cidrv6: "IPv6-alue",
    base64: "base64-koodattu merkkijono",
    base64url: "base64url-koodattu merkkijono",
    json_string: "JSON-merkkijono",
    e164: "E.164-luku",
    jwt: "JWT",
    template_literal: "templaattimerkkijono"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Virheellinen tyyppi: odotettiin ${issue.expected}, oli ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Virheellinen syöte: täytyy olla ${stringifyPrimitive(issue.values[0])}`;
        return `Virheellinen valinta: täytyy olla yksi seuraavista: ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Liian suuri: ${sizing.subject} täytyy olla ${adj}${issue.maximum.toString()} ${sizing.unit}`.trim();
        }
        return `Liian suuri: arvon täytyy olla ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Liian pieni: ${sizing.subject} täytyy olla ${adj}${issue.minimum.toString()} ${sizing.unit}`.trim();
        }
        return `Liian pieni: arvon täytyy olla ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Virheellinen syöte: täytyy alkaa "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Virheellinen syöte: täytyy loppua "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Virheellinen syöte: täytyy sisältää "${_issue.includes}"`;
        if (_issue.format === "regex") {
          return `Virheellinen syöte: täytyy vastata säännöllistä lauseketta ${_issue.pattern}`;
        }
        return `Virheellinen ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Virheellinen luku: täytyy olla luvun ${issue.divisor} monikerta`;
      case "unrecognized_keys":
        return `${issue.keys.length > 1 ? "Tuntemattomat avaimet" : "Tuntematon avain"}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return "Virheellinen avain tietueessa";
      case "invalid_union":
        return "Virheellinen unioni";
      case "invalid_element":
        return "Virheellinen arvo joukossa";
      default:
        return `Virheellinen syöte`;
    }
  };
};
function fi_default() {
  return {
    localeError: error12()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/fr.js
var error13 = () => {
  const Sizable = {
    string: { unit: "caractères", verb: "avoir" },
    file: { unit: "octets", verb: "avoir" },
    array: { unit: "éléments", verb: "avoir" },
    set: { unit: "éléments", verb: "avoir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "nombre";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tableau";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entrée",
    email: "adresse e-mail",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "date et heure ISO",
    date: "date ISO",
    time: "heure ISO",
    duration: "durée ISO",
    ipv4: "adresse IPv4",
    ipv6: "adresse IPv6",
    cidrv4: "plage IPv4",
    cidrv6: "plage IPv6",
    base64: "chaîne encodée en base64",
    base64url: "chaîne encodée en base64url",
    json_string: "chaîne JSON",
    e164: "numéro E.164",
    jwt: "JWT",
    template_literal: "entrée"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Entrée invalide : ${issue.expected} attendu, ${parsedType(issue.input)} reçu`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Entrée invalide : ${stringifyPrimitive(issue.values[0])} attendu`;
        return `Option invalide : une valeur parmi ${joinValues(issue.values, "|")} attendue`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Trop grand : ${issue.origin ?? "valeur"} doit ${sizing.verb} ${adj}${issue.maximum.toString()} ${sizing.unit ?? "élément(s)"}`;
        return `Trop grand : ${issue.origin ?? "valeur"} doit être ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Trop petit : ${issue.origin} doit ${sizing.verb} ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Trop petit : ${issue.origin} doit être ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Chaîne invalide : doit commencer par "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Chaîne invalide : doit se terminer par "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Chaîne invalide : doit inclure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Chaîne invalide : doit correspondre au modèle ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit être un multiple de ${issue.divisor}`;
      case "unrecognized_keys":
        return `Clé${issue.keys.length > 1 ? "s" : ""} non reconnue${issue.keys.length > 1 ? "s" : ""} : ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Clé invalide dans ${issue.origin}`;
      case "invalid_union":
        return "Entrée invalide";
      case "invalid_element":
        return `Valeur invalide dans ${issue.origin}`;
      default:
        return `Entrée invalide`;
    }
  };
};
function fr_default() {
  return {
    localeError: error13()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/fr-CA.js
var error14 = () => {
  const Sizable = {
    string: { unit: "caractères", verb: "avoir" },
    file: { unit: "octets", verb: "avoir" },
    array: { unit: "éléments", verb: "avoir" },
    set: { unit: "éléments", verb: "avoir" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "entrée",
    email: "adresse courriel",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "date-heure ISO",
    date: "date ISO",
    time: "heure ISO",
    duration: "durée ISO",
    ipv4: "adresse IPv4",
    ipv6: "adresse IPv6",
    cidrv4: "plage IPv4",
    cidrv6: "plage IPv6",
    base64: "chaîne encodée en base64",
    base64url: "chaîne encodée en base64url",
    json_string: "chaîne JSON",
    e164: "numéro E.164",
    jwt: "JWT",
    template_literal: "entrée"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Entrée invalide : attendu ${issue.expected}, reçu ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Entrée invalide : attendu ${stringifyPrimitive(issue.values[0])}`;
        return `Option invalide : attendu l'une des valeurs suivantes ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "≤" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Trop grand : attendu que ${issue.origin ?? "la valeur"} ait ${adj}${issue.maximum.toString()} ${sizing.unit}`;
        return `Trop grand : attendu que ${issue.origin ?? "la valeur"} soit ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? "≥" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Trop petit : attendu que ${issue.origin} ait ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Trop petit : attendu que ${issue.origin} soit ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `Chaîne invalide : doit commencer par "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Chaîne invalide : doit se terminer par "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Chaîne invalide : doit inclure "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Chaîne invalide : doit correspondre au motif ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue.format} invalide`;
      }
      case "not_multiple_of":
        return `Nombre invalide : doit être un multiple de ${issue.divisor}`;
      case "unrecognized_keys":
        return `Clé${issue.keys.length > 1 ? "s" : ""} non reconnue${issue.keys.length > 1 ? "s" : ""} : ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Clé invalide dans ${issue.origin}`;
      case "invalid_union":
        return "Entrée invalide";
      case "invalid_element":
        return `Valeur invalide dans ${issue.origin}`;
      default:
        return `Entrée invalide`;
    }
  };
};
function fr_CA_default() {
  return {
    localeError: error14()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/he.js
var error15 = () => {
  const Sizable = {
    string: { unit: "אותיות", verb: "לכלול" },
    file: { unit: "בייטים", verb: "לכלול" },
    array: { unit: "פריטים", verb: "לכלול" },
    set: { unit: "פריטים", verb: "לכלול" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "קלט",
    email: "כתובת אימייל",
    url: "כתובת רשת",
    emoji: "אימוג'י",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "תאריך וזמן ISO",
    date: "תאריך ISO",
    time: "זמן ISO",
    duration: "משך זמן ISO",
    ipv4: "כתובת IPv4",
    ipv6: "כתובת IPv6",
    cidrv4: "טווח IPv4",
    cidrv6: "טווח IPv6",
    base64: "מחרוזת בבסיס 64",
    base64url: "מחרוזת בבסיס 64 לכתובות רשת",
    json_string: "מחרוזת JSON",
    e164: "מספר E.164",
    jwt: "JWT",
    template_literal: "קלט"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `קלט לא תקין: צריך ${issue.expected}, התקבל ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `קלט לא תקין: צריך ${stringifyPrimitive(issue.values[0])}`;
        return `קלט לא תקין: צריך אחת מהאפשרויות  ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `גדול מדי: ${issue.origin ?? "value"} צריך להיות ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `גדול מדי: ${issue.origin ?? "value"} צריך להיות ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `קטן מדי: ${issue.origin} צריך להיות ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `קטן מדי: ${issue.origin} צריך להיות ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `מחרוזת לא תקינה: חייבת להתחיל ב"${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `מחרוזת לא תקינה: חייבת להסתיים ב "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `מחרוזת לא תקינה: חייבת לכלול "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `מחרוזת לא תקינה: חייבת להתאים לתבנית ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue.format} לא תקין`;
      }
      case "not_multiple_of":
        return `מספר לא תקין: חייב להיות מכפלה של ${issue.divisor}`;
      case "unrecognized_keys":
        return `מפתח${issue.keys.length > 1 ? "ות" : ""} לא מזוה${issue.keys.length > 1 ? "ים" : "ה"}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `מפתח לא תקין ב${issue.origin}`;
      case "invalid_union":
        return "קלט לא תקין";
      case "invalid_element":
        return `ערך לא תקין ב${issue.origin}`;
      default:
        return `קלט לא תקין`;
    }
  };
};
function he_default() {
  return {
    localeError: error15()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/hu.js
var error16 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "legyen" },
    file: { unit: "byte", verb: "legyen" },
    array: { unit: "elem", verb: "legyen" },
    set: { unit: "elem", verb: "legyen" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "szám";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tömb";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "bemenet",
    email: "email cím",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO időbélyeg",
    date: "ISO dátum",
    time: "ISO idő",
    duration: "ISO időintervallum",
    ipv4: "IPv4 cím",
    ipv6: "IPv6 cím",
    cidrv4: "IPv4 tartomány",
    cidrv6: "IPv6 tartomány",
    base64: "base64-kódolt string",
    base64url: "base64url-kódolt string",
    json_string: "JSON string",
    e164: "E.164 szám",
    jwt: "JWT",
    template_literal: "bemenet"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Érvénytelen bemenet: a várt érték ${issue.expected}, a kapott érték ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Érvénytelen bemenet: a várt érték ${stringifyPrimitive(issue.values[0])}`;
        return `Érvénytelen opció: valamelyik érték várt ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Túl nagy: ${issue.origin ?? "érték"} mérete túl nagy ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elem"}`;
        return `Túl nagy: a bemeneti érték ${issue.origin ?? "érték"} túl nagy: ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Túl kicsi: a bemeneti érték ${issue.origin} mérete túl kicsi ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Túl kicsi: a bemeneti érték ${issue.origin} túl kicsi ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Érvénytelen string: "${_issue.prefix}" értékkel kell kezdődnie`;
        if (_issue.format === "ends_with")
          return `Érvénytelen string: "${_issue.suffix}" értékkel kell végződnie`;
        if (_issue.format === "includes")
          return `Érvénytelen string: "${_issue.includes}" értéket kell tartalmaznia`;
        if (_issue.format === "regex")
          return `Érvénytelen string: ${_issue.pattern} mintának kell megfelelnie`;
        return `Érvénytelen ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Érvénytelen szám: ${issue.divisor} többszörösének kell lennie`;
      case "unrecognized_keys":
        return `Ismeretlen kulcs${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Érvénytelen kulcs ${issue.origin}`;
      case "invalid_union":
        return "Érvénytelen bemenet";
      case "invalid_element":
        return `Érvénytelen érték: ${issue.origin}`;
      default:
        return `Érvénytelen bemenet`;
    }
  };
};
function hu_default() {
  return {
    localeError: error16()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/id.js
var error17 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "memiliki" },
    file: { unit: "byte", verb: "memiliki" },
    array: { unit: "item", verb: "memiliki" },
    set: { unit: "item", verb: "memiliki" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "alamat email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "tanggal dan waktu format ISO",
    date: "tanggal format ISO",
    time: "jam format ISO",
    duration: "durasi format ISO",
    ipv4: "alamat IPv4",
    ipv6: "alamat IPv6",
    cidrv4: "rentang alamat IPv4",
    cidrv6: "rentang alamat IPv6",
    base64: "string dengan enkode base64",
    base64url: "string dengan enkode base64url",
    json_string: "string JSON",
    e164: "angka E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Input tidak valid: diharapkan ${issue.expected}, diterima ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Input tidak valid: diharapkan ${stringifyPrimitive(issue.values[0])}`;
        return `Pilihan tidak valid: diharapkan salah satu dari ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Terlalu besar: diharapkan ${issue.origin ?? "value"} memiliki ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elemen"}`;
        return `Terlalu besar: diharapkan ${issue.origin ?? "value"} menjadi ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Terlalu kecil: diharapkan ${issue.origin} memiliki ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Terlalu kecil: diharapkan ${issue.origin} menjadi ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `String tidak valid: harus dimulai dengan "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `String tidak valid: harus berakhir dengan "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `String tidak valid: harus menyertakan "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `String tidak valid: harus sesuai pola ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue.format} tidak valid`;
      }
      case "not_multiple_of":
        return `Angka tidak valid: harus kelipatan dari ${issue.divisor}`;
      case "unrecognized_keys":
        return `Kunci tidak dikenali ${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Kunci tidak valid di ${issue.origin}`;
      case "invalid_union":
        return "Input tidak valid";
      case "invalid_element":
        return `Nilai tidak valid di ${issue.origin}`;
      default:
        return `Input tidak valid`;
    }
  };
};
function id_default() {
  return {
    localeError: error17()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/is.js
var parsedType3 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "númer";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "fylki";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error18 = () => {
  const Sizable = {
    string: { unit: "stafi", verb: "að hafa" },
    file: { unit: "bæti", verb: "að hafa" },
    array: { unit: "hluti", verb: "að hafa" },
    set: { unit: "hluti", verb: "að hafa" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "gildi",
    email: "netfang",
    url: "vefslóð",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dagsetning og tími",
    date: "ISO dagsetning",
    time: "ISO tími",
    duration: "ISO tímalengd",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded strengur",
    base64url: "base64url-encoded strengur",
    json_string: "JSON strengur",
    e164: "E.164 tölugildi",
    jwt: "JWT",
    template_literal: "gildi"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Rangt gildi: Þú slóst inn ${parsedType3(issue.input)} þar sem á að vera ${issue.expected}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Rangt gildi: gert ráð fyrir ${stringifyPrimitive(issue.values[0])}`;
        return `Ógilt val: má vera eitt af eftirfarandi ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Of stórt: gert er ráð fyrir að ${issue.origin ?? "gildi"} hafi ${adj}${issue.maximum.toString()} ${sizing.unit ?? "hluti"}`;
        return `Of stórt: gert er ráð fyrir að ${issue.origin ?? "gildi"} sé ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Of lítið: gert er ráð fyrir að ${issue.origin} hafi ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Of lítið: gert er ráð fyrir að ${issue.origin} sé ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `Ógildur strengur: verður að byrja á "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Ógildur strengur: verður að enda á "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ógildur strengur: verður að innihalda "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ógildur strengur: verður að fylgja mynstri ${_issue.pattern}`;
        return `Rangt ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Röng tala: verður að vera margfeldi af ${issue.divisor}`;
      case "unrecognized_keys":
        return `Óþekkt ${issue.keys.length > 1 ? "ir lyklar" : "ur lykill"}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Rangur lykill í ${issue.origin}`;
      case "invalid_union":
        return "Rangt gildi";
      case "invalid_element":
        return `Rangt gildi í ${issue.origin}`;
      default:
        return `Rangt gildi`;
    }
  };
};
function is_default() {
  return {
    localeError: error18()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/it.js
var error19 = () => {
  const Sizable = {
    string: { unit: "caratteri", verb: "avere" },
    file: { unit: "byte", verb: "avere" },
    array: { unit: "elementi", verb: "avere" },
    set: { unit: "elementi", verb: "avere" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "numero";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "vettore";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "indirizzo email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data e ora ISO",
    date: "data ISO",
    time: "ora ISO",
    duration: "durata ISO",
    ipv4: "indirizzo IPv4",
    ipv6: "indirizzo IPv6",
    cidrv4: "intervallo IPv4",
    cidrv6: "intervallo IPv6",
    base64: "stringa codificata in base64",
    base64url: "URL codificata in base64",
    json_string: "stringa JSON",
    e164: "numero E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Input non valido: atteso ${issue.expected}, ricevuto ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Input non valido: atteso ${stringifyPrimitive(issue.values[0])}`;
        return `Opzione non valida: atteso uno tra ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Troppo grande: ${issue.origin ?? "valore"} deve avere ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elementi"}`;
        return `Troppo grande: ${issue.origin ?? "valore"} deve essere ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Troppo piccolo: ${issue.origin} deve avere ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Troppo piccolo: ${issue.origin} deve essere ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Stringa non valida: deve iniziare con "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Stringa non valida: deve terminare con "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Stringa non valida: deve includere "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Stringa non valida: deve corrispondere al pattern ${_issue.pattern}`;
        return `Invalid ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Numero non valido: deve essere un multiplo di ${issue.divisor}`;
      case "unrecognized_keys":
        return `Chiav${issue.keys.length > 1 ? "i" : "e"} non riconosciut${issue.keys.length > 1 ? "e" : "a"}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Chiave non valida in ${issue.origin}`;
      case "invalid_union":
        return "Input non valido";
      case "invalid_element":
        return `Valore non valido in ${issue.origin}`;
      default:
        return `Input non valido`;
    }
  };
};
function it_default() {
  return {
    localeError: error19()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/ja.js
var error20 = () => {
  const Sizable = {
    string: { unit: "文字", verb: "である" },
    file: { unit: "バイト", verb: "である" },
    array: { unit: "要素", verb: "である" },
    set: { unit: "要素", verb: "である" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "数値";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "配列";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "入力値",
    email: "メールアドレス",
    url: "URL",
    emoji: "絵文字",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO日時",
    date: "ISO日付",
    time: "ISO時刻",
    duration: "ISO期間",
    ipv4: "IPv4アドレス",
    ipv6: "IPv6アドレス",
    cidrv4: "IPv4範囲",
    cidrv6: "IPv6範囲",
    base64: "base64エンコード文字列",
    base64url: "base64urlエンコード文字列",
    json_string: "JSON文字列",
    e164: "E.164番号",
    jwt: "JWT",
    template_literal: "入力値"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `無効な入力: ${issue.expected}が期待されましたが、${parsedType(issue.input)}が入力されました`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `無効な入力: ${stringifyPrimitive(issue.values[0])}が期待されました`;
        return `無効な選択: ${joinValues(issue.values, "、")}のいずれかである必要があります`;
      case "too_big": {
        const adj = issue.inclusive ? "以下である" : "より小さい";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `大きすぎる値: ${issue.origin ?? "値"}は${issue.maximum.toString()}${sizing.unit ?? "要素"}${adj}必要があります`;
        return `大きすぎる値: ${issue.origin ?? "値"}は${issue.maximum.toString()}${adj}必要があります`;
      }
      case "too_small": {
        const adj = issue.inclusive ? "以上である" : "より大きい";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `小さすぎる値: ${issue.origin}は${issue.minimum.toString()}${sizing.unit}${adj}必要があります`;
        return `小さすぎる値: ${issue.origin}は${issue.minimum.toString()}${adj}必要があります`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `無効な文字列: "${_issue.prefix}"で始まる必要があります`;
        if (_issue.format === "ends_with")
          return `無効な文字列: "${_issue.suffix}"で終わる必要があります`;
        if (_issue.format === "includes")
          return `無効な文字列: "${_issue.includes}"を含む必要があります`;
        if (_issue.format === "regex")
          return `無効な文字列: パターン${_issue.pattern}に一致する必要があります`;
        return `無効な${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `無効な数値: ${issue.divisor}の倍数である必要があります`;
      case "unrecognized_keys":
        return `認識されていないキー${issue.keys.length > 1 ? "群" : ""}: ${joinValues(issue.keys, "、")}`;
      case "invalid_key":
        return `${issue.origin}内の無効なキー`;
      case "invalid_union":
        return "無効な入力";
      case "invalid_element":
        return `${issue.origin}内の無効な値`;
      default:
        return `無効な入力`;
    }
  };
};
function ja_default() {
  return {
    localeError: error20()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/ka.js
var parsedType4 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "რიცხვი";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "მასივი";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  const typeMap = {
    string: "სტრინგი",
    boolean: "ბულეანი",
    undefined: "undefined",
    bigint: "bigint",
    symbol: "symbol",
    function: "ფუნქცია"
  };
  return typeMap[t] ?? t;
};
var error21 = () => {
  const Sizable = {
    string: { unit: "სიმბოლო", verb: "უნდა შეიცავდეს" },
    file: { unit: "ბაიტი", verb: "უნდა შეიცავდეს" },
    array: { unit: "ელემენტი", verb: "უნდა შეიცავდეს" },
    set: { unit: "ელემენტი", verb: "უნდა შეიცავდეს" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "შეყვანა",
    email: "ელ-ფოსტის მისამართი",
    url: "URL",
    emoji: "ემოჯი",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "თარიღი-დრო",
    date: "თარიღი",
    time: "დრო",
    duration: "ხანგრძლივობა",
    ipv4: "IPv4 მისამართი",
    ipv6: "IPv6 მისამართი",
    cidrv4: "IPv4 დიაპაზონი",
    cidrv6: "IPv6 დიაპაზონი",
    base64: "base64-კოდირებული სტრინგი",
    base64url: "base64url-კოდირებული სტრინგი",
    json_string: "JSON სტრინგი",
    e164: "E.164 ნომერი",
    jwt: "JWT",
    template_literal: "შეყვანა"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `არასწორი შეყვანა: მოსალოდნელი ${issue.expected}, მიღებული ${parsedType4(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `არასწორი შეყვანა: მოსალოდნელი ${stringifyPrimitive(issue.values[0])}`;
        return `არასწორი ვარიანტი: მოსალოდნელია ერთ-ერთი ${joinValues(issue.values, "|")}-დან`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `ზედმეტად დიდი: მოსალოდნელი ${issue.origin ?? "მნიშვნელობა"} ${sizing.verb} ${adj}${issue.maximum.toString()} ${sizing.unit}`;
        return `ზედმეტად დიდი: მოსალოდნელი ${issue.origin ?? "მნიშვნელობა"} იყოს ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `ზედმეტად პატარა: მოსალოდნელი ${issue.origin} ${sizing.verb} ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `ზედმეტად პატარა: მოსალოდნელი ${issue.origin} იყოს ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `არასწორი სტრინგი: უნდა იწყებოდეს "${_issue.prefix}"-ით`;
        }
        if (_issue.format === "ends_with")
          return `არასწორი სტრინგი: უნდა მთავრდებოდეს "${_issue.suffix}"-ით`;
        if (_issue.format === "includes")
          return `არასწორი სტრინგი: უნდა შეიცავდეს "${_issue.includes}"-ს`;
        if (_issue.format === "regex")
          return `არასწორი სტრინგი: უნდა შეესაბამებოდეს შაბლონს ${_issue.pattern}`;
        return `არასწორი ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `არასწორი რიცხვი: უნდა იყოს ${issue.divisor}-ის ჯერადი`;
      case "unrecognized_keys":
        return `უცნობი გასაღებ${issue.keys.length > 1 ? "ები" : "ი"}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `არასწორი გასაღები ${issue.origin}-ში`;
      case "invalid_union":
        return "არასწორი შეყვანა";
      case "invalid_element":
        return `არასწორი მნიშვნელობა ${issue.origin}-ში`;
      default:
        return `არასწორი შეყვანა`;
    }
  };
};
function ka_default() {
  return {
    localeError: error21()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/km.js
var error22 = () => {
  const Sizable = {
    string: { unit: "តួអក្សរ", verb: "គួរមាន" },
    file: { unit: "បៃ", verb: "គួរមាន" },
    array: { unit: "ធាតុ", verb: "គួរមាន" },
    set: { unit: "ធាតុ", verb: "គួរមាន" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "មិនមែនជាលេខ (NaN)" : "លេខ";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "អារេ (Array)";
        }
        if (data === null) {
          return "គ្មានតម្លៃ (null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ទិន្នន័យបញ្ចូល",
    email: "អាសយដ្ឋានអ៊ីមែល",
    url: "URL",
    emoji: "សញ្ញាអារម្មណ៍",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "កាលបរិច្ឆេទ និងម៉ោង ISO",
    date: "កាលបរិច្ឆេទ ISO",
    time: "ម៉ោង ISO",
    duration: "រយៈពេល ISO",
    ipv4: "អាសយដ្ឋាន IPv4",
    ipv6: "អាសយដ្ឋាន IPv6",
    cidrv4: "ដែនអាសយដ្ឋាន IPv4",
    cidrv6: "ដែនអាសយដ្ឋាន IPv6",
    base64: "ខ្សែអក្សរអ៊ិកូដ base64",
    base64url: "ខ្សែអក្សរអ៊ិកូដ base64url",
    json_string: "ខ្សែអក្សរ JSON",
    e164: "លេខ E.164",
    jwt: "JWT",
    template_literal: "ទិន្នន័យបញ្ចូល"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `ទិន្នន័យបញ្ចូលមិនត្រឹមត្រូវ៖ ត្រូវការ ${issue.expected} ប៉ុន្តែទទួលបាន ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `ទិន្នន័យបញ្ចូលមិនត្រឹមត្រូវ៖ ត្រូវការ ${stringifyPrimitive(issue.values[0])}`;
        return `ជម្រើសមិនត្រឹមត្រូវ៖ ត្រូវជាមួយក្នុងចំណោម ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `ធំពេក៖ ត្រូវការ ${issue.origin ?? "តម្លៃ"} ${adj} ${issue.maximum.toString()} ${sizing.unit ?? "ធាតុ"}`;
        return `ធំពេក៖ ត្រូវការ ${issue.origin ?? "តម្លៃ"} ${adj} ${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `តូចពេក៖ ត្រូវការ ${issue.origin} ${adj} ${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `តូចពេក៖ ត្រូវការ ${issue.origin} ${adj} ${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវចាប់ផ្តើមដោយ "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវបញ្ចប់ដោយ "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវមាន "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `ខ្សែអក្សរមិនត្រឹមត្រូវ៖ ត្រូវតែផ្គូផ្គងនឹងទម្រង់ដែលបានកំណត់ ${_issue.pattern}`;
        return `មិនត្រឹមត្រូវ៖ ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `លេខមិនត្រឹមត្រូវ៖ ត្រូវតែជាពហុគុណនៃ ${issue.divisor}`;
      case "unrecognized_keys":
        return `រកឃើញសោមិនស្គាល់៖ ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `សោមិនត្រឹមត្រូវនៅក្នុង ${issue.origin}`;
      case "invalid_union":
        return `ទិន្នន័យមិនត្រឹមត្រូវ`;
      case "invalid_element":
        return `ទិន្នន័យមិនត្រឹមត្រូវនៅក្នុង ${issue.origin}`;
      default:
        return `ទិន្នន័យមិនត្រឹមត្រូវ`;
    }
  };
};
function km_default() {
  return {
    localeError: error22()
  };
}

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/kh.js
function kh_default() {
  return km_default();
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/ko.js
var error23 = () => {
  const Sizable = {
    string: { unit: "문자", verb: "to have" },
    file: { unit: "바이트", verb: "to have" },
    array: { unit: "개", verb: "to have" },
    set: { unit: "개", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "입력",
    email: "이메일 주소",
    url: "URL",
    emoji: "이모지",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO 날짜시간",
    date: "ISO 날짜",
    time: "ISO 시간",
    duration: "ISO 기간",
    ipv4: "IPv4 주소",
    ipv6: "IPv6 주소",
    cidrv4: "IPv4 범위",
    cidrv6: "IPv6 범위",
    base64: "base64 인코딩 문자열",
    base64url: "base64url 인코딩 문자열",
    json_string: "JSON 문자열",
    e164: "E.164 번호",
    jwt: "JWT",
    template_literal: "입력"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `잘못된 입력: 예상 타입은 ${issue.expected}, 받은 타입은 ${parsedType(issue.input)}입니다`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `잘못된 입력: 값은 ${stringifyPrimitive(issue.values[0])} 이어야 합니다`;
        return `잘못된 옵션: ${joinValues(issue.values, "또는 ")} 중 하나여야 합니다`;
      case "too_big": {
        const adj = issue.inclusive ? "이하" : "미만";
        const suffix = adj === "미만" ? "이어야 합니다" : "여야 합니다";
        const sizing = getSizing(issue.origin);
        const unit = sizing?.unit ?? "요소";
        if (sizing)
          return `${issue.origin ?? "값"}이 너무 큽니다: ${issue.maximum.toString()}${unit} ${adj}${suffix}`;
        return `${issue.origin ?? "값"}이 너무 큽니다: ${issue.maximum.toString()} ${adj}${suffix}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? "이상" : "초과";
        const suffix = adj === "이상" ? "이어야 합니다" : "여야 합니다";
        const sizing = getSizing(issue.origin);
        const unit = sizing?.unit ?? "요소";
        if (sizing) {
          return `${issue.origin ?? "값"}이 너무 작습니다: ${issue.minimum.toString()}${unit} ${adj}${suffix}`;
        }
        return `${issue.origin ?? "값"}이 너무 작습니다: ${issue.minimum.toString()} ${adj}${suffix}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `잘못된 문자열: "${_issue.prefix}"(으)로 시작해야 합니다`;
        }
        if (_issue.format === "ends_with")
          return `잘못된 문자열: "${_issue.suffix}"(으)로 끝나야 합니다`;
        if (_issue.format === "includes")
          return `잘못된 문자열: "${_issue.includes}"을(를) 포함해야 합니다`;
        if (_issue.format === "regex")
          return `잘못된 문자열: 정규식 ${_issue.pattern} 패턴과 일치해야 합니다`;
        return `잘못된 ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `잘못된 숫자: ${issue.divisor}의 배수여야 합니다`;
      case "unrecognized_keys":
        return `인식할 수 없는 키: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `잘못된 키: ${issue.origin}`;
      case "invalid_union":
        return `잘못된 입력`;
      case "invalid_element":
        return `잘못된 값: ${issue.origin}`;
      default:
        return `잘못된 입력`;
    }
  };
};
function ko_default() {
  return {
    localeError: error23()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/lt.js
var parsedType5 = (data) => {
  const t = typeof data;
  return parsedTypeFromType(t, data);
};
var parsedTypeFromType = (t, data = undefined) => {
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "skaičius";
    }
    case "bigint": {
      return "sveikasis skaičius";
    }
    case "string": {
      return "eilutė";
    }
    case "boolean": {
      return "loginė reikšmė";
    }
    case "undefined":
    case "void": {
      return "neapibrėžta reikšmė";
    }
    case "function": {
      return "funkcija";
    }
    case "symbol": {
      return "simbolis";
    }
    case "object": {
      if (data === undefined)
        return "nežinomas objektas";
      if (data === null)
        return "nulinė reikšmė";
      if (Array.isArray(data))
        return "masyvas";
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
      return "objektas";
    }
    case "null": {
      return "nulinė reikšmė";
    }
  }
  return t;
};
var capitalizeFirstCharacter = (text) => {
  return text.charAt(0).toUpperCase() + text.slice(1);
};
function getUnitTypeFromNumber(number) {
  const abs = Math.abs(number);
  const last = abs % 10;
  const last2 = abs % 100;
  if (last2 >= 11 && last2 <= 19 || last === 0)
    return "many";
  if (last === 1)
    return "one";
  return "few";
}
var error24 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "simbolis",
        few: "simboliai",
        many: "simbolių"
      },
      verb: {
        smaller: {
          inclusive: "turi būti ne ilgesnė kaip",
          notInclusive: "turi būti trumpesnė kaip"
        },
        bigger: {
          inclusive: "turi būti ne trumpesnė kaip",
          notInclusive: "turi būti ilgesnė kaip"
        }
      }
    },
    file: {
      unit: {
        one: "baitas",
        few: "baitai",
        many: "baitų"
      },
      verb: {
        smaller: {
          inclusive: "turi būti ne didesnis kaip",
          notInclusive: "turi būti mažesnis kaip"
        },
        bigger: {
          inclusive: "turi būti ne mažesnis kaip",
          notInclusive: "turi būti didesnis kaip"
        }
      }
    },
    array: {
      unit: {
        one: "elementą",
        few: "elementus",
        many: "elementų"
      },
      verb: {
        smaller: {
          inclusive: "turi turėti ne daugiau kaip",
          notInclusive: "turi turėti mažiau kaip"
        },
        bigger: {
          inclusive: "turi turėti ne mažiau kaip",
          notInclusive: "turi turėti daugiau kaip"
        }
      }
    },
    set: {
      unit: {
        one: "elementą",
        few: "elementus",
        many: "elementų"
      },
      verb: {
        smaller: {
          inclusive: "turi turėti ne daugiau kaip",
          notInclusive: "turi turėti mažiau kaip"
        },
        bigger: {
          inclusive: "turi turėti ne mažiau kaip",
          notInclusive: "turi turėti daugiau kaip"
        }
      }
    }
  };
  function getSizing(origin, unitType, inclusive, targetShouldBe) {
    const result = Sizable[origin] ?? null;
    if (result === null)
      return result;
    return {
      unit: result.unit[unitType],
      verb: result.verb[targetShouldBe][inclusive ? "inclusive" : "notInclusive"]
    };
  }
  const Nouns = {
    regex: "įvestis",
    email: "el. pašto adresas",
    url: "URL",
    emoji: "jaustukas",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO data ir laikas",
    date: "ISO data",
    time: "ISO laikas",
    duration: "ISO trukmė",
    ipv4: "IPv4 adresas",
    ipv6: "IPv6 adresas",
    cidrv4: "IPv4 tinklo prefiksas (CIDR)",
    cidrv6: "IPv6 tinklo prefiksas (CIDR)",
    base64: "base64 užkoduota eilutė",
    base64url: "base64url užkoduota eilutė",
    json_string: "JSON eilutė",
    e164: "E.164 numeris",
    jwt: "JWT",
    template_literal: "įvestis"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Gautas tipas ${parsedType5(issue.input)}, o tikėtasi - ${parsedTypeFromType(issue.expected)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Privalo būti ${stringifyPrimitive(issue.values[0])}`;
        return `Privalo būti vienas iš ${joinValues(issue.values, "|")} pasirinkimų`;
      case "too_big": {
        const origin = parsedTypeFromType(issue.origin);
        const sizing = getSizing(issue.origin, getUnitTypeFromNumber(Number(issue.maximum)), issue.inclusive ?? false, "smaller");
        if (sizing?.verb)
          return `${capitalizeFirstCharacter(origin ?? issue.origin ?? "reikšmė")} ${sizing.verb} ${issue.maximum.toString()} ${sizing.unit ?? "elementų"}`;
        const adj = issue.inclusive ? "ne didesnis kaip" : "mažesnis kaip";
        return `${capitalizeFirstCharacter(origin ?? issue.origin ?? "reikšmė")} turi būti ${adj} ${issue.maximum.toString()} ${sizing?.unit}`;
      }
      case "too_small": {
        const origin = parsedTypeFromType(issue.origin);
        const sizing = getSizing(issue.origin, getUnitTypeFromNumber(Number(issue.minimum)), issue.inclusive ?? false, "bigger");
        if (sizing?.verb)
          return `${capitalizeFirstCharacter(origin ?? issue.origin ?? "reikšmė")} ${sizing.verb} ${issue.minimum.toString()} ${sizing.unit ?? "elementų"}`;
        const adj = issue.inclusive ? "ne mažesnis kaip" : "didesnis kaip";
        return `${capitalizeFirstCharacter(origin ?? issue.origin ?? "reikšmė")} turi būti ${adj} ${issue.minimum.toString()} ${sizing?.unit}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `Eilutė privalo prasidėti "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Eilutė privalo pasibaigti "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Eilutė privalo įtraukti "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Eilutė privalo atitikti ${_issue.pattern}`;
        return `Neteisingas ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Skaičius privalo būti ${issue.divisor} kartotinis.`;
      case "unrecognized_keys":
        return `Neatpažint${issue.keys.length > 1 ? "i" : "as"} rakt${issue.keys.length > 1 ? "ai" : "as"}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return "Rastas klaidingas raktas";
      case "invalid_union":
        return "Klaidinga įvestis";
      case "invalid_element": {
        const origin = parsedTypeFromType(issue.origin);
        return `${capitalizeFirstCharacter(origin ?? issue.origin ?? "reikšmė")} turi klaidingą įvestį`;
      }
      default:
        return "Klaidinga įvestis";
    }
  };
};
function lt_default() {
  return {
    localeError: error24()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/mk.js
var error25 = () => {
  const Sizable = {
    string: { unit: "знаци", verb: "да имаат" },
    file: { unit: "бајти", verb: "да имаат" },
    array: { unit: "ставки", verb: "да имаат" },
    set: { unit: "ставки", verb: "да имаат" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "број";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "низа";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "внес",
    email: "адреса на е-пошта",
    url: "URL",
    emoji: "емоџи",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO датум и време",
    date: "ISO датум",
    time: "ISO време",
    duration: "ISO времетраење",
    ipv4: "IPv4 адреса",
    ipv6: "IPv6 адреса",
    cidrv4: "IPv4 опсег",
    cidrv6: "IPv6 опсег",
    base64: "base64-енкодирана низа",
    base64url: "base64url-енкодирана низа",
    json_string: "JSON низа",
    e164: "E.164 број",
    jwt: "JWT",
    template_literal: "внес"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Грешен внес: се очекува ${issue.expected}, примено ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue.values[0])}`;
        return `Грешана опција: се очекува една ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Премногу голем: се очекува ${issue.origin ?? "вредноста"} да има ${adj}${issue.maximum.toString()} ${sizing.unit ?? "елементи"}`;
        return `Премногу голем: се очекува ${issue.origin ?? "вредноста"} да биде ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Премногу мал: се очекува ${issue.origin} да има ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Премногу мал: се очекува ${issue.origin} да биде ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `Неважечка низа: мора да започнува со "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Неважечка низа: мора да завршува со "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Неважечка низа: мора да вклучува "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Неважечка низа: мора да одгоара на патернот ${_issue.pattern}`;
        return `Invalid ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Грешен број: мора да биде делив со ${issue.divisor}`;
      case "unrecognized_keys":
        return `${issue.keys.length > 1 ? "Непрепознаени клучеви" : "Непрепознаен клуч"}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Грешен клуч во ${issue.origin}`;
      case "invalid_union":
        return "Грешен внес";
      case "invalid_element":
        return `Грешна вредност во ${issue.origin}`;
      default:
        return `Грешен внес`;
    }
  };
};
function mk_default() {
  return {
    localeError: error25()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/ms.js
var error26 = () => {
  const Sizable = {
    string: { unit: "aksara", verb: "mempunyai" },
    file: { unit: "bait", verb: "mempunyai" },
    array: { unit: "elemen", verb: "mempunyai" },
    set: { unit: "elemen", verb: "mempunyai" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "nombor";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "alamat e-mel",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "tarikh masa ISO",
    date: "tarikh ISO",
    time: "masa ISO",
    duration: "tempoh ISO",
    ipv4: "alamat IPv4",
    ipv6: "alamat IPv6",
    cidrv4: "julat IPv4",
    cidrv6: "julat IPv6",
    base64: "string dikodkan base64",
    base64url: "string dikodkan base64url",
    json_string: "string JSON",
    e164: "nombor E.164",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Input tidak sah: dijangka ${issue.expected}, diterima ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Input tidak sah: dijangka ${stringifyPrimitive(issue.values[0])}`;
        return `Pilihan tidak sah: dijangka salah satu daripada ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Terlalu besar: dijangka ${issue.origin ?? "nilai"} ${sizing.verb} ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elemen"}`;
        return `Terlalu besar: dijangka ${issue.origin ?? "nilai"} adalah ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Terlalu kecil: dijangka ${issue.origin} ${sizing.verb} ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Terlalu kecil: dijangka ${issue.origin} adalah ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `String tidak sah: mesti bermula dengan "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `String tidak sah: mesti berakhir dengan "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `String tidak sah: mesti mengandungi "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `String tidak sah: mesti sepadan dengan corak ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue.format} tidak sah`;
      }
      case "not_multiple_of":
        return `Nombor tidak sah: perlu gandaan ${issue.divisor}`;
      case "unrecognized_keys":
        return `Kunci tidak dikenali: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Kunci tidak sah dalam ${issue.origin}`;
      case "invalid_union":
        return "Input tidak sah";
      case "invalid_element":
        return `Nilai tidak sah dalam ${issue.origin}`;
      default:
        return `Input tidak sah`;
    }
  };
};
function ms_default() {
  return {
    localeError: error26()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/nl.js
var error27 = () => {
  const Sizable = {
    string: { unit: "tekens" },
    file: { unit: "bytes" },
    array: { unit: "elementen" },
    set: { unit: "elementen" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "getal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "invoer",
    email: "emailadres",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datum en tijd",
    date: "ISO datum",
    time: "ISO tijd",
    duration: "ISO duur",
    ipv4: "IPv4-adres",
    ipv6: "IPv6-adres",
    cidrv4: "IPv4-bereik",
    cidrv6: "IPv6-bereik",
    base64: "base64-gecodeerde tekst",
    base64url: "base64 URL-gecodeerde tekst",
    json_string: "JSON string",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "invoer"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Ongeldige invoer: verwacht ${issue.expected}, ontving ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Ongeldige invoer: verwacht ${stringifyPrimitive(issue.values[0])}`;
        return `Ongeldige optie: verwacht één van ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Te lang: verwacht dat ${issue.origin ?? "waarde"} ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elementen"} bevat`;
        return `Te lang: verwacht dat ${issue.origin ?? "waarde"} ${adj}${issue.maximum.toString()} is`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Te kort: verwacht dat ${issue.origin} ${adj}${issue.minimum.toString()} ${sizing.unit} bevat`;
        }
        return `Te kort: verwacht dat ${issue.origin} ${adj}${issue.minimum.toString()} is`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `Ongeldige tekst: moet met "${_issue.prefix}" beginnen`;
        }
        if (_issue.format === "ends_with")
          return `Ongeldige tekst: moet op "${_issue.suffix}" eindigen`;
        if (_issue.format === "includes")
          return `Ongeldige tekst: moet "${_issue.includes}" bevatten`;
        if (_issue.format === "regex")
          return `Ongeldige tekst: moet overeenkomen met patroon ${_issue.pattern}`;
        return `Ongeldig: ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Ongeldig getal: moet een veelvoud van ${issue.divisor} zijn`;
      case "unrecognized_keys":
        return `Onbekende key${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Ongeldige key in ${issue.origin}`;
      case "invalid_union":
        return "Ongeldige invoer";
      case "invalid_element":
        return `Ongeldige waarde in ${issue.origin}`;
      default:
        return `Ongeldige invoer`;
    }
  };
};
function nl_default() {
  return {
    localeError: error27()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/no.js
var error28 = () => {
  const Sizable = {
    string: { unit: "tegn", verb: "å ha" },
    file: { unit: "bytes", verb: "å ha" },
    array: { unit: "elementer", verb: "å inneholde" },
    set: { unit: "elementer", verb: "å inneholde" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "tall";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "liste";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "input",
    email: "e-postadresse",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO dato- og klokkeslett",
    date: "ISO-dato",
    time: "ISO-klokkeslett",
    duration: "ISO-varighet",
    ipv4: "IPv4-område",
    ipv6: "IPv6-område",
    cidrv4: "IPv4-spekter",
    cidrv6: "IPv6-spekter",
    base64: "base64-enkodet streng",
    base64url: "base64url-enkodet streng",
    json_string: "JSON-streng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Ugyldig input: forventet ${issue.expected}, fikk ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Ugyldig verdi: forventet ${stringifyPrimitive(issue.values[0])}`;
        return `Ugyldig valg: forventet en av ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `For stor(t): forventet ${issue.origin ?? "value"} til å ha ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elementer"}`;
        return `For stor(t): forventet ${issue.origin ?? "value"} til å ha ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `For lite(n): forventet ${issue.origin} til å ha ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `For lite(n): forventet ${issue.origin} til å ha ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Ugyldig streng: må starte med "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Ugyldig streng: må ende med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ugyldig streng: må inneholde "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ugyldig streng: må matche mønsteret ${_issue.pattern}`;
        return `Ugyldig ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Ugyldig tall: må være et multiplum av ${issue.divisor}`;
      case "unrecognized_keys":
        return `${issue.keys.length > 1 ? "Ukjente nøkler" : "Ukjent nøkkel"}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Ugyldig nøkkel i ${issue.origin}`;
      case "invalid_union":
        return "Ugyldig input";
      case "invalid_element":
        return `Ugyldig verdi i ${issue.origin}`;
      default:
        return `Ugyldig input`;
    }
  };
};
function no_default() {
  return {
    localeError: error28()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/ota.js
var error29 = () => {
  const Sizable = {
    string: { unit: "harf", verb: "olmalıdır" },
    file: { unit: "bayt", verb: "olmalıdır" },
    array: { unit: "unsur", verb: "olmalıdır" },
    set: { unit: "unsur", verb: "olmalıdır" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "numara";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "saf";
        }
        if (data === null) {
          return "gayb";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "giren",
    email: "epostagâh",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO hengâmı",
    date: "ISO tarihi",
    time: "ISO zamanı",
    duration: "ISO müddeti",
    ipv4: "IPv4 nişânı",
    ipv6: "IPv6 nişânı",
    cidrv4: "IPv4 menzili",
    cidrv6: "IPv6 menzili",
    base64: "base64-şifreli metin",
    base64url: "base64url-şifreli metin",
    json_string: "JSON metin",
    e164: "E.164 sayısı",
    jwt: "JWT",
    template_literal: "giren"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Fâsit giren: umulan ${issue.expected}, alınan ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Fâsit giren: umulan ${stringifyPrimitive(issue.values[0])}`;
        return `Fâsit tercih: mûteberler ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Fazla büyük: ${issue.origin ?? "value"}, ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elements"} sahip olmalıydı.`;
        return `Fazla büyük: ${issue.origin ?? "value"}, ${adj}${issue.maximum.toString()} olmalıydı.`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Fazla küçük: ${issue.origin}, ${adj}${issue.minimum.toString()} ${sizing.unit} sahip olmalıydı.`;
        }
        return `Fazla küçük: ${issue.origin}, ${adj}${issue.minimum.toString()} olmalıydı.`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Fâsit metin: "${_issue.prefix}" ile başlamalı.`;
        if (_issue.format === "ends_with")
          return `Fâsit metin: "${_issue.suffix}" ile bitmeli.`;
        if (_issue.format === "includes")
          return `Fâsit metin: "${_issue.includes}" ihtivâ etmeli.`;
        if (_issue.format === "regex")
          return `Fâsit metin: ${_issue.pattern} nakşına uymalı.`;
        return `Fâsit ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Fâsit sayı: ${issue.divisor} katı olmalıydı.`;
      case "unrecognized_keys":
        return `Tanınmayan anahtar ${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `${issue.origin} için tanınmayan anahtar var.`;
      case "invalid_union":
        return "Giren tanınamadı.";
      case "invalid_element":
        return `${issue.origin} için tanınmayan kıymet var.`;
      default:
        return `Kıymet tanınamadı.`;
    }
  };
};
function ota_default() {
  return {
    localeError: error29()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/ps.js
var error30 = () => {
  const Sizable = {
    string: { unit: "توکي", verb: "ولري" },
    file: { unit: "بایټس", verb: "ولري" },
    array: { unit: "توکي", verb: "ولري" },
    set: { unit: "توکي", verb: "ولري" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "عدد";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "ارې";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ورودي",
    email: "بریښنالیک",
    url: "یو آر ال",
    emoji: "ایموجي",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "نیټه او وخت",
    date: "نېټه",
    time: "وخت",
    duration: "موده",
    ipv4: "د IPv4 پته",
    ipv6: "د IPv6 پته",
    cidrv4: "د IPv4 ساحه",
    cidrv6: "د IPv6 ساحه",
    base64: "base64-encoded متن",
    base64url: "base64url-encoded متن",
    json_string: "JSON متن",
    e164: "د E.164 شمېره",
    jwt: "JWT",
    template_literal: "ورودي"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `ناسم ورودي: باید ${issue.expected} وای, مګر ${parsedType(issue.input)} ترلاسه شو`;
      case "invalid_value":
        if (issue.values.length === 1) {
          return `ناسم ورودي: باید ${stringifyPrimitive(issue.values[0])} وای`;
        }
        return `ناسم انتخاب: باید یو له ${joinValues(issue.values, "|")} څخه وای`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `ډیر لوی: ${issue.origin ?? "ارزښت"} باید ${adj}${issue.maximum.toString()} ${sizing.unit ?? "عنصرونه"} ولري`;
        }
        return `ډیر لوی: ${issue.origin ?? "ارزښت"} باید ${adj}${issue.maximum.toString()} وي`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `ډیر کوچنی: ${issue.origin} باید ${adj}${issue.minimum.toString()} ${sizing.unit} ولري`;
        }
        return `ډیر کوچنی: ${issue.origin} باید ${adj}${issue.minimum.toString()} وي`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `ناسم متن: باید د "${_issue.prefix}" سره پیل شي`;
        }
        if (_issue.format === "ends_with") {
          return `ناسم متن: باید د "${_issue.suffix}" سره پای ته ورسيږي`;
        }
        if (_issue.format === "includes") {
          return `ناسم متن: باید "${_issue.includes}" ولري`;
        }
        if (_issue.format === "regex") {
          return `ناسم متن: باید د ${_issue.pattern} سره مطابقت ولري`;
        }
        return `${Nouns[_issue.format] ?? issue.format} ناسم دی`;
      }
      case "not_multiple_of":
        return `ناسم عدد: باید د ${issue.divisor} مضرب وي`;
      case "unrecognized_keys":
        return `ناسم ${issue.keys.length > 1 ? "کلیډونه" : "کلیډ"}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `ناسم کلیډ په ${issue.origin} کې`;
      case "invalid_union":
        return `ناسمه ورودي`;
      case "invalid_element":
        return `ناسم عنصر په ${issue.origin} کې`;
      default:
        return `ناسمه ورودي`;
    }
  };
};
function ps_default() {
  return {
    localeError: error30()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/pl.js
var error31 = () => {
  const Sizable = {
    string: { unit: "znaków", verb: "mieć" },
    file: { unit: "bajtów", verb: "mieć" },
    array: { unit: "elementów", verb: "mieć" },
    set: { unit: "elementów", verb: "mieć" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "liczba";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tablica";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "wyrażenie",
    email: "adres email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data i godzina w formacie ISO",
    date: "data w formacie ISO",
    time: "godzina w formacie ISO",
    duration: "czas trwania ISO",
    ipv4: "adres IPv4",
    ipv6: "adres IPv6",
    cidrv4: "zakres IPv4",
    cidrv6: "zakres IPv6",
    base64: "ciąg znaków zakodowany w formacie base64",
    base64url: "ciąg znaków zakodowany w formacie base64url",
    json_string: "ciąg znaków w formacie JSON",
    e164: "liczba E.164",
    jwt: "JWT",
    template_literal: "wejście"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Nieprawidłowe dane wejściowe: oczekiwano ${issue.expected}, otrzymano ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Nieprawidłowe dane wejściowe: oczekiwano ${stringifyPrimitive(issue.values[0])}`;
        return `Nieprawidłowa opcja: oczekiwano jednej z wartości ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Za duża wartość: oczekiwano, że ${issue.origin ?? "wartość"} będzie mieć ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elementów"}`;
        }
        return `Zbyt duż(y/a/e): oczekiwano, że ${issue.origin ?? "wartość"} będzie wynosić ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Za mała wartość: oczekiwano, że ${issue.origin ?? "wartość"} będzie mieć ${adj}${issue.minimum.toString()} ${sizing.unit ?? "elementów"}`;
        }
        return `Zbyt mał(y/a/e): oczekiwano, że ${issue.origin ?? "wartość"} będzie wynosić ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Nieprawidłowy ciąg znaków: musi zaczynać się od "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Nieprawidłowy ciąg znaków: musi kończyć się na "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Nieprawidłowy ciąg znaków: musi zawierać "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Nieprawidłowy ciąg znaków: musi odpowiadać wzorcowi ${_issue.pattern}`;
        return `Nieprawidłow(y/a/e) ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Nieprawidłowa liczba: musi być wielokrotnością ${issue.divisor}`;
      case "unrecognized_keys":
        return `Nierozpoznane klucze${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Nieprawidłowy klucz w ${issue.origin}`;
      case "invalid_union":
        return "Nieprawidłowe dane wejściowe";
      case "invalid_element":
        return `Nieprawidłowa wartość w ${issue.origin}`;
      default:
        return `Nieprawidłowe dane wejściowe`;
    }
  };
};
function pl_default() {
  return {
    localeError: error31()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/pt.js
var error32 = () => {
  const Sizable = {
    string: { unit: "caracteres", verb: "ter" },
    file: { unit: "bytes", verb: "ter" },
    array: { unit: "itens", verb: "ter" },
    set: { unit: "itens", verb: "ter" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "número";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "nulo";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "padrão",
    email: "endereço de e-mail",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "data e hora ISO",
    date: "data ISO",
    time: "hora ISO",
    duration: "duração ISO",
    ipv4: "endereço IPv4",
    ipv6: "endereço IPv6",
    cidrv4: "faixa de IPv4",
    cidrv6: "faixa de IPv6",
    base64: "texto codificado em base64",
    base64url: "URL codificada em base64",
    json_string: "texto JSON",
    e164: "número E.164",
    jwt: "JWT",
    template_literal: "entrada"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Tipo inválido: esperado ${issue.expected}, recebido ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Entrada inválida: esperado ${stringifyPrimitive(issue.values[0])}`;
        return `Opção inválida: esperada uma das ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Muito grande: esperado que ${issue.origin ?? "valor"} tivesse ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elementos"}`;
        return `Muito grande: esperado que ${issue.origin ?? "valor"} fosse ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Muito pequeno: esperado que ${issue.origin} tivesse ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Muito pequeno: esperado que ${issue.origin} fosse ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Texto inválido: deve começar com "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Texto inválido: deve terminar com "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Texto inválido: deve incluir "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Texto inválido: deve corresponder ao padrão ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue.format} inválido`;
      }
      case "not_multiple_of":
        return `Número inválido: deve ser múltiplo de ${issue.divisor}`;
      case "unrecognized_keys":
        return `Chave${issue.keys.length > 1 ? "s" : ""} desconhecida${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Chave inválida em ${issue.origin}`;
      case "invalid_union":
        return "Entrada inválida";
      case "invalid_element":
        return `Valor inválido em ${issue.origin}`;
      default:
        return `Campo inválido`;
    }
  };
};
function pt_default() {
  return {
    localeError: error32()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/ru.js
function getRussianPlural(count, one, few, many) {
  const absCount = Math.abs(count);
  const lastDigit = absCount % 10;
  const lastTwoDigits = absCount % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return many;
  }
  if (lastDigit === 1) {
    return one;
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return few;
  }
  return many;
}
var error33 = () => {
  const Sizable = {
    string: {
      unit: {
        one: "символ",
        few: "символа",
        many: "символов"
      },
      verb: "иметь"
    },
    file: {
      unit: {
        one: "байт",
        few: "байта",
        many: "байт"
      },
      verb: "иметь"
    },
    array: {
      unit: {
        one: "элемент",
        few: "элемента",
        many: "элементов"
      },
      verb: "иметь"
    },
    set: {
      unit: {
        one: "элемент",
        few: "элемента",
        many: "элементов"
      },
      verb: "иметь"
    }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "число";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "массив";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ввод",
    email: "email адрес",
    url: "URL",
    emoji: "эмодзи",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO дата и время",
    date: "ISO дата",
    time: "ISO время",
    duration: "ISO длительность",
    ipv4: "IPv4 адрес",
    ipv6: "IPv6 адрес",
    cidrv4: "IPv4 диапазон",
    cidrv6: "IPv6 диапазон",
    base64: "строка в формате base64",
    base64url: "строка в формате base64url",
    json_string: "JSON строка",
    e164: "номер E.164",
    jwt: "JWT",
    template_literal: "ввод"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Неверный ввод: ожидалось ${issue.expected}, получено ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Неверный ввод: ожидалось ${stringifyPrimitive(issue.values[0])}`;
        return `Неверный вариант: ожидалось одно из ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          const maxValue = Number(issue.maximum);
          const unit = getRussianPlural(maxValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `Слишком большое значение: ожидалось, что ${issue.origin ?? "значение"} будет иметь ${adj}${issue.maximum.toString()} ${unit}`;
        }
        return `Слишком большое значение: ожидалось, что ${issue.origin ?? "значение"} будет ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          const minValue = Number(issue.minimum);
          const unit = getRussianPlural(minValue, sizing.unit.one, sizing.unit.few, sizing.unit.many);
          return `Слишком маленькое значение: ожидалось, что ${issue.origin} будет иметь ${adj}${issue.minimum.toString()} ${unit}`;
        }
        return `Слишком маленькое значение: ожидалось, что ${issue.origin} будет ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Неверная строка: должна начинаться с "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Неверная строка: должна заканчиваться на "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Неверная строка: должна содержать "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Неверная строка: должна соответствовать шаблону ${_issue.pattern}`;
        return `Неверный ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Неверное число: должно быть кратным ${issue.divisor}`;
      case "unrecognized_keys":
        return `Нераспознанн${issue.keys.length > 1 ? "ые" : "ый"} ключ${issue.keys.length > 1 ? "и" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Неверный ключ в ${issue.origin}`;
      case "invalid_union":
        return "Неверные входные данные";
      case "invalid_element":
        return `Неверное значение в ${issue.origin}`;
      default:
        return `Неверные входные данные`;
    }
  };
};
function ru_default() {
  return {
    localeError: error33()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/sl.js
var error34 = () => {
  const Sizable = {
    string: { unit: "znakov", verb: "imeti" },
    file: { unit: "bajtov", verb: "imeti" },
    array: { unit: "elementov", verb: "imeti" },
    set: { unit: "elementov", verb: "imeti" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "število";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "tabela";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "vnos",
    email: "e-poštni naslov",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datum in čas",
    date: "ISO datum",
    time: "ISO čas",
    duration: "ISO trajanje",
    ipv4: "IPv4 naslov",
    ipv6: "IPv6 naslov",
    cidrv4: "obseg IPv4",
    cidrv6: "obseg IPv6",
    base64: "base64 kodiran niz",
    base64url: "base64url kodiran niz",
    json_string: "JSON niz",
    e164: "E.164 številka",
    jwt: "JWT",
    template_literal: "vnos"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Neveljaven vnos: pričakovano ${issue.expected}, prejeto ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Neveljaven vnos: pričakovano ${stringifyPrimitive(issue.values[0])}`;
        return `Neveljavna možnost: pričakovano eno izmed ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Preveliko: pričakovano, da bo ${issue.origin ?? "vrednost"} imelo ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elementov"}`;
        return `Preveliko: pričakovano, da bo ${issue.origin ?? "vrednost"} ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Premajhno: pričakovano, da bo ${issue.origin} imelo ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Premajhno: pričakovano, da bo ${issue.origin} ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `Neveljaven niz: mora se začeti z "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Neveljaven niz: mora se končati z "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Neveljaven niz: mora vsebovati "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Neveljaven niz: mora ustrezati vzorcu ${_issue.pattern}`;
        return `Neveljaven ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Neveljavno število: mora biti večkratnik ${issue.divisor}`;
      case "unrecognized_keys":
        return `Neprepoznan${issue.keys.length > 1 ? "i ključi" : " ključ"}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Neveljaven ključ v ${issue.origin}`;
      case "invalid_union":
        return "Neveljaven vnos";
      case "invalid_element":
        return `Neveljavna vrednost v ${issue.origin}`;
      default:
        return "Neveljaven vnos";
    }
  };
};
function sl_default() {
  return {
    localeError: error34()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/sv.js
var error35 = () => {
  const Sizable = {
    string: { unit: "tecken", verb: "att ha" },
    file: { unit: "bytes", verb: "att ha" },
    array: { unit: "objekt", verb: "att innehålla" },
    set: { unit: "objekt", verb: "att innehålla" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "antal";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "lista";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "reguljärt uttryck",
    email: "e-postadress",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO-datum och tid",
    date: "ISO-datum",
    time: "ISO-tid",
    duration: "ISO-varaktighet",
    ipv4: "IPv4-intervall",
    ipv6: "IPv6-intervall",
    cidrv4: "IPv4-spektrum",
    cidrv6: "IPv6-spektrum",
    base64: "base64-kodad sträng",
    base64url: "base64url-kodad sträng",
    json_string: "JSON-sträng",
    e164: "E.164-nummer",
    jwt: "JWT",
    template_literal: "mall-literal"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Ogiltig inmatning: förväntat ${issue.expected}, fick ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Ogiltig inmatning: förväntat ${stringifyPrimitive(issue.values[0])}`;
        return `Ogiltigt val: förväntade en av ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `För stor(t): förväntade ${issue.origin ?? "värdet"} att ha ${adj}${issue.maximum.toString()} ${sizing.unit ?? "element"}`;
        }
        return `För stor(t): förväntat ${issue.origin ?? "värdet"} att ha ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `För lite(t): förväntade ${issue.origin ?? "värdet"} att ha ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `För lite(t): förväntade ${issue.origin ?? "värdet"} att ha ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `Ogiltig sträng: måste börja med "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Ogiltig sträng: måste sluta med "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ogiltig sträng: måste innehålla "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ogiltig sträng: måste matcha mönstret "${_issue.pattern}"`;
        return `Ogiltig(t) ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Ogiltigt tal: måste vara en multipel av ${issue.divisor}`;
      case "unrecognized_keys":
        return `${issue.keys.length > 1 ? "Okända nycklar" : "Okänd nyckel"}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Ogiltig nyckel i ${issue.origin ?? "värdet"}`;
      case "invalid_union":
        return "Ogiltig input";
      case "invalid_element":
        return `Ogiltigt värde i ${issue.origin ?? "värdet"}`;
      default:
        return `Ogiltig input`;
    }
  };
};
function sv_default() {
  return {
    localeError: error35()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/ta.js
var error36 = () => {
  const Sizable = {
    string: { unit: "எழுத்துக்கள்", verb: "கொண்டிருக்க வேண்டும்" },
    file: { unit: "பைட்டுகள்", verb: "கொண்டிருக்க வேண்டும்" },
    array: { unit: "உறுப்புகள்", verb: "கொண்டிருக்க வேண்டும்" },
    set: { unit: "உறுப்புகள்", verb: "கொண்டிருக்க வேண்டும்" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "எண் அல்லாதது" : "எண்";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "அணி";
        }
        if (data === null) {
          return "வெறுமை";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "உள்ளீடு",
    email: "மின்னஞ்சல் முகவரி",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO தேதி நேரம்",
    date: "ISO தேதி",
    time: "ISO நேரம்",
    duration: "ISO கால அளவு",
    ipv4: "IPv4 முகவரி",
    ipv6: "IPv6 முகவரி",
    cidrv4: "IPv4 வரம்பு",
    cidrv6: "IPv6 வரம்பு",
    base64: "base64-encoded சரம்",
    base64url: "base64url-encoded சரம்",
    json_string: "JSON சரம்",
    e164: "E.164 எண்",
    jwt: "JWT",
    template_literal: "input"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `தவறான உள்ளீடு: எதிர்பார்க்கப்பட்டது ${issue.expected}, பெறப்பட்டது ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `தவறான உள்ளீடு: எதிர்பார்க்கப்பட்டது ${stringifyPrimitive(issue.values[0])}`;
        return `தவறான விருப்பம்: எதிர்பார்க்கப்பட்டது ${joinValues(issue.values, "|")} இல் ஒன்று`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `மிக பெரியது: எதிர்பார்க்கப்பட்டது ${issue.origin ?? "மதிப்பு"} ${adj}${issue.maximum.toString()} ${sizing.unit ?? "உறுப்புகள்"} ஆக இருக்க வேண்டும்`;
        }
        return `மிக பெரியது: எதிர்பார்க்கப்பட்டது ${issue.origin ?? "மதிப்பு"} ${adj}${issue.maximum.toString()} ஆக இருக்க வேண்டும்`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `மிகச் சிறியது: எதிர்பார்க்கப்பட்டது ${issue.origin} ${adj}${issue.minimum.toString()} ${sizing.unit} ஆக இருக்க வேண்டும்`;
        }
        return `மிகச் சிறியது: எதிர்பார்க்கப்பட்டது ${issue.origin} ${adj}${issue.minimum.toString()} ஆக இருக்க வேண்டும்`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `தவறான சரம்: "${_issue.prefix}" இல் தொடங்க வேண்டும்`;
        if (_issue.format === "ends_with")
          return `தவறான சரம்: "${_issue.suffix}" இல் முடிவடைய வேண்டும்`;
        if (_issue.format === "includes")
          return `தவறான சரம்: "${_issue.includes}" ஐ உள்ளடக்க வேண்டும்`;
        if (_issue.format === "regex")
          return `தவறான சரம்: ${_issue.pattern} முறைபாட்டுடன் பொருந்த வேண்டும்`;
        return `தவறான ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `தவறான எண்: ${issue.divisor} இன் பலமாக இருக்க வேண்டும்`;
      case "unrecognized_keys":
        return `அடையாளம் தெரியாத விசை${issue.keys.length > 1 ? "கள்" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `${issue.origin} இல் தவறான விசை`;
      case "invalid_union":
        return "தவறான உள்ளீடு";
      case "invalid_element":
        return `${issue.origin} இல் தவறான மதிப்பு`;
      default:
        return `தவறான உள்ளீடு`;
    }
  };
};
function ta_default() {
  return {
    localeError: error36()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/th.js
var error37 = () => {
  const Sizable = {
    string: { unit: "ตัวอักษร", verb: "ควรมี" },
    file: { unit: "ไบต์", verb: "ควรมี" },
    array: { unit: "รายการ", verb: "ควรมี" },
    set: { unit: "รายการ", verb: "ควรมี" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "ไม่ใช่ตัวเลข (NaN)" : "ตัวเลข";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "อาร์เรย์ (Array)";
        }
        if (data === null) {
          return "ไม่มีค่า (null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ข้อมูลที่ป้อน",
    email: "ที่อยู่อีเมล",
    url: "URL",
    emoji: "อิโมจิ",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "วันที่เวลาแบบ ISO",
    date: "วันที่แบบ ISO",
    time: "เวลาแบบ ISO",
    duration: "ช่วงเวลาแบบ ISO",
    ipv4: "ที่อยู่ IPv4",
    ipv6: "ที่อยู่ IPv6",
    cidrv4: "ช่วง IP แบบ IPv4",
    cidrv6: "ช่วง IP แบบ IPv6",
    base64: "ข้อความแบบ Base64",
    base64url: "ข้อความแบบ Base64 สำหรับ URL",
    json_string: "ข้อความแบบ JSON",
    e164: "เบอร์โทรศัพท์ระหว่างประเทศ (E.164)",
    jwt: "โทเคน JWT",
    template_literal: "ข้อมูลที่ป้อน"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `ประเภทข้อมูลไม่ถูกต้อง: ควรเป็น ${issue.expected} แต่ได้รับ ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `ค่าไม่ถูกต้อง: ควรเป็น ${stringifyPrimitive(issue.values[0])}`;
        return `ตัวเลือกไม่ถูกต้อง: ควรเป็นหนึ่งใน ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "ไม่เกิน" : "น้อยกว่า";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `เกินกำหนด: ${issue.origin ?? "ค่า"} ควรมี${adj} ${issue.maximum.toString()} ${sizing.unit ?? "รายการ"}`;
        return `เกินกำหนด: ${issue.origin ?? "ค่า"} ควรมี${adj} ${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? "อย่างน้อย" : "มากกว่า";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `น้อยกว่ากำหนด: ${issue.origin} ควรมี${adj} ${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `น้อยกว่ากำหนด: ${issue.origin} ควรมี${adj} ${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `รูปแบบไม่ถูกต้อง: ข้อความต้องขึ้นต้นด้วย "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `รูปแบบไม่ถูกต้อง: ข้อความต้องลงท้ายด้วย "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `รูปแบบไม่ถูกต้อง: ข้อความต้องมี "${_issue.includes}" อยู่ในข้อความ`;
        if (_issue.format === "regex")
          return `รูปแบบไม่ถูกต้อง: ต้องตรงกับรูปแบบที่กำหนด ${_issue.pattern}`;
        return `รูปแบบไม่ถูกต้อง: ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `ตัวเลขไม่ถูกต้อง: ต้องเป็นจำนวนที่หารด้วย ${issue.divisor} ได้ลงตัว`;
      case "unrecognized_keys":
        return `พบคีย์ที่ไม่รู้จัก: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `คีย์ไม่ถูกต้องใน ${issue.origin}`;
      case "invalid_union":
        return "ข้อมูลไม่ถูกต้อง: ไม่ตรงกับรูปแบบยูเนียนที่กำหนดไว้";
      case "invalid_element":
        return `ข้อมูลไม่ถูกต้องใน ${issue.origin}`;
      default:
        return `ข้อมูลไม่ถูกต้อง`;
    }
  };
};
function th_default() {
  return {
    localeError: error37()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/tr.js
var parsedType6 = (data) => {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "NaN" : "number";
    }
    case "object": {
      if (Array.isArray(data)) {
        return "array";
      }
      if (data === null) {
        return "null";
      }
      if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
        return data.constructor.name;
      }
    }
  }
  return t;
};
var error38 = () => {
  const Sizable = {
    string: { unit: "karakter", verb: "olmalı" },
    file: { unit: "bayt", verb: "olmalı" },
    array: { unit: "öğe", verb: "olmalı" },
    set: { unit: "öğe", verb: "olmalı" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const Nouns = {
    regex: "girdi",
    email: "e-posta adresi",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO tarih ve saat",
    date: "ISO tarih",
    time: "ISO saat",
    duration: "ISO süre",
    ipv4: "IPv4 adresi",
    ipv6: "IPv6 adresi",
    cidrv4: "IPv4 aralığı",
    cidrv6: "IPv6 aralığı",
    base64: "base64 ile şifrelenmiş metin",
    base64url: "base64url ile şifrelenmiş metin",
    json_string: "JSON dizesi",
    e164: "E.164 sayısı",
    jwt: "JWT",
    template_literal: "Şablon dizesi"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Geçersiz değer: beklenen ${issue.expected}, alınan ${parsedType6(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Geçersiz değer: beklenen ${stringifyPrimitive(issue.values[0])}`;
        return `Geçersiz seçenek: aşağıdakilerden biri olmalı: ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Çok büyük: beklenen ${issue.origin ?? "değer"} ${adj}${issue.maximum.toString()} ${sizing.unit ?? "öğe"}`;
        return `Çok büyük: beklenen ${issue.origin ?? "değer"} ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Çok küçük: beklenen ${issue.origin} ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        return `Çok küçük: beklenen ${issue.origin} ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Geçersiz metin: "${_issue.prefix}" ile başlamalı`;
        if (_issue.format === "ends_with")
          return `Geçersiz metin: "${_issue.suffix}" ile bitmeli`;
        if (_issue.format === "includes")
          return `Geçersiz metin: "${_issue.includes}" içermeli`;
        if (_issue.format === "regex")
          return `Geçersiz metin: ${_issue.pattern} desenine uymalı`;
        return `Geçersiz ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Geçersiz sayı: ${issue.divisor} ile tam bölünebilmeli`;
      case "unrecognized_keys":
        return `Tanınmayan anahtar${issue.keys.length > 1 ? "lar" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `${issue.origin} içinde geçersiz anahtar`;
      case "invalid_union":
        return "Geçersiz değer";
      case "invalid_element":
        return `${issue.origin} içinde geçersiz değer`;
      default:
        return `Geçersiz değer`;
    }
  };
};
function tr_default() {
  return {
    localeError: error38()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/uk.js
var error39 = () => {
  const Sizable = {
    string: { unit: "символів", verb: "матиме" },
    file: { unit: "байтів", verb: "матиме" },
    array: { unit: "елементів", verb: "матиме" },
    set: { unit: "елементів", verb: "матиме" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "число";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "масив";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "вхідні дані",
    email: "адреса електронної пошти",
    url: "URL",
    emoji: "емодзі",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "дата та час ISO",
    date: "дата ISO",
    time: "час ISO",
    duration: "тривалість ISO",
    ipv4: "адреса IPv4",
    ipv6: "адреса IPv6",
    cidrv4: "діапазон IPv4",
    cidrv6: "діапазон IPv6",
    base64: "рядок у кодуванні base64",
    base64url: "рядок у кодуванні base64url",
    json_string: "рядок JSON",
    e164: "номер E.164",
    jwt: "JWT",
    template_literal: "вхідні дані"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Неправильні вхідні дані: очікується ${issue.expected}, отримано ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Неправильні вхідні дані: очікується ${stringifyPrimitive(issue.values[0])}`;
        return `Неправильна опція: очікується одне з ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Занадто велике: очікується, що ${issue.origin ?? "значення"} ${sizing.verb} ${adj}${issue.maximum.toString()} ${sizing.unit ?? "елементів"}`;
        return `Занадто велике: очікується, що ${issue.origin ?? "значення"} буде ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Занадто мале: очікується, що ${issue.origin} ${sizing.verb} ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Занадто мале: очікується, що ${issue.origin} буде ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Неправильний рядок: повинен починатися з "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Неправильний рядок: повинен закінчуватися на "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Неправильний рядок: повинен містити "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Неправильний рядок: повинен відповідати шаблону ${_issue.pattern}`;
        return `Неправильний ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Неправильне число: повинно бути кратним ${issue.divisor}`;
      case "unrecognized_keys":
        return `Нерозпізнаний ключ${issue.keys.length > 1 ? "і" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Неправильний ключ у ${issue.origin}`;
      case "invalid_union":
        return "Неправильні вхідні дані";
      case "invalid_element":
        return `Неправильне значення у ${issue.origin}`;
      default:
        return `Неправильні вхідні дані`;
    }
  };
};
function uk_default() {
  return {
    localeError: error39()
  };
}

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/ua.js
function ua_default() {
  return uk_default();
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/ur.js
var error40 = () => {
  const Sizable = {
    string: { unit: "حروف", verb: "ہونا" },
    file: { unit: "بائٹس", verb: "ہونا" },
    array: { unit: "آئٹمز", verb: "ہونا" },
    set: { unit: "آئٹمز", verb: "ہونا" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "نمبر";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "آرے";
        }
        if (data === null) {
          return "نل";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ان پٹ",
    email: "ای میل ایڈریس",
    url: "یو آر ایل",
    emoji: "ایموجی",
    uuid: "یو یو آئی ڈی",
    uuidv4: "یو یو آئی ڈی وی 4",
    uuidv6: "یو یو آئی ڈی وی 6",
    nanoid: "نینو آئی ڈی",
    guid: "جی یو آئی ڈی",
    cuid: "سی یو آئی ڈی",
    cuid2: "سی یو آئی ڈی 2",
    ulid: "یو ایل آئی ڈی",
    xid: "ایکس آئی ڈی",
    ksuid: "کے ایس یو آئی ڈی",
    datetime: "آئی ایس او ڈیٹ ٹائم",
    date: "آئی ایس او تاریخ",
    time: "آئی ایس او وقت",
    duration: "آئی ایس او مدت",
    ipv4: "آئی پی وی 4 ایڈریس",
    ipv6: "آئی پی وی 6 ایڈریس",
    cidrv4: "آئی پی وی 4 رینج",
    cidrv6: "آئی پی وی 6 رینج",
    base64: "بیس 64 ان کوڈڈ سٹرنگ",
    base64url: "بیس 64 یو آر ایل ان کوڈڈ سٹرنگ",
    json_string: "جے ایس او این سٹرنگ",
    e164: "ای 164 نمبر",
    jwt: "جے ڈبلیو ٹی",
    template_literal: "ان پٹ"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `غلط ان پٹ: ${issue.expected} متوقع تھا، ${parsedType(issue.input)} موصول ہوا`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `غلط ان پٹ: ${stringifyPrimitive(issue.values[0])} متوقع تھا`;
        return `غلط آپشن: ${joinValues(issue.values, "|")} میں سے ایک متوقع تھا`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `بہت بڑا: ${issue.origin ?? "ویلیو"} کے ${adj}${issue.maximum.toString()} ${sizing.unit ?? "عناصر"} ہونے متوقع تھے`;
        return `بہت بڑا: ${issue.origin ?? "ویلیو"} کا ${adj}${issue.maximum.toString()} ہونا متوقع تھا`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `بہت چھوٹا: ${issue.origin} کے ${adj}${issue.minimum.toString()} ${sizing.unit} ہونے متوقع تھے`;
        }
        return `بہت چھوٹا: ${issue.origin} کا ${adj}${issue.minimum.toString()} ہونا متوقع تھا`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `غلط سٹرنگ: "${_issue.prefix}" سے شروع ہونا چاہیے`;
        }
        if (_issue.format === "ends_with")
          return `غلط سٹرنگ: "${_issue.suffix}" پر ختم ہونا چاہیے`;
        if (_issue.format === "includes")
          return `غلط سٹرنگ: "${_issue.includes}" شامل ہونا چاہیے`;
        if (_issue.format === "regex")
          return `غلط سٹرنگ: پیٹرن ${_issue.pattern} سے میچ ہونا چاہیے`;
        return `غلط ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `غلط نمبر: ${issue.divisor} کا مضاعف ہونا چاہیے`;
      case "unrecognized_keys":
        return `غیر تسلیم شدہ کی${issue.keys.length > 1 ? "ز" : ""}: ${joinValues(issue.keys, "، ")}`;
      case "invalid_key":
        return `${issue.origin} میں غلط کی`;
      case "invalid_union":
        return "غلط ان پٹ";
      case "invalid_element":
        return `${issue.origin} میں غلط ویلیو`;
      default:
        return `غلط ان پٹ`;
    }
  };
};
function ur_default() {
  return {
    localeError: error40()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/vi.js
var error41 = () => {
  const Sizable = {
    string: { unit: "ký tự", verb: "có" },
    file: { unit: "byte", verb: "có" },
    array: { unit: "phần tử", verb: "có" },
    set: { unit: "phần tử", verb: "có" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "số";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "mảng";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "đầu vào",
    email: "địa chỉ email",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ngày giờ ISO",
    date: "ngày ISO",
    time: "giờ ISO",
    duration: "khoảng thời gian ISO",
    ipv4: "địa chỉ IPv4",
    ipv6: "địa chỉ IPv6",
    cidrv4: "dải IPv4",
    cidrv6: "dải IPv6",
    base64: "chuỗi mã hóa base64",
    base64url: "chuỗi mã hóa base64url",
    json_string: "chuỗi JSON",
    e164: "số E.164",
    jwt: "JWT",
    template_literal: "đầu vào"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Đầu vào không hợp lệ: mong đợi ${issue.expected}, nhận được ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Đầu vào không hợp lệ: mong đợi ${stringifyPrimitive(issue.values[0])}`;
        return `Tùy chọn không hợp lệ: mong đợi một trong các giá trị ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Quá lớn: mong đợi ${issue.origin ?? "giá trị"} ${sizing.verb} ${adj}${issue.maximum.toString()} ${sizing.unit ?? "phần tử"}`;
        return `Quá lớn: mong đợi ${issue.origin ?? "giá trị"} ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Quá nhỏ: mong đợi ${issue.origin} ${sizing.verb} ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Quá nhỏ: mong đợi ${issue.origin} ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Chuỗi không hợp lệ: phải bắt đầu bằng "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Chuỗi không hợp lệ: phải kết thúc bằng "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Chuỗi không hợp lệ: phải bao gồm "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Chuỗi không hợp lệ: phải khớp với mẫu ${_issue.pattern}`;
        return `${Nouns[_issue.format] ?? issue.format} không hợp lệ`;
      }
      case "not_multiple_of":
        return `Số không hợp lệ: phải là bội số của ${issue.divisor}`;
      case "unrecognized_keys":
        return `Khóa không được nhận dạng: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Khóa không hợp lệ trong ${issue.origin}`;
      case "invalid_union":
        return "Đầu vào không hợp lệ";
      case "invalid_element":
        return `Giá trị không hợp lệ trong ${issue.origin}`;
      default:
        return `Đầu vào không hợp lệ`;
    }
  };
};
function vi_default() {
  return {
    localeError: error41()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/zh-CN.js
var error42 = () => {
  const Sizable = {
    string: { unit: "字符", verb: "包含" },
    file: { unit: "字节", verb: "包含" },
    array: { unit: "项", verb: "包含" },
    set: { unit: "项", verb: "包含" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "非数字(NaN)" : "数字";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "数组";
        }
        if (data === null) {
          return "空值(null)";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "输入",
    email: "电子邮件",
    url: "URL",
    emoji: "表情符号",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO日期时间",
    date: "ISO日期",
    time: "ISO时间",
    duration: "ISO时长",
    ipv4: "IPv4地址",
    ipv6: "IPv6地址",
    cidrv4: "IPv4网段",
    cidrv6: "IPv6网段",
    base64: "base64编码字符串",
    base64url: "base64url编码字符串",
    json_string: "JSON字符串",
    e164: "E.164号码",
    jwt: "JWT",
    template_literal: "输入"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `无效输入：期望 ${issue.expected}，实际接收 ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `无效输入：期望 ${stringifyPrimitive(issue.values[0])}`;
        return `无效选项：期望以下之一 ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `数值过大：期望 ${issue.origin ?? "值"} ${adj}${issue.maximum.toString()} ${sizing.unit ?? "个元素"}`;
        return `数值过大：期望 ${issue.origin ?? "值"} ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `数值过小：期望 ${issue.origin} ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `数值过小：期望 ${issue.origin} ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `无效字符串：必须以 "${_issue.prefix}" 开头`;
        if (_issue.format === "ends_with")
          return `无效字符串：必须以 "${_issue.suffix}" 结尾`;
        if (_issue.format === "includes")
          return `无效字符串：必须包含 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `无效字符串：必须满足正则表达式 ${_issue.pattern}`;
        return `无效${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `无效数字：必须是 ${issue.divisor} 的倍数`;
      case "unrecognized_keys":
        return `出现未知的键(key): ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `${issue.origin} 中的键(key)无效`;
      case "invalid_union":
        return "无效输入";
      case "invalid_element":
        return `${issue.origin} 中包含无效值(value)`;
      default:
        return `无效输入`;
    }
  };
};
function zh_CN_default() {
  return {
    localeError: error42()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/zh-TW.js
var error43 = () => {
  const Sizable = {
    string: { unit: "字元", verb: "擁有" },
    file: { unit: "位元組", verb: "擁有" },
    array: { unit: "項目", verb: "擁有" },
    set: { unit: "項目", verb: "擁有" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "number";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "array";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "輸入",
    email: "郵件地址",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO 日期時間",
    date: "ISO 日期",
    time: "ISO 時間",
    duration: "ISO 期間",
    ipv4: "IPv4 位址",
    ipv6: "IPv6 位址",
    cidrv4: "IPv4 範圍",
    cidrv6: "IPv6 範圍",
    base64: "base64 編碼字串",
    base64url: "base64url 編碼字串",
    json_string: "JSON 字串",
    e164: "E.164 數值",
    jwt: "JWT",
    template_literal: "輸入"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `無效的輸入值：預期為 ${issue.expected}，但收到 ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `無效的輸入值：預期為 ${stringifyPrimitive(issue.values[0])}`;
        return `無效的選項：預期為以下其中之一 ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `數值過大：預期 ${issue.origin ?? "值"} 應為 ${adj}${issue.maximum.toString()} ${sizing.unit ?? "個元素"}`;
        return `數值過大：預期 ${issue.origin ?? "值"} 應為 ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `數值過小：預期 ${issue.origin} 應為 ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `數值過小：預期 ${issue.origin} 應為 ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `無效的字串：必須以 "${_issue.prefix}" 開頭`;
        }
        if (_issue.format === "ends_with")
          return `無效的字串：必須以 "${_issue.suffix}" 結尾`;
        if (_issue.format === "includes")
          return `無效的字串：必須包含 "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `無效的字串：必須符合格式 ${_issue.pattern}`;
        return `無效的 ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `無效的數字：必須為 ${issue.divisor} 的倍數`;
      case "unrecognized_keys":
        return `無法識別的鍵值${issue.keys.length > 1 ? "們" : ""}：${joinValues(issue.keys, "、")}`;
      case "invalid_key":
        return `${issue.origin} 中有無效的鍵值`;
      case "invalid_union":
        return "無效的輸入值";
      case "invalid_element":
        return `${issue.origin} 中有無效的值`;
      default:
        return `無效的輸入值`;
    }
  };
};
function zh_TW_default() {
  return {
    localeError: error43()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/locales/yo.js
var error44 = () => {
  const Sizable = {
    string: { unit: "àmi", verb: "ní" },
    file: { unit: "bytes", verb: "ní" },
    array: { unit: "nkan", verb: "ní" },
    set: { unit: "nkan", verb: "ní" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const parsedType = (data) => {
    const t = typeof data;
    switch (t) {
      case "number": {
        return Number.isNaN(data) ? "NaN" : "nọ́mbà";
      }
      case "object": {
        if (Array.isArray(data)) {
          return "akopọ";
        }
        if (data === null) {
          return "null";
        }
        if (Object.getPrototypeOf(data) !== Object.prototype && data.constructor) {
          return data.constructor.name;
        }
      }
    }
    return t;
  };
  const Nouns = {
    regex: "ẹ̀rọ ìbáwọlé",
    email: "àdírẹ́sì ìmẹ́lì",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "àkókò ISO",
    date: "ọjọ́ ISO",
    time: "àkókò ISO",
    duration: "àkókò tó pé ISO",
    ipv4: "àdírẹ́sì IPv4",
    ipv6: "àdírẹ́sì IPv6",
    cidrv4: "àgbègbè IPv4",
    cidrv6: "àgbègbè IPv6",
    base64: "ọ̀rọ̀ tí a kọ́ ní base64",
    base64url: "ọ̀rọ̀ base64url",
    json_string: "ọ̀rọ̀ JSON",
    e164: "nọ́mbà E.164",
    jwt: "JWT",
    template_literal: "ẹ̀rọ ìbáwọlé"
  };
  return (issue) => {
    switch (issue.code) {
      case "invalid_type":
        return `Ìbáwọlé aṣìṣe: a ní láti fi ${issue.expected}, àmọ̀ a rí ${parsedType(issue.input)}`;
      case "invalid_value":
        if (issue.values.length === 1)
          return `Ìbáwọlé aṣìṣe: a ní láti fi ${stringifyPrimitive(issue.values[0])}`;
        return `Àṣàyàn aṣìṣe: yan ọ̀kan lára ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Tó pọ̀ jù: a ní láti jẹ́ pé ${issue.origin ?? "iye"} ${sizing.verb} ${adj}${issue.maximum} ${sizing.unit}`;
        return `Tó pọ̀ jù: a ní láti jẹ́ ${adj}${issue.maximum}`;
      }
      case "too_small": {
        const adj = issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Kéré ju: a ní láti jẹ́ pé ${issue.origin} ${sizing.verb} ${adj}${issue.minimum} ${sizing.unit}`;
        return `Kéré ju: a ní láti jẹ́ ${adj}${issue.minimum}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with")
          return `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ bẹ̀rẹ̀ pẹ̀lú "${_issue.prefix}"`;
        if (_issue.format === "ends_with")
          return `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ parí pẹ̀lú "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ ní "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Ọ̀rọ̀ aṣìṣe: gbọ́dọ̀ bá àpẹẹrẹ mu ${_issue.pattern}`;
        return `Aṣìṣe: ${Nouns[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Nọ́mbà aṣìṣe: gbọ́dọ̀ jẹ́ èyà pípín ti ${issue.divisor}`;
      case "unrecognized_keys":
        return `Bọtìnì àìmọ̀: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Bọtìnì aṣìṣe nínú ${issue.origin}`;
      case "invalid_union":
        return "Ìbáwọlé aṣìṣe";
      case "invalid_element":
        return `Iye aṣìṣe nínú ${issue.origin}`;
      default:
        return "Ìbáwọlé aṣìṣe";
    }
  };
};
function yo_default() {
  return {
    localeError: error44()
  };
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/core/registries.js
var $output = Symbol("ZodOutput");
var $input = Symbol("ZodInput");

class $ZodRegistry {
  constructor() {
    this._map = new WeakMap;
    this._idmap = new Map;
  }
  add(schema, ..._meta) {
    const meta = _meta[0];
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta) {
      if (this._idmap.has(meta.id)) {
        throw new Error(`ID ${meta.id} already exists in the registry`);
      }
      this._idmap.set(meta.id, schema);
    }
    return this;
  }
  clear() {
    this._map = new WeakMap;
    this._idmap = new Map;
    return this;
  }
  remove(schema) {
    const meta = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.delete(meta.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = { ...this.get(p) ?? {} };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : undefined;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
}
function registry() {
  return new $ZodRegistry;
}
var globalRegistry = /* @__PURE__ */ registry();
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/core/api.js
function _string(Class, params) {
  return new Class({
    type: "string",
    ...normalizeParams(params)
  });
}
function _coercedString(Class, params) {
  return new Class({
    type: "string",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _email(Class, params) {
  return new Class({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _guid(Class, params) {
  return new Class({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuid(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuidv4(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
function _uuidv6(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
function _uuidv7(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
function _url(Class, params) {
  return new Class({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _emoji2(Class, params) {
  return new Class({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _nanoid(Class, params) {
  return new Class({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid(Class, params) {
  return new Class({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid2(Class, params) {
  return new Class({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ulid(Class, params) {
  return new Class({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _xid(Class, params) {
  return new Class({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ksuid(Class, params) {
  return new Class({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv4(Class, params) {
  return new Class({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv6(Class, params) {
  return new Class({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv4(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv6(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64(Class, params) {
  return new Class({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64url(Class, params) {
  return new Class({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _e164(Class, params) {
  return new Class({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _jwt(Class, params) {
  return new Class({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
var TimePrecision = {
  Any: null,
  Minute: -1,
  Second: 0,
  Millisecond: 3,
  Microsecond: 6
};
function _isoDateTime(Class, params) {
  return new Class({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDate(Class, params) {
  return new Class({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _isoTime(Class, params) {
  return new Class({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDuration(Class, params) {
  return new Class({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _number(Class, params) {
  return new Class({
    type: "number",
    checks: [],
    ...normalizeParams(params)
  });
}
function _coercedNumber(Class, params) {
  return new Class({
    type: "number",
    coerce: true,
    checks: [],
    ...normalizeParams(params)
  });
}
function _int(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
function _float32(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "float32",
    ...normalizeParams(params)
  });
}
function _float64(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "float64",
    ...normalizeParams(params)
  });
}
function _int32(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "int32",
    ...normalizeParams(params)
  });
}
function _uint32(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "uint32",
    ...normalizeParams(params)
  });
}
function _boolean(Class, params) {
  return new Class({
    type: "boolean",
    ...normalizeParams(params)
  });
}
function _coercedBoolean(Class, params) {
  return new Class({
    type: "boolean",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _bigint(Class, params) {
  return new Class({
    type: "bigint",
    ...normalizeParams(params)
  });
}
function _coercedBigint(Class, params) {
  return new Class({
    type: "bigint",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _int64(Class, params) {
  return new Class({
    type: "bigint",
    check: "bigint_format",
    abort: false,
    format: "int64",
    ...normalizeParams(params)
  });
}
function _uint64(Class, params) {
  return new Class({
    type: "bigint",
    check: "bigint_format",
    abort: false,
    format: "uint64",
    ...normalizeParams(params)
  });
}
function _symbol(Class, params) {
  return new Class({
    type: "symbol",
    ...normalizeParams(params)
  });
}
function _undefined2(Class, params) {
  return new Class({
    type: "undefined",
    ...normalizeParams(params)
  });
}
function _null2(Class, params) {
  return new Class({
    type: "null",
    ...normalizeParams(params)
  });
}
function _any(Class) {
  return new Class({
    type: "any"
  });
}
function _unknown(Class) {
  return new Class({
    type: "unknown"
  });
}
function _never(Class, params) {
  return new Class({
    type: "never",
    ...normalizeParams(params)
  });
}
function _void(Class, params) {
  return new Class({
    type: "void",
    ...normalizeParams(params)
  });
}
function _date(Class, params) {
  return new Class({
    type: "date",
    ...normalizeParams(params)
  });
}
function _coercedDate(Class, params) {
  return new Class({
    type: "date",
    coerce: true,
    ...normalizeParams(params)
  });
}
function _nan(Class, params) {
  return new Class({
    type: "nan",
    ...normalizeParams(params)
  });
}
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _positive(params) {
  return _gt(0, params);
}
function _negative(params) {
  return _lt(0, params);
}
function _nonpositive(params) {
  return _lte(0, params);
}
function _nonnegative(params) {
  return _gte(0, params);
}
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
function _maxSize(maximum, params) {
  return new $ZodCheckMaxSize({
    check: "max_size",
    ...normalizeParams(params),
    maximum
  });
}
function _minSize(minimum, params) {
  return new $ZodCheckMinSize({
    check: "min_size",
    ...normalizeParams(params),
    minimum
  });
}
function _size(size, params) {
  return new $ZodCheckSizeEquals({
    check: "size_equals",
    ...normalizeParams(params),
    size
  });
}
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
function _property(property, schema, params) {
  return new $ZodCheckProperty({
    check: "property",
    property,
    schema,
    ...normalizeParams(params)
  });
}
function _mime(types, params) {
  return new $ZodCheckMimeType({
    check: "mime_type",
    mime: types,
    ...normalizeParams(params)
  });
}
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
function _normalize(form) {
  return _overwrite((input) => input.normalize(form));
}
function _trim() {
  return _overwrite((input) => input.trim());
}
function _toLowerCase() {
  return _overwrite((input) => input.toLowerCase());
}
function _toUpperCase() {
  return _overwrite((input) => input.toUpperCase());
}
function _array(Class, element, params) {
  return new Class({
    type: "array",
    element,
    ...normalizeParams(params)
  });
}
function _union(Class, options, params) {
  return new Class({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
function _discriminatedUnion(Class, discriminator, options, params) {
  return new Class({
    type: "union",
    options,
    discriminator,
    ...normalizeParams(params)
  });
}
function _intersection(Class, left, right) {
  return new Class({
    type: "intersection",
    left,
    right
  });
}
function _tuple(Class, items, _paramsOrRest, _params) {
  const hasRest = _paramsOrRest instanceof $ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new Class({
    type: "tuple",
    items,
    rest,
    ...normalizeParams(params)
  });
}
function _record(Class, keyType, valueType, params) {
  return new Class({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
function _map(Class, keyType, valueType, params) {
  return new Class({
    type: "map",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
function _set(Class, valueType, params) {
  return new Class({
    type: "set",
    valueType,
    ...normalizeParams(params)
  });
}
function _enum(Class, values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new Class({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
function _nativeEnum(Class, entries, params) {
  return new Class({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
function _literal(Class, value, params) {
  return new Class({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
function _file(Class, params) {
  return new Class({
    type: "file",
    ...normalizeParams(params)
  });
}
function _transform(Class, fn) {
  return new Class({
    type: "transform",
    transform: fn
  });
}
function _optional(Class, innerType) {
  return new Class({
    type: "optional",
    innerType
  });
}
function _nullable(Class, innerType) {
  return new Class({
    type: "nullable",
    innerType
  });
}
function _default(Class, innerType, defaultValue) {
  return new Class({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
function _nonoptional(Class, innerType, params) {
  return new Class({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
function _success(Class, innerType) {
  return new Class({
    type: "success",
    innerType
  });
}
function _catch(Class, innerType, catchValue) {
  return new Class({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
function _pipe(Class, in_, out) {
  return new Class({
    type: "pipe",
    in: in_,
    out
  });
}
function _readonly(Class, innerType) {
  return new Class({
    type: "readonly",
    innerType
  });
}
function _templateLiteral(Class, parts, params) {
  return new Class({
    type: "template_literal",
    parts,
    ...normalizeParams(params)
  });
}
function _lazy(Class, getter) {
  return new Class({
    type: "lazy",
    getter
  });
}
function _promise(Class, innerType) {
  return new Class({
    type: "promise",
    innerType
  });
}
function _custom(Class, fn, _params) {
  const norm = normalizeParams(_params);
  norm.abort ?? (norm.abort = true);
  const schema = new Class({
    type: "custom",
    check: "custom",
    fn,
    ...norm
  });
  return schema;
}
function _refine(Class, fn, _params) {
  const schema = new Class({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
function _superRefine(fn) {
  const ch = _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  });
  return ch;
}
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
function _stringbool(Classes, _params) {
  const params = normalizeParams(_params);
  let truthyArray = params.truthy ?? ["true", "1", "yes", "on", "y", "enabled"];
  let falsyArray = params.falsy ?? ["false", "0", "no", "off", "n", "disabled"];
  if (params.case !== "sensitive") {
    truthyArray = truthyArray.map((v) => typeof v === "string" ? v.toLowerCase() : v);
    falsyArray = falsyArray.map((v) => typeof v === "string" ? v.toLowerCase() : v);
  }
  const truthySet = new Set(truthyArray);
  const falsySet = new Set(falsyArray);
  const _Codec = Classes.Codec ?? $ZodCodec;
  const _Boolean = Classes.Boolean ?? $ZodBoolean;
  const _String = Classes.String ?? $ZodString;
  const stringSchema = new _String({ type: "string", error: params.error });
  const booleanSchema = new _Boolean({ type: "boolean", error: params.error });
  const codec = new _Codec({
    type: "pipe",
    in: stringSchema,
    out: booleanSchema,
    transform: (input, payload) => {
      let data = input;
      if (params.case !== "sensitive")
        data = data.toLowerCase();
      if (truthySet.has(data)) {
        return true;
      } else if (falsySet.has(data)) {
        return false;
      } else {
        payload.issues.push({
          code: "invalid_value",
          expected: "stringbool",
          values: [...truthySet, ...falsySet],
          input: payload.value,
          inst: codec,
          continue: false
        });
        return {};
      }
    },
    reverseTransform: (input, _payload) => {
      if (input === true) {
        return truthyArray[0] || "true";
      } else {
        return falsyArray[0] || "false";
      }
    },
    error: params.error
  });
  return codec;
}
function _stringFormat(Class, format, fnOrRegex, _params = {}) {
  const params = normalizeParams(_params);
  const def = {
    ...normalizeParams(_params),
    check: "string_format",
    type: "string",
    format,
    fn: typeof fnOrRegex === "function" ? fnOrRegex : (val) => fnOrRegex.test(val),
    ...params
  };
  if (fnOrRegex instanceof RegExp) {
    def.pattern = fnOrRegex;
  }
  const inst = new Class(def);
  return inst;
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/core/to-json-schema.js
class JSONSchemaGenerator {
  constructor(params) {
    this.counter = 0;
    this.metadataRegistry = params?.metadata ?? globalRegistry;
    this.target = params?.target ?? "draft-2020-12";
    this.unrepresentable = params?.unrepresentable ?? "throw";
    this.override = params?.override ?? (() => {});
    this.io = params?.io ?? "output";
    this.seen = new Map;
  }
  process(schema, _params = { path: [], schemaPath: [] }) {
    var _a;
    const def = schema._zod.def;
    const formatMap = {
      guid: "uuid",
      url: "uri",
      datetime: "date-time",
      json_string: "json-string",
      regex: ""
    };
    const seen = this.seen.get(schema);
    if (seen) {
      seen.count++;
      const isCycle = _params.schemaPath.includes(schema);
      if (isCycle) {
        seen.cycle = _params.path;
      }
      return seen.schema;
    }
    const result = { schema: {}, count: 1, cycle: undefined, path: _params.path };
    this.seen.set(schema, result);
    const overrideSchema = schema._zod.toJSONSchema?.();
    if (overrideSchema) {
      result.schema = overrideSchema;
    } else {
      const params = {
        ..._params,
        schemaPath: [..._params.schemaPath, schema],
        path: _params.path
      };
      const parent = schema._zod.parent;
      if (parent) {
        result.ref = parent;
        this.process(parent, params);
        this.seen.get(parent).isParent = true;
      } else {
        const _json = result.schema;
        switch (def.type) {
          case "string": {
            const json = _json;
            json.type = "string";
            const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
            if (typeof minimum === "number")
              json.minLength = minimum;
            if (typeof maximum === "number")
              json.maxLength = maximum;
            if (format) {
              json.format = formatMap[format] ?? format;
              if (json.format === "")
                delete json.format;
            }
            if (contentEncoding)
              json.contentEncoding = contentEncoding;
            if (patterns && patterns.size > 0) {
              const regexes = [...patterns];
              if (regexes.length === 1)
                json.pattern = regexes[0].source;
              else if (regexes.length > 1) {
                result.schema.allOf = [
                  ...regexes.map((regex) => ({
                    ...this.target === "draft-7" || this.target === "draft-4" || this.target === "openapi-3.0" ? { type: "string" } : {},
                    pattern: regex.source
                  }))
                ];
              }
            }
            break;
          }
          case "number": {
            const json = _json;
            const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
            if (typeof format === "string" && format.includes("int"))
              json.type = "integer";
            else
              json.type = "number";
            if (typeof exclusiveMinimum === "number") {
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json.minimum = exclusiveMinimum;
                json.exclusiveMinimum = true;
              } else {
                json.exclusiveMinimum = exclusiveMinimum;
              }
            }
            if (typeof minimum === "number") {
              json.minimum = minimum;
              if (typeof exclusiveMinimum === "number" && this.target !== "draft-4") {
                if (exclusiveMinimum >= minimum)
                  delete json.minimum;
                else
                  delete json.exclusiveMinimum;
              }
            }
            if (typeof exclusiveMaximum === "number") {
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json.maximum = exclusiveMaximum;
                json.exclusiveMaximum = true;
              } else {
                json.exclusiveMaximum = exclusiveMaximum;
              }
            }
            if (typeof maximum === "number") {
              json.maximum = maximum;
              if (typeof exclusiveMaximum === "number" && this.target !== "draft-4") {
                if (exclusiveMaximum <= maximum)
                  delete json.maximum;
                else
                  delete json.exclusiveMaximum;
              }
            }
            if (typeof multipleOf === "number")
              json.multipleOf = multipleOf;
            break;
          }
          case "boolean": {
            const json = _json;
            json.type = "boolean";
            break;
          }
          case "bigint": {
            if (this.unrepresentable === "throw") {
              throw new Error("BigInt cannot be represented in JSON Schema");
            }
            break;
          }
          case "symbol": {
            if (this.unrepresentable === "throw") {
              throw new Error("Symbols cannot be represented in JSON Schema");
            }
            break;
          }
          case "null": {
            if (this.target === "openapi-3.0") {
              _json.type = "string";
              _json.nullable = true;
              _json.enum = [null];
            } else
              _json.type = "null";
            break;
          }
          case "any": {
            break;
          }
          case "unknown": {
            break;
          }
          case "undefined": {
            if (this.unrepresentable === "throw") {
              throw new Error("Undefined cannot be represented in JSON Schema");
            }
            break;
          }
          case "void": {
            if (this.unrepresentable === "throw") {
              throw new Error("Void cannot be represented in JSON Schema");
            }
            break;
          }
          case "never": {
            _json.not = {};
            break;
          }
          case "date": {
            if (this.unrepresentable === "throw") {
              throw new Error("Date cannot be represented in JSON Schema");
            }
            break;
          }
          case "array": {
            const json = _json;
            const { minimum, maximum } = schema._zod.bag;
            if (typeof minimum === "number")
              json.minItems = minimum;
            if (typeof maximum === "number")
              json.maxItems = maximum;
            json.type = "array";
            json.items = this.process(def.element, { ...params, path: [...params.path, "items"] });
            break;
          }
          case "object": {
            const json = _json;
            json.type = "object";
            json.properties = {};
            const shape = def.shape;
            for (const key in shape) {
              json.properties[key] = this.process(shape[key], {
                ...params,
                path: [...params.path, "properties", key]
              });
            }
            const allKeys = new Set(Object.keys(shape));
            const requiredKeys = new Set([...allKeys].filter((key) => {
              const v = def.shape[key]._zod;
              if (this.io === "input") {
                return v.optin === undefined;
              } else {
                return v.optout === undefined;
              }
            }));
            if (requiredKeys.size > 0) {
              json.required = Array.from(requiredKeys);
            }
            if (def.catchall?._zod.def.type === "never") {
              json.additionalProperties = false;
            } else if (!def.catchall) {
              if (this.io === "output")
                json.additionalProperties = false;
            } else if (def.catchall) {
              json.additionalProperties = this.process(def.catchall, {
                ...params,
                path: [...params.path, "additionalProperties"]
              });
            }
            break;
          }
          case "union": {
            const json = _json;
            const options = def.options.map((x, i) => this.process(x, {
              ...params,
              path: [...params.path, "anyOf", i]
            }));
            json.anyOf = options;
            break;
          }
          case "intersection": {
            const json = _json;
            const a = this.process(def.left, {
              ...params,
              path: [...params.path, "allOf", 0]
            });
            const b = this.process(def.right, {
              ...params,
              path: [...params.path, "allOf", 1]
            });
            const isSimpleIntersection = (val) => ("allOf" in val) && Object.keys(val).length === 1;
            const allOf = [
              ...isSimpleIntersection(a) ? a.allOf : [a],
              ...isSimpleIntersection(b) ? b.allOf : [b]
            ];
            json.allOf = allOf;
            break;
          }
          case "tuple": {
            const json = _json;
            json.type = "array";
            const prefixPath = this.target === "draft-2020-12" ? "prefixItems" : "items";
            const restPath = this.target === "draft-2020-12" ? "items" : this.target === "openapi-3.0" ? "items" : "additionalItems";
            const prefixItems = def.items.map((x, i) => this.process(x, {
              ...params,
              path: [...params.path, prefixPath, i]
            }));
            const rest = def.rest ? this.process(def.rest, {
              ...params,
              path: [...params.path, restPath, ...this.target === "openapi-3.0" ? [def.items.length] : []]
            }) : null;
            if (this.target === "draft-2020-12") {
              json.prefixItems = prefixItems;
              if (rest) {
                json.items = rest;
              }
            } else if (this.target === "openapi-3.0") {
              json.items = {
                anyOf: prefixItems
              };
              if (rest) {
                json.items.anyOf.push(rest);
              }
              json.minItems = prefixItems.length;
              if (!rest) {
                json.maxItems = prefixItems.length;
              }
            } else {
              json.items = prefixItems;
              if (rest) {
                json.additionalItems = rest;
              }
            }
            const { minimum, maximum } = schema._zod.bag;
            if (typeof minimum === "number")
              json.minItems = minimum;
            if (typeof maximum === "number")
              json.maxItems = maximum;
            break;
          }
          case "record": {
            const json = _json;
            json.type = "object";
            if (this.target === "draft-7" || this.target === "draft-2020-12") {
              json.propertyNames = this.process(def.keyType, {
                ...params,
                path: [...params.path, "propertyNames"]
              });
            }
            json.additionalProperties = this.process(def.valueType, {
              ...params,
              path: [...params.path, "additionalProperties"]
            });
            break;
          }
          case "map": {
            if (this.unrepresentable === "throw") {
              throw new Error("Map cannot be represented in JSON Schema");
            }
            break;
          }
          case "set": {
            if (this.unrepresentable === "throw") {
              throw new Error("Set cannot be represented in JSON Schema");
            }
            break;
          }
          case "enum": {
            const json = _json;
            const values = getEnumValues(def.entries);
            if (values.every((v) => typeof v === "number"))
              json.type = "number";
            if (values.every((v) => typeof v === "string"))
              json.type = "string";
            json.enum = values;
            break;
          }
          case "literal": {
            const json = _json;
            const vals = [];
            for (const val of def.values) {
              if (val === undefined) {
                if (this.unrepresentable === "throw") {
                  throw new Error("Literal `undefined` cannot be represented in JSON Schema");
                }
              } else if (typeof val === "bigint") {
                if (this.unrepresentable === "throw") {
                  throw new Error("BigInt literals cannot be represented in JSON Schema");
                } else {
                  vals.push(Number(val));
                }
              } else {
                vals.push(val);
              }
            }
            if (vals.length === 0) {} else if (vals.length === 1) {
              const val = vals[0];
              json.type = val === null ? "null" : typeof val;
              if (this.target === "draft-4" || this.target === "openapi-3.0") {
                json.enum = [val];
              } else {
                json.const = val;
              }
            } else {
              if (vals.every((v) => typeof v === "number"))
                json.type = "number";
              if (vals.every((v) => typeof v === "string"))
                json.type = "string";
              if (vals.every((v) => typeof v === "boolean"))
                json.type = "string";
              if (vals.every((v) => v === null))
                json.type = "null";
              json.enum = vals;
            }
            break;
          }
          case "file": {
            const json = _json;
            const file = {
              type: "string",
              format: "binary",
              contentEncoding: "binary"
            };
            const { minimum, maximum, mime } = schema._zod.bag;
            if (minimum !== undefined)
              file.minLength = minimum;
            if (maximum !== undefined)
              file.maxLength = maximum;
            if (mime) {
              if (mime.length === 1) {
                file.contentMediaType = mime[0];
                Object.assign(json, file);
              } else {
                json.anyOf = mime.map((m) => {
                  const mFile = { ...file, contentMediaType: m };
                  return mFile;
                });
              }
            } else {
              Object.assign(json, file);
            }
            break;
          }
          case "transform": {
            if (this.unrepresentable === "throw") {
              throw new Error("Transforms cannot be represented in JSON Schema");
            }
            break;
          }
          case "nullable": {
            const inner = this.process(def.innerType, params);
            if (this.target === "openapi-3.0") {
              result.ref = def.innerType;
              _json.nullable = true;
            } else {
              _json.anyOf = [inner, { type: "null" }];
            }
            break;
          }
          case "nonoptional": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "success": {
            const json = _json;
            json.type = "boolean";
            break;
          }
          case "default": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            _json.default = JSON.parse(JSON.stringify(def.defaultValue));
            break;
          }
          case "prefault": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            if (this.io === "input")
              _json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
            break;
          }
          case "catch": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            let catchValue;
            try {
              catchValue = def.catchValue(undefined);
            } catch {
              throw new Error("Dynamic catch values are not supported in JSON Schema");
            }
            _json.default = catchValue;
            break;
          }
          case "nan": {
            if (this.unrepresentable === "throw") {
              throw new Error("NaN cannot be represented in JSON Schema");
            }
            break;
          }
          case "template_literal": {
            const json = _json;
            const pattern = schema._zod.pattern;
            if (!pattern)
              throw new Error("Pattern not found in template literal");
            json.type = "string";
            json.pattern = pattern.source;
            break;
          }
          case "pipe": {
            const innerType = this.io === "input" ? def.in._zod.def.type === "transform" ? def.out : def.in : def.out;
            this.process(innerType, params);
            result.ref = innerType;
            break;
          }
          case "readonly": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            _json.readOnly = true;
            break;
          }
          case "promise": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "optional": {
            this.process(def.innerType, params);
            result.ref = def.innerType;
            break;
          }
          case "lazy": {
            const innerType = schema._zod.innerType;
            this.process(innerType, params);
            result.ref = innerType;
            break;
          }
          case "custom": {
            if (this.unrepresentable === "throw") {
              throw new Error("Custom types cannot be represented in JSON Schema");
            }
            break;
          }
          case "function": {
            if (this.unrepresentable === "throw") {
              throw new Error("Function types cannot be represented in JSON Schema");
            }
            break;
          }
          default: {}
        }
      }
    }
    const meta = this.metadataRegistry.get(schema);
    if (meta)
      Object.assign(result.schema, meta);
    if (this.io === "input" && isTransforming(schema)) {
      delete result.schema.examples;
      delete result.schema.default;
    }
    if (this.io === "input" && result.schema._prefault)
      (_a = result.schema).default ?? (_a.default = result.schema._prefault);
    delete result.schema._prefault;
    const _result = this.seen.get(schema);
    return _result.schema;
  }
  emit(schema, _params) {
    const params = {
      cycles: _params?.cycles ?? "ref",
      reused: _params?.reused ?? "inline",
      external: _params?.external ?? undefined
    };
    const root = this.seen.get(schema);
    if (!root)
      throw new Error("Unprocessed schema. This is a bug in Zod.");
    const makeURI = (entry) => {
      const defsSegment = this.target === "draft-2020-12" ? "$defs" : "definitions";
      if (params.external) {
        const externalId = params.external.registry.get(entry[0])?.id;
        const uriGenerator = params.external.uri ?? ((id) => id);
        if (externalId) {
          return { ref: uriGenerator(externalId) };
        }
        const id = entry[1].defId ?? entry[1].schema.id ?? `schema${this.counter++}`;
        entry[1].defId = id;
        return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}` };
      }
      if (entry[1] === root) {
        return { ref: "#" };
      }
      const uriPrefix = `#`;
      const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
      const defId = entry[1].schema.id ?? `__schema${this.counter++}`;
      return { defId, ref: defUriPrefix + defId };
    };
    const extractToDef = (entry) => {
      if (entry[1].schema.$ref) {
        return;
      }
      const seen = entry[1];
      const { ref, defId } = makeURI(entry);
      seen.def = { ...seen.schema };
      if (defId)
        seen.defId = defId;
      const schema = seen.schema;
      for (const key in schema) {
        delete schema[key];
      }
      schema.$ref = ref;
    };
    if (params.cycles === "throw") {
      for (const entry of this.seen.entries()) {
        const seen = entry[1];
        if (seen.cycle) {
          throw new Error("Cycle detected: " + `#/${seen.cycle?.join("/")}/<root>` + '\n\nSet the `cycles` parameter to `"ref"` to resolve cyclical schemas with defs.');
        }
      }
    }
    for (const entry of this.seen.entries()) {
      const seen = entry[1];
      if (schema === entry[0]) {
        extractToDef(entry);
        continue;
      }
      if (params.external) {
        const ext = params.external.registry.get(entry[0])?.id;
        if (schema !== entry[0] && ext) {
          extractToDef(entry);
          continue;
        }
      }
      const id = this.metadataRegistry.get(entry[0])?.id;
      if (id) {
        extractToDef(entry);
        continue;
      }
      if (seen.cycle) {
        extractToDef(entry);
        continue;
      }
      if (seen.count > 1) {
        if (params.reused === "ref") {
          extractToDef(entry);
          continue;
        }
      }
    }
    const flattenRef = (zodSchema, params) => {
      const seen = this.seen.get(zodSchema);
      const schema = seen.def ?? seen.schema;
      const _cached = { ...schema };
      if (seen.ref === null) {
        return;
      }
      const ref = seen.ref;
      seen.ref = null;
      if (ref) {
        flattenRef(ref, params);
        const refSchema = this.seen.get(ref).schema;
        if (refSchema.$ref && (params.target === "draft-7" || params.target === "draft-4" || params.target === "openapi-3.0")) {
          schema.allOf = schema.allOf ?? [];
          schema.allOf.push(refSchema);
        } else {
          Object.assign(schema, refSchema);
          Object.assign(schema, _cached);
        }
      }
      if (!seen.isParent)
        this.override({
          zodSchema,
          jsonSchema: schema,
          path: seen.path ?? []
        });
    };
    for (const entry of [...this.seen.entries()].reverse()) {
      flattenRef(entry[0], { target: this.target });
    }
    const result = {};
    if (this.target === "draft-2020-12") {
      result.$schema = "https://json-schema.org/draft/2020-12/schema";
    } else if (this.target === "draft-7") {
      result.$schema = "http://json-schema.org/draft-07/schema#";
    } else if (this.target === "draft-4") {
      result.$schema = "http://json-schema.org/draft-04/schema#";
    } else if (this.target === "openapi-3.0") {} else {
      console.warn(`Invalid target: ${this.target}`);
    }
    if (params.external?.uri) {
      const id = params.external.registry.get(schema)?.id;
      if (!id)
        throw new Error("Schema is missing an `id` property");
      result.$id = params.external.uri(id);
    }
    Object.assign(result, root.def);
    const defs = params.external?.defs ?? {};
    for (const entry of this.seen.entries()) {
      const seen = entry[1];
      if (seen.def && seen.defId) {
        defs[seen.defId] = seen.def;
      }
    }
    if (params.external) {} else {
      if (Object.keys(defs).length > 0) {
        if (this.target === "draft-2020-12") {
          result.$defs = defs;
        } else {
          result.definitions = defs;
        }
      }
    }
    try {
      return JSON.parse(JSON.stringify(result));
    } catch (_err) {
      throw new Error("Error converting schema to JSON.");
    }
  }
}
function toJSONSchema(input, _params) {
  if (input instanceof $ZodRegistry) {
    const gen = new JSONSchemaGenerator(_params);
    const defs = {};
    for (const entry of input._idmap.entries()) {
      const [_, schema] = entry;
      gen.process(schema);
    }
    const schemas = {};
    const external = {
      registry: input,
      uri: _params?.uri,
      defs
    };
    for (const entry of input._idmap.entries()) {
      const [key, schema] = entry;
      schemas[key] = gen.emit(schema, {
        ..._params,
        external
      });
    }
    if (Object.keys(defs).length > 0) {
      const defsSegment = gen.target === "draft-2020-12" ? "$defs" : "definitions";
      schemas.__shared = {
        [defsSegment]: defs
      };
    }
    return { schemas };
  }
  const gen = new JSONSchemaGenerator(_params);
  gen.process(input);
  return gen.emit(input, _params);
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: new Set };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const schema = _schema;
  const def = schema._zod.def;
  switch (def.type) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
    case "date":
    case "symbol":
    case "undefined":
    case "null":
    case "any":
    case "unknown":
    case "never":
    case "void":
    case "literal":
    case "enum":
    case "nan":
    case "file":
    case "template_literal":
      return false;
    case "array": {
      return isTransforming(def.element, ctx);
    }
    case "object": {
      for (const key in def.shape) {
        if (isTransforming(def.shape[key], ctx))
          return true;
      }
      return false;
    }
    case "union": {
      for (const option of def.options) {
        if (isTransforming(option, ctx))
          return true;
      }
      return false;
    }
    case "intersection": {
      return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
    }
    case "tuple": {
      for (const item of def.items) {
        if (isTransforming(item, ctx))
          return true;
      }
      if (def.rest && isTransforming(def.rest, ctx))
        return true;
      return false;
    }
    case "record": {
      return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
    }
    case "map": {
      return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
    }
    case "set": {
      return isTransforming(def.valueType, ctx);
    }
    case "promise":
    case "optional":
    case "nonoptional":
    case "nullable":
    case "readonly":
      return isTransforming(def.innerType, ctx);
    case "lazy":
      return isTransforming(def.getter(), ctx);
    case "default": {
      return isTransforming(def.innerType, ctx);
    }
    case "prefault": {
      return isTransforming(def.innerType, ctx);
    }
    case "custom": {
      return false;
    }
    case "transform": {
      return true;
    }
    case "pipe": {
      return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
    }
    case "success": {
      return false;
    }
    case "catch": {
      return false;
    }
    case "function": {
      return false;
    }
    default:
  }
  throw new Error(`Unknown schema type: ${def.type}`);
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/core/json-schema.js
var exports_json_schema = {};
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/classic/iso.js
var exports_iso = {};
__export(exports_iso, {
  ZodISODate: () => ZodISODate,
  ZodISODateTime: () => ZodISODateTime,
  ZodISODuration: () => ZodISODuration,
  ZodISOTime: () => ZodISOTime,
  date: () => date2,
  datetime: () => datetime2,
  duration: () => duration2,
  time: () => time2
});
var ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function datetime2(params) {
  return _isoDateTime(ZodISODateTime, params);
}
var ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function date2(params) {
  return _isoDate(ZodISODate, params);
}
var ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function time2(params) {
  return _isoTime(ZodISOTime, params);
}
var ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function duration2(params) {
  return _isoDuration(ZodISODuration, params);
}

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/classic/errors.js
var initializer2 = (inst, issues) => {
  $ZodError.init(inst, issues);
  inst.name = "ZodError";
  Object.defineProperties(inst, {
    format: {
      value: (mapper) => formatError(inst, mapper)
    },
    flatten: {
      value: (mapper) => flattenError(inst, mapper)
    },
    addIssue: {
      value: (issue) => {
        inst.issues.push(issue);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
    },
    addIssues: {
      value: (issues) => {
        inst.issues.push(...issues);
        inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
      }
    },
    isEmpty: {
      get() {
        return inst.issues.length === 0;
      }
    }
  });
};
var ZodError = $constructor("ZodError", initializer2);
var ZodRealError = $constructor("ZodError", initializer2, {
  Parent: Error
});

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/classic/parse.js
var parse3 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync2 = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse2 = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync2 = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode2 = /* @__PURE__ */ _encode(ZodRealError);
var decode2 = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync2 = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync2 = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode2 = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode2 = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync2 = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync2 = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/classic/schemas.js
var ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
  $ZodType.init(inst, def);
  inst.def = def;
  inst.type = def.type;
  Object.defineProperty(inst, "_def", { value: def });
  inst.check = (...checks) => {
    return inst.clone({
      ...def,
      checks: [
        ...def.checks ?? [],
        ...checks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
      ]
    });
  };
  inst.clone = (def, params) => clone(inst, def, params);
  inst.brand = () => inst;
  inst.register = (reg, meta) => {
    reg.add(inst, meta);
    return inst;
  };
  inst.parse = (data, params) => parse3(inst, data, params, { callee: inst.parse });
  inst.safeParse = (data, params) => safeParse2(inst, data, params);
  inst.parseAsync = async (data, params) => parseAsync2(inst, data, params, { callee: inst.parseAsync });
  inst.safeParseAsync = async (data, params) => safeParseAsync2(inst, data, params);
  inst.spa = inst.safeParseAsync;
  inst.encode = (data, params) => encode2(inst, data, params);
  inst.decode = (data, params) => decode2(inst, data, params);
  inst.encodeAsync = async (data, params) => encodeAsync2(inst, data, params);
  inst.decodeAsync = async (data, params) => decodeAsync2(inst, data, params);
  inst.safeEncode = (data, params) => safeEncode2(inst, data, params);
  inst.safeDecode = (data, params) => safeDecode2(inst, data, params);
  inst.safeEncodeAsync = async (data, params) => safeEncodeAsync2(inst, data, params);
  inst.safeDecodeAsync = async (data, params) => safeDecodeAsync2(inst, data, params);
  inst.refine = (check, params) => inst.check(refine(check, params));
  inst.superRefine = (refinement) => inst.check(superRefine(refinement));
  inst.overwrite = (fn) => inst.check(_overwrite(fn));
  inst.optional = () => optional(inst);
  inst.nullable = () => nullable(inst);
  inst.nullish = () => optional(nullable(inst));
  inst.nonoptional = (params) => nonoptional(inst, params);
  inst.array = () => array(inst);
  inst.or = (arg) => union([inst, arg]);
  inst.and = (arg) => intersection(inst, arg);
  inst.transform = (tx) => pipe(inst, transform(tx));
  inst.default = (def) => _default2(inst, def);
  inst.prefault = (def) => prefault(inst, def);
  inst.catch = (params) => _catch2(inst, params);
  inst.pipe = (target) => pipe(inst, target);
  inst.readonly = () => readonly(inst);
  inst.describe = (description) => {
    const cl = inst.clone();
    globalRegistry.add(cl, { description });
    return cl;
  };
  Object.defineProperty(inst, "description", {
    get() {
      return globalRegistry.get(inst)?.description;
    },
    configurable: true
  });
  inst.meta = (...args) => {
    if (args.length === 0) {
      return globalRegistry.get(inst);
    }
    const cl = inst.clone();
    globalRegistry.add(cl, args[0]);
    return cl;
  };
  inst.isOptional = () => inst.safeParse(undefined).success;
  inst.isNullable = () => inst.safeParse(null).success;
  return inst;
});
var _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodType.init(inst, def);
  const bag = inst._zod.bag;
  inst.format = bag.format ?? null;
  inst.minLength = bag.minimum ?? null;
  inst.maxLength = bag.maximum ?? null;
  inst.regex = (...args) => inst.check(_regex(...args));
  inst.includes = (...args) => inst.check(_includes(...args));
  inst.startsWith = (...args) => inst.check(_startsWith(...args));
  inst.endsWith = (...args) => inst.check(_endsWith(...args));
  inst.min = (...args) => inst.check(_minLength(...args));
  inst.max = (...args) => inst.check(_maxLength(...args));
  inst.length = (...args) => inst.check(_length(...args));
  inst.nonempty = (...args) => inst.check(_minLength(1, ...args));
  inst.lowercase = (params) => inst.check(_lowercase(params));
  inst.uppercase = (params) => inst.check(_uppercase(params));
  inst.trim = () => inst.check(_trim());
  inst.normalize = (...args) => inst.check(_normalize(...args));
  inst.toLowerCase = () => inst.check(_toLowerCase());
  inst.toUpperCase = () => inst.check(_toUpperCase());
});
var ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  _ZodString.init(inst, def);
  inst.email = (params) => inst.check(_email(ZodEmail, params));
  inst.url = (params) => inst.check(_url(ZodURL, params));
  inst.jwt = (params) => inst.check(_jwt(ZodJWT, params));
  inst.emoji = (params) => inst.check(_emoji2(ZodEmoji, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.uuid = (params) => inst.check(_uuid(ZodUUID, params));
  inst.uuidv4 = (params) => inst.check(_uuidv4(ZodUUID, params));
  inst.uuidv6 = (params) => inst.check(_uuidv6(ZodUUID, params));
  inst.uuidv7 = (params) => inst.check(_uuidv7(ZodUUID, params));
  inst.nanoid = (params) => inst.check(_nanoid(ZodNanoID, params));
  inst.guid = (params) => inst.check(_guid(ZodGUID, params));
  inst.cuid = (params) => inst.check(_cuid(ZodCUID, params));
  inst.cuid2 = (params) => inst.check(_cuid2(ZodCUID2, params));
  inst.ulid = (params) => inst.check(_ulid(ZodULID, params));
  inst.base64 = (params) => inst.check(_base64(ZodBase64, params));
  inst.base64url = (params) => inst.check(_base64url(ZodBase64URL, params));
  inst.xid = (params) => inst.check(_xid(ZodXID, params));
  inst.ksuid = (params) => inst.check(_ksuid(ZodKSUID, params));
  inst.ipv4 = (params) => inst.check(_ipv4(ZodIPv4, params));
  inst.ipv6 = (params) => inst.check(_ipv6(ZodIPv6, params));
  inst.cidrv4 = (params) => inst.check(_cidrv4(ZodCIDRv4, params));
  inst.cidrv6 = (params) => inst.check(_cidrv6(ZodCIDRv6, params));
  inst.e164 = (params) => inst.check(_e164(ZodE164, params));
  inst.datetime = (params) => inst.check(datetime2(params));
  inst.date = (params) => inst.check(date2(params));
  inst.time = (params) => inst.check(time2(params));
  inst.duration = (params) => inst.check(duration2(params));
});
function string2(params) {
  return _string(ZodString, params);
}
var ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
var ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
  $ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function email2(params) {
  return _email(ZodEmail, params);
}
var ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
  $ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function guid2(params) {
  return _guid(ZodGUID, params);
}
var ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
  $ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function uuid2(params) {
  return _uuid(ZodUUID, params);
}
function uuidv4(params) {
  return _uuidv4(ZodUUID, params);
}
function uuidv6(params) {
  return _uuidv6(ZodUUID, params);
}
function uuidv7(params) {
  return _uuidv7(ZodUUID, params);
}
var ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
  $ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function url(params) {
  return _url(ZodURL, params);
}
function httpUrl(params) {
  return _url(ZodURL, {
    protocol: /^https?$/,
    hostname: domain,
    ...normalizeParams(params)
  });
}
var ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
  $ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function emoji2(params) {
  return _emoji2(ZodEmoji, params);
}
var ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
  $ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function nanoid2(params) {
  return _nanoid(ZodNanoID, params);
}
var ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
  $ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cuid3(params) {
  return _cuid(ZodCUID, params);
}
var ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
  $ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cuid22(params) {
  return _cuid2(ZodCUID2, params);
}
var ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
  $ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ulid2(params) {
  return _ulid(ZodULID, params);
}
var ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
  $ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function xid2(params) {
  return _xid(ZodXID, params);
}
var ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
  $ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ksuid2(params) {
  return _ksuid(ZodKSUID, params);
}
var ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
  $ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ipv42(params) {
  return _ipv4(ZodIPv4, params);
}
var ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
  $ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function ipv62(params) {
  return _ipv6(ZodIPv6, params);
}
var ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
  $ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cidrv42(params) {
  return _cidrv4(ZodCIDRv4, params);
}
var ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
  $ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function cidrv62(params) {
  return _cidrv6(ZodCIDRv6, params);
}
var ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
  $ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function base642(params) {
  return _base64(ZodBase64, params);
}
var ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
  $ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function base64url2(params) {
  return _base64url(ZodBase64URL, params);
}
var ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
  $ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function e1642(params) {
  return _e164(ZodE164, params);
}
var ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
  $ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function jwt(params) {
  return _jwt(ZodJWT, params);
}
var ZodCustomStringFormat = /* @__PURE__ */ $constructor("ZodCustomStringFormat", (inst, def) => {
  $ZodCustomStringFormat.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function stringFormat(format, fnOrRegex, _params = {}) {
  return _stringFormat(ZodCustomStringFormat, format, fnOrRegex, _params);
}
function hostname2(_params) {
  return _stringFormat(ZodCustomStringFormat, "hostname", hostname, _params);
}
function hex2(_params) {
  return _stringFormat(ZodCustomStringFormat, "hex", hex, _params);
}
function hash(alg, params) {
  const enc = params?.enc ?? "hex";
  const format = `${alg}_${enc}`;
  const regex = exports_regexes[format];
  if (!regex)
    throw new Error(`Unrecognized hash format: ${format}`);
  return _stringFormat(ZodCustomStringFormat, format, regex, params);
}
var ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst.gt = (value, params) => inst.check(_gt(value, params));
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.lt = (value, params) => inst.check(_lt(value, params));
  inst.lte = (value, params) => inst.check(_lte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  inst.int = (params) => inst.check(int(params));
  inst.safe = (params) => inst.check(int(params));
  inst.positive = (params) => inst.check(_gt(0, params));
  inst.nonnegative = (params) => inst.check(_gte(0, params));
  inst.negative = (params) => inst.check(_lt(0, params));
  inst.nonpositive = (params) => inst.check(_lte(0, params));
  inst.multipleOf = (value, params) => inst.check(_multipleOf(value, params));
  inst.step = (value, params) => inst.check(_multipleOf(value, params));
  inst.finite = () => inst;
  const bag = inst._zod.bag;
  inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
  inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
  inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? 0.5);
  inst.isFinite = true;
  inst.format = bag.format ?? null;
});
function number2(params) {
  return _number(ZodNumber, params);
}
var ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return _int(ZodNumberFormat, params);
}
function float32(params) {
  return _float32(ZodNumberFormat, params);
}
function float64(params) {
  return _float64(ZodNumberFormat, params);
}
function int32(params) {
  return _int32(ZodNumberFormat, params);
}
function uint32(params) {
  return _uint32(ZodNumberFormat, params);
}
var ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
});
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
var ZodBigInt = /* @__PURE__ */ $constructor("ZodBigInt", (inst, def) => {
  $ZodBigInt.init(inst, def);
  ZodType.init(inst, def);
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.gt = (value, params) => inst.check(_gt(value, params));
  inst.gte = (value, params) => inst.check(_gte(value, params));
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.lt = (value, params) => inst.check(_lt(value, params));
  inst.lte = (value, params) => inst.check(_lte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  inst.positive = (params) => inst.check(_gt(BigInt(0), params));
  inst.negative = (params) => inst.check(_lt(BigInt(0), params));
  inst.nonpositive = (params) => inst.check(_lte(BigInt(0), params));
  inst.nonnegative = (params) => inst.check(_gte(BigInt(0), params));
  inst.multipleOf = (value, params) => inst.check(_multipleOf(value, params));
  const bag = inst._zod.bag;
  inst.minValue = bag.minimum ?? null;
  inst.maxValue = bag.maximum ?? null;
  inst.format = bag.format ?? null;
});
function bigint2(params) {
  return _bigint(ZodBigInt, params);
}
var ZodBigIntFormat = /* @__PURE__ */ $constructor("ZodBigIntFormat", (inst, def) => {
  $ZodBigIntFormat.init(inst, def);
  ZodBigInt.init(inst, def);
});
function int64(params) {
  return _int64(ZodBigIntFormat, params);
}
function uint64(params) {
  return _uint64(ZodBigIntFormat, params);
}
var ZodSymbol = /* @__PURE__ */ $constructor("ZodSymbol", (inst, def) => {
  $ZodSymbol.init(inst, def);
  ZodType.init(inst, def);
});
function symbol(params) {
  return _symbol(ZodSymbol, params);
}
var ZodUndefined = /* @__PURE__ */ $constructor("ZodUndefined", (inst, def) => {
  $ZodUndefined.init(inst, def);
  ZodType.init(inst, def);
});
function _undefined3(params) {
  return _undefined2(ZodUndefined, params);
}
var ZodNull = /* @__PURE__ */ $constructor("ZodNull", (inst, def) => {
  $ZodNull.init(inst, def);
  ZodType.init(inst, def);
});
function _null3(params) {
  return _null2(ZodNull, params);
}
var ZodAny = /* @__PURE__ */ $constructor("ZodAny", (inst, def) => {
  $ZodAny.init(inst, def);
  ZodType.init(inst, def);
});
function any() {
  return _any(ZodAny);
}
var ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
});
function unknown() {
  return _unknown(ZodUnknown);
}
var ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodType.init(inst, def);
});
function never(params) {
  return _never(ZodNever, params);
}
var ZodVoid = /* @__PURE__ */ $constructor("ZodVoid", (inst, def) => {
  $ZodVoid.init(inst, def);
  ZodType.init(inst, def);
});
function _void2(params) {
  return _void(ZodVoid, params);
}
var ZodDate = /* @__PURE__ */ $constructor("ZodDate", (inst, def) => {
  $ZodDate.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (value, params) => inst.check(_gte(value, params));
  inst.max = (value, params) => inst.check(_lte(value, params));
  const c = inst._zod.bag;
  inst.minDate = c.minimum ? new Date(c.minimum) : null;
  inst.maxDate = c.maximum ? new Date(c.maximum) : null;
});
function date3(params) {
  return _date(ZodDate, params);
}
var ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
  $ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst.element = def.element;
  inst.min = (minLength, params) => inst.check(_minLength(minLength, params));
  inst.nonempty = (params) => inst.check(_minLength(1, params));
  inst.max = (maxLength, params) => inst.check(_maxLength(maxLength, params));
  inst.length = (len, params) => inst.check(_length(len, params));
  inst.unwrap = () => inst.element;
});
function array(element, params) {
  return _array(ZodArray, element, params);
}
function keyof(schema) {
  const shape = schema._zod.def.shape;
  return _enum2(Object.keys(shape));
}
var ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
  $ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  defineLazy(inst, "shape", () => def.shape);
  inst.keyof = () => _enum2(Object.keys(inst._zod.def.shape));
  inst.catchall = (catchall) => inst.clone({ ...inst._zod.def, catchall });
  inst.passthrough = () => inst.clone({ ...inst._zod.def, catchall: unknown() });
  inst.loose = () => inst.clone({ ...inst._zod.def, catchall: unknown() });
  inst.strict = () => inst.clone({ ...inst._zod.def, catchall: never() });
  inst.strip = () => inst.clone({ ...inst._zod.def, catchall: undefined });
  inst.extend = (incoming) => {
    return extend(inst, incoming);
  };
  inst.safeExtend = (incoming) => {
    return safeExtend(inst, incoming);
  };
  inst.merge = (other) => merge(inst, other);
  inst.pick = (mask) => pick(inst, mask);
  inst.omit = (mask) => omit(inst, mask);
  inst.partial = (...args) => partial(ZodOptional, inst, args[0]);
  inst.required = (...args) => required(ZodNonOptional, inst, args[0]);
});
function object(shape, params) {
  const def = {
    type: "object",
    get shape() {
      assignProp(this, "shape", shape ? objectClone(shape) : {});
      return this.shape;
    },
    ...normalizeParams(params)
  };
  return new ZodObject(def);
}
function strictObject(shape, params) {
  return new ZodObject({
    type: "object",
    get shape() {
      assignProp(this, "shape", objectClone(shape));
      return this.shape;
    },
    catchall: never(),
    ...normalizeParams(params)
  });
}
function looseObject(shape, params) {
  return new ZodObject({
    type: "object",
    get shape() {
      assignProp(this, "shape", objectClone(shape));
      return this.shape;
    },
    catchall: unknown(),
    ...normalizeParams(params)
  });
}
var ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
var ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("ZodDiscriminatedUnion", (inst, def) => {
  ZodUnion.init(inst, def);
  $ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
  return new ZodDiscriminatedUnion({
    type: "union",
    options,
    discriminator,
    ...normalizeParams(params)
  });
}
var ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
  $ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
var ZodTuple = /* @__PURE__ */ $constructor("ZodTuple", (inst, def) => {
  $ZodTuple.init(inst, def);
  ZodType.init(inst, def);
  inst.rest = (rest) => inst.clone({
    ...inst._zod.def,
    rest
  });
});
function tuple(items, _paramsOrRest, _params) {
  const hasRest = _paramsOrRest instanceof $ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new ZodTuple({
    type: "tuple",
    items,
    rest,
    ...normalizeParams(params)
  });
}
var ZodRecord = /* @__PURE__ */ $constructor("ZodRecord", (inst, def) => {
  $ZodRecord.init(inst, def);
  ZodType.init(inst, def);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
function partialRecord(keyType, valueType, params) {
  const k = clone(keyType);
  k._zod.values = undefined;
  return new ZodRecord({
    type: "record",
    keyType: k,
    valueType,
    ...normalizeParams(params)
  });
}
var ZodMap = /* @__PURE__ */ $constructor("ZodMap", (inst, def) => {
  $ZodMap.init(inst, def);
  ZodType.init(inst, def);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function map(keyType, valueType, params) {
  return new ZodMap({
    type: "map",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
var ZodSet = /* @__PURE__ */ $constructor("ZodSet", (inst, def) => {
  $ZodSet.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (...args) => inst.check(_minSize(...args));
  inst.nonempty = (params) => inst.check(_minSize(1, params));
  inst.max = (...args) => inst.check(_maxSize(...args));
  inst.size = (...args) => inst.check(_size(...args));
});
function set(valueType, params) {
  return new ZodSet({
    type: "set",
    valueType,
    ...normalizeParams(params)
  });
}
var ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst.enum = def.entries;
  inst.options = Object.values(def.entries);
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = { ...def.entries };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum2(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
function nativeEnum(entries, params) {
  return new ZodEnum({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
var ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
var ZodFile = /* @__PURE__ */ $constructor("ZodFile", (inst, def) => {
  $ZodFile.init(inst, def);
  ZodType.init(inst, def);
  inst.min = (size, params) => inst.check(_minSize(size, params));
  inst.max = (size, params) => inst.check(_maxSize(size, params));
  inst.mime = (types, params) => inst.check(_mime(Array.isArray(types) ? types : [types], params));
});
function file(params) {
  return _file(ZodFile, params);
}
var ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
  $ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        _issue.input ?? (_issue.input = payload.value);
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output) => {
        payload.value = output;
        return payload;
      });
    }
    payload.value = output;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
var ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
var ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
function nullish2(innerType) {
  return optional(nullable(innerType));
}
var ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
  $ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default2(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
  $ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
  $ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
var ZodSuccess = /* @__PURE__ */ $constructor("ZodSuccess", (inst, def) => {
  $ZodSuccess.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function success(innerType) {
  return new ZodSuccess({
    type: "success",
    innerType
  });
}
var ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
  $ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch2(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
  });
}
var ZodNaN = /* @__PURE__ */ $constructor("ZodNaN", (inst, def) => {
  $ZodNaN.init(inst, def);
  ZodType.init(inst, def);
});
function nan(params) {
  return _nan(ZodNaN, params);
}
var ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
  $ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
  });
}
var ZodCodec = /* @__PURE__ */ $constructor("ZodCodec", (inst, def) => {
  ZodPipe.init(inst, def);
  $ZodCodec.init(inst, def);
});
function codec(in_, out, params) {
  return new ZodCodec({
    type: "pipe",
    in: in_,
    out,
    transform: params.decode,
    reverseTransform: params.encode
  });
}
var ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
  $ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
var ZodTemplateLiteral = /* @__PURE__ */ $constructor("ZodTemplateLiteral", (inst, def) => {
  $ZodTemplateLiteral.init(inst, def);
  ZodType.init(inst, def);
});
function templateLiteral(parts, params) {
  return new ZodTemplateLiteral({
    type: "template_literal",
    parts,
    ...normalizeParams(params)
  });
}
var ZodLazy = /* @__PURE__ */ $constructor("ZodLazy", (inst, def) => {
  $ZodLazy.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.getter();
});
function lazy(getter) {
  return new ZodLazy({
    type: "lazy",
    getter
  });
}
var ZodPromise = /* @__PURE__ */ $constructor("ZodPromise", (inst, def) => {
  $ZodPromise.init(inst, def);
  ZodType.init(inst, def);
  inst.unwrap = () => inst._zod.def.innerType;
});
function promise(innerType) {
  return new ZodPromise({
    type: "promise",
    innerType
  });
}
var ZodFunction = /* @__PURE__ */ $constructor("ZodFunction", (inst, def) => {
  $ZodFunction.init(inst, def);
  ZodType.init(inst, def);
});
function _function(params) {
  return new ZodFunction({
    type: "function",
    input: Array.isArray(params?.input) ? tuple(params?.input) : params?.input ?? array(unknown()),
    output: params?.output ?? unknown()
  });
}
var ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodType.init(inst, def);
});
function check(fn) {
  const ch = new $ZodCheck({
    check: "custom"
  });
  ch._zod.check = fn;
  return ch;
}
function custom(fn, _params) {
  return _custom(ZodCustom, fn ?? (() => true), _params);
}
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
function superRefine(fn) {
  return _superRefine(fn);
}
function _instanceof(cls, params = {
  error: `Input not instance of ${cls.name}`
}) {
  const inst = new ZodCustom({
    type: "custom",
    check: "custom",
    fn: (data) => data instanceof cls,
    abort: true,
    ...normalizeParams(params)
  });
  inst._zod.bag.Class = cls;
  return inst;
}
var stringbool = (...args) => _stringbool({
  Codec: ZodCodec,
  Boolean: ZodBoolean,
  String: ZodString
}, ...args);
function json(params) {
  const jsonSchema = lazy(() => {
    return union([string2(params), number2(), boolean2(), _null3(), array(jsonSchema), record(string2(), jsonSchema)]);
  });
  return jsonSchema;
}
function preprocess(fn, schema) {
  return pipe(transform(fn), schema);
}
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/classic/compat.js
var ZodIssueCode = {
  invalid_type: "invalid_type",
  too_big: "too_big",
  too_small: "too_small",
  invalid_format: "invalid_format",
  not_multiple_of: "not_multiple_of",
  unrecognized_keys: "unrecognized_keys",
  invalid_union: "invalid_union",
  invalid_key: "invalid_key",
  invalid_element: "invalid_element",
  invalid_value: "invalid_value",
  custom: "custom"
};
function setErrorMap(map) {
  config({
    customError: map
  });
}
function getErrorMap() {
  return config().customError;
}
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind) {})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/classic/coerce.js
var exports_coerce = {};
__export(exports_coerce, {
  bigint: () => bigint3,
  boolean: () => boolean3,
  date: () => date4,
  number: () => number3,
  string: () => string3
});
function string3(params) {
  return _coercedString(ZodString, params);
}
function number3(params) {
  return _coercedNumber(ZodNumber, params);
}
function boolean3(params) {
  return _coercedBoolean(ZodBoolean, params);
}
function bigint3(params) {
  return _coercedBigint(ZodBigInt, params);
}
function date4(params) {
  return _coercedDate(ZodDate, params);
}

// ../../node_modules/.bun/zod@4.1.8/node_modules/zod/v4/classic/external.js
config(en_default());
// ../../node_modules/.bun/@opencode-ai+plugin@1.17.11+4f25175b99662f85/node_modules/@opencode-ai/plugin/dist/tool.js
function tool(input) {
  return input;
}
tool.schema = exports_external;
// ../plugin/src/tools/unwrap-imitated-reduced-args.ts
var MAX_DECODED_STRING_LENGTH = 1024 * 1024;
var MAX_DECODED_ARRAY_ITEMS = 100;
function validField(value, rule) {
  if (rule === "string") {
    return typeof value === "string" && value.length <= MAX_DECODED_STRING_LENGTH;
  }
  if (rule === "number")
    return typeof value === "number" && Number.isFinite(value);
  if (rule === "boolean")
    return typeof value === "boolean";
  if (rule.type === "enum")
    return typeof value === "string" && rule.values.includes(value);
  if (!Array.isArray(value) || value.length > (rule.maxItems ?? MAX_DECODED_ARRAY_ITEMS)) {
    return false;
  }
  return value.every((item) => {
    if (rule.items === "number")
      return typeof item === "number" && Number.isFinite(item);
    return typeof item === "string" && item.length <= MAX_DECODED_STRING_LENGTH && (rule.values === undefined || rule.values.includes(item));
  });
}
function validDecodedArgs(value, schema) {
  for (const [field, fieldValue] of Object.entries(value)) {
    if (field === "reduced") {
      if (typeof fieldValue !== "boolean")
        return false;
      continue;
    }
    if (field === "summary") {
      if (typeof fieldValue !== "string" || fieldValue.length > MAX_DECODED_STRING_LENGTH) {
        return false;
      }
      continue;
    }
    const rule = schema[field];
    if (!rule || !validField(fieldValue, rule))
      return false;
  }
  return true;
}
function unwrapImitatedReducedArgs(args, primaryFields, schema) {
  const record = args;
  if (primaryFields.some((field) => record[field] !== undefined) || record.reduced !== true || typeof record.summary !== "string") {
    return args;
  }
  try {
    const parsed = JSON.parse(record.summary);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && validDecodedArgs(parsed, schema)) {
      return parsed;
    }
  } catch {}
  return args;
}

// ../plugin/src/tools/ctx-expand/constants.ts
var CTX_EXPAND_DESCRIPTION = `Recover original content that is no longer on your desk. It takes two kinds of number, and they are never interchangeable:
- \`tag=N\`: the number from a §N§ tag or a \`[dropped §N§]\` placeholder. Returns that one item whole: a text, or a tool call with its full input and output.
- \`message=N\`, \`start\`/\`end\`: message ordinals, the positions shown in \`<session-history>\` headings (\`## start-end\`) and in \`ctx_search\` hits. An ordinal counts whole messages; a tag counts each text and tool result separately, so the same number points at different things.

Earlier turns are summarized in <session-history> under \`## start-end · date · title\` headings; each heading stands for the raw messages in that ordinal range. When the summary isn't enough — exact wording, a value, an error message, the reasoning behind a decision — expand the range: ctx_expand(start=120, end=245). Also works around a ctx_search message hit: start=N-10, end=N+5. Ranges after the last compartment are your live tail — already visible, not expandable.

Returns the raw transcript as [N] U:/A: lines, capped at ~15K tokens; an oversized range returns the head and says where to continue.

Finer recovery:
- verbose=true lists each message separately with its ordinal and a per-part preview (tool calls with output sizes) so you can pick one.
- message=N returns that one message in full — every text part and every tool call's complete input and output — from stored history. This is the way back to a tool output you released with ctx_reduce; if the message was deleted from history it says so.`;
var CTX_EXPAND_TOKEN_BUDGET = 15000;

// ../plugin/src/features/magic-context/tag-input.ts
var TAG_INPUT_ERROR = 'Error: tag must be one positive integer: 12, "12", "§12§", "§12", "tag 12", or "[dropped §12§]" (surrounding whitespace is allowed).';
function parseTagInput(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return value;
  if (typeof value === "string") {
    const text = value.trim();
    const match = /^(?:([0-9]+)|§([0-9]+)§?|tag\s+([0-9]+)|\[dropped\s+§([0-9]+)§\])$/.exec(text);
    const number = match ? Number(match.slice(1).find((part) => part !== undefined)) : NaN;
    if (Number.isSafeInteger(number) && number > 0)
      return number;
  }
  throw new Error(TAG_INPUT_ERROR);
}

// ../plugin/src/tools/ctx-expand/mode.ts
function isInt(value) {
  return typeof value === "number" && Number.isInteger(value);
}
function minOrdinal(domain) {
  return domain === "non-negative" ? 0 : 1;
}
function messageError(domain) {
  return domain === "non-negative" ? "Error: message must be a non-negative integer." : "Error: message must be a positive integer.";
}
function rangeError(domain) {
  return domain === "non-negative" ? "Error: provide either message=<ordinal>, or start and end (non-negative integers, start <= end)." : "Error: provide either message=<ordinal>, or start and end (positive integers, start <= end).";
}
function resolveCtxExpandMode(args, domain) {
  if (args.tag !== undefined && args.tag !== null && !((args.tag === 0 || args.tag === "") && (args.message !== undefined || args.start !== undefined))) {
    try {
      const tag = parseTagInput(args.tag);
      if ([args.message, args.start, args.end].some((value) => value !== undefined && value !== null && value !== 0)) {
        return {
          kind: "error",
          message: "Error: use tag alone, without message or start/end."
        };
      }
      return { kind: "tag", tag };
    } catch (error) {
      return { kind: "error", message: error.message };
    }
  }
  const min = minOrdinal(domain);
  const messagePresent = args.message !== undefined && args.message !== null;
  const message = isInt(args.message) ? args.message : undefined;
  const start = isInt(args.start) ? args.start : undefined;
  const end = isInt(args.end) ? args.end : undefined;
  const messageValid = message !== undefined && message >= min;
  const rangeValid = start !== undefined && end !== undefined && start >= min && end >= start;
  const fillerPair = start === 0 && end === 0;
  const rangeNamed = rangeValid && !fillerPair;
  if (messageValid && !rangeNamed) {
    return { kind: "message", message };
  }
  if (messagePresent && !messageValid && !rangeNamed) {
    return { kind: "error", message: messageError(domain) };
  }
  if (rangeValid) {
    return {
      kind: "range",
      start,
      end,
      verbose: args.verbose === true
    };
  }
  return { kind: "error", message: rangeError(domain) };
}

// ../plugin/src/tools/ctx-expand/render.ts
import { createHash as createHash2 } from "node:crypto";
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function roleLabel(role) {
  if (role === "assistant")
    return "A (assistant)";
  if (role === "user")
    return "U (user)";
  return role;
}
function verboseRoleLabel(msg) {
  if (msg.role === "user" && msg.parts.length > 0 && msg.parts.every((part) => {
    if (!isRecord(part))
      return false;
    if (part.type === "tool_result")
      return true;
    return part.type === "tool" && asToolPart(part)?.output != null;
  }))
    return "tool results";
  return roleLabel(msg.role);
}
function truncate(value, max) {
  const t = value.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
function keyArg(input) {
  if (!input)
    return "";
  for (const k of ["filePath", "path", "pattern", "query", "symbol", "module", "action"]) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0)
      return truncate(v, 60);
  }
  if (typeof input.description === "string")
    return truncate(input.description, 60);
  return "";
}
function asToolPart(part) {
  const type = typeof part.type === "string" ? part.type : "";
  if (type === "tool") {
    const state = isRecord(part.state) ? part.state : null;
    const output = state && typeof state.output === "string" ? state.output : state && state.output != null ? JSON.stringify(state.output) : null;
    const metadata = state && isRecord(state.metadata) ? state.metadata : null;
    const title = state && typeof state.title === "string" && state.title || metadata && typeof metadata.title === "string" && metadata.title || null;
    return {
      name: typeof part.tool === "string" ? part.tool : "tool",
      callId: typeof part.callID === "string" ? part.callID : "",
      title,
      input: state && isRecord(state.input) ? state.input : null,
      output
    };
  }
  if (type === "tool_use") {
    return {
      name: typeof part.name === "string" ? part.name : "tool",
      callId: typeof part.id === "string" ? part.id : "",
      title: null,
      input: isRecord(part.input) ? part.input : null,
      output: null
    };
  }
  if (type === "tool_result") {
    const content = part.content;
    const output = typeof content === "string" ? content : content != null ? JSON.stringify(content) : null;
    return {
      name: "tool_result",
      callId: typeof part.tool_use_id === "string" ? part.tool_use_id : "",
      title: null,
      input: null,
      output
    };
  }
  return null;
}
function textOf(part) {
  if (part.type === "text" && typeof part.text === "string")
    return part.text;
  return null;
}
function reasoningOf(part) {
  if ((part.type === "reasoning" || part.type === "thinking") && typeof part.text === "string") {
    return part.text;
  }
  return null;
}
function renderPartPreview(part, expandTools) {
  if (!isRecord(part))
    return null;
  const expansion = expandToolPart(part, expandTools);
  if (expansion !== null)
    return `    • tool ${part.tool}: ${expansion}`;
  const text = textOf(part);
  if (text !== null) {
    const t = truncate(text, 200);
    return t.length > 0 ? `    • ${t}` : null;
  }
  const tool = asToolPart(part);
  if (tool) {
    const arg = keyArg(tool.input);
    const head = arg ? `${tool.name}(${arg})` : tool.name;
    return tool.output !== null ? `    • tool ${head} → output ~${estimateTokens(tool.output)} tok` : `    • tool ${head}`;
  }
  const reasoning = reasoningOf(part);
  if (reasoning !== null)
    return `    • [reasoning] ${truncate(reasoning, 120)}`;
  const type = typeof part.type === "string" ? part.type : "part";
  if (type === "file")
    return "    • [file]";
  if (type === "step-start" || type === "step-finish")
    return null;
  return `    • [${type}]`;
}
function renderPartFull(part) {
  if (!isRecord(part))
    return null;
  const text = textOf(part);
  if (text !== null) {
    return text.trim().length > 0 ? `  [text]
${text}` : null;
  }
  const tool = asToolPart(part);
  if (tool) {
    const lines = [];
    const idSuffix = tool.callId ? ` #${tool.callId}` : "";
    lines.push(`  [tool: ${tool.name}${idSuffix}]`);
    if (tool.title && tool.title.trim().length > 0) {
      lines.push(`  description: ${tool.title.trim()}`);
    }
    if (tool.input)
      lines.push(`  input: ${JSON.stringify(tool.input)}`);
    if (tool.output !== null)
      lines.push(`  output:
${tool.output}`);
    return lines.join(`
`);
  }
  const type = typeof part.type === "string" ? part.type : "part";
  if (type === "file") {
    const name = typeof part.filename === "string" && part.filename || typeof part.url === "string" && part.url || "";
    return `  [file]${name ? ` ${name}` : ""}`;
  }
  return null;
}
function renderMessageByOrdinal(sessionId, ordinal) {
  const found = [];
  visitRawSessionMessages2(sessionId, ordinal, ordinal, (m) => {
    if (m.ordinal === ordinal)
      found.push(m);
    return false;
  });
  const msg = found[0];
  if (!msg) {
    return `No message at ordinal ${ordinal} in this session's stored history — it was deleted ` + `(session prune/revert) or the ordinal is wrong, so it can't be recovered. ` + `Re-run the tool if you still need the data.`;
  }
  const rendered = msg.parts.map(renderPartFull).filter((l) => l !== null);
  const lines = [`[${msg.ordinal}] ${roleLabel(msg.role)} — full recovery:`, ""];
  if (rendered.length === 0) {
    lines.push("  (no recoverable content — message had only structural/reasoning parts)");
  } else {
    lines.push(...rendered);
  }
  return lines.join(`
`);
}
function renderVerboseRange(sessionId, start, end, tokenBudget, expandTools) {
  const out = [];
  let usedTokens = 0;
  let lastOrdinal = start - 1;
  let truncated = false;
  visitRawSessionMessages2(sessionId, start, end, (msg) => {
    const header = `[${msg.ordinal}] ${verboseRoleLabel(msg)}`;
    const partLines = msg.parts.map((part) => renderPartPreview(part, expandTools)).filter((l) => l !== null);
    const block = partLines.length > 0 ? `${header}
${partLines.join(`
`)}` : header;
    const blockTokens = estimateTokens(block);
    if (usedTokens + blockTokens > tokenBudget && out.length > 0) {
      truncated = true;
      return false;
    }
    out.push(block);
    usedTokens += blockTokens;
    lastOrdinal = msg.ordinal;
    return true;
  });
  return { text: out.join(`

`), lastOrdinal, truncated };
}
function renderItemByTag(db, sessionId, number, textIndexDomain = "part") {
  const tag = getTagById(db, sessionId, number);
  if (!tag)
    return `no tag ${number} in this session; if ${number} came from a <session-history> heading or a ctx_search hit, it is an ordinal: use message=${number}`;
  if (tag.type === "tool") {
    const owner = tag.toolOwnerMessageId;
    if (!owner)
      return `Tag ${number}'s tool owner is unknown; its original call cannot be resolved safely.`;
    const message = readRawSessionMessageById2(sessionId, owner);
    if (!message)
      return `Tag ${number}'s original tool owner is no longer in stored history.`;
    const parts = message?.parts.filter((part) => isRecord(part) && asToolPart(part)?.callId === tag.messageId) ?? [];
    if (!parts.some((part) => isRecord(part) && asToolPart(part)?.output !== null)) {
      const messages = readRawSessionMessages2(sessionId);
      const ownerIndex = messages.findIndex((candidate) => candidate.id === owner);
      for (const candidate of messages.slice(Math.max(0, ownerIndex + 1))) {
        const matching = candidate.parts.filter((part) => isRecord(part) && asToolPart(part)?.callId === tag.messageId);
        if (matching.some((part) => isRecord(part) && part.type === "tool_use"))
          break;
        parts.push(...matching);
        if (matching.length > 0)
          break;
      }
    }
    const rendered = parts.map(renderPartFull).filter((part) => part !== null);
    return rendered.length ? rendered.join(`
`) : `Tag ${number}'s original tool call is no longer in stored history.`;
  }
  const scoped = /^(.*):p(\d+)$/.exec(tag.messageId);
  const derived = /^(.*):mc-text-v1:([a-f0-9]+):([a-f0-9]+):o(\d+)$/.exec(tag.messageId);
  const owner = scoped?.[1] ?? derived?.[1] ?? tag.messageId;
  const message = readRawSessionMessageById2(sessionId, owner);
  if (!message)
    return `Tag ${number}'s original text is no longer in stored history.`;
  const index = scoped ? Number(scoped[2]) : 0;
  const piText = message.parts.filter((part) => isRecord(part) && part.type === "text");
  const part = message.parts[index];
  const matching = derived ? piText.filter((part) => isRecord(part) && typeof part.text === "string" && createHash2("sha256").update(part.text).digest("hex") === derived[3]) : [];
  const selected = derived ? matching[Number(derived[4])] : textIndexDomain === "text" ? piText[index] : part;
  return selected ? renderPartFull(selected) ?? "" : `Tag ${number}'s original text part is no longer in stored history.`;
}

// ../plugin/src/tools/ctx-expand/tools.ts
var ctxExpandArgsShape = {
  tag: tool.schema.union([tool.schema.number(), tool.schema.string()]).optional().describe("Tag number from a §N§ tag or a [dropped §N§] placeholder, not a message ordinal. Returns that one item in full. Use alone."),
  start: tool.schema.number().optional().describe("First message ordinal of the range (a <session-history> heading's start, or a ctx_search hit), not a tag number."),
  end: tool.schema.number().optional().describe("Last message ordinal of the range, inclusive, not a tag number."),
  verbose: tool.schema.boolean().optional().describe("With start/end: one entry per message with ordinal and per-part preview instead of the transcript."),
  message: tool.schema.number().optional().describe("Message ordinal from a <session-history> heading or a ctx_search hit, not a tag number. Returns that one message in full. Use alone.")
};
var ctxExpandArgsSchema = tool.schema.object(ctxExpandArgsShape).passthrough();
function createCtxExpandTool(deps) {
  return tool({
    description: CTX_EXPAND_DESCRIPTION,
    args: ctxExpandArgsShape,
    async execute(rawArgs, toolContext) {
      const parsedArgs = ctxExpandArgsSchema.safeParse(rawArgs);
      let args = parsedArgs.success ? parsedArgs.data : rawArgs;
      args = unwrapImitatedReducedArgs(args, ["tag", "message", "start"], {
        start: "number",
        end: "number",
        verbose: "boolean",
        message: "number"
      });
      const sessionId = toolContext.sessionID;
      const mode = resolveCtxExpandMode(args, "positive");
      if (mode.kind === "error") {
        return mode.message;
      }
      if (mode.kind === "tag") {
        return renderItemByTag(deps.db, sessionId, mode.tag);
      }
      if (mode.kind === "message") {
        return renderMessageByOrdinal(sessionId, mode.message);
      }
      const { start, end, verbose } = mode;
      const lastCompartmentEnd = deps.getLastCompactedOrdinal ? deps.getLastCompactedOrdinal(sessionId) : getLastCompartmentEndMessage(deps.db, sessionId);
      if (lastCompartmentEnd >= 0 && start > lastCompartmentEnd) {
        return `Range ${start}-${end} is entirely within the live tail (after the last compacted message ${lastCompartmentEnd}); those messages are already visible in context.`;
      }
      const effectiveEnd = lastCompartmentEnd >= 0 ? Math.min(end, lastCompartmentEnd) : end;
      if (verbose) {
        const v = renderVerboseRange(sessionId, start, effectiveEnd, CTX_EXPAND_TOKEN_BUDGET, deps.expandTools);
        if (!v.text) {
          return `No messages found in range ${start}-${effectiveEnd}. The range may be outside this session's history.`;
        }
        const out = [
          `Messages ${start}-${v.lastOrdinal} (verbose). Recover any one in full with ctx_expand(message=<ordinal>):`,
          "",
          v.text
        ];
        if (v.truncated) {
          out.push("", `Truncated at message ${v.lastOrdinal} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${v.lastOrdinal + 1} end=${effectiveEnd} verbose=true for more.`);
        }
        return out.join(`
`);
      }
      const chunk = readSessionChunk2(sessionId, CTX_EXPAND_TOKEN_BUDGET, start, effectiveEnd + 1, { expand: false });
      if (!chunk.text || chunk.messageCount === 0) {
        return `No messages found in range ${start}-${end}. The range may be outside this session's history.`;
      }
      const lines = [];
      lines.push(`Messages ${chunk.startIndex}-${chunk.endIndex} (${chunk.messageCount} messages, ~${chunk.tokenEstimate} tokens):`);
      lines.push("");
      lines.push(chunk.text);
      if (chunk.endIndex < effectiveEnd) {
        lines.push("");
        lines.push(`Truncated at message ${chunk.endIndex} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${chunk.endIndex + 1} end=${effectiveEnd} for more.`);
      }
      return lines.join(`
`);
    }
  });
}
function createCtxExpandTools(deps) {
  return {
    ctx_expand: createCtxExpandTool(deps)
  };
}
// ../plugin/src/tools/ctx-memory/constants.ts
var CTX_MEMORY_TOOL_NAME = "ctx_memory";
var CTX_MEMORY_DESCRIPTION = `Durable facts about this project, shared with every agent working on it and kept for the months this work lasts.

Your active memories are already in <project-memory> as \`#id: fact\` lines. Write one when you learn something that must not have to be found again — a project rule, an architectural fact, a hard-won constraint, a config value, a naming convention — and especially when it cost you turns to find. One standalone fact per memory, phrased to make sense on its own. A pending intention with its evidence ("do X later, here is what we know") is ctx_note, not memory.

Actions:
- write: new memory (content + category).
- update: rewrite one memory whose fact changed (ids: [one], content; category optional to recategorize).
- archive: retire wrong or obsolete memories (ids: [one or more], optional reason).
- merge: collapse duplicates into one (ids: [two or more], content).
- get: fetch by id (ids: 1–20), readable in every status.
Examples: category="CONFIG_VALUES", content="OpenCode source is at ~/Work/OSS/opencode" · category="CONSTRAINTS", content="Dashboard Tauri build needs RGBA PNGs, not grayscale"`;
var DEFAULT_SEARCH_LIMIT = 10;
// ../plugin/src/agents/dreamer.ts
var DREAMER_AGENT = "dreamer";

// ../plugin/src/features/magic-context/dreamer/storage-task-schedule.ts
function toRow(r) {
  return {
    projectPath: r.project_path,
    task: r.task,
    lastRunAt: r.last_run_at,
    nextDueAt: r.next_due_at,
    schedule: r.schedule ?? null,
    lastStatus: r.last_status ?? null,
    lastError: r.last_error,
    retryCount: r.retry_count ?? 0,
    taskStateJson: r.last_checked_commit ?? null,
    lastCheckedCommit: r.last_checked_commit ?? null,
    lastBroadRunAt: r.last_broad_run_at ?? null,
    retrospectiveWatermarkMs: r.retrospective_watermark_ms ?? null
  };
}
var SELECT_COLUMNS = "project_path, task, last_run_at, next_due_at, schedule, last_status, last_error, retry_count, last_checked_commit, last_broad_run_at, retrospective_watermark_ms";
function getTaskScheduleState(db, projectPath, task) {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM task_schedule_state WHERE project_path = ? AND task = ?`).get(projectPath, task);
  return row ? toRow(row) : null;
}

// ../plugin/src/features/magic-context/dreamer/curate-category-rotation.ts
var CURATE_MEMORY_CATEGORIES = V2_MEMORY_CATEGORIES;
var LEGACY_CURATE_CATEGORY_BUCKETS = {
  ARCHITECTURE_DECISIONS: "ARCHITECTURE",
  CONFIG_DEFAULTS: "CONFIG_VALUES",
  ENVIRONMENT: "CONFIG_VALUES",
  KNOWN_ISSUES: "CONSTRAINTS",
  USER_DIRECTIVES: "PROJECT_RULES",
  USER_PREFERENCES: "PROJECT_RULES",
  WORKFLOW_RULES: "PROJECT_RULES"
};
function curateCategoryForMemoryCategory(category) {
  return isCurateMemoryCategory(category) ? category : LEGACY_CURATE_CATEGORY_BUCKETS[category] ?? null;
}
function isCurateMemoryCategory(value) {
  return CURATE_MEMORY_CATEGORIES.includes(value);
}
function parseTaskState(raw) {
  if (!raw)
    return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function readState(db, projectIdentity) {
  return parseTaskState(getTaskScheduleState(db, projectIdentity, "curate")?.taskStateJson);
}
function getActiveCurateCategory(db, projectIdentity) {
  const active = readState(db, projectIdentity).curate?.activeCategory;
  return isCurateMemoryCategory(active) ? active : null;
}
function getCurateCategoryScopeRefusal(args) {
  if (args.requestedCategory && args.requestedCategory !== args.scope) {
    return `Error: Curate scope is ${args.scope}; ${args.action} cannot target category ${args.requestedCategory}.`;
  }
  for (const id of args.ids ?? []) {
    const category = args.categoryForId(id);
    if (category && category !== args.scope) {
      return `Error: Curate scope is ${args.scope}; memory ID ${id} is outside the scoped category.`;
    }
  }
  return null;
}

// ../plugin/src/features/magic-context/dreamer/memory-claim-safety.ts
var POLICY_SENTENCE_START = /(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:you\s+|we\s+)?(?:must(?:\s+not)?|never|always|do\s+not|don't|shall\s+not)\b/i;
var ACTOR_POLICY = /\b(?:you|we|agents?|masons?|workers?|operators?|users?|maintainers?)\s+(?:must(?:\s+not)?|should(?:\s+not)?|need\s+to|shall(?:\s+not)?|cannot|can't|may\s+not)\b/i;
var BEHAVIORAL_WHEN_CLAUSE = /\bwhen\s+(?:you(?:'re|\s+are)?|we(?:'re|\s+are)?|told|asked|requested|working|debugging|reviewing|checking|verifying|investigating|using|running|editing|changing)\b/i;
var WORKFLOW_IMPERATIVE = /(?:^|[.!?]\s+|\n\s*)(?:[-*]\s+|\d+[.)]\s+)?(?:please\s+)?(?:run|use|check|ask|avoid|prefer|ensure|keep|follow|brief|report|inspect|search|open|read|review|validate|confirm|delegate|stop|start|remember)\b/i;
var DECISION_AUTHORITY = /\b(?:the\s+)?(?:user|operator|maintainer|owner)\s+(?:decides|chooses|approves|has\s+(?:the\s+)?final\s+say)\b/i;
function isDirectiveShapedProjectRule(category, content) {
  if (category !== V2_MEMORY_CATEGORIES[0])
    return false;
  const text = content.trim();
  if (!text)
    return false;
  return POLICY_SENTENCE_START.test(text) || ACTOR_POLICY.test(text) || BEHAVIORAL_WHEN_CLAUSE.test(text) || WORKFLOW_IMPERATIVE.test(text) || DECISION_AUTHORITY.test(text);
}

// ../plugin/src/features/magic-context/dreamer/curate-memory-safety.ts
var PROJECT_SCOPED_CATEGORIES = new Set(V2_MEMORY_CATEGORIES);
var USER_PROFILE_REFERENCE = /\buser(?:[\s_-]+)(?:profile|preferences?)\b|\bU\d+\b/i;
var refusalCountsBySession = new Map;
function isSurvivingConsolidationTarget(memory, successor, projectIdentity) {
  return successor !== null && successor.id !== memory.id && successor.status === "active" && successor.supersededByMemoryId === null && (successor.expiresAt === null || successor.expiresAt > Date.now()) && projectIdentity(successor) === projectIdentity(memory) && successor.category === memory.category;
}
function assessCurateMutationSafety(args) {
  const { memory, successor, verdict } = args;
  if (verdict === "archive") {
    if (!isSurvivingConsolidationTarget(memory, successor, args.projectIdentity)) {
      return {
        memoryId: memory.id,
        verdict,
        reason: "missing-active-same-category-successor"
      };
    }
    if (PROJECT_SCOPED_CATEGORIES.has(memory.category) && USER_PROFILE_REFERENCE.test(args.reason ?? "")) {
      return {
        memoryId: memory.id,
        verdict,
        reason: "user-profile-is-not-project-memory"
      };
    }
  }
  if (isDirectiveShapedProjectRule(memory.category, memory.content)) {
    return {
      memoryId: memory.id,
      verdict,
      reason: "directive-shaped-project-rule"
    };
  }
  if (verdict === "update") {
    const originalChars = memory.content.trim().length;
    const replacementChars = args.replacementContent?.trim().length ?? 0;
    if (replacementChars * 2 < originalChars && !isSurvivingConsolidationTarget(memory, successor, args.projectIdentity)) {
      return {
        memoryId: memory.id,
        verdict,
        reason: "content-loss",
        originalChars,
        replacementChars
      };
    }
  }
  return null;
}
function recordCurateSafetyRefusal(sessionId, refusal) {
  const count = (refusalCountsBySession.get(sessionId) ?? 0) + 1;
  refusalCountsBySession.set(sessionId, count);
  const lengths = refusal.originalChars === undefined ? "" : ` original_chars=${refusal.originalChars} replacement_chars=${refusal.replacementChars ?? 0}`;
  log(`[dreamer] curate safety refusal: session_id=${sessionId} memory_id=${refusal.memoryId} verdict=${refusal.verdict} reason=${refusal.reason}${lengths} refused=${count}`);
  return count;
}

// ../plugin/src/features/magic-context/memory/memory-visibility.ts
function createMemoryVisibilityPolicy(db, projectIdentity) {
  const identitySet = resolveWorkspaceIdentitySet(db, projectIdentity);
  const workspaced = identitySet.identities.length > 1;
  const expanded = expandWorkspaceIdentitySetWithAliases(db, identitySet.identities);
  const visibleIdentities = workspaced ? expanded.expandedIdentities : identitySet.identities;
  const shareCategories = workspaced ? resolveWorkspaceShareCategories(db, projectIdentity) : null;
  const identityFor = (storedProjectPath) => workspaced ? resolveStoredPathWorkspaceIdentity(storedProjectPath, identitySet.identities, expanded.canonicalIdentityByStoredPath) ?? normalizeStoredProjectPath(storedProjectPath) : normalizeStoredProjectPath(storedProjectPath);
  const owned = (memory) => workspaced ? identityFor(memory.projectPath) === projectIdentity : storedPathBelongsToIdentity(memory.projectPath, projectIdentity);
  const visible = (memory) => {
    if (!workspaced)
      return storedPathBelongsToIdentity(memory.projectPath, projectIdentity);
    if (!storedPathBelongsToWorkspace(memory.projectPath, identitySet.identities, visibleIdentities, expanded.canonicalIdentityByStoredPath)) {
      return false;
    }
    if (identityFor(memory.projectPath) === projectIdentity)
      return true;
    return (memory.status === "active" || memory.status === "permanent") && (memory.expiresAt === null || memory.expiresAt > Date.now()) && memory.shareable === 1 && ["project", "ecosystem", "universe"].includes(memory.scope) && (shareCategories?.includes(memory.category) ?? false);
  };
  return { workspaced, identityFor, visible, owned };
}

// ../plugin/src/shared/user-facing-codes.ts
var USER_FACING_FAILURES = {
  historian_unavailable: {
    code: "MC-H01",
    sentence: "History compression could not finish this turn.",
    action: "It will retry automatically."
  },
  historian_saved_history_misaligned: {
    code: "MC-H03",
    sentence: "History compression is paused because this session's saved summaries no longer line up with its messages.",
    action: "Run /ctx-recomp to rebuild them."
  },
  history_boundary_unresolved: {
    code: "MC-H04",
    sentence: "This request was not sent: the message that marks where this session's history summary ends is missing from the OpenCode store, and without it the request is larger than the model's context window.",
    action: "Run /ctx-recomp to rebuild the history summary."
  },
  history_over_window_unmanaged: {
    code: "MC-H06",
    sentence: "This request was not sent: this session's history is larger than the model's context window, and Magic Context does not have a summary of it yet to send in its place.",
    action: "Send your message again once history compression has caught up, or switch to a model with a larger context window."
  },
  frozen_history_over_window: {
    code: "MC-H07",
    sentence: "This request was not sent: the conversation is larger than the context window the provider reported, and the compressed history Magic Context has ready does not fit either.",
    action: "Run /ctx-flush to compress it now, then send your message again."
  },
  historian_window_too_small: {
    code: "MC-H05",
    sentence: "History compression is paused because the history model's context window is too small for its instructions.",
    action: "Set historian.model in magic-context.jsonc to a model with a larger context window."
  },
  recomp_unavailable: {
    code: "MC-R01",
    sentence: "History compression could not be rebuilt.",
    action: "Run /ctx-recomp again."
  },
  dream_provider_timeout: {
    code: "MC-D01",
    sentence: "Memory maintenance took too long to respond.",
    action: "Run /ctx-dream again."
  },
  dream_provider_error: {
    code: "MC-D02",
    sentence: "Memory maintenance could not reach its model.",
    action: "Check the model connection, then run /ctx-dream again."
  },
  dream_local_refusal: {
    code: "MC-D12",
    sentence: "Memory maintenance was refused before reaching the model.",
    action: "Check the hidden-request diagnostic in the Magic Context log before retrying."
  },
  dream_step_limit: {
    code: "MC-D10",
    sentence: "Memory maintenance stopped at its hidden agent step limit.",
    action: "This task needs less work per run; changing the model connection will not help."
  },
  dream_token_budget: {
    code: "MC-D11",
    sentence: "Memory maintenance reached its prompt-token budget.",
    action: "The unfinished items will be retried on the next run."
  },
  dream_empty_completion: {
    code: "MC-D03",
    sentence: "Memory maintenance received no usable response.",
    action: "Run /ctx-dream again."
  },
  dream_no_models: {
    code: "MC-D04",
    sentence: "Memory maintenance has no model available.",
    action: "Check the model settings, then run /ctx-dream again."
  },
  dream_child_aborted: {
    code: "MC-D05",
    sentence: "Memory maintenance was interrupted.",
    action: "Run /ctx-dream again."
  },
  dream_parse_failed: {
    code: "MC-D06",
    sentence: "Memory maintenance could not use the model response.",
    action: "Run /ctx-dream again."
  },
  dream_unknown: {
    code: "MC-D07",
    sentence: "Memory maintenance could not finish.",
    action: "Run /ctx-dream again."
  },
  dreamer_tick_blocked: {
    code: "MC-D09",
    sentence: "Background maintenance is not running: its last pass stopped before it reached the scheduled tasks.",
    action: "It is retried automatically; if it keeps happening, check the Magic Context log for the stage that stopped and run `npx @cortexkit/magic-context doctor`."
  },
  dream_task_needs_tool_loop: {
    code: "MC-D08",
    sentence: "Some memory maintenance tasks need a tool loop this host does not provide.",
    action: "The remaining tasks still run; the listed ones are skipped on this host."
  },
  embedding_substitution_rejected: {
    code: "MC-E01",
    sentence: "Search indexing could not use the selected model.",
    action: "Check the embedding model setting, then run /ctx-embed start again."
  },
  embedding_http_error: {
    code: "MC-E02",
    sentence: "The search indexing provider refused the request.",
    action: "Check the provider connection and credentials, then run /ctx-embed start again."
  },
  embedding_transport_error: {
    code: "MC-E03",
    sentence: "Search indexing could not reach its provider.",
    action: "Check the connection, then run /ctx-embed start again."
  },
  embedding_invalid_envelope: {
    code: "MC-E04",
    sentence: "Search indexing received an unsupported response.",
    action: "Check the embedding endpoint, then run /ctx-embed start again."
  },
  embedding_empty_result: {
    code: "MC-E05",
    sentence: "Search indexing received no usable result.",
    action: "Run /ctx-embed start again."
  },
  embedding_certification_refusal: {
    code: "MC-E06",
    sentence: "Search indexing is not ready for this provider.",
    action: "Finish the provider setup, or set a fallback provider in the embedding settings, then run /ctx-embed start again."
  },
  embedding_credential_required: {
    code: "MC-E07",
    sentence: "Search indexing needs provider credentials.",
    action: "Sign in to the provider, then run /ctx-embed start again."
  },
  embedding_local_binding_missing: {
    code: "MC-E08",
    sentence: "Local search indexing is unavailable on this system.",
    action: "Run `npx @cortexkit/magic-context doctor`, then retry."
  },
  embedding_local_fs_unavailable: {
    code: "MC-E09",
    sentence: "Local search indexing cannot save its model files.",
    action: "Update or reinstall Magic Context, then retry."
  },
  embedding_local_download_failure: {
    code: "MC-E10",
    sentence: "Local search indexing could not download its model.",
    action: "Check the network connection, then retry."
  },
  embedding_local_runtime_error: {
    code: "MC-E11",
    sentence: "Local search indexing could not start.",
    action: "Run `npx @cortexkit/magic-context doctor`, then retry."
  },
  embedding_unavailable: {
    code: "MC-E12",
    sentence: "Search indexing could not finish.",
    action: "Run /ctx-embed start again."
  },
  status_unavailable: {
    code: "MC-S01",
    sentence: "Magic Context status is temporarily unavailable.",
    action: "Retry /ctx-status in a moment."
  },
  transform_update_failed: {
    code: "MC-S02",
    sentence: "The last context update did not finish.",
    action: "Send another message to retry."
  },
  transform_pass_degraded: {
    code: "MC-S06",
    sentence: "This request was not sent: Magic Context could not finish preparing it, and without that preparation it could be far larger than the previous request.",
    action: "Send your message again."
  },
  configuration_warning: {
    code: "MC-S03",
    sentence: "Some configuration settings could not be applied.",
    action: "Fix the configuration warning shown in /ctx-status, then restart."
  },
  status_log_unavailable: {
    code: "MC-S04",
    sentence: "Some diagnostic details could not be saved.",
    action: "Retry /ctx-status in a moment."
  },
  memory_writes_paused: {
    code: "MC-C01",
    sentence: "Memory writes are paused while the engine syncs.",
    action: "Retry in a moment."
  },
  memory_access_unavailable: {
    code: "MC-C02",
    sentence: "Memory access is temporarily unavailable.",
    action: "Retry in a moment."
  },
  note_changes_paused: {
    code: "MC-C03",
    sentence: "Note changes are paused while the engine syncs.",
    action: "Retry in a moment."
  },
  note_access_unavailable: {
    code: "MC-C04",
    sentence: "Notes are temporarily unavailable.",
    action: "Retry in a moment."
  },
  context_cleanup_paused: {
    code: "MC-C05",
    sentence: "Context cleanup is paused while the engine syncs.",
    action: "Retry in a moment."
  },
  partial_history_unavailable: {
    code: "MC-C06",
    sentence: "Partial history compression is not available in the current mode.",
    action: "Run /ctx-recomp without a range."
  },
  smart_note_conditions_unavailable: {
    code: "MC-C08",
    sentence: "Conditional notes are not available in the current mode.",
    action: "Save a regular note without a condition."
  },
  history_compression_paused: {
    code: "MC-C09",
    sentence: "History compression is paused while the engine syncs.",
    action: "Retry in a moment."
  },
  history_compression_needs_message: {
    code: "MC-C12",
    sentence: "History compression has not seen this session since Magic Context reconnected.",
    action: "Send a message in this session first, then run /ctx-wrapup again."
  },
  context_service_unavailable: {
    code: "MC-C10",
    sentence: "Magic Context is temporarily unavailable.",
    action: "Retry in a moment."
  },
  context_db_missing: {
    code: "MC-C15",
    sentence: "Magic Context has no context.db.",
    action: "Run `npx @cortexkit/magic-context doctor store init`, then restart ck-mc."
  },
  single_store_migration_required: {
    code: "MC-C14",
    sentence: "Magic Context's Rust mode needs a one-time migration of its store.",
    action: "Quit OpenCode and every ck-mc process, then run `magic-context doctor single-store migrate`."
  },
  store_ahead_of_binary: {
    code: "MC-C13",
    sentence: "Magic Context refused to start: its store (store.db) was migrated by a newer ck-mc build than the one running.",
    action: "Update ck-mc, or roll back by restoring ck-mc together with context.db and store.db from the same backup."
  },
  compaction_marker_missing: {
    code: "MC-C11",
    sentence: "The history boundary marker is missing from the OpenCode store, so requests carry the full session.",
    action: "It is retried on every message; if this persists, run `/ctx-flush`."
  },
  memory_mirror_stalled: {
    code: "MC-M01",
    sentence: "Memory synchronization stopped before the host mirror caught up.",
    action: "Send another message to resume it, or run `ck doctor drain-authority`."
  },
  memory_authority_mismatch: {
    code: "MC-M02",
    sentence: "Memory authority is inconsistent between the host and module.",
    action: "Run `ck doctor drain-authority` before changing Rust mode."
  },
  dreamer_task_failing: {
    code: "MC-S05",
    sentence: "A background maintenance task keeps failing on its schedule.",
    action: "Check the Magic Context log for the failing task and its error."
  }
};

// ../plugin/src/hooks/magic-context/single-store-refusal.ts
function renderSingleStoreMigrationRequiredRefusal() {
  const failure = USER_FACING_FAILURES.single_store_migration_required;
  return `${failure.sentence} ${failure.action} (${failure.code})`;
}
function projectNeedsSingleStoreMigration(db, projectPath) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'authority_managed'").get();
  return Boolean(table && db.prepare("SELECT 1 FROM authority_managed WHERE project_path = ?").get(projectPath));
}

// ../plugin/src/tools/ctx-memory/types.ts
var CTX_MEMORY_ACTIONS = ["write", "update", "archive", "merge", "get"];
var CTX_MEMORY_DREAMER_ACTIONS = [...CTX_MEMORY_ACTIONS, "list"];

// ../plugin/src/tools/ctx-memory/verification-recording.ts
function runImmediateTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  const transactionStartedAt = performance.now();
  try {
    const result = fn();
    db.exec("COMMIT");
    logSlowWriteTransaction("ctx_memory_mutation", transactionStartedAt);
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// ../plugin/src/tools/ctx-memory/tools.ts
var MEMORY_CATEGORIES = new Set(CATEGORY_PRIORITY);
function isMemoryCategory(value) {
  return MEMORY_CATEGORIES.has(value);
}
function normalizeLimit(limit) {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit === 0) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.max(1, Math.floor(limit));
}
function getAllowedActions(deps) {
  const allowed = deps.allowedActions?.length ? deps.allowedActions : CTX_MEMORY_ACTIONS;
  return [...allowed];
}
function normalizeCategory(category) {
  const trimmed = category?.trim();
  return trimmed ? trimmed : undefined;
}
function formatMemoryList(memories) {
  if (memories.length === 0) {
    return "No active memories found.";
  }
  const rows = memories.map((memory) => ({
    id: String(memory.id),
    category: memory.category,
    status: memory.status,
    verification: memory.verificationStatus,
    updated: new Date(memory.updatedAt).toISOString(),
    content: memory.content.replace(/\s+/g, " ").trim()
  }));
  const headers = {
    id: "ID",
    category: "CATEGORY",
    status: "STATUS",
    verification: "VERIFY",
    updated: "UPDATED",
    content: "CONTENT"
  };
  const widths = {
    id: Math.max(headers.id.length, ...rows.map((row) => row.id.length)),
    category: Math.max(headers.category.length, ...rows.map((row) => row.category.length)),
    status: Math.max(headers.status.length, ...rows.map((row) => row.status.length)),
    verification: Math.max(headers.verification.length, ...rows.map((row) => row.verification.length)),
    updated: Math.max(headers.updated.length, ...rows.map((row) => row.updated.length))
  };
  const formatRow = (row) => [
    row.id.padEnd(widths.id),
    row.category.padEnd(widths.category),
    row.status.padEnd(widths.status),
    row.verification.padEnd(widths.verification),
    row.updated.padEnd(widths.updated),
    row.content
  ].join(" | ");
  const allActive = memories.every((memory) => memory.status === "active");
  return [
    `Found ${rows.length} ${allActive ? "active " : ""}${rows.length === 1 ? "memory" : "memories"}:`,
    "",
    formatRow(headers),
    [
      "-".repeat(widths.id),
      "-".repeat(widths.category),
      "-".repeat(widths.status),
      "-".repeat(widths.verification),
      "-".repeat(widths.updated),
      "-------"
    ].join("-+-"),
    ...rows.map(formatRow)
  ].join(`
`);
}
function filterByCategory(memories, category) {
  if (!category) {
    return memories;
  }
  return memories.filter((memory) => memory.category === category);
}
var GET_NOT_VISIBLE_MESSAGE = (id) => `id ${id}: not found or not visible from this project`;
var GET_MAX_IDS = 20;
function formatGetOutput(args) {
  const parts = [];
  for (const id of args.requestedIds) {
    const memory = args.memoriesById.get(id);
    if (!memory) {
      parts.push(GET_NOT_VISIBLE_MESSAGE(id));
    } else {
      parts.push(formatMemoryList([memory]));
    }
  }
  return parts.join(`

`);
}
function queueMemoryEmbedding(args) {
  const snapshot = getProjectEmbeddingSnapshot(args.projectPath);
  if (!snapshot?.enabled) {
    return;
  }
  const normalizedHash = computeNormalizedHash(args.content);
  (async () => {
    const result = await embedTextForProject(args.projectPath, args.content);
    if (!result) {
      sessionLog(args.sessionId, `memory embedding skipped for memory ${args.memoryId}: provider unavailable or embedding generation failed.`);
      return;
    }
    const saved = saveEmbeddingIfHashMatches(args.deps.db, args.memoryId, result.vector, result.modelId, normalizedHash);
    if (!saved) {
      sessionLog(args.sessionId, `memory embedding skipped for memory ${args.memoryId}: content changed before the embedding finished.`);
      return;
    }
    enqueueShadowEmbeddingItems(args.projectPath, "memory", [String(args.memoryId)]);
    sessionLog(args.sessionId, `proactively embedded memory ${args.memoryId}.`);
  })().catch((error) => {
    sessionLog(args.sessionId, `memory embedding failed for memory ${args.memoryId}:`, error);
  });
}
function getValidatedCategory(category) {
  const trimmedCategory = category?.trim();
  if (!trimmedCategory) {
    return null;
  }
  if (!isMemoryCategory(trimmedCategory)) {
    return null;
  }
  return trimmedCategory;
}
function getDisabledMessage() {
  return "Cross-session memory is disabled for this project.";
}
function getSourceType(deps) {
  return deps.sourceType ?? "agent";
}
function requestRustMemorySync(deps, sessionId) {
  try {
    deps.rustToolBackends?.memorySync?.(sessionId);
  } catch (error) {
    sessionLog(sessionId, "rust memory sync trigger failed (ignored):", error);
  }
}
function projectPathForMemoryId(db, id) {
  const row = db.prepare("SELECT project_path FROM memories WHERE id = ?").get(id);
  return row?.project_path ?? null;
}
function projectIdentityForStoredPath(rawProjectPath) {
  return normalizeStoredProjectPath(rawProjectPath);
}
function preflightCurateMutation(args) {
  const { params } = args;
  if (params.action !== "archive" && params.action !== "update") {
    return { skip: null, successor: null };
  }
  const ids = params.ids;
  const content = params.content?.trim();
  if (!ids || ids.length === 0 || !ids.every(Number.isInteger) || params.action === "update" && (ids.length !== 1 || !content)) {
    return { skip: null, successor: null };
  }
  const uniqueIds = [...new Set(ids)];
  const memories = uniqueIds.map((id) => getMemoryById(args.db, id));
  if (memories.some((memory) => !memory)) {
    return { skip: null, successor: null };
  }
  const successor = Number.isInteger(params.superseded_by) ? getMemoryById(args.db, params.superseded_by) : null;
  const refusals = memories.flatMap((memory) => {
    if (!memory)
      return [];
    const refusal = assessCurateMutationSafety({
      memory,
      verdict: params.action,
      reason: params.reason,
      replacementContent: content,
      successor,
      projectIdentity: (candidate) => projectIdentityForStoredPath(candidate.projectPath)
    });
    return refusal ? [refusal] : [];
  });
  if (refusals.length === 0)
    return { skip: null, successor };
  let refused = 0;
  for (const refusal of refusals) {
    refused = recordCurateSafetyRefusal(args.sessionId, refusal);
  }
  const memoryIds = refusals.map((refusal) => refusal.memoryId).join(", ");
  const reasons = [...new Set(refusals.map((refusal) => refusal.reason))].join(",");
  return {
    skip: `Skipped ${params.action} for memory [ID: ${memoryIds}]: curate safety refusal (${reasons}); refused=${refused}.`,
    successor
  };
}
function isPrimaryMutableMemory(memory) {
  return (memory.status === "active" || memory.status === "permanent") && memory.supersededByMemoryId === null;
}
function inactiveMemoryError(id, action) {
  return `Error: Memory with ID ${id} is archived or superseded; restore it before ${action}.`;
}
function isUniqueConstraintError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  if (code === "SQLITE_CONSTRAINT_UNIQUE") {
    return true;
  }
  return /UNIQUE constraint failed/i.test(error.message);
}
var DUPLICATE_MEMORY_ERROR = (id) => `Error: Memory content already exists as ID ${id}; merge or archive duplicates instead.`;
function updateMemoryContentInCurrentTransaction(db, memory, content, normalizedHash, targetCategory = memory.category) {
  db.prepare("UPDATE memories SET content = ?, category = ?, normalized_hash = ?, updated_at = ? WHERE id = ?").run(content, targetCategory, normalizedHash, Date.now(), memory.id);
  if (hasMemoryShareableColumn(db)) {
    db.prepare("UPDATE memories SET shareable = 0 WHERE id = ?").run(memory.id);
  }
  if (hasMemoryClassifiedAtColumn(db)) {
    db.prepare("UPDATE memories SET classified_at = NULL WHERE id = ?").run(memory.id);
  }
  db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memory.id);
  clearMemoryVerifications(db, memory.id);
  invalidateMemory(memory.projectPath, memory.id);
}
var ctxMemoryArgsShape = {
  action: tool.schema.enum([...CTX_MEMORY_ACTIONS]).optional().describe("write | update | archive | merge | get"),
  content: tool.schema.string().optional().describe("The memory text — one standalone fact (write, update, merge)."),
  category: tool.schema.enum([...V2_MEMORY_CATEGORIES]).optional().describe("Kind of fact (required for write; on update/merge optional, omitted keeps the current category)."),
  ids: tool.schema.array(tool.schema.number()).optional().describe("Memory ids from <project-memory>: one for update, one or more for archive, two or more for merge, 1–20 for get."),
  reason: tool.schema.string().optional().describe("Why it is being archived (optional).")
};
var ctxMemoryListArgsShape = {
  category: tool.schema.enum([...V2_MEMORY_CATEGORIES]).optional().describe("Kind of fact (required for write; on update/merge optional, omitted keeps the current category)."),
  limit: tool.schema.number().optional().describe("Max results for list (default 10).")
};
var ctxMemoryArgsSchema = tool.schema.object({
  ...ctxMemoryArgsShape,
  superseded_by: tool.schema.number().optional(),
  limit: tool.schema.number().optional()
}).passthrough();
function createCtxMemoryTool(deps) {
  const allowedActions = getAllowedActions(deps);
  return tool({
    description: CTX_MEMORY_DESCRIPTION,
    args: ctxMemoryArgsShape,
    async execute(rawArgs, toolContext) {
      const parsedArgs = ctxMemoryArgsSchema.safeParse(rawArgs);
      let args = parsedArgs.success ? parsedArgs.data : rawArgs;
      args = unwrapImitatedReducedArgs(args, ["action"], {
        action: { type: "enum", values: CTX_MEMORY_DREAMER_ACTIONS },
        content: "string",
        category: { type: "enum", values: V2_MEMORY_CATEGORIES },
        ids: { type: "array", items: "number", maxItems: 100 },
        limit: "number",
        reason: "string",
        superseded_by: "number"
      });
      if (args.action === undefined || toolContext.agent !== DREAMER_AGENT && !allowedActions.includes(args.action)) {
        return `Error: Action '${args.action}' is not allowed in this context.`;
      }
      const projectPath = deps.resolveProjectPath(toolContext.directory);
      if (!projectPath) {
        return `Error: Could not resolve project identity for memory action: ${describeUnresolvedProjectIdentity(toolContext.directory)}`;
      }
      await deps.ensureProjectRegistered?.(toolContext.directory, deps.db);
      const activeCurateCategory = toolContext.agent === DREAMER_AGENT ? getActiveCurateCategory(deps.db, projectPath) : null;
      if (activeCurateCategory) {
        const usesCategory = ["write", "update", "merge", "list"].includes(args.action);
        const usesIds = ["update", "archive", "merge", "get"].includes(args.action);
        const usesSuccessor = args.action === "update" || args.action === "archive";
        const scopeRefusal = getCurateCategoryScopeRefusal({
          scope: activeCurateCategory,
          action: args.action,
          requestedCategory: usesCategory ? args.category : undefined,
          ids: usesIds ? [
            ...args.ids ?? [],
            ...usesSuccessor && Number.isInteger(args.superseded_by) ? [args.superseded_by] : []
          ] : [],
          categoryForId: (id) => {
            const category = getMemoryById(deps.db, id)?.category;
            return category ? curateCategoryForMemoryCategory(category) : null;
          }
        });
        if (scopeRefusal)
          return scopeRefusal;
      }
      const curatePreflight = toolContext.agent === DREAMER_AGENT ? preflightCurateMutation({
        db: deps.db,
        params: args,
        sessionId: toolContext.sessionID
      }) : { skip: null, successor: null };
      if (curatePreflight.skip)
        return curatePreflight.skip;
      const visibility = createMemoryVisibilityPolicy(deps.db, projectPath);
      if (projectNeedsSingleStoreMigration(deps.db, projectPath)) {
        return renderSingleStoreMigrationRequiredRefusal();
      }
      const targetIdentityForStoredPath = (rawProjectPath) => visibility.identityFor(rawProjectPath);
      const memoryVisibleToTool = (memory) => visibility.visible(memory);
      const memoryOwnedByTool = (memory) => visibility.owned(memory);
      const embeddingSnapshot = getProjectEmbeddingSnapshot(projectPath);
      if (embeddingSnapshot ? !embeddingSnapshot.features.memoryEnabled : deps.memoryEnabled === false) {
        return getDisabledMessage();
      }
      if (args.action === "write") {
        const content = args.content?.trim();
        if (!content) {
          return "Error: 'content' is required when action is 'write'.";
        }
        const rawCategory = args.category?.trim();
        if (!rawCategory) {
          return "Error: 'category' is required when action is 'write'.";
        }
        const category = getValidatedCategory(rawCategory);
        if (!category) {
          return `Error: Unknown memory category '${rawCategory}'.`;
        }
        const existingMemory = getMemoryByHash(deps.db, projectPath, category, computeNormalizedHash(content));
        if (existingMemory) {
          updateMemorySeenCount(deps.db, existingMemory.id);
          requestRustMemorySync(deps, toolContext.sessionID);
          return `Memory already exists [ID: ${existingMemory.id}] in ${category} (seen count incremented).`;
        }
        const insertResult = insertMemoryIdempotent(deps.db, {
          projectPath,
          category,
          content,
          sourceSessionId: toolContext.sessionID,
          sourceType: toolContext.agent === DREAMER_AGENT ? "dreamer" : getSourceType(deps)
        });
        if (!insertResult.inserted) {
          return `Memory already exists [ID: ${insertResult.memory.id}] in ${category} (seen count incremented).`;
        }
        queueMemoryEmbedding({
          deps,
          sessionId: toolContext.sessionID,
          projectPath,
          memoryId: insertResult.memory.id,
          content
        });
        requestRustMemorySync(deps, toolContext.sessionID);
        return `Saved memory [ID: ${insertResult.memory.id}] in ${category}.`;
      }
      if (args.action === "list") {
        const limit = normalizeLimit(args.limit);
        const category = normalizeCategory(args.category);
        const allMemories = getMemoriesByProject(deps.db, projectPath);
        const memories = (activeCurateCategory ? allMemories.filter((memory) => curateCategoryForMemoryCategory(memory.category) === activeCurateCategory) : filterByCategory(allMemories, category)).slice(0, limit);
        return formatMemoryList(memories);
      }
      if (args.action === "get") {
        const getIds = args.ids;
        if (!getIds || getIds.length === 0 || !getIds.every(Number.isInteger)) {
          return "Error: 'ids' must contain at least one integer memory ID when action is 'get'.";
        }
        if (getIds.length > GET_MAX_IDS) {
          return `Error: 'ids' must contain at most ${GET_MAX_IDS} memory IDs when action is 'get' (got ${getIds.length}).`;
        }
        const uniqueIds = [...new Set(getIds)];
        const fetched = getMemoriesByIds(deps.db, uniqueIds);
        const memoriesById = new Map(fetched.filter((memory) => memoryVisibleToTool(memory)).map((memory) => [memory.id, memory]));
        return formatGetOutput({
          requestedIds: uniqueIds,
          memoriesById
        });
      }
      if (args.action === "update") {
        const updateIds = args.ids;
        if (updateIds?.length !== 1 || !updateIds.every(Number.isInteger)) {
          return "Error: 'ids' must contain exactly one integer memory ID when action is 'update'.";
        }
        const updateId = updateIds[0];
        const content = args.content?.trim();
        if (!content) {
          return "Error: 'content' is required when action is 'update'.";
        }
        const rawProjectPath = projectPathForMemoryId(deps.db, updateId);
        const memory = getMemoryById(deps.db, updateId);
        const updateAllowed = memory ? toolContext.agent === DREAMER_AGENT ? memoryVisibleToTool(memory) : memoryOwnedByTool(memory) : false;
        if (!memory || !rawProjectPath || !updateAllowed) {
          return `Error: Memory with ID ${updateId} was not found.`;
        }
        if (toolContext.agent !== DREAMER_AGENT && !isPrimaryMutableMemory(memory)) {
          return inactiveMemoryError(updateId, "updating");
        }
        const normalizedHash = computeNormalizedHash(content);
        const targetCategory = args.category && V2_MEMORY_CATEGORIES.includes(args.category) ? args.category : memory.category;
        const projectIdentity = targetIdentityForStoredPath(rawProjectPath);
        let duplicateId = null;
        try {
          runImmediateTransaction(deps.db, () => {
            const duplicate = getMemoryByHash(deps.db, rawProjectPath, targetCategory, normalizedHash);
            if (duplicate && duplicate.id !== memory.id) {
              duplicateId = duplicate.id;
              return;
            }
            updateMemoryContentInCurrentTransaction(deps.db, memory, content, normalizedHash, targetCategory);
            queueMemoryMutation(deps.db, {
              projectPath: projectIdentity,
              mutationType: "update",
              targetMemoryId: memory.id,
              category: targetCategory,
              newContent: content
            });
          });
        } catch (error) {
          if (!isUniqueConstraintError(error)) {
            throw error;
          }
          const raced = getMemoryByHash(deps.db, rawProjectPath, targetCategory, normalizedHash);
          if (raced && raced.id !== memory.id) {
            return DUPLICATE_MEMORY_ERROR(raced.id);
          }
          throw error;
        }
        if (duplicateId !== null) {
          return DUPLICATE_MEMORY_ERROR(duplicateId);
        }
        queueMemoryEmbedding({
          deps,
          sessionId: toolContext.sessionID,
          projectPath: projectIdentity,
          memoryId: memory.id,
          content
        });
        requestRustMemorySync(deps, toolContext.sessionID);
        return `Updated memory [ID: ${memory.id}] in ${targetCategory}.`;
      }
      if (args.action === "merge") {
        const ids = args.ids;
        if (!ids || ids.length < 2 || !ids.every(Number.isInteger)) {
          return "Error: 'ids' must include at least two integer memory IDs when action is 'merge'.";
        }
        if (new Set(ids).size !== ids.length) {
          return "Error: 'ids' must include at least two distinct memory IDs when action is 'merge'.";
        }
        const content = args.content?.trim();
        if (!content) {
          return "Error: 'content' is required when action is 'merge'.";
        }
        const sourceMemories = ids.map((id) => getMemoryById(deps.db, id)).filter((memory) => Boolean(memory));
        if (sourceMemories.length !== ids.length) {
          return "Error: One or more source memories were not found.";
        }
        if (toolContext.agent !== DREAMER_AGENT) {
          const foreign = sourceMemories.find((memory) => !memoryOwnedByTool(memory));
          if (foreign) {
            return `Error: Memory with ID ${foreign.id} was not found.`;
          }
          const inactive = sourceMemories.find((memory) => !isPrimaryMutableMemory(memory));
          if (inactive) {
            return inactiveMemoryError(inactive.id, "merging");
          }
        } else if (visibility.workspaced) {
          const blocked = sourceMemories.find((memory) => !memoryVisibleToTool(memory));
          if (blocked) {
            return `Error: Memory with ID ${blocked.id} is in a category not shared with this workspace member and cannot be merged.`;
          }
        }
        const sourceCategories = new Set(sourceMemories.map((memory) => memory.category));
        if (sourceCategories.size > 1) {
          return `Error: Cannot merge memories from different categories (${[...sourceCategories].join(", ")}). If they are genuine duplicates, one is miscategorized — archive the redundant one instead of merging across categories.`;
        }
        const category = getValidatedCategory(args.category) ?? sourceMemories[0]?.category ?? null;
        if (!category) {
          return "Error: A valid category is required when action is 'merge'.";
        }
        const normalizedHash = computeNormalizedHash(content);
        const mergedFrom = JSON.stringify(Array.from(new Set(sourceMemories.flatMap((memory) => {
          let parsed;
          try {
            parsed = memory.mergedFrom ? JSON.parse(memory.mergedFrom) : [];
          } catch {
            parsed = [];
          }
          return [
            memory.id,
            ...Array.isArray(parsed) ? parsed.filter((value) => typeof value === "number") : []
          ];
        }))).sort((left, right) => left - right));
        const mergedSeenCount = sourceMemories.reduce((sum, memory) => sum + memory.seenCount, 0);
        const mergedRetrievalCount = sourceMemories.reduce((sum, memory) => sum + memory.retrievalCount, 0);
        const mergedStatus = sourceMemories.some((memory) => memory.status === "permanent") ? "permanent" : "active";
        let mergeConflict = null;
        const canonicalMemory = runImmediateTransaction(deps.db, () => {
          const lockedDuplicate = getMemoryByHash(deps.db, projectPath, category, normalizedHash);
          const canonicalExisting = lockedDuplicate && ids.includes(lockedDuplicate.id) ? lockedDuplicate : null;
          if (lockedDuplicate && !canonicalExisting) {
            mergeConflict = `Error: Memory content already exists as ID ${lockedDuplicate.id}; update or archive existing duplicates instead.`;
            return null;
          }
          const nextCanonical = canonicalExisting?.id != null ? canonicalExisting : insertMemoryIdempotent(deps.db, {
            projectPath,
            category,
            content,
            sourceSessionId: toolContext.sessionID,
            sourceType: toolContext.agent === DREAMER_AGENT ? "dreamer" : getSourceType(deps)
          }).memory;
          const canonicalContentChanged = nextCanonical.content !== content || nextCanonical.normalizedHash !== normalizedHash;
          if (canonicalContentChanged) {
            updateMemoryContentInCurrentTransaction(deps.db, nextCanonical, content, normalizedHash);
          }
          mergeMemoryStats(deps.db, nextCanonical.id, mergedSeenCount, mergedRetrievalCount, mergedFrom, mergedStatus);
          for (const memory of sourceMemories) {
            if (memory.id === nextCanonical.id) {
              continue;
            }
            supersededMemory(deps.db, memory.id, nextCanonical.id);
            queueMemoryMutation(deps.db, {
              projectPath: projectIdentityForStoredPath(memory.projectPath),
              mutationType: "superseded",
              targetMemoryId: memory.id,
              supersededById: nextCanonical.id
            });
          }
          if (canonicalExisting && canonicalContentChanged) {
            queueMemoryMutation(deps.db, {
              projectPath: projectIdentityForStoredPath(nextCanonical.projectPath),
              mutationType: "update",
              targetMemoryId: nextCanonical.id,
              category,
              newContent: content
            });
          }
          return nextCanonical;
        });
        if (mergeConflict || !canonicalMemory) {
          return mergeConflict ?? "Error: Failed to merge memories.";
        }
        queueMemoryEmbedding({
          deps,
          sessionId: toolContext.sessionID,
          projectPath,
          memoryId: canonicalMemory.id,
          content
        });
        requestRustMemorySync(deps, toolContext.sessionID);
        const supersededIds = sourceMemories.map((memory) => memory.id).filter((id) => id !== canonicalMemory.id);
        return `Merged memories [${ids.join(", ")}] into canonical memory [ID: ${canonicalMemory.id}] in ${category}; superseded [${supersededIds.join(", ")}].`;
      }
      if (args.action === "archive") {
        const rawArchiveIds = args.ids;
        if (!rawArchiveIds || rawArchiveIds.length === 0 || !rawArchiveIds.every(Number.isInteger)) {
          return "Error: 'ids' must contain at least one integer memory ID when action is 'archive'.";
        }
        const archiveIds = [...new Set(rawArchiveIds)];
        const targets = [];
        for (const memoryId of archiveIds) {
          const rawProjectPath = projectPathForMemoryId(deps.db, memoryId);
          const memory = getMemoryById(deps.db, memoryId);
          const archiveAllowed = memory ? toolContext.agent === DREAMER_AGENT ? memoryVisibleToTool(memory) : memoryOwnedByTool(memory) : false;
          if (!memory || !rawProjectPath || !archiveAllowed) {
            return `Error: Memory with ID ${memoryId} was not found.`;
          }
          if (toolContext.agent !== DREAMER_AGENT && !isPrimaryMutableMemory(memory)) {
            return inactiveMemoryError(memoryId, "archiving");
          }
          targets.push({
            memoryId,
            projectIdentity: targetIdentityForStoredPath(rawProjectPath)
          });
        }
        runImmediateTransaction(deps.db, () => {
          for (const target of targets) {
            archiveMemory(deps.db, target.memoryId, args.reason);
            if (toolContext.agent === DREAMER_AGENT && curatePreflight.successor) {
              supersededMemory(deps.db, target.memoryId, curatePreflight.successor.id);
              queueMemoryMutation(deps.db, {
                projectPath: target.projectIdentity,
                mutationType: "superseded",
                targetMemoryId: target.memoryId,
                supersededById: curatePreflight.successor.id
              });
            } else {
              queueMemoryMutation(deps.db, {
                projectPath: target.projectIdentity,
                mutationType: "archive",
                targetMemoryId: target.memoryId
              });
            }
          }
        });
        requestRustMemorySync(deps, toolContext.sessionID);
        const idList = targets.map((t) => t.memoryId).join(", ");
        const plural = targets.length > 1 ? "memories" : "memory";
        return args.reason?.trim() ? `Archived ${plural} [ID: ${idList}] (${args.reason.trim()}).` : `Archived ${plural} [ID: ${idList}].`;
      }
      return "Error: Unknown action.";
    }
  });
}
function createCtxMemoryTools(deps) {
  return {
    [CTX_MEMORY_TOOL_NAME]: createCtxMemoryTool(deps)
  };
}
// ../plugin/src/tools/ctx-note/constants.ts
var CTX_NOTE_DESCRIPTION = `Session notes are pending intentions: work you intend to return to, with its findings attached.

Use notes for:
- A finding to revisit when you return to the intended work
- A decision with its reasoning, when follow-up work remains
- A backlog item with evidence already found
- Something the user explicitly asks you to note

Don't use notes for: the next few steps; a plan you are actively executing; restart/fold insurance; or a record of how things stand (world-state, a design at a point in time) with nothing you intend to do about it — that goes stale silently; a fact worth keeping is memory, the rest is nothing. Use todos for active work. If the detail already lives in a file, record the path and what to inspect — don't copy the file into a note. Durable project facts belong in ctx_memory, not notes.

First line is the title (under 80 chars), followed by detail. Operations:
- write: save a new note (content required)
- read: one row per note — \`#id · age · title\` — ready smart notes first, then newest; rows untouched 30+ days are marked stale. Pass note_ids to read full bodies; limit/offset page; filter selects other statuses.
- update: change one note (note_ids=[N])
- dismiss: retire 1–50 notes (note_ids). Dismiss a note when its work lands or is abandoned; a queue you never dismiss from stops being read.
- surface_condition: make it a smart note — an outside checker periodically tests the condition using only externally verifiable signals (GitHub state, files, git, releases, web), never this conversation or future actions; the note is parked until the condition holds.`;
// ../plugin/src/features/magic-context/smart-notes/condition-compiler.ts
import { existsSync } from "node:fs";
import { isAbsolute as isAbsolute2 } from "node:path";

// ../retina-local-fs/src/path-fence.ts
import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// ../retina-local-fs/src/errors.ts
class ProviderError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ProviderError";
  }
}

// ../retina-local-fs/src/path-fence.ts
async function resolveAndFenceProviderPath(configuredPath, options) {
  const { home, dataDirectory, aliases } = await resolveFenceRoots(options);
  const expanded = configuredPath.startsWith("~/") ? join(home, configuredPath.slice(2)) : configuredPath === "~" ? home : configuredPath;
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(options.cwd ?? process.cwd(), expanded);
  const canonical = await canonicalPath(absolute, options.allowMissing);
  if (fenceCandidates(canonical, aliases).some((candidate) => isFencedPath(candidate, home, dataDirectory))) {
    throw new ProviderError("fenced_path", `Refusing fenced path: ${canonical}`);
  }
  return canonical;
}
var FENCED_CORTEXKIT_ROOTS = ["plexus", "claustrum", "staging", "run", "magic-context"];
async function resolveFenceRoots(options) {
  const configuredHomePath = resolve(options.homeDirectory ?? process.env.HOME ?? homedir());
  let home;
  try {
    home = await realpath(configuredHomePath);
  } catch (error) {
    throw fsError(configuredHomePath, error);
  }
  const configuredDataDirectory = resolve(options.dataDirectory ?? process.env.XDG_DATA_HOME ?? join(home, ".local", "share"));
  const dataDirectory = await canonicalPath(configuredDataDirectory, true);
  const aliases = [];
  const logicalCortexkit = join(dataDirectory, "cortexkit");
  for (const logical of [
    logicalCortexkit,
    ...FENCED_CORTEXKIT_ROOTS.map((root) => join(logicalCortexkit, root))
  ]) {
    const canonical = await canonicalPath(logical, true);
    if (canonical !== logical)
      aliases.push({ logical, canonical });
  }
  return { home, dataDirectory, aliases };
}
function fenceCandidates(canonical, aliases) {
  const candidates = [canonical];
  for (const alias of aliases) {
    const relativeToAlias = relative(alias.canonical, canonical);
    const inside = relativeToAlias === "" || relativeToAlias !== ".." && !relativeToAlias.startsWith(`..${sep}`) && !isAbsolute(relativeToAlias);
    if (inside)
      candidates.push(join(alias.logical, relativeToAlias));
  }
  return candidates;
}
async function canonicalPath(path, allowMissing) {
  try {
    return await realpath(path);
  } catch (error) {
    if (!allowMissing || !isMissingError(error)) {
      throw fsError(path, error);
    }
    const suffix = [];
    let candidate = path;
    while (true) {
      try {
        const metadata = await lstat(candidate);
        if (metadata.isSymbolicLink()) {
          const target = await readlink(candidate);
          const resolvedTarget = resolve(dirname(candidate), target);
          return canonicalPath(join(resolvedTarget, ...suffix), true);
        }
      } catch (candidateError) {
        if (!isMissingError(candidateError)) {
          throw fsError(path, candidateError);
        }
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw fsError(path, error);
      }
      suffix.unshift(basename(candidate));
      candidate = parent;
      try {
        return join(await realpath(candidate), ...suffix);
      } catch (parentError) {
        if (!isMissingError(parentError)) {
          throw fsError(path, parentError);
        }
      }
    }
  }
}
function isFencedPath(canonicalPath, homeDirectory, dataDirectory = process.env.XDG_DATA_HOME ?? join(resolve(homeDirectory), ".local", "share")) {
  const cortexkitRoot = join(resolve(dataDirectory), "cortexkit");
  const relativeToCortexkit = relative(cortexkitRoot, canonicalPath);
  const insideCortexkit = relativeToCortexkit !== "" && relativeToCortexkit !== ".." && !relativeToCortexkit.startsWith(`..${sep}`) && !isAbsolute(relativeToCortexkit);
  const parts = insideCortexkit ? relativeToCortexkit.split(sep) : [];
  const pathParts = canonicalPath.split(sep).filter(Boolean);
  const name = basename(canonicalPath);
  const catalogDirectoryCarveIn = pathParts.includes("catalog");
  const moduleBinCarveIn = parts.length >= 2 && parts[1] === "bin";
  const catalogJsonCarveIn = name.endsWith(".json") && name.includes("catalog");
  const rootWithoutCarveIns = insideCortexkit && (parts[0] === "run" || parts[0] === "magic-context");
  if (!rootWithoutCarveIns && (catalogDirectoryCarveIn || moduleBinCarveIn || catalogJsonCarveIn)) {
    return false;
  }
  const inFencedRoot = insideCortexkit && FENCED_CORTEXKIT_ROOTS.includes(parts[0] ?? "");
  const fencedBasename = name.includes("binding-key") || name.endsWith(".handle");
  const plexusStore = insideCortexkit && parts[0] === "plexus" && name.startsWith("store.db");
  return inFencedRoot || fencedBasename || plexusStore;
}
function fsError(path, error) {
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError("unreadable_path", `Could not read ${path}: ${message}`);
}
function isMissingError(error) {
  return error !== null && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

// ../retina-local-fs/src/provider.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
function parseSemver(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) {
    throw new ProviderError("invalid_config", `Invalid semantic version: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part) : []
  };
}
function validateProviderConfig(input) {
  try {
    return { success: true, config: parseConfig(input) };
  } catch (error) {
    return {
      success: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
function parseConfig(value) {
  const config = requireObject(value, "config");
  if ("any" in config) {
    requireOnlyKeys(config, ["any"], "compound config");
    if (!Array.isArray(config.any) || config.any.length < 1 || config.any.length > 4) {
      invalid("config.any must contain between 1 and 4 predicates");
    }
    return { any: config.any.map(parseAtomicPredicate) };
  }
  return parseAtomicPredicate(config);
}
function parseAtomicPredicate(value) {
  const predicate = requireObject(value, "predicate");
  if (typeof predicate.kind !== "string") {
    invalid("predicate.kind must be a string");
  }
  switch (predicate.kind) {
    case "file_contains":
      requireOnlyKeys(predicate, ["kind", "path", "needle", "absent", "resolved_path_exists"], predicate.kind);
      return {
        kind: predicate.kind,
        path: requireString(predicate.path, "path"),
        needle: requireString(predicate.needle, "needle", true),
        ...optionalBoolean(predicate.absent, "absent") === undefined ? {} : { absent: predicate.absent },
        ...predicateAudit(predicate)
      };
    case "path_exists":
      requireOnlyKeys(predicate, ["kind", "path", "gone", "resolved_path_exists"], predicate.kind);
      return {
        kind: predicate.kind,
        path: requireString(predicate.path, "path"),
        ...optionalBoolean(predicate.gone, "gone") === undefined ? {} : { gone: predicate.gone },
        ...predicateAudit(predicate)
      };
    case "mtime_after":
      requireOnlyKeys(predicate, ["kind", "path", "since_ms", "resolved_path_exists"], predicate.kind);
      return {
        kind: predicate.kind,
        path: requireString(predicate.path, "path"),
        since_ms: requireFiniteNumber(predicate.since_ms, "since_ms"),
        ...predicateAudit(predicate)
      };
    case "git_commit_after":
      requireOnlyKeys(predicate, ["kind", "repo_path", "ref", "sha", "resolved_path_exists"], predicate.kind);
      return {
        kind: predicate.kind,
        repo_path: requireString(predicate.repo_path, "repo_path"),
        sha: requireGitArgument(predicate.sha, "sha"),
        ...predicate.ref === undefined ? {} : { ref: requireGitArgument(predicate.ref, "ref") },
        ...predicateAudit(predicate)
      };
    case "git_tag_matching": {
      requireOnlyKeys(predicate, ["kind", "repo_path", "pattern", "above", "resolved_path_exists"], predicate.kind);
      const above = predicate.above === undefined ? undefined : requireString(predicate.above, "above");
      if (above !== undefined) {
        parseSemver(above);
      }
      return {
        kind: predicate.kind,
        repo_path: requireString(predicate.repo_path, "repo_path"),
        pattern: requireGitArgument(predicate.pattern, "pattern"),
        ...above === undefined ? {} : { above },
        ...predicateAudit(predicate)
      };
    }
    default:
      invalid(`Unsupported predicate kind: ${predicate.kind}`);
  }
}
function requireObject(value, field) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object`);
  }
  return value;
}
function requireOnlyKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    invalid(`${field} contains unknown field(s): ${unknown.join(", ")}`);
  }
}
function requireString(value, field, allowEmpty = false) {
  if (typeof value !== "string" || !allowEmpty && value.length === 0) {
    invalid(`${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}
function requireGitArgument(value, field) {
  const text = requireString(value, field);
  if (text.startsWith("-")) {
    invalid(`${field} must not start with "-"`);
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    invalid(`${field} must not contain control characters`);
  }
  return text;
}
function predicateAudit(predicate) {
  const exists = optionalBoolean(predicate.resolved_path_exists, "resolved_path_exists");
  return exists === undefined ? {} : { resolved_path_exists: exists };
}
function optionalBoolean(value, field) {
  if (value !== undefined && typeof value !== "boolean") {
    invalid(`${field} must be a boolean`);
  }
  return value;
}
function requireFiniteNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${field} must be a finite number`);
  }
  return value;
}
function invalid(message) {
  throw new ProviderError("invalid_config", message);
}

// ../plugin/src/features/magic-context/smart-notes/condition-compiler.ts
var RETINA_LOCAL_FS_PROVIDER = "local-fs";
var VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)`;
async function compileSurfaceCondition(surfaceCondition, options) {
  const plainReason = unsafeGrammarReason(surfaceCondition);
  if (plainReason)
    return { status: "plain", reason: plainReason };
  const parsed = parseCondition(surfaceCondition, options.projectPath);
  if (parsed === null)
    return { status: "plain" };
  const now = (options.now ?? Date.now)();
  const resolvePath = options.resolvePath ?? (async (path) => {
    const resolved = await resolveAndFenceProviderPath(path, {
      allowMissing: true,
      homeDirectory: options.homeDirectory,
      dataDirectory: options.dataDirectory,
      cwd: options.projectPath
    });
    return { path: resolved, exists: existsSync(resolved) };
  });
  let predicates;
  try {
    predicates = [];
    for (const predicate of parsed) {
      predicates.push(await resolvePredicate(predicate, resolvePath, now));
    }
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    return {
      status: "refused",
      reason: code === "fenced_path" ? "fenced path" : "path resolution failed"
    };
  }
  const candidate = predicates.length === 1 ? predicates[0] : { any: predicates };
  const validation = validateProviderConfig(candidate);
  if (!validation.success) {
    return {
      status: "refused",
      reason: `provider schema: ${singleLine(validation.reason)}`.slice(0, 180)
    };
  }
  return {
    status: "compiled",
    provider: RETINA_LOCAL_FS_PROVIDER,
    config: validation.config,
    compiledAt: now
  };
}
function conditionCompileStorageFields(result) {
  if (result.status === "compiled") {
    return {
      compiledProvider: result.provider,
      compiledConfig: JSON.stringify(result.config),
      compiledAt: result.compiledAt,
      compileStatus: result.status
    };
  }
  return {
    compiledProvider: null,
    compiledConfig: null,
    compiledAt: null,
    compileStatus: result.status
  };
}
function conditionCompileReplySuffix(result) {
  if (result.status === "compiled") {
    return `
- Retina provider: ${result.provider}`;
  }
  if (result.status === "refused") {
    return `
- Retina compile refused: ${result.reason}`;
  }
  return "";
}
function parseCondition(surfaceCondition, projectPath) {
  const trimmed = surfaceCondition.trim();
  const either = trimmed.match(/^either\s+(.+)$/i);
  if (!either) {
    const predicate = parseAtomicCondition(trimmed, projectPath);
    return predicate ? [predicate] : null;
  }
  const clauses = splitOrClauses(either[1]);
  if (clauses.length < 2)
    return null;
  const predicates = clauses.map((clause) => parseAtomicCondition(clause, projectPath));
  return predicates.every((predicate) => predicate !== null) ? predicates : null;
}
function parseAtomicCondition(text, projectPath) {
  const fileContains = text.match(new RegExp(`^(?:when\\s+)?file\\s+(${VALUE})\\s+(no longer contains|contains)\\s+(${VALUE})$`, "i"));
  if (fileContains) {
    const path = unquote(fileContains[1]);
    const needle = unquote(fileContains[3].trim());
    if (path === null || needle === null)
      return null;
    return {
      kind: "file_contains",
      path,
      needle,
      ...fileContains[2].toLowerCase() === "no longer contains" ? { absent: true } : {}
    };
  }
  const commit = text.match(new RegExp(`^(?:when\\s+)?(?:repo(?:sitory)?\\s+)?(${VALUE})\\s+has\\s+a\\s+commit\\s+(?:after|newer than)\\s+([0-9a-f]{7,64})$`, "i"));
  if (commit) {
    const repoPath = unquote(commit[1]);
    if (repoPath === null)
      return null;
    return {
      kind: "git_commit_after",
      repo_path: repoPath,
      sha: commit[2]
    };
  }
  const tag = text.match(new RegExp(`^(?:when\\s+)?a\\s+tag\\s+(?:(?:matching\\s+(${VALUE})(?:\\s+above\\s+semver\\s+(${VALUE}))?)|(?:above\\s+semver\\s+(${VALUE})))\\s+appears(?:\\s+in\\s+(?:repo(?:sitory)?\\s+)?(${VALUE}))?$`, "i"));
  if (tag) {
    const pattern = tag[1] ? unquote(tag[1]) : "*";
    const above = unquote(tag[2] ?? tag[3] ?? "");
    const repoPath = tag[4] ? unquote(tag[4]) : projectPath;
    if (pattern === null || above === null || repoPath === null)
      return null;
    return {
      kind: "git_tag_matching",
      repo_path: repoPath,
      pattern,
      ...above.length > 0 ? { above } : {}
    };
  }
  const mtime = text.match(new RegExp(`^(?:when\\s+)?(?:file\\s+)?(${VALUE})\\s+(changes|is rebuilt|mtime moves)$`, "i"));
  if (mtime) {
    const path = unquote(mtime[1]);
    if (path === null)
      return null;
    return {
      kind: "mtime_after",
      path
    };
  }
  const pathExists = text.match(new RegExp(`^(?:when\\s+)?(?:path\\s+)?(${VALUE})\\s+(exists|is gone)$`, "i"));
  if (pathExists) {
    const path = unquote(pathExists[1]);
    if (path === null)
      return null;
    return {
      kind: "path_exists",
      path,
      ...pathExists[2].toLowerCase() === "is gone" ? { gone: true } : {}
    };
  }
  return null;
}
async function resolvePredicate(predicate, resolvePath, now) {
  const configuredPath = "repo_path" in predicate ? predicate.repo_path : predicate.path;
  const resolved = await resolvePath(configuredPath);
  const sourceIsResolvable = isAbsolute2(configuredPath) || configuredPath === "~" || configuredPath.startsWith("~/");
  const audit = sourceIsResolvable && resolved.exists ? {} : { resolved_path_exists: false };
  switch (predicate.kind) {
    case "file_contains":
      return { ...predicate, path: resolved.path, ...audit };
    case "path_exists":
      return { ...predicate, path: resolved.path, ...audit };
    case "mtime_after":
      return { kind: predicate.kind, path: resolved.path, since_ms: now, ...audit };
    case "git_commit_after":
      return { ...predicate, repo_path: resolved.path, ...audit };
    case "git_tag_matching":
      return { ...predicate, repo_path: resolved.path, ...audit };
  }
}
function splitOrClauses(text) {
  const clauses = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0;index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? null : quote === null ? character : quote;
      continue;
    }
    if (quote !== null)
      continue;
    const separator = text.slice(index).match(/^\s+or\s+/i);
    if (!separator)
      continue;
    clauses.push(text.slice(start, index).trim());
    index += separator[0].length - 1;
    start = index + 1;
  }
  clauses.push(text.slice(start).trim());
  return clauses.filter(Boolean);
}
function unsafeGrammarReason(value) {
  let quote = null;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? null : quote === null ? character : quote;
    }
  }
  if (quote !== null)
    return "unbalanced quote; leaving condition dreamer-evaluated";
  if (/\bcontains\s+no(?:\s|$)/i.test(value)) {
    return "ambiguous negation after contains; leaving condition dreamer-evaluated";
  }
  const temporalSuffix = new RegExp(`\\bcontains\\s+${VALUE}\\s+(?:since|until|after|before|when|while|for|as\\s+of)\\b`, "i");
  if (temporalSuffix.test(value)) {
    return "temporal suffix after contains; leaving condition dreamer-evaluated";
  }
  return null;
}
function unquote(value) {
  const quote = value[0];
  const final = value.at(-1);
  const startsQuoted = quote === '"' || quote === "'";
  const endsQuoted = final === '"' || final === "'";
  if (!startsQuoted && !endsQuoted)
    return value;
  if (!startsQuoted || final !== quote || value.length < 2)
    return null;
  if (quote === '"') {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}
function singleLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

// ../plugin/src/features/magic-context/smart-notes/wake-plane.ts
import { join as join2 } from "node:path";
var WAKE_PLANE_CAPABILITY = "wake.create";
var WAKE_PLANE_STATUS_TTL_MS = 5 * 60 * 1000;
var WAKE_PLANE_HANDSHAKE_TIMEOUT_MS = 2000;
var cachedStatus = null;
var inFlightProbe = null;
var catalogProbe = probeWakePlaneCatalog;
var now = () => Date.now();
function connectionFile() {
  return join2(getDataDir(), "cortexkit", "run", "subc-connection.json");
}
async function probeWakePlaneCatalog() {
  const file = connectionFile();
  if (!await connectionFileExists(file)) {
    throw new Error("subc connection is not configured");
  }
  const client = await SubcClient.connect({
    connectionFile: file,
    handshakeTimeoutMs: WAKE_PLANE_HANDSHAKE_TIMEOUT_MS
  });
  try {
    return await client.catalogList();
  } finally {
    client.close();
  }
}
function catalogHasWakePlane(entries) {
  return entries.some((entry) => Array.isArray(entry.control_ops) && entry.control_ops.includes(WAKE_PLANE_CAPABILITY));
}
async function probeStatus() {
  try {
    return catalogHasWakePlane(await catalogProbe()) ? "present" : "absent";
  } catch {
    return "unknown";
  }
}
async function wakePlaneStatus() {
  const cached = cachedStatus;
  if (cached && now() < cached.expiresAt)
    return cached.status;
  if (inFlightProbe)
    return await inFlightProbe;
  const startedAt = now();
  const probe = probeStatus().then((status) => {
    cachedStatus = { status, expiresAt: startedAt + WAKE_PLANE_STATUS_TTL_MS };
    return status;
  });
  inFlightProbe = probe;
  try {
    return await probe;
  } finally {
    if (inFlightProbe === probe)
      inFlightProbe = null;
  }
}

// ../plugin/src/tools/ctx-note/tools.ts
function captureAnchorOrdinal(db, sessionId) {
  try {
    const ordinal = getLastIndexedOrdinal(db, sessionId);
    return ordinal > 0 ? ordinal : null;
  } catch {
    return null;
  }
}
var DISMISS_FOOTER = `

To dismiss a stale note: ctx_note(action="dismiss", note_ids=[N])`;
var DEFAULT_READ_LIMIT = 25;
function readGlanceNotes(args) {
  if (args.filter === undefined) {
    const sessionNotes = getSessionNotes(args.db, args.sessionId);
    const readySmartNotes = args.projectIdentity ? getReadySmartNotes(args.db, args.projectIdentity) : [];
    const pendingSmartNotes = args.projectIdentity ? getPendingSmartNotes(args.db, args.projectIdentity) : [];
    return [...sessionNotes, ...readySmartNotes, ...pendingSmartNotes];
  }
  const statusByFilter = {
    active: "active",
    all: ["active", "pending", "ready", "dismissed"],
    dismissed: "dismissed",
    pending: "pending",
    ready: "ready"
  };
  const sessionNotes = getNotes(args.db, {
    sessionId: args.sessionId,
    type: "session",
    status: statusByFilter[args.filter]
  });
  const smartNotes = args.projectIdentity ? getNotes(args.db, {
    projectPath: args.projectIdentity,
    type: "smart",
    status: statusByFilter[args.filter]
  }) : [];
  return [...sessionNotes, ...smartNotes];
}
function writeTray(db, sessionId) {
  const active = getSessionNotes(db, sessionId);
  const oldest = active.reduce((min, note) => {
    const touchedAt = noteTouchedAt(note);
    return min === null || touchedAt < min ? touchedAt : min;
  }, null);
  return { activeCount: active.length, oldestTouchedAt: oldest };
}
var ctxNoteArgsShape = {
  action: tool.schema.enum(["write", "read", "dismiss", "update"]).optional().describe("write | read | update | dismiss. Defaults to write when content is given, else read."),
  content: tool.schema.string().optional().describe("Note text for write/update: first line is the title (under 80 chars), then the detail."),
  surface_condition: tool.schema.string().optional().describe("Makes this a smart note: a condition an outside checker can verify on its own, periodically — repository state, releases, web pages, anything it can look up — never something only this conversation knows. The note is parked until the condition holds."),
  filter: tool.schema.enum(["all", "active", "pending", "ready", "dismissed"]).optional().describe("Read filter: all, active, pending (unsurfaced smart notes), ready, dismissed. Omitted, it shows active session notes plus every current smart note (pending included); active shows only notes whose stored status is active."),
  limit: tool.schema.number().optional().describe("Rows per read (default 25)."),
  offset: tool.schema.number().optional().describe("Skip this many newest rows (default 0)."),
  note_ids: tool.schema.array(tool.schema.number().int().min(1)).min(1).max(50).optional().describe("Note ids: one for update, 1–50 for dismiss or read (read returns full bodies). Ignored by write.")
};
var ctxNoteArgsSchema = tool.schema.object(ctxNoteArgsShape).passthrough();
function formatDismissResults(results) {
  const dismissedCount = results.filter((result) => result.outcome === "dismissed").length;
  return `Dismissed ${dismissedCount} of ${results.length} notes.
${results.map((result) => `- Note #${result.noteId}: ${result.outcome === "not_owned" ? "not_found" : result.outcome}`).join(`
`)}`;
}
function formatNotesById(db, noteIds, scope, nowMs) {
  return renderNotesById(noteIds.map((noteId) => ({ noteId, note: getNoteByIdInScope(db, noteId, scope) })), nowMs);
}
function parseNoteIds(action, value) {
  const max = action === "update" ? 1 : 50;
  if (!Array.isArray(value) || value.length < 1 || value.length > max || value.some((id) => typeof id !== "number" || !Number.isInteger(id) || id <= 0)) {
    return action === "update" ? "Error: 'note_ids' must contain exactly one positive integer id when action is 'update'." : `Error: 'note_ids' must contain 1 to 50 positive integer ids when action is '${action}'.`;
  }
  return value;
}
function createCtxNoteTool(deps) {
  return tool({
    description: CTX_NOTE_DESCRIPTION,
    args: ctxNoteArgsShape,
    async execute(rawArgs, toolContext) {
      const parsedArgs = ctxNoteArgsSchema.safeParse(rawArgs);
      let args = parsedArgs.success ? parsedArgs.data : rawArgs;
      args = unwrapImitatedReducedArgs(args, ["action", "content"], {
        action: { type: "enum", values: ["write", "read", "dismiss", "update"] },
        content: "string",
        surface_condition: "string",
        filter: {
          type: "enum",
          values: ["all", "active", "pending", "ready", "dismissed"]
        },
        limit: "number",
        offset: "number",
        note_ids: { type: "array", items: "number", maxItems: 50 }
      });
      const sessionId = toolContext.sessionID;
      const action = args.action ?? (args.content?.trim() ? "write" : "read");
      const noteIds = action === "dismiss" || action === "update" || action === "read" && args.note_ids !== undefined ? parseNoteIds(action, args.note_ids) : undefined;
      if (typeof noteIds === "string")
        return noteIds;
      const wakePlaneActive = action === "write" && Boolean(args.surface_condition?.trim()) && await wakePlaneStatus() === "present";
      const _surfaceCondition = wakePlaneActive ? undefined : args.surface_condition?.trim();
      const projectIdentity = deps.resolveProjectPath?.(toolContext.directory);
      if (projectIdentity && projectNeedsSingleStoreMigration(deps.db, projectIdentity)) {
        return renderSingleStoreMigrationRequiredRefusal();
      }
      if (action === "write") {
        const content = args.content?.trim();
        if (!content) {
          return "Error: 'content' is required when action is 'write'.";
        }
        const anchorOrdinal = captureAnchorOrdinal(deps.db, sessionId);
        if (args.surface_condition?.trim()) {
          if (wakePlaneActive) {
            const note = addNote(deps.db, "session", {
              sessionId,
              content,
              anchorOrdinal
            });
            return `${formatWriteReply(note.id, writeTray(deps.db, sessionId), Date.now())}
wake plane active — create a scheduled wake instead; stored as a plain note.`;
          }
          if (!deps.dreamerEnabled) {
            return "Error: Smart notes require dreamer to be enabled. Enable dreamer in magic-context.jsonc to use surface_condition.";
          }
          if (!projectIdentity) {
            return `Error: Could not resolve project identity for smart note: ${describeUnresolvedProjectIdentity(toolContext.directory)}`;
          }
          const smartSurfaceCondition = args.surface_condition.trim();
          const compilation = await compileSurfaceCondition(smartSurfaceCondition, {
            projectPath: toolContext.directory
          });
          const note = addNote(deps.db, "smart", {
            content,
            projectPath: projectIdentity,
            sessionId,
            surfaceCondition: smartSurfaceCondition,
            anchorOrdinal,
            ...conditionCompileStorageFields(compilation)
          });
          return `Created smart note #${note.id}. Dreamer will evaluate the condition during nightly runs:
- Content: ${content}
- Condition: ${smartSurfaceCondition}${conditionCompileReplySuffix(compilation)}`;
        }
        const note = addNote(deps.db, "session", { sessionId, content, anchorOrdinal });
        return formatWriteReply(note.id, writeTray(deps.db, sessionId), Date.now());
      }
      if (action === "dismiss") {
        if (!projectIdentity) {
          return `Error: Could not resolve project identity for note dismiss: ${describeUnresolvedProjectIdentity(toolContext.directory)}`;
        }
        const ids = noteIds;
        if (ids.length === 1) {
          const dismissed = dismissNote(deps.db, ids[0], {
            projectPath: projectIdentity,
            sessionId
          });
          return dismissed ? `Note #${ids[0]} dismissed.` : `Error: Note #${ids[0]} not found in your session/project or already dismissed.`;
        }
        return formatDismissResults(dismissNotes(deps.db, ids, {
          projectPath: projectIdentity,
          sessionId
        }));
      }
      if (action === "update") {
        const noteId = noteIds[0];
        const updates = {};
        if (args.content?.trim())
          updates.content = args.content.trim();
        let compilation;
        if (args.surface_condition?.trim() && projectIdentity) {
          const existing = getNoteByIdInScope(deps.db, noteId, {
            projectPath: projectIdentity,
            sessionId
          });
          if (existing?.type === "session")
            return `Error: ${SESSION_NOTE_CONDITION_ERROR}`;
        }
        if (args.surface_condition?.trim()) {
          const surfaceCondition = args.surface_condition.trim();
          updates.surfaceCondition = surfaceCondition;
          compilation = await compileSurfaceCondition(surfaceCondition, {
            projectPath: toolContext.directory
          });
          Object.assign(updates, conditionCompileStorageFields(compilation));
        }
        if (!updates.content && !updates.surfaceCondition) {
          return "Error: Provide 'content' and/or 'surface_condition' to update.";
        }
        if (!projectIdentity) {
          return `Error: Could not resolve project identity for note update: ${describeUnresolvedProjectIdentity(toolContext.directory)}`;
        }
        const updated = updateNote(deps.db, noteId, updates, {
          projectPath: projectIdentity,
          sessionId
        });
        if (!updated) {
          return `Error: Note #${noteId} not found in your session/project or has no compatible fields to update.`;
        }
        const parts = [];
        if (updates.content)
          parts.push(`Content: ${updates.content}`);
        if (updates.surfaceCondition)
          parts.push(`Condition: ${updates.surfaceCondition}`);
        return `Updated note #${noteId}:
${parts.join(`
`)}${compilation ? conditionCompileReplySuffix(compilation) : ""}`;
      }
      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_READ_LIMIT;
      const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
      if (Array.isArray(noteIds) && !projectIdentity) {
        return `Error: Could not resolve project identity for note read: ${describeUnresolvedProjectIdentity(toolContext.directory)}`;
      }
      const nowMs = Date.now();
      const body = Array.isArray(noteIds) ? formatNotesById(deps.db, noteIds, { projectPath: projectIdentity, sessionId }, nowMs) : renderGlance(readGlanceNotes({
        db: deps.db,
        filter: args.filter,
        projectIdentity,
        sessionId
      }), { limit, offset, nowMs });
      try {
        setNoteLastReadAt(deps.db, sessionId);
      } catch {}
      if (body === EMPTY_READ_REPLY) {
        return EMPTY_READ_REPLY;
      }
      const anchorHint = body.includes("↳ @msg ") ? `

↳ @msg N marks the conversation tail when a note was written. To see what led to it: ctx_expand(start=N-x, end=N) (pick x for how far back to look).` : "";
      return body + anchorHint + DISMISS_FOOTER;
    }
  });
}
function createCtxNoteTools(deps) {
  return {
    ctx_note: createCtxNoteTool(deps)
  };
}
// ../plugin/src/tools/ctx-search/constants.ts
var CTX_SEARCH_TOOL_NAME = "ctx_search";
var CTX_SEARCH_DESCRIPTION = `Search the archive — everything that ever happened in this project, not just what is on your desk.

Retrieval matches meaning and exact words and fuses them, so phrase \`query\` as a natural-language question that still carries the exact terms you expect in the answer (paths, symbols, config keys, error strings); a bare keyword stack finds less.
- "where is the opencode source code path?"  (a location you once knew)
- "why did we choose SQLite over postgres?"  (a decision and its reasons)
- "how does the dreamer lease work?"  (a mechanism discussed or implemented earlier)
- Not: "upload client retry backoff config"

Results only contain what you CANNOT currently see — memories already in <project-memory> and the live tail are filtered out. A query that is just memory ids (\`#7234\`, \`12, 34\`) resolves them directly.

Sources (omit for all):
- memory — rules, constraints, conventions; "what's our convention for X"
- message — the raw conversation behind compacted history; "did we discuss this"; hits carry ordinals for ctx_expand(start=N-10, end=N+5)
- git_commit — commit history; "when did this change" (pair with message for regression hunts)
- primer — reusable project Q&A the dreamer distils from recurring questions; "have we answered this before"
- note — parked follow-ups with their recorded text; "did we leave a follow-up"
Use from/to to restrict every source to an inclusive UTC date range.`;
var DEFAULT_CTX_SEARCH_LIMIT = 10;
// ../plugin/src/features/magic-context/git-commits/git-log-reader.ts
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
var execFileAsync2 = promisify2(execFile2);
// ../plugin/src/features/magic-context/git-commits/indexer.ts
var MS_PER_DAY = 24 * 60 * 60 * 1000;
var EMBED_SWEEP_MAX_WALL_CLOCK_MS = 5 * 60 * 1000;
var indexInProgress = new Set;
var embedInProgress = new Set;
// ../plugin/src/features/magic-context/git-commits/search-git-commits.ts
var ftsStatements = new WeakMap;
var datedFtsStatements = new WeakMap;
var ftsPlainStatements = new WeakMap;
var datedFtsPlainStatements = new WeakMap;
var getBySHAsStatements = new WeakMap;
var datedGetBySHAsStatements = new WeakMap;
function rowToCommit(row) {
  return {
    sha: row.sha,
    shortSha: row.short_sha,
    projectPath: row.project_path,
    message: row.message,
    author: row.author,
    committedAtMs: row.committed_at,
    indexedAtMs: row.indexed_at
  };
}
function getFtsStatement(db, dated = false) {
  const statements = dated ? datedFtsStatements : ftsStatements;
  let stmt = statements.get(db);
  if (!stmt) {
    stmt = db.prepare(`SELECT c.sha AS sha, c.project_path AS project_path, c.short_sha AS short_sha,
                    c.message AS message, c.author AS author,
                    c.committed_at AS committed_at, c.indexed_at AS indexed_at
             FROM git_commits_fts
             INNER JOIN git_commits c ON c.sha = git_commits_fts.sha
             WHERE c.project_path = ?
               ${dated ? "AND c.committed_at BETWEEN ? AND ?" : ""}
               AND git_commits_fts MATCH ?
             ORDER BY bm25(git_commits_fts) LIMIT ?`);
    statements.set(db, stmt);
  }
  return stmt;
}
function escapeLikePattern(text) {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}
function getLikeFallbackStatement(db, dated = false) {
  const statements = dated ? datedFtsPlainStatements : ftsPlainStatements;
  let stmt = statements.get(db);
  if (!stmt) {
    stmt = db.prepare(`SELECT sha, project_path, short_sha, message, author, committed_at, indexed_at
             FROM git_commits
             WHERE project_path = ?
               ${dated ? "AND committed_at BETWEEN ? AND ?" : ""}
               AND lower(message) LIKE '%' || lower(?) || '%' ESCAPE '\\'
             ORDER BY committed_at DESC LIMIT ?`);
    statements.set(db, stmt);
  }
  return stmt;
}
function getBySHAsStatement(db, dated = false) {
  const statements = dated ? datedGetBySHAsStatements : getBySHAsStatements;
  let stmt = statements.get(db);
  if (!stmt) {
    stmt = db.prepare(`SELECT sha, project_path, short_sha, message, author, committed_at, indexed_at
               FROM git_commits
               WHERE project_path = ?
                 ${dated ? "AND committed_at BETWEEN ? AND ?" : ""}
                 AND sha IN (SELECT value FROM json_each(?))`);
    statements.set(db, stmt);
  }
  return stmt;
}
function clamp01(value) {
  if (!Number.isFinite(value))
    return 0;
  return Math.min(1, Math.max(0, value));
}
function searchGitCommitsSync(db, projectPath, query, options) {
  const trimmed = query.trim();
  if (trimmed.length === 0 || options.limit <= 0)
    return [];
  const semanticWeight = options.semanticWeight ?? 0.7;
  const ftsWeight = options.ftsWeight ?? 0.3;
  const singleSourcePenalty = options.singleSourcePenalty ?? 0.8;
  const fetchLimit = Math.max(options.limit * 3, 30);
  const dated = options.from !== undefined || options.to !== undefined;
  const from = options.from ?? Number.MIN_SAFE_INTEGER;
  const to = options.to ?? Number.MAX_SAFE_INTEGER;
  const ftsCandidates = [];
  const sanitized = sanitizeFtsQuery(trimmed);
  if (sanitized.length > 0) {
    try {
      for (const row of getFtsStatement(db, dated).all(projectPath, ...dated ? [from, to] : [], sanitized, fetchLimit)) {
        ftsCandidates.push(rowToCommit(row));
      }
    } catch (error) {
      log(`[git-commits] FTS query failed for "${trimmed}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (ftsCandidates.length === 0) {
    for (const row of getLikeFallbackStatement(db, dated).all(projectPath, ...dated ? [from, to] : [], escapeLikePattern(trimmed), fetchLimit)) {
      ftsCandidates.push(rowToCommit(row));
    }
  }
  const ftsScores = new Map;
  ftsCandidates.forEach((commit, rank) => {
    ftsScores.set(commit.sha, 1 / (rank + 1));
  });
  const semanticScores = new Map;
  if (options.queryEmbedding && options.queryModelId && options.queryModelId !== "off") {
    const embeddings = loadProjectCommitEmbeddings(db, projectPath, options.queryModelId);
    for (const [sha, embedding] of embeddings.entries()) {
      const similarity = clamp01(cosineSimilarity(options.queryEmbedding, embedding));
      if (similarity > 0) {
        semanticScores.set(sha, similarity);
      }
    }
  }
  const bySha = new Map;
  for (const commit of ftsCandidates)
    bySha.set(commit.sha, commit);
  const semanticOnlyShas = [...semanticScores.keys()].filter((sha) => !bySha.has(sha));
  if (semanticOnlyShas.length > 0) {
    const rows = getBySHAsStatement(db, dated).all(projectPath, ...dated ? [from, to] : [], JSON.stringify(semanticOnlyShas));
    for (const row of rows)
      bySha.set(row.sha, rowToCommit(row));
  }
  const results = [];
  for (const [sha, commit] of bySha.entries()) {
    const sem = semanticScores.get(sha);
    const fts = ftsScores.get(sha);
    let score = 0;
    let matchType = "fts";
    if (sem !== undefined && fts !== undefined) {
      score = semanticWeight * sem + ftsWeight * fts;
      matchType = "hybrid";
    } else if (sem !== undefined) {
      score = sem * singleSourcePenalty;
      matchType = "semantic";
    } else if (fts !== undefined) {
      score = fts * singleSourcePenalty;
      matchType = "fts";
    }
    if (score <= 0)
      continue;
    results.push({ commit, score, matchType });
  }
  results.sort((left, right) => {
    if (right.score !== left.score)
      return right.score - left.score;
    return right.commit.committedAtMs - left.commit.committedAtMs;
  });
  return results.slice(0, options.limit);
}
// ../plugin/src/features/magic-context/literal-probes.ts
var MAX_PROBES = 5;
var MIN_PROBE_LENGTH = 3;
var SLASH_COMMAND_RE = /\/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/gi;
var KEBAB_SNAKE_RE = /[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+/gi;
var DOTTED_RE = /[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)+/gi;
var CAMEL_RE = /\b[a-zA-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g;
var SHA_RE = /\b[0-9a-f]{7,40}\b/gi;
var ERROR_CODE_RE = /\b(?:TS\d{4,}|ERR_[A-Z][A-Z0-9_]*)\b/g;
var QUOTED_RE = /["`]([^"`]{3,80})["`]/g;
function looksLikeSha(token) {
  return /[0-9]/.test(token) && /^[0-9a-f]{7,40}$/i.test(token);
}
function extractLiteralProbes(query) {
  const trimmed = query.trim();
  if (trimmed.length === 0)
    return [];
  const ordered = [];
  const seen = new Set;
  const add = (raw) => {
    if (!raw)
      return;
    const probe = raw.trim();
    if (probe.length < MIN_PROBE_LENGTH)
      return;
    const key = probe.toLowerCase();
    if (seen.has(key))
      return;
    seen.add(key);
    ordered.push(probe);
  };
  for (const m of trimmed.matchAll(QUOTED_RE))
    add(m[1]);
  for (const m of trimmed.matchAll(SLASH_COMMAND_RE))
    add(m[0]);
  for (const m of trimmed.matchAll(ERROR_CODE_RE))
    add(m[0]);
  for (const m of trimmed.matchAll(DOTTED_RE))
    add(m[0]);
  for (const m of trimmed.matchAll(KEBAB_SNAKE_RE))
    add(m[0]);
  for (const m of trimmed.matchAll(CAMEL_RE))
    add(m[0]);
  for (const m of trimmed.matchAll(SHA_RE)) {
    if (looksLikeSha(m[0]))
      add(m[0]);
  }
  return ordered.slice(0, MAX_PROBES);
}
function containsProbeVerbatim(text, probes) {
  if (probes.length === 0)
    return false;
  const haystack = text.toLowerCase();
  return probes.some((probe) => haystack.includes(probe.toLowerCase()));
}

// ../plugin/src/features/magic-context/search-measurement.ts
import { createHash as createHash3 } from "node:crypto";
function resultId(result) {
  switch (result.source) {
    case "memory":
      return `memory:${result.memoryId}`;
    case "message":
      return `message:${result.messageId}`;
    case "compartment":
      return `chunk:${result.compartmentId}`;
    case "git_commit":
      return `commit:${result.sha}`;
    case "primer":
      return `primer:${result.primerId}`;
    case "note":
      return `note:${result.noteId}`;
  }
}
async function recordShadowMeasurement(args) {
  try {
    const shadowCohort = getShadowEmbeddingMeasurementCohort(args.projectPath);
    if (!shadowCohort)
      return;
    const primaryCohort = getPrimaryEmbeddingMeasurementCohort(args.projectPath);
    const shadowStartedAt = Date.now();
    let shadowFailed = false;
    let shadowResults = [];
    try {
      const vector = await embedShadowTextForProject(args.projectPath, args.query);
      if (!vector) {
        shadowFailed = true;
      } else {
        shadowResults = await args.search(args.db, args.sessionId, args.projectPath, args.query, {
          ...args.options,
          embedQuery: async () => vector,
          isEmbeddingRuntimeEnabled: () => true,
          embeddingEnabled: true,
          embeddingModelIdOverride: shadowCohort.modelId,
          chunkModelIdOverride: shadowCohort.chunkModelId,
          measurementDisabled: true,
          countRetrievals: false
        });
      }
    } catch {
      shadowFailed = true;
    }
    const primaryModelId = args.primaryQuery?.modelId ?? primaryCohort?.modelId ?? "";
    const primaryFingerprint = primaryCohort?.fingerprint ?? "";
    const primaryEpoch = primaryCohort?.epoch ?? 0;
    const cohortKey = JSON.stringify({
      primaryFingerprint,
      primaryEpoch,
      shadowFingerprint: shadowCohort.fingerprint,
      shadowEpoch: shadowCohort.epoch
    });
    const primaryIds = args.primaryResults.map(resultId);
    const shadowIds = shadowResults.map(resultId);
    const corpusHash = sha256(JSON.stringify({ query: args.query, primaryIds, shadowIds }));
    recordEmbeddingMeasurement(args.db, {
      sessionId: args.sessionId,
      projectPath: args.projectPath,
      queryText: args.query,
      cohortKey,
      primaryResultIds: primaryIds,
      shadowResultIds: shadowIds,
      primaryLatencyMs: args.primaryLatencyMs,
      shadowLatencyMs: Date.now() - shadowStartedAt,
      primaryFailed: args.primaryQuery === null,
      shadowFailed,
      primaryModelId,
      shadowModelId: shadowCohort.modelId,
      primaryFingerprint,
      shadowFingerprint: shadowCohort.fingerprint,
      primaryEpoch,
      shadowEpoch: shadowCohort.epoch,
      corpusHash,
      coverage: {
        primaryResultCount: primaryIds.length,
        shadowResultCount: shadowIds.length,
        primaryAnswered: args.primaryQuery !== null,
        shadowAnswered: !shadowFailed
      }
    });
  } catch (error) {
    log("[magic-context] shadow embedding measurement failed:", error);
  }
}
function sha256(value) {
  return createHash3("sha256").update(value).digest("hex");
}

// ../plugin/src/features/magic-context/search.ts
var DEFAULT_UNIFIED_SEARCH_LIMIT = 10;
var MAX_UNIFIED_SEARCH_LIMIT = 25;
var FTS_SEMANTIC_CANDIDATE_LIMIT = 50;
var SEMANTIC_WEIGHT = 0.7;
var FTS_WEIGHT = 0.3;
var SINGLE_SOURCE_PENALTY = 0.8;
var RESULT_PREVIEW_LIMIT = 220;
var MEMORY_SOURCE_BOOST = 1.3;
var MESSAGE_SOURCE_BOOST = 1.275;
var GIT_COMMIT_SOURCE_BOOST = 1.2;
var PRIMER_SOURCE_BOOST = 1.25;
var messageSearchStatements = new WeakMap;
var messageSearchStatementsWithCutoff = new WeakMap;
var messageSearchStatementsWithDateRange = new WeakMap;
var messageSearchDiagnosticStatements = new WeakMap;
var messageSearchDiagnosticStatementsWithDateRange = new WeakMap;
var batchedMessageSearchStatements = new WeakMap;
var batchedFtsCountStatements = new WeakMap;
function createUnifiedSearchDiagnostics() {
  return {
    suppressedVisibleMemoryIds: [],
    suppressedLiveMessageMatches: 0,
    gitCommitUnavailable: null
  };
}
function normalizeLimit2(limit) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_UNIFIED_SEARCH_LIMIT;
  }
  return Math.min(MAX_UNIFIED_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
}
function normalizeDateRange(from, to) {
  if (from === undefined && to === undefined)
    return null;
  return {
    from: typeof from === "number" && Number.isSafeInteger(from) ? from : Number.MIN_SAFE_INTEGER,
    to: typeof to === "number" && Number.isSafeInteger(to) ? to : Number.MAX_SAFE_INTEGER
  };
}
function timestampIsInRange(timestamp, range) {
  return range === null || timestamp >= range.from && timestamp <= range.to;
}
var ID_SHAPED_QUERY_MAX_TOKENS = 5;
var ID_SHAPED_TOKEN = /^#?\d+$/;
function parseIdShapedQuery(query) {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const tokens = trimmed.split(/[\s,]+/).filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > ID_SHAPED_QUERY_MAX_TOKENS) {
    return null;
  }
  const ids = [];
  for (const token of tokens) {
    if (!ID_SHAPED_TOKEN.test(token)) {
      return null;
    }
    const parsed = Number.parseInt(token.replace(/^#/, ""), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    ids.push(parsed);
  }
  return ids;
}
function normalizeCosineScore(score) {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.min(1, Math.max(0, score));
}
function previewText(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= RESULT_PREVIEW_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, RESULT_PREVIEW_LIMIT - 1).trimEnd()}…`;
}
function resolveSearchWorkspaceContext(db, projectPath, identitySet) {
  const resolved = identitySet ?? resolveWorkspaceIdentitySet(db, projectPath);
  const isWorkspaced = resolved.identities.length > 1;
  const expanded = expandWorkspaceIdentitySetWithAliases(db, resolved.identities);
  const expandedIdentities = isWorkspaced ? expanded.expandedIdentities : resolved.identities;
  const canonicalIdentityByStoredPath = isWorkspaced ? expanded.canonicalIdentityByStoredPath : new Map(resolved.identities.map((identity) => [identity, identity]));
  const ownIdentities = expandedIdentities.filter((identity) => canonicalIdentityByStoredPath.get(identity) === projectPath);
  return {
    identities: resolved.identities,
    expandedIdentities,
    ownIdentities,
    shareCategories: isWorkspaced ? resolveWorkspaceShareCategories(db, projectPath) : null,
    namesByIdentity: resolved.namesByIdentity,
    canonicalIdentityByStoredPath,
    isWorkspaced
  };
}
function memoryWorkspaceIdentity(memory, workspace) {
  return resolveStoredPathWorkspaceIdentity(memory.projectPath, workspace.identities, workspace.canonicalIdentityByStoredPath);
}
function sourceNamesForSearchMemories(args) {
  if (!args.workspace.isWorkspaced)
    return;
  const sourceNames = new Map;
  for (const memory of args.memories) {
    const source = sourceNameForMemory(memory.projectPath, args.projectPath, args.workspace.identities, args.workspace.namesByIdentity, args.workspace.canonicalIdentityByStoredPath);
    if (source)
      sourceNames.set(memory.id, source);
  }
  return sourceNames.size > 0 ? sourceNames : undefined;
}
function getMessageSearchStatement(db) {
  let stmt = messageSearchStatements.get(db);
  if (!stmt) {
    stmt = db.prepare("SELECT message_ordinal AS messageOrdinal, message_id AS messageId, role, content FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ? ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC LIMIT ?");
    messageSearchStatements.set(db, stmt);
  }
  return stmt;
}
function getMessageSearchStatementWithCutoff(db) {
  let stmt = messageSearchStatementsWithCutoff.get(db);
  if (!stmt) {
    stmt = db.prepare("SELECT message_ordinal AS messageOrdinal, message_id AS messageId, role, content FROM message_history_fts WHERE session_id = ? AND message_history_fts MATCH ? AND CAST(message_ordinal AS INTEGER) <= ? ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC LIMIT ?");
    messageSearchStatementsWithCutoff.set(db, stmt);
  }
  return stmt;
}
function getMessageSearchStatementWithDateRange(db, withCutoff) {
  let statements = messageSearchStatementsWithDateRange.get(db);
  if (!statements) {
    statements = new Map;
    messageSearchStatementsWithDateRange.set(db, statements);
  }
  const key = withCutoff ? "cutoff" : "all";
  let statement = statements.get(key);
  if (!statement) {
    statement = db.prepare(`SELECT message_history_fts.message_ordinal AS messageOrdinal,
                    message_history_fts.message_id AS messageId,
                    message_history_fts.role AS role,
                    message_history_fts.content AS content
               FROM message_history_fts
               JOIN message_fts_rowid_map AS map
                 ON map.session_id = message_history_fts.session_id
                AND map.fts_rowid = message_history_fts.rowid
              WHERE message_history_fts.session_id = ?
                AND message_history_fts MATCH ?
                AND map.message_time_ms BETWEEN ? AND ?
                ${withCutoff ? "AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?" : ""}
              ORDER BY bm25(message_history_fts),
                       CAST(message_history_fts.message_ordinal AS INTEGER) ASC
              LIMIT ?`);
    statements.set(key, statement);
  }
  return statement;
}
function getMessageSearchDiagnosticStatement(db) {
  let stmt = messageSearchDiagnosticStatements.get(db);
  if (!stmt) {
    stmt = db.prepare(`
            WITH matches AS MATERIALIZED (
                SELECT
                    message_ordinal AS messageOrdinal,
                    message_id AS messageId,
                    role,
                    content,
                    CAST(message_ordinal AS INTEGER) AS ordinalValue,
                    bm25(message_history_fts) AS ftsRank
                FROM message_history_fts
                WHERE session_id = ? AND message_history_fts MATCH ?
            ),
            eligible AS (
                SELECT * FROM matches
                WHERE ordinalValue <= ?
                ORDER BY ftsRank, ordinalValue ASC
                LIMIT ?
            ),
            summary AS (
                SELECT COUNT(*) AS suppressedCount
                FROM matches
                WHERE ordinalValue > ?
            )
            SELECT
                eligible.messageOrdinal,
                eligible.messageId,
                eligible.role,
                eligible.content,
                eligible.ftsRank,
                summary.suppressedCount,
                0 AS summaryOnly
            FROM eligible CROSS JOIN summary
            UNION ALL
            SELECT NULL, NULL, NULL, NULL, NULL, summary.suppressedCount, 1
            FROM summary
            WHERE NOT EXISTS (SELECT 1 FROM eligible)
            ORDER BY summaryOnly ASC, ftsRank ASC, messageOrdinal ASC
        `);
    messageSearchDiagnosticStatements.set(db, stmt);
  }
  return stmt;
}
function getMessageSearchDiagnosticStatementWithDateRange(db) {
  let statement = messageSearchDiagnosticStatementsWithDateRange.get(db);
  if (!statement) {
    statement = db.prepare(`
            WITH matches AS MATERIALIZED (
                SELECT
                    message_history_fts.message_ordinal AS messageOrdinal,
                    message_history_fts.message_id AS messageId,
                    message_history_fts.role AS role,
                    message_history_fts.content AS content,
                    CAST(message_history_fts.message_ordinal AS INTEGER) AS ordinalValue,
                    bm25(message_history_fts) AS ftsRank
                FROM message_history_fts
                JOIN message_fts_rowid_map AS map
                  ON map.session_id = message_history_fts.session_id
                 AND map.fts_rowid = message_history_fts.rowid
                WHERE message_history_fts.session_id = ?
                  AND message_history_fts MATCH ?
                  AND map.message_time_ms BETWEEN ? AND ?
            ),
            eligible AS (
                SELECT * FROM matches
                WHERE ordinalValue <= ?
                ORDER BY ftsRank, ordinalValue ASC
                LIMIT ?
            ),
            summary AS (
                SELECT COUNT(*) AS suppressedCount
                FROM matches
                WHERE ordinalValue > ?
            )
            SELECT
                eligible.messageOrdinal,
                eligible.messageId,
                eligible.role,
                eligible.content,
                eligible.ftsRank,
                summary.suppressedCount,
                0 AS summaryOnly
            FROM eligible CROSS JOIN summary
            UNION ALL
            SELECT NULL, NULL, NULL, NULL, NULL, summary.suppressedCount, 1
            FROM summary
            WHERE NOT EXISTS (SELECT 1 FROM eligible)
            ORDER BY summaryOnly ASC, ftsRank ASC, messageOrdinal ASC
        `);
    messageSearchDiagnosticStatementsWithDateRange.set(db, statement);
  }
  return statement;
}
function getBatchedFtsCountStatement(db, queryCount, cutoff, dateRange) {
  let statements = batchedFtsCountStatements.get(db);
  if (!statements) {
    statements = new Map;
    batchedFtsCountStatements.set(db, statements);
  }
  const key = `${queryCount}:${cutoff === null ? "all" : "cutoff"}:${dateRange === null ? "all-dates" : "dated"}`;
  let statement = statements.get(key);
  if (!statement) {
    const cutoffSql = cutoff === null ? "" : " AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?";
    const joinSql = dateRange === null ? "" : ` JOIN message_fts_rowid_map AS map
                         ON map.session_id = message_history_fts.session_id
                        AND map.fts_rowid = message_history_fts.rowid`;
    const dateSql = dateRange === null ? "" : " AND map.message_time_ms BETWEEN ? AND ?";
    statement = db.prepare(Array.from({ length: queryCount }, (_, index) => `SELECT ${index} AS queryIndex, COUNT(*) AS count
                       FROM message_history_fts${joinSql}
                      WHERE message_history_fts.session_id = ?
                        AND message_history_fts MATCH ?${dateSql}${cutoffSql}`).join(`
UNION ALL
`));
    statements.set(key, statement);
  }
  return statement;
}
function contentOnlyMessageQuery(ftsQuery) {
  return ftsQuery.length === 0 ? "" : `content : (${ftsQuery})`;
}
function countSessionFtsMatchesBatch(db, sessionId, ftsQueries, cutoff, dateRange) {
  if (ftsQueries.length === 0)
    return [];
  const bindings = [];
  for (const query of ftsQueries) {
    bindings.push(sessionId, contentOnlyMessageQuery(query));
    if (dateRange !== null)
      bindings.push(dateRange.from, dateRange.to);
    if (cutoff !== null)
      bindings.push(cutoff);
  }
  try {
    const rows = getBatchedFtsCountStatement(db, ftsQueries.length, cutoff, dateRange).all(...bindings);
    const counts = Array.from({ length: ftsQueries.length }, () => 0);
    for (const row of rows) {
      if (typeof row.queryIndex === "number" && row.queryIndex >= 0 && row.queryIndex < counts.length && typeof row.count === "number") {
        counts[row.queryIndex] = row.count;
      }
    }
    return counts;
  } catch {
    return Array.from({ length: ftsQueries.length }, () => 0);
  }
}
function getMessageOrdinal(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
async function getSemanticScores(args) {
  const semanticScores = new Map;
  if (!args.queryEmbedding || args.memories.length === 0 || !args.queryModelId || args.queryModelId === "off") {
    return semanticScores;
  }
  if (!args.workspace?.isWorkspaced) {
    const cachedEmbeddings = getProjectEmbeddings(args.db, args.projectPath, args.queryModelId);
    const embeddings = await ensureMemoryEmbeddings({
      db: args.db,
      projectIdentity: args.projectPath,
      memories: args.memories,
      existingEmbeddings: cachedEmbeddings
    });
    for (const memory of args.memories) {
      const memoryEmbedding = embeddings.get(memory.id);
      if (!memoryEmbedding) {
        continue;
      }
      semanticScores.set(memory.id, normalizeCosineScore(cosineSimilarity(args.queryEmbedding, memoryEmbedding.embedding)));
    }
    return semanticScores;
  }
  const workspace = args.workspace;
  const memoriesByIdentity = new Map;
  for (const memory of args.memories) {
    const identity = memoryWorkspaceIdentity(memory, workspace);
    if (!identity)
      continue;
    const list = memoriesByIdentity.get(identity) ?? [];
    list.push(memory);
    memoriesByIdentity.set(identity, list);
  }
  const ownMemories = memoriesByIdentity.get(args.projectPath) ?? [];
  if (ownMemories.length > 0) {
    const ownEmbeddings = getProjectEmbeddings(args.db, args.projectPath, args.queryModelId);
    await ensureMemoryEmbeddings({
      db: args.db,
      projectIdentity: args.projectPath,
      memories: ownMemories,
      existingEmbeddings: ownEmbeddings
    });
  }
  for (const identity of workspace.identities) {
    const memberMemories = memoriesByIdentity.get(identity) ?? [];
    if (memberMemories.length === 0)
      continue;
    const cachedEmbeddings = getProjectEmbeddings(args.db, identity, args.queryModelId);
    for (const memory of memberMemories) {
      const memoryEmbedding = cachedEmbeddings.get(memory.id);
      if (!memoryEmbedding || memoryEmbedding.modelId !== args.queryModelId)
        continue;
      semanticScores.set(memory.id, normalizeCosineScore(cosineSimilarity(args.queryEmbedding, memoryEmbedding.embedding)));
    }
  }
  return semanticScores;
}
function getFtsMatches(args) {
  try {
    return args.workspace?.isWorkspaced ? searchMemoriesFTSUnion(args.db, args.workspace.expandedIdentities, args.query, args.limit, args.workspace.ownIdentities, args.workspace.shareCategories, args.dateRange) : searchMemoriesFTS(args.db, args.projectPath, args.query, args.limit, args.dateRange);
  } catch (error) {
    log(`[search] FTS query failed for "${args.query}": ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
function getFtsScores(matches) {
  return new Map(matches.map((memory, rank) => [memory.id, 1 / (rank + 1)]));
}
function selectSemanticCandidates(args) {
  if (args.ftsMatches.length === 0) {
    return args.memories;
  }
  const candidateIds = new Set(args.ftsMatches.map((memory) => memory.id));
  if (args.queryModelId && args.queryModelId !== "off") {
    const embeddingProjects = args.workspace?.isWorkspaced ? args.workspace.identities : [args.projectPath];
    for (const projectPath of embeddingProjects) {
      const storedEmbeddings = getProjectEmbeddings(args.db, projectPath, args.queryModelId);
      for (const memoryId of storedEmbeddings.keys()) {
        candidateIds.add(memoryId);
      }
    }
  }
  return args.memories.filter((memory) => candidateIds.has(memory.id));
}
function mergeMemoryResults(args) {
  const memoryById = new Map(args.memories.map((memory) => [memory.id, memory]));
  const candidateIds = new Set([...args.semanticScores.keys(), ...args.ftsScores.keys()]);
  const results = [];
  const suppressedVisibleIds = [];
  for (const id of candidateIds) {
    const memory = memoryById.get(id);
    if (!memory) {
      continue;
    }
    const semanticScore = args.semanticScores.get(id);
    const ftsScore = args.ftsScores.get(id);
    let score = 0;
    let matchType = "fts";
    if (semanticScore !== undefined && ftsScore !== undefined) {
      score = SEMANTIC_WEIGHT * semanticScore + FTS_WEIGHT * ftsScore;
      matchType = "hybrid";
    } else if (semanticScore !== undefined) {
      score = semanticScore * SINGLE_SOURCE_PENALTY;
      matchType = "semantic";
    } else if (ftsScore !== undefined) {
      score = ftsScore * SINGLE_SOURCE_PENALTY;
      matchType = "fts";
    }
    if (score <= 0) {
      continue;
    }
    if (args.visibleMemoryIds?.has(id)) {
      suppressedVisibleIds.push(id);
      continue;
    }
    results.push({
      source: "memory",
      content: previewText(memory.content),
      score,
      memoryId: memory.id,
      category: memory.category,
      matchType,
      sourceName: args.sourceNameByMemoryId?.get(memory.id)
    });
  }
  return {
    results: results.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.memoryId - right.memoryId;
    }).slice(0, args.limit),
    suppressedVisibleIds: suppressedVisibleIds.sort((left, right) => left - right)
  };
}
async function searchMemories(args) {
  if (!args.memoryEnabled) {
    return { results: [], suppressedVisibleIds: [] };
  }
  const unfilteredMemories = args.workspace?.isWorkspaced ? getMemoriesByProjects(args.db, args.workspace.expandedIdentities, ["active", "permanent"], Date.now(), args.workspace.ownIdentities, args.workspace.shareCategories) : getMemoriesByProject(args.db, args.projectPath);
  const memories = unfilteredMemories.filter((memory) => timestampIsInRange(memory.createdAt, args.dateRange));
  if (memories.length === 0) {
    return { results: [], suppressedVisibleIds: [] };
  }
  const ftsMatches = getFtsMatches({
    db: args.db,
    projectPath: args.projectPath,
    query: args.query,
    limit: FTS_SEMANTIC_CANDIDATE_LIMIT,
    workspace: args.workspace,
    dateRange: args.dateRange
  });
  const ftsScores = getFtsScores(ftsMatches);
  const semanticCandidates = selectSemanticCandidates({
    db: args.db,
    memories,
    projectPath: args.projectPath,
    ftsMatches,
    queryModelId: args.queryModelId,
    workspace: args.workspace
  });
  const semanticScores = await getSemanticScores({
    db: args.db,
    projectPath: args.projectPath,
    memories: semanticCandidates,
    queryEmbedding: args.queryEmbedding,
    queryModelId: args.queryModelId,
    workspace: args.workspace
  });
  return mergeMemoryResults({
    memories,
    semanticScores,
    ftsScores,
    limit: args.limit,
    visibleMemoryIds: args.visibleMemoryIds,
    sourceNameByMemoryId: sourceNamesForSearchMemories({
      memories,
      projectPath: args.projectPath,
      workspace: args.workspace ?? {
        identities: [args.projectPath],
        expandedIdentities: [args.projectPath],
        namesByIdentity: new Map,
        canonicalIdentityByStoredPath: new Map([[args.projectPath, args.projectPath]]),
        ownIdentities: [args.projectPath],
        shareCategories: null,
        isWorkspaced: false
      }
    })
  });
}
function linearDecayScore(rank, total) {
  if (total <= 0)
    return 0;
  return Math.max(0, 1 - rank / total);
}
function normalizeMessageSearchRow(row, cutoff) {
  const messageOrdinal = getMessageOrdinal(row.messageOrdinal);
  if (messageOrdinal === null || typeof row.messageId !== "string" || typeof row.role !== "string" || typeof row.content !== "string") {
    return null;
  }
  if (cutoff !== null && messageOrdinal > cutoff)
    return null;
  return {
    messageOrdinal,
    messageId: row.messageId,
    role: row.role,
    content: row.content
  };
}
function runMessageFtsQuery(db, sessionId, ftsQuery, fetchLimit, cutoff, dateRange) {
  if (ftsQuery.length === 0)
    return [];
  let rawRows;
  const matchQuery = contentOnlyMessageQuery(ftsQuery);
  if (dateRange !== null) {
    const bindings = [sessionId, matchQuery, dateRange.from, dateRange.to];
    if (cutoff !== null)
      bindings.push(cutoff);
    bindings.push(fetchLimit);
    rawRows = getMessageSearchStatementWithDateRange(db, cutoff !== null).all(...bindings);
  } else {
    rawRows = cutoff !== null ? getMessageSearchStatementWithCutoff(db).all(sessionId, matchQuery, cutoff, fetchLimit) : getMessageSearchStatement(db).all(sessionId, matchQuery, fetchLimit);
  }
  const rows = rawRows.map((row) => row);
  const result = [];
  for (const row of rows) {
    const normalized = normalizeMessageSearchRow(row, cutoff);
    if (normalized)
      result.push(normalized);
  }
  return result;
}
function runMessageFtsQueryWithDiagnostics(args) {
  if (args.ftsQuery.length === 0)
    return { rows: [], suppressedCount: 0 };
  const matchQuery = contentOnlyMessageQuery(args.ftsQuery);
  const rawRows = (args.dateRange === null ? getMessageSearchDiagnosticStatement(args.db).all(args.sessionId, matchQuery, args.cutoff, args.fetchLimit, args.cutoff) : getMessageSearchDiagnosticStatementWithDateRange(args.db).all(args.sessionId, matchQuery, args.dateRange.from, args.dateRange.to, args.cutoff, args.fetchLimit, args.cutoff)).map((row) => row);
  const suppressedCount = rawRows[0]?.suppressedCount ?? 0;
  const rows = [];
  for (const row of rawRows) {
    if (row.summaryOnly === 1)
      continue;
    const normalized = normalizeMessageSearchRow(row, args.cutoff);
    if (normalized)
      rows.push(normalized);
  }
  return { rows, suppressedCount };
}
function getBatchedMessageSearchStatement(db, queryCount, cutoff, dateRange) {
  let statements = batchedMessageSearchStatements.get(db);
  if (!statements) {
    statements = new Map;
    batchedMessageSearchStatements.set(db, statements);
  }
  const key = `${queryCount}:${cutoff === null ? "all" : "cutoff"}:${dateRange === null ? "all-dates" : "dated"}`;
  let statement = statements.get(key);
  if (!statement) {
    const cutoffSql = cutoff === null ? "" : " AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?";
    const joinSql = dateRange === null ? "" : ` JOIN message_fts_rowid_map AS map
                         ON map.session_id = message_history_fts.session_id
                        AND map.fts_rowid = message_history_fts.rowid`;
    const dateSql = dateRange === null ? "" : " AND map.message_time_ms BETWEEN ? AND ?";
    const branches = Array.from({ length: queryCount }, (_, index) => `SELECT * FROM (
                SELECT ${index} AS queryIndex,
                       message_history_fts.message_ordinal AS messageOrdinal,
                       message_history_fts.message_id AS messageId,
                       message_history_fts.role AS role,
                       message_history_fts.content AS content,
                       bm25(message_history_fts) AS ftsRank
                  FROM message_history_fts${joinSql}
                 WHERE message_history_fts.session_id = ?
                   AND message_history_fts MATCH ?${dateSql}${cutoffSql}
                 ORDER BY ftsRank
                 LIMIT ?
            )`);
    statement = db.prepare(`${branches.join(`
UNION ALL
`)}
ORDER BY queryIndex ASC, ftsRank ASC`);
    statements.set(key, statement);
  }
  return statement;
}
function runMessageFtsQueriesBatch(db, sessionId, ftsQueries, fetchLimit, cutoff, dateRange) {
  if (ftsQueries.length === 0)
    return [];
  const bindings = [];
  for (const query of ftsQueries) {
    bindings.push(sessionId, contentOnlyMessageQuery(query));
    if (dateRange !== null)
      bindings.push(dateRange.from, dateRange.to);
    if (cutoff !== null)
      bindings.push(cutoff);
    bindings.push(fetchLimit);
  }
  const rows = getBatchedMessageSearchStatement(db, ftsQueries.length, cutoff, dateRange).all(...bindings);
  const result = Array.from({ length: ftsQueries.length }, () => []);
  for (const row of rows) {
    if (typeof row.queryIndex !== "number" || row.queryIndex < 0 || row.queryIndex >= result.length) {
      continue;
    }
    const normalized = normalizeMessageSearchRow(row, cutoff);
    if (normalized)
      result[row.queryIndex].push(normalized);
  }
  return result;
}
var RRF_K = 60;
var VERBATIM_RANK_BONUS = 1 / RRF_K;
var IDF_FALLOFF = 100;
function probeDiscriminationWeight(df, corpusSize) {
  if (corpusSize <= 0 || df <= 0)
    return 1;
  return 1 / (1 + IDF_FALLOFF * df / corpusSize);
}
function searchMessages(args) {
  const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;
  const fetchLimit = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.limit * 3 : args.limit;
  const baseQuery = sanitizeFtsQuery(args.query.trim());
  const probes = args.probes ?? [];
  if (probes.length === 0) {
    const outcome = args.diagnostics && cutoff !== null ? runMessageFtsQueryWithDiagnostics({
      db: args.db,
      sessionId: args.sessionId,
      ftsQuery: baseQuery,
      fetchLimit,
      cutoff,
      dateRange: args.dateRange
    }) : {
      rows: runMessageFtsQuery(args.db, args.sessionId, baseQuery, fetchLimit, cutoff, args.dateRange),
      suppressedCount: 0
    };
    if (args.diagnostics) {
      args.diagnostics.suppressedLiveMessageMatches = outcome.suppressedCount;
    }
    const rows = outcome.rows.length > 0 || !args.relaxedRecall ? outcome.rows : runMessageFtsQuery(args.db, args.sessionId, relaxedFtsQuery(args.query), fetchLimit, cutoff, args.dateRange);
    const filtered = rows.slice(0, args.limit);
    return filtered.map((row, rank) => ({
      source: "message",
      content: previewText(row.content),
      score: linearDecayScore(rank, filtered.length),
      messageOrdinal: row.messageOrdinal,
      messageId: row.messageId,
      role: row.role
    }));
  }
  const sanitizedProbes = probes.map((probe) => ({ probe, query: sanitizeFtsQuery(probe) })).filter((entry) => entry.query.length > 0);
  const corpusSize = getIndexedMessageCorpusSize(args.db, args.sessionId, cutoff);
  const probeCounts = countSessionFtsMatchesBatch(args.db, args.sessionId, sanitizedProbes.map((entry) => entry.query), cutoff, args.dateRange);
  const collectBaseDiagnostics = args.diagnostics !== undefined && cutoff !== null;
  const baseOutcome = collectBaseDiagnostics && baseQuery.length > 0 ? runMessageFtsQueryWithDiagnostics({
    db: args.db,
    sessionId: args.sessionId,
    ftsQuery: baseQuery,
    fetchLimit,
    cutoff,
    dateRange: args.dateRange
  }) : null;
  if (args.diagnostics) {
    args.diagnostics.suppressedLiveMessageMatches = baseOutcome?.suppressedCount ?? 0;
  }
  const searchQueries = [
    ...!collectBaseDiagnostics && baseQuery.length > 0 ? [baseQuery] : [],
    ...sanitizedProbes.map((entry) => entry.query)
  ];
  const rowsByQuery = runMessageFtsQueriesBatch(args.db, args.sessionId, searchQueries, fetchLimit, cutoff, args.dateRange);
  const queryLists = [];
  let queryIndex = 0;
  if (baseQuery.length > 0) {
    queryLists.push({
      rows: baseOutcome?.rows ?? rowsByQuery[queryIndex] ?? [],
      weight: 1
    });
    if (!collectBaseDiagnostics)
      queryIndex += 1;
  }
  const probeWeights = new Map;
  sanitizedProbes.forEach((entry, probeIndex) => {
    const weight = probeDiscriminationWeight(probeCounts[probeIndex] ?? 0, corpusSize);
    probeWeights.set(entry.probe, weight);
    queryLists.push({ rows: rowsByQuery[queryIndex] ?? [], weight });
    queryIndex += 1;
  });
  const fused = new Map;
  for (const list of queryLists) {
    list.rows.forEach((row, rank) => {
      const rrf = list.weight / (RRF_K + rank);
      const existing = fused.get(row.messageId);
      if (existing) {
        existing.score += rrf;
      } else {
        fused.set(row.messageId, { row, score: rrf });
      }
    });
  }
  for (const entry of fused.values()) {
    let best = 0;
    for (const probe of probes) {
      const weight = probeWeights.get(probe) ?? 0;
      if (weight > best && containsProbeVerbatim(entry.row.content, [probe])) {
        best = weight;
      }
    }
    if (best > 0) {
      entry.score += best * VERBATIM_RANK_BONUS;
    }
  }
  const ranked = [...fused.values()].sort((a, b) => b.score !== a.score ? b.score - a.score : a.row.messageOrdinal - b.row.messageOrdinal).slice(0, args.limit);
  return ranked.map((entry, rank) => ({
    source: "message",
    content: previewText(entry.row.content),
    score: linearDecayScore(rank, ranked.length),
    messageOrdinal: entry.row.messageOrdinal,
    messageId: entry.row.messageId,
    role: entry.row.role
  }));
}
var NOTE_SEARCHABLE_STATUSES = ["active", "pending", "ready"];
var MAX_NOTE_KEYWORD_SCORE = 3.5;
function noteSearchText(note) {
  const reason = note.readyReason?.trim();
  return reason ? `${note.content}
Reason: ${reason}` : note.content;
}
function tokenizeKeywordNeedle(text) {
  const matches = text.toLowerCase().match(/[a-z0-9/._:-]+/g) ?? [];
  const seen = new Set;
  const tokens = [];
  for (const match of matches) {
    if (match.length <= 1 || !/[a-z0-9]/.test(match) || seen.has(match)) {
      continue;
    }
    seen.add(match);
    tokens.push(match);
  }
  return tokens;
}
function normalizeNoteKeywordScore(score) {
  return normalizeCosineScore(score / MAX_NOTE_KEYWORD_SCORE) * SINGLE_SOURCE_PENALTY;
}
function rankNotesForNeedle(notes, needle) {
  const normalizedNeedle = needle.trim().toLowerCase();
  if (normalizedNeedle.length === 0) {
    return [];
  }
  const needleTokens = tokenizeKeywordNeedle(normalizedNeedle);
  const ranked = [];
  for (const note of notes) {
    const text = noteSearchText(note);
    const normalizedText = text.toLowerCase();
    const noteTokens = new Set(tokenizeKeywordNeedle(normalizedText));
    const exact = normalizedText.includes(normalizedNeedle);
    const matchedTokens = needleTokens.filter((token) => noteTokens.has(token)).length;
    if (!exact && matchedTokens === 0) {
      continue;
    }
    const matchedUniqueTokens = new Set(needleTokens.filter((token) => noteTokens.has(token))).size;
    const coverage = needleTokens.length > 0 ? matchedTokens / needleTokens.length : 0;
    const density = noteTokens.size > 0 ? matchedUniqueTokens / noteTokens.size : 0;
    const exactPhrase = exact && (needleTokens.length > 1 || normalizedText.trim() === normalizedNeedle);
    const allTokens = needleTokens.length > 1 && matchedTokens === needleTokens.length;
    const score = (exactPhrase ? 2 : 0) + coverage * density + (allTokens ? 0.5 * density : 0);
    ranked.push({ note, score, text });
  }
  return ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.note.createdAt !== left.note.createdAt) {
      return right.note.createdAt - left.note.createdAt;
    }
    return left.note.id - right.note.id;
  });
}
function searchNotes(args) {
  if (args.limit <= 0) {
    return [];
  }
  const notes = [
    ...getNotes(args.db, {
      sessionId: args.sessionId,
      type: "session",
      status: NOTE_SEARCHABLE_STATUSES
    }),
    ...getNotes(args.db, {
      projectPath: args.projectPath,
      type: "smart",
      status: NOTE_SEARCHABLE_STATUSES
    })
  ].filter((note) => timestampIsInRange(note.createdAt, args.dateRange));
  if (notes.length === 0) {
    return [];
  }
  const baseList = rankNotesForNeedle(notes, args.query);
  const probes = args.probes ?? [];
  if (probes.length === 0) {
    const ranked = baseList.slice(0, args.limit);
    return ranked.map((entry) => ({
      source: "note",
      content: previewText(entry.text),
      score: normalizeNoteKeywordScore(entry.score),
      noteId: entry.note.id,
      status: entry.note.status,
      createdAt: entry.note.createdAt,
      anchorOrdinal: entry.note.anchorOrdinal,
      sourceSessionId: entry.note.sessionId
    }));
  }
  const queryLists = [];
  if (baseList.length > 0) {
    queryLists.push({ rows: baseList, weight: 1 });
  }
  for (const probe of probes) {
    const rows = rankNotesForNeedle(notes, probe);
    if (rows.length === 0) {
      continue;
    }
    const weight = probeDiscriminationWeight(rows.length, notes.length);
    queryLists.push({ rows, weight });
  }
  const fused = new Map;
  for (const list of queryLists) {
    for (const row of list.rows) {
      const relevance = row.score * list.weight;
      const existing = fused.get(row.note.id);
      if (existing) {
        if (relevance > existing.score) {
          existing.entry = row;
          existing.score = relevance;
        }
      } else {
        fused.set(row.note.id, { entry: row, score: relevance });
      }
    }
  }
  const ranked = [...fused.values()].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.entry.note.createdAt !== left.entry.note.createdAt) {
      return right.entry.note.createdAt - left.entry.note.createdAt;
    }
    return left.entry.note.id - right.entry.note.id;
  }).slice(0, args.limit);
  return ranked.map((entry) => ({
    source: "note",
    content: previewText(entry.entry.text),
    score: normalizeNoteKeywordScore(entry.score),
    noteId: entry.entry.note.id,
    status: entry.entry.note.status,
    createdAt: entry.entry.note.createdAt,
    anchorOrdinal: entry.entry.note.anchorOrdinal,
    sourceSessionId: entry.entry.note.sessionId
  }));
}
function searchCompartmentChunks(args) {
  if (!args.queryEmbedding || args.limit <= 0 || !args.modelId || args.modelId === "off")
    return [];
  const cutoff = args.maxOrdinal != null && args.maxOrdinal >= 0 ? args.maxOrdinal : null;
  const rows = loadCompartmentChunkEmbeddingsForSearch(args.db, args.sessionId, args.projectPath, args.modelId, args.dateRange);
  if (rows.length === 0)
    return [];
  const byCompartment = new Map;
  for (const row of rows) {
    if (cutoff !== null && row.endOrdinal > cutoff) {
      continue;
    }
    const score = normalizeCosineScore(cosineSimilarity(args.queryEmbedding, row.vector));
    if (score <= 0)
      continue;
    const existing = byCompartment.get(row.compartmentId);
    if (!existing || score > existing.score) {
      byCompartment.set(row.compartmentId, { row, score });
    }
  }
  return [...byCompartment.values()].sort((left, right) => right.score !== left.score ? right.score - left.score : left.row.startOrdinal - right.row.startOrdinal).slice(0, args.limit).map(({ row, score }) => ({
    source: "compartment",
    content: previewText(row.title),
    score: score * SINGLE_SOURCE_PENALTY,
    compartmentId: row.compartmentId,
    sessionId: row.sessionId,
    title: row.title,
    startOrdinal: row.startOrdinal,
    endOrdinal: row.endOrdinal,
    matchType: "semantic"
  }));
}
function mergeMessageAndCompartmentResults(args) {
  if (args.compartments.length === 0)
    return args.messages;
  if (args.messages.length === 0)
    return args.compartments;
  const fused = new Map;
  const add = (key, result, score, tieOrdinal) => {
    const existing = fused.get(key);
    if (existing) {
      existing.score += score;
      return existing;
    }
    const entry = { result, score, tieOrdinal, snippetScore: -1 };
    fused.set(key, entry);
    return entry;
  };
  args.compartments.forEach((compartment, rank) => {
    add(`compartment:${compartment.compartmentId}`, compartment, 1 / (RRF_K + rank), compartment.startOrdinal);
  });
  for (const [rank, message] of args.messages.entries()) {
    const containing = args.compartments.find((compartment) => message.messageOrdinal >= compartment.startOrdinal && message.messageOrdinal <= compartment.endOrdinal);
    const contribution = 1 / (RRF_K + rank);
    if (!containing) {
      add(`message:${message.messageId}`, message, contribution, message.messageOrdinal);
      continue;
    }
    const entry = add(`compartment:${containing.compartmentId}`, containing, contribution, containing.startOrdinal);
    if (message.score > entry.snippetScore && entry.result.source === "compartment") {
      entry.snippetScore = message.score;
      entry.result = {
        ...entry.result,
        matchType: "hybrid",
        snippet: message.content
      };
    }
  }
  const ranked = [...fused.values()].sort((left, right) => right.score !== left.score ? right.score - left.score : left.tieOrdinal - right.tieOrdinal).slice(0, args.limit);
  return ranked.map((entry, rank) => ({
    ...entry.result,
    score: linearDecayScore(rank, ranked.length)
  }));
}
function getSourceBoost(result) {
  switch (result.source) {
    case "memory":
      return MEMORY_SOURCE_BOOST;
    case "message":
    case "compartment":
      return MESSAGE_SOURCE_BOOST;
    case "git_commit":
      return GIT_COMMIT_SOURCE_BOOST;
    case "primer":
      return PRIMER_SOURCE_BOOST;
    case "note":
      return 1;
  }
}
function compareUnifiedResults(left, right) {
  const leftEffective = left.score * getSourceBoost(left);
  const rightEffective = right.score * getSourceBoost(right);
  if (rightEffective !== leftEffective) {
    return rightEffective - leftEffective;
  }
  if (left.source === "memory" && right.source === "memory") {
    return left.memoryId - right.memoryId;
  }
  if (left.source === "message" && right.source === "message") {
    return left.messageOrdinal - right.messageOrdinal;
  }
  if (left.source === "compartment" && right.source === "compartment") {
    return left.startOrdinal - right.startOrdinal;
  }
  if (left.source === "git_commit" && right.source === "git_commit") {
    return right.committedAtMs - left.committedAtMs;
  }
  if (left.source === "primer" && right.source === "primer") {
    return right.support - left.support || left.primerId - right.primerId;
  }
  if (left.source === "note" && right.source === "note") {
    return right.createdAt - left.createdAt || left.noteId - right.noteId;
  }
  return 0;
}
function toGitCommitResult(hit) {
  return {
    source: "git_commit",
    content: previewText(hit.commit.message),
    score: hit.score,
    sha: hit.commit.sha,
    shortSha: hit.commit.shortSha,
    author: hit.commit.author,
    committedAtMs: hit.commit.committedAtMs,
    matchType: hit.matchType
  };
}
function searchGitCommits(args) {
  if (args.limit <= 0)
    return [];
  const hits = searchGitCommitsSync(args.db, args.projectPath, args.query, {
    limit: args.limit,
    queryEmbedding: args.queryEmbedding,
    queryModelId: args.queryModelId,
    from: args.dateRange?.from,
    to: args.dateRange?.to
  });
  return hits.map(toGitCommitResult);
}
function primerText(primer) {
  const answer = primer.answer.trim();
  return answer ? `Q: ${primer.question}
A: ${answer}` : `Q: ${primer.question}`;
}
function searchPrimers(args) {
  const primers = getActivePrimers(args.db, args.projectPath).filter((primer) => timestampIsInRange(primer.createdAt, args.dateRange));
  if (primers.length === 0 || args.limit <= 0)
    return [];
  const ftsQuery = sanitizeFtsQuery(args.query);
  const ftsRanks = new Map;
  if (ftsQuery) {
    const rows = args.db.prepare(`SELECT p.id AS id, bm25(primers_fts) AS rank
                 FROM primers_fts
                 JOIN primers p ON p.id = primers_fts.rowid
                  WHERE primers_fts MATCH ? AND p.project_path = ? AND p.status = 'active'
                    ${args.dateRange === null ? "" : "AND p.created_at BETWEEN ? AND ?"}
                  ORDER BY rank ASC
                  LIMIT ?`).all(ftsQuery, args.projectPath, ...args.dateRange === null ? [] : [args.dateRange.from, args.dateRange.to], args.limit * 3);
    rows.forEach((row, index) => {
      ftsRanks.set(row.id, linearDecayScore(index, rows.length));
    });
  }
  const scored = primers.map((primer) => {
    const semantic = args.queryEmbedding && primer.questionEmbedding && primer.questionEmbeddingModelId === args.queryModelId ? normalizeCosineScore(cosineSimilarity(args.queryEmbedding, primer.questionEmbedding)) : 0;
    const fts = ftsRanks.get(primer.id) ?? 0;
    if (semantic <= 0 && fts <= 0)
      return null;
    const score = semantic > 0 && fts > 0 ? semantic * SEMANTIC_WEIGHT + fts * FTS_WEIGHT : Math.max(semantic, fts);
    return {
      source: "primer",
      content: previewText(primerText(primer)),
      score,
      primerId: primer.id,
      question: primer.question,
      support: primer.totalSupport,
      lastObservedAt: primer.lastObservedAt,
      matchType: semantic > 0 && fts > 0 ? "hybrid" : semantic > 0 ? "semantic" : "fts"
    };
  }).filter((result) => result !== null).sort((a, b) => b.score - a.score || b.support - a.support || a.primerId - b.primerId).slice(0, args.limit);
  return scored;
}
function resolveSources(sources) {
  if (sources === undefined) {
    return new Set(["memory", "message", "git_commit", "primer", "note"]);
  }
  const set = new Set;
  for (const source of sources) {
    if (source === "memory" || source === "message" || source === "git_commit" || source === "primer" || source === "note") {
      set.add(source);
    }
  }
  return set;
}
function memoriesToIdLookupResults(args) {
  const ordered = args.memories.slice(0, args.limit);
  return ordered.map((memory, rank) => ({
    source: "memory",
    content: previewText(memory.content),
    score: 1 - rank * 0.01,
    memoryId: memory.id,
    category: memory.category,
    matchType: "fts",
    sourceName: args.sourceNameByMemoryId?.get(memory.id)
  }));
}
function resolveMemoriesByIdsForSearch(args) {
  if (args.diagnostics) {
    args.diagnostics.suppressedVisibleMemoryIds = [];
  }
  if (args.ids.length === 0) {
    return null;
  }
  const workspace = resolveSearchWorkspaceContext(args.db, args.projectPath);
  const fetched = workspace.isWorkspaced ? getMemoriesByProjects(args.db, workspace.expandedIdentities, ["active", "permanent", "archived"], Date.now(), workspace.ownIdentities, workspace.shareCategories) : getMemoriesByProject(args.db, args.projectPath, ["active", "permanent", "archived"]);
  if (fetched.length === 0) {
    return null;
  }
  const dateRange = normalizeDateRange(args.from, args.to);
  const memoriesById = new Map(fetched.filter((memory) => timestampIsInRange(memory.createdAt, dateRange)).map((memory) => [memory.id, memory]));
  const ordered = [];
  const suppressedVisibleIds = new Set;
  for (const id of args.ids) {
    const memory = memoriesById.get(id);
    if (!memory)
      continue;
    if (args.visibleMemoryIds?.has(id)) {
      suppressedVisibleIds.add(id);
      continue;
    }
    ordered.push(memory);
    if (ordered.length >= args.limit)
      break;
  }
  if (args.diagnostics) {
    args.diagnostics.suppressedVisibleMemoryIds = [...suppressedVisibleIds].sort((left, right) => left - right);
  }
  if (ordered.length === 0) {
    return null;
  }
  return memoriesToIdLookupResults({
    memories: ordered,
    limit: args.limit,
    sourceNameByMemoryId: sourceNamesForSearchMemories({
      memories: ordered,
      projectPath: args.projectPath,
      workspace
    })
  });
}
async function unifiedSearch(db, sessionId, projectPath, query, options = {}) {
  const trimmedQuery = query.trim();
  const measurementStartedAt = Date.now();
  if (trimmedQuery.length === 0 || options.signal?.aborted) {
    return [];
  }
  const limit = normalizeLimit2(options.limit);
  const dateRange = normalizeDateRange(options.from, options.to);
  const tierLimit = Math.max(limit * 3, DEFAULT_UNIFIED_SEARCH_LIMIT);
  if (options.diagnostics) {
    options.diagnostics.suppressedVisibleMemoryIds = [];
    options.diagnostics.suppressedLiveMessageMatches = 0;
    options.diagnostics.gitCommitUnavailable = null;
  }
  const embeddingEnabled = options.embeddingEnabled ?? true;
  const embedQuery = options.embedQuery ?? embedText;
  const isEmbeddingRuntimeEnabled = options.isEmbeddingRuntimeEnabled ?? isEmbeddingEnabled;
  const gitCommitsEnabled = options.gitCommitsEnabled ?? false;
  const activeSources = resolveSources(options.sources);
  const memoryFeatureEnabled = options.memoryEnabled ?? true;
  const runMemory = activeSources.has("memory") && memoryFeatureEnabled;
  const runMessages = activeSources.has("message");
  const runGitCommits = activeSources.has("git_commit") && gitCommitsEnabled;
  if (options.diagnostics && activeSources.has("git_commit") && options.gitRepositoryAvailable === false) {
    options.diagnostics.gitCommitUnavailable = "no_git_repository";
  }
  const runPrimers = activeSources.has("primer") && memoryFeatureEnabled;
  const runNotes = activeSources.has("note");
  const runCompartmentChunks = runMessages && embeddingEnabled;
  const needsEmbedding = (runMemory || runGitCommits || runCompartmentChunks || runPrimers) && embeddingEnabled && isEmbeddingRuntimeEnabled();
  const queryEmbeddingPromise = needsEmbedding ? embedQuery(trimmedQuery, options.signal).catch((error) => {
    log(`[search] query embedding failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }) : Promise.resolve(null);
  await Promise.resolve();
  if (options.signal?.aborted)
    return [];
  const messageProbes = options.explicitSearch ? extractLiteralProbes(trimmedQuery) : [];
  const messageResults = runMessages ? searchMessages({
    db,
    sessionId,
    query: trimmedQuery,
    limit: tierLimit,
    maxOrdinal: options.maxMessageOrdinal,
    probes: messageProbes,
    relaxedRecall: options.explicitSearch,
    diagnostics: options.diagnostics,
    dateRange
  }) : [];
  const capturedQuery = await queryEmbeddingPromise;
  if (options.signal?.aborted)
    return [];
  const embeddingSnapshot = getProjectEmbeddingSnapshot(projectPath);
  const queryContract = capturedQuery instanceof Float32Array || capturedQuery === null ? null : capturedQuery;
  const generationIsCurrent = queryContract === null || embeddingSnapshot !== null && embeddingSnapshot.generation === queryContract.generation;
  const queryEmbedding = generationIsCurrent ? queryContract?.vector ?? (capturedQuery instanceof Float32Array ? capturedQuery : null) : null;
  const workspace = resolveSearchWorkspaceContext(db, projectPath);
  const embeddingModelId = queryContract?.modelId ?? options.embeddingModelIdOverride ?? embeddingSnapshot?.modelId;
  const chunkModelId = queryContract?.chunkModelId ?? options.chunkModelIdOverride ?? embeddingSnapshot?.chunkModelId;
  const compartmentResults = runCompartmentChunks ? searchCompartmentChunks({
    db,
    sessionId,
    projectPath,
    queryEmbedding,
    limit: tierLimit,
    maxOrdinal: options.maxMessageOrdinal,
    modelId: chunkModelId && chunkModelId !== "off" ? chunkModelId : null,
    dateRange
  }) : [];
  const messageLikeResults = mergeMessageAndCompartmentResults({
    messages: messageResults,
    compartments: compartmentResults,
    limit: tierLimit
  });
  const [memoryOutcome, gitCommitResults, primerResults, noteResults] = await Promise.all([
    runMemory ? searchMemories({
      db,
      projectPath,
      query: trimmedQuery,
      limit: tierLimit,
      memoryEnabled: true,
      queryEmbedding,
      queryModelId: embeddingModelId && embeddingModelId !== "off" ? embeddingModelId : null,
      workspace,
      visibleMemoryIds: options.visibleMemoryIds,
      dateRange
    }) : Promise.resolve({
      results: [],
      suppressedVisibleIds: []
    }),
    runGitCommits ? Promise.resolve(searchGitCommits({
      db,
      projectPath,
      query: trimmedQuery,
      limit: tierLimit,
      queryEmbedding,
      queryModelId: embeddingModelId && embeddingModelId !== "off" ? embeddingModelId : null,
      dateRange
    })) : Promise.resolve([]),
    runPrimers ? Promise.resolve(searchPrimers({
      db,
      projectPath,
      query: trimmedQuery,
      limit: tierLimit,
      queryEmbedding,
      queryModelId: embeddingModelId && embeddingModelId !== "off" ? embeddingModelId : null,
      dateRange
    })) : Promise.resolve([]),
    runNotes ? Promise.resolve(searchNotes({
      db,
      sessionId,
      projectPath,
      query: trimmedQuery,
      limit: tierLimit,
      probes: messageProbes,
      dateRange
    })) : Promise.resolve([])
  ]);
  if (options.diagnostics) {
    options.diagnostics.suppressedVisibleMemoryIds = memoryOutcome.suppressedVisibleIds;
  }
  const results = [
    ...memoryOutcome.results,
    ...primerResults,
    ...messageLikeResults,
    ...gitCommitResults,
    ...noteResults
  ].sort(compareUnifiedResults).slice(0, limit);
  if (!options.measurementDisabled) {
    recordShadowMeasurement({
      db,
      sessionId,
      projectPath,
      query: trimmedQuery,
      options,
      primaryResults: results,
      primaryQuery: queryContract,
      primaryLatencyMs: Date.now() - measurementStartedAt,
      search: unifiedSearch
    });
  }
  const countRetrievals = options.countRetrievals ?? true;
  if (countRetrievals) {
    const memoryIds = results.filter((result) => result.source === "memory").map((result) => result.memoryId);
    if (memoryIds.length > 0) {
      db.transaction(() => {
        for (const memoryId of memoryIds) {
          try {
            updateMemoryRetrievalCount(db, memoryId);
          } catch (error) {
            if (error instanceof ModuleMemoryAuthorityError)
              continue;
            throw error;
          }
        }
      }).immediate();
    }
  }
  return results;
}
var SEARCH_NOTE_EXPAND_HINT = "Use ctx_expand(start=N-10, end=N) around any note @msg anchor above to read the surrounding conversation context.";
function formatSearchAge(timestampMs) {
  const ageMs = Date.now() - timestampMs;
  if (ageMs < 0)
    return "future";
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days <= 0)
    return "today";
  if (days === 1)
    return "1d ago";
  if (days < 30)
    return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months === 1)
    return "1mo ago";
  if (months < 12)
    return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "1y ago" : `${years}y ago`;
}
function formatUnifiedSearchResult(result, index, currentSessionId) {
  if (result.source === "memory") {
    const source = result.sourceName ? ` source=${result.sourceName}` : "";
    return [
      `[${index}] [memory] score=${result.score.toFixed(2)} id=${result.memoryId} category=${result.category}${source} match=${result.matchType}`,
      result.content
    ].join(`
`);
  }
  if (result.source === "git_commit") {
    return [
      `[${index}] [git_commit] score=${result.score.toFixed(2)} sha=${result.shortSha} ${formatSearchAge(result.committedAtMs)} match=${result.matchType}`,
      result.content
    ].join(`
`);
  }
  if (result.source === "primer") {
    return [
      `[${index}] [primer] score=${result.score.toFixed(2)} id=${result.primerId} support=${result.support} match=${result.matchType}`,
      result.content
    ].join(`
`);
  }
  if (result.source === "note") {
    const anchor = result.anchorOrdinal !== null && result.sourceSessionId === currentSessionId ? ` @msg ${result.anchorOrdinal}` : "";
    return [
      `[${index}] [note] score=${result.score.toFixed(2)} id=#${result.noteId} status=${result.status} ${formatSearchAge(result.createdAt)}${anchor}`,
      result.content
    ].join(`
`);
  }
  if (result.source === "compartment") {
    return [
      `[${index}] [message] score=${result.score.toFixed(2)} compartment_id=${result.compartmentId} range=${result.startOrdinal}-${result.endOrdinal} match=${result.matchType} title=${result.title}`,
      result.snippet ? `Snippet: ${result.snippet}` : result.content
    ].join(`
`);
  }
  const expandStart = Math.max(1, result.messageOrdinal - 3);
  const expandEnd = result.messageOrdinal + 3;
  return [
    `[${index}] [message] score=${result.score.toFixed(2)} ordinal=${result.messageOrdinal} range=${expandStart}-${expandEnd} role=${result.role}`,
    result.content
  ].join(`
`);
}
function formatSearchDiagnosticLines(results, diagnostics) {
  if (!diagnostics)
    return [];
  const lines = [];
  const visibleIds = [...diagnostics.suppressedVisibleMemoryIds].sort((left, right) => left - right);
  if (visibleIds.length > 0) {
    const count = visibleIds.length;
    const noun = count === 1 ? "match" : "matches";
    const ids = visibleIds.join(", ");
    if (results.some((result) => result.source === "memory")) {
      lines.push(`Memories: ${count} additional ${noun} suppressed because ${count === 1 ? "it is" : "they are"} already visible in your project-memory block (ids ${ids}).`);
    } else {
      lines.push(`Memories: ${count} ${noun} found, all already visible in your project-memory block (ids ${ids}).`);
    }
  }
  if (diagnostics.suppressedLiveMessageMatches > 0) {
    const count = diagnostics.suppressedLiveMessageMatches;
    lines.push(`Message history: ${count} raw-message ${count === 1 ? "match is" : "matches are"} newer than the last compartment boundary (already in your context).`);
  }
  if (diagnostics.gitCommitUnavailable === "no_git_repository") {
    lines.push("Git commits: no git repository — commit search unavailable for this project.");
  }
  return lines;
}
function formatSearchResults(query, results, currentSessionId, diagnostics) {
  const diagnosticLines = formatSearchDiagnosticLines(results, diagnostics);
  if (results.length === 0) {
    if (diagnosticLines.length > 0) {
      return `No hidden results found for "${query}".

${diagnosticLines.join(`
`)}`;
    }
    return `No results found for "${query}" across notes, memories, primers, git commits, or message history.`;
  }
  const bodyParts = results.map((result, index) => formatUnifiedSearchResult(result, index + 1, currentSessionId));
  if (diagnosticLines.length > 0)
    bodyParts.push(diagnosticLines.join(`
`));
  if (results.some((result) => result.source === "message" || result.source === "compartment")) {
    bodyParts.push("Use ctx_expand(start, end) with the range from any message result above to read the full conversation context.");
  }
  if (results.some((result) => result.source === "note" && result.anchorOrdinal !== null && result.sourceSessionId === currentSessionId)) {
    bodyParts.push(SEARCH_NOTE_EXPAND_HINT);
  }
  return `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":

${bodyParts.join(`

`)}`;
}

// ../plugin/src/tools/ctx-search/date-range.ts
class SearchDateRangeError extends Error {
  code = "invalid_search_date_range";
}
var DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
var FULL_ISO = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/;
function parseDate(value, field) {
  const trimmed = value.trim();
  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const start = Date.UTC(year, month - 1, day);
    const roundTrip = new Date(start);
    if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== day) {
      throw new SearchDateRangeError(`Invalid '${field}' date; use YYYY-MM-DD or a full ISO datetime.`);
    }
    return field === "to" ? start + 24 * 60 * 60 * 1000 - 1 : start;
  }
  if (FULL_ISO.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (Number.isSafeInteger(parsed))
      return parsed;
  }
  throw new SearchDateRangeError(`Invalid '${field}' date; use YYYY-MM-DD or a full ISO datetime.`);
}
function parseSearchDateRange(from, to) {
  const parsed = {
    ...from === undefined ? {} : { from: parseDate(from, "from") },
    ...to === undefined ? {} : { to: parseDate(to, "to") }
  };
  if (parsed.from !== undefined && parsed.to !== undefined && parsed.from > parsed.to) {
    throw new SearchDateRangeError("Invalid date range; 'from' must be on or before 'to'.");
  }
  return parsed;
}

// ../plugin/src/tools/ctx-search/tools.ts
var VALID_SOURCES = new Set([
  "memory",
  "message",
  "git_commit",
  "primer",
  "note"
]);
function normalizeLimit3(limit) {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit === 0) {
    return DEFAULT_CTX_SEARCH_LIMIT;
  }
  return Math.max(1, Math.floor(limit));
}
function normalizeSources(sources) {
  if (sources === undefined)
    return;
  const result = [];
  const seen = new Set;
  for (const source of sources) {
    if (VALID_SOURCES.has(source)) {
      const typed = source;
      if (!seen.has(typed)) {
        seen.add(typed);
        result.push(typed);
      }
    }
  }
  return sources.length === 0 ? undefined : result;
}
var ctxSearchArgsShape = {
  query: tool.schema.string().optional().describe("A natural-language question carrying the exact terms you expect in the answer."),
  limit: tool.schema.number().optional().describe("Maximum results (default 10)."),
  from: tool.schema.string().optional().describe("Earliest date, YYYY-MM-DD (inclusive)."),
  to: tool.schema.string().optional().describe("Latest date, YYYY-MM-DD (inclusive; default open)."),
  sources: tool.schema.array(tool.schema.enum(["memory", "message", "git_commit", "primer", "note"])).optional().describe("Restrict to these sources; omitting it or passing [] searches every source.")
};
var ctxSearchArgsSchema = tool.schema.object(ctxSearchArgsShape).passthrough();
function createCtxSearchTool(deps) {
  return tool({
    description: CTX_SEARCH_DESCRIPTION,
    args: ctxSearchArgsShape,
    async execute(rawArgs, toolContext) {
      const parsedArgs = ctxSearchArgsSchema.safeParse(rawArgs);
      let args = parsedArgs.success ? parsedArgs.data : rawArgs;
      args = unwrapImitatedReducedArgs(args, ["query"], {
        query: "string",
        limit: "number",
        from: "string",
        to: "string",
        sources: {
          type: "array",
          items: "string",
          maxItems: 5,
          values: ["memory", "message", "git_commit", "primer", "note"]
        }
      });
      const query = args.query?.trim();
      if (!query) {
        return "Error: 'query' is required.";
      }
      let dateRange;
      try {
        dateRange = parseSearchDateRange(args.from, args.to);
      } catch (error) {
        if (error instanceof SearchDateRangeError)
          return `Error: ${error.message}`;
        throw error;
      }
      const messageOrdinalCutoff = Math.max(0, deps.resolveMessageOrdinalCutoff ? deps.resolveMessageOrdinalCutoff(toolContext.sessionID) : getLastCompartmentEndMessage(deps.db, toolContext.sessionID));
      const visibleMemoryIds = getVisibleMemoryIds(deps.db, toolContext.sessionID);
      const diagnostics = createUnifiedSearchDiagnostics();
      const projectPath = deps.resolveProjectPath(toolContext.directory);
      if (!projectPath) {
        return `Error: Could not resolve project identity for search: ${describeUnresolvedProjectIdentity(toolContext.directory)}`;
      }
      await deps.ensureProjectRegistered?.(toolContext.directory, deps.db);
      const embeddingSnapshot = getProjectEmbeddingSnapshot(projectPath);
      const memoryEnabled = embeddingSnapshot?.features.memoryEnabled ?? deps.memoryEnabled;
      const embeddingEnabled = embeddingSnapshot ? embeddingSnapshot.historyEnabled : deps.embeddingEnabled;
      const gitCommitsEnabled = embeddingSnapshot?.gitCommitEnabled ?? deps.gitCommitsEnabled ?? false;
      const idShape = parseIdShapedQuery(query);
      if (idShape && memoryEnabled) {
        const idResults = resolveMemoriesByIdsForSearch({
          db: deps.db,
          projectPath,
          ids: idShape,
          limit: Math.max(normalizeLimit3(args.limit), idShape.length),
          visibleMemoryIds,
          diagnostics,
          ...dateRange
        });
        if (idResults !== null || diagnostics.suppressedVisibleMemoryIds.length > 0) {
          return formatSearchResults(query, idResults ?? [], toolContext.sessionID, diagnostics);
        }
      }
      const results = await unifiedSearch(deps.db, toolContext.sessionID, projectPath, query, {
        limit: normalizeLimit3(args.limit),
        memoryEnabled,
        embeddingEnabled,
        embedQuery: async (text, signal) => {
          const result = await embedTextForProject(projectPath, text, signal, "query");
          return result;
        },
        isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
        readMessages: deps.readMessages,
        maxMessageOrdinal: messageOrdinalCutoff,
        gitCommitsEnabled,
        sources: normalizeSources(args.sources),
        visibleMemoryIds,
        diagnostics,
        gitRepositoryAvailable: typeof toolContext.directory === "string" ? directoryHasGitMetadata(toolContext.directory) : undefined,
        explicitSearch: true,
        ...dateRange
      });
      return formatSearchResults(query, results, toolContext.sessionID, diagnostics);
    }
  });
}
function createCtxSearchTools(deps) {
  return {
    [CTX_SEARCH_TOOL_NAME]: createCtxSearchTool(deps)
  };
}
// src/operation-skills/tool.ts
var z = tool.schema;
var trimmed = (description) => z.string().trim().min(1).describe(description);
var operationSchema = z.object({
  id: trimmed("Stable id of the operation, lowercase-kebab, e.g. save-order."),
  trigger: z.object({
    kind: z.enum(TRIGGER_KINDS).describe("What the user acts on."),
    label: trimmed('Visible label or event name, e.g. "保存" or "order:submitted".'),
    location: z.string().optional().describe("Where the trigger is defined, project-relative `path:line`."),
    selector: z.string().optional().describe("CSS selector / test id, when there is one."),
    event: z.string().optional().describe("onClick, submit, change, ...")
  }),
  intents: z.array(z.string()).optional().describe('Phrases a user would say for it, e.g. ["保存订单", "save the order"].'),
  action: z.object({
    summary: trimmed("What the action does, end to end, in one or two sentences."),
    handler: z.string().optional().describe("Handler function name."),
    location: z.string().optional().describe("Handler location, `path:line`.")
  }),
  apis: z.array(z.object({
    method: z.string().optional(),
    endpoint: trimmed("Path, RPC or mutation name."),
    request: z.string().optional().describe("Body / parameters it sends."),
    response: z.string().optional(),
    handler: z.string().optional().describe("Server handler, `path:symbol`.")
  })).optional().describe("Backend calls the action makes, in order."),
  writes: z.array(z.object({
    target: trimmed("Table, collection, file, storage key, queue..."),
    fields: z.string().optional(),
    detail: z.string().optional()
  })).optional().describe("Data the operation writes. The most important part: what each button writes."),
  state: z.array(z.object({
    target: trimmed("Store, cache key or component state."),
    change: trimmed("How it changes."),
    location: z.string().optional()
  })).optional().describe("Client state the operation updates."),
  save_and_linkage: z.string().optional().describe("How saving completes and what else updates: refetches, events, other views."),
  files_to_modify: z.array(z.string()).optional().describe("Files to change when this operation has to change, project-relative."),
  steps: z.array(z.string()).min(1).describe(`How you (the agent) perform the operation directly, in order, as runnable commands or requests with <placeholders>, e.g. curl -X POST $BASE/api/notes -d '{"text":"<text>"}'. Not clicks: the trigger already names the button. UI steps only when there is no other way, with the selector.`),
  verification: z.object({
    method: trimmed("How the flow was verified (test, request + DB check, UI run)."),
    evidence: z.string().optional().describe("Command, test name or observed result.")
  })
});
var argsSchema = z.object({
  action: z.enum(["list", "find", "read", "save", "verify", "remove"]).describe("list: this project's skills. find: the operation for a request, button or event. read: a skill or one operation in full. save: create or update a skill. verify: record a fresh verification. remove: delete an operation or skill."),
  name: z.string().optional().describe("Skill name, lowercase-kebab (read/save/verify/remove)."),
  operation: z.string().optional().describe("Operation id (read/verify/remove)."),
  query: z.string().optional().describe("find: the user's request or the button/event it names, verbatim."),
  title: z.string().optional().describe("save: human title, e.g. 订单编辑页."),
  description: z.string().optional().describe("save: when to use the skill, naming its buttons/events; Claude Code uses it to trigger the skill."),
  scope: z.string().optional().describe('save: project-relative directory the skill covers, e.g. "apps/web" ("." = whole project).'),
  setup: z.array(z.string()).optional().describe("save: how to get the project ready to run these operations, as commands: start the app/server (and how to read its port), base URL, test account, env. Replaces the recorded setup."),
  operations: z.array(operationSchema).optional().describe("save: operations to add or replace (matched by id)."),
  verification: z.object({ method: trimmed("How it was re-verified."), evidence: z.string().optional() }).optional().describe("verify: the new verification.")
});
var CTX_SKILL_DESCRIPTION = `Operation skills: this project's verified flows, mapped from a trigger (button, form, event, route...) to the action behind it, the APIs it calls, the data it writes, the state it updates, how saving and linked updates complete, the steps to perform it, and how it was verified. They live in the project's .claude/skills/ and load as native skills in later sessions.

- find (query = the user's request verbatim): before working out how a UI action or flow works, look it up. A hit gives the recorded action and steps; follow them instead of re-analysing the code. Re-check only files reported as changed since verification.
- list / read: the project's skills; one skill or one operation in full.
- save: after you have traced AND verified a flow that writes data, record it. One operation per button/event; update an existing skill (same name, same operation id) instead of creating a duplicate. Writes are the most important part: say exactly what each button writes and where. Record the setup (how to start the app and reach it) and steps as commands you can run, so a later session performs the operation without reading the code.
- verify: after re-checking an operation whose files changed, record the new verification.
- remove: delete an operation or a whole skill that no longer exists.`;
function textOf2(lines) {
  return { text: lines.join(`
`), isError: false };
}
function error45(message) {
  return { text: `Error: ${message}`, isError: true };
}
function setupLines(skill) {
  const setup = renderSetup(skill);
  return setup ? ["Setup / 准备 (skip what is already running):", setup, ""] : [];
}
function needs(value, what, action) {
  if (value === undefined || typeof value === "string" && value.trim() === "") {
    throw new OperationSkillError(`${action} needs ${what}`);
  }
  return value;
}
function run(projectDir, args) {
  switch (args.action) {
    case "list": {
      const skills = listSkills(projectDir);
      if (skills.length === 0) {
        return textOf2([
          "No operation skills are recorded for this project yet. Trace and verify a flow, then save it with ctx_skill save."
        ]);
      }
      const lines = [`${skills.length} operation skill(s) in .claude/skills/:`];
      for (const skill of skills) {
        lines.push("", `${skill.name} — ${skill.title} (scope: ${skill.scope})`);
        for (const operation of skill.operations) {
          const drift = driftOf(projectDir, operation);
          const effect = operation.writes.map((write) => write.target).join(", ");
          lines.push(`  - ${operation.id}: ${operation.trigger.kind} "${operation.trigger.label}"${effect ? ` → writes ${effect}` : ""} (verified ${operation.verification.verifiedAt.slice(0, 10)}${isStale(drift) ? ", files changed since" : ""})`);
        }
      }
      return textOf2(lines);
    }
    case "find": {
      const query = needs(args.query, "a query", "find");
      const matches = findOperations(projectDir, query);
      if (matches.length === 0) {
        return textOf2([
          `No recorded operation matches "${query}". Trace the flow in the code; once it is verified, save it with ctx_skill save.`
        ]);
      }
      const [best, ...others] = matches;
      const lines = [
        `Best match: skill "${best.skill.name}" (${best.skill.title}, scope ${best.skill.scope}), operation "${best.operation.id}":`,
        "",
        ...setupLines(best.skill),
        renderOperation(best.operation, driftOf(projectDir, best.operation))
      ];
      if (others.length > 0) {
        lines.push("", "Other candidates:", ...others.map((match) => `- ${match.skill.name}/${match.operation.id}: ${match.operation.trigger.kind} "${match.operation.trigger.label}"`));
      }
      return textOf2(lines);
    }
    case "read": {
      const name = needs(args.name, "a skill name", "read");
      const skill = loadSkill(projectDir, name);
      if (!skill)
        return error45(`no operation skill named "${name}" (ctx_skill list)`);
      const operations = args.operation ? skill.operations.filter((operation) => operation.id === args.operation) : skill.operations;
      if (operations.length === 0) {
        return error45(`skill "${name}" has no operation "${args.operation}"`);
      }
      return textOf2([
        `# ${skill.title} (${skill.name}, scope ${skill.scope})`,
        "",
        skill.description,
        "",
        ...setupLines(skill),
        operations.map((operation) => renderOperation(operation, driftOf(projectDir, operation))).join(`

`)
      ]);
    }
    case "save": {
      const name = needs(args.name, "a skill name", "save");
      const operations = (args.operations ?? []).map((operation) => ({
        id: operation.id,
        trigger: operation.trigger,
        intents: operation.intents,
        action: operation.action,
        apis: operation.apis ?? [],
        writes: operation.writes ?? [],
        state: operation.state ?? [],
        saveAndLinkage: operation.save_and_linkage,
        filesToModify: operation.files_to_modify ?? [],
        steps: operation.steps,
        verification: operation.verification
      }));
      const { skill, created } = saveSkill(projectDir, {
        name,
        title: args.title,
        description: args.description,
        scope: args.scope,
        setup: args.setup,
        operations
      });
      const tracked = new Set(skill.operations.flatMap((operation) => Object.keys(operation.fileHashes)));
      return textOf2([
        `${created ? "Created" : "Updated"} operation skill "${skill.name}" with ${skill.operations.length} operation(s) in .claude/skills/${skill.name}/ (SKILL.md + flow.json); ${tracked.size} file(s) tracked for changes.`,
        "ctx_skill find/read serve it now; Claude Code loads it as a native skill from the next session."
      ]);
    }
    case "verify": {
      const name = needs(args.name, "a skill name", "verify");
      const operation = needs(args.operation, "an operation id", "verify");
      const verification = needs(args.verification, "a verification", "verify");
      markVerified(projectDir, name, operation, verification);
      return textOf2([
        `Recorded a fresh verification of ${name}/${operation}; its files are tracked from their current contents.`
      ]);
    }
    case "remove": {
      const name = needs(args.name, "a skill name", "remove");
      const removed = removeSkillOrOperation(projectDir, name, args.operation);
      return textOf2([
        removed === "skill" ? `Removed operation skill "${name}".` : `Removed operation "${args.operation}" from "${name}".`
      ]);
    }
    default:
      return error45(`unknown action "${String(args.action)}"`);
  }
}
function describeIssues(issues) {
  return issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "arguments"}: ${issue.message}`).join("; ");
}
function createCtxSkillTool(options) {
  return {
    name: "ctx_skill",
    description: CTX_SKILL_DESCRIPTION,
    inputSchema: z.toJSONSchema(argsSchema, { io: "input" }),
    annotations: {
      title: "ctx_skill",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false
    },
    async call(rawArgs) {
      const reason = options.unavailable?.();
      if (reason)
        return { text: reason, isError: true };
      const parsed = argsSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return {
          text: `Invalid arguments: ${describeIssues(parsed.error.issues)}`,
          isError: true
        };
      }
      try {
        return run(options.getProjectDir(), parsed.data);
      } catch (caught) {
        if (caught instanceof OperationSkillError)
          return error45(caught.message);
        throw caught;
      }
    }
  };
}

// src/tools.ts
var z2 = tool.schema;
var TOOL_PRESENTATION = {
  ctx_search: { description: CTX_SEARCH_CLAUDE_CODE_DESCRIPTION, readOnly: true },
  ctx_expand: {
    description: CTX_EXPAND_CLAUDE_CODE_DESCRIPTION,
    omitArgs: ["tag"],
    readOnly: true
  },
  ctx_note: {
    description: CTX_NOTE_CLAUDE_CODE_DESCRIPTION,
    omitArgs: ["surface_condition"],
    readOnly: false
  },
  ctx_memory: { readOnly: false }
};
var CLAUDE_CODE_TOOL_NAMES = [...Object.keys(TOOL_PRESENTATION), "ctx_skill"];
var DISABLED_MESSAGE = "Magic Context is disabled for this project (`enabled: false` in magic-context.jsonc).";
function resultText(result) {
  if (typeof result === "string")
    return result;
  if (result && typeof result === "object" && "output" in result) {
    const output = result.output;
    if (typeof output === "string")
      return output;
  }
  return String(result);
}
function describeIssues2(error) {
  return error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "arguments"}: ${issue.message}`).join("; ");
}
function indexCompactedMessages(db, sessionId, source) {
  try {
    const compacted = source.compactedThroughOrdinal();
    if (compacted <= 0)
      return;
    ensureMessagesIndexed(db, sessionId, () => source.provider.readMessages().slice(0, compacted));
  } catch (error) {
    log(`[magic-context] message indexing for ctx_search failed: ${getErrorMessage(error)}`);
  }
}
function buildCoreTools(runtime, transcriptFor) {
  const db = runtime?.db ?? null;
  const directoryConfig = runtime?.config;
  const resolveProjectPath = (directory) => resolveProjectIdentityForSession(directory, directoryConfig?.allow_home_project);
  const memoryEnabled = directoryConfig?.memory?.enabled !== false;
  const compactedThrough = (sessionId) => transcriptFor(sessionId)?.compactedThroughOrdinal() ?? 0;
  return {
    ...createCtxNoteTools({ db, dreamerEnabled: false, resolveProjectPath }),
    ...createCtxSearchTools({
      db,
      resolveProjectPath,
      ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
      resolveMessageOrdinalCutoff: compactedThrough
    }),
    ...memoryEnabled ? createCtxMemoryTools({
      db,
      resolveProjectPath,
      ensureProjectRegistered: ensureProjectRegisteredFromOpenCodeDirectory,
      allowedActions: [...CTX_MEMORY_ACTIONS]
    }) : {},
    ...createCtxExpandTools({
      db,
      expandTools: directoryConfig?.historian?.expand_tools,
      getLastCompactedOrdinal: (sessionId) => {
        const compacted = compactedThrough(sessionId);
        return compacted > 0 ? compacted : -1;
      }
    })
  };
}
function createClaudeCodeTools(input) {
  const { runtime, session, unavailableReason } = input;
  const currentSession = input.currentSession ?? (() => session);
  const transcripts = new Map;
  const transcriptFor = (sessionId) => {
    const known = transcripts.get(sessionId);
    if (known)
      return known;
    const path = locateTranscript({ sessionId, directory: session.directory });
    if (!path)
      return null;
    const source = createTranscriptSource(path);
    transcripts.set(sessionId, source);
    return source;
  };
  const core = buildCoreTools(runtime, transcriptFor);
  const tools = [];
  for (const [name, definition] of Object.entries(core)) {
    const presentation = TOOL_PRESENTATION[name];
    if (!presentation)
      continue;
    const shape = { ...definition.args };
    for (const omitted of presentation.omitArgs ?? [])
      delete shape[omitted];
    const parser = z2.object(shape).passthrough();
    tools.push({
      name,
      description: presentation.description ?? definition.description,
      inputSchema: z2.toJSONSchema(z2.object(shape), { io: "input" }),
      annotations: {
        title: name,
        readOnlyHint: presentation.readOnly,
        destructiveHint: false,
        openWorldHint: false
      },
      async call(rawArgs) {
        if (!runtime) {
          return {
            text: unavailableReason ?? "Magic Context storage is unavailable.",
            isError: true
          };
        }
        if (runtime.config.enabled !== true) {
          return { text: DISABLED_MESSAGE, isError: true };
        }
        const parsed = parser.safeParse(rawArgs ?? {});
        if (!parsed.success) {
          return {
            text: `Invalid arguments: ${describeIssues2(parsed.error)}`,
            isError: true
          };
        }
        const { sessionId, directory } = currentSession();
        const toolContext = {
          sessionID: sessionId,
          messageID: "",
          agent: "claude-code",
          directory,
          worktree: directory,
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {}
        };
        const execute = () => definition.execute(parsed.data, toolContext);
        const source = name === "ctx_search" || name === "ctx_expand" ? transcriptFor(sessionId) : null;
        if (source && name === "ctx_search") {
          indexCompactedMessages(runtime.db, sessionId, source);
        }
        const output = source ? await withRawMessageProvider2(sessionId, source.provider, execute) : await execute();
        const text = resultText(output);
        return { text, isError: /^Error\b/.test(text) };
      }
    });
  }
  tools.push(createCtxSkillTool({
    getProjectDir: () => currentSession().directory,
    unavailable: () => runtime && runtime.config.enabled !== true ? DISABLED_MESSAGE : null
  }));
  return tools;
}

// src/mcp-server.ts
console.log = console.error;
console.info = console.error;
console.debug = console.error;
var session = resolveMcpSession();
var runtime = null;
var claudePid = process.ppid;
var notBefore = Date.now() - 60000;
function currentSession() {
  const handoff = readCurrentSession(claudePid, notBefore);
  return handoff && handoff.directory === session.directory ? { sessionId: handoff.sessionId, directory: session.directory, source: "hook" } : session;
}
var server = new McpServer({
  name: "magic-context",
  title: "Magic Context",
  version: package_default.version,
  instructions: MCP_SERVER_INSTRUCTIONS,
  log: (message) => console.error(`[magic-context] ${message}`),
  getTools: () => {
    try {
      runtime = openRuntime(session.directory);
      return createClaudeCodeTools({ runtime, session, currentSession });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[magic-context] ${reason}`);
      return createClaudeCodeTools({
        runtime: null,
        session,
        currentSession,
        unavailableReason: reason
      });
    }
  }
});
await serveStdio(server);
runtime?.close();
flushLogger();
process.exit(0);
