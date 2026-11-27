import { describe, expect, test } from "bun:test";
import {
    EMBEDDING_WORKER_STOPPING_ERROR,
    type EmbeddingWorkerModel,
    serveEmbeddingWorker,
} from "./embedding-worker-loop";

/** A worker port and model whose every step the test controls. */
function fixture() {
    const posted: Record<string, unknown>[] = [];
    const events: string[] = [];
    let listener: ((message: unknown) => void) | undefined;
    const batches: { texts: string[]; finish: () => void }[] = [];
    const model: EmbeddingWorkerModel = {
        initialize: async () => true,
        getLastFailureReason: () => null,
        embedBatch: (texts) =>
            new Promise((resolve) => {
                events.push(`batch ${texts.join(",")}`);
                batches.push({
                    texts,
                    finish: () => resolve(texts.map((text) => new Float32Array([text.length]))),
                });
            }),
        dispose: async () => {
            events.push("dispose");
        },
    };
    serveEmbeddingWorker(
        {
            on: (_event, handler) => {
                listener = handler;
            },
            postMessage: (message) => {
                posted.push(message as Record<string, unknown>);
                const record = message as { id?: number; control?: string; error?: string };
                events.push(
                    record.control
                        ? `posted ${record.control}`
                        : `reply ${record.id}${record.error ? ` ${record.error}` : ""}`,
                );
            },
        },
        model,
        { batchSize: 2, exit: () => events.push("exit") },
    );
    const send = (message: unknown) => listener?.(message);
    // Long enough for the loop's own macrotask yields between batches to run.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    return { posted, events, batches, send, settle };
}

describe("embedding worker loop", () => {
    test("a stop lets the running inference finish, starts nothing after it, then releases the model and exits", async () => {
        const { events, batches, send, settle, posted } = fixture();
        send({ id: 1, texts: ["a", "bb", "ccc", "dddd"] });
        await settle();
        expect(events).toEqual(["batch a,bb"]);

        send({ stop: true });
        send({ id: 2, texts: ["late"] });
        await settle();
        // The running batch has not been interrupted, so nothing is released yet.
        expect(events).toEqual([
            "batch a,bb",
            "posted stopping",
            `reply 2 ${EMBEDDING_WORKER_STOPPING_ERROR}`,
        ]);
        expect(posted[0]).toMatchObject({ control: "stopping", busy: true });

        batches[0]!.finish();
        await settle();
        // The second batch of request 1 never starts; neither does request 2.
        expect(batches).toHaveLength(1);
        expect(events).toEqual([
            "batch a,bb",
            "posted stopping",
            `reply 2 ${EMBEDDING_WORKER_STOPPING_ERROR}`,
            `reply 1 Error: ${EMBEDDING_WORKER_STOPPING_ERROR}`,
            "dispose",
            "posted stopped",
            "exit",
        ]);
    });

    test("a request queued behind the running one never starts after a stop", async () => {
        const { events, batches, send, settle } = fixture();
        send({ id: 1, texts: ["a"] });
        send({ id: 2, texts: ["b"] });
        await settle();
        send({ stop: true });
        batches[0]!.finish();
        await settle();
        expect(batches).toHaveLength(1);
        expect(events).toEqual([
            "batch a",
            "posted stopping",
            "reply 1",
            `reply 2 ${EMBEDDING_WORKER_STOPPING_ERROR}`,
            "dispose",
            "posted stopped",
            "exit",
        ]);
    });

    test("a repeated stop request is ignored", async () => {
        const { events, batches, send, settle } = fixture();
        send({ id: 1, texts: ["a"] });
        await settle();
        send({ stop: true });
        send({ stop: true });
        batches[0]!.finish();
        await settle();
        expect(events.filter((event) => event === "posted stopping")).toHaveLength(1);
        expect(events.filter((event) => event === "exit")).toHaveLength(1);
    });

    test("an idle worker stops without waiting", async () => {
        const { events, send, settle, posted } = fixture();
        send({ stop: true });
        await settle();
        expect(posted[0]).toEqual({ control: "stopping", busy: false, busyMs: 0 });
        expect(events).toEqual(["posted stopping", "dispose", "posted stopped", "exit"]);
    });

    test("requests between batches still return every vector when no stop arrives", async () => {
        const { batches, send, settle, posted } = fixture();
        send({ id: 1, texts: ["a", "bb", "ccc"] });
        await settle();
        batches[0]!.finish();
        await settle();
        batches[1]!.finish();
        await settle();
        expect(batches.map((batch) => batch.texts)).toEqual([["a", "bb"], ["ccc"]]);
        const reply = posted[0] as { id: number; vectors: Float32Array[] };
        expect(reply.id).toBe(1);
        expect(reply.vectors.map((vector) => vector[0])).toEqual([1, 2, 3]);
    });
});
