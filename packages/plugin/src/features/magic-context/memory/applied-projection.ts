import { createHash } from "node:crypto";
import { BoundedSessionMap } from "../../../shared/bounded-session-map";
import { getHarness } from "../../../shared/harness";
import type { Database } from "../../../shared/sqlite";
import { escapeXmlContent } from "../compartment-storage";
import type { Memory } from "./types";

/**
 * Applied-state projection: what one session's served memory prefix holds.
 *
 * A HARD fold is the only pass that reads current memory rows. It captures:
 *   - the memories rendered as m[0] text, mural cues, and the m[1] additions the
 *     fold itself rendered (each with the revision and text captured in the
 *     fold's read snapshot);
 *   - the exact m[1] memory block the fold rendered, which later SOFT passes
 *     replay byte for byte;
 *   - the session's agent-fragment watermark: fragments up to it are already
 *     part of the canonical rows the fold read.
 * A busting SOFT pass only appends this session's newer agent fragments; the
 * fragments it commits are carried forward unchanged until the next HARD.
 *
 * Search uses the projection to decide which memories are already fully visible.
 */

export type AppliedRepresentation = "text" | "delta" | "cue";

/** One agent fragment as it was committed to this session's m[1]. */
export interface CommittedFragment {
    /** Mutation-log cursor for an admitted dashboard operation; agent ids stay independent. */
    dashboardLogId?: number;
    id: number;
    /**
     * `full` shows the operation's lines; `marker` shows only a stale-memory marker;
     * `overflow` is the one aggregate line for edits that did not fit even as markers
     * (always the last entry, and the only one whose line is rewritten as it grows).
     */
    form: "full" | "marker" | "overflow";
    /** For `overflow`: every memory id it stands for, and how many edits. */
    overflowIds?: number[];
    overflowCount?: number;
    lines: string[];
    /** Full memory texts shown by a `full` fragment; empty for a marker. */
    visibleTexts: Array<{ id: number; text: string }>;
}

export interface AppliedProjection {
    generation: number;
    hardMemoryBlock: string;
    fragmentWatermark: number;
    committed: CommittedFragment[];
    /**
     * True when the tuple was adopted from a cache written before projections
     * existed: its blocks are the cached bytes, and there is no text manifest.
     */
    legacy: boolean;
}

export interface HardProjectionInput {
    sessionId: string;
    projectPath: string | undefined;
    m0Text: string;
    hardMemoryBlock: string;
    fragmentWatermark: number;
    /** Revisions read in the same snapshot as the rendered rows; never re-read at commit. */
    revisions: ReadonlyMap<number, number>;
    textMemories: readonly Memory[];
    cueMemories: readonly Memory[];
    deltaMemories: readonly Memory[];
}

function tablesPresent(db: Database): boolean {
    return (
        (
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('memory_applied_snapshots','memory_applied_rows')",
                )
                .get() as { count: number }
        ).count === 2
    );
}

export function m0TextSha256(m0Text: string): string {
    return createHash("sha256").update(m0Text).digest("hex");
}

export interface CachedM0OwnerEvidence {
    projectIdentity?: string;
    unscopedHardMatch: boolean;
}

const unknownOwnerEvidence = new WeakMap<
    Database,
    BoundedSessionMap<{
        digest: string;
        evidence: CachedM0OwnerEvidence;
    }>
>();

/** Only one non-legacy snapshot matching these exact bytes can establish their project owner. */
export function readCachedM0OwnerEvidence(
    db: Database,
    sessionId: string,
    m0Bytes: Uint8Array,
    force = false,
): CachedM0OwnerEvidence {
    const cacheKey = `${getHarness()}\0${sessionId}`;
    const digest = createHash("sha256").update(m0Bytes).digest("hex");
    let cache = unknownOwnerEvidence.get(db);
    const cached = cache?.get(cacheKey);
    if (!force && !db.inTransaction && cached?.digest === digest) return cached.evidence;
    const rows = tablesPresent(db)
        ? (db
              .prepare(
                  `SELECT project_path FROM memory_applied_snapshots
         WHERE session_id = ? AND harness = ? AND m0_sha256 = ? AND legacy = 0
         ORDER BY project_path LIMIT 2`,
              )
              .all(sessionId, getHarness(), digest) as Array<{ project_path: string }>)
        : [];
    const evidence: CachedM0OwnerEvidence = {
        projectIdentity:
            rows.length === 1 && rows[0].project_path.trim().length > 0
                ? rows[0].project_path
                : undefined,
        unscopedHardMatch: rows.some((row) => row.project_path === ""),
    };
    // Successful recovery is persisted in session_meta.cached_m0_project_identity.
    // Cache only unknown ownership; writeHardProjection and writeSoftProjection each
    // invalidate this session's negative result before updating snapshots.
    if (!evidence.projectIdentity && !db.inTransaction) {
        if (!cache) {
            cache = new BoundedSessionMap(100);
            unknownOwnerEvidence.set(db, cache);
        }
        cache.set(cacheKey, { digest, evidence });
    }
    return evidence;
}

const ID_CHUNK = 500;

/** Read memory revisions inside the caller's read snapshot. */
export function readMemoryRevisions(db: Database, ids: readonly number[]): Map<number, number> {
    const revisions = new Map<number, number>();
    const unique = [...new Set(ids)];
    const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    const hasRevision = columns.some((column) => column.name === "revision");
    for (let start = 0; start < unique.length; start += ID_CHUNK) {
        const chunk = unique.slice(start, start + ID_CHUNK);
        const rows = db
            .prepare(
                `SELECT id, ${hasRevision ? "revision" : "1"} AS revision FROM memories WHERE id IN (${chunk.map(() => "?").join(",")})`,
            )
            .all(...chunk) as Array<{ id: number; revision: number }>;
        for (const row of rows) revisions.set(row.id, row.revision);
    }
    return revisions;
}

function key(sessionId: string, projectPath: string | undefined) {
    return { sessionId, harness: getHarness(), projectPath: projectPath ?? "" };
}

/**
 * Replace this session's applied tuple after a HARD fold. Call inside the same
 * write transaction that persists the served m[0]/m[1] bytes, so bytes and
 * manifest never diverge.
 */
export function writeHardProjection(db: Database, input: HardProjectionInput): void {
    unknownOwnerEvidence.get(db)?.delete(`${getHarness()}\0${input.sessionId}`);
    if (!tablesPresent(db)) return;
    const k = key(input.sessionId, input.projectPath);
    const rows = new Map<
        number,
        { revision: number; text: string; representations: AppliedRepresentation[] }
    >();
    const add = (memory: Memory, representation: AppliedRepresentation) => {
        const entry = rows.get(memory.id) ?? {
            revision: input.revisions.get(memory.id) ?? 1,
            text: memory.content,
            representations: [],
        };
        if (!entry.representations.includes(representation))
            entry.representations.push(representation);
        rows.set(memory.id, entry);
    };
    for (const memory of input.textMemories) add(memory, "text");
    for (const memory of input.cueMemories) add(memory, "cue");
    for (const memory of input.deltaMemories) add(memory, "delta");
    const previous = db
        .prepare(
            "SELECT generation FROM memory_applied_snapshots WHERE session_id=? AND harness=? AND project_path=?",
        )
        .get(k.sessionId, k.harness, k.projectPath) as { generation: number } | null;
    db.prepare(
        "DELETE FROM memory_applied_snapshots WHERE session_id=? AND harness=? AND project_path=?",
    ).run(k.sessionId, k.harness, k.projectPath);
    db.prepare(
        "DELETE FROM memory_applied_rows WHERE session_id=? AND harness=? AND project_path=?",
    ).run(k.sessionId, k.harness, k.projectPath);
    db.prepare(
        `INSERT INTO memory_applied_snapshots
            (session_id, harness, project_path, generation, m0_sha256, hard_memory_block, fragment_watermark, committed_fragments_json, legacy)
         VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 0)`,
    ).run(
        k.sessionId,
        k.harness,
        k.projectPath,
        (previous?.generation ?? 0) + 1,
        m0TextSha256(input.m0Text),
        input.hardMemoryBlock,
        input.fragmentWatermark,
    );
    const insert = db.prepare(
        "INSERT INTO memory_applied_rows(session_id,harness,project_path,memory_id,applied_revision,projected_text,projected_metadata_json) VALUES (?,?,?,?,?,?,?)",
    );
    for (const [memoryId, entry] of rows)
        insert.run(
            k.sessionId,
            k.harness,
            k.projectPath,
            memoryId,
            entry.revision,
            entry.text,
            JSON.stringify({ representations: entry.representations }),
        );
}

/**
 * Record a busting SOFT pass: the fragments it committed, carried forward with
 * every earlier committed fragment. A legacy tuple (adopted from a cache that
 * predates projections) is created here on its first SOFT pass, with its cached
 * memory bytes as its blocks. Call inside the write transaction that stores the
 * new m[1] bytes.
 */
export function writeSoftProjection(
    db: Database,
    input: {
        sessionId: string;
        projectPath: string | undefined;
        m0Text: string;
        projection: AppliedProjection;
    },
): void {
    unknownOwnerEvidence.get(db)?.delete(`${getHarness()}\0${input.sessionId}`);
    if (!tablesPresent(db)) return;
    const k = key(input.sessionId, input.projectPath);
    db.prepare(
        `INSERT INTO memory_applied_snapshots
            (session_id, harness, project_path, generation, m0_sha256, hard_memory_block, fragment_watermark, committed_fragments_json, legacy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, harness, project_path) DO UPDATE SET
            generation = excluded.generation,
            m0_sha256 = excluded.m0_sha256,
            hard_memory_block = excluded.hard_memory_block,
            fragment_watermark = excluded.fragment_watermark,
            committed_fragments_json = excluded.committed_fragments_json,
            legacy = excluded.legacy`,
    ).run(
        k.sessionId,
        k.harness,
        k.projectPath,
        input.projection.generation + 1,
        m0TextSha256(input.m0Text),
        input.projection.hardMemoryBlock,
        input.projection.fragmentWatermark,
        JSON.stringify(input.projection.committed),
        input.projection.legacy ? 1 : 0,
    );
}

/** Whether this session has any applied tuple row, whatever baseline it describes. */
export function hasAppliedSnapshot(
    db: Database,
    sessionId: string,
    projectPath: string | undefined,
): boolean {
    if (!tablesPresent(db)) return false;
    const k = key(sessionId, projectPath);
    return Boolean(
        db
            .prepare(
                "SELECT 1 FROM memory_applied_snapshots WHERE session_id=? AND harness=? AND project_path=?",
            )
            .get(k.sessionId, k.harness, k.projectPath),
    );
}

/**
 * Load the applied tuple for one session. Returns null when none exists or when
 * it was captured with different m[0] bytes than the caller is serving: a stale
 * tuple must never be replayed against another baseline.
 */
export function readAppliedProjection(
    db: Database,
    sessionId: string,
    projectPath: string | undefined,
    servedM0Text: string,
): AppliedProjection | null {
    if (!tablesPresent(db)) return null;
    const k = key(sessionId, projectPath);
    const row = db
        .prepare(
            "SELECT generation, m0_sha256, hard_memory_block, fragment_watermark, committed_fragments_json, legacy FROM memory_applied_snapshots WHERE session_id=? AND harness=? AND project_path=?",
        )
        .get(k.sessionId, k.harness, k.projectPath) as {
        generation: number;
        m0_sha256: string;
        hard_memory_block: string;
        fragment_watermark: number;
        committed_fragments_json: string;
        legacy: number;
    } | null;
    if (!row || row.m0_sha256 !== m0TextSha256(servedM0Text)) return null;
    let committed: CommittedFragment[] = [];
    try {
        committed = JSON.parse(row.committed_fragments_json) as CommittedFragment[];
    } catch {
        return null;
    }
    return {
        generation: row.generation,
        hardMemoryBlock: row.hard_memory_block,
        fragmentWatermark: row.fragment_watermark,
        committed,
        legacy: row.legacy === 1,
    };
}

/** Memory ids shown only as mural cues in the frozen image. */
export function readCueMemoryIds(db: Database, sessionId: string): Set<number> {
    const ids = new Set<number>();
    if (!tablesPresent(db)) return ids;
    const rows = db
        .prepare(
            "SELECT memory_id, projected_metadata_json FROM memory_applied_rows WHERE session_id=? AND harness=?",
        )
        .all(sessionId, getHarness()) as Array<{
        memory_id: number;
        projected_metadata_json: string;
    }>;
    for (const row of rows) {
        try {
            const metadata = JSON.parse(row.projected_metadata_json) as {
                representations?: string[];
            };
            if (metadata.representations?.includes("cue")) ids.add(row.memory_id);
        } catch {
            // A malformed row describes nothing shown.
        }
    }
    return ids;
}

/**
 * Memory ids whose CURRENT canonical text is already fully visible in this
 * session's prompt: rendered as m[0] text or as a fold-time m[1] addition, or
 * shown in full by a committed agent fragment. A memory whose text changed
 * after it was rendered stays discoverable, a cue or a stale-memory marker never
 * hides a memory, and an archived row is never treated as visible.
 *
 * Returns undefined when the session has no non-legacy applied tuple; callers
 * then judge visibility from the served bytes.
 */
export function readFullyVisibleMemoryIds(
    db: Database,
    sessionId: string,
): Set<number> | undefined {
    if (!tablesPresent(db)) return undefined;
    const harness = getHarness();
    const snapshot = db
        .prepare(
            "SELECT committed_fragments_json, legacy FROM memory_applied_snapshots WHERE session_id=? AND harness=? LIMIT 1",
        )
        .get(sessionId, harness) as { committed_fragments_json: string; legacy: number } | null;
    if (!snapshot || snapshot.legacy === 1) return undefined;
    const visibleTexts = new Map<number, Set<string>>();
    const addText = (id: number, text: string) => {
        const texts = visibleTexts.get(id) ?? new Set<string>();
        texts.add(text);
        visibleTexts.set(id, texts);
    };
    const rows = db
        .prepare(
            "SELECT memory_id, projected_text, projected_metadata_json FROM memory_applied_rows WHERE session_id=? AND harness=?",
        )
        .all(sessionId, harness) as Array<{
        memory_id: number;
        projected_text: string;
        projected_metadata_json: string;
    }>;
    for (const row of rows) {
        try {
            const metadata = JSON.parse(row.projected_metadata_json) as {
                representations?: string[];
            };
            if (
                metadata.representations?.includes("text") ||
                metadata.representations?.includes("delta")
            )
                addText(row.memory_id, row.projected_text);
        } catch {
            // A malformed row describes nothing shown.
        }
    }
    try {
        for (const fragment of JSON.parse(snapshot.committed_fragments_json) as CommittedFragment[])
            if (fragment.form === "full")
                for (const shown of fragment.visibleTexts) addText(shown.id, shown.text);
    } catch {
        // A malformed fragment list shows nothing extra.
    }
    const visible = new Set<number>();
    const ids = [...visibleTexts.keys()];
    for (let start = 0; start < ids.length; start += ID_CHUNK) {
        const chunk = ids.slice(start, start + ID_CHUNK);
        const current = db
            .prepare(
                `SELECT id, content, status FROM memories WHERE id IN (${chunk.map(() => "?").join(",")})`,
            )
            .all(...chunk) as Array<{ id: number; content: string; status: string }>;
        for (const row of current) {
            if (row.status === "archived") continue;
            if (visibleTexts.get(row.id)?.has(row.content)) visible.add(row.id);
        }
    }
    return visible;
}

/**
 * Whether this session's memory pair already shows `text` as the full text of memory
 * `memoryId`: rendered by its HARD fold (m[0] text or an m[1] addition) or shown in
 * full by a committed fragment. Read from the session's own served manifest only,
 * never from canonical rows. Fragments still waiting for a SOFT do not count (they
 * may yet become markers), and a session with no applied tuple shows nothing, so a
 * caller that is unsure includes the text.
 */
export function sessionShowsMemoryText(
    db: Database,
    sessionId: string,
    memoryId: number,
    text: string,
): boolean {
    if (!tablesPresent(db)) return false;
    const harness = getHarness();
    const rows = db
        .prepare(
            "SELECT projected_text, projected_metadata_json FROM memory_applied_rows WHERE session_id=? AND harness=? AND memory_id=?",
        )
        .all(sessionId, harness, memoryId) as Array<{
        projected_text: string;
        projected_metadata_json: string;
    }>;
    for (const row of rows) {
        if (row.projected_text !== text) continue;
        try {
            const metadata = JSON.parse(row.projected_metadata_json) as {
                representations?: string[];
            };
            if (
                metadata.representations?.includes("text") ||
                metadata.representations?.includes("delta")
            )
                return true;
        } catch {
            // A malformed row describes nothing shown.
        }
    }
    const shows = (json: string) => {
        try {
            return (JSON.parse(json) as Array<{ id: number; text: string }>).some(
                (shown) => shown.id === memoryId && shown.text === text,
            );
        } catch {
            return false;
        }
    };
    const snapshot = db
        .prepare(
            "SELECT committed_fragments_json FROM memory_applied_snapshots WHERE session_id=? AND harness=? LIMIT 1",
        )
        .get(sessionId, harness) as { committed_fragments_json: string } | null;
    if (snapshot) {
        try {
            for (const fragment of JSON.parse(
                snapshot.committed_fragments_json,
            ) as CommittedFragment[])
                if (fragment.form === "full" && shows(JSON.stringify(fragment.visibleTexts)))
                    return true;
        } catch {
            // A malformed fragment list shows nothing.
        }
    }
    return false;
}

// The m[0]/m[1] texts this process last served for a session when that pair was
// rendered fresh and NOT persisted (contention recovery). Neither session_meta
// nor the stored projection describes such a pair, so search visibility must be
// judged against these texts until a persisted pair is served again.
const servedRecoveryTexts = new BoundedSessionMap<readonly string[]>(256);

/** Remember a fresh, non-persisted m[0]/m[1] pair that this process just served. */
export function recordServedRecoveryTexts(sessionId: string, texts: readonly string[]): void {
    servedRecoveryTexts.set(sessionId, [...texts]);
}

/** The session is serving persisted bytes again; forget any recovery pair. */
export function clearServedRecoveryTexts(sessionId: string): void {
    servedRecoveryTexts.delete(sessionId);
}

export function servedRecoveryTextsFor(sessionId: string): readonly string[] | undefined {
    return servedRecoveryTexts.get(sessionId);
}

const MEMORY_LINE_START = /(?:^|\n)#(\d+)(?: \[[^\]\n]*\])?: /g;
const SHOWN_LINE_START = /<(?:updated|added) id="(\d+)"/g;

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Memory ids whose CURRENT text appears in full in the given served texts: as a
 * rendered memory entry (`#id: text`, optionally with a source label) or as an
 * `<updated>`/`<added>` line. Memory text may span several lines; the whole text
 * must be present and end where the entry ends (at the next entry, a closing
 * tag, or the end of the text). Used when no applied projection describes what
 * was served (a cache from before projections, or a fresh recovery pair). An
 * edited row is not visible because its old entry no longer matches its current
 * text, and an archived row is never visible.
 *
 * `candidateIds` limits the check to ids the caller knows were rendered.
 */
export function readServedTextVisibleMemoryIds(
    db: Database,
    texts: readonly string[],
    candidateIds?: ReadonlySet<number>,
): Set<number> {
    const mentioned = new Set<number>();
    for (const text of texts) {
        for (const pattern of [MEMORY_LINE_START, SHOWN_LINE_START]) {
            pattern.lastIndex = 0;
            for (const match of text.matchAll(pattern)) {
                const id = Number(match[1]);
                if (!candidateIds || candidateIds.has(id)) mentioned.add(id);
            }
        }
    }
    const visible = new Set<number>();
    const ids = [...mentioned];
    for (let start = 0; start < ids.length; start += ID_CHUNK) {
        const chunk = ids.slice(start, start + ID_CHUNK);
        const current = db
            .prepare(
                `SELECT id, content, status FROM memories WHERE id IN (${chunk.map(() => "?").join(",")})`,
            )
            .all(...chunk) as Array<{ id: number; content: string; status: string }>;
        for (const row of current) {
            if (row.status === "archived") continue;
            const escaped = escapeRegExp(escapeXmlContent(row.content));
            // The entry must end where the next entry or a closing tag starts, so a
            // first line alone never counts as a whole multiline claim.
            const entry = new RegExp(
                `(?:^|\\n)#${row.id}(?: \\[[^\\]\\n]*\\])?: ${escaped}(?=\\n#\\d+(?: \\[[^\\]\\n]*\\])?: |\\n</|$)`,
            );
            const shown = new RegExp(`<(updated|added) id="${row.id}"[^>]*>${escaped}</\\1>`);
            if (texts.some((text) => entry.test(text) || shown.test(text))) visible.add(row.id);
        }
    }
    return visible;
}
