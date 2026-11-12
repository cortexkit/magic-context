// Magic Context subagent failure sentinel, run by basal every five minutes.
//
// It reads finished subagent invocations from ck-mc's (Magic Context's
// module in the CortexKit daemon) read-only
// `subagent_invocations.read` op and wakes MC when failures look new or are
// growing. The rules are a port of `evaluateFailures` in
// packages/plugin/scripts/subagent-failure-sentinel.ts, and
// packages/plugin/scripts/subagent-failure-sentinel-flow.test.ts checks that
// both produce the same alerts on the same rows. A change to the rules belongs
// in both places until that script is retired.
//
// One known difference: the script leaves out a dreamer run that stopped at
// its token budget (DreamTokenBudgetExceeded) when its dream task still
// completed, and holds such a row for up to 60 minutes while the run has not
// been recorded yet; it reads the outcome from dream_runs and session_projects.
// This flow can read only `subagent_invocations.read`, which does not return
// run outcomes, so it still counts those rows as failures. Closing the gap
// needs that read to return the owning dream run's outcome for such rows; the
// parity test pins the difference so it is flipped when the read grows it.
//
// basal wraps this text in an async function, so top-level `await` and
// `return` work. The runtime has no console, timers or TextEncoder.

const MODULE = 'magic-context';
const OP = 'subagent_invocations.read';
const AGENT = 'MC';
const STATE_KEY = 'state';

const HOUR = 3600000;
const DAY = 24 * HOUR;
// A primary attempt that fails is followed by its fallback attempt, which ends
// later. Rows are judged only once they are this old, which gives the fallback
// time to finish before its outcome is checked.
const SETTLE_MS = 5 * 60000;
// Some fallback rows carry no parent link. Such a row still counts as a
// primary's fallback when it has task `fallback`, the same subagent and session,
// and starts between 5 seconds before and this long after the primary ends.
const FALLBACK_START_WINDOW_MS = 120000;
const RECOVERABLE_ERROR =
  /account pool has no account|quota|rate[ _-]?limit|too many requests|\b429\b|resource_exhausted|usage limit|producer_prompt_exceeds_window|prompt timed out after/i;
// prefrontal-core refuses a digest body over this many UTF-8 bytes.
const BODY_MAX_BYTES = 4096;
const CONTENT_PREFIX = 'Magic Context subagent failure sentinel: ';
// The script's bounds: new rows judged per run, and history rows read for
// them. MAX_HISTORY now bounds the cold-start read and the unsettled-tail read.
const MAX_NEW = 500;
const MAX_HISTORY = 5000;

function normalizeError(error) {
  return (error === null || error === undefined ? '(no error)' : error)
    .replace(/(?:[a-zA-Z]:)?(?:\/[\w.~-]+){2,}/g, '<path>')
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, '<id>')
    // Recorded errors are cut at a fixed length, which can split a UUID;
    // the surviving prefix (8 hex digits plus partial groups) is still an id.
    .replace(/\b[a-f0-9]{8}(?:-[a-f0-9]{1,12})+/gi, '<id>')
    .replace(/\b(?:0x[a-f0-9]+|[a-f0-9]{16,}|(?:ses|session|task|run|agent|invocation|request|trace|job|msg|wi|ct)_[a-z0-9_-]+)\b/gi, '<id>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/gi, '<duration>')
    // Compact countdowns such as "34h 33m 37s" change on every report of the
    // same failure, so they must collapse into one class.
    .replace(/\b\d+[dhms](?:\s+\d+[dhms])*\b/gi, '<duration>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim();
}

// The rules compare classes of the same rows many times over; QuickJS has no JIT,
// so each distinct error text is normalized once per run.
const errorClasses = new Map();
function errorClass(error) {
  const text = error === null || error === undefined ? null : error;
  if (!errorClasses.has(text)) errorClasses.set(text, normalizeError(text));
  return errorClasses.get(text);
}

function cursorAfter(row, cursor) {
  return row.ended_at > cursor.ended_at || (row.ended_at === cursor.ended_at && row.id > cursor.id);
}

function alertKey(alert) {
  // The share rule describes the whole task, so one burst of mixed failure classes
  // must dedupe to a single alert instead of re-firing for every class it contains.
  const klass = alert.rule === 'failure_share' ? '*' : alert.class;
  return JSON.stringify([alert.rule, alert.subagent, alert.task, klass]);
}

// Routine failures are recovered when any later attempt in their fallback chain
// completes. Intermediate non-routine failures remain eligible for alerts.
function recoveredByFallback(rows) {
  const byParent = new Map();
  const unlinked = new Map();
  const positions = new Map();
  for (const [index, row] of rows.entries()) {
    positions.set(row, index);
    if (row.parent_invocation_id !== null && row.parent_invocation_id !== undefined) {
      const children = byParent.get(row.parent_invocation_id) || [];
      children.push(row);
      byParent.set(row.parent_invocation_id, children);
    } else if (row.parent_invocation_id === null && row.task === 'fallback') {
      let sessions = unlinked.get(row.subagent);
      if (!sessions) { sessions = new Map(); unlinked.set(row.subagent, sessions); }
      const attempts = sessions.get(row.session_id) || [];
      attempts.push(row);
      sessions.set(row.session_id, attempts);
    }
  }
  // Index links once: QuickJS has no JIT, and retained windows can contain
  // thousands of unrelated rows that need not be scanned for every chain step.
  const nextAttempts = (row) => (byParent.get(row.id) || []).concat(
    ((unlinked.get(row.subagent) || new Map()).get(row.session_id) || []).filter(
      (candidate) => candidate.started_at >= row.ended_at - 5000 &&
        candidate.started_at <= row.ended_at + FALLBACK_START_WINDOW_MS,
    ),
  ).sort((a, b) => positions.get(a) - positions.get(b));
  const reachesCompletion = (row, seen) => {
    for (const next of nextAttempts(row)) {
      if (seen.has(next.id)) continue;
      if (next.status === 'completed') return true;
      seen.add(next.id);
      if (reachesCompletion(next, seen)) return true;
    }
    return false;
  };
  const recovered = new Set();
  for (const row of rows) {
    if (row.status !== 'failed' && row.status !== 'timed_out') continue;
    if (!RECOVERABLE_ERROR.test(row.error === null || row.error === undefined ? '' : row.error)) continue;
    if (reachesCompletion(row, new Set([row.id]))) recovered.add(row.id);
  }
  return recovered;
}

function evaluateFailures(allRows, allNewRows, now, completeSince) {
  // A recovered attempt is neither a failure nor a success of its task, so it is
  // left out of every rule, including the share denominator.
  const recovered = recoveredByFallback(allRows);
  const rows = allRows.filter((row) => !recovered.has(row.id));
  const newRows = allNewRows.filter((row) => !recovered.has(row.id));
  const failures = (row) => row.status === 'failed' || row.status === 'timed_out';
  const taskName = (row) => (row.task === null || row.task === undefined ? '(untitled)' : row.task);
  const alerts = [];
  const seen = new Set();
  for (const row of newRows) {
    if (!failures(row) || row.ended_at < now - DAY) continue;
    const task = taskName(row);
    const klass = errorClass(row.error);
    const group = rows.filter((candidate) => candidate.subagent === row.subagent && taskName(candidate) === task);
    const current = group.filter((candidate) => candidate.ended_at > now - DAY);
    const prior = group.filter((candidate) => candidate.ended_at > now - 2 * DAY && candidate.ended_at <= now - DAY);
    const classRows = current.filter((candidate) => failures(candidate) && errorClass(candidate.error) === klass);
    const oldClass = prior.filter((candidate) => failures(candidate) && errorClass(candidate.error) === klass);
    const failuresToday = current.filter(failures).length;
    const share = current.length ? failuresToday / current.length : 0;
    // Field order matches the script's alert objects, so both serialize alike.
    const base = {
      subagent: row.subagent,
      task,
      class: klass,
      count: classRows.length,
      share,
      example_error: row.error === null || row.error === undefined ? '(no error)' : row.error,
      newest_session_id: classRows.length ? classRows[0].session_id : row.session_id,
      empty: current.filter((candidate) => candidate.status === 'empty').length,
      aborted: current.filter((candidate) => candidate.status === 'aborted').length,
    };
    const earlier = rows.some((candidate) =>
      candidate.subagent === row.subagent && taskName(candidate) === task && failures(candidate) &&
      errorClass(candidate.error) === klass && candidate.ended_at >= row.ended_at - 7 * DAY &&
      candidate.ended_at < row.ended_at && cursorAfter(row, candidate));
    const rules = [];
    if (completeSince <= now - 7 * DAY && !earlier) rules.push('new_class');
    if (completeSince <= now - DAY && current.length >= 8 && share >= 0.25) rules.push('failure_share');
    if (completeSince <= now - 2 * DAY && oldClass.length > 0 && classRows.length >= 2 * oldClass.length) rules.push('class_doubled');
    for (const rule of rules) {
      // A share alert counts every failure of the task, so the 50% re-alert
      // threshold tracks the task's failures rather than one class's.
      const alert = rule === 'failure_share'
        ? Object.assign({ rule }, base, { class: '*', count: failuresToday })
        : Object.assign({ rule }, base);
      const id = alertKey(alert);
      if (!seen.has(id)) { alerts.push(alert); seen.add(id); }
    }
  }
  return alerts;
}

function invalidState() {
  throw new Error('invalid failure sentinel state');
}

// ---- Stored row state ----
//
// Each run reads only the rows after its cursor and folds them into kv, so the
// rules no longer need the seven-day history read back from ck-mc (every result
// of a run is journaled whole for seven days). What the rules read from the
// stored state:
//
// - Every row of roughly the last 49 hours, kept as a compact record under one
//   key per hour (`hour:<hour index>#<part>`). The share and doubling rules
//   count rows whose end falls on either side of `now - 24h` and `now - 48h`,
//   to the millisecond, so their counts need each row's own end time. A record
//   keeps only the fields the rules and the fallback exclusion read.
// - For every subagent, task and failure class, the end time of its newest
//   unrecovered failure older than those hours (`older#<part>`). The new-class
//   rule only asks whether some such failure ended inside the last seven days,
//   and the newest one answers that until it expires.
//
// A record names its failure class by a hash. At evaluation time a record is
// turned back into a row whose `error` is a stand-in text; `errorClass` is told
// which class each stand-in has, so `evaluateFailures` runs unchanged on the
// same rows the script would read.

const STATE_VERSION = 3;
const OLDER_KEY = 'older';
const STATUSES = ['completed', 'failed', 'timed_out', 'empty', 'aborted'];
// basal refuses a kv value over 64 KiB of JSON, so a stored list is split into
// parts of about this many UTF-8 bytes. A single record larger than this gets
// a part of its own (records are small: ids, times, a hash and a session id).
const PART_BYTES = 48 * 1024;
// basal keeps at most 1 MiB of kv per flow. Past these budgets the oldest
// hours leave the records early and the oldest summary entries are forgotten;
// see `trimRecords` and `trimOlder`.
const RECORD_BUDGET_BYTES = 640 * 1024;
const OLDER_BUDGET_BYTES = 192 * 1024;

const failed = (row) => row.status === 'failed' || row.status === 'timed_out';
const hourOf = (endedAt) => Math.floor(endedAt / HOUR);
// Records are kept from this hour on: one whole hour before `now - 48h`, so a
// failure has long had its fallback recorded before it leaves the records.
// Operational assumption: configured runs use a handful of attempts of at most 20 minutes each.
// A fallback chain completes within hours; the horizon covers any real chain.
// Only a chain whose first attempt is outside this horizon has an incomplete prefix.
const firstKeptHour = (now) => hourOf(now - 2 * DAY) - 1;

// A 64-bit class hash written with the letters a-p only. Neither the hash nor a
// stand-in error built from it can match RECOVERABLE_ERROR, which looks for words
// and `429`.
const classIds = new Map();
function classId(klass) {
  if (classIds.has(klass)) return classIds.get(klass);
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < klass.length; i++) {
    const code = klass.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
    b ^= b >>> 15;
  }
  let text = '';
  for (const word of [a >>> 0, b >>> 0]) {
    for (let shift = 28; shift >= 0; shift -= 4) text += String.fromCharCode(97 + ((word >>> shift) & 15));
  }
  classIds.set(klass, text);
  return text;
}

// The stand-in error of a stored failure: its class hash, plus the word `quota`
// when the original error matched RECOVERABLE_ERROR, so the fallback exclusion
// treats it as the original.
function standIn(cls, routine) {
  return '\u0000\u0001' + cls + (routine ? ' quota' : '');
}

// A row's stored form is an item { group: [subagent, task], rec }, where rec is
// [id, ended_at, status, ...]. Failures add [class hash, routine 0|1,
// session_id], followed by a parent, or [null, started_at] for an unlinked
// fallback. Other statuses retain those same links too, so a failed or empty
// intermediate attempt can lead to a completed child. In kv, `group` becomes an index into the
// part's group table, written after ended_at.
function itemOf(row) {
  const status = STATUSES.indexOf(row.status);
  const task = row.task === undefined ? null : row.task;
  const item = { group: [row.subagent, task], rec: [row.id, row.ended_at, status < 0 ? row.status : status] };
  const parent = row.parent_invocation_id === null || row.parent_invocation_id === undefined
    ? null
    : row.parent_invocation_id;
  if (failed(row)) {
    const error = row.error === null || row.error === undefined ? '' : row.error;
    item.rec.push(classId(errorClass(row.error)), RECOVERABLE_ERROR.test(error) ? 1 : 0, row.session_id);
    if (parent !== null) item.rec.push(parent);
    else if (task === 'fallback') item.rec.push(null, row.started_at);
    return item;
  }
  if (row.status !== 'completed') {
    item.rec.push(parent, row.session_id, row.started_at);
    return item;
  }
  if (parent !== null) item.rec.push(parent);
  else if (task === 'fallback') item.rec.push(null, row.session_id, row.started_at);
  return item;
}

const encodeItem = (item, group) => [item.rec[0], item.rec[1], group].concat(item.rec.slice(2));

function decodeItem(record, groups) {
  const group = groups[record[2]];
  if (!Array.isArray(record) || record.length < 4 || !Number.isSafeInteger(record[0]) ||
    !Number.isSafeInteger(record[1]) || !Array.isArray(group) || group.length !== 2) {
    invalidState();
  }
  return { group, rec: [record[0], record[1]].concat(record.slice(3)) };
}

// The row an item stands for, as far as the rules can tell.
function rowOf(item) {
  const rec = item.rec;
  const status = typeof rec[2] === 'number' ? STATUSES[rec[2]] : rec[2];
  const row = {
    id: rec[0], session_id: null, subagent: item.group[0], task: item.group[1],
    started_at: rec[1], ended_at: rec[1], status, error: null, parent_invocation_id: null,
  };
  if (failed(row)) {
    row.error = standIn(rec[3], rec[4] === 1);
    row.session_id = rec[5];
    if (rec.length > 6) row.parent_invocation_id = rec[6];
    if (rec.length > 7) row.started_at = rec[7];
  } else if (rec.length > 3) {
    row.parent_invocation_id = rec[3];
    if (rec.length > 4) {
      row.session_id = rec[4];
      row.started_at = rec[5];
    }
  }
  return row;
}

// Splits records into kv values of at most PART_BYTES. Each part carries its
// own table of [subagent, task] groups. `encode(item, groupIndex)` builds one
// record from an item.
function packParts(items, groupOf, encode) {
  const parts = [];
  let part = null;
  let groups = null;
  let bytes = 0;
  for (const item of items) {
    const group = groupOf(item);
    const groupKey = JSON.stringify(group);
    for (;;) {
      if (!part) {
        part = { g: [], r: [] };
        groups = new Map();
        bytes = 16;
      }
      const known = groups.get(groupKey);
      const index = known === undefined ? part.g.length : known;
      const record = encode(item, index);
      const added = utf8Bytes(JSON.stringify(record)) + 1 + (known === undefined ? utf8Bytes(groupKey) + 1 : 0);
      // A part this item would overflow is closed and the item retried in a new
      // one. An empty part takes any item, so the retry ends.
      if (part.r.length && bytes + added > PART_BYTES) {
        parts.push(part);
        part = null;
        continue;
      }
      if (known === undefined) {
        groups.set(groupKey, index);
        part.g.push(group);
      }
      part.r.push(record);
      bytes += added;
      break;
    }
  }
  if (part) parts.push(part);
  return { parts, bytes: parts.reduce((sum, value) => sum + utf8Bytes(JSON.stringify(value)), 0) };
}

// Reads `<base>#0`, `<base>#1`, ... until a part is missing. The part count is
// not trusted from elsewhere: kv writes are not undone when a run fails, so a
// run that stopped part way may have left one part more than its state says.
async function loadParts(base) {
  const parts = [];
  for (let index = 0; ; index++) {
    const part = await kv.get(`${base}#${index}`);
    if (part === null || part === undefined) return parts;
    if (typeof part !== 'object' || !Array.isArray(part.g) || !Array.isArray(part.r)) invalidState();
    parts.push(part);
  }
}

// Writes `parts` under `base` and deletes any later part left from before.
async function storeParts(base, parts, previousCount) {
  for (let index = 0; index < parts.length; index++) await kv.set(`${base}#${index}`, parts[index]);
  for (let index = parts.length; index < previousCount; index++) await kv.delete(`${base}#${index}`);
}

const hourKey = (hour) => `hour:${hour}`;
const olderKey = (entry) => JSON.stringify([entry.subagent, entry.task, entry.cls]);

// Folds the stored summary parts into a map keyed by subagent, task and class.
function openOlder(parts) {
  const older = new Map();
  for (const part of parts) {
    for (const record of part.r) {
      const group = part.g[record[0]];
      if (!Array.isArray(group) || typeof record[1] !== 'string' || !Number.isSafeInteger(record[2])) invalidState();
      mergeOlder(older, { subagent: group[0], task: group[1], cls: record[1], ended_at: record[2] });
    }
  }
  return older;
}

function mergeOlder(older, entry) {
  const key = olderKey(entry);
  const known = older.get(key);
  if (!known || known.ended_at < entry.ended_at) older.set(key, entry);
}

// Missing state starts the cursor five minutes back, as the script's first run
// did. Earlier state keeps its cursor and dedupe keys and is bootstrapped from
// the seven-day window. Version 2 records omitted intermediate fallback links,
// so refreshing those rows is necessary before evaluating whole chains.
function loadState(stored, now) {
  if (stored === null || stored === undefined) {
    return {
      state: { version: STATE_VERSION, cursor: { ended_at: now - 5 * 60000, id: 0 }, sent: {}, complete_since: null, records_since: null, hours: [], older_bytes: 0 },
      bootstrap: true,
    };
  }
  if (typeof stored !== 'object') invalidState();
  const cursor = stored.cursor;
  if ((stored.version !== 1 && stored.version !== 2 && stored.version !== STATE_VERSION) || !cursor || !Number.isSafeInteger(cursor.ended_at) ||
    !Number.isSafeInteger(cursor.id) || !stored.sent || typeof stored.sent !== 'object') {
    invalidState();
  }
  if (stored.version === 1) {
    return {
      state: { version: STATE_VERSION, cursor, sent: stored.sent, complete_since: null, records_since: null, hours: [], older_bytes: 0 },
      bootstrap: true,
    };
  }
  if (!Number.isSafeInteger(stored.complete_since) || !Number.isSafeInteger(stored.older_bytes) ||
    (stored.records_since !== null && !Number.isSafeInteger(stored.records_since)) ||
    !Array.isArray(stored.hours) ||
    !stored.hours.every((hour) => Array.isArray(hour) && Number.isSafeInteger(hour[0]) && Number.isSafeInteger(hour[1]) && Number.isSafeInteger(hour[2]))) {
    invalidState();
  }
  if (stored.version === 2) {
    return {
      state: { ...stored, version: STATE_VERSION, records_since: null },
      bootstrap: true,
      rebuild: true,
    };
  }
  return { state: stored, bootstrap: false };
}

function utf8Bytes(text) {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// The script's wake text when it fits a digest body. A larger set keeps as many
// whole alerts as fit, with long example errors shortened, and says how many
// were left out; the full count is also in the item's data.
function digestBody(alerts) {
  const full = CONTENT_PREFIX + JSON.stringify(alerts);
  if (utf8Bytes(full) <= BODY_MAX_BYTES) return full;
  const shortened = alerts.map((alert) =>
    Object.assign({}, alert, {
      example_error: alert.example_error.length > 300
        ? alert.example_error.slice(0, 300) + '…'
        : alert.example_error,
    }));
  for (let kept = shortened.length; kept > 0; kept--) {
    const omitted = shortened.length - kept;
    const suffix = omitted ? ` (${omitted} more alert${omitted === 1 ? '' : 's'} not shown)` : '';
    const text = CONTENT_PREFIX + JSON.stringify(shortened.slice(0, kept)) + suffix;
    if (utf8Bytes(text) <= BODY_MAX_BYTES) return text;
  }
  return `${CONTENT_PREFIX}${alerts.length} alerts; none fits a digest body.`;
}

// Reads up to `limit` rows of one query. ck-mc keeps each reply under basal's
// 512 KiB result cap, so a query can take several pages, each continuing from
// the previous page's last row through `cursorField`. `more` says whether a
// matching row exists past the last one returned.
async function readRows(args, cursorField, limit) {
  const rows = [];
  let more = true;
  while (rows.length < limit && more) {
    const request = Object.assign({}, args, { limit: limit - rows.length });
    if (rows.length) {
      const last = rows[rows.length - 1];
      request[cursorField] = { ended_at: last.ended_at, id: last.id };
    }
    const page = await ops.call(MODULE, OP, request);
    more = page.more;
    // ck-mc returns at least one row whenever one matches; stop rather than loop.
    if (!page.rows.length) break;
    for (const row of page.rows) rows.push(row);
  }
  return { rows, more };
}

// ---- The run ----
// Everything above only defines constants and functions; the equivalence test
// loads it on its own by cutting the script at this marker.

const now = Date.now();
const loaded = loadState(await kv.get(STATE_KEY), now);
const state = loaded.state;
// Dedupe keys saved before a change to normalizeError keep their old class
// text. Normalize them again, as the script does when it loads its state;
// several old classes can collapse into one, so their counts are combined
// rather than read as new growth.
{
  const sent = {};
  for (const [oldKey, value] of Object.entries(state.sent)) {
    const parts = JSON.parse(oldKey);
    const normalizedKey = Array.isArray(parts) && parts.length === 4 && typeof parts[3] === 'string'
      ? JSON.stringify([...parts.slice(0, 3), normalizeError(parts[3])]) : oldKey;
    const previous = sent[normalizedKey];
    sent[normalizedKey] = previous
      ? { at: Math.max(previous.at, value.at), count: previous.count + value.count } : value;
  }
  state.sent = sent;
}
for (const key of Object.keys(state.sent)) {
  if (now - state.sent[key].at >= 6 * HOUR) delete state.sent[key];
}

// The hours whose records this run has read, by hour index.
const hours = new Map();
const storedHours = new Map(state.hours.map((hour) => [hour[0], { parts: hour[1], bytes: hour[2] }]));
async function openHour(hour) {
  if (hours.has(hour)) return hours.get(hour);
  const opened = { items: new Map(), parts: 0, dirty: false };
  if (storedHours.has(hour)) {
    const parts = await loadParts(hourKey(hour));
    opened.parts = Math.max(parts.length, storedHours.get(hour).parts);
    for (const part of parts) {
      for (const record of part.r) {
        const item = decodeItem(record, part.g);
        opened.items.set(item.rec[0], item);
      }
    }
  }
  hours.set(hour, opened);
  return opened;
}
// Rows are keyed by id, so a run repeated after a failure part way does not
// count a row twice.
async function fold(row) {
  const hour = await openHour(hourOf(row.ended_at));
  // Replacing the same id does not count it twice, and refreshes old records'
  // missing fallback links during the version-2 bootstrap.
  hour.items.set(row.id, itemOf(row));
  hour.dirty = true;
}

let older = new Map();
let olderParts = 0;
let olderOpen = false;
let olderDirty = false;
let bootstrapRows = 0;
// Cold start: one bounded read of the seven days up to the cursor. Past
// MAX_HISTORY rows the state is complete only back to the oldest row read, and
// rules needing a longer window wait, as the script's cut-off history did.
if (loaded.bootstrap) {
  if (loaded.rebuild) olderParts = (await loadParts(OLDER_KEY)).length;
  const boot = await readRows({ query: 'window', after: now - 7 * DAY, until: state.cursor.ended_at }, 'before', MAX_HISTORY);
  bootstrapRows = boot.rows.length;
  state.complete_since = boot.more ? boot.rows[boot.rows.length - 1].ended_at : now - 7 * DAY;
  for (const row of boot.rows) {
    if (!cursorAfter(row, state.cursor)) await fold(row);
  }
  olderOpen = true;
  olderDirty = true;
}

const next = await readRows(
  { query: 'after_cursor', cursor: state.cursor, settled_before: now - SETTLE_MS },
  'cursor',
  MAX_NEW,
);
const fresh = next.rows;
const examined = fresh.length + (next.more ? 1 : 0);
let bounded = next.more;
const evaluate = fresh.some(failed);
const cutoff = firstKeptHour(now);
const recordBytes = state.hours.reduce((sum, hour) => sum + hour[2], 0);
// A quiet run reads and writes only the hours its new rows fall in. Every
// stored hour is read when the rules run or when the records near their
// budget (about 160 bytes a new row is assumed). Retiring an hour also reads
// the retained window: a completed chain can span several long model attempts.
const leaving = state.hours.some((hour) => hour[0] < cutoff) || fresh.some((row) => hourOf(row.ended_at) < cutoff);
const readAll = loaded.bootstrap || evaluate || leaving || recordBytes + 160 * fresh.length > RECORD_BUDGET_BYTES;
for (const hour of state.hours) {
  if (readAll) await openHour(hour[0]);
}
if ((readAll || leaving) && !olderOpen) {
  const parts = await loadParts(OLDER_KEY);
  olderParts = parts.length;
  older = openOlder(parts);
  olderOpen = true;
}

let alerts = [];
let tailRows = 0;
// Only a new failure can raise an alert. The rules then see what the script's
// seven-day read saw: the stored records, the summary of older failures, the
// new rows, and the rows that ended after them (the not yet settled tail,
// which holds the fallbacks the exclusion looks for).
if (evaluate) {
  const last = fresh[fresh.length - 1];
  const tail = await readRows({ query: 'window', after: last.ended_at - 1, until: now }, 'before', MAX_HISTORY);
  const after = tail.rows.filter((row) => cursorAfter(row, last));
  tailRows = after.length;
  let completeSince = state.complete_since;
  // Records trimmed for the kv budget leave the windows before records_since incomplete.
  if (state.records_since !== null && state.records_since > now - 2 * DAY) {
    completeSince = Math.max(completeSince, state.records_since);
  }
  // A cut-off tail misses rows between the new rows and its oldest row.
  if (tail.more) completeSince = Math.max(completeSince, tail.rows[tail.rows.length - 1].ended_at);
  const real = fresh.concat(after);
  const realIds = new Set(real.map((row) => row.id));
  // A stand-in error has the class of a real row with the same hash. Any other
  // class only has to differ from every real class, which a text beginning
  // with NUL does.
  const classOf = new Map();
  for (const row of real) {
    if (failed(row)) classOf.set(classId(errorClass(row.error)), errorClass(row.error));
  }
  const teach = (row) => {
    if (failed(row) && !errorClasses.has(row.error)) {
      const cls = row.error.slice(2, 18);
      errorClasses.set(row.error, classOf.has(cls) ? classOf.get(cls) : '\u0000\u0002' + cls);
    }
    return row;
  };
  const rows = real.slice();
  for (const hour of hours.values()) {
    for (const item of hour.items.values()) {
      if (!realIds.has(item.rec[0])) rows.push(teach(rowOf(item)));
    }
  }
  let phantom = 0;
  for (const entry of older.values()) {
    if (entry.ended_at <= now - 7 * DAY) continue;
    rows.push(teach({
      id: -(++phantom), session_id: null, subagent: entry.subagent, task: entry.task,
      started_at: entry.ended_at, ended_at: entry.ended_at, status: 'failed',
      error: standIn(entry.cls, false), parent_invocation_id: null,
    }));
  }
  // Newest first, as the script's window read returned them.
  rows.sort((a, b) => b.ended_at - a.ended_at || b.id - a.id);
  bounded = bounded || completeSince > now - 7 * DAY;
  alerts = evaluateFailures(rows, fresh, now, completeSince).filter((alert) => {
    const previous = state.sent[alertKey(alert)];
    return !previous || now - previous.at >= 6 * HOUR || alert.count >= Math.ceil(previous.count * 1.5);
  });
}

for (const row of fresh) await fold(row);
if (fresh.length) {
  const last = fresh[fresh.length - 1];
  state.cursor = { ended_at: last.ended_at, id: last.id };
}

const packed = new Map();
const pack = (hour) => packParts(hour.items.values(), (item) => item.group, encodeItem);
for (const [index, hour] of hours) {
  if (hour.dirty) packed.set(index, pack(hour));
}
const hourBytes = (index) => packed.has(index) ? packed.get(index).bytes : storedHours.has(index) ? storedHours.get(index).bytes : 0;
const dropped = [];
if (readAll || leaving) {
  // Hours before the cutoff leave the records. While the records exceed their
  // budget, the oldest remaining hours leave too, and the windows they covered
  // count as incomplete (records_since). Only a read hour can leave.
  const kept = [...new Set([...storedHours.keys(), ...hours.keys()])].sort((a, b) => a - b);
  let total = kept.reduce((sum, index) => sum + hourBytes(index), 0);
  while (kept.length && hours.has(kept[0]) && (kept[0] < cutoff || total > RECORD_BUDGET_BYTES)) {
    const index = kept.shift();
    total -= hourBytes(index);
    if (index >= cutoff) state.records_since = (index + 1) * HOUR;
    dropped.push(index);
  }
  if (dropped.length) {
    // An unrecovered failure in a leaving hour joins the summary. Its fallback
    // ended long before, inside the hours read, so the exclusion is final here.
    const all = [];
    for (const hour of hours.values()) for (const item of hour.items.values()) all.push(rowOf(item));
    const recovered = recoveredByFallback(all);
    for (const index of dropped) {
      for (const item of hours.get(index).items.values()) {
        const row = rowOf(item);
        if (!failed(row) || recovered.has(item.rec[0])) continue;
        if (next.more && index < cutoff && RECOVERABLE_ERROR.test(row.error || '')) {
          // An old first attempt can retire while its completed fallback is
          // still in the cursor backlog. Its discarded prefix is incomplete.
          state.complete_since = Math.max(state.complete_since, (index + 1) * HOUR);
        }
        mergeOlder(older, { subagent: item.group[0], task: item.group[1], cls: item.rec[3], ended_at: item.rec[1] });
        olderDirty = true;
      }
    }
  }
  for (const [key, entry] of older) {
    if (entry.ended_at <= now - 7 * DAY) {
      older.delete(key);
      olderDirty = true;
    }
  }
}

// Writes go summary first, then hours, then the state: kv keeps each write
// even if the run fails later, and every step is safe to repeat.
if (olderDirty) {
  const entries = [...older.values()].sort((a, b) => b.ended_at - a.ended_at);
  const packOlder = () => packParts(entries, (entry) => [entry.subagent, entry.task], (entry, group) => [group, entry.cls, entry.ended_at]);
  let summary = packOlder();
  // Past its budget the summary forgets its oldest entries, so their classes
  // can count as new again a little early.
  while (summary.bytes > OLDER_BUDGET_BYTES) {
    entries.length = Math.floor(entries.length * 0.9);
    summary = packOlder();
  }
  await storeParts(OLDER_KEY, summary.parts, olderParts);
  state.older_bytes = summary.bytes;
}
for (const [index, value] of packed) {
  if (!dropped.includes(index)) await storeParts(hourKey(index), value.parts, hours.get(index).parts);
}
for (const index of dropped) {
  if (storedHours.has(index)) await storeParts(hourKey(index), [], hours.get(index).parts);
}
const stillStored = new Set([...storedHours.keys(), ...packed.keys()]);
state.hours = [...stillStored].filter((index) => !dropped.includes(index)).sort((a, b) => a - b).map((index) => [
  index,
  packed.has(index) ? packed.get(index).parts.length : storedHours.get(index).parts,
  hourBytes(index),
]);

if (alerts.length) {
  // Reserve the dedupe keys before delivery so an ambiguous delivery cannot cause a repeated wake.
  for (const alert of alerts) state.sent[alertKey(alert)] = { at: now, count: alert.count };
}
// The script holds a dreamer budget stop here until its run is recorded; this
// flow never does (see the header), so its list of held rows is always empty.
state.pending = [];
await kv.set(STATE_KEY, state);
if (alerts.length) {
  const deliveryId = `mc-subagent-failure-${now}-${state.cursor.id}`;
  const item = {
    title: `Magic Context subagent failure sentinel: ${alerts.length} alert${alerts.length === 1 ? '' : 's'}`,
    body: digestBody(alerts),
    data: { delivery_id: deliveryId, alerts: alerts.length, bounded },
  };
  // The delivery id as replace_key makes a replayed write replace, not repeat, this run's item.
  try {
    await sink.digest(AGENT, item, 'wake', { replace_key: deliveryId });
  } catch (e) {
    if (!e || !e.data || e.data.code !== 'digest_replace_key_unsupported') throw e;
    await sink.digest(AGENT, item, 'wake');
  }
}

return {
  examined,
  alerts: alerts.length,
  bounded,
  evaluated: evaluate,
  bootstrap_rows: bootstrapRows,
  tail_rows: tailRows,
  stored_bytes: state.hours.reduce((sum, hour) => sum + hour[2], 0) + state.older_bytes,
  watermark: state.cursor,
};
