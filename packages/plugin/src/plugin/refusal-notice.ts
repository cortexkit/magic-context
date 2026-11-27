import { StorageBusyRefusalError } from "../hooks/magic-context/storage-busy-refusal";
import { sessionLog } from "../shared/logger";
import { importPluginModule } from "../shared/stale-plugin-build";
import type { PluginContext } from "./types";

export async function sendOpenCodeRefusal(
    client: PluginContext["client"],
    sessionId: string,
    message: string,
    refusal: Error,
): Promise<void> {
    const { sendStatusNotification } = await importPluginModule(
        () => import("../hooks/magic-context/send-session-notification"),
    );
    const storageBusy = refusal instanceof StorageBusyRefusalError;
    const toast = { toastDurationMs: 15000 };
    const delivery = await sendStatusNotification(
        client,
        sessionId,
        message,
        storageBusy
            ? toast
            : { ...toast, toastTitle: "Magic Context", toastVariant: "error", liveOnly: true },
    );
    if (delivery === "skipped") {
        sessionLog(
            sessionId,
            "refusal notice skipped: no terminal viewing the session",
            refusal.name,
        );
    }
    if (storageBusy) {
        const { abortSessionFailClosed } = await importPluginModule(
            () => import("../hooks/magic-context/transform-postprocess-phase"),
        );
        await abortSessionFailClosed(client, sessionId);
    }
}
