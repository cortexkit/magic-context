import { parseRescoreCommand } from "../../features/magic-context/rescore-service";
import { getMagicContextBuiltinCommands } from "../../shared/builtin-commands";
import { log } from "../../shared/logger";
import { isTuiConnected, pushNotification } from "../../shared/rpc-notifications";
import type { MagicContextRpcServer } from "../../shared/rpc-server";
import type { V2CommandDomain, V2CommandInvocation } from "./types";

/**
 * Register the `/ctx-*` commands with the OpenCode 2 host so every client can
 * run them, not only the terminal UI.
 *
 * The host keeps added definitions in a location-scoped registry that
 * `GET /api/command` lists and `POST /api/session/:sessionID/command` executes,
 * calling this plugin's own `execute` back. A terminal UI keymap entry, by
 * contrast, exists only inside that one UI process, so it is not reachable from
 * `opencode run`, the HTTP API or Desktop.
 *
 * Each command runs the SAME in-process RPC handler the terminal UI calls over
 * the plugin's loopback RPC, so the two entry points cannot drift into doing
 * different work for the same command name.
 *
 * Result TEXT still reaches only a connected terminal UI: the host's command
 * contract returns no payload to the caller, and OpenCode 2 has no
 * ignored-message carrier for writing a status report into a session without
 * making it conversation input. The work itself runs on every client. See
 * PARITY.md.
 */
export async function registerV2Commands(args: {
    command: V2CommandDomain | undefined;
    rpc: MagicContextRpcServer;
    directory: string;
    compactionEnabled: boolean;
}): Promise<boolean> {
    const domain = args.command;
    if (!domain || typeof domain.transform !== "function") {
        log("[magic-context] v2 host exposes no command domain; /ctx-* commands are TUI-only");
        return false;
    }
    const descriptions = getMagicContextBuiltinCommands(args.compactionEnabled);
    const commands = buildV2Commands(args.rpc, args.directory);
    try {
        await domain.transform((editor) => {
            for (const command of commands) {
                editor.add({
                    name: command.name,
                    description: descriptions[command.name].description,
                    execute: command.execute,
                });
            }
        });
    } catch (error) {
        log("[magic-context] v2 command registration failed", error);
        return false;
    }
    log(
        `[magic-context] registered server-side commands: ${commands
            .map((command) => command.name)
            .join(" ")}`,
    );
    return true;
}

type V2CommandName = keyof ReturnType<typeof getMagicContextBuiltinCommands>;

interface V2Command {
    name: V2CommandName;
    execute: (input: V2CommandInvocation) => Promise<void>;
}

/**
 * The argument remainder a client typed. The host carries it in `prompt.text`;
 * a client that sends the whole typed line instead is tolerated by stripping a
 * leading `/name`, so `/ctx-wrapup 30` and `30` mean the same thing.
 */
function commandArgument(input: V2CommandInvocation, name: string): string {
    const raw = typeof input.prompt?.text === "string" ? input.prompt.text.trim() : "";
    const prefix = `/${name}`;
    if (raw === prefix) return "";
    if (raw.startsWith(`${prefix} `)) return raw.slice(prefix.length).trim();
    return raw;
}

function reportResult(sessionID: string, title: string, message: string): void {
    pushNotification("action", { action: "show-result-dialog", title, message }, sessionID);
}

function reportUsage(sessionID: string, message: string): void {
    pushNotification("toast", { message, variant: "warning" }, sessionID);
}

/**
 * Turn one RPC reply into a user report. A handler answers either with finished
 * text, an acknowledgement that background work started (its own result arrives
 * later on the notification channel), or an error.
 */
function reportRpcReply(
    sessionID: string,
    title: string,
    reply: Record<string, unknown>,
    pending: string,
): void {
    if (reply.ok !== true) {
        const error = typeof reply.error === "string" ? reply.error : `${title} request failed`;
        pushNotification("toast", { message: error, variant: "error" }, sessionID);
        return;
    }
    if (reply.started === true) {
        pushNotification("toast", { message: pending, variant: "info" }, sessionID);
        return;
    }
    reportResult(sessionID, title, typeof reply.message === "string" ? reply.message : "");
}

function buildV2Commands(rpc: MagicContextRpcServer, directory: string): V2Command[] {
    return [
        {
            name: "ctx-rescore",
            execute: async (input) => {
                const argument = commandArgument(input, "ctx-rescore");
                try {
                    parseRescoreCommand(argument);
                } catch (error) {
                    reportUsage(
                        input.sessionID,
                        error instanceof Error ? error.message : "Invalid rescore arguments",
                    );
                    return;
                }
                const reply = await rpc.dispatch("rescore", {
                    sessionId: input.sessionID,
                    arguments: argument,
                    directory,
                });
                reportRpcReply(input.sessionID, "Rescore", reply, "Rescore started");
            },
        },
        {
            name: "ctx-status",
            execute: async (input) => {
                // Reading status has no side effect, so the whole point of the
                // command is the report. Build it here so a failure surfaces as a
                // command error to the caller, then hand the detail to the UI that
                // can draw it.
                const detail = await rpc.dispatch("status-detail", {
                    sessionId: input.sessionID,
                    directory,
                });
                if (typeof detail.error === "string") {
                    throw new Error(`Magic Context status is unavailable: ${detail.error}`);
                }
                pushNotification("action", { action: "show-status-dialog" }, input.sessionID);
            },
        },
        {
            name: "ctx-recomp",
            execute: async (input) => {
                // Recomp can spend a lot of tokens, so a terminal UI asks for
                // confirmation first and owns that dialog. Without one there is no
                // surface to confirm on, and the client already expressed the
                // intent by invoking the command, so the run starts directly.
                if (isTuiConnected(input.sessionID)) {
                    pushNotification("action", { action: "show-recomp-dialog" }, input.sessionID);
                    return;
                }
                const reply = await rpc.dispatch("recomp", { sessionId: input.sessionID });
                if (reply.ok !== true) {
                    throw new Error("Magic Context could not start the history rebuild.");
                }
            },
        },
        {
            name: "ctx-dream",
            execute: async (input) => {
                // The dream handler starts the pass in the background and pushes
                // its own summary when the run finishes.
                const task = commandArgument(input, "ctx-dream");
                const reply = await rpc.dispatch("dream", {
                    sessionId: input.sessionID,
                    ...(task ? { task } : {}),
                });
                if (reply.ok !== true) {
                    const error =
                        typeof reply.error === "string" ? reply.error : "dream request failed";
                    throw new Error(`Magic Context could not start the dream run: ${error}`);
                }
                // The run outlives this command callback; report acceptance now and
                // leave the eventual summary to the dream handler's notification.
                pushNotification(
                    "toast",
                    {
                        message: "Dream run started; the summary appears when it finishes",
                        variant: "info",
                    },
                    input.sessionID,
                );
            },
        },
        {
            name: "ctx-flush",
            execute: async (input) => {
                const reply = await rpc.dispatch("flush", { sessionId: input.sessionID });
                reportRpcReply(input.sessionID, "Flush", reply, "Flush started");
                if (reply.ok === true) {
                    // Flush removes queued rows; update the TUI's sidebar snapshot now.
                    pushNotification("action", { action: "refresh-sidebar" }, input.sessionID);
                }
            },
        },
        {
            name: "ctx-embed",
            execute: async (input) => {
                const argument = commandArgument(input, "ctx-embed").toLowerCase();
                if (argument !== "" && argument !== "start" && argument !== "pause") {
                    reportUsage(
                        input.sessionID,
                        "Usage: /ctx-embed (status), /ctx-embed start, or /ctx-embed pause",
                    );
                    return;
                }
                const reply = await rpc.dispatch("embed", {
                    sessionId: input.sessionID,
                    action: argument === "" ? "status" : argument,
                    directory,
                });
                reportRpcReply(
                    input.sessionID,
                    "Embed",
                    reply,
                    "Embedding started; the summary appears when it finishes",
                );
            },
        },
        {
            name: "ctx-wrapup",
            execute: async (input) => {
                const argument = commandArgument(input, "ctx-wrapup");
                if (argument !== "" && !/^\d+$/.test(argument)) {
                    const usage =
                        "Usage: /ctx-wrapup [messages_to_keep] where messages_to_keep is a whole number; 0 summarizes the whole session";
                    reportUsage(input.sessionID, usage);
                    return;
                }
                const messagesToKeep = argument === "" ? 20 : Number.parseInt(argument, 10);
                if (!Number.isSafeInteger(messagesToKeep)) {
                    reportUsage(input.sessionID, "messages_to_keep must be a whole number");
                    return;
                }
                const reply = await rpc.dispatch("wrapup", {
                    sessionId: input.sessionID,
                    messagesToKeep,
                });
                reportRpcReply(
                    input.sessionID,
                    "Wrapup",
                    reply,
                    "Wrapup started; the summary appears when it finishes",
                );
            },
        },
    ];
}
