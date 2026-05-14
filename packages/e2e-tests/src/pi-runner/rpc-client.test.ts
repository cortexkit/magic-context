/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import {
  attachStrictJsonlReader,
  PiRpcProtocol,
  serializeRpcMessage,
  type PiRpcEvent,
} from "./rpc-client";

describe("Pi RPC protocol", () => {
  it("frames strict JSONL records on LF only", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    attachStrictJsonlReader(stream, (line) => lines.push(line));

    stream.write('{"text":"has \\u2028 separator"}\n{"ok":true}\r\npartial');
    stream.end(" tail");

    await new Promise((resolve) => stream.once("close", resolve));
    expect(lines).toEqual([
      '{"text":"has \\u2028 separator"}',
      '{"ok":true}',
      "partial tail",
    ]);
  });

  it("serializes commands as one JSONL record", () => {
    expect(serializeRpcMessage({ type: "get_state", id: "req-1" })).toBe(
      '{"type":"get_state","id":"req-1"}\n',
    );
  });

  it("correlates responses by id without dispatching them as events", async () => {
    const protocol = new PiRpcProtocol();
    const events: PiRpcEvent[] = [];
    const writes: string[] = [];
    protocol.onEvent((event) => events.push(event));

    const pending = protocol.sendCommand((line) => writes.push(line), "get_state", {}, { timeoutMs: 1_000 });
    const sent = JSON.parse(writes[0]!) as { id: string; type: string };
    expect(sent.type).toBe("get_state");

    protocol.dispatchLine(JSON.stringify({ type: "agent_start" }));
    protocol.dispatchLine(
      JSON.stringify({ id: sent.id, type: "response", command: "get_state", success: true, data: { sessionId: "s1" } }),
    );

    await expect(pending).resolves.toMatchObject({ data: { sessionId: "s1" } });
    expect(events).toEqual([{ type: "agent_start" }]);
  });

  it("waits for matching async events", async () => {
    const protocol = new PiRpcProtocol();
    const wait = protocol.waitForEvent((event) => event.type === "agent_end", { timeoutMs: 1_000 });

    protocol.dispatchLine(JSON.stringify({ type: "message_end" }));
    protocol.dispatchLine(JSON.stringify({ type: "agent_end", messages: [] }));

    await expect(wait).resolves.toMatchObject({ type: "agent_end" });
  });
});
