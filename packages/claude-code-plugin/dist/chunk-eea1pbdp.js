import {
  harnessOwnsOpenCodeStore,
  getMagicContextStorageDir,
  getLegacyOpenCodeMagicContextStorageDir
} from "./chunk-6q6cxsv6.js";
import {
  importPluginModule,
  log,
  registerSlowWriteReporter,
  registerSqliteDiagnosticSink,
  detectSqliteRuntime,
  Database,
  withSqliteBackgroundWriter,
  withoutSqliteTransformPass,
  isTransientSqliteError,
  withPrivilegedWriter
} from "./chunk-e4mkgkj9.js";
import {
  resolveOpenCodeDbPath,
  hasV1MessageTables,
  openCodeDbPathExists,
  getOpenCodeDbProbeDescriptions,
  closeQuietly,
  setDatabase,
  loadToolDefinitionMeasurements
} from "./chunk-q5f7wcc8.js";
import {
  logSlowWriteTransaction
} from "./chunk-t7etejbh.js";

// ../plugin/src/features/magic-context/migrations.ts
import { isMainThread } from "node:worker_threads";

// ../plugin/src/features/magic-context/memory/constants.ts
var V2_MEMORY_CATEGORIES = [
  "PROJECT_RULES",
  "ARCHITECTURE",
  "CONSTRAINTS",
  "CONFIG_VALUES",
  "NAMING"
];
var PROMOTABLE_CATEGORIES = [
  ...V2_MEMORY_CATEGORIES,
  "ARCHITECTURE_DECISIONS",
  "CONFIG_DEFAULTS",
  "USER_PREFERENCES",
  "USER_DIRECTIVES",
  "ENVIRONMENT",
  "WORKFLOW_RULES",
  "KNOWN_ISSUES"
];
var CATEGORY_PRIORITY = [
  ...V2_MEMORY_CATEGORIES,
  "USER_DIRECTIVES",
  "USER_PREFERENCES",
  "CONFIG_DEFAULTS",
  "ARCHITECTURE_DECISIONS",
  "ENVIRONMENT",
  "WORKFLOW_RULES",
  "KNOWN_ISSUES"
];
var MEMORY_CATEGORY_ORDER_UNKNOWN = 99;
var MEMORY_CATEGORY_ORDER_PRIORITY = CATEGORY_PRIORITY.reduce((acc, category, index) => {
  acc[category] = index;
  return acc;
}, {});
var MEMORY_CATEGORY_ORDER_SQL = `CASE category ${CATEGORY_PRIORITY.map((category, index) => `WHEN '${category}' THEN ${index}`).join(" ")} ELSE ${MEMORY_CATEGORY_ORDER_UNKNOWN} END`;
var CATEGORY_DEFAULT_TTL = {
  WORKFLOW_RULES: 90 * 24 * 60 * 60 * 1000,
  KNOWN_ISSUES: 30 * 24 * 60 * 60 * 1000
};

// ../plugin/src/shared/xml-unescape.ts
var XML_ENTITY_REGEX = /&(amp|apos|quot|lt|gt);/g;
var XML_ENTITIES = {
  amp: "&",
  apos: "'",
  quot: '"',
  lt: "<",
  gt: ">"
};
function unescapeXml(s) {
  return s.replace(XML_ENTITY_REGEX, (entity, name) => XML_ENTITIES[name] ?? entity);
}

// ../plugin/src/hooks/magic-context/compartment-parser.ts
var TIER_OPEN_REGEX = /<p(\d)\s*(\/?)>/g;
var TIER_CLOSE_REGEX = /<\/p(\d)\s*>/g;
var TIER_CLOSE_FOLLOWER_REGEX = /^\s*(?:$|<\/?p\d\s*\/?>)/;
var TIER_CLOSE_ANY_REGEX = /<\/p\d/;
var TIER_OPEN_ANY_REGEX = /<p\d/;
var HISTORIAN_CATEGORIES = new Set(V2_MEMORY_CATEGORIES);
function searchFrom(s, regex, from) {
  const at = s.slice(from).search(regex);
  return at === -1 ? -1 : from + at;
}
function hasTierOpenerFrom(inner, digit, from) {
  return new RegExp(`<p${digit}\\s*/?>`).test(inner.slice(from));
}
function findMatchingTierClose(inner, bodyStart, digit, found) {
  const closeRegex = new RegExp(TIER_CLOSE_REGEX.source, "g");
  closeRegex.lastIndex = bodyStart;
  for (let close = closeRegex.exec(inner);close; close = closeRegex.exec(inner)) {
    const end = close.index + close[0].length;
    if (Number(close[1]) !== digit)
      continue;
    if (!TIER_CLOSE_FOLLOWER_REGEX.test(inner.slice(end)))
      continue;
    const body = inner.slice(bodyStart, close.index);
    for (const open of body.matchAll(new RegExp(TIER_OPEN_REGEX.source, "g"))) {
      const other = Number(open[1]);
      const otherwiseMissing = other >= 1 && other <= 4 && other !== digit && !found.has(other) && !hasTierOpenerFrom(inner, other, end);
      if (otherwiseMissing)
        return;
    }
    return { start: close.index, end };
  }
  return;
}
function extractTiers(inner) {
  const tiers = new Map;
  const openRegex = new RegExp(TIER_OPEN_REGEX.source, "g");
  let pos = 0;
  for (;; ) {
    openRegex.lastIndex = pos;
    const open = openRegex.exec(inner);
    if (!open)
      break;
    const digit = Number(open[1]);
    const bodyStart = open.index + open[0].length;
    let bodyEnd = bodyStart;
    pos = bodyStart;
    if (open[2] !== "/") {
      const close = findMatchingTierClose(inner, bodyStart, digit, tiers);
      if (close) {
        bodyEnd = close.start;
        pos = close.end;
      } else {
        const closeAt = searchFrom(inner, TIER_CLOSE_ANY_REGEX, bodyStart);
        bodyEnd = closeAt === -1 ? inner.length : closeAt;
        pos = closeAt === -1 ? inner.length : closeAt + 1;
        const openInside = searchFrom(inner.slice(0, bodyEnd), TIER_OPEN_ANY_REGEX, bodyStart);
        if (openInside !== -1) {
          bodyEnd = openInside;
          pos = openInside;
        }
      }
    }
    if (!tiers.has(digit)) {
      tiers.set(digit, unescapeXml(inner.slice(bodyStart, bodyEnd).trim()));
    }
  }
  return tiers;
}
function extractTiersFromInner(inner) {
  const tiers = extractTiers(inner);
  return { p1: tiers.get(1), p2: tiers.get(2), p3: tiers.get(3), p4: tiers.get(4) };
}

// ../plugin/src/features/magic-context/lkg-prefix-chunks.ts
import { createHash } from "node:crypto";
var LKG_PREFIX_CHUNK_CHARS = 64 * 1024;
function splitLkgPrefix(jsonPrefix) {
  const chunks = [];
  let start = 0;
  while (start < jsonPrefix.length) {
    let end = Math.min(start + LKG_PREFIX_CHUNK_CHARS, jsonPrefix.length);
    if (end < jsonPrefix.length) {
      const last = jsonPrefix.charCodeAt(end - 1);
      if (last >= 55296 && last <= 56319)
        end -= 1;
    }
    chunks.push(jsonPrefix.slice(start, end));
    start = end;
  }
  return chunks;
}
function hashLkgChunk(body) {
  return createHash("sha256").update(body).digest("hex");
}
function hashLkgChunkList(chunkHashes) {
  return createHash("sha256").update(chunkHashes.join(`
`)).digest("hex");
}
function layoutLkgPrefix(jsonPrefix) {
  const chunks = splitLkgPrefix(jsonPrefix);
  const chunkHashes = chunks.map(hashLkgChunk);
  return { chunks, chunkHashes, chars: jsonPrefix.length, hash: hashLkgChunkList(chunkHashes) };
}

// ../plugin/src/features/magic-context/migration-v94-write-split.ts
var LKG_SLOT_CHUNKS_DDL = `
    CREATE TABLE IF NOT EXISTS lkg_slot_chunks (
        session_id TEXT NOT NULL,
        chunk INTEGER NOT NULL,
        hash TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (session_id, chunk)
    );
`;
var SESSION_REPLAY_DECISIONS_DDL = `
    CREATE TABLE IF NOT EXISTS session_replay_decisions (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id)
    ) WITHOUT ROWID;
`;
function lkgSlotsDdl(table) {
  return `
        CREATE TABLE IF NOT EXISTS ${table} (
            session_id TEXT PRIMARY KEY,
            json_prefix_chars INTEGER NOT NULL,
            json_prefix_chunks INTEGER NOT NULL,
            json_prefix_hash TEXT NOT NULL,
            input_id_seq TEXT NOT NULL,
            input_content_digests TEXT NOT NULL,
            input_content_signatures TEXT,
            last_input_message_id TEXT NOT NULL,
            model_key TEXT,
            provider_key TEXT,
            captured_at INTEGER NOT NULL,
            row_version INTEGER,
            capture_sequence INTEGER
        );
    `;
}
var LKG_SLOTS_DDL = lkgSlotsDdl("lkg_slots");
var LKG_MOVE_WINDOW_MS = 24 * 60 * 60 * 1000;
function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}
function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}
function splitLkgSlotPrefixes(db, now = Date.now()) {
  db.exec(LKG_SLOT_CHUNKS_DDL);
  if (!tableExists(db, "lkg_slots")) {
    db.exec(LKG_SLOTS_DDL);
    return;
  }
  if (!columnExists(db, "lkg_slots", "json_prefix"))
    return;
  db.prepare("DELETE FROM lkg_slots WHERE NOT (captured_at >= ?)").run(now - LKG_MOVE_WINDOW_MS);
  db.exec("DROP TABLE IF EXISTS lkg_slots_v94");
  db.exec(lkgSlotsDdl("lkg_slots_v94"));
  const sessionIds = db.prepare("SELECT session_id FROM lkg_slots").all().map((row) => row.session_id);
  const readPrefix = db.prepare("SELECT json_prefix FROM lkg_slots WHERE session_id IS ?");
  const insertSlot = db.prepare(`INSERT OR IGNORE INTO lkg_slots_v94 (
            session_id, json_prefix_chars, json_prefix_chunks, json_prefix_hash,
            input_id_seq, input_content_digests, input_content_signatures,
            last_input_message_id, model_key, provider_key,
            captured_at, row_version, capture_sequence
        )
        SELECT session_id, ?, ?, ?,
            input_id_seq, input_content_digests, input_content_signatures,
            last_input_message_id, model_key, provider_key,
            captured_at, row_version, capture_sequence
        FROM lkg_slots WHERE session_id IS ?`);
  const insertChunk = db.prepare("INSERT INTO lkg_slot_chunks (session_id, chunk, hash, body) VALUES (?, ?, ?, ?)");
  db.prepare("DELETE FROM lkg_slot_chunks").run();
  for (const sessionId of sessionIds) {
    if (typeof sessionId !== "string")
      continue;
    const row = readPrefix.get(sessionId);
    if (typeof row?.json_prefix !== "string")
      continue;
    const layout = layoutLkgPrefix(row.json_prefix);
    const inserted = insertSlot.run(layout.chars, layout.chunks.length, layout.hash, sessionId);
    if (Number(inserted.changes) !== 1)
      continue;
    for (let index = 0;index < layout.chunks.length; index += 1) {
      insertChunk.run(sessionId, index, layout.chunkHashes[index], layout.chunks[index]);
    }
  }
  db.exec("DROP TABLE lkg_slots");
  db.exec("ALTER TABLE lkg_slots_v94 RENAME TO lkg_slots");
}
function validDecisionSql(type, value) {
  return `(${type} = 'text' AND (
        ${value} IN ('keep', 'strip') OR (
            ${value} GLOB 'keep:[1-9]*'
            AND substr(${value}, 6) NOT GLOB '*[^0-9]*'
            AND length(${value}) <= 10
            AND CAST(substr(${value}, 6) AS INTEGER) BETWEEN 2 AND 10000
        )
    ))`;
}
function splitReplayDecisions(db) {
  db.exec(SESSION_REPLAY_DECISIONS_DDL);
  if (!tableExists(db, "session_meta"))
    return;
  if (!columnExists(db, "session_meta", "trailing_blank_decisions"))
    return;
  const doc = "sm.trailing_blank_decisions";
  const hasVersionKey = `json_type(${doc}, '$.version') IS NOT NULL`;
  const versionIsDecision = validDecisionSql(`json_type(${doc}, '$.version')`, `json_extract(${doc}, '$.version')`);
  const isV2 = `(${hasVersionKey} AND NOT ${versionIsDecision})`;
  const v2Valid = `(
        json_type(${doc}, '$.version') IN ('integer', 'real')
        AND json_extract(${doc}, '$.version') = 2
        AND json_type(${doc}, '$.trailingBlank') = 'object'
        AND NOT EXISTS (
            SELECT 1 FROM json_each(${doc}, '$.trailingBlank') AS entry
            WHERE entry.key = '' OR NOT ${validDecisionSql("entry.type", "entry.value")}
        )
    )`;
  const v1Valid = `NOT EXISTS (
        SELECT 1 FROM json_each(${doc}) AS entry
        WHERE entry.key = '' OR NOT ${validDecisionSql("entry.type", "entry.value")}
    )`;
  db.exec("DROP TABLE IF EXISTS temp.v94_replay_documents");
  db.exec(`
        CREATE TEMP TABLE v94_replay_documents AS
        SELECT session_id, version FROM (
            SELECT sm.session_id AS session_id, CASE WHEN ${isV2} THEN 2 ELSE 1 END AS version,
                CASE WHEN ${isV2} THEN ${v2Valid} ELSE ${v1Valid} END AS strictly_valid
            FROM session_meta AS sm
            WHERE typeof(${doc}) = 'text' AND ${doc} <> ''
                AND json_valid(${doc}) AND json_type(${doc}) = 'object'
        ) WHERE strictly_valid;
    `);
  db.exec(`
        INSERT INTO session_replay_decisions (session_id, message_id, decision)
        SELECT sm.session_id, entry.key, entry.value
        FROM v94_replay_documents AS moved
        JOIN session_meta AS sm ON sm.session_id = moved.session_id
        JOIN json_each(
            ${doc}, CASE moved.version WHEN 2 THEN '$.trailingBlank' ELSE '$' END
        ) AS entry
        WHERE true
        ON CONFLICT(session_id, message_id) DO UPDATE SET decision = excluded.decision;
    `);
  db.exec(`
        UPDATE session_meta SET trailing_blank_decisions = (
            SELECT CASE moved.version
                WHEN 2 THEN json_set(session_meta.trailing_blank_decisions, '$.trailingBlank', json('{}'))
                ELSE ''
            END
            FROM v94_replay_documents AS moved WHERE moved.session_id = session_meta.session_id
        )
        WHERE session_id IN (SELECT session_id FROM v94_replay_documents);
    `);
  db.exec("DROP TABLE temp.v94_replay_documents");
}

// ../plugin/src/features/magic-context/opencode2-relabel.ts
var OPENCODE2_RELABEL_STATE_KEY = "v87_opencode2_relabel";
var V87_HARNESS_TWIN_RULES = [
  {
    table: "session_projects",
    keyColumns: ["session_id"],
    incomingIsNewer: "incoming.updated_at > existing.updated_at"
  },
  {
    table: "primer_candidates",
    keyColumns: [
      "project_path",
      "session_id",
      "source_start_message_id",
      "source_end_message_id"
    ],
    incomingIsNewer: "incoming.created_at > existing.created_at"
  },
  {
    table: "transform_decisions",
    keyColumns: ["session_id", "message_id"],
    incomingIsNewer: "incoming.ts_ms > existing.ts_ms"
  }
];
function tableExists2(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}
function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}
function listSessionScopedHarnessTables(db, tables) {
  const shapes = [];
  for (const table of tables) {
    if (!tableExists2(db, table))
      continue;
    const columns = columnNames(db, table);
    if (!columns.has("harness"))
      continue;
    shapes.push({ table, hasSessionId: columns.has("session_id") });
  }
  return shapes;
}
function collectCandidateSessions(db, shapes) {
  const sessions = new Set;
  for (const shape of shapes) {
    if (!shape.hasSessionId)
      continue;
    const rows = db.prepare(`SELECT DISTINCT session_id AS id FROM ${shape.table}
                  WHERE session_id IS NOT NULL AND harness IN ('opencode', 'opencode2')`).all();
    for (const row of rows)
      sessions.add(row.id);
  }
  return [...sessions].sort();
}
function openEvidenceStore(path) {
  const store = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const hasV1Messages = tableExists2(store, "message");
    const hasV1Session = tableExists2(store, "session");
    const hasV2 = tableExists2(store, "session_v2");
    const hasV2Messages = hasV2 && tableExists2(store, "session_message");
    if (!hasV1Messages && !hasV1Session && !hasV2) {
      store.close();
      return null;
    }
    const v1Message = hasV1Messages ? store.prepare("SELECT MAX(time_updated) AS newest FROM message WHERE session_id = ?") : null;
    const v1Session = hasV1Session ? store.prepare("SELECT time_updated AS newest FROM session WHERE id = ?") : null;
    const v2Message = hasV2Messages ? store.prepare("SELECT MAX(time_updated) AS newest FROM session_message WHERE session_id = ?") : null;
    const v2Session = hasV2 ? store.prepare("SELECT time_updated AS newest FROM session_v2 WHERE id = ?") : null;
    const newest = (statements, sessionId) => {
      let best = null;
      for (const statement of statements) {
        if (!statement)
          continue;
        const row = statement.get(sessionId);
        const value = row?.newest;
        if (typeof value !== "number")
          continue;
        if (best === null || value > best)
          best = value;
      }
      return best;
    };
    return {
      newestV1Activity: (sessionId) => newest([v1Message, v1Session], sessionId),
      newestV2Activity: (sessionId) => newest([v2Message, v2Session], sessionId),
      close: () => store.close()
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
function resolveHarnessFromEvidence(evidence, sessionId) {
  const v1 = evidence.newestV1Activity(sessionId);
  const v2 = evidence.newestV2Activity(sessionId);
  if (v1 === null && v2 === null)
    return null;
  if (v2 !== null && (v1 === null || v2 > v1))
    return "opencode2";
  if (v1 !== null && (v2 === null || v1 > v2))
    return "opencode";
  return null;
}
function prepareTwinResolver(db, table, keyColumns, incomingIsNewer) {
  const joinOn = keyColumns.map((column) => `incoming.${column} = existing.${column}`).join(" AND ");
  const dropIncoming = db.prepare(`DELETE FROM ${table} WHERE rowid IN (
             SELECT incoming.rowid FROM ${table} AS incoming
             JOIN ${table} AS existing ON ${joinOn} AND existing.harness = ?
             WHERE incoming.session_id = ? AND incoming.harness = ?
               AND NOT (${incomingIsNewer})
         )`);
  const dropExisting = db.prepare(`DELETE FROM ${table} WHERE rowid IN (
             SELECT existing.rowid FROM ${table} AS existing
             JOIN ${table} AS incoming ON ${joinOn} AND incoming.harness = ?
             WHERE existing.session_id = ? AND existing.harness = ?
               AND (${incomingIsNewer})
         )`);
  return {
    run(sessionId, target, source) {
      dropIncoming.run(target, sessionId, source);
      dropExisting.run(source, sessionId, target);
    }
  };
}
function writeUnresolvedState(db, reason, resolution, sessionIds) {
  if (!tableExists2(db, "schema_migrations_meta"))
    return;
  const value = {
    reason,
    lookedFor: getOpenCodeDbProbeDescriptions(resolution).join(", "),
    sessionIds: [...sessionIds],
    recordedAt: Date.now()
  };
  db.prepare(`INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(OPENCODE2_RELABEL_STATE_KEY, JSON.stringify(value));
}
function clearUnresolvedState(db) {
  if (!tableExists2(db, "schema_migrations_meta"))
    return;
  db.prepare("DELETE FROM schema_migrations_meta WHERE key = ?").run(OPENCODE2_RELABEL_STATE_KEY);
}
function repairOpenCode2HarnessLabels(db, options) {
  const shapes = listSessionScopedHarnessTables(db, options.tables);
  const candidateSessionIds = collectCandidateSessions(db, shapes);
  if (candidateSessionIds.length === 0) {
    clearUnresolvedState(db);
    return {
      status: "no_candidates",
      storePath: null,
      candidateSessionIds,
      relabelledSessions: []
    };
  }
  const resolution = resolveOpenCodeDbPath("v1", { env: options.env });
  let evidence = null;
  let reason = null;
  if (!openCodeDbPathExists(resolution)) {
    reason = "store_not_found";
  } else {
    try {
      evidence = openEvidenceStore(resolution.path);
      if (!evidence)
        reason = "store_schema_unknown";
    } catch (error) {
      reason = "store_unreadable";
      log(`[migration] OpenCode session database at ${resolution.path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!evidence || reason !== null) {
    evidence?.close();
    writeUnresolvedState(db, reason ?? "store_not_found", resolution, candidateSessionIds);
    log(`[migration] OpenCode harness labels left unverified for ${candidateSessionIds.length} session(s): ` + `no readable OpenCode session database (${reason ?? "store_not_found"}) at ${resolution.path}. ` + "Nothing was relabelled; `magic-context doctor` reports the affected sessions.");
    return {
      status: "unresolved",
      reason: reason ?? "store_not_found",
      storePath: null,
      candidateSessionIds,
      relabelledSessions: []
    };
  }
  const relabelledSessions = [];
  try {
    const updates = shapes.filter((shape) => shape.hasSessionId).map((shape) => db.prepare(`UPDATE ${shape.table} SET harness = ? WHERE session_id = ? AND harness = ?`));
    const presentTables = new Set(shapes.map((shape) => shape.table));
    const twinResolvers = V87_HARNESS_TWIN_RULES.filter((rule) => presentTables.has(rule.table)).map((rule) => prepareTwinResolver(db, rule.table, rule.keyColumns, rule.incomingIsNewer));
    for (const sessionId of candidateSessionIds) {
      const target = resolveHarnessFromEvidence(evidence, sessionId);
      if (target === null)
        continue;
      const source = target === "opencode" ? "opencode2" : "opencode";
      for (const resolver of twinResolvers)
        resolver.run(sessionId, target, source);
      let moved = 0;
      for (const update of updates) {
        moved += Number(update.run(target, sessionId, source).changes ?? 0);
      }
      if (moved > 0)
        relabelledSessions.push({ sessionId, harness: target });
    }
  } finally {
    evidence.close();
  }
  clearUnresolvedState(db);
  if (relabelledSessions.length > 0) {
    const toOpenCode2 = relabelledSessions.filter((entry) => entry.harness === "opencode2").length;
    log(`[migration] OpenCode harness labels repaired from ${resolution.path}: ` + `${toOpenCode2} session(s) restored to opencode2, ` + `${relabelledSessions.length - toOpenCode2} session(s) set to opencode.`);
  }
  return {
    status: "resolved",
    storePath: resolution.path,
    candidateSessionIds,
    relabelledSessions
  };
}

// ../plugin/src/features/magic-context/storage-compartment-history-version.ts
function definitions(db) {
  const hasPrivilegeTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_privilege_state'").get());
  const externalUpdate = hasPrivilegeTable ? "CASE WHEN COALESCE((SELECT enabled FROM context_privilege_state WHERE id=1),0)=0 THEN 1 ELSE 0 END" : "1";
  return [
    {
      type: "table",
      name: "compartment_history_versions",
      sql: `CREATE TABLE compartment_history_versions (
            session_id TEXT PRIMARY KEY NOT NULL,
            generation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
            version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
            rewrite_version INTEGER NOT NULL DEFAULT 0 CHECK (rewrite_version >= 0),
            seeded INTEGER NOT NULL DEFAULT 0 CHECK (seeded IN (0, 1))
        )`
    },
    {
      type: "trigger",
      name: "compartment_history_ai",
      sql: `CREATE TRIGGER compartment_history_ai AFTER INSERT ON compartments BEGIN
            INSERT INTO compartment_history_versions(session_id, version) VALUES (NEW.session_id, 1)
            ON CONFLICT(session_id) DO UPDATE SET version = version + 1;
        END`
    },
    {
      type: "trigger",
      name: "compartment_history_ad",
      sql: `CREATE TRIGGER compartment_history_ad AFTER DELETE ON compartments BEGIN
            INSERT INTO compartment_history_versions(session_id, version) VALUES (OLD.session_id, 1)
            ON CONFLICT(session_id) DO UPDATE SET version = version + 1;
        END`
    },
    {
      type: "trigger",
      name: "compartment_history_au",
      sql: `CREATE TRIGGER compartment_history_au AFTER UPDATE ON compartments BEGIN
            INSERT INTO compartment_history_versions(session_id, version, rewrite_version) VALUES (OLD.session_id, 1, ${externalUpdate})
            ON CONFLICT(session_id) DO UPDATE SET version = version + 1, rewrite_version = rewrite_version + ${externalUpdate};
            INSERT INTO compartment_history_versions(session_id, version, rewrite_version)
                SELECT NEW.session_id, 1, ${externalUpdate} WHERE NEW.session_id != OLD.session_id
            ON CONFLICT(session_id) DO UPDATE SET version = version + 1, rewrite_version = rewrite_version + ${externalUpdate};
        END`
    }
  ];
}
function installedDefinitions(db) {
  const rows = db.prepare(`SELECT type, name, sql FROM sqlite_master
        WHERE name IN ('compartment_history_versions', 'compartment_history_ai', 'compartment_history_ad', 'compartment_history_au')`).all();
  return new Map(rows.map((row) => [`${row.type}:${row.name}`, row.sql]));
}
function matches(expected, installed) {
  return expected.every((definition) => installed.get(`${definition.type}:${definition.name}`) === definition.sql);
}
function installCompartmentHistoryVersions(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='compartments'").get())
    return;
  if (matches(definitions(db), installedDefinitions(db)))
    return;
  db.transaction(() => {
    const expected = definitions(db);
    const installed = installedDefinitions(db);
    if (matches(expected, installed))
      return;
    const table = expected[0];
    const existingTable = installed.get(`table:${table.name}`);
    if (existingTable !== undefined && existingTable !== table.sql) {
      throw new Error("compartment_history_versions schema differs from v93; refusing to replace revision data");
    }
    if (existingTable === undefined)
      db.exec(table.sql);
    db.exec(`INSERT OR IGNORE INTO compartment_history_versions(session_id, seeded)
            SELECT DISTINCT session_id, 1 FROM compartments`);
    for (const trigger of expected.slice(1)) {
      if (installed.get(`trigger:${trigger.name}`) === trigger.sql)
        continue;
      db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
      db.exec(trigger.sql);
    }
  }).immediate();
}

// ../plugin/src/features/magic-context/storage-schema-helpers.ts
function ensureColumn(db, table, column, definition) {
  if (!/^[a-z][a-z0-9_]*$/.test(table) || !/^[a-z][a-z0-9_]*$/.test(column) || !/^[A-Z0-9_"'(),[\]\s]+$/i.test(definition)) {
    throw new Error(`Unsafe schema identifier: ${table}.${column} ${definition}`);
  }
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (rows.some((row) => row.name === column)) {
    return;
  }
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    const recheck = db.prepare(`PRAGMA table_info(${table})`).all();
    if (recheck.some((row) => row.name === column)) {
      return;
    }
    throw err;
  }
}
function healAllNullColumns(db) {
  const existingColumns = getSessionMetaColumns(db);
  const fallbacks = [
    ["cache_ttl", ""],
    ["last_nudge_band", ""],
    ["last_nudge_level", ""],
    ["channel2_nudge_claim_token", ""],
    ["last_transform_error", ""],
    ["nudge_anchor_message_id", ""],
    ["nudge_anchor_text", ""],
    ["sticky_turn_reminder_text", ""],
    ["sticky_turn_reminder_message_id", ""],
    ["note_nudge_trigger_message_id", ""],
    ["note_nudge_sticky_text", ""],
    ["note_nudge_sticky_message_id", ""],
    ["last_todo_state", ""],
    ["todo_synthetic_call_id", ""],
    ["todo_synthetic_anchor_message_id", ""],
    ["todo_synthetic_state_json", ""],
    ["system_prompt_hash", ""],
    ["stripped_placeholder_ids", ""],
    ["stale_reduce_stripped_ids", ""],
    ["processed_image_stripped_ids", ""],
    ["merged_reasoning_stripped_ids", ""],
    ["thinking_binding_recovery_target", ""],
    ["trailing_blank_decisions", ""],
    ["memory_block_cache", ""],
    ["memory_block_ids", ""],
    ["compaction_marker_state", ""],
    ["key_files", ""],
    ["times_execute_threshold_reached", 0],
    ["compartment_in_progress", 0],
    ["historian_failure_count", 0],
    ["cleared_reasoning_through_tag", 0],
    ["memory_block_count", 0],
    ["system_prompt_tokens", 0],
    ["conversation_tokens", 0],
    ["tool_call_tokens", 0],
    ["note_nudge_trigger_pending", 0],
    ["observed_safe_input_tokens", 0],
    ["cache_alert_sent", 0],
    ["new_work_tokens", 0],
    ["total_input_tokens", 0],
    ["last_emergency_input_sample", 0],
    ["channel2_nudge_claimed_at", 0],
    ["last_usage_context_limit", 0],
    ["prior_boundary_ordinal", 1],
    ["protected_tail_policy_version", 0],
    ["protected_tail_drain_window_started_at", 0],
    ["protected_tail_drain_tokens", 0],
    ["recovery_no_eligible_head_count", 0],
    ["force_emergency_bypass_window_start", 0],
    ["force_emergency_bypass_used", 0],
    ["emergency_drain_active", 0],
    ["historian_drain_failure_at", 0]
  ];
  const presentFallbacks = fallbacks.filter(([column]) => existingColumns.has(column));
  if (presentFallbacks.length > 0) {
    const assignments = presentFallbacks.map(([column]) => `${column} = COALESCE(${column}, ?)`).join(", ");
    const nullPredicate = presentFallbacks.map(([column]) => `${column} IS NULL`).join(" OR ");
    db.prepare(`UPDATE session_meta SET ${assignments} WHERE ${nullPredicate}`).run(...presentFallbacks.map(([, fallback]) => fallback));
  }
  healMissingMemoryBlockIds(db, existingColumns);
}
function getSessionMetaColumns(db) {
  const rows = db.prepare("PRAGMA table_info(session_meta)").all();
  return new Set(rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []));
}
function healMissingMemoryBlockIds(db, columns) {
  if (!columns.has("memory_block_cache") || !columns.has("memory_block_ids") || !columns.has("memory_block_count")) {
    return;
  }
  db.prepare("UPDATE session_meta SET memory_block_cache = '' WHERE memory_block_cache != '' AND (memory_block_ids IS NULL OR memory_block_ids = '') AND memory_block_count > 0").run();
}

// ../plugin/src/features/magic-context/memory/project-identity.ts
import { execFileSync } from "node:child_process";
import { createHash as createHash3 } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path3 from "node:path";

// ../plugin/src/features/magic-context/memory/project-identity-cache.ts
import { createHash as createHash2, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path2 from "node:path";

// ../plugin/src/shared/project-directory-key.ts
import path from "node:path";
function projectDirectoryKey(directory) {
  const slashed = directory.replaceAll("\\", "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "");
  if (/^[a-z]:\//i.test(slashed) || slashed.startsWith("//")) {
    return path.win32.normalize(slashed).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
  }
  return path.resolve(directory);
}

// ../plugin/src/features/magic-context/memory/project-identity-cache.ts
function cachePath(directory, storageDir = getMagicContextStorageDir()) {
  const hash = createHash2("sha256").update(projectDirectoryKey(directory)).digest("hex");
  return path2.join(storageDir, "project-identities", `${hash}.json`);
}
function rememberGitIdentity(directory, identity) {
  try {
    const destination = cachePath(directory);
    mkdirSync(path2.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ directory: projectDirectoryKey(directory), identity }), { mode: 384 });
    renameSync(temporary, destination);
  } catch {}
}
function readRememberedGitIdentity(directory, storageDir) {
  try {
    const record = JSON.parse(readFileSync(cachePath(directory, storageDir), "utf8"));
    if (record.directory === projectDirectoryKey(directory) && /^git:[0-9a-f]{7,64}$/.test(record.identity))
      return record.identity;
  } catch {}
  return;
}

// ../plugin/src/features/magic-context/memory/project-identity.ts
var GIT_TIMEOUT_MS = 5000;
var TRANSIENT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
var identityCache = new Map;
var linkedGitWorktreeCache = new Map;
var lastKnownGitIdentityCache = new Map;
var directoryFallbackCache = new Map;
var transientFailureCooldown = new Map;
var dubiousOwnershipFallbackDirectories = new Set;
var dubiousOwnershipLoggedDirectories = new Set;
var dubiousOwnershipWarnedDirectories = new Set;
var transientGitIdentityReuseLoggedDirectories = new Set;
var sessionIdentityCache = new Map;
var homeProjectPermission = false;
var pausedIdentityReasons = new Map;
var pausedIdentityLogged = new Set;
var execFileSyncForIdentity = execFileSync;
var userHomeDirectoryForIdentity = () => homedir();
var nowMs = () => Date.now();
var filesystemProbeObserverForTests;

class ProjectIdentityError extends Error {
  errorClass;
  rawDirectory;
  constructor(errorClass, rawDirectory, message, cause) {
    super(message);
    this.name = "ProjectIdentityError";
    this.errorClass = errorClass;
    this.rawDirectory = rawDirectory;
    if (cause) {
      this.cause = cause;
    }
  }
}
function asError(error) {
  return error instanceof Error ? error : undefined;
}
function getErrorCode(error) {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
function getErrorSignal(error) {
  if (error === null || typeof error !== "object" || !("signal" in error)) {
    return;
  }
  const signal = error.signal;
  return typeof signal === "string" ? signal : undefined;
}
function getErrorKilled(error) {
  if (error === null || typeof error !== "object" || !("killed" in error)) {
    return false;
  }
  return error.killed === true;
}
function getErrorStderr(error) {
  if (error === null || typeof error !== "object" || !("stderr" in error)) {
    return "";
  }
  const stderr = error.stderr;
  if (typeof stderr === "string") {
    return stderr;
  }
  if (Buffer.isBuffer(stderr)) {
    return stderr.toString("utf8");
  }
  return "";
}
function directoryFallback(directory) {
  const canonical = path3.resolve(directory);
  const hash = createHash3("md5").update(canonical, "utf8").digest("hex").slice(0, 12);
  return `dir:${hash}`;
}
function rememberedIdentityOrDirectoryFallback(canonical) {
  return readRememberedGitIdentity(canonical) ?? directoryFallback(canonical);
}
function assertDirectoryUsable(canonicalDirectory, rawDirectory) {
  try {
    const stat = statSync(canonicalDirectory);
    if (!stat.isDirectory()) {
      throw new ProjectIdentityError("unknown", rawDirectory, `Project path is not a directory: ${canonicalDirectory}`);
    }
  } catch (error) {
    if (error instanceof ProjectIdentityError) {
      throw error;
    }
    const code = getErrorCode(error);
    if (code === "EACCES" || code === "EPERM") {
      throw new ProjectIdentityError("permission_denied", rawDirectory, `Permission denied while accessing project directory: ${canonicalDirectory}`, asError(error));
    }
    throw new ProjectIdentityError("unknown", rawDirectory, `Unable to access project directory: ${canonicalDirectory}`, asError(error));
  }
}
function isGitTimeoutError(error) {
  const code = getErrorCode(error);
  const signal = getErrorSignal(error);
  return code === "ETIMEDOUT" || signal === "SIGTERM" || signal === "SIGKILL" || getErrorKilled(error);
}
function hasUnbornHead(directory) {
  const options = {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true
  };
  try {
    execFileSyncForIdentity("git", ["rev-parse", "--git-dir"], options);
    try {
      execFileSyncForIdentity("git", ["rev-parse", "--verify", "--quiet", "HEAD"], options);
      return false;
    } catch (error) {
      return !isGitTimeoutError(error) && typeof error === "object" && error !== null && "status" in error && error.status === 1 && getErrorStderr(error) === "";
    }
  } catch {
    return false;
  }
}
function classifyGitError(error, rawDirectory) {
  if (isGitTimeoutError(error)) {
    return new ProjectIdentityError("git_timeout", rawDirectory, `git rev-list timed out after ${GIT_TIMEOUT_MS}ms`, asError(error));
  }
  const code = getErrorCode(error);
  if (code === "ENOENT") {
    return new ProjectIdentityError("git_missing", rawDirectory, "git binary is not available in PATH", asError(error));
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ProjectIdentityError("permission_denied", rawDirectory, "Permission denied while spawning git", asError(error));
  }
  const stderr = getErrorStderr(error).toLowerCase();
  if (stderr.includes("detected dubious ownership")) {
    return new ProjectIdentityError("dubious_ownership", rawDirectory, "git refused to read the repository because it detected dubious ownership", asError(error));
  }
  if (stderr.includes("not a git repository") || stderr.includes("does not have any commits yet") || stderr.includes("ambiguous argument 'head'") || stderr.includes("unknown revision or path")) {
    return new ProjectIdentityError("not_git_repo", rawDirectory, "Directory has no git root commit; caller may use directory fallback", asError(error));
  }
  return new ProjectIdentityError("unknown", rawDirectory, "git rev-list failed while resolving project identity", asError(error));
}
function resolveProjectIdentityStrict(directory, allowHomeProject = homeProjectPermission) {
  assertProjectAllowed(directory, allowHomeProject);
  const canonical = path3.resolve(directory);
  const cached = identityCache.get(canonical);
  if (cached !== undefined) {
    return cached;
  }
  assertDirectoryUsable(canonical, directory);
  if (!hasGitDir(canonical)) {
    throw new ProjectIdentityError("not_git_repo", directory, "Directory has no git metadata; caller may use directory fallback");
  }
  let output;
  try {
    output = execFileSyncForIdentity("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd: canonical,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true
    });
  } catch (error) {
    const classified = classifyGitError(error, directory);
    if (classified.errorClass === "not_git_repo" && hasUnbornHead(canonical)) {
      throw new ProjectIdentityError("no_commits", directory, "Git repository has no commits yet");
    }
    throw classified;
  }
  const rootCommit = output.split(`
`).map((line) => line.trim().slice(0, 64)).filter((line) => /^[0-9a-f]{7,64}$/.test(line)).sort()[0];
  if (!rootCommit) {
    throw new ProjectIdentityError("unknown", directory, "git rev-list returned no valid root commit hash");
  }
  const identity = `git:${rootCommit}`;
  identityCache.set(canonical, identity);
  lastKnownGitIdentityCache.set(canonical, identity);
  rememberGitIdentity(canonical, identity);
  const root = gitRootDirectory(canonical);
  if (root && root !== canonical)
    rememberGitIdentity(root, identity);
  transientFailureCooldown.delete(canonical);
  dubiousOwnershipFallbackDirectories.delete(canonical);
  transientGitIdentityReuseLoggedDirectories.delete(canonical);
  return identity;
}
function shouldUseDirectoryFallback(error) {
  return error.errorClass !== "home_project_disabled";
}
function getActiveCooldown(canonical) {
  const until = transientFailureCooldown.get(canonical);
  if (until === undefined)
    return;
  if (nowMs() < until)
    return until;
  transientFailureCooldown.delete(canonical);
  return;
}
function lastKnownGitIdentity(canonical) {
  return lastKnownGitIdentityCache.get(canonical) ?? identityCache.get(canonical) ?? readRememberedGitIdentity(canonical);
}
function nearestLastKnownGitIdentity(canonical) {
  const visited = new Set;
  const walk = (start) => {
    let current = start;
    while (!visited.has(current)) {
      visited.add(current);
      const cached = lastKnownGitIdentity(current);
      if (cached !== undefined)
        return { identity: cached, source: current };
      if (existsSync(path3.join(current, ".git")))
        break;
      const parent = path3.dirname(current);
      if (parent === current)
        break;
      current = parent;
    }
    return;
  };
  const exactOrAncestor = walk(canonical);
  if (exactOrAncestor)
    return exactOrAncestor;
  try {
    const realCanonical = realpathSync.native(canonical);
    if (realCanonical !== canonical)
      return walk(realCanonical);
  } catch {}
  return;
}
function reuseLastKnownGitIdentity(canonical) {
  const cached = nearestLastKnownGitIdentity(canonical);
  if (cached === undefined)
    return;
  if (!transientGitIdentityReuseLoggedDirectories.has(canonical)) {
    transientGitIdentityReuseLoggedDirectories.add(canonical);
    const sourceNote = cached.source === canonical ? "" : ` from ancestor ${cached.source}`;
    log(`[magic-context] git identity resolution is temporarily unavailable for ${canonical}; reusing the last successful project identity${sourceNote} to avoid splitting project-scoped memory`);
  }
  return cached.identity;
}
function formatDubiousOwnershipWarning(canonical) {
  return `Magic Context: git refused to read ${canonical} (dubious ownership — the repo is owned by a different user). Memory features are paused unless a previous git identity is available. Fix: git config --global --add safe.directory ${canonical}`;
}
function recordDubiousOwnershipFallback(canonical) {
  dubiousOwnershipFallbackDirectories.add(canonical);
  if (dubiousOwnershipLoggedDirectories.has(canonical))
    return;
  dubiousOwnershipLoggedDirectories.add(canonical);
  log(`[magic-context] ${formatDubiousOwnershipWarning(canonical)}`);
}
function canonicalUserHomeDirectory() {
  const homeDirectory = userHomeDirectoryForIdentity();
  try {
    return realpathSync.native(homeDirectory);
  } catch {
    return homeDirectory;
  }
}
function isUserHomeDirectory(directory) {
  if (projectDirectoryKey(directory) === projectDirectoryKey(userHomeDirectoryForIdentity()))
    return true;
  try {
    return projectDirectoryKey(realpathSync.native(path3.resolve(directory))) === projectDirectoryKey(canonicalUserHomeDirectory());
  } catch {
    return false;
  }
}
function assertProjectAllowed(directory, allowHomeProject) {
  const canonical = path3.resolve(directory);
  if (!allowHomeProject && (isUserHomeDirectory(directory) || isUserHomeDirectory(gitRootDirectory(canonical) ?? canonical))) {
    throw new ProjectIdentityError("home_project_disabled", directory, "Home project memory is disabled; set allow_home_project to opt in");
  }
}
function resolveProjectIdentity(directory, allowHomeProject = homeProjectPermission) {
  assertProjectAllowed(directory, allowHomeProject);
  const canonical = path3.resolve(directory);
  const cachedFallback = directoryFallbackCache.get(canonical);
  if (cachedFallback !== undefined) {
    if (!hasGitDir(canonical)) {
      return cachedFallback;
    }
    directoryFallbackCache.delete(canonical);
  }
  if (getActiveCooldown(canonical) !== undefined) {
    if (hasGitDir(canonical)) {
      const cachedGitIdentity = reuseLastKnownGitIdentity(canonical);
      if (cachedGitIdentity !== undefined) {
        return cachedGitIdentity;
      }
      throw new ProjectIdentityError("git_identity_unavailable", directory, "Git identity unavailable; memory features paused until the retry cooldown expires");
    }
    return rememberedIdentityOrDirectoryFallback(canonical);
  }
  try {
    return resolveProjectIdentityStrict(directory, allowHomeProject);
  } catch (error) {
    if (error instanceof ProjectIdentityError && shouldUseDirectoryFallback(error)) {
      if (error.errorClass === "no_commits")
        return directoryFallback(canonical);
      if (!hasGitDir(canonical)) {
        if (error.errorClass === "permission_denied")
          throw error;
        const resolved = rememberedIdentityOrDirectoryFallback(canonical);
        directoryFallbackCache.set(canonical, resolved);
        transientFailureCooldown.delete(canonical);
        return resolved;
      }
      transientFailureCooldown.set(canonical, nowMs() + TRANSIENT_FAILURE_COOLDOWN_MS);
      const cachedGitIdentity = reuseLastKnownGitIdentity(canonical);
      if (error.errorClass === "dubious_ownership")
        recordDubiousOwnershipFallback(canonical);
      if (cachedGitIdentity !== undefined) {
        return cachedGitIdentity;
      }
      throw error;
    }
    throw error;
  }
}
function resolveProjectIdentityOrFallback(directory, allowHomeProject = homeProjectPermission) {
  try {
    return resolveProjectIdentity(directory, allowHomeProject);
  } catch (error) {
    const canonical = path3.resolve(directory);
    if (hasGitDir(canonical) || error instanceof ProjectIdentityError && error.errorClass === "home_project_disabled")
      throw error;
    const fallback = rememberedIdentityOrDirectoryFallback(canonical);
    const message = error instanceof Error ? error.message : String(error);
    log(`[magic-context] project identity resolution failed for ${canonical}; using directory fallback ${fallback}: ${message}`);
    return fallback;
  }
}
function hasGitDir(canonical) {
  if (hasGitDirInAncestorChain(canonical)) {
    return true;
  }
  try {
    const realCanonical = realpathSync.native(canonical);
    return realCanonical !== canonical && hasGitDirInAncestorChain(realCanonical);
  } catch {
    return false;
  }
}
function gitRootInAncestorChain(startDirectory) {
  let current = startDirectory;
  while (true) {
    if (existsSync(path3.join(current, ".git"))) {
      try {
        return realpathSync.native(current);
      } catch {
        return path3.resolve(current);
      }
    }
    const parent = path3.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
function hasGitDirInAncestorChain(startDirectory) {
  return gitRootInAncestorChain(startDirectory) !== null;
}
function gitRootDirectory(canonical) {
  const direct = gitRootInAncestorChain(canonical);
  if (direct)
    return direct;
  try {
    const realCanonical = realpathSync.native(canonical);
    return realCanonical === canonical ? null : gitRootInAncestorChain(realCanonical);
  } catch {
    return null;
  }
}
function directoryHasGitMetadata(directory) {
  return gitRootDirectory(path3.resolve(directory)) !== null;
}
function describeUnresolvedProjectIdentity(directory) {
  const resolvedDirectory = path3.resolve(directory);
  const canonicalHome = canonicalUserHomeDirectory();
  const canonicalDirectory = (() => {
    try {
      return realpathSync.native(resolvedDirectory);
    } catch {
      return resolvedDirectory;
    }
  })();
  if (isUserHomeDirectory(directory) || gitRootDirectory(canonicalDirectory) === canonicalHome) {
    return `this session runs in your home directory (${canonicalHome}), which Magic Context does not treat as a project. ` + "Start OpenCode inside a project folder, or set `allow_home_project: true` in the user-level " + "magic-context.jsonc (~/.config/cortexkit/) to give home sessions their own memory.";
  }
  if (hasGitDir(resolvedDirectory))
    return `git identity resolution for ${resolvedDirectory} is temporarily unavailable. Memory features are paused; retry after git access recovers.`;
  return `the session directory ${resolvedDirectory} could not be read as a project.`;
}
function resolveProjectIdentityForSession(directory, allowHomeProject = homeProjectPermission) {
  const resolvedDirectory = path3.resolve(directory);
  const cacheKey = `${allowHomeProject ? "1" : "0"}\x00${resolvedDirectory}`;
  const cached = sessionIdentityCache.get(cacheKey);
  if (cached && (cached.revalidateAt === null || nowMs() < cached.revalidateAt) && !(cached.identity?.startsWith("dir:") && hasGitDir(resolvedDirectory))) {
    return cached.identity;
  }
  sessionIdentityCache.delete(cacheKey);
  filesystemProbeObserverForTests?.();
  const canonicalDirectory = (() => {
    try {
      filesystemProbeObserverForTests?.();
      return realpathSync.native(resolvedDirectory);
    } catch {
      return resolvedDirectory;
    }
  })();
  filesystemProbeObserverForTests?.();
  const homeRoot = gitRootDirectory(canonicalDirectory);
  const inheritsHomeRepository = homeRoot !== null && isUserHomeDirectory(homeRoot);
  let identity;
  if (!allowHomeProject && (isUserHomeDirectory(directory) || inheritsHomeRepository)) {
    identity = undefined;
  } else {
    try {
      identity = resolveProjectIdentityOrFallback(isUserHomeDirectory(directory) ? canonicalUserHomeDirectory() : directory, allowHomeProject);
    } catch (error) {
      if (!(error instanceof ProjectIdentityError))
        throw error;
      const reason = error.errorClass === "git_identity_unavailable" ? pausedIdentityReasons.get(resolvedDirectory) ?? error.errorClass : error.errorClass;
      pausedIdentityReasons.set(resolvedDirectory, reason);
      const logKey = `${resolvedDirectory}\x00${reason}`;
      if (!pausedIdentityLogged.has(logKey)) {
        pausedIdentityLogged.add(logKey);
        log(`[magic-context] memory features paused for ${resolvedDirectory}: ${reason}`);
      }
      identity = undefined;
    }
  }
  if (identity !== undefined)
    pausedIdentityReasons.delete(resolvedDirectory);
  sessionIdentityCache.set(cacheKey, {
    identity,
    revalidateAt: identity?.startsWith("git:") === true ? null : nowMs() + TRANSIENT_FAILURE_COOLDOWN_MS
  });
  return identity;
}
function normalizeStoredProjectPath(rawOrStored) {
  if (rawOrStored.startsWith("git:") || rawOrStored.startsWith("dir:")) {
    return rawOrStored;
  }
  try {
    return resolveProjectIdentity(rawOrStored);
  } catch {
    return rawOrStored;
  }
}
function storedPathBelongsToIdentity(storedProjectPath, projectIdentity) {
  return storedProjectPath === projectIdentity || normalizeStoredProjectPath(storedProjectPath) === projectIdentity;
}
// ../plugin/src/features/magic-context/workspaces.ts
var VALID_SHARE_CATEGORIES = new Set(V2_MEMORY_CATEGORIES);
var DEFAULT_WORKSPACE_SHARE_CATEGORIES = ["CONSTRAINTS"];
function tableExists3(db, tableName) {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1").get(tableName);
  return Boolean(row);
}
function columnExists2(db, tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}
function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function placeholders(values) {
  return values.map(() => "?").join(", ");
}
function defaultWorkspaceShareCategories() {
  return [...DEFAULT_WORKSPACE_SHARE_CATEGORIES];
}
function warnInvalidShareCategories(reason, raw) {
  log("[magic-context] WARN: invalid workspace share_categories; sharing no foreign memory categories", {
    reason,
    raw
  });
}
function normalizeShareCategories(raw) {
  if (raw === null || raw === undefined) {
    return defaultWorkspaceShareCategories();
  }
  if (typeof raw !== "string") {
    warnInvalidShareCategories("not a string", raw);
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnInvalidShareCategories("malformed JSON", raw);
    return [];
  }
  if (!Array.isArray(parsed)) {
    warnInvalidShareCategories("not a JSON array", raw);
    return [];
  }
  const categories = [];
  for (const value of parsed) {
    if (typeof value !== "string" || !VALID_SHARE_CATEGORIES.has(value)) {
      warnInvalidShareCategories("unknown category", raw);
      return [];
    }
    if (!categories.includes(value))
      categories.push(value);
  }
  return categories.sort((left, right) => left.localeCompare(right));
}
function selectWorkspaceShareCategories(db, identities) {
  const candidates = uniqueSorted(identities.filter((identity) => identity.length > 0));
  if (candidates.length === 0 || !tableExists3(db, "workspace_members")) {
    return null;
  }
  const hasMembership = Boolean(db.prepare(`SELECT 1
                   FROM workspace_members
                  WHERE project_path IN (${placeholders(candidates)})
                  LIMIT 1`).get(...candidates));
  if (!hasMembership)
    return null;
  if (!tableExists3(db, "workspaces")) {
    log("[magic-context] WARN: workspace member has no workspaces table; sharing no foreign memory categories");
    return [];
  }
  if (!columnExists2(db, "workspaces", "share_categories")) {
    return defaultWorkspaceShareCategories();
  }
  const row = db.prepare(`SELECT workspace.share_categories AS shareCategories
               FROM workspace_members AS member
               JOIN workspaces AS workspace ON workspace.id = member.workspace_id
              WHERE member.project_path IN (${placeholders(candidates)})
              ORDER BY workspace.id ASC
              LIMIT 1`).get(...candidates);
  if (!row) {
    log("[magic-context] WARN: workspace member has no workspace share_categories row; sharing no foreign memory categories");
    return [];
  }
  return normalizeShareCategories(row.shareCategories);
}
function resolveWorkspaceShareCategories(db, projectIdentity) {
  return selectWorkspaceShareCategories(db, [projectIdentity]);
}
function resolveWorkspaceIdentitySet(db, projectIdentity) {
  if (!tableExists3(db, "workspace_members")) {
    return { identities: [projectIdentity], namesByIdentity: new Map };
  }
  const rows = db.prepare(`SELECT member.project_path AS identity, member.display_name AS displayName
               FROM workspace_members AS anchor
               JOIN workspace_members AS member ON member.workspace_id = anchor.workspace_id
              WHERE anchor.project_path = ?
              ORDER BY member.display_name ASC, member.project_path ASC`).all(projectIdentity);
  if (rows.length === 0) {
    return { identities: [projectIdentity], namesByIdentity: new Map };
  }
  const namesByIdentity = new Map;
  const identities = [];
  for (const row of rows) {
    if (typeof row.identity !== "string" || row.identity.length === 0)
      continue;
    if (identities.includes(row.identity))
      continue;
    identities.push(row.identity);
    if (typeof row.displayName === "string" && row.displayName.length > 0) {
      namesByIdentity.set(row.identity, row.displayName);
    }
  }
  return identities.length > 0 ? { identities, namesByIdentity } : { identities: [projectIdentity], namesByIdentity: new Map };
}
function expandWorkspaceIdentitySetWithAliases(db, identities) {
  const canonical = uniqueSorted(identities.filter((identity) => identity.length > 0));
  const expanded = new Set(canonical);
  const canonicalIdentityByStoredPath = new Map;
  for (const identity of canonical) {
    canonicalIdentityByStoredPath.set(identity, identity);
  }
  if (canonical.length === 0 || !tableExists3(db, "v22_identity_rekey_map")) {
    return { expandedIdentities: [...expanded], canonicalIdentityByStoredPath };
  }
  const rows = db.prepare(`SELECT old_project_path AS oldProjectPath, new_project_path AS newProjectPath
               FROM v22_identity_rekey_map
              WHERE new_project_path IN (${placeholders(canonical)})
              ORDER BY old_project_path ASC`).all(...canonical);
  for (const row of rows) {
    if (typeof row.oldProjectPath !== "string" || typeof row.newProjectPath !== "string") {
      continue;
    }
    if (!canonicalIdentityByStoredPath.has(row.newProjectPath))
      continue;
    expanded.add(row.oldProjectPath);
    canonicalIdentityByStoredPath.set(row.oldProjectPath, row.newProjectPath);
  }
  return { expandedIdentities: [...expanded], canonicalIdentityByStoredPath };
}
function resolveStoredPathWorkspaceIdentity(storedProjectPath, memberIdentities, canonicalIdentityByStoredPath) {
  const direct = canonicalIdentityByStoredPath.get(storedProjectPath);
  if (direct)
    return direct;
  const normalized = normalizeStoredProjectPath(storedProjectPath);
  const normalizedDirect = canonicalIdentityByStoredPath.get(normalized);
  if (normalizedDirect)
    return normalizedDirect;
  if (memberIdentities.includes(normalized))
    return normalized;
  for (const identity of memberIdentities) {
    if (storedPathBelongsToIdentity(storedProjectPath, identity)) {
      return identity;
    }
  }
  return null;
}
function storedPathBelongsToWorkspace(storedProjectPath, memberIdentities, expandedIdentities, canonicalIdentityByStoredPath) {
  if (expandedIdentities.includes(storedProjectPath))
    return true;
  return resolveStoredPathWorkspaceIdentity(storedProjectPath, memberIdentities, canonicalIdentityByStoredPath) !== null;
}
function sourceNameForMemory(storedProjectPath, ownIdentity, memberIdentities, namesByIdentity, canonicalIdentityByStoredPath) {
  const canonicalIdentity = resolveStoredPathWorkspaceIdentity(storedProjectPath, memberIdentities, canonicalIdentityByStoredPath);
  if (!canonicalIdentity || canonicalIdentity === ownIdentity)
    return;
  return namesByIdentity.get(canonicalIdentity);
}
function isInTransaction(db) {
  const candidate = db;
  return candidate.inTransaction === true || candidate.isTransaction === true;
}
function bumpEpochRows(db, identities, now) {
  const stmt = db.prepare(`INSERT INTO project_state
            (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES (?, 1, 0, ?)
         ON CONFLICT(project_path) DO UPDATE SET
            project_memory_epoch = project_memory_epoch + 1,
            updated_at = excluded.updated_at`);
  for (const identity of uniqueSorted(identities)) {
    stmt.run(identity, now);
  }
}
function bumpEpochsForWorkspaceMemberSet(db, identities, now = Date.now()) {
  const run = () => bumpEpochRows(db, identities, now);
  if (isInTransaction(db)) {
    run();
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  const transactionStartedAt = performance.now();
  try {
    run();
    db.exec("COMMIT");
    logSlowWriteTransaction("workspace_epoch_bump", transactionStartedAt);
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

// ../plugin/src/features/magic-context/migrations.ts
var FORK_MIGRATION_VERSION_FLOOR = 1e4;
var MIGRATION_LOCK_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

class MigrationLockBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationLockBusyError";
  }
}
function isSqliteLockError(error) {
  if (!error || typeof error !== "object")
    return false;
  const candidate = error;
  if (candidate.code === "SQLITE_BUSY" || candidate.code === "SQLITE_LOCKED")
    return true;
  return typeof candidate.message === "string" && /database is locked|sqlite_(busy|locked)/i.test(candidate.message);
}
function tableExists4(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}
var V85_OPENCODE2_RELABEL_TABLES = [
  "tags",
  "pending_ops",
  "source_contents",
  "compartments",
  "compartment_chunk_embeddings",
  "session_projects",
  "compartment_events",
  "compression_depth",
  "session_facts",
  "primer_candidates",
  "notes",
  "message_history_index",
  "message_history_source",
  "pending_session_cleanup",
  "message_history_orphan_sweep",
  "session_meta",
  "subagent_invocations",
  "historian_runs",
  "transform_decisions",
  "recomp_compartments",
  "recomp_facts"
];
var V85_OPTIONAL_OPENCODE2_RELABEL_TABLES = ["session_project_backfill_state"];
function healMismatchedTierClose(db, table, hasLegacy) {
  if (!tableExists4(db, table))
    return;
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  for (const required of ["content", "p1", "p2", "p3", "p4"]) {
    if (!columns.has(required))
      return;
  }
  if (hasLegacy && !columns.has("legacy"))
    return;
  const predicate = hasLegacy ? "legacy = 1 AND p1 IS NULL AND content LIKE '%<p1%'" : "p1 IS NULL AND content LIKE '%<p1%'";
  const rows = db.prepare(`SELECT id, content FROM ${table} WHERE ${predicate}`).all();
  const update = db.prepare(`UPDATE ${table} SET p1 = ?, p2 = ?, p3 = ?, p4 = ?${hasLegacy ? ", legacy = 0" : ""} WHERE id = ?`);
  for (const row of rows) {
    const tiers = extractTiersFromInner(row.content);
    if (typeof tiers.p1 !== "string" || tiers.p1.length === 0)
      continue;
    const p1 = tiers.p1;
    const p2 = typeof tiers.p2 === "string" ? tiers.p2 : p1;
    const p3 = typeof tiers.p3 === "string" ? tiers.p3 : p2;
    const p4 = typeof tiers.p4 === "string" ? tiers.p4 : "";
    update.run(p1, p2, p3, p4, row.id);
  }
}
function assertForeignKeyIntegrity(db, table) {
  const rows = (table ? db.prepare(`PRAGMA foreign_key_check(${table})`) : db.prepare("PRAGMA foreign_key_check")).all();
  if (rows.length > 0) {
    throw new Error(`foreign_key_check failed after embedding table rebuild${table ? ` (${table})` : ""} (${rows.length} violation(s))`);
  }
}
function authorityPrivilegeCheck() {
  return "COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0";
}
function managedAuthorityNoteRow(row) {
  return `(
        EXISTS (SELECT 1 FROM authority_managed WHERE project_path = ${row}.project_path)
        OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = ${row}.project_path)
        OR EXISTS (
            SELECT 1 FROM session_projects sp
            JOIN authority_managed am ON am.project_path = sp.project_path
            WHERE sp.session_id = ${row}.session_id
        )
        OR EXISTS (
            SELECT 1 FROM session_projects sp
            JOIN authority_repair_pending arp ON arp.project_path = sp.project_path
            WHERE sp.session_id = ${row}.session_id
        )
    )`;
}
function installLatestAuthorityTriggers(db) {
  const privilegeCheck = authorityPrivilegeCheck();
  if (tableExists4(db, "memories")) {
    db.exec(`
            DROP TRIGGER IF EXISTS memories_authority_guard_insert;
            DROP TRIGGER IF EXISTS memories_authority_guard_update;
            DROP TRIGGER IF EXISTS memories_authority_guard_delete;
            CREATE TRIGGER memories_authority_guard_insert
            BEFORE INSERT ON memories
            WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
               OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
              AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
            CREATE TRIGGER memories_authority_guard_update
            BEFORE UPDATE ON memories
            WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
               OR EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
               OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
               OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
              AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
            CREATE TRIGGER memories_authority_guard_delete
            BEFORE DELETE ON memories
            WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
               OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path))
              AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
        `);
  }
  if (tableExists4(db, "notes")) {
    const managedOld = managedAuthorityNoteRow("OLD");
    const managedNew = managedAuthorityNoteRow("NEW");
    db.exec(`
            DROP TRIGGER IF EXISTS notes_authority_guard_insert;
            DROP TRIGGER IF EXISTS notes_authority_guard_update;
            DROP TRIGGER IF EXISTS notes_authority_guard_delete;
            CREATE TRIGGER notes_authority_guard_insert
            BEFORE INSERT ON notes
            WHEN ${managedNew} AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;
            CREATE TRIGGER notes_authority_guard_update
            BEFORE UPDATE ON notes
            WHEN (${managedOld} OR ${managedNew}) AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;
            CREATE TRIGGER notes_authority_guard_delete
            BEFORE DELETE ON notes
            WHEN ${managedOld} AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;
        `);
  }
}
var MIGRATIONS = [
  {
    version: 1,
    description: "Merge session_notes + smart_notes into unified notes table",
    up: (db) => {
      db.exec(`
				CREATE TABLE IF NOT EXISTS notes (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					type TEXT NOT NULL DEFAULT 'session',
					status TEXT NOT NULL DEFAULT 'active',
					content TEXT NOT NULL,
					session_id TEXT,
					project_path TEXT,
					surface_condition TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					last_checked_at INTEGER,
					ready_at INTEGER,
					ready_reason TEXT,
					compiled_provider TEXT,
					compiled_config TEXT,
					compiled_at INTEGER,
					compile_status TEXT CHECK(compile_status IN ('compiled', 'plain', 'refused'))
				);
				CREATE INDEX IF NOT EXISTS idx_notes_session_status ON notes(session_id, status);
				CREATE INDEX IF NOT EXISTS idx_notes_project_status ON notes(project_path, status);
				CREATE INDEX IF NOT EXISTS idx_notes_type_status ON notes(type, status);
			`);
      const hasSessionNotes = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_notes'").get();
      if (hasSessionNotes) {
        db.exec(`
					INSERT INTO notes (type, status, content, session_id, created_at, updated_at)
					SELECT 'session', 'active', content, session_id, created_at, created_at
					FROM session_notes
				`);
      }
      const hasSmartNotes = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='smart_notes'").get();
      if (hasSmartNotes) {
        db.exec(`
					INSERT INTO notes (type, status, content, session_id, project_path, surface_condition,
						created_at, updated_at, last_checked_at, ready_at, ready_reason)
					SELECT 'smart', status, content, created_session_id, project_path, surface_condition,
						created_at, updated_at, last_checked_at, ready_at, ready_reason
					FROM smart_notes
				`);
      }
      if (hasSessionNotes) {
        const sourceCount = db.prepare("SELECT COUNT(*) as c FROM session_notes").get().c;
        const migratedCount = db.prepare("SELECT COUNT(*) as c FROM notes WHERE type = 'session'").get().c;
        if (migratedCount >= sourceCount) {
          db.exec("DROP TABLE session_notes");
        } else {
          throw new Error(`session_notes migration verification failed: expected ${sourceCount} rows, got ${migratedCount}`);
        }
      }
      if (hasSmartNotes) {
        const sourceCount = db.prepare("SELECT COUNT(*) as c FROM smart_notes").get().c;
        const migratedCount = db.prepare("SELECT COUNT(*) as c FROM notes WHERE type = 'smart'").get().c;
        if (migratedCount >= sourceCount) {
          db.exec("DROP TABLE smart_notes");
        } else {
          throw new Error(`smart_notes migration verification failed: expected ${sourceCount} rows, got ${migratedCount}`);
        }
      }
    }
  },
  {
    version: 2,
    description: "Add plugin_messages table for TUI ↔ server communication",
    up: (db) => {
      db.exec(`
				CREATE TABLE IF NOT EXISTS plugin_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					direction TEXT NOT NULL,
					type TEXT NOT NULL,
					payload TEXT NOT NULL DEFAULT '{}',
					session_id TEXT,
					created_at INTEGER NOT NULL,
					consumed_at INTEGER
				);
				CREATE INDEX IF NOT EXISTS idx_plugin_messages_direction_consumed
					ON plugin_messages(direction, consumed_at);
				CREATE INDEX IF NOT EXISTS idx_plugin_messages_created
					ON plugin_messages(created_at);
			`);
    }
  },
  {
    version: 3,
    description: "Add user_memory_candidates and user_memories tables",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS user_memory_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    source_compartment_start INTEGER,
                    source_compartment_end INTEGER,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_umc_created ON user_memory_candidates(created_at);

                CREATE TABLE IF NOT EXISTS user_memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    promoted_at INTEGER NOT NULL,
                    source_candidate_ids TEXT DEFAULT '[]',
                    source_candidate_provenance TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_um_status ON user_memories(status);
            `);
    }
  },
  {
    version: 4,
    description: "Add git_commits + git_commit_embeddings + git_commits_fts tables",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS git_commits (
                    sha TEXT PRIMARY KEY,
                    project_path TEXT NOT NULL,
                    short_sha TEXT NOT NULL,
                    message TEXT NOT NULL,
                    author TEXT,
                    committed_at INTEGER NOT NULL,
                    indexed_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_git_commits_project_time
                    ON git_commits(project_path, committed_at DESC);

                CREATE TABLE IF NOT EXISTS git_commit_embeddings (
                    sha TEXT PRIMARY KEY,
                    embedding BLOB NOT NULL,
                    model_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    -- FK-cascade audit (v12): git_commit_embeddings.sha -> git_commits.sha
                    -- uses ON DELETE CASCADE, so SQLite PRAGMA foreign_keys must be ON on
                    -- every connection and v12 cleans historical orphan rows.
                    FOREIGN KEY(sha) REFERENCES git_commits(sha) ON DELETE CASCADE
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS git_commits_fts USING fts5(
                    sha UNINDEXED,
                    project_path UNINDEXED,
                    message,
                    tokenize = 'porter unicode61'
                );

                -- Mirror writes into FTS. We intentionally rebuild FTS rows on
                -- every INSERT OR REPLACE so amended commits or re-indexed
                -- messages update cleanly.
                CREATE TRIGGER IF NOT EXISTS git_commits_fts_insert
                AFTER INSERT ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = NEW.sha;
                    INSERT INTO git_commits_fts(sha, project_path, message)
                    VALUES (NEW.sha, NEW.project_path, NEW.message);
                END;

                CREATE TRIGGER IF NOT EXISTS git_commits_fts_delete
                AFTER DELETE ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = OLD.sha;
                END;

                CREATE TRIGGER IF NOT EXISTS git_commits_fts_update
                AFTER UPDATE OF message, project_path ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = OLD.sha;
                    INSERT INTO git_commits_fts(sha, project_path, message)
                    VALUES (NEW.sha, NEW.project_path, NEW.message);
                END;
            `);
    }
  },
  {
    version: 5,
    description: "One-shot heal of NULL session_meta columns",
    up: (db) => {
      healAllNullColumns(db);
    }
  },
  {
    version: 6,
    description: "Heal session_meta.counter drift below MAX(tag_number)",
    up: (db) => {
      db.prepare(`UPDATE session_meta
                 SET counter = (
                     SELECT MAX(tag_number)
                     FROM tags
                     WHERE tags.session_id = session_meta.session_id
                 )
                 WHERE EXISTS (
                     SELECT 1
                     FROM tags
                     WHERE tags.session_id = session_meta.session_id
                       AND tags.tag_number > session_meta.counter
                 )`).run();
    }
  },
  {
    version: 7,
    description: "Add harness column to notes table for cross-harness sharing",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(notes)").all();
      if (!cols.some((c) => c.name === "harness")) {
        db.exec("ALTER TABLE notes ADD COLUMN harness TEXT NOT NULL DEFAULT 'opencode'");
      }
    }
  },
  {
    version: 8,
    description: "Add partial indexes on tags(session_id, tag_number) for active and dropped",
    up: (db) => {
      db.exec(`
                CREATE INDEX IF NOT EXISTS idx_tags_active_session_tag_number
                ON tags(session_id, tag_number)
                WHERE status = 'active';

                CREATE INDEX IF NOT EXISTS idx_tags_dropped_session_tag_number
                ON tags(session_id, tag_number)
                WHERE status = 'dropped';
            `);
      db.exec("ANALYZE tags;");
    }
  },
  {
    version: 9,
    description: "Persist tool_definition_measurements across plugin restarts",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS tool_definition_measurements (
                    provider_id TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    agent_name TEXT NOT NULL,
                    tool_id TEXT NOT NULL,
                    token_count INTEGER NOT NULL,
                    recorded_at INTEGER NOT NULL,
                    PRIMARY KEY (provider_id, model_id, agent_name, tool_id)
                );
            `);
    }
  },
  {
    version: 10,
    description: "Add tool_owner_message_id column to tags + composite identity indexes",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(tags)").all();
      if (!cols.some((c) => c.name === "tool_owner_message_id")) {
        db.exec("ALTER TABLE tags ADD COLUMN tool_owner_message_id TEXT DEFAULT NULL");
      }
      db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_tool_composite
                ON tags(session_id, message_id, tool_owner_message_id)
                WHERE type = 'tool' AND tool_owner_message_id IS NOT NULL;

                CREATE INDEX IF NOT EXISTS idx_tags_tool_null_owner
                ON tags(session_id, message_id)
                WHERE type = 'tool' AND tool_owner_message_id IS NULL;
            `);
    }
  },
  {
    version: 11,
    description: "Add todo state synthesis columns to session_meta",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!cols.some((c) => c.name === "last_todo_state")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN last_todo_state TEXT DEFAULT ''");
      }
      if (!cols.some((c) => c.name === "todo_synthetic_call_id")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN todo_synthetic_call_id TEXT DEFAULT ''");
      }
      if (!cols.some((c) => c.name === "todo_synthetic_anchor_message_id")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN todo_synthetic_anchor_message_id TEXT DEFAULT ''");
      }
      if (!cols.some((c) => c.name === "todo_synthetic_state_json")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN todo_synthetic_state_json TEXT DEFAULT ''");
      }
    }
  },
  {
    version: 12,
    description: "Clean orphan rows from FK-cascade embedding tables",
    up: (db) => {
      const hasTable = (name) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name));
      const memoryEmbeddings = hasTable("memory_embeddings") ? db.prepare(`DELETE FROM memory_embeddings
                           WHERE memory_id NOT IN (SELECT id FROM memories)`).run().changes : 0;
      log(`[migrations] v12 cleaned ${memoryEmbeddings} orphan memory_embeddings row(s)`);
      const gitCommitEmbeddings = hasTable("git_commit_embeddings") ? db.prepare(`DELETE FROM git_commit_embeddings
                           WHERE sha NOT IN (SELECT sha FROM git_commits)`).run().changes : 0;
      log(`[migrations] v12 cleaned ${gitCommitEmbeddings} orphan git_commit_embeddings row(s)`);
    }
  },
  {
    version: 13,
    description: "Add pending_compaction_marker_state column for deferred marker drain",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!cols.some((c) => c.name === "pending_compaction_marker_state")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN pending_compaction_marker_state TEXT");
      }
    }
  },
  {
    version: 14,
    description: "Add project-scoped key files and version counter",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS project_key_files (
                    project_path           TEXT    NOT NULL,
                    path                   TEXT    NOT NULL,
                    content                TEXT    NOT NULL,
                    content_hash           TEXT    NOT NULL,
                    local_token_estimate   INTEGER NOT NULL,
                    generated_at           INTEGER NOT NULL,
                    generated_by_model     TEXT,
                    generation_config_hash TEXT    NOT NULL,
                    stale_reason           TEXT,
                    PRIMARY KEY (project_path, path)
                );

                CREATE INDEX IF NOT EXISTS idx_project_key_files_project
                    ON project_key_files(project_path);
                CREATE INDEX IF NOT EXISTS idx_project_key_files_generated_at
                    ON project_key_files(project_path, generated_at);

                CREATE TABLE IF NOT EXISTS project_key_files_version (
                    project_path TEXT    PRIMARY KEY,
                    version      INTEGER NOT NULL DEFAULT 0
                );
            `);
    }
  },
  {
    version: 15,
    description: "Add the now-retired deferred_execute_state column",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!cols.some((c) => c.name === "deferred_execute_state")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN deferred_execute_state TEXT");
      }
    }
  },
  {
    version: 16,
    description: "Add context-limit cache regression sentinels",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!cols.some((c) => c.name === "observed_safe_input_tokens")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0");
      }
      if (!cols.some((c) => c.name === "cache_alert_sent")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN cache_alert_sent INTEGER NOT NULL DEFAULT 0");
      }
    }
  },
  {
    version: 17,
    description: "Multi-anchor JSON storage for note-nudge and auto-search-hint persistence",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!cols.some((c) => c.name === "note_nudge_anchors")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN note_nudge_anchors TEXT NOT NULL DEFAULT '[]'");
      }
      if (!cols.some((c) => c.name === "auto_search_hint_decisions")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN auto_search_hint_decisions TEXT NOT NULL DEFAULT '[]'");
      }
      db.exec(`
                UPDATE session_meta
                SET note_nudge_anchors = json_array(
                    json_object(
                        'messageId', note_nudge_sticky_message_id,
                        'text', note_nudge_sticky_text
                    )
                )
                WHERE COALESCE(note_nudge_sticky_text, '') != ''
                  AND COALESCE(note_nudge_sticky_message_id, '') != ''
                  AND (note_nudge_anchors IS NULL OR note_nudge_anchors = '[]')
            `);
      db.exec(`
                UPDATE session_meta SET note_nudge_anchors = '[]'
                WHERE note_nudge_anchors IS NULL
            `);
      db.exec(`
                UPDATE session_meta SET auto_search_hint_decisions = '[]'
                WHERE auto_search_hint_decisions IS NULL
            `);
    }
  },
  {
    version: 18,
    description: "Add pending_pi_compaction_marker_state column for Pi deferred marker drain",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!cols.some((c) => c.name === "pending_pi_compaction_marker_state")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN pending_pi_compaction_marker_state TEXT");
      }
    }
  },
  {
    version: 19,
    description: "Add compartment state lease table",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS compartment_state_lease (
                    session_id TEXT PRIMARY KEY NOT NULL,
                    holder_id TEXT NOT NULL,
                    acquired_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_compartment_state_lease_expires
                    ON compartment_state_lease(expires_at);
            `);
    }
  },
  {
    version: 20,
    description: "Add subagent invocation token accounting",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS subagent_invocations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    harness TEXT NOT NULL,
                    subagent TEXT NOT NULL,
                    task TEXT,
                    provider_id TEXT,
                    model_id TEXT,
                    started_at INTEGER NOT NULL,
                    ended_at INTEGER,
                    status TEXT NOT NULL,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                    error TEXT,
                    parent_invocation_id INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_sai_session_started
                    ON subagent_invocations(session_id, started_at DESC);
                CREATE INDEX IF NOT EXISTS idx_sai_subagent
                    ON subagent_invocations(subagent, started_at DESC);
            `);
    }
  },
  {
    version: 21,
    description: "Add session lifetime work metrics",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!cols.some((c) => c.name === "new_work_tokens")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN new_work_tokens INTEGER NOT NULL DEFAULT 0");
      }
      if (!cols.some((c) => c.name === "total_input_tokens")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0");
      }
    }
  },
  {
    version: 22,
    description: "v2.0 cache architecture schema foundation",
    up: (db) => {
      const hasSessionMetaTable = tableExists4(db, "session_meta");
      const hasCompartmentsTable = tableExists4(db, "compartments");
      const hasMemoriesTable = tableExists4(db, "memories");
      if (hasSessionMetaTable) {
        ensureColumn(db, "session_meta", "cached_m0_bytes", "BLOB");
        ensureColumn(db, "session_meta", "cached_m0_project_memory_epoch", "INTEGER");
        ensureColumn(db, "session_meta", "cached_m0_project_user_profile_version", "INTEGER");
        ensureColumn(db, "session_meta", "cached_m0_max_compartment_seq", "INTEGER");
        ensureColumn(db, "session_meta", "cached_m0_max_memory_id", "INTEGER");
        ensureColumn(db, "session_meta", "cached_m0_max_mutation_id", "INTEGER");
        ensureColumn(db, "session_meta", "cached_m0_project_docs_hash", "TEXT");
        ensureColumn(db, "session_meta", "cached_m0_materialized_at", "INTEGER");
        ensureColumn(db, "session_meta", "cached_m0_session_facts_version", "INTEGER");
        ensureColumn(db, "session_meta", "cached_m0_upgrade_state", "TEXT");
        ensureColumn(db, "session_meta", "upgrade_reminded_at", "INTEGER");
      }
      if (hasCompartmentsTable) {
        ensureColumn(db, "compartments", "p1", "TEXT");
        ensureColumn(db, "compartments", "p2", "TEXT");
        ensureColumn(db, "compartments", "p3", "TEXT");
        ensureColumn(db, "compartments", "p4", "TEXT");
        ensureColumn(db, "compartments", "importance", "INTEGER NOT NULL DEFAULT 50");
        ensureColumn(db, "compartments", "episode_type", "TEXT");
        ensureColumn(db, "compartments", "p1_embedding", "BLOB");
        ensureColumn(db, "compartments", "p1_embedding_model_id", "TEXT");
        ensureColumn(db, "compartments", "legacy", "INTEGER NOT NULL DEFAULT 0");
      }
      const hasRecompCompartmentsTable = tableExists4(db, "recomp_compartments");
      if (hasRecompCompartmentsTable) {
        ensureColumn(db, "recomp_compartments", "p1", "TEXT");
        ensureColumn(db, "recomp_compartments", "p2", "TEXT");
        ensureColumn(db, "recomp_compartments", "p3", "TEXT");
        ensureColumn(db, "recomp_compartments", "p4", "TEXT");
        ensureColumn(db, "recomp_compartments", "importance", "INTEGER NOT NULL DEFAULT 50");
        ensureColumn(db, "recomp_compartments", "episode_type", "TEXT");
      }
      if (hasMemoriesTable) {
        ensureColumn(db, "memories", "importance", "INTEGER");
      }
      db.exec(`
                CREATE TABLE IF NOT EXISTS schema_migrations_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS project_state (
                    project_path TEXT PRIMARY KEY,
                    project_memory_epoch INTEGER NOT NULL DEFAULT 0,
                    project_user_profile_version INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS m0_mutation_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    mutation_type TEXT NOT NULL CHECK (mutation_type IN (
                        'compartment_delete',
                        'compartment_merge',
                        'recomp_boundary_change',
                        'compartment_upgrade'
                    )),
                    target_id INTEGER,
                    queued_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_m0_mutation_log_session
                    ON m0_mutation_log(session_id);

                CREATE TABLE IF NOT EXISTS v22_identity_rekey_map (
                    old_project_path TEXT PRIMARY KEY,
                    new_project_path TEXT NOT NULL,
                    rekeyed_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS v22_backfill_failures (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    table_name TEXT NOT NULL,
                    row_id INTEGER NOT NULL,
                    raw_project_path TEXT NOT NULL,
                    error_class TEXT NOT NULL CHECK (error_class IN (
                        'not_git_repo',
                        'git_missing',
                        'git_timeout',
                        'permission_denied',
                        'unknown'
                    )),
                    error_message TEXT,
                    failed_at INTEGER NOT NULL,
                    UNIQUE(table_name, row_id)
                );
            `);
      if (hasCompartmentsTable) {
        db.exec(`
                    INSERT OR IGNORE INTO schema_migrations_meta (key, value)
                    SELECT 'v22_legacy_compartment_boundary', CAST(COALESCE(MAX(id), 0) AS TEXT)
                    FROM compartments
                `);
        const boundaryRow = db.prepare("SELECT value FROM schema_migrations_meta WHERE key = 'v22_legacy_compartment_boundary'").get();
        const compartmentBoundary = Number.parseInt(boundaryRow?.value ?? "0", 10);
        db.prepare("UPDATE compartments SET legacy = 1 WHERE legacy = 0 AND id <= ?").run(Number.isFinite(compartmentBoundary) ? compartmentBoundary : 0);
      } else {
        db.prepare("INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES ('v22_legacy_compartment_boundary', '0')").run();
      }
      db.prepare("INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES ('v22_legacy_memory_backfill', 'pending')").run();
    }
  },
  {
    version: 23,
    description: "v2 compartment events storage (causal_incident / trajectory_correction)",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS compartment_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    compartment_id INTEGER,
                    kind TEXT NOT NULL,
                    at_compartment INTEGER,
                    fields_json TEXT NOT NULL DEFAULT '{}',
                    created_at INTEGER NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode'
                );
                CREATE INDEX IF NOT EXISTS idx_compartment_events_session
                    ON compartment_events(session_id);
            `);
    }
  },
  {
    version: 24,
    description: "historian_runs metrics (per-run quality/cost telemetry)",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS historian_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    subagent_invocation_id INTEGER,
                    run_kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    failure_reason TEXT,
                    chunk_start_ordinal INTEGER,
                    chunk_end_ordinal INTEGER,
                    unprocessed_from INTEGER,
                    compartments_produced INTEGER NOT NULL DEFAULT 0,
                    compartment_id_min INTEGER,
                    compartment_id_max INTEGER,
                    facts_emitted INTEGER NOT NULL DEFAULT 0,
                    facts_by_category_json TEXT,
                    events_emitted INTEGER NOT NULL DEFAULT 0,
                    importance_min INTEGER,
                    importance_max INTEGER,
                    importance_avg REAL,
                    discarded_last INTEGER NOT NULL DEFAULT 0,
                    legacy INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_historian_runs_session
                    ON historian_runs(session_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_historian_runs_status
                    ON historian_runs(status, created_at DESC);
            `);
    }
  },
  {
    version: 25,
    description: "pi_stable_id_scheme session_meta column (Pi message-id cutover gate)",
    up: (db) => {
      const rows = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!rows.some((row) => row.name === "pi_stable_id_scheme")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN pi_stable_id_scheme INTEGER");
      }
    }
  },
  {
    version: 26,
    description: "memory mutation log and atomic m[1] cache columns",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS memory_mutation_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    mutation_type TEXT NOT NULL CHECK (mutation_type IN (
                        'archive',
                        'delete',
                        'update',
                        'superseded'
                    )),
                    target_memory_id INTEGER NOT NULL,
                    superseded_by_id INTEGER,
                    category TEXT,
                    new_content TEXT,
                    queued_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_project
                    ON memory_mutation_log(project_path, id);
            `);
      ensureColumn(db, "session_meta", "cached_m0_bytes", "BLOB");
      ensureColumn(db, "session_meta", "cached_m0_project_memory_epoch", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_project_user_profile_version", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_max_compartment_seq", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_max_memory_id", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_max_mutation_id", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_max_memory_mutation_id", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_project_docs_hash", "TEXT");
      ensureColumn(db, "session_meta", "cached_m0_materialized_at", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_session_facts_version", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_upgrade_state", "TEXT");
      ensureColumn(db, "session_meta", "cached_m1_bytes", "BLOB");
      ensureColumn(db, "session_meta", "last_observed_model_key", "TEXT");
      ensureColumn(db, "session_meta", "memory_block_cache", "TEXT DEFAULT ''");
      ensureColumn(db, "session_meta", "memory_block_count", "INTEGER DEFAULT 0");
      ensureColumn(db, "session_meta", "memory_block_ids", "TEXT DEFAULT ''");
      db.prepare(`UPDATE session_meta SET
                    cached_m0_bytes = NULL,
                    cached_m1_bytes = NULL,
                    cached_m0_project_memory_epoch = NULL,
                    cached_m0_project_user_profile_version = NULL,
                    cached_m0_max_compartment_seq = NULL,
                    cached_m0_max_memory_id = NULL,
                    cached_m0_max_mutation_id = NULL,
                    cached_m0_max_memory_mutation_id = NULL,
                    cached_m0_project_docs_hash = NULL,
                    cached_m0_materialized_at = NULL,
                    cached_m0_session_facts_version = NULL,
                    cached_m0_upgrade_state = NULL,
                    memory_block_cache = '',
                    memory_block_count = 0,
                    memory_block_ids = ''`).run();
    }
  },
  {
    version: 27,
    description: "tags.entry_fingerprint for Pi fallback-tag adoption",
    up: (db) => {
      const hasTags = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tags' LIMIT 1").get();
      if (!hasTags)
        return;
      ensureColumn(db, "tags", "entry_fingerprint", "TEXT");
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tags_pi_adopt
                    ON tags(session_id, entry_fingerprint)
                    WHERE type='message' AND entry_fingerprint IS NOT NULL`);
    }
  },
  {
    version: 28,
    description: "Add git commit sweep coordinator lease/cooldown table",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS git_sweep_coordinator (
                    project_path TEXT PRIMARY KEY,
                    lease_holder TEXT,
                    lease_expires_at INTEGER,
                    last_swept_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_git_sweep_coordinator_lease_expires
                    ON git_sweep_coordinator(lease_expires_at);
                CREATE INDEX IF NOT EXISTS idx_git_sweep_coordinator_last_swept
                    ON git_sweep_coordinator(last_swept_at);
            `);
    }
  },
  {
    version: 29,
    description: "Add anchor_ordinal to notes (traceback to the conversation tail)",
    up: (db) => {
      const notesExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'").get();
      if (!notesExists) {
        return;
      }
      const columns = db.prepare("PRAGMA table_info(notes)").all();
      if (!columns.some((column) => column.name === "anchor_ordinal")) {
        db.exec("ALTER TABLE notes ADD COLUMN anchor_ordinal INTEGER");
      }
    }
  },
  {
    version: 30,
    description: "HARD-bust m[0] markers: cached system/tool-set/model identity",
    up: (db) => {
      const hasSessionMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1").get();
      if (!hasSessionMeta)
        return;
      ensureColumn(db, "session_meta", "cached_m0_system_hash", "TEXT");
      ensureColumn(db, "session_meta", "cached_m0_tool_set_hash", "TEXT");
      ensureColumn(db, "session_meta", "cached_m0_model_key", "TEXT");
      const columns = new Set(db.prepare("PRAGMA table_info(session_meta)").all().map((column) => column.name));
      if (columns.has("cached_m0_bytes")) {
        db.prepare(`UPDATE session_meta SET
                        cached_m0_bytes = NULL,
                        cached_m1_bytes = NULL,
                        cached_m0_materialized_at = NULL,
                        cached_m0_system_hash = NULL,
                        cached_m0_tool_set_hash = NULL,
                        cached_m0_model_key = NULL`).run();
      }
    }
  },
  {
    version: 31,
    description: "Nudge redesign: Channel 1 cadence (last_nudge_undropped) + Channel 2 ceiling lease " + "(channel2_nudge_state); zero legacy ctx_reduce-nudge sticky/anchor state (startup heal)",
    up: (db) => {
      const hasSessionMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1").get();
      if (!hasSessionMeta)
        return;
      ensureColumn(db, "session_meta", "last_nudge_undropped", "INTEGER DEFAULT 0");
      ensureColumn(db, "session_meta", "channel2_nudge_state", "TEXT DEFAULT ''");
      const columns = new Set(db.prepare("PRAGMA table_info(session_meta)").all().map((column) => column.name));
      if (columns.has("sticky_turn_reminder_text")) {
        db.prepare(`UPDATE session_meta SET
                        sticky_turn_reminder_text = '',
                        sticky_turn_reminder_message_id = '',
                        nudge_anchor_message_id = '',
                        nudge_anchor_text = ''`).run();
      }
    }
  },
  {
    version: 32,
    description: "Protected tail boundary state, usage resolver fields, recovery escape, and drain quota",
    up: (db) => {
      const hasSessionMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1").get();
      if (!hasSessionMeta)
        return;
      ensureColumn(db, "session_meta", "prior_boundary_ordinal", "INTEGER NOT NULL DEFAULT 1");
      ensureColumn(db, "session_meta", "protected_tail_policy_version", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "session_meta", "protected_tail_drain_window_started_at", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "session_meta", "protected_tail_drain_tokens", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "session_meta", "recovery_no_eligible_head_count", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "session_meta", "force_emergency_bypass_window_start", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "session_meta", "force_emergency_bypass_used", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "session_meta", "last_usage_context_limit", "INTEGER NOT NULL DEFAULT 0");
      db.prepare("UPDATE session_meta SET prior_boundary_ordinal = 1 WHERE prior_boundary_ordinal IS NULL OR prior_boundary_ordinal < 1").run();
      db.prepare("UPDATE session_meta SET protected_tail_policy_version = 0 WHERE protected_tail_policy_version IS NULL").run();
      db.prepare("UPDATE session_meta SET protected_tail_drain_window_started_at = 0 WHERE protected_tail_drain_window_started_at IS NULL").run();
      db.prepare("UPDATE session_meta SET protected_tail_drain_tokens = 0 WHERE protected_tail_drain_tokens IS NULL").run();
      db.prepare("UPDATE session_meta SET recovery_no_eligible_head_count = 0 WHERE recovery_no_eligible_head_count IS NULL").run();
      db.prepare("UPDATE session_meta SET force_emergency_bypass_window_start = 0 WHERE force_emergency_bypass_window_start IS NULL").run();
      db.prepare("UPDATE session_meta SET force_emergency_bypass_used = 0 WHERE force_emergency_bypass_used IS NULL").run();
      db.prepare("UPDATE session_meta SET last_usage_context_limit = 0 WHERE last_usage_context_limit IS NULL").run();
    }
  },
  {
    version: 33,
    description: "Compartment chunk embeddings for semantic message-history search",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS compartment_chunk_embeddings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    project_path TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    window_index INTEGER NOT NULL DEFAULT 0,
                    start_ordinal INTEGER NOT NULL,
                    end_ordinal INTEGER NOT NULL,
                    chunk_hash TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    dims INTEGER NOT NULL,
                    vector BLOB NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(compartment_id, window_index)
                );
                CREATE INDEX IF NOT EXISTS idx_cce_session
                    ON compartment_chunk_embeddings(session_id);
                CREATE INDEX IF NOT EXISTS idx_cce_project_model
                    ON compartment_chunk_embeddings(project_path, model_id);
            `);
    }
  },
  {
    version: 34,
    description: "workspace tables and m[0] workspace fingerprint cache reset",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS workspaces (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workspace_members (
                    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    project_path TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    display_path TEXT NOT NULL,
                    added_at INTEGER NOT NULL,
                    PRIMARY KEY (workspace_id, project_path)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_unique
                    ON workspace_members(project_path);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_name
                    ON workspace_members(workspace_id, display_name);
            `);
      const hasSessionMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1").get();
      if (!hasSessionMeta)
        return;
      ensureColumn(db, "session_meta", "cached_m0_workspace_fingerprint", "TEXT");
      const columns = new Set(db.prepare("PRAGMA table_info(session_meta)").all().map((column) => column.name));
      const clears = [
        ["cached_m0_bytes", null],
        ["cached_m1_bytes", null],
        ["cached_m0_project_memory_epoch", null],
        ["cached_m0_workspace_fingerprint", null],
        ["cached_m0_project_user_profile_version", null],
        ["cached_m0_max_compartment_seq", null],
        ["cached_m0_max_memory_id", null],
        ["cached_m0_max_mutation_id", null],
        ["cached_m0_max_memory_mutation_id", null],
        ["cached_m0_project_docs_hash", null],
        ["cached_m0_materialized_at", null],
        ["cached_m0_session_facts_version", null],
        ["cached_m0_upgrade_state", null],
        ["cached_m0_system_hash", null],
        ["cached_m0_tool_set_hash", null],
        ["cached_m0_model_key", null],
        ["cached_m0_last_baseline_end_message_id", null],
        ["memory_block_cache", ""],
        ["memory_block_ids", ""],
        ["memory_block_count", 0]
      ];
      const setClauses = [];
      const values = [];
      for (const [column, value] of clears) {
        if (!columns.has(column))
          continue;
        setClauses.push(`${column} = ?`);
        values.push(value);
      }
      if (setClauses.length > 0) {
        db.prepare(`UPDATE session_meta SET ${setClauses.join(", ")}`).run(...values);
      }
    }
  },
  {
    version: 35,
    description: "workspace per-category share defaults and epoch refresh",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS workspaces (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'
                );
            `);
      ensureColumn(db, "workspaces", "share_categories", `TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'`);
      db.prepare(`UPDATE workspaces
                    SET share_categories = '["CONSTRAINTS"]'
                  WHERE share_categories IS NULL OR share_categories = ''`).run();
      if (!tableExists4(db, "workspace_members"))
        return;
      const rows = db.prepare(`SELECT DISTINCT project_path AS identity
                       FROM workspace_members
                      WHERE project_path IS NOT NULL AND project_path <> ''
                      ORDER BY project_path ASC`).all();
      const identities = rows.map((row) => typeof row.identity === "string" ? row.identity : "").filter((identity) => identity.length > 0);
      if (identities.length > 0) {
        bumpEpochsForWorkspaceMemberSet(db, identities, Date.now());
      }
    }
  },
  {
    version: 36,
    description: "session project ownership map for compartment chunk backfill scoping",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS session_projects (
                    session_id TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    project_path TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(session_id, harness)
                );
                CREATE INDEX IF NOT EXISTS idx_session_projects_project
                    ON session_projects(project_path);
            `);
      const hasChunkTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='compartment_chunk_embeddings'").get();
      if (hasChunkTable) {
        db.exec(`
                    INSERT OR IGNORE INTO session_projects (session_id, harness, project_path, updated_at)
                    SELECT session_id, harness, MIN(project_path), 0
                    FROM compartment_chunk_embeddings
                    GROUP BY session_id, harness
                    HAVING COUNT(DISTINCT project_path) = 1;
                `);
      }
    }
  },
  {
    version: 37,
    description: "emergency drain catch-up latch + historian drain failure backoff",
    up: (db) => {
      const hasSessionMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta'").get();
      if (!hasSessionMeta)
        return;
      ensureColumn(db, "session_meta", "emergency_drain_active", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "session_meta", "historian_drain_failure_at", "INTEGER NOT NULL DEFAULT 0");
    }
  },
  {
    version: 38,
    description: "durable transform decisions for cache-event cause attribution",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS transform_decisions (
                    session_id         TEXT    NOT NULL,
                    harness            TEXT    NOT NULL DEFAULT 'opencode',
                    message_id         TEXT    NOT NULL,
                    ts_ms              INTEGER NOT NULL,
                    decision           TEXT    NOT NULL,
                    materialized       INTEGER NOT NULL DEFAULT 0,
                    materialize_reason TEXT,
                    emergency          INTEGER NOT NULL DEFAULT 0,
                    dropped_tokens     INTEGER NOT NULL DEFAULT 0,
                    dropped_count      INTEGER NOT NULL DEFAULT 0,
                    input_tokens       INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (session_id, harness, message_id)
                );
                CREATE INDEX IF NOT EXISTS idx_transform_decisions_session_harness
                    ON transform_decisions(session_id, harness);
            `);
    }
  },
  {
    version: 39,
    description: "persist compaction marker target end message id",
    up: (db) => {
      const hasSessionMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta'").get();
      if (!hasSessionMeta)
        return;
      ensureColumn(db, "session_meta", "compaction_marker_state", "TEXT DEFAULT ''");
      ensureColumn(db, "session_meta", "compaction_marker_target_end_message_id", "TEXT");
      db.exec(`
                UPDATE session_meta
                SET compaction_marker_target_end_message_id = json_extract(compaction_marker_state, '$.targetEndMessageId')
                WHERE compaction_marker_target_end_message_id IS NULL
                  AND COALESCE(compaction_marker_state, '') != ''
                  AND json_valid(compaction_marker_state)
                  AND typeof(json_extract(compaction_marker_state, '$.targetEndMessageId')) = 'text'
            `);
    }
  },
  {
    version: 40,
    description: "index Pi fallback tool owners for stable-id cutover",
    up: (db) => {
      if (!tableExists4(db, "tags"))
        return;
      db.exec(`
                CREATE INDEX IF NOT EXISTS idx_tags_pi_fallback_tool_owner
                ON tags(session_id, tool_owner_message_id)
                WHERE type='tool';
            `);
    }
  },
  {
    version: 41,
    description: "key detected context limits by model",
    up: (db) => {
      if (!tableExists4(db, "session_meta"))
        return;
      ensureColumn(db, "session_meta", "detected_context_limit_model_key", "TEXT");
    }
  },
  {
    version: 42,
    description: "per-task dreamer scheduling state (Dreamer v2 A+B)",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS task_schedule_state (
                    project_path  TEXT    NOT NULL,
                    task          TEXT    NOT NULL,
                    last_run_at   INTEGER,
                    next_due_at   INTEGER,
                    schedule      TEXT,
                    last_status   TEXT,
                    last_error    TEXT,
                    retry_count   INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (project_path, task)
                );
                CREATE INDEX IF NOT EXISTS idx_task_schedule_due
                    ON task_schedule_state(next_due_at);
            `);
    }
  },
  {
    version: 43,
    description: "memory verification side table and verify watermarks",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS memory_verifications (
                    memory_id    INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                    file_path    TEXT NOT NULL,
                    verified_at  INTEGER NOT NULL,
                    PRIMARY KEY (memory_id, file_path)
                );
                CREATE INDEX IF NOT EXISTS idx_memory_verifications_memory
                    ON memory_verifications(memory_id);
            `);
      if (tableExists4(db, "task_schedule_state")) {
        ensureColumn(db, "task_schedule_state", "last_checked_commit", "TEXT");
        ensureColumn(db, "task_schedule_state", "last_broad_run_at", "INTEGER");
      }
    }
  },
  {
    version: 44,
    description: "memory classification scope and shareability columns",
    up: (db) => {
      if (!tableExists4(db, "memories"))
        return;
      ensureColumn(db, "memories", "scope", "TEXT NOT NULL DEFAULT 'project'");
      ensureColumn(db, "memories", "shareable", "INTEGER NOT NULL DEFAULT 0");
    }
  },
  {
    version: 45,
    description: "retrospective content watermark and processed-window idempotence",
    up: (db) => {
      if (tableExists4(db, "task_schedule_state")) {
        ensureColumn(db, "task_schedule_state", "retrospective_watermark_ms", "INTEGER");
      }
      db.exec(`
                CREATE TABLE IF NOT EXISTS retrospective_processed_windows (
                    project_path TEXT NOT NULL,
                    window_key   TEXT NOT NULL,
                    processed_at INTEGER NOT NULL,
                    PRIMARY KEY (project_path, window_key)
                );
            `);
    }
  },
  {
    version: 46,
    description: "Primers v1 candidate and promoted primer storage",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS primer_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    session_id TEXT NOT NULL,
                    question TEXT NOT NULL,
                    normalized_question TEXT NOT NULL,
                    source_compartment_start INTEGER,
                    source_compartment_end INTEGER,
                    source_start_message_id TEXT NOT NULL DEFAULT '',
                    source_end_message_id TEXT NOT NULL DEFAULT '',
                    source_message_time INTEGER NOT NULL,
                    question_embedding BLOB,
                    question_embedding_model_id TEXT,
                    created_at INTEGER NOT NULL,
                    UNIQUE(project_path, harness, session_id, source_start_message_id, source_end_message_id)
                );
                CREATE INDEX IF NOT EXISTS idx_primer_candidates_project_time
                    ON primer_candidates(project_path, source_message_time);
                CREATE INDEX IF NOT EXISTS idx_primer_candidates_session
                    ON primer_candidates(session_id, harness);
                CREATE INDEX IF NOT EXISTS idx_primer_candidates_embedding_model
                    ON primer_candidates(project_path, question_embedding_model_id);

                CREATE TABLE IF NOT EXISTS primers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    question TEXT NOT NULL,
                    question_embedding BLOB,
                    question_embedding_model_id TEXT,
                    answer TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
                    total_support INTEGER NOT NULL DEFAULT 0,
                    last_observed_at INTEGER,
                    answer_refreshed_at INTEGER,
                    source_candidate_ids TEXT NOT NULL DEFAULT '[]',
                    source_candidate_provenance TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_primers_project_status_observed
                    ON primers(project_path, status, last_observed_at DESC);
                CREATE INDEX IF NOT EXISTS idx_primers_embedding_model
                    ON primers(project_path, question_embedding_model_id);

                CREATE VIRTUAL TABLE IF NOT EXISTS primers_fts USING fts5(
                    question,
                    answer,
                    project_path UNINDEXED,
                    content='primers',
                    content_rowid='id',
                    tokenize='porter unicode61'
                );
                CREATE TRIGGER IF NOT EXISTS primers_ai AFTER INSERT ON primers BEGIN
                    INSERT INTO primers_fts(rowid, question, answer, project_path)
                    VALUES (new.id, new.question, new.answer, new.project_path);
                END;
                CREATE TRIGGER IF NOT EXISTS primers_ad AFTER DELETE ON primers BEGIN
                    INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
                    VALUES ('delete', old.id, old.question, old.answer, old.project_path);
                END;
                CREATE TRIGGER IF NOT EXISTS primers_au AFTER UPDATE ON primers BEGIN
                    INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
                    VALUES ('delete', old.id, old.question, old.answer, old.project_path);
                    INSERT INTO primers_fts(rowid, question, answer, project_path)
                    VALUES (new.id, new.question, new.answer, new.project_path);
                END;
            `);
    }
  },
  {
    version: 47,
    description: "compiled smart-note checks and runtime policy state",
    up: (db) => {
      if (!tableExists4(db, "notes"))
        return;
      ensureColumn(db, "notes", "compiled_check", "TEXT");
      ensureColumn(db, "notes", "manifest_json", "TEXT");
      ensureColumn(db, "notes", "check_hash", "TEXT");
      ensureColumn(db, "notes", "check_cron", "TEXT");
      ensureColumn(db, "notes", "check_version", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "notes", "check_status", "TEXT NOT NULL DEFAULT 'uncompiled'");
      ensureColumn(db, "notes", "check_failure_count", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "notes", "check_network_failure_count", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "notes", "check_quarantined_until", "INTEGER");
      ensureColumn(db, "notes", "check_next_due_at", "INTEGER");
      ensureColumn(db, "notes", "check_compiled_at", "INTEGER");
      ensureColumn(db, "notes", "check_false_since_at", "INTEGER");
      ensureColumn(db, "notes", "check_last_liveness_at", "INTEGER");
      ensureColumn(db, "notes", "policy_version", "INTEGER NOT NULL DEFAULT 1");
      db.exec(`
                CREATE INDEX IF NOT EXISTS idx_notes_smart_checks_due
                    ON notes(project_path, check_status, check_next_due_at)
                    WHERE type = 'smart' AND status = 'pending';
                CREATE INDEX IF NOT EXISTS idx_notes_smart_checks_liveness
                    ON notes(project_path, check_false_since_at, check_last_liveness_at)
                    WHERE type = 'smart' AND status = 'pending';
            `);
    }
  },
  {
    version: 48,
    description: "DreamerV2 rework: memory→file mapping vs verification split, classify marker",
    up: (db) => {
      if (tableExists4(db, "memory_verifications")) {
        ensureColumn(db, "memory_verifications", "mapped_at", "INTEGER NOT NULL DEFAULT 0");
      }
      if (tableExists4(db, "memories")) {
        ensureColumn(db, "memories", "classified_at", "INTEGER");
      }
    }
  },
  {
    version: 49,
    description: "per-model embedding coexistence and active identity tracking",
    up: (db) => {
      if (tableExists4(db, "memory_embeddings")) {
        db.exec(`
                    UPDATE memory_embeddings
                    SET model_id = 'legacy:unknown'
                    WHERE model_id IS NULL;
                `);
        if (tableExists4(db, "memories")) {
          db.exec(`
                        DELETE FROM memory_embeddings
                        WHERE memory_id NOT IN (SELECT id FROM memories);
                    `);
        }
        db.exec(`
                    DROP TABLE IF EXISTS memory_embeddings_v49_new;
                    CREATE TABLE memory_embeddings_v49_new (
                        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                        embedding BLOB NOT NULL,
                        model_id TEXT NOT NULL,
                        PRIMARY KEY(memory_id, model_id)
                    );
                    INSERT INTO memory_embeddings_v49_new (memory_id, embedding, model_id)
                    SELECT memory_id, embedding, model_id
                    FROM memory_embeddings;
                    DROP TABLE memory_embeddings;
                    ALTER TABLE memory_embeddings_v49_new RENAME TO memory_embeddings;
                `);
        assertForeignKeyIntegrity(db, "memory_embeddings");
      }
      if (tableExists4(db, "git_commit_embeddings")) {
        if (tableExists4(db, "git_commits")) {
          db.exec(`
                        DELETE FROM git_commit_embeddings
                        WHERE sha NOT IN (SELECT sha FROM git_commits);
                    `);
        }
        db.exec(`
                    DROP TABLE IF EXISTS git_commit_embeddings_v49_new;
                    CREATE TABLE git_commit_embeddings_v49_new (
                        sha TEXT NOT NULL,
                        embedding BLOB NOT NULL,
                        model_id TEXT NOT NULL,
                        created_at INTEGER NOT NULL,
                        PRIMARY KEY(sha, model_id),
                        FOREIGN KEY(sha) REFERENCES git_commits(sha) ON DELETE CASCADE
                    );
                    INSERT INTO git_commit_embeddings_v49_new (sha, embedding, model_id, created_at)
                    SELECT sha, embedding, model_id, created_at
                    FROM git_commit_embeddings;
                    DROP TABLE git_commit_embeddings;
                    ALTER TABLE git_commit_embeddings_v49_new RENAME TO git_commit_embeddings;
                `);
        assertForeignKeyIntegrity(db, "git_commit_embeddings");
      }
      if (tableExists4(db, "compartment_chunk_embeddings")) {
        if (tableExists4(db, "compartments")) {
          db.exec(`
                        DELETE FROM compartment_chunk_embeddings
                        WHERE compartment_id NOT IN (SELECT id FROM compartments);
                    `);
        }
        db.exec(`
                    DROP INDEX IF EXISTS idx_cce_session;
                    DROP INDEX IF EXISTS idx_cce_project_model;
                    DROP TABLE IF EXISTS compartment_chunk_embeddings_v49_new;
                    CREATE TABLE compartment_chunk_embeddings_v49_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
                        session_id TEXT NOT NULL,
                        project_path TEXT NOT NULL,
                        harness TEXT NOT NULL DEFAULT 'opencode',
                        window_index INTEGER NOT NULL DEFAULT 0,
                        start_ordinal INTEGER NOT NULL,
                        end_ordinal INTEGER NOT NULL,
                        chunk_hash TEXT NOT NULL,
                        model_id TEXT NOT NULL,
                        dims INTEGER NOT NULL,
                        vector BLOB NOT NULL,
                        created_at INTEGER NOT NULL,
                        UNIQUE(compartment_id, model_id, window_index)
                    );
                    INSERT INTO compartment_chunk_embeddings_v49_new (
                        id, compartment_id, session_id, project_path, harness, window_index,
                        start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
                    )
                    SELECT id, compartment_id, session_id, project_path, harness, window_index,
                           start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
                    FROM compartment_chunk_embeddings;
                    DROP TABLE compartment_chunk_embeddings;
                    ALTER TABLE compartment_chunk_embeddings_v49_new RENAME TO compartment_chunk_embeddings;
                    CREATE INDEX IF NOT EXISTS idx_cce_session ON compartment_chunk_embeddings(session_id);
                    CREATE INDEX IF NOT EXISTS idx_cce_project_model ON compartment_chunk_embeddings(project_path, model_id);
                `);
        assertForeignKeyIntegrity(db, "compartment_chunk_embeddings");
      }
      db.exec(`
                CREATE TABLE IF NOT EXISTS embedding_identity_active (
                    project_path TEXT NOT NULL,
                    scope TEXT NOT NULL CHECK(scope IN ('memory', 'commit', 'chunk')),
                    model_id TEXT NOT NULL,
                    last_active_at INTEGER NOT NULL,
                    PRIMARY KEY(project_path, scope, model_id)
                );
            `);
    }
  },
  {
    version: 50,
    description: "add durable ctx-wrapup session marker",
    up(db) {
      if (tableExists4(db, "session_meta")) {
        ensureColumn(db, "session_meta", "wrapup_in_progress_state", "TEXT");
      }
    }
  },
  {
    version: 51,
    description: "version tool-owner backfill state and repair legacy NULL session metadata",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS tool_owner_backfill_state (
                    session_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'skipped')),
                    started_at INTEGER,
                    lease_expires_at INTEGER,
                    completed_at INTEGER,
                    last_error TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_tool_owner_backfill_state_status
                    ON tool_owner_backfill_state(status);
            `);
      healAllNullColumns(db);
    }
  },
  {
    version: 52,
    description: "persist emergency recovery origin",
    up(db) {
      if (tableExists4(db, "session_meta")) {
        ensureColumn(db, "session_meta", "emergency_recovery_origin", "TEXT DEFAULT ''");
      }
    }
  },
  {
    version: 53,
    description: "add Synapse batch, shadow, and measurement storage",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS embedding_registrations (
                    project_path TEXT PRIMARY KEY,
                    provider_identity TEXT NOT NULL DEFAULT '',
                    model_id TEXT NOT NULL DEFAULT '',
                    chunk_model_id TEXT NOT NULL DEFAULT '',
                    fingerprint TEXT NOT NULL DEFAULT '',
                    table_epoch INTEGER NOT NULL DEFAULT 0,
                    dims INTEGER NOT NULL DEFAULT 0,
                    provenance_json TEXT NOT NULL DEFAULT '{}',
                    generation INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS synapse_batch_ledger (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    project_path TEXT NOT NULL DEFAULT '',
                    scope TEXT NOT NULL DEFAULT '',
                    manifest_json TEXT NOT NULL DEFAULT '{}',
                    request_key TEXT NOT NULL DEFAULT '',
                    job_id TEXT,
                    cursor TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(session_id, request_key)
                );
                CREATE INDEX IF NOT EXISTS idx_synapse_batch_ledger_session
                    ON synapse_batch_ledger(session_id, updated_at);
                CREATE TABLE IF NOT EXISTS shadow_embedding_registrations (
                    project_path TEXT NOT NULL,
                    scope TEXT NOT NULL CHECK(scope IN ('memory', 'commit', 'chunk')),
                    model_id TEXT NOT NULL,
                    generation INTEGER NOT NULL DEFAULT 0,
                    fingerprint TEXT NOT NULL DEFAULT '',
                    table_epoch INTEGER NOT NULL DEFAULT 0,
                    dims INTEGER NOT NULL DEFAULT 0,
                    provenance_json TEXT NOT NULL DEFAULT '{}',
                    updated_at INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(project_path, scope, model_id)
                );
                CREATE TABLE IF NOT EXISTS embedding_measurement_corpus (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    project_path TEXT NOT NULL DEFAULT '',
                    dedup_key TEXT NOT NULL DEFAULT '',
                    cohort_key TEXT NOT NULL DEFAULT '',
                    query_text_hash TEXT NOT NULL DEFAULT '',
                    primary_result_ids_json TEXT NOT NULL DEFAULT '[]',
                    shadow_result_ids_json TEXT NOT NULL DEFAULT '[]',
                    primary_latency_ms INTEGER,
                    shadow_latency_ms INTEGER,
                    primary_failed INTEGER NOT NULL DEFAULT 0,
                    shadow_failed INTEGER NOT NULL DEFAULT 0,
                    primary_model_id TEXT NOT NULL DEFAULT '',
                    shadow_model_id TEXT NOT NULL DEFAULT '',
                    primary_fingerprint TEXT NOT NULL DEFAULT '',
                    shadow_fingerprint TEXT NOT NULL DEFAULT '',
                    primary_epoch INTEGER NOT NULL DEFAULT 0,
                    shadow_epoch INTEGER NOT NULL DEFAULT 0,
                    corpus_hash TEXT NOT NULL DEFAULT '',
                    coverage_json TEXT NOT NULL DEFAULT '{}',
                    created_at INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(dedup_key, cohort_key)
                );
                CREATE INDEX IF NOT EXISTS idx_embedding_measurement_session
                    ON embedding_measurement_corpus(session_id, created_at);
            `);
    }
  },
  {
    version: 54,
    description: "add authority identity, managed-write guards, and mirror cursors",
    up(db) {
      const memoriesPresent = tableExists4(db, "memories");
      const notesPresent = tableExists4(db, "notes");
      db.exec(`
                CREATE TABLE IF NOT EXISTS context_store_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS authority_managed (
                    project_path TEXT PRIMARY KEY,
                    context_store_uuid TEXT NOT NULL,
                    marked_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS authority_repair_pending (
                    project_path TEXT PRIMARY KEY,
                    started_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS mirror_identity (
                    domain TEXT NOT NULL CHECK(domain IN ('memories', 'notes')),
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    context_row_id INTEGER NOT NULL,
                    PRIMARY KEY(domain, module_project, module_row_id),
                    UNIQUE(domain, context_row_id)
                );
                CREATE TABLE IF NOT EXISTS mirror_cursors (
                    domain TEXT PRIMARY KEY CHECK(domain IN ('memories', 'notes')),
                    cursor INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS context_privilege_state (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1))
                );
            `);
      if (memoriesPresent) {
        db.exec(`
                DROP TRIGGER IF EXISTS memories_authority_guard_insert;
                DROP TRIGGER IF EXISTS memories_authority_guard_update;
                DROP TRIGGER IF EXISTS memories_authority_guard_delete;
                CREATE TRIGGER memories_authority_guard_insert
                BEFORE INSERT ON memories
                 WHEN (
                     EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path)
                 ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module');
                END;
                CREATE TRIGGER memories_authority_guard_update
                BEFORE UPDATE ON memories
                 WHEN (
                     EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                     OR EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
                     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path)
                 ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module');
                END;
                CREATE TRIGGER memories_authority_guard_delete
                BEFORE DELETE ON memories
                 WHEN (
                     EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
                 ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module');
                END;
                `);
      }
      if (notesPresent) {
        db.exec(`
                DROP TRIGGER IF EXISTS notes_authority_guard_insert;
                DROP TRIGGER IF EXISTS notes_authority_guard_update;
                DROP TRIGGER IF EXISTS notes_authority_guard_delete;
                CREATE TRIGGER notes_authority_guard_insert
                BEFORE INSERT ON notes
                 WHEN NEW.type = 'smart' AND NEW.project_path IS NOT NULL
                   AND (
                       EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path)
                   ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module');
                END;
                CREATE TRIGGER notes_authority_guard_update
                BEFORE UPDATE ON notes
                WHEN (
                     (OLD.type = 'smart' AND OLD.project_path IS NOT NULL
                      AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)))
                     OR
                     (NEW.type = 'smart' AND NEW.project_path IS NOT NULL
                      AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path)))
                ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module');
                END;
                CREATE TRIGGER notes_authority_guard_delete
                BEFORE DELETE ON notes
                 WHEN OLD.type = 'smart' AND OLD.project_path IS NOT NULL
                   AND (
                       EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
                   ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module');
                END;
                `);
      }
    }
  },
  {
    version: 55,
    description: "make managed-write privilege connection-local",
    up(db) {
      const memoriesPresent = tableExists4(db, "memories");
      const notesPresent = tableExists4(db, "notes");
      const native = db;
      const privilegeCheck = typeof native.function === "function" || typeof native.createFunction === "function" ? "mc_privileged_writer() = 0" : "COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0";
      if (memoriesPresent) {
        db.exec(`
                    DROP TRIGGER IF EXISTS memories_authority_guard_insert;
                    DROP TRIGGER IF EXISTS memories_authority_guard_update;
                    DROP TRIGGER IF EXISTS memories_authority_guard_delete;
                    CREATE TRIGGER memories_authority_guard_insert
                    BEFORE INSERT ON memories
                    WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
                    CREATE TRIGGER memories_authority_guard_update
                    BEFORE UPDATE ON memories
                    WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
                    CREATE TRIGGER memories_authority_guard_delete
                    BEFORE DELETE ON memories
                    WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
                `);
      }
      if (notesPresent) {
        db.exec(`
                    DROP TRIGGER IF EXISTS notes_authority_guard_insert;
                    DROP TRIGGER IF EXISTS notes_authority_guard_update;
                    DROP TRIGGER IF EXISTS notes_authority_guard_delete;
                    CREATE TRIGGER notes_authority_guard_insert
                    BEFORE INSERT ON notes
                    WHEN NEW.type = 'smart' AND NEW.project_path IS NOT NULL
                      AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                        OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module'); END;
                    CREATE TRIGGER notes_authority_guard_update
                    BEFORE UPDATE ON notes
                    WHEN ((OLD.type = 'smart' AND OLD.project_path IS NOT NULL
                            AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                              OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)))
                       OR (NEW.type = 'smart' AND NEW.project_path IS NOT NULL
                            AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                              OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module'); END;
                    CREATE TRIGGER notes_authority_guard_delete
                    BEFORE DELETE ON notes
                    WHEN OLD.type = 'smart' AND OLD.project_path IS NOT NULL
                      AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                        OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module'); END;
                `);
      }
    }
  },
  {
    version: 56,
    description: "record authority capture bounds and pending mirror references",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS authority_capture_bounds (
                    project_path TEXT NOT NULL,
                    domain TEXT NOT NULL CHECK(domain IN ('memories', 'notes')),
                    max_rowid INTEGER NOT NULL,
                    data_version INTEGER NOT NULL,
                    captured_at INTEGER NOT NULL,
                    PRIMARY KEY(project_path, domain)
                );
                CREATE TABLE IF NOT EXISTS mirror_pending_references (
                    domain TEXT NOT NULL CHECK(domain = 'memories'),
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    target_module_row_id INTEGER NOT NULL,
                    PRIMARY KEY(domain, module_project, module_row_id)
                );
                CREATE INDEX IF NOT EXISTS idx_mirror_pending_reference_target
                    ON mirror_pending_references(domain, module_project, target_module_row_id);
                CREATE TABLE IF NOT EXISTS mirror_note_revisions (
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    context_row_id INTEGER NOT NULL,
                    status_version INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(module_project, module_row_id),
                    UNIQUE(context_row_id)
                );
            `);
      installLatestAuthorityTriggers(db);
    }
  },
  {
    version: 57,
    description: "domain mutation epoch for authority capture bounds",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS domain_mutation_epoch (
                    project_path TEXT NOT NULL,
                    domain TEXT NOT NULL CHECK(domain IN ('memories', 'notes')),
                    epoch INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(project_path, domain)
                );
            `);
      if (tableExists4(db, "authority_capture_bounds")) {
        ensureColumn(db, "authority_capture_bounds", "mutation_epoch", "INTEGER NOT NULL DEFAULT 0");
      }
    }
  },
  {
    version: 58,
    description: "track live module memory identities during mirror replay",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS mirror_live_memory_rows (
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    category TEXT NOT NULL,
                    normalized_hash TEXT NOT NULL,
                    PRIMARY KEY(module_project, module_row_id)
                );
                CREATE INDEX IF NOT EXISTS idx_mirror_live_memory_content
                    ON mirror_live_memory_rows(module_project, category, normalized_hash);
                CREATE TABLE IF NOT EXISTS mirror_resnapshot_state (
                    domain TEXT PRIMARY KEY CHECK(domain = 'memories'),
                    status TEXT NOT NULL CHECK(status IN ('pending_check', 'resnapshotting', 'complete')),
                    updated_at INTEGER NOT NULL
                );
                INSERT OR IGNORE INTO mirror_resnapshot_state(domain, status, updated_at)
                VALUES ('memories', 'pending_check', 0);
            `);
    }
  },
  {
    version: 59,
    description: "stage paged live memory resnapshots before atomic replacement",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS mirror_live_staging (
                    generation TEXT NOT NULL,
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    category TEXT NOT NULL,
                    normalized_hash TEXT NOT NULL,
                    PRIMARY KEY(generation, module_project, module_row_id)
                );
                CREATE INDEX IF NOT EXISTS idx_mirror_live_staging_generation
                    ON mirror_live_staging(generation);
            `);
    }
  },
  {
    version: 60,
    description: "persist the owning live memory resnapshot generation",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS mirror_resnapshot_state (
                    domain TEXT PRIMARY KEY CHECK(domain = 'memories'),
                    status TEXT NOT NULL CHECK(status IN ('pending_check', 'resnapshotting', 'complete')),
                    updated_at INTEGER NOT NULL
                );
            `);
      db.exec("INSERT OR IGNORE INTO mirror_resnapshot_state(domain, status, updated_at) VALUES ('memories', 'pending_check', 0)");
      ensureColumn(db, "mirror_resnapshot_state", "generation", "TEXT");
    }
  },
  {
    version: 61,
    description: "retain complete memory snapshots for mirror healing",
    up(db) {
      ensureColumn(db, "mirror_live_memory_rows", "full_row_snapshot", "TEXT");
      ensureColumn(db, "mirror_live_staging", "full_row_snapshot", "TEXT");
      db.prepare(`UPDATE mirror_resnapshot_state
                    SET status = 'pending_check', generation = NULL, updated_at = ?
                  WHERE domain = 'memories'
                    AND status = 'complete'
                    AND NOT EXISTS (
                        SELECT 1 FROM schema_migrations WHERE version = 61
                    )`).run(Date.now());
    }
  },
  {
    version: 62,
    description: "durable row-level project identity merge audit log",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS identity_merge_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_identity TEXT NOT NULL,
                    to_identity TEXT NOT NULL,
                    table_name TEXT NOT NULL,
                    row_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    target_row_id TEXT,
                    merged_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_identity_merge_log_identities
                    ON identity_merge_log(from_identity, to_identity, merged_at);
                CREATE INDEX IF NOT EXISTS idx_identity_merge_log_table_row
                    ON identity_merge_log(table_name, row_id);
            `);
    }
  },
  {
    version: 63,
    description: "Add anchor_block_id to notes (module note mirror writes it)",
    up(db) {
      if (!tableExists4(db, "notes"))
        return;
      const columns = db.prepare("PRAGMA table_info(notes)").all();
      if (!columns.some((column) => column.name === "anchor_block_id")) {
        db.exec("ALTER TABLE notes ADD COLUMN anchor_block_id TEXT");
      }
    }
  },
  {
    version: 64,
    description: "store project-scoped rendered memory mural",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS mural_manifest (
                    project_path TEXT PRIMARY KEY,
                    image BLOB NOT NULL,
                    content_hash TEXT NOT NULL,
                    rendered_at INTEGER NOT NULL,
                    model TEXT,
                    memory_ids_json TEXT NOT NULL DEFAULT '[]',
                    width INTEGER NOT NULL DEFAULT 1092,
                    height INTEGER NOT NULL DEFAULT 1092
                );
            `);
      ensureColumn(db, "mural_manifest", "model", "TEXT");
      ensureColumn(db, "mural_manifest", "memory_ids_json", "TEXT NOT NULL DEFAULT '[]'");
      ensureColumn(db, "mural_manifest", "width", "INTEGER NOT NULL DEFAULT 1092");
      ensureColumn(db, "mural_manifest", "height", "INTEGER NOT NULL DEFAULT 1092");
    }
  },
  {
    version: 65,
    description: "Add per-memory mural cue columns for the deterministic cue-compression cutover",
    up(db) {
      if (!tableExists4(db, "memories"))
        return;
      ensureColumn(db, "memories", "mural_cue", "TEXT");
      ensureColumn(db, "memories", "mural_cue_hash", "TEXT");
      ensureColumn(db, "memories", "mural_cue_at", "INTEGER");
    }
  },
  {
    version: 66,
    description: "bound per-session historian upgrade reminders",
    up(db) {
      if (!tableExists4(db, "session_meta"))
        return;
      ensureColumn(db, "session_meta", "upgrade_reminder_last_sent_at", "INTEGER");
      ensureColumn(db, "session_meta", "upgrade_reminder_count", "INTEGER NOT NULL DEFAULT 0");
    }
  },
  {
    version: 67,
    description: "persist the frozen mural payload with each cached m0 baseline",
    up(db) {
      if (!tableExists4(db, "session_meta"))
        return;
      ensureColumn(db, "session_meta", "cached_m0_mural_data_url", "TEXT");
      ensureColumn(db, "session_meta", "cached_m0_mural_hash", "TEXT");
    }
  },
  {
    version: 68,
    description: "converge message FTS deletions and same-ID source revisions",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS message_history_source (
                    session_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    message_ordinal INTEGER NOT NULL,
                    source_version TEXT NOT NULL,
                    normalized_content_hash TEXT NOT NULL,
                    role TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(session_id, message_id)
                );
                CREATE INDEX IF NOT EXISTS idx_message_history_source_session_ordinal
                    ON message_history_source(session_id, message_ordinal);

                CREATE TABLE IF NOT EXISTS pending_session_cleanup (
                    session_id TEXT PRIMARY KEY,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    requested_at INTEGER NOT NULL,
                    last_attempt_at INTEGER
                );

                CREATE TABLE IF NOT EXISTS message_history_orphan_sweep (
                    harness TEXT PRIMARY KEY,
                    cursor_session_id TEXT NOT NULL DEFAULT '',
                    last_swept_at INTEGER
                );
            `);
      if (tableExists4(db, "message_history_index")) {
        const columns = new Set(db.prepare("PRAGMA table_info(message_history_index)").all().map((column) => column.name));
        if (columns.has("session_id") && columns.has("harness") && columns.has("updated_at")) {
          db.exec(`
                        CREATE INDEX IF NOT EXISTS idx_message_history_index_orphan_sweep
                            ON message_history_index(harness, session_id, updated_at);
                    `);
        }
      }
    }
  },
  {
    version: 69,
    description: "index visibility mutation discovery and target loading",
    up(db) {
      if (!tableExists4(db, "memory_mutation_log"))
        return;
      db.exec(`
                CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_visibility
                    ON memory_mutation_log(project_path, category, id, target_memory_id);
                CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_target
                    ON memory_mutation_log(project_path, target_memory_id, id);
            `);
    }
  },
  {
    version: 70,
    description: "heal legacy compartments stranded by mismatched tier closing tags (issue #246)",
    up(db) {
      healMismatchedTierClose(db, "compartments", true);
      healMismatchedTierClose(db, "recomp_compartments", false);
    }
  },
  {
    version: 71,
    description: "rebuild authority guard triggers to the durable state-table form (issue #253)",
    up(db) {
      installLatestAuthorityTriggers(db);
    }
  },
  {
    version: 72,
    description: "add per-session compaction mode record column (issue #266)",
    up(db) {
      if (tableExists4(db, "session_meta")) {
        ensureColumn(db, "session_meta", "compaction_mode_record", "TEXT");
      }
    }
  },
  {
    version: 73,
    description: "persist the last successful todowrite permission verdict",
    up(db) {
      if (tableExists4(db, "session_meta")) {
        ensureColumn(db, "session_meta", "todo_permission_denied", "INTEGER NOT NULL DEFAULT 2");
      }
    }
  },
  {
    version: 74,
    description: "persist detected context-limit provenance",
    up(db) {
      if (tableExists4(db, "session_meta")) {
        ensureColumn(db, "session_meta", "detected_context_limit_provenance", "TEXT NOT NULL DEFAULT 'unknown'");
      }
    }
  },
  {
    version: 75,
    description: "persist mural cue validation rejection latches",
    up(db) {
      if (!tableExists4(db, "memories"))
        return;
      ensureColumn(db, "memories", "mural_cue_rejection_count", "INTEGER NOT NULL DEFAULT 0");
    }
  },
  {
    version: 76,
    description: "persist retina provider compilation for smart-note conditions",
    up(db) {
      if (!tableExists4(db, "notes"))
        return;
      ensureColumn(db, "notes", "compiled_provider", "TEXT");
      ensureColumn(db, "notes", "compiled_config", "TEXT");
      ensureColumn(db, "notes", "compiled_at", "INTEGER");
      ensureColumn(db, "notes", "compile_status", "TEXT CHECK(compile_status IN ('compiled', 'plain', 'refused'))");
    }
  },
  {
    version: 77,
    description: "persist scoped provenance for promoted user memories and primers",
    up(db) {
      if (tableExists4(db, "user_memories")) {
        ensureColumn(db, "user_memories", "source_candidate_provenance", "TEXT");
      }
      if (tableExists4(db, "primers")) {
        ensureColumn(db, "primers", "source_candidate_provenance", "TEXT");
      }
    }
  },
  {
    version: 78,
    description: "add migration_pending journal for crash-safe cross-harness session migration",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS migration_pending (
                    migration_key TEXT PRIMARY KEY,
                    source_session_id TEXT NOT NULL,
                    target_harness TEXT NOT NULL,
                    pi_session_id TEXT NOT NULL,
                    final_path TEXT NOT NULL,
                    stage_path TEXT NOT NULL,
                    content_sha256 TEXT NOT NULL,
                    phase TEXT NOT NULL CHECK (phase IN ('staged', 'db_committed')),
                    created_at INTEGER NOT NULL
                );
            `);
    }
  },
  {
    version: 79,
    description: "record m[0] system-hash and model-key comparison telemetry",
    up(db) {
      if (!tableExists4(db, "transform_decisions"))
        return;
      ensureColumn(db, "transform_decisions", "system_hash_prev", "TEXT");
      ensureColumn(db, "transform_decisions", "system_hash_new", "TEXT");
      ensureColumn(db, "transform_decisions", "m0_model_key_prev", "TEXT");
      ensureColumn(db, "transform_decisions", "m0_model_key_new", "TEXT");
    }
  },
  {
    version: 80,
    description: "record observed m[0] tool-set hash comparisons",
    up(db) {
      if (!tableExists4(db, "transform_decisions"))
        return;
      ensureColumn(db, "transform_decisions", "m0_tool_set_hash_prev", "TEXT");
      ensureColumn(db, "transform_decisions", "m0_tool_set_hash_new", "TEXT");
    }
  },
  {
    version: 81,
    description: "persist last-known-good transform snapshots across restarts",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS lkg_slots (
                    session_id TEXT PRIMARY KEY,
                    json_prefix TEXT NOT NULL,
                    input_id_seq TEXT NOT NULL,
                    input_content_digests TEXT NOT NULL,
                    input_content_signatures TEXT,
                    last_input_message_id TEXT NOT NULL,
                    model_key TEXT,
                    provider_key TEXT,
                    captured_at INTEGER NOT NULL,
                    row_version INTEGER,
                    capture_sequence INTEGER
                );
            `);
    }
  },
  {
    version: 82,
    description: "record the origin of memory file-independent mappings",
    up(db) {
      if (!tableExists4(db, "memory_verifications"))
        return;
      ensureColumn(db, "memory_verifications", "mapping_origin", "TEXT NOT NULL DEFAULT 'mapper'");
    }
  },
  {
    version: 83,
    description: "add indexed rowid access for message FTS content",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS message_fts_rowid_map (
                    session_id TEXT NOT NULL,
                    message_ordinal INTEGER NOT NULL,
                    fts_rowid INTEGER NOT NULL,
                    PRIMARY KEY(session_id, message_ordinal)
                );

                CREATE TABLE IF NOT EXISTS message_fts_rowid_map_backfill_state (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    watermark_rowid INTEGER NOT NULL DEFAULT 0,
                    completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
                    updated_at INTEGER NOT NULL DEFAULT 0
                );
                INSERT OR IGNORE INTO message_fts_rowid_map_backfill_state
                    (id, watermark_rowid, completed, updated_at)
                VALUES (1, 0, 0, 0);
            `);
    }
  },
  {
    version: 84,
    description: "persist protected-token floor state per session",
    up(db) {
      if (!tableExists4(db, "session_meta"))
        return;
      ensureColumn(db, "session_meta", "protected_tokens_effective", "INTEGER");
      ensureColumn(db, "session_meta", "protected_tokens_pre_snapshot", "TEXT");
    }
  },
  {
    version: 85,
    description: "relabel OpenCode 1.x mis-tagged opencode2 session rows (inert; superseded by v87)",
    up() {}
  },
  {
    version: 86,
    description: "track tag identity changes per session",
    up(db) {
      if (!tableExists4(db, "session_meta") || !tableExists4(db, "tags"))
        return;
      ensureColumn(db, "session_meta", "tags_version", "INTEGER NOT NULL DEFAULT 0");
      db.exec(`
                CREATE TRIGGER IF NOT EXISTS tags_version_ai AFTER INSERT ON tags BEGIN
                    INSERT INTO session_meta(
                        session_id, harness, last_response_time, cache_ttl, counter, tags_version,
                        last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent,
                        last_context_percentage, last_input_tokens, observed_safe_input_tokens,
                        cache_alert_sent, times_execute_threshold_reached, compartment_in_progress,
                        system_prompt_hash, cleared_reasoning_through_tag
                    ) VALUES(NEW.session_id, NEW.harness, 0, '5m', 0, 1, 0, '', '', 0, 0, 0, 0, 0, 0, 0, '', 0)
                    ON CONFLICT(session_id) DO UPDATE SET tags_version = tags_version + 1;
                END;
                CREATE TRIGGER IF NOT EXISTS tags_version_ad AFTER DELETE ON tags BEGIN
                    INSERT INTO session_meta(
                        session_id, harness, last_response_time, cache_ttl, counter, tags_version,
                        last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent,
                        last_context_percentage, last_input_tokens, observed_safe_input_tokens,
                        cache_alert_sent, times_execute_threshold_reached, compartment_in_progress,
                        system_prompt_hash, cleared_reasoning_through_tag
                    ) VALUES(OLD.session_id, OLD.harness, 0, '5m', 0, 1, 0, '', '', 0, 0, 0, 0, 0, 0, 0, '', 0)
                    ON CONFLICT(session_id) DO UPDATE SET tags_version = tags_version + 1;
                END;
                CREATE TRIGGER IF NOT EXISTS tags_version_au
                AFTER UPDATE OF session_id, message_id, tag_number, type, tool_owner_message_id, status
                ON tags BEGIN
                    INSERT INTO session_meta(
                        session_id, harness, last_response_time, cache_ttl, counter, tags_version,
                        last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent,
                        last_context_percentage, last_input_tokens, observed_safe_input_tokens,
                        cache_alert_sent, times_execute_threshold_reached, compartment_in_progress,
                        system_prompt_hash, cleared_reasoning_through_tag
                    ) VALUES(OLD.session_id, OLD.harness, 0, '5m', 0, 1, 0, '', '', 0, 0, 0, 0, 0, 0, 0, '', 0)
                    ON CONFLICT(session_id) DO UPDATE SET tags_version = tags_version + 1;
                    INSERT INTO session_meta(
                        session_id, harness, last_response_time, cache_ttl, counter, tags_version,
                        last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent,
                        last_context_percentage, last_input_tokens, observed_safe_input_tokens,
                        cache_alert_sent, times_execute_threshold_reached, compartment_in_progress,
                        system_prompt_hash, cleared_reasoning_through_tag
                    )
                    SELECT NEW.session_id, NEW.harness, 0, '5m', 0, 1, 0, '', '', 0, 0, 0, 0, 0, 0, 0, '', 0
                    WHERE NEW.session_id != OLD.session_id
                    ON CONFLICT(session_id) DO UPDATE SET tags_version = tags_version + 1;
                END;
            `);
    }
  },
  {
    version: 87,
    description: "repair OpenCode harness labels from host-store evidence",
    up(db) {
      repairOpenCode2HarnessLabels(db, {
        tables: [...V85_OPENCODE2_RELABEL_TABLES, ...V85_OPTIONAL_OPENCODE2_RELABEL_TABLES]
      });
    }
  },
  {
    version: 88,
    description: "record the store projection each session's coordinates were derived against",
    up(db) {
      if (tableExists4(db, "session_meta")) {
        ensureColumn(db, "session_meta", "coordinate_generation", "TEXT");
        ensureColumn(db, "session_meta", "coordinate_rebase_notice", "TEXT");
      }
      if (tableExists4(db, "compartments")) {
        ensureColumn(db, "compartments", "rebase_status", "TEXT NOT NULL DEFAULT 'ok'");
      }
      if (tableExists4(db, "recomp_compartments")) {
        ensureColumn(db, "recomp_compartments", "rebase_status", "TEXT NOT NULL DEFAULT 'ok'");
      }
    }
  },
  {
    version: 89,
    description: "persist indexed message creation times for date-bounded search",
    up(db) {
      if (!tableExists4(db, "message_fts_rowid_map"))
        return;
      ensureColumn(db, "message_fts_rowid_map", "message_time_ms", "INTEGER");
      db.exec(`
                CREATE INDEX IF NOT EXISTS idx_message_fts_rowid_map_session_time
                    ON message_fts_rowid_map(session_id, message_time_ms);
                CREATE TABLE IF NOT EXISTS message_time_backfill_state (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    cursor_session_id TEXT NOT NULL DEFAULT '',
                    cursor_ordinal INTEGER NOT NULL DEFAULT 0,
                    completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
                    updated_at INTEGER NOT NULL DEFAULT 0
                );
                INSERT OR IGNORE INTO message_time_backfill_state
                    (id, cursor_session_id, cursor_ordinal, completed, updated_at)
                VALUES (1, '', 0, 0, 0);
            `);
    }
  },
  {
    version: 90,
    description: "record compartment lease owner pids",
    up(db) {
      if (!tableExists4(db, "compartment_state_lease"))
        return;
      ensureColumn(db, "compartment_state_lease", "owner_pid", "INTEGER");
    }
  },
  {
    version: 91,
    description: "per-project embedding high-water mark for memories written outside this host",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS memory_embedding_watermarks (
                    project_path TEXT PRIMARY KEY,
                    written_memory_id INTEGER NOT NULL DEFAULT 0,
                    embedded_memory_id INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );
            `);
    }
  },
  {
    version: 92,
    description: "store-level offline single-store state and canonical compartment boundaries",
    up(db) {
      for (const table of ["compartments", "recomp_compartments"]) {
        if (!tableExists4(db, table))
          continue;
        ensureColumn(db, table, "start_block_index", "INTEGER");
        ensureColumn(db, table, "end_block_index", "INTEGER");
      }
      db.exec(`
                CREATE TABLE IF NOT EXISTS single_store_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    state TEXT NOT NULL CHECK (state IN ('required', 'migrated')),
                    migrated_at INTEGER,
                    migrated_by TEXT,
                    backup_dir TEXT,
                    report_json TEXT
                );
                INSERT OR IGNORE INTO single_store_state(id, state) VALUES (1, 'required');
            `);
    }
  },
  {
    version: 93,
    description: "per-session compartment history revision for shared readers",
    up(db) {
      installCompartmentHistoryVersions(db);
    }
  },
  {
    version: 94,
    description: "store LKG prefixes as slices and replay decisions as rows instead of growing records",
    up(db) {
      splitLkgSlotPrefixes(db);
      splitReplayDecisions(db);
    }
  }
];
var LATEST_MIGRATION_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
function ensureMigrationsTable(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			description TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		)
	`);
}
function getCurrentVersion(db) {
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE version < ?").get(FORK_MIGRATION_VERSION_FLOOR);
  return row?.version ?? 0;
}
function isMigrationApplied(db, version) {
  return db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version) != null;
}
var mainThreadMigrationBodies = 0;
function isSiblingMigrationConflict(db, error, version) {
  if (!(error instanceof Error))
    return false;
  const msg = error.message;
  if (!msg.includes("schema_migrations"))
    return false;
  if (!msg.toLowerCase().includes("version"))
    return false;
  const confirmed = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version);
  return confirmed != null;
}
function runMigrations(db) {
  try {
    ensureMigrationsTable(db);
  } catch (error) {
    if (isSqliteLockError(error)) {
      throw new MigrationLockBusyError(`failed to prepare migration lock: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  }
  let loggedPlan = false;
  let touchedLegacyAuthorityBatch = false;
  while (true) {
    let migration;
    const migrationState = {};
    let currentVersion = 0;
    try {
      currentVersion = getCurrentVersion(db);
      const pendingMigration = MIGRATIONS.find((candidate) => candidate.version > currentVersion && !isMigrationApplied(db, candidate.version));
      if (!pendingMigration)
        break;
      migration = undefined;
      let transactionStartedAt = 0;
      const applied = db.transaction(() => {
        transactionStartedAt = performance.now();
        currentVersion = getCurrentVersion(db);
        migration = MIGRATIONS.find((candidate) => candidate.version > currentVersion && !isMigrationApplied(db, candidate.version));
        migrationState.value = migration;
        if (!migration)
          return false;
        if (!loggedPlan) {
          const pendingCount = MIGRATIONS.filter((candidate) => candidate.version > currentVersion && !isMigrationApplied(db, candidate.version)).length;
          log(`[migrations] current upstream migration lane: ${currentVersion}, applying ${pendingCount} migration(s)`);
          loggedPlan = true;
        }
        if (isMainThread)
          mainThreadMigrationBodies += 1;
        migration.up(db);
        db.prepare("INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)").run(migration.version, migration.description, Date.now());
        return true;
      }).immediate();
      logSlowWriteTransaction("migration-runner", transactionStartedAt);
      migration = migrationState.value;
      if (!applied || !migration)
        break;
      if (migration.version <= 61)
        touchedLegacyAuthorityBatch = true;
      log(`[migrations] applied v${migration.version}: ${migration.description}`);
    } catch (error) {
      if (!migration && isSqliteLockError(error)) {
        throw new MigrationLockBusyError(`failed to acquire migration write lock: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (migration && isSiblingMigrationConflict(db, error, migration.version)) {
        log(`[migrations] v${migration.version} already applied by sibling instance — resuming with re-read version`);
        const reReadVersion = getCurrentVersion(db);
        if (reReadVersion > currentVersion)
          continue;
        throw new Error(`Migration v${migration.version} failed: sibling conflict reported but version did not advance. Database may need manual repair.`);
      }
      const version = migration?.version ?? currentVersion + 1;
      const description = migration?.description ?? "acquire migration write lock";
      log(`[migrations] FAILED v${version}: ${description} — ${error instanceof Error ? error.message : String(error)}`);
      throw new Error(`Migration v${version} failed: ${error instanceof Error ? error.message : String(error)}. Database may need manual repair.`);
    }
  }
  if (touchedLegacyAuthorityBatch) {
    try {
      let transactionStartedAt = 0;
      db.transaction(() => {
        transactionStartedAt = performance.now();
        installLatestAuthorityTriggers(db);
      }).immediate();
      logSlowWriteTransaction("migration-runner", transactionStartedAt);
    } catch (error) {
      throw new Error(`Migration authority-trigger postcondition failed: ${error instanceof Error ? error.message : String(error)}. Database may need manual repair.`);
    }
  }
  if (loggedPlan) {
    log(`[migrations] upstream migration lane now: ${MIGRATIONS[MIGRATIONS.length - 1].version}`);
  }
}
async function runMigrationsWithRetry(db, options = {}) {
  const retryDelaysMs = options.retryDelaysMs ?? MIGRATION_LOCK_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const totalAttempts = retryDelaysMs.length + 1;
  for (let attempt = 1;attempt <= totalAttempts; attempt += 1) {
    log(`[migrations] migration lock check attempt ${attempt}/${totalAttempts}`);
    try {
      runMigrations(db);
      return;
    } catch (error) {
      if (!(error instanceof MigrationLockBusyError))
        throw error;
      const delayMs = retryDelaysMs[attempt - 1];
      if (delayMs === undefined)
        throw error;
      log(`[migrations] migration write lock is busy; retrying attempt ${attempt + 1}/${totalAttempts} in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
}

// ../plugin/src/features/magic-context/storage-db.ts
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync as existsSync3,
  mkdirSync as mkdirSync2,
  readdirSync,
  readFileSync as readFileSync3,
  rmdirSync,
  statSync as statSync2,
  unlinkSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// ../plugin/src/plugin/boot-quiet.ts
var bootQuietUntilMs = 0;
function bootQuietRemainingMs(now = Date.now()) {
  return Math.max(0, bootQuietUntilMs - now);
}
function scheduleAfterBootQuiet(task, additionalDelayMs = 0) {
  const timer = setTimeout(task, bootQuietRemainingMs() + Math.max(0, additionalDelayMs));
  timer.unref?.();
  return timer;
}

// ../plugin/src/shared/error-message.ts
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ../plugin/src/shared/rpc-utils.ts
import { execFile, execFileSync as execFileSync2 } from "node:child_process";
import { readFileSync as readFileSync2 } from "node:fs";

// ../plugin/src/shared/pi-executable.ts
var PI_IMAGE_NAMES = new Set(["pi", "pi.cmd", "omp", "oh-my-pi"]);
function piHarnessKindFromExecutable(value) {
  const executable = (value ?? "").trim().replace(/^['"]|['"]$/g, "").replaceAll("\\", "/").split("/").at(-1)?.toLowerCase().replace(/\.(?:exe|cmd)$/, "");
  if (!executable || !PI_IMAGE_NAMES.has(executable))
    return;
  return executable === "pi" ? "pi" : "omp";
}

// ../plugin/src/shared/rpc-utils.ts
var ownRpcServerInstanceIds = new Set;
function isOwnRpcServerRecord(record) {
  return record.pid === process.pid && record.instance_id !== undefined && ownRpcServerInstanceIds.has(record.instance_id);
}
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0)
    return "dead";
  if (rpcIdentityPlatform === "win32")
    return readWindowsProcess(pid).state;
  try {
    rpcIdentityProcessKill(pid, 0);
    return "alive";
  } catch (error) {
    return error.code === "ESRCH" ? "dead" : "inconclusive";
  }
}
var RPC_IDENTITY_SKEW_TOLERANCE_MS = 120000;
var LINUX_CLOCK_TICKS_PER_SECOND = 100;
var PS_PROBE_TIMEOUT_MS = 1000;
var WINDOWS_CIM_PROBE_TIMEOUT_MS = 5000;
var WINDOWS_PROCESS_SNAPSHOT_TTL_MS = 2000;
var MAX_ANCESTOR_WALK_DEPTH = 16;
var OPEN_CODE_COMMAND_MARKERS = ["opencode", "node", "bun", "electron"];
var WINDOWS_CIM_COMMAND = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name='CreationDate';Expression={if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }}} | ConvertTo-Json -Compress";
var PROCESS_LIST_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
var PI_HARNESS_ARC_MARKERS = [
  "pi-coding-agent",
  "oh-my-pi",
  "@oh-my-pi",
  "cljs/dist",
  "dist/bundle/cli"
];
var rpcIdentityReadFileSync = readFileSync2;
var rpcIdentityExecFileSync = execFileSync2;
var rpcIdentityProcessKill = process.kill;
var rpcProcessListExecFileSync = execFileSync2;
var rpcIdentityPlatform = process.platform;
var rpcIdentityNowMs = () => Date.now();
function parseLinuxProcessStartTime(statContent, uptimeContent) {
  const closingCommandName = statContent.lastIndexOf(")");
  if (closingCommandName < 0)
    return null;
  const statFields = statContent.slice(closingCommandName + 1).trim().split(/\s+/);
  const startTimeTicks = Number(statFields[19]);
  const uptimeSeconds = Number(uptimeContent.trim().split(/\s+/)[0]);
  if (!Number.isFinite(startTimeTicks) || startTimeTicks < 0 || !Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) {
    return null;
  }
  const processStartTime = rpcIdentityNowMs() - uptimeSeconds * 1000 + startTimeTicks / LINUX_CLOCK_TICKS_PER_SECOND * 1000;
  return Number.isFinite(processStartTime) ? processStartTime : null;
}
function readLinuxProcessStartTime(pid) {
  try {
    const statContent = String(rpcIdentityReadFileSync(`/proc/${pid}/stat`, "utf8"));
    const uptimeContent = String(rpcIdentityReadFileSync("/proc/uptime", "utf8"));
    return parseLinuxProcessStartTime(statContent, uptimeContent);
  } catch {
    return null;
  }
}
function readPsProcessStartTime(pid) {
  try {
    const output = rpcIdentityExecFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: PS_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const processStartTime = Date.parse(String(output).trim());
    return Number.isFinite(processStartTime) ? processStartTime : null;
  } catch {
    return null;
  }
}
function readProcessStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0)
    return null;
  return rpcIdentityPlatform === "linux" ? readLinuxProcessStartTime(pid) : rpcIdentityPlatform === "win32" ? readWindowsProcessStartTime(pid) : readPsProcessStartTime(pid);
}
function readProcessProbeEvidence(pid) {
  return {
    startTime: readProcessStartTime(pid),
    commandLine: readProcessCommand(pid)
  };
}
function readCachedWindowsImageName(pid) {
  return rpcIdentityPlatform === "win32" ? windowsProcessFactsCache?.get(pid)?.imageName ?? null : null;
}
var windowsProcessFactsCache = null;
var windowsProcessSnapshotCache = null;
function rememberWindowsProcessFacts(facts) {
  windowsProcessFactsCache = new Map(facts.map((fact) => [fact.pid, fact]));
}
function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0;index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted)
    return null;
  fields.push(field);
  return fields;
}
function parseTasklistOutput(output) {
  const entries = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line)
      continue;
    const fields = parseCsvLine(line);
    if (!fields)
      continue;
    if (fields[1]?.trim().toLowerCase() === "pid") {
      continue;
    }
    const pid = Number(fields[1]);
    if (!Number.isInteger(pid) || pid <= 0 || !fields[0])
      continue;
    entries.push({ pid, command: fields[0] });
  }
  return entries;
}
function readWindowsProcess(pid) {
  try {
    const output = rpcIdentityExecFileSync("tasklist", ["/FO", "CSV", "/NH", "/FI", `PID eq ${pid}`], {
      encoding: "utf8",
      timeout: PS_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const entries = parseTasklistOutput(String(output));
    if (entries === null)
      return { state: "inconclusive" };
    const process2 = entries.find((entry) => entry.pid === pid);
    return process2 ? { state: "alive", command: process2.command } : { state: "dead" };
  } catch {
    return { state: "inconclusive" };
  }
}
function readWindowsProcessStartTime(pid) {
  const cached = windowsProcessFactsCache?.get(pid);
  if (cached)
    return cached.startTime;
  const snapshot = tryReadWindowsCimSnapshot(rpcIdentityExecFileSync);
  if (!snapshot)
    return null;
  rememberWindowsProcessFacts(snapshot.facts);
  return windowsProcessFactsCache?.get(pid)?.startTime ?? null;
}
function readLinuxProcessCommand(pid) {
  try {
    return String(rpcIdentityReadFileSync(`/proc/${pid}/cmdline`, "utf8"));
  } catch {
    return null;
  }
}
function readPsProcessCommand(pid) {
  try {
    const output = rpcIdentityExecFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: PS_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    return String(output);
  } catch {
    return null;
  }
}
function readProcessCommand(pid) {
  if (!Number.isInteger(pid) || pid <= 0)
    return null;
  if (rpcIdentityPlatform === "linux")
    return readLinuxProcessCommand(pid);
  if (rpcIdentityPlatform === "win32") {
    const cached = windowsProcessFactsCache?.get(pid);
    if (cached?.commandLine)
      return cached.commandLine;
    return readWindowsProcess(pid).command ?? null;
  }
  return readPsProcessCommand(pid);
}
function executableName(token) {
  return (token ?? "").replace(/^['"]|['"]$/g, "").split("/").at(-1) ?? "";
}
function commandTokens(command) {
  return command.toLowerCase().replaceAll("\\", "/").replaceAll("\x00", " ").split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, "")).filter(Boolean);
}
function commandHasOpenCodeExecutable(tokens) {
  return tokens.findIndex((token) => {
    const executable = executableName(token).replace(/\.(?:exe|cmd)$/, "");
    return executable === "opencode" || executable.endsWith("/opencode");
  });
}
function commandHasPiExecutable(tokens) {
  for (let index = 0;index < tokens.length; index += 1) {
    const executable = executableName(tokens[index]).replace(/\.(?:exe|cmd)$/, "");
    if (piHarnessKindFromExecutable(executable) !== undefined)
      return true;
    if (["node", "bun", "deno"].includes(executable)) {
      const script = executableName(tokens[index + 1]).replace(/\.(?:exe|cmd)$/, "");
      if (["pi", "pi.js", "pi.mjs", "pi.cjs"].includes(script) || tokens[index + 1]?.includes("pi-coding-agent")) {
        return true;
      }
    }
  }
  return false;
}
function classifyProcessKind(command) {
  if (!command)
    return "process";
  const tokens = commandTokens(command);
  const openCodeIndex = commandHasOpenCodeExecutable(tokens);
  if (openCodeIndex >= 0) {
    const args = tokens.slice(openCodeIndex + 1);
    if (args.some((token) => token === "serve" || token === "--serve" || token.startsWith("--serve="))) {
      return "OpenCode server";
    }
    return "OpenCode instance (TUI/CLI)";
  }
  return commandHasPiExecutable(tokens) ? "Pi" : "process";
}
function commandLooksLikeOpenCode(command) {
  const normalized = command.toLowerCase();
  return OPEN_CODE_COMMAND_MARKERS.some((marker) => normalized.includes(marker));
}
var RPC_HOST_PROCESS_MARKERS = [
  "opencode",
  "openchamber",
  "ck-mc",
  "magic-context",
  "cortexkit",
  "electron",
  "node",
  "bun",
  "deno",
  "pi-coding-agent",
  "oh-my-pi"
];
function processCannotBeRpcHost(evidence) {
  const texts = [evidence.imageName, evidence.commandLine].filter((text) => typeof text === "string" && text.trim().length > 0);
  if (texts.length === 0)
    return false;
  for (const text of texts) {
    const normalized = text.toLowerCase();
    if (RPC_HOST_PROCESS_MARKERS.some((marker) => normalized.includes(marker)))
      return false;
    const tokens = commandTokens(text);
    if (commandHasPiExecutable(tokens))
      return false;
    if (tokens.some((token) => piHarnessKindFromExecutable(token) !== undefined))
      return false;
  }
  return true;
}
function isPidIdentityPlausible(record, evidence) {
  if (!Number.isInteger(record.pid) || record.pid <= 0)
    return "implausible";
  if (Number.isFinite(record.started_at) && record.started_at > 0) {
    const processStartTime = evidence ? evidence.startTime : readProcessStartTime(record.pid);
    if (processStartTime !== null) {
      return processStartTime <= record.started_at + RPC_IDENTITY_SKEW_TOLERANCE_MS ? "plausible" : "implausible";
    }
    const identity = evidence ?? {
      commandLine: readProcessCommand(record.pid),
      imageName: readCachedWindowsImageName(record.pid)
    };
    return processCannotBeRpcHost(identity) ? "implausible" : "inconclusive";
  }
  const command = evidence ? evidence.commandLine : rpcIdentityPlatform === "linux" ? readLinuxProcessCommand(record.pid) : rpcIdentityPlatform === "win32" ? readWindowsProcess(record.pid).command ?? null : readPsProcessCommand(record.pid);
  if (command === null)
    return "inconclusive";
  if (commandLooksLikeOpenCode(command))
    return "plausible";
  return processCannotBeRpcHost({ commandLine: command, imageName: evidence?.imageName }) ? "implausible" : "inconclusive";
}
function commandLooksLikePiImage(command) {
  const tokens = commandTokens(command);
  const first = executableName(tokens[0]).replace(/\.(?:exe|cmd)$/, "");
  return PI_IMAGE_NAMES.has(first);
}
function commandHasPiHarnessArc(command) {
  const normalized = command.trim().toLowerCase().replaceAll("\\", "/").replaceAll("\x00", " ");
  if (!normalized)
    return false;
  const tokens = commandTokens(command);
  if (tokens.length === 0)
    return false;
  const hasArc = PI_HARNESS_ARC_MARKERS.some((marker) => normalized.includes(marker));
  const first = executableName(tokens[0]).replace(/\.(?:exe|cmd)$/, "");
  if (hasArc && ["pi", "omp", "oh-my-pi", "node", "bun", "deno", "cmd"].includes(first)) {
    return true;
  }
  if (hasArc && PI_HARNESS_ARC_MARKERS.some((marker) => tokens[0].includes(marker))) {
    return true;
  }
  if (["node", "bun", "deno"].includes(first)) {
    const script = executableName(tokens[1]).replace(/\.(?:exe|cmd)$/, "");
    if (["pi", "pi.js", "pi.mjs", "pi.cjs"].includes(script))
      return true;
    if (hasArc)
      return true;
  }
  return false;
}
function execProcessList(exec, file, args, timeout = PS_PROBE_TIMEOUT_MS) {
  return String(exec(file, [...args], {
    encoding: "utf8",
    timeout,
    maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  }));
}
function parseWindowsCreationDate(value) {
  if (value !== null && typeof value === "object" && "value" in value) {
    return parseWindowsCreationDate(value.value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1000000000000 ? value : value * 1000;
  }
  if (typeof value !== "string")
    return null;
  const trimmed = value.trim();
  if (!trimmed)
    return null;
  const wmi = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(trimmed);
  if (wmi) {
    const utcMs = Date.UTC(Number(wmi[1]), Number(wmi[2]) - 1, Number(wmi[3]), Number(wmi[4]), Number(wmi[5]), Number(wmi[6]), Number(wmi[7]) / 1000);
    if (!Number.isFinite(utcMs))
      return null;
    const offsetMinutes = Number(wmi[9]);
    const sign = wmi[8] === "+" ? 1 : -1;
    return utcMs - sign * offsetMinutes * 60000;
  }
  const dotNet = /^\/Date\((-?\d+)\)\/$/.exec(trimmed);
  if (dotNet) {
    const milliseconds = Number(dotNet[1]);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
function parseWindowsCimOutput(output) {
  const trimmed = output.trim();
  if (!trimmed)
    return null;
  const bracket = trimmed.indexOf("[");
  const brace = trimmed.indexOf("{");
  const start = Math.min(bracket === -1 ? Number.POSITIVE_INFINITY : bracket, brace === -1 ? Number.POSITIVE_INFINITY : brace);
  if (!Number.isFinite(start))
    return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed.slice(start));
  } catch {
    return null;
  }
  if (parsed == null)
    return null;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const facts = [];
  for (const row of rows) {
    if (!row || typeof row !== "object")
      continue;
    const record = row;
    const pid = Number(record.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0)
      continue;
    const parentRaw = record.ParentProcessId;
    const parentPid = parentRaw == null || parentRaw === "" ? Number.NaN : Number(parentRaw);
    const commandLine = typeof record.CommandLine === "string" ? record.CommandLine : null;
    facts.push({
      pid,
      parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
      commandLine,
      imageName: typeof record.Name === "string" ? record.Name : commandLine ? executableName(commandTokens(commandLine)[0]) : null,
      startTime: parseWindowsCreationDate(record.CreationDate)
    });
  }
  return facts.length > 0 ? facts : null;
}
function snapshotFromFacts(facts, source) {
  const parentByPid = new Map;
  for (const fact of facts) {
    if (fact.parentPid != null)
      parentByPid.set(fact.pid, fact.parentPid);
  }
  return { facts, parentByPid, source };
}
function tryReadWindowsCimSnapshot(exec) {
  try {
    const output = execProcessList(exec, "powershell", ["-NoProfile", "-Command", WINDOWS_CIM_COMMAND], WINDOWS_CIM_PROBE_TIMEOUT_MS);
    const facts = parseWindowsCimOutput(output);
    return facts ? snapshotFromFacts(facts, "cim") : null;
  } catch {
    return null;
  }
}
function tryReadWindowsTasklistSnapshot() {
  try {
    const output = execProcessList(rpcProcessListExecFileSync, "tasklist", [
      "/FO",
      "CSV",
      "/NH"
    ]);
    const entries = parseTasklistOutput(output);
    if (entries === null)
      return null;
    const facts = entries.map((entry) => ({
      pid: entry.pid,
      parentPid: null,
      commandLine: null,
      imageName: entry.command,
      startTime: null
    }));
    return snapshotFromFacts(facts, "tasklist");
  } catch {
    return null;
  }
}
function readPosixProcessSnapshot() {
  const output = execProcessList(rpcProcessListExecFileSync, "ps", ["-axo", "pid=,command="]);
  const facts = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match)
      continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0)
      continue;
    facts.push({
      pid,
      parentPid: null,
      commandLine: match[2],
      imageName: executableName(commandTokens(match[2])[0]),
      startTime: null
    });
  }
  return snapshotFromFacts(facts, "ps");
}
function readPosixParentPid(pid) {
  try {
    const output = execProcessList(rpcProcessListExecFileSync, "ps", [
      "-o",
      "ppid=",
      "-p",
      String(pid)
    ]);
    const match = /^\s*(\d+)\s*$/.exec(output);
    if (!match)
      return null;
    const ppid = Number(match[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}
function collectAncestorPids(selfPid, parentByPid, probeParents = true) {
  const ancestors = new Set;
  let current = selfPid;
  for (let depth = 0;depth < MAX_ANCESTOR_WALK_DEPTH; depth += 1) {
    let ppid = null;
    if (parentByPid.has(current)) {
      ppid = parentByPid.get(current) ?? null;
    } else if (rpcIdentityPlatform !== "win32" && probeParents) {
      ppid = readPosixParentPid(current);
      if (ppid == null && current === process.pid && process.ppid > 0) {
        ppid = process.ppid;
      }
    } else if (current === process.pid && process.ppid > 0) {
      ppid = process.ppid;
    } else {
      break;
    }
    if (ppid == null || ppid <= 0 || ppid === current || ancestors.has(ppid))
      break;
    ancestors.add(ppid);
    current = ppid;
  }
  return ancestors;
}
function classifyLivePiSnapshot(snapshot, probeParents = true) {
  const ancestors = collectAncestorPids(process.pid, snapshot.parentByPid, probeParents);
  const processIds = new Set;
  const inconclusivePids = new Set;
  const skippedAncestorPids = [];
  for (const fact of snapshot.facts) {
    if (fact.pid === process.pid)
      continue;
    const command = fact.commandLine ?? fact.imageName ?? "";
    const looksLikeHarness = commandHasPiHarnessArc(command) || commandLooksLikePiImage(command);
    if (!looksLikeHarness)
      continue;
    if (ancestors.has(fact.pid)) {
      skippedAncestorPids.push(fact.pid);
      log(`[magic-context] Pi process scan: skipping ancestor PID ${fact.pid} (session launcher shim)`);
      continue;
    }
    if (commandHasPiHarnessArc(command)) {
      processIds.add(fact.pid);
      continue;
    }
    inconclusivePids.add(fact.pid);
    log(`[magic-context] Pi process scan: PID ${fact.pid} command line is ambiguous (image-name or missing Pi/OMP arc); treating as inconclusive`);
  }
  skippedAncestorPids.sort((left, right) => left - right);
  const verified = [...processIds].sort((left, right) => left - right);
  const inconclusive = [...inconclusivePids].sort((left, right) => left - right);
  if (verified.length === 0 && inconclusive.length > 0) {
    return {
      state: "inconclusive",
      processIds: [],
      inconclusivePids: inconclusive,
      ...skippedAncestorPids.length > 0 ? { skippedAncestorPids } : {}
    };
  }
  return {
    state: "known",
    processIds: verified,
    ...inconclusive.length > 0 ? { inconclusivePids: inconclusive } : {},
    ...skippedAncestorPids.length > 0 ? { skippedAncestorPids } : {}
  };
}
function inspectLivePiProcesses() {
  if (false) {}
  try {
    if (rpcIdentityPlatform === "win32") {
      const now = rpcIdentityNowMs();
      const cached = windowsProcessSnapshotCache;
      const snapshot = cached && now >= cached.at && now - cached.at < WINDOWS_PROCESS_SNAPSHOT_TTL_MS ? cached.snapshot : tryReadWindowsCimSnapshot(rpcProcessListExecFileSync) ?? tryReadWindowsTasklistSnapshot();
      if (!snapshot) {
        return {
          state: "unreadable",
          processIds: [],
          error: "process list unavailable"
        };
      }
      if (snapshot !== cached?.snapshot)
        windowsProcessSnapshotCache = { snapshot, at: now };
      rememberWindowsProcessFacts(snapshot.facts);
      return classifyLivePiSnapshot(snapshot);
    }
    return classifyLivePiSnapshot(readPosixProcessSnapshot());
  } catch (error) {
    return {
      state: "unreadable",
      processIds: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
function parseRpcPortFile(content, fallbackPid = 0) {
  const trimmed = content.trim();
  if (!trimmed)
    return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const port = Number(parsed.port);
      const pid = Number(parsed.pid);
      const startedAt = Number(parsed.started_at);
      if (!isValidPort(port) || !Number.isInteger(pid) || pid <= 0)
        return null;
      return {
        port,
        pid,
        started_at: Number.isFinite(startedAt) ? startedAt : 0,
        kind: typeof parsed.kind === "string" ? parsed.kind : undefined,
        harness: typeof parsed.harness === "string" ? parsed.harness : undefined,
        token: typeof parsed.token === "string" ? parsed.token : undefined,
        instance_id: typeof parsed.instance_id === "string" ? parsed.instance_id : undefined
      };
    } catch {
      return null;
    }
  }
  const port = Number.parseInt(trimmed, 10);
  if (!isValidPort(port))
    return null;
  return { port, pid: fallbackPid, started_at: 0 };
}
function isValidPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}
function snapshotEvidence(fact) {
  return {
    startTime: fact?.startTime ?? null,
    commandLine: fact?.commandLine ?? fact?.imageName ?? null,
    ...fact?.imageName ? { imageName: fact.imageName } : {}
  };
}
function inspectWindowsProcessesSync() {
  const snapshot = tryReadWindowsCimSnapshot(rpcProcessListExecFileSync) ?? tryReadWindowsTasklistSnapshot();
  const byPid = new Map(snapshot?.facts.map((fact) => [fact.pid, fact]));
  return {
    pi: snapshot ? classifyLivePiSnapshot(snapshot) : { state: "unreadable", processIds: [] },
    ...snapshot ? { processSnapshot: { source: snapshot.source, facts: snapshot.facts } } : {},
    evidence: (pid) => snapshotEvidence(byPid.get(pid)),
    liveness: (pid) => byPid.has(pid) ? "alive" : snapshot ? "dead" : "inconclusive"
  };
}

// ../plugin/src/shared/storage-permissions.ts
var enforcePrivateStoragePermissions = true;
function shouldEnforcePrivateStoragePermissions() {
  return enforcePrivateStoragePermissions;
}

// ../plugin/src/features/magic-context/context-store-uuid.ts
import { randomUUID as randomUUID2 } from "node:crypto";
function getContextStoreUuid(db) {
  const row = db.prepare("SELECT value FROM context_store_meta WHERE key = 'store_uuid'").get();
  return typeof row?.value === "string" && row.value.length > 0 ? row.value : null;
}
function ensureContextStoreUuid(db) {
  const existing = getContextStoreUuid(db);
  if (existing)
    return existing;
  const minted = randomUUID2();
  withPrivilegedWriter(db, () => {
    db.transaction(() => {
      db.prepare("INSERT INTO context_store_meta(key, value) VALUES ('store_uuid', ?) ON CONFLICT(key) DO NOTHING").run(minted);
    }).immediate();
  });
  return getContextStoreUuid(db) ?? minted;
}

// ../plugin/src/features/magic-context/fail-closed-block.ts
function attachFailClosedBlockingProcessEvidence(process2, evidence) {
  Object.defineProperties(process2, {
    startTime: { configurable: true, value: evidence.startTime },
    commandLine: { configurable: true, value: evidence.commandLine }
  });
  return process2;
}
var OPENCODE_INTERNAL_AGENT_NAMES = new Set(["title", "summary", "compaction"]);

// ../plugin/src/features/magic-context/message-fts-rowid-map.ts
import { createHash as createHash4 } from "node:crypto";
var MESSAGE_FTS_ROWID_MAP_BACKFILL_BATCH_SIZE = 100;
var BACKFILL_STATE_ID = 1;
var EMPTY_INDEX_CONTENT_HASH = createHash4("sha256").update("").digest("hex");
var upsertMapStatements = new WeakMap;
var rangeReadyStatements = new WeakMap;
var updateTimeStatements = new WeakMap;
var activeBackfills = new WeakMap;
function getUpsertMapStatement(db) {
  let statement = upsertMapStatements.get(db);
  if (!statement) {
    statement = db.prepare(`INSERT INTO message_fts_rowid_map
                 (session_id, message_ordinal, fts_rowid, message_time_ms)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id, message_ordinal) DO UPDATE SET
                 fts_rowid = excluded.fts_rowid,
                 message_time_ms = COALESCE(
                     excluded.message_time_ms,
                     message_fts_rowid_map.message_time_ms
                 )`);
    upsertMapStatements.set(db, statement);
  }
  return statement;
}
function getBackfillState(db) {
  const row = db.prepare(`SELECT watermark_rowid AS watermarkRowid, completed
             FROM message_fts_rowid_map_backfill_state
             WHERE id = ?`).get(BACKFILL_STATE_ID);
  return {
    processed: 0,
    watermarkRowid: typeof row?.watermarkRowid === "number" && Number.isSafeInteger(row.watermarkRowid) ? row.watermarkRowid : 0,
    completed: row?.completed === 1
  };
}
function recordMessageFtsRowid(db, sessionId, messageOrdinal, ftsRowid, messageTimeMs = null) {
  const numericRowid = Number(ftsRowid);
  if (!Number.isSafeInteger(numericRowid) || numericRowid <= 0) {
    throw new Error(`invalid message FTS rowid: ${String(ftsRowid)}`);
  }
  const normalizedTime = typeof messageTimeMs === "number" && Number.isSafeInteger(messageTimeMs) && messageTimeMs >= 0 ? messageTimeMs : null;
  getUpsertMapStatement(db).run(sessionId, messageOrdinal, numericRowid, normalizedTime);
}
function backfillMessageFtsRowidMapBatch(db, batchSize = MESSAGE_FTS_ROWID_MAP_BACKFILL_BATCH_SIZE) {
  const boundedBatchSize = Number.isFinite(batchSize) ? Math.min(MESSAGE_FTS_ROWID_MAP_BACKFILL_BATCH_SIZE, Math.max(1, Math.floor(batchSize))) : MESSAGE_FTS_ROWID_MAP_BACKFILL_BATCH_SIZE;
  let progress = {
    processed: 0,
    watermarkRowid: 0,
    completed: false
  };
  let transactionStartedAt = 0;
  db.transaction(() => {
    transactionStartedAt = performance.now();
    db.prepare(`INSERT OR IGNORE INTO message_fts_rowid_map_backfill_state
            (id, watermark_rowid, completed) VALUES (?, 0, 0)`).run(BACKFILL_STATE_ID);
    const state = getBackfillState(db);
    if (state.completed) {
      progress = state;
      return;
    }
    const rows = db.prepare(`SELECT rowid AS ftsRowid,
            session_id AS sessionId, message_ordinal AS messageOrdinal
            FROM message_history_fts WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`).all(state.watermarkRowid, boundedBatchSize);
    let watermarkRowid = state.watermarkRowid;
    for (const row of rows) {
      const ftsRowid = Number(row.ftsRowid);
      const messageOrdinal = Number(row.messageOrdinal);
      if (Number.isSafeInteger(ftsRowid) && ftsRowid > watermarkRowid) {
        watermarkRowid = ftsRowid;
      }
      if (typeof row.sessionId === "string" && Number.isSafeInteger(messageOrdinal) && messageOrdinal >= 0 && Number.isSafeInteger(ftsRowid) && ftsRowid > 0) {
        recordMessageFtsRowid(db, row.sessionId, messageOrdinal, ftsRowid);
      }
    }
    const completed = rows.length < boundedBatchSize;
    db.prepare(`UPDATE message_fts_rowid_map_backfill_state
             SET watermark_rowid = ?, completed = ?, updated_at = ?
             WHERE id = ?`).run(watermarkRowid, completed ? 1 : 0, Date.now(), BACKFILL_STATE_ID);
    progress = {
      processed: rows.length,
      watermarkRowid,
      completed
    };
  }).immediate();
  logSlowWriteTransaction("message_fts_rowid_backfill", transactionStartedAt);
  return progress;
}
async function runMessageFtsRowidMapBackfill(db) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (;; ) {
    const progress = backfillMessageFtsRowidMapBatch(db);
    if (progress.completed)
      return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
function startMessageFtsRowidMapBackfill(db) {
  const active = activeBackfills.get(db);
  if (active)
    return active;
  const run = withoutSqliteTransformPass(() => withSqliteBackgroundWriter(() => runMessageFtsRowidMapBackfill(db))).finally(() => {
    activeBackfills.delete(db);
  });
  activeBackfills.set(db, run);
  return run;
}
function messageFtsOrdinalRangeIsMapped(db, sessionId, startOrdinal, endOrdinal) {
  if (endOrdinal < startOrdinal)
    return true;
  if (getBackfillState(db).completed)
    return true;
  let statement = rangeReadyStatements.get(db);
  if (!statement) {
    statement = db.prepare(`SELECT COUNT(DISTINCT source.message_ordinal) AS sourceOrdinalCount,
                    COUNT(DISTINCT CASE
                        WHEN source.role IN ('user', 'assistant')
                         AND source.normalized_content_hash != ?
                        THEN source.message_ordinal
                    END) AS expectedMapCount,
                    COUNT(DISTINCT CASE
                        WHEN source.role IN ('user', 'assistant')
                         AND source.normalized_content_hash != ?
                         AND map.fts_rowid IS NOT NULL
                        THEN source.message_ordinal
                    END) AS mappedCount
             FROM message_history_source AS source
             LEFT JOIN message_fts_rowid_map AS map
               ON map.session_id = source.session_id
              AND map.message_ordinal = source.message_ordinal
             WHERE source.session_id = ?
               AND source.message_ordinal BETWEEN ? AND ?`);
    rangeReadyStatements.set(db, statement);
  }
  const row = statement.get(EMPTY_INDEX_CONTENT_HASH, EMPTY_INDEX_CONTENT_HASH, sessionId, startOrdinal, endOrdinal);
  const ordinalCount = endOrdinal - startOrdinal + 1;
  return row?.sourceOrdinalCount === ordinalCount && row.expectedMapCount === row.mappedCount;
}
function deleteUnmappedMessageFtsRows(db, sessionIds) {
  if (sessionIds.length === 0)
    return;
  const state = getBackfillState(db);
  if (state.completed)
    return;
  const placeholders = sessionIds.map(() => "?").join(", ");
  db.prepare(`DELETE FROM message_history_fts
         WHERE rowid > ? AND session_id IN (${placeholders})`).run(state.watermarkRowid, ...sessionIds);
}

// ../plugin/src/features/magic-context/tool-owner-backfill.ts
import { existsSync as existsSync2 } from "node:fs";
var LEASE_DURATION_MS = 5 * 60 * 1000;
var LEASE_RENEWAL_MS = 60 * 1000;
function resolveOpencodeDbPath() {
  return resolveOpenCodeDbPath().path;
}
function ensureBackfillStateTable(db) {
  db.exec(`
        CREATE TABLE IF NOT EXISTS tool_owner_backfill_state (
            session_id TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'skipped')),
            started_at INTEGER,
            lease_expires_at INTEGER,
            completed_at INTEGER,
            last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tool_owner_backfill_state_status
        ON tool_owner_backfill_state(status);
    `);
}
function runToolOwnerBackfill(db) {
  const startedAt = performance.now();
  ensureBackfillStateTable(db);
  const result = {
    sessionsProcessed: 0,
    sessionsSkippedNoOcDb: 0,
    sessionsSkippedNoMatches: 0,
    sessionsCompleted: 0,
    sessionsBlockedByLease: 0,
    sessionsErrored: 0,
    rowsUpdated: 0,
    rowsLeftNull: 0,
    durationMs: 0
  };
  if (!isToolOwnerBackfillNeeded(db)) {
    result.durationMs = performance.now() - startedAt;
    return result;
  }
  const opencodeDbPath = resolveOpencodeDbPath();
  if (!existsSync2(opencodeDbPath)) {
    log(`[backfill] OpenCode DB not found at ${opencodeDbPath} — marking all unbackfilled sessions as skipped. Lazy adoption (defense-in-depth) handles legacy rows at runtime.`);
    markAllUnbackfilledSessionsSkipped(db);
    result.sessionsSkippedNoOcDb = countSessionsByStatus(db, "skipped");
    result.durationMs = performance.now() - startedAt;
    return result;
  }
  const escapedDbPath = opencodeDbPath.replaceAll("'", "''");
  db.exec(`ATTACH '${escapedDbPath}' AS oc_backfill`);
  try {
    if (!hasV1MessageTables(db, "oc_backfill")) {
      throw new Error(`OpenCode store at ${opencodeDbPath} has no v1 message tables; nothing to backfill`);
    }
    backfillToolOwnersInChunks(db, result);
  } finally {
    try {
      db.exec("DETACH DATABASE oc_backfill");
    } catch (error) {
      log(`[backfill] failed to detach oc_backfill database: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  result.durationMs = performance.now() - startedAt;
  log(`[backfill] sessions=${result.sessionsProcessed} completed=${result.sessionsCompleted} skipped_no_oc=${result.sessionsSkippedNoOcDb} skipped_no_matches=${result.sessionsSkippedNoMatches} blocked_by_lease=${result.sessionsBlockedByLease} errored=${result.sessionsErrored} rows_updated=${result.rowsUpdated} rows_left_null=${result.rowsLeftNull} duration_ms=${Math.round(result.durationMs)}`);
  return result;
}
function isToolOwnerBackfillNeeded(db) {
  ensureBackfillStateTable(db);
  const row = db.prepare(`SELECT 1 AS hit
             FROM tags
             WHERE type = 'tool' AND tool_owner_message_id IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM tool_owner_backfill_state s
                   WHERE s.session_id = tags.session_id
                     AND s.status IN ('completed', 'skipped')
               )
             LIMIT 1`).get();
  return row !== null && row !== undefined;
}
function markAllUnbackfilledSessionsSkipped(db) {
  const now = Date.now();
  db.prepare(`INSERT INTO tool_owner_backfill_state(session_id, status, started_at, completed_at, last_error)
         SELECT DISTINCT session_id, 'skipped', NULL, ?, NULL
         FROM tags
         WHERE type = 'tool' AND tool_owner_message_id IS NULL
         ON CONFLICT(session_id) DO UPDATE SET
             status = 'skipped',
             completed_at = excluded.completed_at,
             last_error = NULL
         WHERE tool_owner_backfill_state.status NOT IN ('completed', 'running')`).run(now);
}
function countSessionsByStatus(db, status) {
  const row = db.prepare("SELECT COUNT(*) AS c FROM tool_owner_backfill_state WHERE status = ?").get(status);
  return row.c;
}
function acquireSessionLease(db, sessionId, now) {
  const expiresAt = now + LEASE_DURATION_MS;
  const result = db.prepare(`INSERT INTO tool_owner_backfill_state(session_id, status, started_at, lease_expires_at)
             SELECT ?, 'running', ?, ?
             WHERE EXISTS (SELECT 1 FROM tags WHERE session_id = ?)
             ON CONFLICT(session_id) DO UPDATE SET
                 status = 'running',
                 started_at = excluded.started_at,
                 lease_expires_at = excluded.lease_expires_at,
                 last_error = NULL
             WHERE tool_owner_backfill_state.status IN ('pending', 'skipped')
                OR (tool_owner_backfill_state.status = 'running'
                    AND tool_owner_backfill_state.lease_expires_at < ?)`).run(sessionId, now, expiresAt, sessionId, now);
  return (result.changes ?? 0) === 1;
}
function renewSessionLease(db, sessionId, now) {
  const expiresAt = now + LEASE_DURATION_MS;
  db.prepare(`UPDATE tool_owner_backfill_state
         SET lease_expires_at = ?
         WHERE session_id = ? AND status = 'running'`).run(expiresAt, sessionId);
}
function markSessionCompleted(db, sessionId, now) {
  db.prepare(`UPDATE tool_owner_backfill_state
         SET status = 'completed', completed_at = ?, lease_expires_at = NULL, last_error = NULL
         WHERE session_id = ?`).run(now, sessionId);
}
function markSessionPendingRetry(db, sessionId) {
  db.prepare(`UPDATE tool_owner_backfill_state
         SET status = 'pending', completed_at = NULL, lease_expires_at = NULL, last_error = NULL
         WHERE session_id = ?`).run(sessionId);
}
function markSessionSkipped(db, sessionId, now, reason) {
  db.prepare(`UPDATE tool_owner_backfill_state
         SET status = 'skipped', completed_at = ?, last_error = ?, lease_expires_at = NULL
         WHERE session_id = ? AND status = 'running'`).run(now, reason, sessionId);
}
function markSessionErrored(db, sessionId, error) {
  const message = error instanceof Error ? error.message : String(error);
  db.prepare(`UPDATE tool_owner_backfill_state
         SET last_error = ?, lease_expires_at = NULL
         WHERE session_id = ?`).run(message, sessionId);
}
function getSessionsNeedingBackfill(db) {
  const rows = db.prepare(`SELECT DISTINCT t.session_id
             FROM tags t
             LEFT JOIN tool_owner_backfill_state s ON s.session_id = t.session_id
             WHERE t.type = 'tool' AND t.tool_owner_message_id IS NULL
               AND (s.status IS NULL OR s.status NOT IN ('completed', 'skipped'))
             ORDER BY t.session_id ASC`).all();
  return rows.map((r) => r.session_id);
}
function buildSessionOwnerMap(db, sessionId) {
  const rows = db.prepare(`SELECT
                COALESCE(
                    CASE WHEN json_extract(p.data, '$.type') = 'tool_use'
                        THEN json_extract(p.data, '$.id')
                    END,
                    json_extract(p.data, '$.callID')
                ) AS callid,
                m.id AS owner_id,
                m.time_created AS owner_t_created,
                p.id AS part_id,
                p.time_created AS part_t_created
             FROM oc_backfill.message m
             INNER JOIN oc_backfill.part p ON p.message_id = m.id
             WHERE m.session_id = ?
               AND json_extract(m.data, '$.role') = 'assistant'
               AND (
                   (json_extract(p.data, '$.type') IN ('tool', 'tool-invocation')
                       AND json_extract(p.data, '$.callID') IS NOT NULL)
                   OR (json_extract(p.data, '$.type') = 'tool_use'
                       AND json_extract(p.data, '$.id') IS NOT NULL)
               )
             ORDER BY
                 m.time_created ASC,
                 m.id ASC,
                 p.time_created ASC,
                 p.id ASC`).all(sessionId);
  const oldestByCallId = new Map;
  for (const r of rows) {
    if (typeof r.callid !== "string" || r.callid.length === 0)
      continue;
    if (!oldestByCallId.has(r.callid)) {
      oldestByCallId.set(r.callid, r.owner_id);
    }
  }
  return oldestByCallId;
}
function applyOwnersForSession(db, sessionId, ownersByCallId) {
  if (ownersByCallId.size === 0) {
    const leftNull = db.prepare(`SELECT COUNT(*) AS c FROM tags
                     WHERE session_id = ? AND type = 'tool'
                       AND tool_owner_message_id IS NULL`).get(sessionId).c;
    return { rowsUpdated: 0, rowsLeftNull: leftNull };
  }
  const findOrphanStmt = db.prepare(`SELECT id FROM tags
         WHERE session_id = ? AND message_id = ? AND type = 'tool'
           AND tool_owner_message_id IS NULL
         ORDER BY tag_number ASC
         LIMIT 1`);
  const updateRowStmt = db.prepare(`UPDATE tags
         SET tool_owner_message_id = ?
         WHERE id = ? AND tool_owner_message_id IS NULL`);
  const existingOwnerStmt = db.prepare(`SELECT 1 AS hit FROM tags
         WHERE session_id = ? AND message_id = ? AND type = 'tool'
           AND tool_owner_message_id = ?
         LIMIT 1`);
  const ownerForRowStmt = db.prepare("SELECT tool_owner_message_id FROM tags WHERE id = ?");
  let rowsUpdated = 0;
  db.transaction(() => {
    for (const [callId, ownerId] of ownersByCallId) {
      const orphan = findOrphanStmt.get(sessionId, callId);
      if (!orphan)
        continue;
      if (existingOwnerStmt.get(sessionId, callId, ownerId))
        continue;
      updateRowStmt.run(ownerId, orphan.id);
      const updated = ownerForRowStmt.get(orphan.id);
      if (updated?.tool_owner_message_id === ownerId)
        rowsUpdated += 1;
    }
  }).immediate();
  const rowsLeftNull = db.prepare(`SELECT COUNT(*) AS c FROM tags
                 WHERE session_id = ? AND type = 'tool'
                   AND tool_owner_message_id IS NULL`).get(sessionId).c;
  return { rowsUpdated, rowsLeftNull };
}
function backfillToolOwnersInChunks(db, result) {
  const sessionIds = getSessionsNeedingBackfill(db);
  let lastRenewedAt = Date.now();
  for (const sessionId of sessionIds) {
    const now = Date.now();
    result.sessionsProcessed += 1;
    const acquired = acquireSessionLease(db, sessionId, now);
    if (!acquired) {
      result.sessionsBlockedByLease += 1;
      continue;
    }
    try {
      const owners = buildSessionOwnerMap(db, sessionId);
      const { rowsUpdated, rowsLeftNull } = applyOwnersForSession(db, sessionId, owners);
      result.rowsUpdated += rowsUpdated;
      result.rowsLeftNull += rowsLeftNull;
      if (owners.size === 0) {
        markSessionSkipped(db, sessionId, Date.now(), "no_oc_matches");
        result.sessionsSkippedNoMatches += 1;
      } else if (rowsLeftNull > 0) {
        markSessionPendingRetry(db, sessionId);
      } else {
        markSessionCompleted(db, sessionId, Date.now());
        result.sessionsCompleted += 1;
      }
    } catch (error) {
      log(`[backfill] session=${sessionId} errored: ${error instanceof Error ? error.message : String(error)}`);
      markSessionErrored(db, sessionId, error);
      result.sessionsErrored += 1;
    }
    const sinceRenew = Date.now() - lastRenewedAt;
    if (sinceRenew > LEASE_RENEWAL_MS) {
      renewSessionLease(db, sessionId, Date.now());
      lastRenewedAt = Date.now();
    }
  }
}

// ../plugin/src/features/magic-context/storage-db.ts
registerSlowWriteReporter(logSlowWriteTransaction);
registerSqliteDiagnosticSink((message) => log(message));
var databases = new Map;
var pendingAsyncOpens = new Map;
var persistenceByDatabase = new WeakMap;
var persistenceErrorByDatabase = new WeakMap;
var pathByDatabase = new WeakMap;
var lastSchemaFenceRejection = null;
var lastMigrationOnOpenRefusal = null;
var lastUnconfirmedMigrationHolders = null;
var LATEST_SUPPORTED_VERSION = 94;
var BOOT_SQLITE_BUSY_TIMEOUT_MS = 5000;
var PERMISSIONS_ENFORCEABLE = process.platform !== "win32";
var defaultStoragePermissionFs = { chmodSync, mkdirSync: mkdirSync2 };
var storagePermissionFs = defaultStoragePermissionFs;
function ensureSecureStorageDir(dir) {
  if (!shouldEnforcePrivateStoragePermissions()) {
    storagePermissionFs.mkdirSync(dir, { recursive: true });
    return;
  }
  storagePermissionFs.mkdirSync(dir, { recursive: true, mode: 448 });
  if (!PERMISSIONS_ENFORCEABLE)
    return;
  try {
    storagePermissionFs.chmodSync(dir, 448);
  } catch (error) {
    log(`[magic-context] could not restrict storage dir permissions on ${dir}: ${getErrorMessage(error)}`);
  }
}
function restrictDatabaseFilePermissions(dbPath) {
  if (!PERMISSIONS_ENFORCEABLE || !shouldEnforcePrivateStoragePermissions())
    return;
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${dbPath}${suffix}`;
    if (!existsSync3(file))
      continue;
    try {
      storagePermissionFs.chmodSync(file, 384);
    } catch (error) {
      log(`[magic-context] could not restrict DB file permissions on ${file}: ${getErrorMessage(error)}`);
    }
  }
}
function resolveBootBusyTimeoutMs(value) {
  if (value === undefined)
    return BOOT_SQLITE_BUSY_TIMEOUT_MS;
  if (!Number.isFinite(value))
    return BOOT_SQLITE_BUSY_TIMEOUT_MS;
  return Math.max(0, Math.min(BOOT_SQLITE_BUSY_TIMEOUT_MS, Math.floor(value)));
}
function installBootBusyTimeout(db, dbPath, timeoutMs, report = log) {
  db.exec(`PRAGMA busy_timeout=${timeoutMs}`);
  report(`[magic-context] SQLite boot busy timeout: backend=${detectSqliteRuntime()} timeout=${timeoutMs}ms path=${dbPath}`);
}
function resolveDatabasePath(dbPathOverride) {
  if (dbPathOverride) {
    return { dbDir: dirname(dbPathOverride), dbPath: dbPathOverride };
  }
  const dbDir = getMagicContextStorageDir();
  return { dbDir, dbPath: join(dbDir, "context.db") };
}
function migrateLegacyStorageIfNeeded(targetDbPath, targetDbDir) {
  if (existsSync3(targetDbPath))
    return;
  const legacyDir = getLegacyOpenCodeMagicContextStorageDir();
  const legacyDbPath = join(legacyDir, "context.db");
  if (!existsSync3(legacyDbPath))
    return;
  log(`[magic-context] migrating legacy plugin storage: ${legacyDir} -> ${targetDbDir} (legacy left in place as backup)`);
  ensureSecureStorageDir(targetDbDir);
  try {
    const legacyDb = new Database(legacyDbPath);
    try {
      legacyDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      closeQuietly(legacyDb);
    }
  } catch (error) {
    log(`[magic-context] legacy WAL checkpoint before copy failed (continuing with sidecar copy): ${getErrorMessage(error)}`);
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = `${legacyDbPath}${suffix}`;
    const dst = join(targetDbDir, `context.db${suffix}`);
    if (existsSync3(src)) {
      try {
        copyFileSync(src, dst);
      } catch (error) {
        log(`[magic-context] failed to copy ${src}:`, getErrorMessage(error));
      }
    }
  }
  const legacyModelsDir = join(legacyDir, "models");
  const targetModelsDir = join(targetDbDir, "models");
  if (existsSync3(legacyModelsDir) && !existsSync3(targetModelsDir)) {
    try {
      cpSync(legacyModelsDir, targetModelsDir, { recursive: true });
    } catch (error) {
      log("[magic-context] failed to copy embedding model cache:", getErrorMessage(error));
    }
  }
}
function getPersistedSchemaVersion(db) {
  const hasMigrationsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!hasMigrationsTable) {
    return 0;
  }
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE version < ?").get(FORK_MIGRATION_VERSION_FLOOR);
  return row?.version ?? 0;
}
function formatSchemaFenceBootLog(persistedVersion, supportedVersion) {
  return `[magic-context] upstream migration lane at boot: database=v${persistedVersion}, supported_fence=v${supportedVersion}`;
}
function getRuntimeLatestSupportedVersion(options) {
  if (options?.latestSupportedVersion !== undefined) {
    return options.latestSupportedVersion;
  }
  const override = process.env.MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION;
  if (override) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return LATEST_SUPPORTED_VERSION;
}
function enforceSchemaFence(db, dbPath, latestSupportedVersion) {
  const persistedVersion = getPersistedSchemaVersion(db);
  if (persistedVersion <= latestSupportedVersion) {
    lastSchemaFenceRejection = null;
    return true;
  }
  lastSchemaFenceRejection = { persistedVersion, supportedVersion: latestSupportedVersion };
  log(`[magic-context] storage fatal: refusing to open ${dbPath}; upstream migration lane v${persistedVersion} is newer than this binary supports (max v${latestSupportedVersion}). A pinned or stale plugin is likely sharing this database with a newer instance; update or unpin Magic Context with 'npx @cortexkit/magic-context@latest doctor --force', then restart.`);
  return false;
}
function unreadableDiscovery(path, arm) {
  return {
    state: "unreadable",
    serverPids: [],
    staleFiles: [],
    unreadableFile: path,
    unreadableArm: arm
  };
}
var RPC_DISCOVERY_PARSE_GRACE_MS = 10 * 60 * 1000;
var defaultRpcDiscoveryFs = {
  readdirSync: (path, options) => options?.withFileTypes ? readdirSync(path, { withFileTypes: true }) : readdirSync(path),
  readFileSync: (path, encoding) => String(readFileSync3(path, encoding)),
  statSync: (path) => ({ mtimeMs: statSync2(path).mtimeMs }),
  unlinkSync: (path) => unlinkSync(path),
  rmdirSync: (path) => rmdirSync(path)
};
var rpcDiscoveryFs = defaultRpcDiscoveryFs;
function invalidDiscoveryReason(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if ("pid" in parsed) {
        const pid = Number(parsed.pid);
        if (!Number.isInteger(pid) || pid <= 0)
          return "invalid-pid";
      }
    } catch {}
  }
  return "parse-invalid";
}
function classifyDiscoveryRecordKind(record) {
  for (const value of [record.kind, record.harness]) {
    const normalized = value?.trim().toLowerCase();
    if (!normalized)
      continue;
    if (normalized === "process")
      return "process";
    if (normalized === "opencode server" || normalized === "server") {
      return "OpenCode server";
    }
    if (normalized === "opencode instance" || normalized === "opencode instance (tui/cli)" || normalized === "opencode" || normalized === "tui" || normalized === "cli") {
      return "OpenCode instance (TUI/CLI)";
    }
    if (normalized === "pi" || normalized === "pi harness" || normalized === "omp" || normalized === "oh-my-pi") {
      return "Pi";
    }
  }
  return null;
}
function classifyRpcProcess(record, commandLine) {
  return classifyDiscoveryRecordKind(record) ?? classifyProcessKind(commandLine === undefined ? readProcessProbeEvidence(record.pid).commandLine : commandLine);
}
function classifyJunkDiscovery(portFile, raw, staleFiles) {
  let mtimeMs;
  try {
    mtimeMs = rpcDiscoveryFs.statSync(portFile).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT")
      return null;
    return unreadableDiscovery(portFile, "io");
  }
  const ageMs = Date.now() - mtimeMs;
  if (!Number.isFinite(ageMs) || ageMs < RPC_DISCOVERY_PARSE_GRACE_MS) {
    return unreadableDiscovery(portFile, "parse");
  }
  staleFiles.push(portFile);
  const reason = invalidDiscoveryReason(raw);
  log(`[magic-context] removing stale RPC discovery file ${portFile}: ${reason} record older than 10 minutes`);
  return null;
}
function inspectRpcServerDiscovery(storageDir, processes, options) {
  const deadline = options?.deadlineMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + options.deadlineMs;
  let progressAt = Date.now() + 3000;
  const rpcRoot = join(storageDir, "rpc");
  let projectEntries;
  try {
    projectEntries = rpcDiscoveryFs.readdirSync(rpcRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return { state: "absent", serverPids: [], staleFiles: [] };
    }
    return unreadableDiscovery(rpcRoot, "io");
  }
  const portFiles = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory())
      continue;
    const projectDir = join(rpcRoot, projectEntry.name);
    let entries;
    try {
      entries = rpcDiscoveryFs.readdirSync(projectDir);
    } catch (error) {
      if (error.code === "ENOENT")
        continue;
      return unreadableDiscovery(projectDir, "io");
    }
    for (const entry of entries) {
      if (entry === "port" || entry.startsWith("port-") && entry.endsWith(".json")) {
        portFiles.push(join(projectDir, entry));
      }
    }
  }
  if (portFiles.length === 0) {
    return { state: "absent", serverPids: [], staleFiles: [] };
  }
  if (!processes && process.platform === "win32")
    processes = inspectWindowsProcessesSync();
  const pids = new Set;
  const processByPid = new Map;
  const staleFiles = [];
  const inconclusivePids = new Set;
  const inconclusiveRecords = [];
  for (const [index, portFile] of portFiles.entries()) {
    if (Date.now() >= deadline)
      throw new Error(`RPC holder inspection timed out after ${Math.round((options?.deadlineMs ?? 0) / 1000)} seconds (${index}/${portFiles.length} records checked). Close OpenCode and Pi, then retry.`);
    if (options?.onProgress && Date.now() >= progressAt) {
      options.onProgress(index, portFiles.length);
      progressAt = Date.now() + 3000;
    }
    let raw;
    try {
      raw = rpcDiscoveryFs.readFileSync(portFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT")
        continue;
      return unreadableDiscovery(portFile, "io");
    }
    const filename = basename(portFile);
    const pidFromName = /^port-(\d+)/.exec(filename)?.[1];
    const fallbackPid = pidFromName ? Number(pidFromName) : 0;
    const record = parseRpcPortFile(raw, fallbackPid);
    if (!record || !Number.isInteger(record.pid) || record.pid <= 0) {
      const junk = classifyJunkDiscovery(portFile, raw, staleFiles);
      if (junk)
        return junk;
      continue;
    }
    if (isOwnRpcServerRecord(record))
      continue;
    const liveness = processes ? processes.liveness(record.pid) : isPidAlive(record.pid);
    if (liveness === "dead") {
      staleFiles.push(portFile);
      continue;
    }
    const evidence = processes ? processes.evidence(record.pid) : readProcessProbeEvidence(record.pid);
    const identity = isPidIdentityPlausible(record, evidence);
    if (identity === "plausible") {
      pids.add(record.pid);
      const detected = attachFailClosedBlockingProcessEvidence({
        kind: classifyRpcProcess(record, evidence.commandLine),
        pid: record.pid
      }, evidence);
      const previous = processByPid.get(record.pid);
      if (!previous || previous.kind === "process" && detected.kind !== "process") {
        processByPid.set(record.pid, detected);
      }
    } else if (identity === "implausible") {
      staleFiles.push(portFile);
    } else {
      inconclusivePids.add(record.pid);
      inconclusiveRecords.push({
        file: portFile,
        pid: record.pid,
        recordedStartedAt: record.started_at > 0 ? record.started_at : null,
        processStartTime: evidence.startTime,
        imageName: evidence.imageName ?? null,
        commandLine: evidence.commandLine,
        liveness
      });
    }
  }
  for (const staleFile of staleFiles) {
    try {
      rpcDiscoveryFs.unlinkSync(staleFile);
    } catch {
      return unreadableDiscovery(staleFile, "io");
    }
  }
  const serverPids = [...pids].sort((a, b) => a - b);
  if (serverPids.length > 0) {
    return {
      state: "live",
      serverPids,
      serverProcesses: serverPids.map((pid) => processByPid.get(pid) ?? { kind: "process", pid }),
      staleFiles,
      ...inconclusiveRecords.length > 0 ? { inconclusiveRecords } : {}
    };
  }
  const uncertainPids = [...inconclusivePids].sort((a, b) => a - b);
  if (uncertainPids.length > 0) {
    return {
      state: "inconclusive",
      serverPids: [],
      staleFiles,
      inconclusivePids: uncertainPids,
      inconclusiveRecords
    };
  }
  return { state: "stale", serverPids: [], staleFiles };
}
function createPiBlockingProcess(pid) {
  return attachFailClosedBlockingProcessEvidence({ kind: "Pi", pid }, readProcessProbeEvidence(pid));
}
function formatInconclusiveOpenCodeMigrationWarning(dbPath, pids) {
  return `[magic-context] storage warning: continuing migration for ${dbPath}; OpenCode server PID ${pids.join(", ")} was not confirmed because its liveness or identity check could not run. This commonly means an OS sandbox denied kill(0) or ps. No live OpenCode server was confirmed.`;
}
function formatInconclusivePiMigrationWarning(dbPath, pids) {
  return `[magic-context] storage warning: continuing migration for ${dbPath}; Pi/OMP PID ${pids.join(", ")} was not confirmed as a live harness because the process image or command line was ambiguous. No live Pi harness was confirmed.`;
}
function logInconclusiveMigrationProbes(dbPath, discovery, piDiscovery) {
  const uncertainPids = discovery.inconclusivePids ?? [];
  if (uncertainPids.length > 0) {
    log(formatInconclusiveOpenCodeMigrationWarning(dbPath, uncertainPids));
  }
  if (piDiscovery.state === "unreadable") {
    log(`[magic-context] storage warning: continuing migration for ${dbPath}; the Pi/OMP process-list probe could not run, which commonly means an OS sandbox denied ps. No live Pi harness was confirmed.`);
  } else if ((piDiscovery.inconclusivePids?.length ?? 0) > 0) {
    log(formatInconclusivePiMigrationWarning(dbPath, piDiscovery.inconclusivePids ?? []));
  }
}
function isDefaultSharedDatabasePath(dbPath) {
  if (!process.env.XDG_DATA_HOME && (process.env.MAGIC_CONTEXT_TEST_DATA_DIR || false)) {
    return false;
  }
  return resolve(dbPath) === resolve(join(getMagicContextStorageDir(), "context.db"));
}
function migrationBlockingPiPids(dbPath, discovery, discoveredPiPids) {
  if (isDefaultSharedDatabasePath(dbPath))
    return [...discoveredPiPids];
  const sameDataDirPids = new Set(discovery.serverPids);
  return discoveredPiPids.filter((pid) => sameDataDirPids.has(pid));
}
function formatLiveProcessMigrationRefusal(dbPath, persistedVersion, latestSupportedVersion, serverPids, piPids) {
  const blockers = [
    ...serverPids.map((pid) => `confirmed OpenCode server PID ${pid}`),
    ...piPids.map((pid) => `confirmed Pi harness PID ${pid}`)
  ];
  return `[magic-context] storage fatal: refusing to migrate ${dbPath} from upstream migration v${persistedVersion} to v${latestSupportedVersion} while ${blockers.join(", ")} still use the old plugin build. Restart the blocking harness, then retry this process.`;
}
function enforceMigrationOnOpenGuard(db, dbPath, dbDir, latestSupportedVersion, processes) {
  const persistedVersion = getPersistedSchemaVersion(db);
  if (persistedVersion >= latestSupportedVersion) {
    lastMigrationOnOpenRefusal = null;
    return true;
  }
  const discovery = inspectRpcServerDiscovery(dbDir, processes);
  const piDiscovery = processes?.pi ?? inspectLivePiProcesses();
  const piPids = migrationBlockingPiPids(dbPath, discovery, piDiscovery.processIds);
  const serverProcesses = discovery.serverProcesses ?? (discovery.state === "live" ? discovery.serverPids.map((pid) => ({ kind: "process", pid })) : []);
  const blockingProcesses = [
    ...serverProcesses,
    ...piPids.map((pid) => processes ? attachFailClosedBlockingProcessEvidence({ kind: "Pi", pid }, processes.evidence(pid)) : createPiBlockingProcess(pid))
  ];
  if ((discovery.state === "absent" || discovery.state === "stale" || discovery.state === "inconclusive") && piPids.length === 0) {
    lastMigrationOnOpenRefusal = null;
    logInconclusiveMigrationProbes(dbPath, discovery, piDiscovery);
    const uncertainPids = discovery.inconclusivePids ?? [];
    if (uncertainPids.length > 0) {
      lastUnconfirmedMigrationHolders = {
        pids: [...uncertainPids],
        fromVersion: persistedVersion,
        toVersion: latestSupportedVersion
      };
    }
    return true;
  }
  const blockingPids = [...new Set([...discovery.serverPids, ...piPids])].sort((left, right) => left - right);
  lastMigrationOnOpenRefusal = {
    persistedVersion,
    supportedVersion: latestSupportedVersion,
    serverPids: blockingPids,
    blockingProcesses,
    ...discovery.unreadableFile ? { unreadableFile: discovery.unreadableFile } : {},
    ...discovery.unreadableArm ? { unreadableArm: discovery.unreadableArm } : {}
  };
  if (discovery.state === "unreadable") {
    const unreadableFile = discovery.unreadableFile ?? "<unknown>";
    const arm = discovery.unreadableArm ?? "io";
    const recovery = arm === "io" ? `If no OpenCode server is running, it is safe to delete ${unreadableFile} and retry.` : `Retry after the file is older than the ten-minute grace window, or stop OpenCode before deleting it.`;
    log(`[magic-context] storage fatal: refusing to migrate ${dbPath} from upstream migration v${persistedVersion} to v${latestSupportedVersion} because RPC discovery file ${unreadableFile} is uncertain (${arm} arm), so the absence of a live OpenCode server cannot be proven. ${recovery}`);
  } else {
    log(formatLiveProcessMigrationRefusal(dbPath, persistedVersion, latestSupportedVersion, discovery.serverPids, piPids));
  }
  return false;
}
var sqlitePragmaConfig = {
  cacheSizeMb: 64,
  mmapSizeMb: 0
};
function setSqlitePragmaConfig(config) {
  sqlitePragmaConfig = config;
}
function applySqliteTuningPragmas(db) {
  db.exec(`PRAGMA cache_size=-${Math.round(sqlitePragmaConfig.cacheSizeMb * 1024)}`);
  db.exec(`PRAGMA mmap_size=${Math.round(sqlitePragmaConfig.mmapSizeMb * 1024 * 1024)}`);
  db.exec("PRAGMA analysis_limit=400");
}
function finishDatabaseOpen(db, dbPath, explicitDbPath, latestSupportedVersion) {
  if (!enforceSchemaFence(db, dbPath, latestSupportedVersion)) {
    closeQuietly(db);
    return null;
  }
  healWedgedChannel2Claims(db);
  if (!explicitDbPath) {
    const readsOpenCodeStore = harnessOwnsOpenCodeStore();
    let busyRetryMs = 100;
    const runBackfills = () => withoutSqliteTransformPass(() => withSqliteBackgroundWriter(() => {
      if (readsOpenCodeStore) {
        try {
          runToolOwnerBackfill(db);
        } catch (error) {
          log(`[magic-context] tool-owner backfill failed (continuing with lazy adoption fallback): ${getErrorMessage(error)}`);
        }
      }
      startMessageFtsRowidMapBackfill(db).then(async () => {
        if (!readsOpenCodeStore)
          return;
        const { readRawSessionMessagePage, readRawSessionMessages } = await importPluginModule(() => import("./chunk-yh989bh5.js"));
        const { startMessageTimeBackfill } = await importPluginModule(() => import("./chunk-04kgnzmd.js"));
        await startMessageTimeBackfill(db, Object.assign(readRawSessionMessages, {
          readPage: readRawSessionMessagePage
        }));
      }).catch((error) => {
        if (isTransientSqliteError(error)) {
          withoutSqliteTransformPass(() => {
            const timer = setTimeout(runBackfills, busyRetryMs);
            timer.unref();
          });
          busyRetryMs = Math.min(30000, busyRetryMs * 2);
          return;
        }
        log(`[magic-context] message-index backfill failed (will resume next startup): ${getErrorMessage(error)}`);
      });
    }));
    if (bootQuietRemainingMs() > 0)
      scheduleAfterBootQuiet(runBackfills);
    else
      runBackfills();
  }
  setDatabase(db);
  loadToolDefinitionMeasurements(db);
  restrictDatabaseFilePermissions(dbPath);
  databases.set(dbPath, db);
  pathByDatabase.set(db, dbPath);
  persistenceByDatabase.set(db, true);
  persistenceErrorByDatabase.delete(db);
  if (!explicitDbPath) {
    log(formatSchemaFenceBootLog(getPersistedSchemaVersion(db), latestSupportedVersion));
  }
  return db;
}
function initializeDatabase(db, busyTimeoutMs = BOOT_SQLITE_BUSY_TIMEOUT_MS) {
  db.exec(`PRAGMA busy_timeout=${resolveBootBusyTimeoutMs(busyTimeoutMs)}`);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA journal_mode=WAL");
  applySqliteTuningPragmas(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message_id TEXT,
      type TEXT,
      status TEXT DEFAULT 'active',
      byte_size INTEGER,
      tag_number INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode',
      entry_fingerprint TEXT,
      token_count INTEGER,
      input_token_count INTEGER,
      reasoning_token_count INTEGER,
      UNIQUE(session_id, tag_number)
    );

    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

    CREATE TABLE IF NOT EXISTS source_contents (
      tag_id INTEGER,
      session_id TEXT,
      content TEXT,
      created_at INTEGER, -- epoch ms; Date.now() on source writes, preserved on session clones
      harness TEXT NOT NULL DEFAULT 'opencode',
      PRIMARY KEY(session_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      start_message INTEGER NOT NULL,
      end_message INTEGER NOT NULL,
      start_message_id TEXT DEFAULT '',
      end_message_id TEXT DEFAULT '',
      start_block_index INTEGER,
      end_block_index INTEGER,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      p1 TEXT,
      p2 TEXT,
      p3 TEXT,
      p4 TEXT,
      importance INTEGER NOT NULL DEFAULT 50,
      episode_type TEXT,
      p1_embedding BLOB,
      p1_embedding_model_id TEXT,
      legacy INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, -- epoch ms (Date.now())
      harness TEXT NOT NULL DEFAULT 'opencode',
      UNIQUE(session_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_compartments_session ON compartments(session_id);

    CREATE TABLE IF NOT EXISTS compartment_chunk_embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      project_path TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      window_index INTEGER NOT NULL DEFAULT 0,
      start_ordinal INTEGER NOT NULL,
      end_ordinal INTEGER NOT NULL,
      chunk_hash TEXT NOT NULL,
      model_id TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector BLOB NOT NULL,
      created_at INTEGER NOT NULL, -- epoch ms (Date.now())
      UNIQUE(compartment_id, model_id, window_index)
    );
    CREATE INDEX IF NOT EXISTS idx_cce_session ON compartment_chunk_embeddings(session_id);
    CREATE INDEX IF NOT EXISTS idx_cce_project_model ON compartment_chunk_embeddings(project_path, model_id);

    CREATE TABLE IF NOT EXISTS session_projects (
      session_id TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      project_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, harness)
    );
    CREATE INDEX IF NOT EXISTS idx_session_projects_project
      ON session_projects(project_path);

    CREATE TABLE IF NOT EXISTS compartment_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      compartment_id INTEGER,
      kind TEXT NOT NULL,
      at_compartment INTEGER,
      fields_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL, -- epoch ms (Date.now())
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
    CREATE INDEX IF NOT EXISTS idx_compartment_events_session
      ON compartment_events(session_id);

    CREATE TABLE IF NOT EXISTS compartment_state_lease (
      session_id TEXT PRIMARY KEY NOT NULL,
      holder_id TEXT NOT NULL,
      owner_pid INTEGER,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_compartment_state_lease_expires
      ON compartment_state_lease(expires_at);

    CREATE TABLE IF NOT EXISTS compression_depth (
      session_id TEXT NOT NULL,
      message_ordinal INTEGER NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode',
      PRIMARY KEY(session_id, message_ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_compression_depth_session ON compression_depth(session_id);

    CREATE TABLE IF NOT EXISTS session_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL, -- epoch ms (Date.now())
      updated_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

    CREATE TABLE IF NOT EXISTS primer_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      session_id TEXT NOT NULL,
      question TEXT NOT NULL,
      normalized_question TEXT NOT NULL,
      source_compartment_start INTEGER,
      source_compartment_end INTEGER,
      source_start_message_id TEXT NOT NULL DEFAULT '',
      source_end_message_id TEXT NOT NULL DEFAULT '',
      source_message_time INTEGER NOT NULL,
      question_embedding BLOB,
      question_embedding_model_id TEXT,
      created_at INTEGER NOT NULL, -- epoch ms (Date.now())
      UNIQUE(project_path, harness, session_id, source_start_message_id, source_end_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_primer_candidates_project_time
      ON primer_candidates(project_path, source_message_time);
    CREATE INDEX IF NOT EXISTS idx_primer_candidates_session
      ON primer_candidates(session_id, harness);
    CREATE INDEX IF NOT EXISTS idx_primer_candidates_embedding_model
      ON primer_candidates(project_path, question_embedding_model_id);

    CREATE TABLE IF NOT EXISTS primers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      question TEXT NOT NULL,
      question_embedding BLOB,
      question_embedding_model_id TEXT,
      answer TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
      total_support INTEGER NOT NULL DEFAULT 0,
      last_observed_at INTEGER,
      answer_refreshed_at INTEGER,
      source_candidate_ids TEXT NOT NULL DEFAULT '[]',
      source_candidate_provenance TEXT,
      created_at INTEGER NOT NULL, -- epoch ms (Date.now())
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_primers_project_status_observed
      ON primers(project_path, status, last_observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_primers_embedding_model
      ON primers(project_path, question_embedding_model_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS primers_fts USING fts5(
      question,
      answer,
      project_path UNINDEXED,
      content='primers',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS primers_ai AFTER INSERT ON primers BEGIN
      INSERT INTO primers_fts(rowid, question, answer, project_path)
      VALUES (new.id, new.question, new.answer, new.project_path);
    END;

    CREATE TRIGGER IF NOT EXISTS primers_ad AFTER DELETE ON primers BEGIN
      INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
      VALUES ('delete', old.id, old.question, old.answer, old.project_path);
    END;

    CREATE TRIGGER IF NOT EXISTS primers_au AFTER UPDATE ON primers BEGIN
      INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
      VALUES ('delete', old.id, old.question, old.answer, old.project_path);
      INSERT INTO primers_fts(rowid, question, answer, project_path)
      VALUES (new.id, new.question, new.answer, new.project_path);
    END;

    -- session_notes and smart_notes were merged into the unified notes table
    -- by migration v1 (see features/magic-context/migrations.ts). The old tables
    -- are never recreated; fresh DBs create only notes, upgraded DBs have
    -- their old tables migrated and dropped by the migration runner.

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      importance INTEGER,
      scope TEXT NOT NULL DEFAULT 'project',
      shareable INTEGER NOT NULL DEFAULT 0,
      source_session_id TEXT,
      source_type TEXT DEFAULT 'historian',
      seen_count INTEGER DEFAULT 1,
      retrieval_count INTEGER DEFAULT 0,
      first_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      last_retrieved_at INTEGER,
      status TEXT DEFAULT 'active',
      expires_at INTEGER,
      verification_status TEXT DEFAULT 'unverified',
      verified_at INTEGER,
      classified_at INTEGER,
      superseded_by_memory_id INTEGER,
      merged_from TEXT,
      metadata_json TEXT,
      mural_cue TEXT,
      mural_cue_hash TEXT,
      mural_cue_at INTEGER,
      mural_cue_rejection_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(project_path, category, normalized_hash)
    );

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      -- FK-cascade audit (v12): memory_embeddings.memory_id -> memories.id
      -- uses ON DELETE CASCADE, so SQLite PRAGMA foreign_keys must be ON on
      -- every connection and v12 cleans historical orphan rows.
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model_id TEXT NOT NULL,
      PRIMARY KEY(memory_id, model_id)
    );

    CREATE TABLE IF NOT EXISTS embedding_identity_active (
      project_path TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('memory', 'commit', 'chunk')),
      model_id TEXT NOT NULL,
      last_active_at INTEGER NOT NULL,
      PRIMARY KEY(project_path, scope, model_id)
    );

    CREATE TABLE IF NOT EXISTS embedding_registrations (
      project_path TEXT PRIMARY KEY,
      provider_identity TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      chunk_model_id TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL DEFAULT '',
      table_epoch INTEGER NOT NULL DEFAULT 0,
      dims INTEGER NOT NULL DEFAULT 0,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      generation INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS synapse_batch_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_path TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      manifest_json TEXT NOT NULL DEFAULT '{}',
      request_key TEXT NOT NULL DEFAULT '',
      job_id TEXT,
      cursor TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT 0, -- epoch ms (Date.now())
      updated_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, request_key)
    );
    CREATE INDEX IF NOT EXISTS idx_synapse_batch_ledger_session
      ON synapse_batch_ledger(session_id, updated_at);

    CREATE TABLE IF NOT EXISTS shadow_embedding_registrations (
      project_path TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('memory', 'commit', 'chunk')),
      model_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      fingerprint TEXT NOT NULL DEFAULT '',
      table_epoch INTEGER NOT NULL DEFAULT 0,
      dims INTEGER NOT NULL DEFAULT 0,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_path, scope, model_id)
    );

    CREATE TABLE IF NOT EXISTS embedding_measurement_corpus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_path TEXT NOT NULL DEFAULT '',
      dedup_key TEXT NOT NULL DEFAULT '',
      cohort_key TEXT NOT NULL DEFAULT '',
      query_text_hash TEXT NOT NULL DEFAULT '',
      primary_result_ids_json TEXT NOT NULL DEFAULT '[]',
      shadow_result_ids_json TEXT NOT NULL DEFAULT '[]',
      primary_latency_ms INTEGER,
      shadow_latency_ms INTEGER,
      primary_failed INTEGER NOT NULL DEFAULT 0,
      shadow_failed INTEGER NOT NULL DEFAULT 0,
      primary_model_id TEXT NOT NULL DEFAULT '',
      shadow_model_id TEXT NOT NULL DEFAULT '',
      primary_fingerprint TEXT NOT NULL DEFAULT '',
      shadow_fingerprint TEXT NOT NULL DEFAULT '',
      primary_epoch INTEGER NOT NULL DEFAULT 0,
      shadow_epoch INTEGER NOT NULL DEFAULT 0,
      corpus_hash TEXT NOT NULL DEFAULT '',
      coverage_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT 0, -- epoch ms (Date.now())
      UNIQUE(dedup_key, cohort_key)
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_measurement_session
      ON embedding_measurement_corpus(session_id, created_at);

    CREATE TABLE IF NOT EXISTS memory_verifications (
      memory_id    INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      file_path    TEXT NOT NULL,
      -- verified_at=0 means "mapped (files known) but not yet content-verified".
      -- map-memories sets mapped_at + verified_at=0; verify sets verified_at=now.
      verified_at  INTEGER NOT NULL,
       mapped_at    INTEGER NOT NULL DEFAULT 0,
       -- Distinguishes mapper-authored independence from a host rejection fallback.
       mapping_origin TEXT NOT NULL DEFAULT 'mapper',
       PRIMARY KEY (memory_id, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_verifications_memory ON memory_verifications(memory_id);

    CREATE TABLE IF NOT EXISTS memory_mutation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      mutation_type TEXT NOT NULL CHECK (mutation_type IN ('archive', 'delete', 'update', 'superseded')),
      target_memory_id INTEGER NOT NULL,
      superseded_by_id INTEGER,
      category TEXT,
      new_content TEXT,
      queued_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_project
      ON memory_mutation_log(project_path, id);
    CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_visibility
      ON memory_mutation_log(project_path, category, id, target_memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_target
      ON memory_mutation_log(project_path, target_memory_id, id);

    CREATE TABLE IF NOT EXISTS dream_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dream_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      reason TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL,
      started_at INTEGER,
      retry_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dream_queue_project ON dream_queue(project_path);
CREATE INDEX IF NOT EXISTS idx_dream_queue_pending ON dream_queue(started_at, enqueued_at);

    CREATE TABLE IF NOT EXISTS dream_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      holder_id TEXT NOT NULL,
      tasks_json TEXT NOT NULL,
      tasks_succeeded INTEGER NOT NULL DEFAULT 0,
      tasks_failed INTEGER NOT NULL DEFAULT 0,
      smart_notes_surfaced INTEGER NOT NULL DEFAULT 0,
      smart_notes_pending INTEGER NOT NULL DEFAULT 0,
      memory_changes_json TEXT,
      parent_session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dream_runs_project ON dream_runs(project_path, finished_at DESC);

    CREATE TABLE IF NOT EXISTS task_schedule_state (
      project_path  TEXT    NOT NULL,
      task          TEXT    NOT NULL,
      last_run_at   INTEGER,
      next_due_at   INTEGER,
      schedule      TEXT,
      last_status   TEXT,
      last_error    TEXT,
      last_checked_commit TEXT,
      last_broad_run_at INTEGER,
      retrospective_watermark_ms INTEGER,
      retry_count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_path, task)
    );
    CREATE INDEX IF NOT EXISTS idx_task_schedule_due ON task_schedule_state(next_due_at);

    CREATE TABLE IF NOT EXISTS retrospective_processed_windows (
      project_path TEXT NOT NULL,
      window_key   TEXT NOT NULL,
      processed_at INTEGER NOT NULL,
      PRIMARY KEY (project_path, window_key)
    );

    CREATE TABLE IF NOT EXISTS project_key_files (
      project_path           TEXT    NOT NULL,
      path                   TEXT    NOT NULL,
      content                TEXT    NOT NULL,
      content_hash           TEXT    NOT NULL,
      local_token_estimate   INTEGER NOT NULL,
      generated_at           INTEGER NOT NULL,
      generated_by_model     TEXT,
      generation_config_hash TEXT    NOT NULL,
      stale_reason           TEXT,
      PRIMARY KEY (project_path, path)
    );
    CREATE INDEX IF NOT EXISTS idx_project_key_files_project ON project_key_files(project_path);
    CREATE INDEX IF NOT EXISTS idx_project_key_files_generated_at ON project_key_files(project_path, generated_at);

    CREATE TABLE IF NOT EXISTS project_key_files_version (
      project_path TEXT    PRIMARY KEY,
      version      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS schema_migrations_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_state (
      project_path TEXT PRIMARY KEY,
      project_memory_epoch INTEGER NOT NULL DEFAULT 0,
      project_user_profile_version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS git_sweep_coordinator (
      project_path TEXT PRIMARY KEY,
      lease_holder TEXT,
      lease_expires_at INTEGER,
      last_swept_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_git_sweep_coordinator_lease_expires
      ON git_sweep_coordinator(lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_git_sweep_coordinator_last_swept
      ON git_sweep_coordinator(last_swept_at);

    CREATE TABLE IF NOT EXISTS m0_mutation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      mutation_type TEXT NOT NULL CHECK (mutation_type IN (
        'compartment_delete', 'compartment_merge', 'recomp_boundary_change', 'compartment_upgrade'
      )),
      target_id INTEGER,
      queued_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_m0_mutation_log_session ON m0_mutation_log(session_id);

    CREATE TABLE IF NOT EXISTS v22_identity_rekey_map (
      old_project_path TEXT PRIMARY KEY,
      new_project_path TEXT NOT NULL,
      rekeyed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'
    );

    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      display_path TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, project_path)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_unique ON workspace_members(project_path);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_name ON workspace_members(workspace_id, display_name);

    CREATE TABLE IF NOT EXISTS v22_backfill_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      raw_project_path TEXT NOT NULL,
      error_class TEXT NOT NULL CHECK (error_class IN ('not_git_repo', 'git_missing', 'git_timeout', 'permission_denied', 'unknown')),
      error_message TEXT,
      failed_at INTEGER NOT NULL,
      UNIQUE(table_name, row_id)
    );

    -- (smart_notes: see note above; merged into unified notes table by migration v1)

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      category,
      content='memories',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS message_history_fts USING fts5(
      session_id UNINDEXED,
      message_ordinal UNINDEXED,
      message_id UNINDEXED,
      role,
      content,
      tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS message_fts_rowid_map (
      session_id TEXT NOT NULL,
      message_ordinal INTEGER NOT NULL,
      fts_rowid INTEGER NOT NULL,
      message_time_ms INTEGER,
      PRIMARY KEY(session_id, message_ordinal)
    );

    CREATE TABLE IF NOT EXISTS message_fts_rowid_map_backfill_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      watermark_rowid INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO message_fts_rowid_map_backfill_state
      (id, watermark_rowid, completed, updated_at)
    VALUES (1, 0, 0, 0);

    CREATE TABLE IF NOT EXISTS message_time_backfill_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      cursor_session_id TEXT NOT NULL DEFAULT '',
      cursor_ordinal INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO message_time_backfill_state
      (id, cursor_session_id, cursor_ordinal, completed, updated_at)
    VALUES (1, '', 0, 0, 0);

    CREATE TABLE IF NOT EXISTS single_store_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL CHECK (state IN ('required', 'migrated')),
      migrated_at INTEGER,
      migrated_by TEXT,
      backup_dir TEXT,
      report_json TEXT
    );
    INSERT OR IGNORE INTO single_store_state(id, state) VALUES (1, 'required');

    -- Highest memory id another writer (the Rust module in single-store mode) put
    -- into memories for a project, and how far this host has embedded. Migration v91.
    CREATE TABLE IF NOT EXISTS memory_embedding_watermarks (
      project_path TEXT PRIMARY KEY,
      written_memory_id INTEGER NOT NULL DEFAULT 0,
      embedded_memory_id INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    -- Last-known-good replay slots, their prefix slices, and trailing-blank replay
    -- decisions, in the layout of migration v94.
    ${LKG_SLOTS_DDL}
    ${LKG_SLOT_CHUNKS_DDL}
    ${SESSION_REPLAY_DECISIONS_DDL}

    CREATE TABLE IF NOT EXISTS message_history_index (
      session_id TEXT PRIMARY KEY,
      last_indexed_ordinal INTEGER NOT NULL DEFAULT 0,
      dirty_floor_ordinal INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

    CREATE TABLE IF NOT EXISTS message_history_source (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      message_ordinal INTEGER NOT NULL,
      source_version TEXT NOT NULL,
      normalized_content_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_history_source_session_ordinal
      ON message_history_source(session_id, message_ordinal);

    CREATE TABLE IF NOT EXISTS pending_session_cleanup (
      session_id TEXT PRIMARY KEY,
      harness TEXT NOT NULL DEFAULT 'opencode',
      requested_at INTEGER NOT NULL,
      last_attempt_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS message_history_orphan_sweep (
      harness TEXT PRIMARY KEY,
      cursor_session_id TEXT NOT NULL DEFAULT '',
      last_swept_at INTEGER
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
      INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
    END;

    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      harness TEXT NOT NULL DEFAULT 'opencode',
      last_response_time INTEGER,
      cache_ttl TEXT,
      counter INTEGER DEFAULT 0,
      tags_version INTEGER NOT NULL DEFAULT 0,
      last_nudge_tokens INTEGER DEFAULT 0,
      last_nudge_band TEXT DEFAULT '',
      last_nudge_undropped INTEGER DEFAULT 0,
      last_nudge_level TEXT DEFAULT '',
      channel2_nudge_state TEXT DEFAULT '',
      channel2_nudge_claimed_at INTEGER DEFAULT 0,
      channel2_nudge_claim_token TEXT DEFAULT '',
      last_emergency_input_sample INTEGER DEFAULT 0,
      last_transform_error TEXT DEFAULT '',
      nudge_anchor_message_id TEXT DEFAULT '',
      nudge_anchor_text TEXT DEFAULT '',
      sticky_turn_reminder_text TEXT DEFAULT '',
      sticky_turn_reminder_message_id TEXT DEFAULT '',
      note_nudge_trigger_pending INTEGER DEFAULT 0,
      note_nudge_trigger_message_id TEXT DEFAULT '',
      note_nudge_sticky_text TEXT DEFAULT '',
      note_nudge_sticky_message_id TEXT DEFAULT '',
      note_nudge_anchors TEXT NOT NULL DEFAULT '[]',
      auto_search_hint_decisions TEXT NOT NULL DEFAULT '[]',
      last_todo_state TEXT DEFAULT '',
      todo_permission_denied INTEGER NOT NULL DEFAULT 2,
      todo_synthetic_call_id TEXT DEFAULT '',
      todo_synthetic_anchor_message_id TEXT DEFAULT '',
      todo_synthetic_state_json TEXT DEFAULT '',
      is_subagent INTEGER DEFAULT 0,
      last_context_percentage REAL DEFAULT 0,
      last_input_tokens INTEGER DEFAULT 0,
      detected_context_limit_provenance TEXT NOT NULL DEFAULT 'unknown',
      observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_alert_sent INTEGER NOT NULL DEFAULT 0,
      times_execute_threshold_reached INTEGER DEFAULT 0,
      compartment_in_progress INTEGER DEFAULT 0,
      historian_failure_count INTEGER DEFAULT 0,
      historian_last_error TEXT DEFAULT NULL,
      historian_last_failure_at INTEGER DEFAULT NULL,
      system_prompt_hash TEXT DEFAULT '',
      memory_block_cache TEXT DEFAULT '',
      memory_block_count INTEGER DEFAULT 0,
      memory_block_ids TEXT DEFAULT '',
      -- pending_compaction_marker_state: intentionally NULLABLE without a
      -- default. Absence of a deferred marker is SQL NULL; presence is a
      -- valid JSON blob written via setPendingCompactionMarkerState.
      -- Excluded from the healAllNullColumns fallback list. Readers filter
      -- IS NOT NULL AND != empty-string defensively. Plan v6 section 3.
      pending_compaction_marker_state TEXT,
      -- Target OpenCode message id used to inject the current compaction marker.
      -- Nullable for legacy persisted markers; repaired on the next marker move.
      compaction_marker_target_end_message_id TEXT,
      -- pending_pi_compaction_marker_state: intentionally NULLABLE without a
      -- default. Absence of a deferred Pi-native marker is SQL NULL; presence
      -- is a valid JSON blob written via setPendingPiCompactionMarkerState.
      -- Excluded from the healAllNullColumns fallback list.
      pending_pi_compaction_marker_state TEXT,
      new_work_tokens INTEGER NOT NULL DEFAULT 0,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      -- Retired columns remain in place so existing databases keep the same schema:
      -- deferred_execute_state was used by the removed turn-boundary execute hold.
      deferred_execute_state TEXT,
      cached_m0_bytes BLOB,
      cached_m0_project_memory_epoch INTEGER,
      cached_m0_workspace_fingerprint TEXT,
      cached_m0_project_user_profile_version INTEGER,
      cached_m0_max_compartment_seq INTEGER,
      cached_m0_max_memory_id INTEGER,
      cached_m0_max_mutation_id INTEGER,
      cached_m0_max_memory_mutation_id INTEGER,
      cached_m0_project_docs_hash TEXT,
      cached_m1_bytes BLOB,
      last_observed_model_key TEXT,
      last_usage_context_limit INTEGER NOT NULL DEFAULT 0,
      prior_boundary_ordinal INTEGER NOT NULL DEFAULT 1,
      protected_tokens_effective INTEGER,
      protected_tokens_pre_snapshot TEXT,
      protected_tail_policy_version INTEGER NOT NULL DEFAULT 0,
      protected_tail_drain_window_started_at INTEGER NOT NULL DEFAULT 0,
      protected_tail_drain_tokens INTEGER NOT NULL DEFAULT 0,
      recovery_no_eligible_head_count INTEGER NOT NULL DEFAULT 0,
      force_emergency_bypass_window_start INTEGER NOT NULL DEFAULT 0,
      force_emergency_bypass_used INTEGER NOT NULL DEFAULT 0,
      emergency_drain_active INTEGER NOT NULL DEFAULT 0,
      historian_drain_failure_at INTEGER NOT NULL DEFAULT 0,
      wrapup_in_progress_state TEXT,
      compaction_mode_record TEXT,
      cached_m0_materialized_at INTEGER,
      cached_m0_session_facts_version INTEGER,
      cached_m0_upgrade_state TEXT,
      cached_m0_system_hash TEXT,
      cached_m0_tool_set_hash TEXT,
      cached_m0_model_key TEXT,
       cached_m0_project_identity TEXT,
       cached_m0_last_baseline_end_message_id TEXT,
       thinking_binding_recovery_target TEXT NOT NULL DEFAULT '',
       upgrade_reminded_at INTEGER,
       pi_stable_id_scheme INTEGER
    );

    CREATE TABLE IF NOT EXISTS tool_owner_backfill_state (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'skipped')),
      started_at INTEGER,
      lease_expires_at INTEGER,
      completed_at INTEGER,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_owner_backfill_state_status
      ON tool_owner_backfill_state(status);

    CREATE TABLE IF NOT EXISTS subagent_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      harness TEXT NOT NULL,
      subagent TEXT NOT NULL,
      task TEXT,
      provider_id TEXT,
      model_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      parent_invocation_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sai_session_started
      ON subagent_invocations(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sai_subagent
      ON subagent_invocations(subagent, started_at DESC);

    CREATE TABLE IF NOT EXISTS historian_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode',
      subagent_invocation_id INTEGER,
      run_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_reason TEXT,
      chunk_start_ordinal INTEGER,
      chunk_end_ordinal INTEGER,
      unprocessed_from INTEGER,
      compartments_produced INTEGER NOT NULL DEFAULT 0,
      compartment_id_min INTEGER,
      compartment_id_max INTEGER,
      facts_emitted INTEGER NOT NULL DEFAULT 0,
      facts_by_category_json TEXT,
      events_emitted INTEGER NOT NULL DEFAULT 0,
      importance_min INTEGER,
      importance_max INTEGER,
      importance_avg REAL,
      discarded_last INTEGER NOT NULL DEFAULT 0,
      legacy INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL -- epoch ms (Date.now())
    );
    CREATE INDEX IF NOT EXISTS idx_historian_runs_session
      ON historian_runs(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_historian_runs_status
      ON historian_runs(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS transform_decisions (
      session_id         TEXT    NOT NULL,
      harness            TEXT    NOT NULL DEFAULT 'opencode',
      message_id         TEXT    NOT NULL,
      ts_ms              INTEGER NOT NULL,
      decision           TEXT    NOT NULL,
      materialized       INTEGER NOT NULL DEFAULT 0,
      materialize_reason TEXT,
      system_hash_prev      TEXT,
      system_hash_new       TEXT,
      m0_tool_set_hash_prev TEXT,
      m0_tool_set_hash_new  TEXT,
      m0_model_key_prev     TEXT,
      m0_model_key_new      TEXT,
      emergency          INTEGER NOT NULL DEFAULT 0,
      dropped_tokens     INTEGER NOT NULL DEFAULT 0,
      dropped_count      INTEGER NOT NULL DEFAULT 0,
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, harness, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_transform_decisions_session_harness
      ON transform_decisions(session_id, harness);

    CREATE INDEX IF NOT EXISTS idx_tags_session_tag_number ON tags(session_id, tag_number);
    CREATE INDEX IF NOT EXISTS idx_tags_session_message_id ON tags(session_id, message_id);

    -- Clone/import paths can write tags before session bootstrap. Keep trigger-created
    -- metadata rows aligned with the explicit defaults in ensureSessionMetaRow.
    CREATE TRIGGER IF NOT EXISTS tags_version_ai AFTER INSERT ON tags BEGIN
      INSERT INTO session_meta(
        session_id, harness, last_response_time, cache_ttl, counter, tags_version,
        last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent,
        last_context_percentage, last_input_tokens, observed_safe_input_tokens,
        cache_alert_sent, times_execute_threshold_reached, compartment_in_progress,
        system_prompt_hash, cleared_reasoning_through_tag
      ) VALUES(NEW.session_id, NEW.harness, 0, '5m', 0, 1, 0, '', '', 0, 0, 0, 0, 0, 0, 0, '', 0)
      ON CONFLICT(session_id) DO UPDATE SET tags_version = tags_version + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS tags_version_ad AFTER DELETE ON tags BEGIN
      INSERT INTO session_meta(
        session_id, harness, last_response_time, cache_ttl, counter, tags_version,
        last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent,
        last_context_percentage, last_input_tokens, observed_safe_input_tokens,
        cache_alert_sent, times_execute_threshold_reached, compartment_in_progress,
        system_prompt_hash, cleared_reasoning_through_tag
      ) VALUES(OLD.session_id, OLD.harness, 0, '5m', 0, 1, 0, '', '', 0, 0, 0, 0, 0, 0, 0, '', 0)
      ON CONFLICT(session_id) DO UPDATE SET tags_version = tags_version + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS tags_version_au
    AFTER UPDATE OF session_id, message_id, tag_number, type, tool_owner_message_id, status ON tags BEGIN
      INSERT INTO session_meta(
        session_id, harness, last_response_time, cache_ttl, counter, tags_version,
        last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent,
        last_context_percentage, last_input_tokens, observed_safe_input_tokens,
        cache_alert_sent, times_execute_threshold_reached, compartment_in_progress,
        system_prompt_hash, cleared_reasoning_through_tag
      ) VALUES(OLD.session_id, OLD.harness, 0, '5m', 0, 1, 0, '', '', 0, 0, 0, 0, 0, 0, 0, '', 0)
      ON CONFLICT(session_id) DO UPDATE SET tags_version = tags_version + 1;
      INSERT INTO session_meta(
        session_id, harness, last_response_time, cache_ttl, counter, tags_version,
        last_nudge_tokens, last_nudge_band, last_transform_error, is_subagent,
        last_context_percentage, last_input_tokens, observed_safe_input_tokens,
        cache_alert_sent, times_execute_threshold_reached, compartment_in_progress,
        system_prompt_hash, cleared_reasoning_through_tag
      )
      SELECT NEW.session_id, NEW.harness, 0, '5m', 0, 1, 0, '', '', 0, 0, 0, 0, 0, 0, 0, '', 0
      WHERE NEW.session_id != OLD.session_id
      ON CONFLICT(session_id) DO UPDATE SET tags_version = tags_version + 1;
    END;
    CREATE INDEX IF NOT EXISTS idx_pending_ops_session ON pending_ops(session_id);
    CREATE INDEX IF NOT EXISTS idx_pending_ops_session_tag_id ON pending_ops(session_id, tag_id);
    CREATE INDEX IF NOT EXISTS idx_source_contents_session ON source_contents(session_id);
    
    CREATE TABLE IF NOT EXISTS recomp_compartments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      start_message INTEGER NOT NULL,
      end_message INTEGER NOT NULL,
      start_message_id TEXT DEFAULT '',
      end_message_id TEXT DEFAULT '',
      start_block_index INTEGER,
      end_block_index INTEGER,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      p1 TEXT,
      p2 TEXT,
      p3 TEXT,
      p4 TEXT,
      importance INTEGER NOT NULL DEFAULT 50,
      episode_type TEXT,
      pass_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL, -- epoch ms (Date.now())
      harness TEXT NOT NULL DEFAULT 'opencode',
      UNIQUE(session_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS recomp_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      pass_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL, -- epoch ms (Date.now())
      harness TEXT NOT NULL DEFAULT 'opencode'
    );

    CREATE INDEX IF NOT EXISTS idx_session_facts_session ON session_facts(session_id);
    CREATE INDEX IF NOT EXISTS idx_recomp_compartments_session ON recomp_compartments(session_id);
    CREATE INDEX IF NOT EXISTS idx_recomp_facts_session ON recomp_facts(session_id);
    CREATE INDEX IF NOT EXISTS idx_memories_project_status_category ON memories(project_path, status, category);
    CREATE INDEX IF NOT EXISTS idx_memories_project_status_expires ON memories(project_path, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_memories_project_category_hash ON memories(project_path, category, normalized_hash);
    CREATE INDEX IF NOT EXISTS idx_message_history_index_updated_at ON message_history_index(updated_at);
  `);
  installCompartmentHistoryVersions(db);
  ensureColumn(db, "message_fts_rowid_map", "message_time_ms", "INTEGER");
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_message_fts_rowid_map_session_time
        ON message_fts_rowid_map(session_id, message_time_ms);
    `);
  ensureColumn(db, "primer_candidates", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
  ensureColumn(db, "primer_candidates", "source_start_message_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "primer_candidates", "source_end_message_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "primer_candidates", "question_embedding", "BLOB");
  ensureColumn(db, "primer_candidates", "question_embedding_model_id", "TEXT");
  ensureColumn(db, "primers", "question_embedding_model_id", "TEXT");
  ensureColumn(db, "primers", "source_candidate_provenance", "TEXT");
  const hasUserMemoriesTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_memories'").get();
  if (hasUserMemoriesTable) {
    ensureColumn(db, "user_memories", "source_candidate_provenance", "TEXT");
  }
  db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_primer_candidates_occurrence
        ON primer_candidates(project_path, harness, session_id, source_start_message_id, source_end_message_id);
      CREATE INDEX IF NOT EXISTS idx_primer_candidates_project_time
        ON primer_candidates(project_path, source_message_time);
      CREATE INDEX IF NOT EXISTS idx_primer_candidates_session
        ON primer_candidates(session_id, harness);
      CREATE INDEX IF NOT EXISTS idx_primer_candidates_embedding_model
        ON primer_candidates(project_path, question_embedding_model_id);
      CREATE INDEX IF NOT EXISTS idx_primers_project_status_observed
        ON primers(project_path, status, last_observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_primers_embedding_model
        ON primers(project_path, question_embedding_model_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS primers_fts USING fts5(
        question,
        answer,
        project_path UNINDEXED,
        content='primers',
        content_rowid='id',
        tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS primers_ai AFTER INSERT ON primers BEGIN
        INSERT INTO primers_fts(rowid, question, answer, project_path)
        VALUES (new.id, new.question, new.answer, new.project_path);
      END;
      CREATE TRIGGER IF NOT EXISTS primers_ad AFTER DELETE ON primers BEGIN
        INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
        VALUES ('delete', old.id, old.question, old.answer, old.project_path);
      END;
      CREATE TRIGGER IF NOT EXISTS primers_au AFTER UPDATE ON primers BEGIN
        INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
        VALUES ('delete', old.id, old.question, old.answer, old.project_path);
        INSERT INTO primers_fts(rowid, question, answer, project_path)
        VALUES (new.id, new.question, new.answer, new.project_path);
      END;
    `);
  ensureColumn(db, "session_meta", "last_nudge_band", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "last_nudge_undropped", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "last_nudge_level", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "channel2_nudge_state", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "channel2_nudge_claimed_at", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "channel2_nudge_claim_token", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "last_emergency_input_sample", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "last_transform_error", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "nudge_anchor_message_id", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "nudge_anchor_text", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "sticky_turn_reminder_text", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "sticky_turn_reminder_message_id", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "note_nudge_trigger_pending", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "note_nudge_trigger_message_id", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "note_nudge_sticky_text", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "note_nudge_sticky_message_id", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "note_nudge_anchors", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "session_meta", "auto_search_hint_decisions", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "session_meta", "last_todo_state", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "todo_permission_denied", "INTEGER NOT NULL DEFAULT 2");
  ensureColumn(db, "session_meta", "todo_synthetic_call_id", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "todo_synthetic_anchor_message_id", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "todo_synthetic_state_json", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "note_last_read_at", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "times_execute_threshold_reached", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "observed_safe_input_tokens", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "cache_alert_sent", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "compartment_in_progress", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "historian_failure_count", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "historian_last_error", "TEXT DEFAULT NULL");
  ensureColumn(db, "session_meta", "historian_last_failure_at", "INTEGER DEFAULT NULL");
  ensureColumn(db, "session_meta", "system_prompt_hash", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "cleared_reasoning_through_tag", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "tags_version", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "tool_reclaim_watermark", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "stripped_placeholder_ids", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "stale_reduce_stripped_ids", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "processed_image_stripped_ids", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "merged_reasoning_stripped_ids", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "thinking_binding_recovery_target", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "trailing_blank_decisions", "TEXT DEFAULT ''");
  ensureColumn(db, "compartment_state_lease", "owner_pid", "INTEGER");
  ensureColumn(db, "compartments", "start_message_id", "TEXT DEFAULT ''");
  ensureColumn(db, "compartments", "end_message_id", "TEXT DEFAULT ''");
  ensureColumn(db, "memory_embeddings", "model_id", "TEXT");
  ensureColumn(db, "session_meta", "memory_block_cache", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "memory_block_count", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "pi_stable_id_scheme", "INTEGER");
  ensureColumn(db, "session_meta", "memory_block_ids", "TEXT DEFAULT ''");
  ensureColumn(db, "dream_queue", "retry_count", "INTEGER DEFAULT 0");
  ensureColumn(db, "tags", "reasoning_byte_size", "INTEGER DEFAULT 0");
  ensureColumn(db, "tags", "drop_mode", "TEXT DEFAULT 'full'");
  ensureColumn(db, "tags", "tool_name", "TEXT");
  ensureColumn(db, "tags", "input_byte_size", "INTEGER DEFAULT 0");
  ensureColumn(db, "tags", "caveman_depth", "INTEGER DEFAULT 0");
  ensureColumn(db, "tags", "tool_owner_message_id", "TEXT DEFAULT NULL");
  ensureColumn(db, "tags", "entry_fingerprint", "TEXT");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tags_pi_adopt
            ON tags(session_id, entry_fingerprint)
            WHERE type='message' AND entry_fingerprint IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tags_pi_fallback_tool_owner
            ON tags(session_id, tool_owner_message_id)
            WHERE type='tool'`);
  ensureColumn(db, "tags", "token_count", "INTEGER");
  ensureColumn(db, "tags", "input_token_count", "INTEGER");
  ensureColumn(db, "tags", "reasoning_token_count", "INTEGER");
  ensureColumn(db, "task_schedule_state", "schedule", "TEXT");
  ensureColumn(db, "task_schedule_state", "last_checked_commit", "TEXT");
  ensureColumn(db, "task_schedule_state", "last_broad_run_at", "INTEGER");
  ensureColumn(db, "task_schedule_state", "retrospective_watermark_ms", "INTEGER");
  ensureColumn(db, "dream_runs", "parent_session_id", "TEXT");
  ensureColumn(db, "session_meta", "system_prompt_tokens", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "compaction_marker_state", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "compaction_marker_target_end_message_id", "TEXT");
  ensureColumn(db, "session_meta", "key_files", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "conversation_tokens", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "tool_call_tokens", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "recomp_partial_range_start", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "recomp_partial_range_end", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "detected_context_limit", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "detected_context_limit_model_key", "TEXT");
  ensureColumn(db, "session_meta", "detected_context_limit_provenance", "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(db, "session_meta", "needs_emergency_recovery", "INTEGER DEFAULT 0");
  ensureColumn(db, "session_meta", "emergency_recovery_origin", "TEXT DEFAULT ''");
  ensureColumn(db, "session_meta", "pending_compaction_marker_state", "TEXT");
  ensureColumn(db, "session_meta", "pending_pi_compaction_marker_state", "TEXT");
  ensureColumn(db, "session_meta", "new_work_tokens", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "total_input_tokens", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "deferred_execute_state", "TEXT");
  ensureColumn(db, "compartments", "p1", "TEXT");
  ensureColumn(db, "compartments", "p2", "TEXT");
  ensureColumn(db, "compartments", "p3", "TEXT");
  ensureColumn(db, "compartments", "p4", "TEXT");
  ensureColumn(db, "compartments", "importance", "INTEGER NOT NULL DEFAULT 50");
  ensureColumn(db, "compartments", "episode_type", "TEXT");
  ensureColumn(db, "compartments", "p1_embedding", "BLOB");
  ensureColumn(db, "compartments", "p1_embedding_model_id", "TEXT");
  ensureColumn(db, "compartments", "legacy", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "recomp_compartments", "p1", "TEXT");
  ensureColumn(db, "recomp_compartments", "p2", "TEXT");
  ensureColumn(db, "recomp_compartments", "p3", "TEXT");
  ensureColumn(db, "recomp_compartments", "p4", "TEXT");
  ensureColumn(db, "recomp_compartments", "importance", "INTEGER NOT NULL DEFAULT 50");
  ensureColumn(db, "recomp_compartments", "episode_type", "TEXT");
  ensureColumn(db, "memories", "importance", "INTEGER");
  ensureColumn(db, "memories", "classified_at", "INTEGER");
  ensureColumn(db, "memories", "mural_cue", "TEXT");
  ensureColumn(db, "memories", "mural_cue_hash", "TEXT");
  ensureColumn(db, "memories", "mural_cue_at", "INTEGER");
  ensureColumn(db, "memory_verifications", "mapped_at", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "cached_m0_bytes", "BLOB");
  ensureColumn(db, "session_meta", "cached_m0_project_memory_epoch", "INTEGER");
  ensureColumn(db, "session_meta", "cached_m0_workspace_fingerprint", "TEXT");
  ensureColumn(db, "session_meta", "cached_m0_project_user_profile_version", "INTEGER");
  ensureColumn(db, "session_meta", "cached_m0_max_compartment_seq", "INTEGER");
  ensureColumn(db, "session_meta", "cached_m0_max_memory_id", "INTEGER");
  ensureColumn(db, "session_meta", "cached_m0_max_mutation_id", "INTEGER");
  ensureColumn(db, "session_meta", "cached_m0_max_memory_mutation_id", "INTEGER");
  ensureColumn(db, "session_meta", "cached_m0_project_docs_hash", "TEXT");
  ensureColumn(db, "session_meta", "cached_m1_bytes", "BLOB");
  ensureColumn(db, "session_meta", "last_observed_model_key", "TEXT");
  ensureColumn(db, "session_meta", "last_usage_context_limit", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "prior_boundary_ordinal", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "session_meta", "protected_tokens_effective", "INTEGER");
  ensureColumn(db, "session_meta", "protected_tokens_pre_snapshot", "TEXT");
  ensureColumn(db, "session_meta", "protected_tail_policy_version", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "protected_tail_drain_window_started_at", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "protected_tail_drain_tokens", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "recovery_no_eligible_head_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "force_emergency_bypass_window_start", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "force_emergency_bypass_used", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "emergency_drain_active", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "historian_drain_failure_at", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "wrapup_in_progress_state", "TEXT");
  ensureColumn(db, "session_meta", "compaction_mode_record", "TEXT");
  ensureColumn(db, "session_meta", "cached_m0_materialized_at", "INTEGER");
  ensureColumn(db, "session_meta", "cached_m0_session_facts_version", "INTEGER");
  ensureColumn(db, "session_meta", "cached_m0_upgrade_state", "TEXT");
  ensureColumn(db, "session_meta", "cached_m0_system_hash", "TEXT");
  ensureColumn(db, "session_meta", "cached_m0_tool_set_hash", "TEXT");
  ensureColumn(db, "session_meta", "cached_m0_model_key", "TEXT");
  ensureColumn(db, "session_meta", "cached_m0_project_identity", "TEXT");
  ensureColumn(db, "session_meta", "cached_m0_last_baseline_end_message_id", "TEXT");
  ensureColumn(db, "session_meta", "upgrade_reminded_at", "INTEGER");
  ensureColumn(db, "session_meta", "upgrade_reminder_last_sent_at", "INTEGER");
  ensureColumn(db, "session_meta", "upgrade_reminder_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "session_meta", "cached_m0_mural_data_url", "TEXT");
  ensureColumn(db, "session_meta", "cached_m0_mural_hash", "TEXT");
  ensureColumn(db, "session_meta", "coordinate_generation", "TEXT");
  ensureColumn(db, "session_meta", "coordinate_rebase_notice", "TEXT");
  ensureColumn(db, "compartments", "rebase_status", "TEXT NOT NULL DEFAULT 'ok'");
  ensureColumn(db, "recomp_compartments", "rebase_status", "TEXT NOT NULL DEFAULT 'ok'");
  db.exec(`
      CREATE TABLE IF NOT EXISTS project_state (
        project_path TEXT PRIMARY KEY,
        project_memory_epoch INTEGER NOT NULL DEFAULT 0,
        project_user_profile_version INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS session_projects (
        session_id TEXT NOT NULL,
        harness TEXT NOT NULL DEFAULT 'opencode',
        project_path TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, harness)
      );
      CREATE INDEX IF NOT EXISTS idx_session_projects_project
        ON session_projects(project_path);
      CREATE TABLE IF NOT EXISTS m0_mutation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        mutation_type TEXT NOT NULL CHECK (mutation_type IN (
          'compartment_delete', 'compartment_merge', 'recomp_boundary_change', 'compartment_upgrade'
        )),
        target_id INTEGER,
        queued_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_m0_mutation_log_session ON m0_mutation_log(session_id);
      CREATE TABLE IF NOT EXISTS memory_mutation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        mutation_type TEXT NOT NULL CHECK (mutation_type IN ('archive', 'delete', 'update', 'superseded')),
        target_memory_id INTEGER NOT NULL,
        superseded_by_id INTEGER,
        category TEXT,
        new_content TEXT,
        queued_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_project
        ON memory_mutation_log(project_path, id);
       CREATE TABLE IF NOT EXISTS v22_identity_rekey_map (
         old_project_path TEXT PRIMARY KEY,
         new_project_path TEXT NOT NULL,
         rekeyed_at INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS identity_merge_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         from_identity TEXT NOT NULL,
         to_identity TEXT NOT NULL,
         table_name TEXT NOT NULL,
         row_id TEXT NOT NULL,
         action TEXT NOT NULL,
         target_row_id TEXT,
         merged_at INTEGER NOT NULL
       );
       CREATE INDEX IF NOT EXISTS idx_identity_merge_log_identities
         ON identity_merge_log(from_identity, to_identity, merged_at);
       CREATE INDEX IF NOT EXISTS idx_identity_merge_log_table_row
         ON identity_merge_log(table_name, row_id);
      CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'
      );
      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        display_path TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, project_path)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_unique ON workspace_members(project_path);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_name ON workspace_members(workspace_id, display_name);
      CREATE TABLE IF NOT EXISTS v22_backfill_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        row_id INTEGER NOT NULL,
        raw_project_path TEXT NOT NULL,
        error_class TEXT NOT NULL CHECK (error_class IN ('not_git_repo', 'git_missing', 'git_timeout', 'permission_denied', 'unknown')),
        error_message TEXT,
        failed_at INTEGER NOT NULL,
        UNIQUE(table_name, row_id)
      );
      CREATE TABLE IF NOT EXISTS transform_decisions (
        session_id         TEXT    NOT NULL,
        harness            TEXT    NOT NULL DEFAULT 'opencode',
        message_id         TEXT    NOT NULL,
        ts_ms              INTEGER NOT NULL,
        decision           TEXT    NOT NULL,
        materialized       INTEGER NOT NULL DEFAULT 0,
        materialize_reason TEXT,
      system_hash_prev      TEXT,
      system_hash_new       TEXT,
      m0_tool_set_hash_prev TEXT,
      m0_tool_set_hash_new  TEXT,
      m0_model_key_prev     TEXT,
      m0_model_key_new      TEXT,
        emergency          INTEGER NOT NULL DEFAULT 0,
        dropped_tokens     INTEGER NOT NULL DEFAULT 0,
        dropped_count      INTEGER NOT NULL DEFAULT 0,
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, harness, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_transform_decisions_session_harness
        ON transform_decisions(session_id, harness);
    `);
  ensureColumn(db, "transform_decisions", "system_hash_prev", "TEXT");
  ensureColumn(db, "transform_decisions", "system_hash_new", "TEXT");
  ensureColumn(db, "transform_decisions", "m0_model_key_prev", "TEXT");
  ensureColumn(db, "transform_decisions", "m0_model_key_new", "TEXT");
  ensureColumn(db, "tags", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
  ensureColumn(db, "message_history_index", "dirty_floor_ordinal", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "pending_ops", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
  ensureColumn(db, "source_contents", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
  ensureColumn(db, "compartments", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
  ensureColumn(db, "compression_depth", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
  ensureColumn(db, "session_facts", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
  ensureColumn(db, "session_meta", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
  ensureColumn(db, "recomp_compartments", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
  ensureColumn(db, "recomp_facts", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
  ensureColumn(db, "message_history_index", "harness", "TEXT NOT NULL DEFAULT 'opencode'");
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_message_history_index_orphan_sweep
        ON message_history_index(harness, session_id, updated_at);
    `);
  ensureColumn(db, "workspaces", "share_categories", `TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'`);
}
var CHANNEL2_CLAIM_TTL_MS = 10 * 60000;
function healWedgedChannel2Claims(db) {
  try {
    const staleBefore = Date.now() - CHANNEL2_CLAIM_TTL_MS;
    db.prepare("UPDATE session_meta SET channel2_nudge_state = '', channel2_nudge_claimed_at = 0, channel2_nudge_claim_token = '' WHERE channel2_nudge_state = 'claimed' AND (channel2_nudge_claimed_at IS NULL OR channel2_nudge_claimed_at = 0 OR channel2_nudge_claimed_at <= ?)").run(staleBefore);
  } catch {}
}
function openDatabase(dbPathOrOptions) {
  const options = typeof dbPathOrOptions === "string" ? { dbPath: dbPathOrOptions } : dbPathOrOptions;
  const explicitDbPath = options?.dbPath !== undefined;
  const { dbDir, dbPath } = resolveDatabasePath(options?.dbPath);
  const latestSupportedVersion = getRuntimeLatestSupportedVersion(options);
  const busyTimeoutMs = resolveBootBusyTimeoutMs(options?.busyTimeoutMs);
  lastSchemaFenceRejection = null;
  lastMigrationOnOpenRefusal = null;
  const existing = databases.get(dbPath);
  if (!existing && pendingAsyncOpens.has(dbPath)) {
    log(`[magic-context] storage not ready: ${dbPath} is still being opened or migrated; refusing a second synchronous open`);
    return null;
  }
  if (existing) {
    if (!enforceSchemaFence(existing, dbPath, latestSupportedVersion)) {
      return null;
    }
    if (!persistenceByDatabase.has(existing)) {
      persistenceByDatabase.set(existing, true);
    }
    healWedgedChannel2Claims(existing);
    return existing;
  }
  let db;
  try {
    if (!explicitDbPath) {
      migrateLegacyStorageIfNeeded(dbPath, dbDir);
    }
    ensureSecureStorageDir(dbDir);
    db = new Database(dbPath);
    installBootBusyTimeout(db, dbPath, busyTimeoutMs, options?.onBootBusyTimeout);
    if (!enforceSchemaFence(db, dbPath, latestSupportedVersion)) {
      closeQuietly(db);
      return null;
    }
    if (!enforceMigrationOnOpenGuard(db, dbPath, dbDir, latestSupportedVersion)) {
      closeQuietly(db);
      return null;
    }
    initializeDatabase(db, busyTimeoutMs);
    runMigrations(db);
    ensureContextStoreUuid(db);
    return finishDatabaseOpen(db, dbPath, explicitDbPath, latestSupportedVersion);
  } catch (error) {
    if (db)
      closeQuietly(db);
    const detail = getErrorMessage(error);
    log(`[magic-context] storage fatal: failed to open ${dbPath}: ${detail}`);
    throw new Error(`[magic-context] storage unavailable: ${detail}. Magic Context is disabled for this run; check log for details.`);
  }
}
function isDatabasePersisted(db) {
  if (!db)
    return false;
  return persistenceByDatabase.get(db) ?? false;
}
function getDatabasePersistenceError(db) {
  if (!db)
    return null;
  return persistenceErrorByDatabase.get(db) ?? null;
}
function closeDatabase() {
  pendingAsyncOpens.clear();
  for (const [key, db] of databases) {
    try {
      closeQuietly(db);
    } catch (error) {
      log("[magic-context] storage error:", error);
    } finally {
      databases.delete(key);
    }
  }
}

export { shouldEnforcePrivateStoragePermissions, directoryHasGitMetadata, describeUnresolvedProjectIdentity, resolveProjectIdentityForSession, normalizeStoredProjectPath, storedPathBelongsToIdentity, recordMessageFtsRowid, messageFtsOrdinalRangeIsMapped, deleteUnmappedMessageFtsRows, V2_MEMORY_CATEGORIES, CATEGORY_PRIORITY, resolveWorkspaceShareCategories, resolveWorkspaceIdentitySet, expandWorkspaceIdentitySetWithAliases, resolveStoredPathWorkspaceIdentity, storedPathBelongsToWorkspace, sourceNameForMemory, managedAuthorityNoteRow, runMigrationsWithRetry, getErrorMessage, setSqlitePragmaConfig, initializeDatabase, openDatabase, isDatabasePersisted, getDatabasePersistenceError, closeDatabase };
