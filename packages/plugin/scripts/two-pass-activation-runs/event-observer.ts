import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { underRoot } from "./activation-driver";

/** Sidecars only record host events; they register no tools and change no model input. */
export function stageEventObserver(root: string, lane: "opencode-1" | "opencode-2" | "omp") {
    const directory = underRoot(root, join(root, "host-event-observer"));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const eventsPath = underRoot(root, join(directory, "events.jsonl"));
    writeFileSync(eventsPath, "", { mode: 0o600 });
    const common = `import { appendFileSync } from "node:fs";
const file = process.env.MC_HOST_EVENT_JSONL;
if (!file) throw new Error("isolated_event_path_required");
const secrets = Object.entries(process.env).filter(([key, value]) => key.endsWith("_API_KEY") && value).map(([, value]) => value);
const scrub = (key, value) => {
    if (/^(authorization|x-api-key|api[_-]?key|password|credential|secret|access_token)$/i.test(key)) return "[REDACTED]";
    if (typeof value !== "string") return value;
    for (const secret of secrets) value = value.split(secret).join("[REDACTED]");
    return value.replace(/Bearer\\s+[^\\s"']+/gi, "Bearer [REDACTED]");
};
const record = (event) => appendFileSync(file, JSON.stringify({ pid: process.pid, observedAt: Date.now(), event }, scrub) + "\\n");
`;
    const source = lane === "opencode-1" ? `${common}
export default { id: "mc-host-event-observer", async server() {
    return { event: async ({ event }) => record(event) };
} };
` : lane === "opencode-2" ? `${common}
export default { id: "mc-host-event-observer", setup(context) {
    const controller = new AbortController();
    void (async () => {
        try {
            for await (const event of context.event.subscribe({ signal: controller.signal })) record(event);
        } catch {
            if (!controller.signal.aborted) record({ type: "observer.stream_error" });
        }
    })();
    return () => controller.abort();
} };
` : `${common}
export default function observer(pi) {
    pi.on("session_start", record);
    pi.on("agent_start", record);
    pi.on("agent_end", record);
    pi.on("session_shutdown", record);
}
`;
    const entrypoint = join(directory, "index.js");
    writeFileSync(entrypoint, source);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
    return { directory, entrypoint, eventsPath };
}

export function readHostEvents(eventsPath: string): unknown[] {
    return readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
