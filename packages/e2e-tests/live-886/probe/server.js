// Observe drafts and HTTP bodies without rewriting either. Never serialize headers:
// provider authorization must not enter diagnostic logs or captured request files.
export default {
    id: "issue-886-live-probe",
    async setup(context) {
        const pending = new Map();
        const post = async (path, body) => {
            const response = await fetch(`${process.env.MC886_CONTROL_URL}/${path}`, {
                method: "POST", headers: { "Content-Type": "application/json",
                    Authorization: `Bearer ${process.env.MC886_CONTROL_TOKEN}` },
                body: JSON.stringify(body),
            });
            if (!response.ok) throw new Error("issue-886 harness guard stopped the run");
            return response.json();
        };
        await context.session.hook("context", async (draft) => {
            await post("pass", draft);
        });
        await context.session.hook("http.request", async (event) => {
            const result = await post("wire", { sessionID: event.sessionID, kind: event.kind,
                model: event.model, url: event.request.url, body: await event.request.clone().text() });
            const key = `${event.sessionID}:${event.kind}`;
            const queue = pending.get(key) ?? [];
            queue.push(result.callID);
            pending.set(key, queue);
        });
        await context.session.hook("http.response", (event) => {
            const key = `${event.sessionID}:${event.kind}`;
            const callID = pending.get(key)?.shift();
            // Read a tee asynchronously: do not hold up the host's streaming decoder.
            void event.response.clone().text().then(async (text) => {
                let usage;
                for (const line of text.split("\n")) {
                    try {
                        const payload = JSON.parse(line.startsWith("data: ") ? line.slice(6) : line);
                        if (payload.usage) usage = payload.usage;
                    } catch { /* SSE event names and [DONE] are not JSON payloads. */ }
                }
                await post("result", { callID, usage, status: event.response.status });
            }).catch(() => { /* The next request retains the full reservation if capture failed. */ });
        });
    },
};
