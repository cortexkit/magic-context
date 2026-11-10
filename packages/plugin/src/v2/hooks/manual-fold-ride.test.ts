import { expect, test } from "bun:test";
import { queuePendingOp } from "../../features/magic-context/storage-ops";
import { CHECKPOINT_NOTE } from "../fold/summary";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

// A manual host compaction (the user's /compact) on a session with published
// history makes the compaction hook stage and commit a new history head: the
// two synthetic messages at the start of every request. The first (m[0], the
// frozen baseline) gains the newer summaries and the second (m[1], what was
// added since) resets. The next request therefore starts with different bytes,
// so the provider's cached prefix is already lost. Work queued for the next
// rebuild, such as a drop the agent queued with ctx_reduce, must land on that
// request, as it does when the transform itself rebuilds the head for a
// changed system prompt.

const options = {
    area: "oc2-manual-fold-ride",
    instructions: false,
    temporal: false,
    cacheTtl: "never",
};

type Fixture = Awaited<ReturnType<typeof oc2ContextFixture>>;
type Pass = Awaited<ReturnType<Fixture["pass"]>>;

const head = (pass: Pass) => JSON.stringify(pass.draft.messages.slice(0, 2));

/** The served text of the assistant row `id`; a drop replaces it with a placeholder. */
const servedText = (pass: Pass, id: string) =>
    JSON.stringify(pass.draft.messages.find((message) => message.id === id)?.content ?? null);

/** The summary the host stored on its latest compaction row. */
const storedSummary = (f: Fixture) =>
    (
        JSON.parse(
            (
                f.raw
                    .prepare(
                        "SELECT data FROM session_message WHERE session_id = ? AND type = 'compaction' ORDER BY seq DESC LIMIT 1",
                    )
                    .get(f.session) as { data: string }
            ).data,
        ) as { summary?: string }
    ).summary;

/** Serve a head with one compartment, publish a newer one that only a rebuild
 * may render, and queue a drop that only a rebuild may apply. */
async function heldDropWithNewerHistory(seed: number) {
    const f = await oc2ContextFixture(seed, options);
    f.compartment(4);
    await f.pass();
    f.compartment(10);
    await f.pass();
    // Row 13 is the assistant reply of turn 6, after both compartments.
    const target = `r${seed}-13`;
    const { tag } = f.db
        .prepare("SELECT tag_number AS tag FROM tags WHERE session_id = ? AND message_id = ?")
        .get(f.session, `${target}:p0`) as { tag: number };
    queuePendingOp(f.db, f.session, tag, "drop");
    const waiting = await f.pass();
    const pending = () =>
        (
            f.db
                .prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ?")
                .get(f.session) as { n: number }
        ).n;
    return { f, seed, target, waiting, pending };
}

test("control: a fold the transform executes for a system-prompt change applies the held drop", async () => {
    const { f, seed, target, waiting, pending } = await heldDropWithNewerHistory(41886);
    try {
        expect(servedText(waiting, target)).toContain(`${seed}/6: `);
        expect(pending()).toBe(1);
        f.setSystem("Review the isolated project with a changed system prompt.");
        const rebuilt = await f.pass();
        expect(head(rebuilt)).not.toBe(head(waiting));
        expect(rebuilt.logs.some((line) => /rewrite permission: allowed=true/.test(line))).toBe(
            true,
        );
        expect(servedText(rebuilt, target)).not.toContain(`${seed}/6: `);
        expect(pending()).toBe(0);
    } finally {
        await f.cleanup();
    }
}, 60000);

// Before the fix this failed on every OpenCode 2 version (2.0.22 through 2.2.6
// on real hosts): the head changed but the pass logged `rewrite permission:
// allowed=false ride=none`, and the queued drop waited for a second, avoidable
// rebuild.
test("the pass after a manual host fold that rebuilt the served head applies the held drop", async () => {
    const { f, seed, target, waiting, pending } = await heldDropWithNewerHistory(42886);
    try {
        expect(servedText(waiting, target)).toContain(`${seed}/6: `);
        expect(pending()).toBe(1);
        await f.nativeFold(3, 0, "", "manual");
        const afterFold = await f.pass();
        // The manual fold served a new history head (the newer compartment moved
        // into m[0]): the provider's cached prefix is gone.
        expect(head(afterFold)).not.toBe(head(waiting));
        expect(head(afterFold)).toContain("Review history 1");
        // The host stores Magic Context's fixed checkpoint note as the summary,
        // and the request serves Magic Context's own head instead of that note.
        expect(storedSummary(f)).toBe(CHECKPOINT_NOTE);
        expect(afterFold.bytes).not.toContain(CHECKPOINT_NOTE);
        expect(afterFold.logs.some((line) => /rewrite permission: allowed=true/.test(line))).toBe(
            true,
        );
        expect(servedText(afterFold, target)).not.toContain(`${seed}/6: `);
        expect(pending()).toBe(0);
        // One ride: the next request replays the rebuilt request byte for byte.
        const replay = await f.pass();
        expect(replay.bytes).toBe(afterFold.bytes);
        expect(replay.bytes).not.toContain(CHECKPOINT_NOTE);
        expect(replay.logs.some((line) => /rewrite permission: allowed=false/.test(line))).toBe(
            true,
        );
    } finally {
        await f.cleanup();
    }
}, 60000);

test("a manual host fold that leaves the served head unchanged keeps the cache and the held drop", async () => {
    const f = await oc2ContextFixture(43886, options);
    try {
        f.compartment(10);
        await f.pass();
        const target = `r43886-13`;
        const { tag } = f.db
            .prepare("SELECT tag_number AS tag FROM tags WHERE session_id = ? AND message_id = ?")
            .get(f.session, `${target}:p0`) as { tag: number };
        queuePendingOp(f.db, f.session, tag, "drop");
        const waiting = await f.pass();
        // Every published compartment is already in the served head, so the
        // manual fold re-renders the same head.
        await f.nativeFold(3, 0, "", "manual");
        const afterFold = await f.pass();
        expect(head(afterFold)).toBe(head(waiting));
        expect(afterFold.bytes).toBe(waiting.bytes);
        expect(
            afterFold.logs.some((line) => /host checkpoint head: changed=false/.test(line)),
        ).toBe(true);
        expect(afterFold.logs.some((line) => /rewrite permission: allowed=false/.test(line))).toBe(
            true,
        );
        expect(servedText(afterFold, target)).toContain("43886/6: ");
    } finally {
        await f.cleanup();
    }
}, 60000);
