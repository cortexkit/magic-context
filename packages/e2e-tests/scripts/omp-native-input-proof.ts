import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

interface Packet {
  type?: string;
  id?: string;
  success?: boolean;
  data?: { messages?: Record<string, unknown>[] };
  message?: { role?: string; stopReason?: string; content?: { text?: string }[] };
}

/** Use the real RPC commands behind user shell execution and @file expansion. */
export async function driveOmpNativeInputs(
  child: ChildProcessWithoutNullStreams,
  work: string,
  out: string,
): Promise<void> {
  const pending = new Map<
    string,
    { resolve: (value: Packet) => void; reject: (error: Error) => void }
  >();
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let serial = 0;
  let complete: (() => void) | undefined;
  const listen = (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let packet: Packet;
      try {
        packet = JSON.parse(line);
      } catch {
        continue;
      }
      if (packet.type === "response" && packet.id) {
        const waiter = pending.get(packet.id);
        pending.delete(packet.id);
        if (packet.success) waiter?.resolve(packet);
        else waiter?.reject(new Error(`Native RPC command refused: ${line}`));
      }
      if (
        packet.type === "message_end" &&
        packet.message?.role === "assistant" &&
        packet.message.stopReason === "stop" &&
        packet.message.content?.some((part) => part.text === "OMP_PROOF_OK")
      )
        complete?.();
    }
  };
  child.stdout.on("data", listen);
  const command = async (type: string, body: Record<string, unknown> = {}): Promise<Packet> => {
    const id = `native-proof-${serial++}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Packet>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Native RPC timeout: ${type}`));
        }, 30_000);
        child.stdin.write(`${JSON.stringify({ id, type, ...body })}\n`);
      });
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    writeFileSync(join(work, "proof-context.txt"), "NATIVE_FILE_MENTION_683\n");
    // RPC bash calls AgentSession.executeBash, the same native method as !cmd.
    // It persists a real bashExecution, not an extension-created imitation.
    await command("bash", { command: "printf NATIVE_BASH_EXECUTION_683" });
    const before = await command("get_messages");
    if (!before.data?.messages?.some((message) => message.role === "bashExecution"))
      throw new Error("Real shell execution did not enter the session");
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    const finished = new Promise<void>((resolve, reject) => {
      complete = resolve;
      finishTimer = setTimeout(
        () => reject(new Error("Native-input turn did not complete")),
        30_000,
      );
    });
    try {
      await command("prompt", { message: "@proof-context.txt Say OMP_PROOF_OK and stop." });
      await finished;
    } finally {
      clearTimeout(finishTimer);
    }
    const after = await command("get_messages");
    writeFileSync(join(out, "native-session.json"), JSON.stringify(after.data?.messages, null, 2));
    if (!after.data?.messages?.some((message) => message.role === "fileMention"))
      throw new Error("Real @file expansion did not enter the session");
    child.stdin.end();
  } finally {
    child.stdout.off("data", listen);
  }
}
