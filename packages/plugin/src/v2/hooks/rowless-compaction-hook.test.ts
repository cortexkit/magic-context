import { expect, spyOn, test } from "bun:test";
import { queuePendingOp } from "../../features/magic-context/storage-ops";
import * as rustServedM0 from "../../hooks/magic-context/rust-served-m0";
import { NativeFoldReplay } from "../fold/native-replay";
import type { FoldIdentity } from "../fold/owner";
import { CHECKPOINT_NOTE } from "../fold/summary";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

// OpenCode can ask the compaction hook for a checkpoint summary while no
// checkpoint row is running: from 2.3.1 it prepares a compaction in the
// background after a high-usage reply (on by default), and older hosts do it
// for a model in provider compaction mode. Nothing is cut at that moment, and
// the host may never install what it prepared. The next ordinary request is a
// defer pass that replays the stored history head (m[0] and m[1], the two
// synthetic messages at the start of every request). If the hook stored a newly
// rendered baseline, that defer pass would send a different head, rewriting
// the provider's cached prefix without landing any queued reduction in it.

const options = {
    area: "oc2-rowless-compaction-hook",
    instructions: false,
    temporal: false,
    cacheTtl: "never",
};

type Fixture = Awaited<ReturnType<typeof oc2ContextFixture>>;
type Pass = Awaited<ReturnType<Fixture["pass"]>>;

const head = (pass: Pass) => JSON.stringify(pass.draft.messages.slice(0, 2));
const headText = (pass: Pass, index: 0 | 1) =>
    JSON.stringify(pass.draft.messages[index]?.content ?? null);

/** The served text of row `id`; a drop replaces it with a placeholder. */
const servedText = (pass: Pass, id: string) =>
    JSON.stringify(pass.draft.messages.find((message) => message.id === id)?.content ?? null);

/** Every session_meta column of the session, quoted by SQLite so type and bytes both count. */
function storedRow(f: Fixture) {
    const columns = (
        f.db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    return f.db
        .prepare(
            `SELECT ${columns.map((name) => `quote("${name}") AS "${name}"`).join(", ")} FROM session_meta WHERE session_id = ?`,
        )
        .get(f.session) as Record<string, string> | null;
}

/** The stored baseline columns only: the history head pair, its markers and the memory manifest. */
function baselineColumns(f: Fixture) {
    const row = storedRow(f) ?? {};
    return Object.fromEntries(
        Object.entries(row).filter(
            ([key]) =>
                key.startsWith("cached_m0_") ||
                key.startsWith("cached_m1_") ||
                key === "memory_block_count" ||
                key === "memory_block_ids",
        ),
    );
}

/** The baseline columns of a newly created metadata row: each column's declared default. */
const emptyBaseline = (f: Fixture) => {
    const defaults = new Map(
        (
            f.db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
                name: string;
                dflt_value: string | null;
            }>
        ).map((column) => [column.name, column.dflt_value ?? "NULL"]),
    );
    return Object.fromEntries(
        Object.keys(baselineColumns(f)).map((key) => [key, defaults.get(key)]),
    );
};

const pendingOps = (f: Fixture) =>
    (
        f.db
            .prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ?")
            .get(f.session) as { n: number }
    ).n;

const record = async (f: Fixture) =>
    (await f.hostStorage.get(`fold/v1/${f.session}`)) as FoldIdentity | undefined;

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

/**
 * Serve a head with one compartment, then serve a newer compartment through
 * m[1] on an execute pass, and queue a drop that only a rebuild may apply.
 */
async function servedDeltaWithHeldDrop(seed: number) {
    const f = await oc2ContextFixture(seed, options);
    f.compartment(4);
    await f.pass();
    f.compartment(10);
    // A reply at 70% of the window makes the next pass an execute pass, which
    // serves the newly published summary in m[1].
    f.respond(1, 700_000);
    const published = await f.pass();
    f.respond();
    // Row 13 is the assistant reply of turn 6, after both compartments.
    const target = `r${seed}-13`;
    const { tag } = f.db
        .prepare("SELECT tag_number AS tag FROM tags WHERE session_id = ? AND message_id = ?")
        .get(f.session, `${target}:p0`) as { tag: number };
    queuePendingOp(f.db, f.session, tag, "drop");
    const waiting = await f.pass();
    return { f, seed, target, published, waiting };
}

test("a compaction request with no running checkpoint row stores nothing and the next passes replay the served heads", async () => {
    const { f, seed, target, published, waiting } = await servedDeltaWithHeldDrop(61886);
    try {
        // Setup: the newer summary is served in m[1], not yet folded into m[0].
        expect(headText(published, 1)).toContain("Review history 1");
        expect(headText(published, 0)).not.toContain("Review history 1");
        expect(head(waiting)).toBe(head(published));
        expect(waiting.logs.some((line) => /decision=defer/.test(line))).toBe(true);
        expect(servedText(waiting, target)).toContain(`${seed}/6: `);
        expect(pendingOps(f)).toBe(1);

        const rowBefore = storedRow(f);
        const result = await f.prepareCompaction();
        // What the host receives is unchanged: the fixed checkpoint note.
        expect(result?.summary).toBe(CHECKPOINT_NOTE);
        // Every stored session_meta column, the baseline pair and all of its
        // markers included, is byte-identical across the call.
        expect(storedRow(f)).toEqual(rowBefore);
        // The owner record keeps its rowless shape and the head it stands for.
        // The host stores it as JSON, so only defined keys count.
        const owned = await record(f);
        expect(Object.keys(JSON.parse(JSON.stringify(owned ?? {}))).sort()).toEqual([
            "head",
            "submitted",
            "submittedSha",
            "watermark",
        ]);
        expect(owned?.submitted).toBe(CHECKPOINT_NOTE);
        expect(owned?.head).toContain("Review history 1");

        // The next ordinary passes replay the served heads byte for byte, and
        // the queued drop stays queued for a real rebuild.
        const after = await f.pass();
        expect(after.bytes).toBe(waiting.bytes);
        expect(after.logs.some((line) => /rewrite permission: allowed=false/.test(line))).toBe(
            true,
        );
        expect(servedText(after, target)).toContain(`${seed}/6: `);
        expect(pendingOps(f)).toBe(1);
        f.respond();
        const later = await f.pass();
        expect(head(later)).toBe(head(waiting));
        expect(pendingOps(f)).toBe(1);

        // A real rebuild folds the summary into m[0] exactly once and lands the drop.
        f.setSystem("Review the isolated project with a changed system prompt.");
        const rebuilt = await f.pass();
        expect(head(rebuilt)).not.toBe(head(waiting));
        expect(occurrences(headText(rebuilt, 0), "Review history 1")).toBe(1);
        expect(headText(rebuilt, 1)).not.toContain("Review history 1");
        expect(rebuilt.logs.some((line) => /rewrite permission: allowed=true/.test(line))).toBe(
            true,
        );
        expect(servedText(rebuilt, target)).not.toContain(`${seed}/6: `);
        expect(pendingOps(f)).toBe(0);
    } finally {
        await f.cleanup();
    }
}, 60000);

test("a compaction request before any context pass stores no baseline, and the first pass renders one", async () => {
    const f = await oc2ContextFixture(62886, options);
    try {
        f.compartment(4);
        expect(storedRow(f)).toBeNull();
        const result = await f.prepareCompaction();
        expect(result?.summary).toBe(CHECKPOINT_NOTE);
        // The hook may create the session's metadata row, but every baseline
        // column keeps the value a new row starts with.
        expect(storedRow(f)).not.toBeNull();
        expect(baselineColumns(f)).toEqual(emptyBaseline(f));
        const first = await f.pass();
        expect(first.logs.some((line) => /first_render=true/.test(line))).toBe(true);
        expect(headText(first, 0)).toContain("Review history 0");
    } finally {
        await f.cleanup();
    }
}, 60000);

test("a compaction request with a running checkpoint row that native admission declines still stores its baseline", async () => {
    const { f } = await servedDeltaWithHeldDrop(63886);
    const supply = spyOn(NativeFoldReplay.prototype, "supply").mockResolvedValue(false);
    try {
        const before = baselineColumns(f);
        const id = await f.nativeFold(3, 0, "");
        // A real cut is in progress here: the legacy owner materializes and
        // keeps the baseline the checkpoint stands for, as it always has.
        const after = baselineColumns(f);
        expect(after.cached_m0_bytes).not.toBe(before.cached_m0_bytes);
        expect(after.cached_m0_max_compartment_seq).toBe("1");
        const owned = await record(f);
        expect(owned?.cutSeq).toBeDefined();
        expect(owned?.answered).toEqual([id]);
        expect(owned?.head).toContain("Review history 1");
    } finally {
        supply.mockRestore();
        await f.cleanup();
    }
}, 60000);

test("in Rust mode a compaction request with no running checkpoint row answers from the module's served baseline", async () => {
    const moduleHead =
        "<session-history>\nThe module's own served history baseline.\n</session-history>";
    const served = spyOn(rustServedM0, "servedModuleM0Text").mockReturnValue(moduleHead);
    const f = await oc2ContextFixture(64886, {
        ...options,
        configOverrides: { transform_mode: "rust" },
    });
    try {
        f.compartment(4);
        expect(storedRow(f)).toBeNull();
        const result = await f.prepareCompaction();
        expect(result?.summary).toBe(CHECKPOINT_NOTE);
        const owned = await record(f);
        expect(owned?.head).toBe(moduleHead);
        expect(owned?.cutSeq).toBeUndefined();
        expect(storedRow(f)).not.toBeNull();
        expect(baselineColumns(f)).toEqual(emptyBaseline(f));
    } finally {
        await f.cleanup();
        served.mockRestore();
    }
}, 60000);
