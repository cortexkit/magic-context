import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
    STORAGE_BUSY_MESSAGE,
    StorageBusyRefusalError,
} from "../hooks/magic-context/storage-busy-refusal";
import * as logger from "../shared/logger";
import {
    __resetNotificationStateForTests,
    drainNotifications,
    pushNotification,
    registerNotificationSink,
} from "../shared/rpc-notifications";
import { createMessagesTransformHandler, IncompleteUserMessageError } from "./messages-transform";
import { sendOpenCodeRefusal } from "./refusal-notice";
import type { PluginContext } from "./types";

const SESSION = "ses-refusal";
const NOTICE = "Your message hadn't finished arriving. Send it again.";

afterEach(__resetNotificationStateForTests);

function clientWithAbort() {
    const abort = mock(async (_input: unknown) => ({ data: true }));
    return { abort, client: { session: { abort } } as unknown as PluginContext["client"] };
}

test("storage busy pushes the shipped notice before aborting and rejects with the same error", async () => {
    const { client, abort } = clientWithAbort();
    const send = mock(() => {});
    registerNotificationSink({ sessionId: SESSION, protocol: 2, send });
    const refusal = new StorageBusyRefusalError(new Error("fixture busy"), "messages-transform");
    abort.mockImplementation(async () => {
        expect(send).toHaveBeenCalledTimes(1);
        return { data: true };
    });
    const handle = createMessagesTransformHandler({
        magicContext: {
            "experimental.chat.messages.transform": async () => {
                throw refusal;
            },
        },
        onRefusal: (id, message, error) => sendOpenCodeRefusal(client, id, message, error),
    });
    await expect(
        handle({}, {
            messages: [
                {
                    info: { id: "m1", role: "user", sessionID: SESSION },
                    parts: [{ type: "text", text: "hello" }],
                },
            ],
        } as never),
    ).rejects.toBe(refusal);
    const shipped = {
        id: 1,
        sessionId: SESSION,
        type: "toast",
        payload: {
            title: "Magic Context",
            message: STORAGE_BUSY_MESSAGE,
            variant: "info",
            duration: 15000,
        },
    };
    expect(send).toHaveBeenCalledWith(shipped);
    expect(drainNotifications(0, SESSION, { sessionOnly: true })).toEqual([shipped]);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith({ path: { id: SESSION }, throwOnError: true });
});

test("a live refusal is an error toast with a fixed title and never aborts", async () => {
    const { client, abort } = clientWithAbort();
    const send = mock(() => {});
    registerNotificationSink({ sessionId: SESSION, protocol: 2, send });
    await sendOpenCodeRefusal(client, SESSION, NOTICE, new IncompleteUserMessageError());
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
        id: 1,
        sessionId: SESSION,
        type: "toast",
        payload: { title: "Magic Context", message: NOTICE, variant: "error", duration: 15000 },
    });
    expect(abort).not.toHaveBeenCalled();
    expect(drainNotifications(0, SESSION, { sessionOnly: true })).toEqual([]);
});

test("an unwatched refusal never queues, logs once, and stays out of other terminals", async () => {
    const { client } = clientWithAbort();
    const other = mock(() => {});
    const legacy = mock(() => {});
    registerNotificationSink({ sessionId: "ses-other", protocol: 2, send: other });
    registerNotificationSink({ send: legacy });
    const log = spyOn(logger, "sessionLog");
    try {
        await sendOpenCodeRefusal(client, SESSION, NOTICE, new IncompleteUserMessageError());
        expect(other).not.toHaveBeenCalled();
        expect(legacy).not.toHaveBeenCalled();
        expect(drainNotifications(0, SESSION, { sessionOnly: true })).toEqual([]);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith(
            SESSION,
            "refusal notice skipped: no terminal viewing the session",
            "IncompleteUserMessageError",
        );
    } finally {
        log.mockRestore();
    }
});

test("300 refused turns cannot evict another session's queued status", async () => {
    const { client } = clientWithAbort();
    const other = "ses-other";
    pushNotification("toast", { message: "older user notice" }, other);
    pushNotification("toast", { message: "newest user notice" }, other);
    const snapshot = drainNotifications(0);
    for (let attempt = 0; attempt < 300; attempt++) {
        await sendOpenCodeRefusal(client, SESSION, NOTICE, new IncompleteUserMessageError());
    }
    expect(drainNotifications(0)).toEqual(snapshot);
});
