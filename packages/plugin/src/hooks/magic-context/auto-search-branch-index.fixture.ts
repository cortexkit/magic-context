import { parentPort } from "node:worker_threads";

parentPort?.on("message", (reply: { id?: number }) => {
    if (reply.id !== 1) return;
    parentPort?.postMessage({
        kind: "result",
        results: [
            {
                source: "message",
                messageId: "abandoned",
                messageOrdinal: 2,
                role: "user",
                content: "abandoned branch",
                score: 1,
            },
            {
                source: "note",
                noteId: "1",
                content: "retained note",
                status: "active",
                createdAt: 1,
                anchorOrdinal: null,
                sourceSessionId: null,
                score: 1,
            },
        ],
    });
});
// The parent test pauses its embedding response until navigation has occurred.
parentPort?.postMessage({ kind: "query", id: 1, text: "worker entered" });
