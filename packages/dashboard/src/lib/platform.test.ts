import { afterEach, describe, expect, it } from "bun:test";
import { __resetServeTokenForTests, initServeToken, invoke, isTauri } from "./platform";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

function setWindow(value: unknown) {
  Object.defineProperty(globalThis, "window", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  __resetServeTokenForTests();
  Object.defineProperty(globalThis, "window", {
    value: originalWindow,
    configurable: true,
    writable: true,
  });
  globalThis.fetch = originalFetch;
});

describe("platform shim", () => {
  it("preserves typed unsupported-host refusals from serve mode", async () => {
    setWindow({});
    const refusal = { kind: "unsupported_harness", harness: "broca" };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: refusal }), { status: 400 })) as typeof fetch;
    await expect(
      invoke("get_session_cache_events", { harness: "broca", sessionId: "fixture" }),
    ).rejects.toEqual(refusal);
  });

  it("detects Tauri from window internals", () => {
    setWindow({});
    expect(isTauri()).toBe(false);
    setWindow({ __TAURI_INTERNALS__: {} });
    expect(isTauri()).toBe(true);
  });

  it("captures the serve token from the fragment and strips it", async () => {
    const replaceCalls: string[] = [];
    setWindow({
      location: { hash: "#token=abc%20123", pathname: "/", search: "?tab=config" },
      history: {
        replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
          replaceCalls.push(String(url));
        },
      },
      confirm: () => true,
      alert: () => {},
    });
    initServeToken();
    expect(replaceCalls).toEqual(["/?tab=config"]);

    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedInput = input;
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const result = await invoke<{ ok: boolean }>("get_db_health", { sample: true });
    expect(result).toEqual({ ok: true });
    expect(capturedInput).toBe("/api/invoke");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer abc 123",
    });
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      cmd: "get_db_health",
      args: { sample: true },
    });
  });

  it("omits authorization before a serve token is captured", async () => {
    setWindow({
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState: () => {} },
      confirm: () => true,
      alert: () => {},
    });

    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await invoke("get_db_health");
    expect(capturedInit?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(capturedInit?.body))).toEqual({ cmd: "get_db_health", args: {} });
  });
});
