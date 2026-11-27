import type { ChildProcess } from "node:child_process";
import type { Worker } from "node:worker_threads";

/** One worker transport, seen from the side that starts the worker. */
export interface BoundaryChannel {
    send(message: unknown): void;
    onMessage(listener: (message: unknown) => void): void;
    exited: Promise<number | null>;
    kill(): void;
}

export function threadChannel(worker: Worker): BoundaryChannel {
    return {
        send: (message) => worker.postMessage(message),
        onMessage: (listener) => worker.on("message", listener),
        exited: new Promise((resolve) => worker.once("exit", (code) => resolve(code))),
        kill: () => void worker.terminate(),
    };
}

export function childChannel(child: ChildProcess): BoundaryChannel {
    return {
        send: (message) => child.send(message as object),
        onMessage: (listener) => child.on("message", listener),
        exited: new Promise((resolve) => child.once("exit", (code) => resolve(code))),
        kill: () => void child.kill("SIGKILL"),
    };
}

export interface BoundaryResult {
    batches: string[][];
    events: string[];
    exitCode: number | null | "timeout";
}

/**
 * Sends one six-text request to a worker running the boundary-probe fixture
 * (two texts per inference call, each call blocking for 150 ms), and sends a
 * stop request as soon as the first call reports that it started, while that
 * call is still blocking the worker. Collects what the worker did until it exits.
 */
export async function driveBoundary(channel: BoundaryChannel): Promise<BoundaryResult> {
    const batches: string[][] = [];
    const events: string[] = [];
    channel.onMessage((raw) => {
        const message = raw as {
            probe?: string;
            texts?: string[];
            control?: string;
            id?: number;
            error?: string;
        };
        if (message.probe === "batch" && message.texts) {
            batches.push(message.texts);
            events.push(`batch ${message.texts.join(",")}`);
            if (batches.length === 1) {
                channel.send({ stop: true });
                events.push("sent stop");
            }
        } else if (message.control) events.push(message.control);
        else if (message.id !== undefined) events.push(`reply ${message.error ?? "vectors"}`);
    });
    channel.send({ id: 1, texts: ["a", "b", "c", "d", "e", "f"] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exitCode = await Promise.race([
        channel.exited,
        new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), 5_000);
        }),
    ]);
    clearTimeout(timer);
    if (exitCode === "timeout") channel.kill();
    return { batches, events, exitCode };
}
