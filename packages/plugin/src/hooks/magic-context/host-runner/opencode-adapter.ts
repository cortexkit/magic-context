import { createHash } from "node:crypto";
import { providerNativeMessage } from "../provider-visible-parts";
import { isRawCompactionSummaryInfo } from "../read-session-raw";
import type { MessageLike } from "../transform-operations";
import type { Incoming } from "./record";

// Message helpers shared by the OpenCode 2 payload adapter and the bridge's served
// view. The in-tree provider pipeline that used to live here called module routes
// ck-mc no longer serves, and is gone; runner sessions reach ck-mc through their
// runner instead.

type Part = Record<string, unknown>;
function part(value: unknown): Part {
    return value as Part;
}
function mid(message: MessageLike): string | undefined {
    return message.info.id;
}
/** The v2 projection has a call ID, not a v1 store part ID. The part position
 * disambiguates repeated call IDs within a terminal message and survives JSON. */
export function providerSubjectPart(tool: Part, index: number): string {
    if (typeof tool.id === "string" && tool.id) return tool.id;
    if (typeof tool.callID !== "string" || !tool.callID)
        throw new Error("Terminal tool has no stable identity");
    const identity = `v2:${index}:${tool.callID}`;
    return Buffer.byteLength(identity, "utf8") <= 256
        ? identity
        : `v2:${index}:${createHash("sha256").update(tool.callID).digest("hex")}`;
}
function toolTextField(state: Part): "error" | "output" {
    return state.status === "error" && typeof state.error === "string" ? "error" : "output";
}
const hostReplay = new WeakMap<MessageLike, () => unknown>();
/** Defer copying v2 tool-result and host metadata until `providerIncoming` reads
 * the message; nothing else reads it. */
export function rememberOpenCodeHostReplay(message: MessageLike, read: () => unknown): void {
    hostReplay.set(message, read);
}

export function providerIncoming(message: MessageLike): Incoming<MessageLike> {
    return {
        id: mid(message),
        classify: () => {
            if (
                isRawCompactionSummaryInfo(message.info) ||
                message.parts.some((p) => part(p).type === "compaction")
            )
                return "marker";
            return message.parts.some(
                (p) =>
                    part(p).type === "tool" &&
                    !["completed", "error"].includes(String(part(part(p).state).status)),
            )
                ? "non_terminal"
                : "terminal";
        },
        read: () => {
            // This shared input becomes ck-mc's hook and bootstrap/history JSON.
            // LSP diagnostics are host UI data, not model input. Reuse replay's
            // model projection, plus the answer markers needed to prevent removal
            // of user answers, before the context module stores rows or views.
            let visible = providerNativeMessage(message);
            if (visible.info.role === "user" && "summary" in visible.info) {
                // OpenCode fills user diff statistics asynchronously, even after
                // a refused send. They are UI data, not a change to model input;
                // retaining them makes a module-ahead retry conflict with itself.
                const { summary: _summary, ...info } = visible.info;
                visible = { ...visible, info };
            }
            // Persist the projected identity in ingest as well as the hook. The
            // module can address the same part after a rebuild changes part order.
            let changed = false;
            const parts = visible.parts.map((p, index) => {
                const tool = part(p);
                if (
                    tool.type !== "tool" ||
                    (typeof tool.id === "string" && tool.id) ||
                    !["completed", "error"].includes(String(part(tool.state).status))
                )
                    return p;
                changed = true;
                return { ...tool, id: providerSubjectPart(tool, index) };
            });
            const replay = hostReplay.get(message);
            return replay
                ? { ...visible, info: { ...visible.info, magicContextHostReplay: replay() }, parts }
                : changed
                  ? { ...visible, parts }
                  : visible;
        },
    };
}
/** The model-visible text of each part: message text, or a tool's output or error.
 * Hook answers (tags, notes) change exactly these strings. */
function visibleText(message: MessageLike): string {
    return JSON.stringify(
        (Array.isArray(message?.parts) ? message.parts : []).map((value) => {
            const p = part(value);
            if (p.type === "text") return ["text", p.text ?? ""];
            if (p.type !== "tool") return [String(p.type)];
            const state = part(p.state);
            return ["tool", state[toolTextField(state)] ?? ""];
        }),
    );
}

/**
 * Whether `next` puts a message back to the host's raw text after Magic Context had
 * served it with its own changes (`served`): a tag or other hook edit was removed and
 * nothing replaced it. A drop or a different edit renders other text and is not a
 * reversion. `raw` is the host's own copy of the same message.
 */
export function providerRevertsToRaw(
    served: MessageLike,
    next: MessageLike,
    raw: MessageLike,
): boolean {
    const host = visibleText(raw);
    const before = visibleText(served);
    return before !== host && visibleText(next) === host;
}
