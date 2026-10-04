import {
  getHarness,
  getMagicContextLogPath
} from "./chunk-6q6cxsv6.js";

// ../plugin/src/shared/logger.ts
import * as fs from "node:fs";
import * as path from "node:path";

// ../plugin/src/shared/redaction.ts
import { homedir, userInfo } from "node:os";
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var SECRET_WORDS = [
  "key",
  "token",
  "secret",
  "password",
  "auth",
  "authorization",
  "bearer",
  "credential"
];
var SECRET_SEGMENT_PATTERN = new RegExp(`^(?:${SECRET_WORDS.map((w) => `${w}s?`).join("|")})$`, "i");
var TRAILING_DESCRIPTORS = new Set(["id", "ids", "value", "values", "header", "headers"]);
function redactionTypeForKey(key) {
  const normalized = key.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
  const suffix = normalized.split(".").filter(Boolean).at(-1) ?? normalized;
  return suffix || "secret";
}
function isNonSecretScalarValue(value) {
  const v = value.trim();
  if (v === "true" || v === "false" || v === "null" || v === "undefined")
    return true;
  return /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v);
}
var SECRET_QUALIFIERS = new Set([
  "api",
  "access",
  "private",
  "client",
  "auth",
  "authorization",
  "secret",
  "bearer",
  "session",
  "refresh",
  "service",
  "x",
  "openai",
  "anthropic",
  "google",
  "github",
  "huggingface",
  "aws",
  "azure",
  "id"
]);
var UNQUALIFIED_SECRET_SEGMENT_PATTERN = /^(?:password|secret|credential|bearer|authorization)s?$/;
function isSecretKey(key) {
  const segments = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[._-]+/).filter(Boolean);
  if (segments.length === 0)
    return false;
  if (segments.length === 1) {
    const first = segments[0];
    return Boolean(first && SECRET_SEGMENT_PATTERN.test(first));
  }
  for (let i = 0;i < segments.length; i++) {
    const seg = segments[i];
    if (!seg || !SECRET_SEGMENT_PATTERN.test(seg))
      continue;
    let trailingOk = true;
    for (let j = i + 1;j < segments.length; j++) {
      const tail = segments[j];
      if (!tail)
        continue;
      if (TRAILING_DESCRIPTORS.has(tail))
        continue;
      if (SECRET_SEGMENT_PATTERN.test(tail))
        continue;
      trailingOk = false;
      break;
    }
    if (!trailingOk)
      continue;
    if (UNQUALIFIED_SECRET_SEGMENT_PATTERN.test(seg))
      return true;
    for (let k = i - 1;k >= 0; k--) {
      const lead = segments[k];
      if (lead && SECRET_QUALIFIERS.has(lead))
        return true;
    }
  }
  return false;
}
function sanitizePathString(value) {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const username = userInfo().username;
  let sanitized = value;
  if (home) {
    sanitized = sanitized.replace(new RegExp(escapeRegex(home), "g"), "~");
  }
  sanitized = sanitized.replace(/\/Users\/[^/]+\//g, "/Users/<USER>/");
  sanitized = sanitized.replace(/\/home\/[^/]+\//g, "/home/<USER>/");
  sanitized = sanitized.replace(/C:\\Users\\[^\\]+\\/g, "C:\\Users\\<USER>\\");
  if (username) {
    sanitized = sanitized.replace(new RegExp(escapeRegex(username), "g"), "<USER>");
  }
  return sanitized;
}
var SECRET_TEXT_PATTERNS = [
  {
    pattern: /\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{32,}/g,
    replacement: "<ANTHROPIC_API_KEY_REDACTED>"
  },
  {
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}/g,
    replacement: "<OPENAI_API_KEY_REDACTED>"
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replacement: "<GITHUB_PAT_REDACTED>"
  },
  {
    pattern: /\b(?:gh[opsu]|ghr)_[A-Za-z0-9]{30,}/g,
    replacement: "<GITHUB_TOKEN_REDACTED>"
  },
  {
    pattern: /\bhf_[A-Za-z0-9]{30,}/g,
    replacement: "<HUGGINGFACE_TOKEN_REDACTED>"
  },
  {
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "<AWS_ACCESS_KEY_ID_REDACTED>"
  },
  {
    pattern: /\bxox[abprsuvc]-[A-Za-z0-9-]{10,}/g,
    replacement: "<SLACK_TOKEN_REDACTED>"
  },
  {
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    replacement: "<GOOGLE_API_KEY_REDACTED>"
  },
  {
    pattern: /\b(Authorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    replacement: (_full, prefix) => `${prefix}<REDACTED:bearer>`
  },
  {
    pattern: /\b((?:Proxy-)?Authorization\s*:\s*(?:Basic|Digest|Token|Negotiate|NTLM)\s+)([A-Za-z0-9._~+/=-]{4,})/gi,
    replacement: (_full, prefix) => `${prefix}<REDACTED:authorization>`
  },
  {
    pattern: /\b((?:x-)?(?:api-?key|api-?token|auth-?token|access-?token)\s*:\s*)([^\s'"`,;<>]{6,})/gi,
    replacement: (full, prefix, value) => isNonSecretScalarValue(value) ? full : `${prefix}<REDACTED:api_key>`
  },
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi,
    replacement: (_full, prefix, _password, at) => `${prefix}<REDACTED:password>${at}`
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: "<JWT_REDACTED>"
  },
  {
    pattern: /(["'])([^"']*(?:key|token|secret|password|auth|bearer|credential)[^"']*)\1(\s*:\s*)(["'])([^"']*)\4/gi,
    replacement: (full, quote, key, separator, valueQuote, value) => isNonSecretScalarValue(value) ? full : `${quote}${key}${quote}${separator}${valueQuote}<REDACTED:${redactionTypeForKey(key)}>${valueQuote}`
  },
  {
    pattern: /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|auth|bearer|credential)[A-Za-z0-9_.-]*)\s*=\s*([^\s'"`]+)/gi,
    replacement: (full, key, value) => isNonSecretScalarValue(value) ? full : `${key}=<REDACTED:${redactionTypeForKey(key)}>`
  }
];
function redactSecretText(value) {
  let redacted = value;
  for (const { pattern, replacement } of SECRET_TEXT_PATTERNS) {
    if (typeof replacement === "string") {
      redacted = redacted.replace(pattern, replacement);
    } else {
      redacted = redacted.replace(pattern, replacement);
    }
  }
  return redacted;
}
function sanitizeDiagnosticText(value) {
  return redactSecretText(sanitizePathString(value));
}
function sanitizeConfigValue(value, keyPath = []) {
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return value;
  const key = keyPath.at(-1) ?? "";
  if (key && isSecretKey(key)) {
    return `<REDACTED:${redactionTypeForKey(key)}>`;
  }
  if (typeof value === "string")
    return sanitizeDiagnosticText(value);
  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeConfigValue(entry, [...keyPath, String(index)]));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      sanitizeConfigValue(entry, [...keyPath, entryKey])
    ]));
  }
  return value;
}

// ../plugin/src/shared/stale-plugin-build.ts
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
var STATE = Symbol.for("magic-context.stale-plugin-build");
function state() {
  const globals = globalThis;
  return globals[STATE] ??= {
    hosts: new Map,
    loggedChunks: new Set,
    notified: false
  };
}
function absolutePath(value) {
  let path = value;
  if (path.startsWith("file:")) {
    try {
      path = fileURLToPath(path);
    } catch {
      return;
    }
  }
  path = path.replaceAll("\\", "/").replace(/^\/(?=[A-Za-z]:\/)/, "");
  if (!path.startsWith("/") && !/^[A-Za-z]:\//.test(path))
    return;
  path = posix.normalize(path);
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}
function distForModule(moduleUrl) {
  const path = absolutePath(moduleUrl);
  if (!path)
    return;
  const dist = path.lastIndexOf("/dist/");
  return dist < 0 ? undefined : path.slice(0, dist + "/dist".length);
}
function stalePluginBuildGuidance(harness) {
  if (harness === "pi" || harness === "omp")
    return "Magic Context was rebuilt while this Pi was running; type /reload to load the new build";
  if (harness === "claude-code")
    return "Magic Context was rebuilt while this Claude Code session was running; restart Claude Code to load the new build";
  return "Magic Context was rebuilt while this OpenCode host was running; restart the host to load the new build";
}
function deliverNotice(host) {
  const current = state();
  if (current.notified || !current.pendingNotice || !host.notify)
    return;
  current.notified = true;
  try {
    Promise.resolve(host.notify(current.pendingNotice)).catch(() => {});
  } catch {}
}
function classifyStalePluginBuild(error) {
  if (error instanceof StalePluginBuildError)
    return error.build;
  const message = error instanceof Error ? error.message : String(error);
  const missing = message.match(/(?:Cannot find module|ENOENT reading)\s+(['"])(.*?)\1/);
  if (!missing)
    return null;
  let chunk = absolutePath(missing[2]);
  if (!chunk && /^\.\.?[/\\]/.test(missing[2])) {
    const importer = message.slice((missing.index ?? 0) + missing[0].length).match(/(?:imported from|from)\s+(?:['"]([^'"]+)['"]|([^\n]+))/);
    const from = importer && absolutePath((importer[1] ?? importer[2]).trim());
    if (from)
      chunk = absolutePath(posix.join(posix.dirname(from), missing[2].replaceAll("\\", "/")));
  }
  if (!chunk)
    return null;
  for (const host of state().hosts.values()) {
    if (chunk.startsWith(`${host.dist}/`)) {
      return { chunk, guidance: stalePluginBuildGuidance(host.harness) };
    }
  }
  const ownDist = distForModule(import.meta.url);
  return ownDist && chunk.startsWith(`${ownDist}/`) ? { chunk, guidance: stalePluginBuildGuidance(getHarness()) } : null;
}

class StalePluginBuildError extends Error {
  build;
  constructor(build) {
    super(build.guidance);
    this.build = build;
    this.name = "StalePluginBuildError";
  }
}
function stalePluginBuildDiagnostic(error) {
  const pending = state().pendingNotice;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (pending && message.includes(pending))
    return null;
  const build = classifyStalePluginBuild(error);
  if (!build)
    return;
  const current = state();
  current.pendingNotice ??= build.guidance;
  for (const host of current.hosts.values())
    deliverNotice(host);
  if (current.loggedChunks.has(build.chunk))
    return null;
  current.loggedChunks.add(build.chunk);
  return `[magic-context] stale plugin build: missing ${build.chunk.replace(/[\r\n]/g, " ")}; ${build.guidance}`;
}
async function importPluginModule(load) {
  try {
    return await load();
  } catch (error) {
    const build = classifyStalePluginBuild(error);
    if (!build)
      throw error;
    log("[magic-context] lazy import failed", error);
    throw new StalePluginBuildError(build);
  }
}

// ../plugin/src/shared/logger.ts
var isTestEnv = false;
var buffer = [];
var flushTimer = null;
var FLUSH_INTERVAL_MS = 500;
var BUFFER_SIZE_LIMIT = 50;
var MAX_BUFFERED_BYTES = 1024 * 1024;
var bufferedBytes = 0;
var droppedLines = 0;
function boundBuffer() {
  while (bufferedBytes > MAX_BUFFERED_BYTES && buffer.length > 0) {
    bufferedBytes -= Buffer.byteLength(buffer.shift() ?? "");
    droppedLines++;
  }
}
var MAX_LOG_FILE_BYTES = 32 * 1024 * 1024;
var SIZE_CHECK_INTERVAL_FLUSHES = 64;
var activeLogFile = null;
var activeLogSize = null;
var flushesSinceSizeCheck = 0;
var swallowedWriteCount = 0;
var lastErrorMessage = null;
var lastErrorTime = null;
function recordSwallowedWrite(error) {
  try {
    swallowedWriteCount++;
    lastErrorMessage = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error));
    lastErrorTime = new Date().toISOString();
  } catch {}
}
function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
function isMissingFile(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function getCurrentLogSize(logFile) {
  if (activeLogFile === logFile && activeLogSize !== null && flushesSinceSizeCheck < SIZE_CHECK_INTERVAL_FLUSHES) {
    return activeLogSize;
  }
  try {
    const stat = fs.statSync(logFile);
    if (!stat.isFile()) {
      throw new Error(`Magic Context log path is not a regular file: ${logFile}`);
    }
    fs.chmodSync(logFile, 384);
    activeLogFile = logFile;
    activeLogSize = stat.size;
    flushesSinceSizeCheck = 0;
    return stat.size;
  } catch (error) {
    if (!isMissingFile(error))
      throw error;
    activeLogFile = logFile;
    activeLogSize = 0;
    flushesSinceSizeCheck = 0;
    return 0;
  }
}
function capLogData(data) {
  if (Buffer.byteLength(data) <= MAX_LOG_FILE_BYTES)
    return data;
  let bounded = Buffer.from(data).subarray(0, MAX_LOG_FILE_BYTES).toString("utf8");
  while (Buffer.byteLength(bounded) > MAX_LOG_FILE_BYTES) {
    bounded = bounded.slice(0, -1);
  }
  return bounded;
}
function writeBoundedPredecessor(logFile, predecessorPath, size) {
  const predecessorFd = fs.openSync(predecessorPath, "w", 384);
  try {
    fs.fchmodSync(predecessorFd, 384);
    const bytesToCopy = Math.min(size, MAX_LOG_FILE_BYTES);
    const sourceFd = fs.openSync(logFile, "r");
    try {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, bytesToCopy));
      let remaining = bytesToCopy;
      let position = Math.max(0, size - bytesToCopy);
      while (remaining > 0) {
        const bytesRead = fs.readSync(sourceFd, chunk, 0, Math.min(chunk.length, remaining), position);
        if (bytesRead === 0)
          break;
        fs.writeSync(predecessorFd, chunk, 0, bytesRead);
        remaining -= bytesRead;
        position += bytesRead;
      }
    } finally {
      fs.closeSync(sourceFd);
    }
  } finally {
    fs.closeSync(predecessorFd);
  }
}
function rotateLogFile(logFile, size) {
  const predecessorPath = `${logFile}.1`;
  writeBoundedPredecessor(logFile, predecessorPath, size);
  fs.truncateSync(logFile, 0);
  activeLogSize = 0;
  flushesSinceSizeCheck = 0;
}
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0 && droppedLines === 0)
    return;
  const notice = droppedLines ? `[${new Date().toISOString()}] [magic-context][global] logger dropped ${droppedLines} ${droppedLines === 1 ? "line" : "lines"}: buffer exceeded ${MAX_BUFFERED_BYTES} bytes while writes were pending
` : "";
  try {
    const data = capLogData(notice + buffer.join(""));
    const logFile = getMagicContextLogPath();
    ensureDir(logFile);
    let currentSize = getCurrentLogSize(logFile);
    const dataSize = Buffer.byteLength(data);
    if (currentSize > 0 && currentSize + dataSize > MAX_LOG_FILE_BYTES) {
      rotateLogFile(logFile, currentSize);
      currentSize = 0;
    }
    fs.appendFileSync(logFile, data, { encoding: "utf8", mode: 384 });
    buffer = [];
    bufferedBytes = 0;
    droppedLines = 0;
    activeLogFile = logFile;
    activeLogSize = currentSize + dataSize;
    flushesSinceSizeCheck++;
  } catch (error) {
    activeLogFile = null;
    activeLogSize = null;
    flushesSinceSizeCheck = 0;
    recordSwallowedWrite(error);
    boundBuffer();
  }
}
function scheduleFlush() {
  if (flushTimer)
    return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
}
var lineForwarder = null;
function setLogLineForwarder(forward) {
  lineForwarder = forward;
}
function log(message, data) {
  try {
    let diagnostic = stalePluginBuildDiagnostic(data);
    if (diagnostic === undefined)
      diagnostic = stalePluginBuildDiagnostic(message);
    if (diagnostic === null)
      return;
    if (diagnostic !== undefined) {
      message = diagnostic;
      data = undefined;
    }
    if (isTestEnv)
      return;
    const timestamp = new Date().toISOString();
    const serialized = data === undefined ? "" : data instanceof Error ? ` ${sanitizeDiagnosticText(`${data.message}${data.stack ? `
${data.stack}` : ""}`)}` : ` ${JSON.stringify(sanitizeConfigValue(data))}`;
    const line = `[${timestamp}] ${sanitizeDiagnosticText(message)}${serialized}
`;
    if (lineForwarder) {
      lineForwarder(line);
      return;
    }
    buffer.push(line);
    bufferedBytes += Buffer.byteLength(line);
    boundBuffer();
    if (buffer.length >= BUFFER_SIZE_LIMIT) {
      flush();
    } else {
      scheduleFlush();
    }
  } catch {}
}
function sessionLog(sessionId, message, data) {
  log(`[magic-context][${sessionId}] ${message}`, data);
}
function flushLogger() {
  flush();
}
if (!isTestEnv) {
  process.on("exit", flush);
}

// ../plugin/src/shared/sqlite.ts
import { AsyncLocalStorage } from "node:async_hooks";
var reportSlowPrivilegedWrite;
function registerSlowWriteReporter(reporter) {
  reportSlowPrivilegedWrite = reporter;
}
var sqliteDiagnosticSink;
function registerSqliteDiagnosticSink(sink) {
  sqliteDiagnosticSink = sink;
}
function reportSqliteDiagnostic(message) {
  try {
    sqliteDiagnosticSink?.(`[magic-context] ${message}`);
  } catch {}
}
function detectSqliteRuntime() {
  const hasBunVersion = typeof process !== "undefined" && typeof process.versions?.bun === "string";
  const hasBunGlobal = typeof globalThis !== "undefined" && typeof globalThis.Bun !== "undefined";
  return hasBunVersion || hasBunGlobal ? "Bun" : "Node.js";
}
var bunSpec = "bun:" + "sqlite";
var nodeSpec = "node:" + "sqlite";
async function importSqliteModule(specifier) {
  return await import(specifier);
}
function isModuleNotFoundError(error, specifier) {
  const candidate = error;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  const details = `${code} ${name} ${message}`.toLowerCase();
  const mentionsSpecifier = details.includes(specifier.toLowerCase());
  if (!mentionsSpecifier)
    return false;
  return code === "ERR_MODULE_NOT_FOUND" || code === "ERR_UNKNOWN_BUILTIN_MODULE" || code === "MODULE_NOT_FOUND" || name === "ResolveMessage" || details.includes("module not found") || details.includes("cannot find module") || details.includes("cannot find package") || details.includes("no such built-in module");
}

class SqliteRuntimeUnavailableError extends Error {
  runtime;
  specifier;
  constructor(runtime, specifier, cause) {
    const requirement = specifier === nodeSpec ? "Requires Node.js >= 24, or Bun with bun:sqlite — this Bun build lacks node:sqlite." : "Requires Bun with bun:sqlite, or Node.js >= 24 — this Bun build lacks bun:sqlite.";
    super(`Magic Context detected ${runtime}, but could not load ${specifier}. ${requirement}`, { cause });
    this.name = "SqliteRuntimeUnavailableError";
    this.runtime = runtime;
    this.specifier = specifier;
  }
}
async function loadSqliteModule(runtime = detectSqliteRuntime(), importer = importSqliteModule) {
  const specifier = runtime === "Bun" ? bunSpec : nodeSpec;
  try {
    return await importer(specifier);
  } catch (error) {
    if (isModuleNotFoundError(error, specifier)) {
      throw new SqliteRuntimeUnavailableError(runtime, specifier, error);
    }
    throw error;
  }
}
var detectedRuntime = detectSqliteRuntime();
var isBun = detectedRuntime === "Bun";
var sqliteModule = await loadSqliteModule(detectedRuntime);
var DatabaseImpl = isBun ? sqliteModule.Database : buildNodeSqliteDatabaseClass(sqliteModule.DatabaseSync);
var trackedSqliteConnections = new Map;
var nextSqliteConnectionSequence = 1;
function installTransactionRouting(db, readonly) {
  const nativeExec = db.exec.bind(db);
  Object.defineProperty(db, "exec", {
    configurable: true,
    writable: true,
    value: (sql) => {
      if (/^\s*BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)(?:\s+TRANSACTION)?\s*;?\s*$/i.test(sql)) {
        openWriterTransactions.delete(db);
        if (transformPassScope.getStore()?.active || backgroundWriterScope.getStore())
          acquireShort(db, () => nativeExec(sql), sql.trim());
        else
          nativeExec(sql);
        return db;
      }
      if (WRITER_TRANSACTION_END.test(sql) && openWriterTransactions.has(db))
        return endWriterTransaction(db, () => nativeExec(sql), sql);
      if (!/^\s*(?:SELECT|EXPLAIN|PRAGMA|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql))
        return withAutocommitTimeout(db, () => nativeExec(sql));
      return nativeExec(sql);
    }
  });
  const nativePrepare = db.prepare.bind(db);
  Object.defineProperty(db, "prepare", {
    configurable: true,
    writable: true,
    value: (sql) => {
      const statement = nativePrepare(sql);
      if (!readonly && !/^\s*(?:SELECT|EXPLAIN|PRAGMA)\b/i.test(sql)) {
        for (const method of ["run", "get", "all"]) {
          const execute = statement[method].bind(statement);
          Object.defineProperty(statement, method, {
            configurable: true,
            value: (...args) => withAutocommitTimeout(db, () => execute(...args))
          });
        }
      }
      return statement;
    }
  });
  Object.defineProperty(db, "transaction", {
    configurable: true,
    writable: true,
    value: (fn) => {
      const make = (mode) => function(...args) {
        const nested = isInTransaction(db);
        const savepoint = "mc_tx_sp";
        db.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`);
        try {
          const result = fn.apply(this, args);
          db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
          return result;
        } catch (error) {
          if (isInTransaction(db)) {
            if (nested) {
              db.exec(`ROLLBACK TO ${savepoint}`);
              db.exec(`RELEASE ${savepoint}`);
            } else
              db.exec("ROLLBACK");
          }
          throw error;
        }
      };
      const defaultTransaction = make(readonly ? "DEFERRED" : "IMMEDIATE");
      const variants = {
        default: defaultTransaction,
        deferred: make("DEFERRED"),
        immediate: make("IMMEDIATE"),
        exclusive: make("EXCLUSIVE"),
        database: db
      };
      for (const transaction of [
        variants.default,
        variants.deferred,
        variants.immediate,
        variants.exclusive
      ]) {
        Object.assign(transaction, variants);
      }
      return defaultTransaction;
    }
  });
}
function trackSqliteConnection(db, filename, options) {
  const originalClose = db.close.bind(db);
  const sequence = nextSqliteConnectionSequence++;
  const metadata = {
    sequence,
    filename: typeof filename === "string" ? filename : Buffer.isBuffer(filename) ? "<buffer>" : ":memory:",
    readonly: Boolean(options) && typeof options === "object" && (options.readonly === true || options.readOnly === true)
  };
  installTransactionRouting(db, metadata.readonly);
  Object.defineProperty(db, "close", {
    configurable: true,
    value: (...args) => {
      try {
        return originalClose(...args);
      } finally {
        trackedSqliteConnections.delete(sequence);
      }
    }
  });
  trackedSqliteConnections.set(sequence, {
    ...metadata,
    reference: new WeakRef(db)
  });
  return db;
}
var TrackedDatabase = new Proxy(DatabaseImpl, {
  construct(target, args) {
    const db = Reflect.construct(target, args, target);
    return trackSqliteConnection(db, args[0], args[1]);
  }
});
function buildNodeSqliteDatabaseClass(DatabaseSync) {

  class NodeSqliteDatabase extends DatabaseSync {
    constructor(filename, options) {
      const translated = { ...options };
      if (options && "readonly" in options) {
        translated.readOnly = options.readonly;
        delete translated.readonly;
      }
      super(typeof filename === "string" ? filename : ":memory:", translated);
    }
    prepare(sql) {
      const stmt = super.prepare(sql);
      for (const method of ["run", "get", "all"]) {
        const original = stmt[method].bind(stmt);
        stmt[method] = (...args) => args.length === 1 && Array.isArray(args[0]) ? original(...args[0]) : original(...args);
      }
      return stmt;
    }
  }
  return NodeSqliteDatabase;
}
var Database = TrackedDatabase;
function pragmaValue(db, name) {
  const row = db.prepare(`PRAGMA ${name}`).get();
  if (!row)
    return;
  return row[name] ?? Object.values(row)[0];
}
function pragmaNumber(db, name) {
  try {
    const value = pragmaValue(db, name);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
var privilegeDepth = new WeakMap;
var transformPassScope = new AsyncLocalStorage;
var admissionScope = new AsyncLocalStorage;
var backgroundWriterScope = new AsyncLocalStorage;
function withSqliteBackgroundWriter(operation) {
  return backgroundWriterScope.run(true, operation);
}
function withoutSqliteTransformPass(operation) {
  return transformPassScope.run(undefined, operation);
}
function isTransientSqliteError(error) {
  if (!error || typeof error !== "object")
    return false;
  const value = error;
  return typeof value.code === "string" && /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(value.code) || typeof value.errcode === "number" && [5, 6].includes(value.errcode & 255);
}

class SqliteAcquisitionBusyError extends Error {
  code = "SQLITE_BUSY";
  stage;
  constructor(cause, stage = "BEGIN IMMEDIATE") {
    super("SQLite writer acquisition remained busy", { cause });
    this.name = "SqliteAcquisitionBusyError";
    this.stage = stage;
  }
}
var SHORT_BUSY_TIMEOUT_MS = 25;
var SLOW_WRITER_LOG_MS = 250;
var WRITER_TRANSACTION_END = /^\s*(?:COMMIT|END|ROLLBACK)(?:\s+TRANSACTION)?\s*;?\s*$/i;
var writerAcquisitionScope = new AsyncLocalStorage;
var openWriterTransactions = new WeakMap;
function foregroundWaitLease() {
  const lease = transformPassScope.getStore();
  return lease?.active && !admissionScope.getStore() && !backgroundWriterScope.getStore() ? lease : undefined;
}
function withAutocommitTimeout(db, operation) {
  const lease = foregroundWaitLease();
  if (isInTransaction(db) || !lease && !backgroundWriterScope.getStore())
    return operation();
  const previous = pragmaNumber(db, "busy_timeout");
  db.exec(`PRAGMA busy_timeout=${lease ? Math.floor(lease.remainingWaitMs) : SHORT_BUSY_TIMEOUT_MS}`);
  const started = performance.now();
  try {
    return operation();
  } catch (error) {
    if (lease && isTransientSqliteError(error))
      throw new SqliteAcquisitionBusyError(error, "autocommit");
    throw error;
  } finally {
    if (lease)
      lease.remainingWaitMs = Math.max(0, lease.remainingWaitMs - (performance.now() - started));
    if (previous !== null)
      db.exec(`PRAGMA busy_timeout=${previous}`);
  }
}
function acquireShort(db, acquire, site) {
  const started = performance.now();
  const previous = pragmaNumber(db, "busy_timeout");
  const outer = writerAcquisitionScope.getStore();
  const owner = outer && !outer.claimed ? outer : undefined;
  if (owner)
    owner.claimed = true;
  const writerSite = owner?.site ?? site;
  const lane = owner?.lane ?? (transformPassScope.getStore()?.active ? "foreground" : "background");
  let acquiredAt;
  try {
    const lease = foregroundWaitLease();
    const timeout = lease ? Math.floor(lease.remainingWaitMs) : SHORT_BUSY_TIMEOUT_MS;
    db.exec(`PRAGMA busy_timeout=${timeout}`);
    acquire();
    acquiredAt = performance.now();
  } catch (error) {
    if (transformPassScope.getStore()?.active && isTransientSqliteError(error))
      throw new SqliteAcquisitionBusyError(error, site);
    throw error;
  } finally {
    const attemptMs = (acquiredAt ?? performance.now()) - started;
    const lease = foregroundWaitLease();
    if (lease)
      lease.remainingWaitMs = Math.max(0, lease.remainingWaitMs - attemptMs);
    if (previous !== null)
      db.exec(`PRAGMA busy_timeout=${previous}`);
    if (acquiredAt !== undefined) {
      openWriterTransactions.set(db, {
        site: writerSite,
        lane,
        acquireMs: acquiredAt - (owner?.startedAt ?? started),
        attempts: owner?.attempts ?? 1,
        acquiredAt
      });
    } else if (attemptMs >= SLOW_WRITER_LOG_MS) {
      reportSqliteDiagnostic(`sqlite writer site=${writerSite} lane=${lane} acquire_ms=${Math.round(attemptMs)} attempts=${owner?.attempts ?? 1} outcome=busy`);
    }
  }
}
function endWriterTransaction(db, end, sql) {
  let ended = false;
  try {
    const result = end();
    ended = true;
    return result;
  } finally {
    const open = openWriterTransactions.get(db);
    if (open && !isInTransaction(db)) {
      openWriterTransactions.delete(db);
      const holdMs = performance.now() - open.acquiredAt;
      if (open.acquireMs >= SLOW_WRITER_LOG_MS || holdMs >= SLOW_WRITER_LOG_MS) {
        const outcome = /^\s*ROLLBACK/i.test(sql) ? "rolled_back" : ended ? "committed" : "failed";
        reportSqliteDiagnostic(`sqlite writer site=${open.site} lane=${open.lane} acquire_ms=${Math.round(open.acquireMs)} hold_ms=${Math.round(holdMs)} attempts=${open.attempts} outcome=${outcome}`);
      }
    }
  }
}
function isInTransaction(db) {
  const candidate = db;
  return candidate.inTransaction === true || candidate.isTransaction === true;
}
function withPrivilegedWriter(db, operation) {
  const previousDepth = privilegeDepth.get(db) ?? 0;
  const nested = isInTransaction(db);
  const savepoint = "mc_privilege_scope";
  let transactionStartedAt;
  if (nested) {
    db.exec(`SAVEPOINT ${savepoint}`);
  } else {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (transformPassScope.getStore()?.active && isTransientSqliteError(error))
        throw new SqliteAcquisitionBusyError(error);
      throw error;
    }
    transactionStartedAt = performance.now();
  }
  privilegeDepth.set(db, previousDepth + 1);
  try {
    db.prepare("INSERT INTO context_privilege_state(id, enabled) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET enabled = 1").run();
    const result = operation();
    if (previousDepth === 0) {
      db.prepare("UPDATE context_privilege_state SET enabled = 0 WHERE id = 1").run();
    }
    if (nested) {
      db.exec(`RELEASE ${savepoint}`);
    } else {
      db.exec("COMMIT");
      if (transactionStartedAt !== undefined) {
        reportSlowPrivilegedWrite?.("privileged_writer", transactionStartedAt);
      }
    }
    if (previousDepth > 0)
      privilegeDepth.set(db, previousDepth);
    else
      privilegeDepth.delete(db);
    return result;
  } catch (error) {
    try {
      if (nested) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } else {
        db.exec("ROLLBACK");
      }
    } finally {
      if (previousDepth > 0)
        privilegeDepth.set(db, previousDepth);
      else
        privilegeDepth.delete(db);
    }
    throw error;
  }
}

export { sanitizeDiagnosticText, importPluginModule, setLogLineForwarder, log, sessionLog, flushLogger, registerSlowWriteReporter, registerSqliteDiagnosticSink, detectSqliteRuntime, Database, withSqliteBackgroundWriter, withoutSqliteTransformPass, isTransientSqliteError, withPrivilegedWriter };
