import { expect, spyOn, test } from "bun:test";
import { resetServedHeadsForTest } from "../../hooks/magic-context/host-checkpoint-ride";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

// A manual host compaction (the user's /compact) on OpenCode 2 renders a new
// history head (m[0] and m[1], the two synthetic messages at the start of every
// request) inside the compaction hook, but the head may only become the served
// one once the host has admitted the checkpoint. Until then the stored head
// must stay the one the provider cached: a refused admission, or a process that
// stops before the admission finishes, must leave the next request serving the
// previous head byte for byte.

const options = {
    area: "oc2-manual-fold-staging",
    instructions: false,
    temporal: false,
    cacheTtl: "never",
};

type Fixture = Awaited<ReturnType<typeof oc2ContextFixture>>;
type Pass = Awaited<ReturnType<Fixture["pass"]>>;

const head = (pass: Pass) => JSON.stringify(pass.draft.messages.slice(0, 2));

/**
 * Everything the stored history head consists of: the rendered payloads, the
 * id manifest of memories rendered into it, the memory projection keyed to its
 * bytes, and the session_meta markers that describe it.
 */
function storedHead(f: Fixture) {
    const meta = f.db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get(f.session) as
        | Record<string, unknown>
        | undefined;
    const markers = Object.fromEntries(
        Object.entries(meta ?? {}).filter(
            ([key]) =>
                key.startsWith("cached_m0_") ||
                key.startsWith("cached_m1_") ||
                key === "memory_block_count",
        ),
    );
    const rows = (sql: string) =>
        (f.db.prepare(sql).all(f.session) as Record<string, unknown>[]).map((row) =>
            Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                    key,
                    value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value,
                ]),
            ),
        );
    return {
        markers,
        renderCache: rows(
            "SELECT cache_key, value FROM session_render_cache WHERE session_id = ? ORDER BY cache_key",
        ),
        memoryBlockIds: rows(
            "SELECT chunk, body FROM session_meta_chunks WHERE session_id = ? AND column_name = 'memory_block_ids' ORDER BY chunk",
        ),
        projection: rows(
            "SELECT project_path, generation, m0_sha256, hard_memory_block, fragment_watermark, committed_fragments_json, legacy FROM memory_applied_snapshots WHERE session_id = ? ORDER BY project_path",
        ),
    };
}

/** The host gives up on a compaction it was running (a refusal, a cancel, a restart). */
function failRunningCompaction(f: Fixture) {
    f.raw
        .prepare(
            "UPDATE session_message SET data = json_set(data, '$.status', 'failed') WHERE session_id = ? AND type = 'compaction' AND json_extract(data, '$.status') = 'running'",
        )
        .run(f.session);
}

test("a refused manual compact keeps the stored and served history head", async () => {
    const f = await oc2ContextFixture(61886, options);
    const realSet = f.hostStorage.set.bind(f.hostStorage);
    let refuse = false;
    const write = spyOn(f.hostStorage, "set").mockImplementation(async (key, value) => {
        if (refuse && key.startsWith("native-fold/v3/"))
            throw new Error("isolated host storage write failure");
        return realSet(key, value);
    });
    try {
        f.compartment(4);
        const served = await f.pass();
        const before = storedHead(f);
        // A newer summary only a rebuilt head would render.
        f.compartment(10);
        refuse = true;
        await expect(f.nativeFold(3, 0, "", "manual")).rejects.toThrow(
            "could not preserve the host checkpoint",
        );
        refuse = false;
        const storedAfterRefusal = storedHead(f);
        failRunningCompaction(f);
        const after = await f.pass();
        // The request after the refusal still serves the head the provider
        // cached; the newer summary waits for a rebuild that is admitted.
        expect(head(after)).not.toContain("Review history 1");
        expect(head(after)).toBe(head(served));
        expect(storedAfterRefusal).toEqual(before);
    } finally {
        write.mockRestore();
        await f.cleanup();
    }
}, 60000);

test("a restart between staging and admitting a manual compact serves the previous head", async () => {
    const f = await oc2ContextFixture(62886, options);
    const realSet = f.hostStorage.set.bind(f.hostStorage);
    let hang = false;
    let atAdmission: ReturnType<typeof storedHead> | undefined;
    const write = spyOn(f.hostStorage, "set").mockImplementation(async (key, value) => {
        if (hang && key.startsWith("native-fold/v3/")) {
            // The process stops here: the hook rendered and staged the new
            // head, and the host never hears back.
            atAdmission = storedHead(f);
            return new Promise<void>(() => {});
        }
        return realSet(key, value);
    });
    try {
        f.compartment(4);
        const served = await f.pass();
        const before = storedHead(f);
        f.compartment(10);
        hang = true;
        void f.nativeFold(3, 0, "", "manual");
        for (let tick = 0; tick < 200 && !atAdmission; tick++)
            await new Promise((resolve) => setTimeout(resolve, 5));
        expect(atAdmission).toBeDefined();
        hang = false;
        // A new plugin process over the same stores; the host marks the
        // checkpoint it never finished as failed.
        await f.restart();
        resetServedHeadsForTest();
        failRunningCompaction(f);
        const after = await f.pass();
        expect(head(after)).not.toContain("Review history 1");
        expect(head(after)).toBe(head(served));
        // What the store holds while the admission is in flight is what a
        // process that stops there leaves behind.
        expect(atAdmission).toEqual(before);
    } finally {
        write.mockRestore();
        await f.cleanup();
    }
}, 60000);

test("the head an admitted manual compact commits is the head the next request serves", async () => {
    const f = await oc2ContextFixture(63886, options);
    try {
        f.compartment(4);
        const served = await f.pass();
        f.compartment(10);
        await f.nativeFold(3, 0, "", "manual");
        const committed = storedHead(f);
        const afterFold = await f.pass();
        expect(head(afterFold)).not.toBe(head(served));
        expect(head(afterFold)).toContain("Review history 1");
        const payload = (stored: ReturnType<typeof storedHead>, key: string) =>
            stored.renderCache.find((row) => row.cache_key === key)?.value;
        const m0 = payload(committed, "cached_m0_bytes");
        expect(String(m0)).toContain("Review history 1");
        const servedM0 = (afterFold.draft.messages[0]?.content ?? [])
            .map((part) => part.text ?? "")
            .join("");
        expect(servedM0).toContain(String(m0));
        // The pass serves the committed head; it renders no head of its own.
        expect(
            afterFold.logs.some((line) =>
                /injected m\[0\]\/m\[1\] \(rematerialized=false/.test(line),
            ),
        ).toBe(true);
        expect(payload(storedHead(f), "cached_m0_bytes")).toBe(m0);
        expect(payload(storedHead(f), "cached_m1_bytes")).toBe(
            payload(committed, "cached_m1_bytes"),
        );
        const replay = await f.pass();
        expect(replay.bytes).toBe(afterFold.bytes);
    } finally {
        await f.cleanup();
    }
}, 60000);
